import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { sanitizeInlineText } from './untrustedText';

/**
 * ロードマップ実行（Issue #1465 / #1555）のウィンドウの専有権（lease）。
 *
 * 同じロードマップを複数のVS Codeウィンドウから同時に制御しないよう、runの開始・再開の前に
 * ロードマップ（repo＋Issue番号）ごとに1つのファイルを排他的に作る。置き場はセッション統括の
 * 共有ディレクトリ（`sessionHub.ts`の`sessionHubRoot`）の下で、`globalState`は使わない
 * （ウィンドウ間で変更通知が飛ばず、書き込みの排他も取れないため）。
 *
 * - 作成は一時ファイルを書いてから`link`で本来の名前を付ける。`link`は既に名前があれば
 *   `EEXIST`で失敗するため`open(..., 'wx')`と同じく排他になり、そのうえ中身の無い
 *   ファイルを他のウィンドウに読ませる瞬間が無い（NFS上でも`link`は不可分）
 * - 保持中は`ROADMAP_LEASE_HEARTBEAT_MS`ごとに`heartbeatAt`を書き直す（一時ファイル→`rename`）
 * - `heartbeatAt`が`ROADMAP_LEASE_STALE_MS`以上古いものは、持ち主のウィンドウが落ちたと
 *   みなして取り直せる。同じホストならPIDの生存確認で早めに失効とみなす。globalStorageは
 *   NFSで複数ホストに共有されうるため、ホストが違えばheartbeatだけで判断する
 * - 取り直しは、失効と判定したファイルを`rename`で退避してから作り直す。退避した中身が判定
 *   したものと違えば（判定の後に別のウィンドウが取り直していた）、元へ戻して諦める。作成は
 *   常に`link`なので、2つのウィンドウが同時に取れることは無い
 *
 * heartbeatの時刻は各ホストの時計で書く。失効はその時刻に加えて、このウィンドウが自分の
 * 時計で観測した「中身が変わらない時間」でも判定する（`isRoadmapRunLeaseStale`、時計のずれ対策）。
 */

/** heartbeatを書き直す間隔。 */
export const ROADMAP_LEASE_HEARTBEAT_MS = 15_000;
/** これより長くheartbeatが止まっている専有権は失効とみなす。 */
export const ROADMAP_LEASE_STALE_MS = 60_000;
/** `sessionHubRoot`の下の、専有権ファイルの置き場。 */
export const ROADMAP_LEASE_DIR_NAME = 'roadmap-leases';

const LEASE_VERSION = 1;
/** 取り合いが続いたときに作成・退避を繰り返す上限。 */
const MAX_ACQUIRE_ATTEMPTS = 3;
/** 専有権を持つウィンドウの表示で、hostnameを切り詰める長さ。 */
const HOLDER_HOSTNAME_MAX_LENGTH = 64;
/** 専有権を持つウィンドウの表示で、windowIdの先頭から見せる長さ。 */
const HOLDER_WINDOW_ID_LENGTH = 8;
/** 作成・退避の途中で残った一時ファイル（`*.tmp-*` / `*.stale-*`）。 */
const LEFTOVER_FILE_PATTERN = /^[0-9a-f]{32}\.json\.(?:tmp|stale)-/u;

export interface RoadmapRunLease {
  version: typeof LEASE_VERSION;
  windowId: string;
  runId: string;
  roadmapIssueNumber: number;
  hostname: string;
  /** boot_id＋PID名前空間から作る識別子。読めない環境では''（`computeHostIdentity`参照）。 */
  hostIdentity: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
}

/** 専有権を取る側（このウィンドウ）。 */
export interface RoadmapLeaseOwner {
  windowId: string;
  hostname: string;
  hostIdentity: string;
  pid: number;
}

/**
 * ホストのboot_idと自分のPID名前空間を組み合わせた識別子。同じhostnameでもPID名前空間が
 * 違えば別プロセス（`--network=host`のdevcontainerがホストとhostnameを共有する場合等）が
 * 同じPIDを名乗りうるため、hostnameだけでのPID生死判定を補う。
 * `/proc`が無い環境（macOS/Windows）や読めない環境では空文字列を返し、呼び出し側は
 * hostnameだけでの判定へフォールバックする。
 */
export function computeHostIdentity(): string {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const pidNamespace = readlinkSync('/proc/self/ns/pid');
    return bootId === '' || pidNamespace === '' ? '' : `${bootId}:${pidNamespace}`;
  } catch {
    return '';
  }
}

export type RoadmapLeaseJudgement =
  /** 誰も持っていない。 */
  | 'free'
  /** このウィンドウが持っていて、まだ新しい。 */
  | 'own'
  /** 失効している（持ち主を問わない）。退避してから取り直す。 */
  | 'stale'
  /** 別のウィンドウが持っている。 */
  | 'busy';

/** 専有権ファイルの中身を読む。形の合わないものは`undefined`。 */
export function parseRoadmapRunLease(text: string): RoadmapRunLease | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) {
    return undefined;
  }
  const r = v as Record<string, unknown>;
  if (
    r.version !== LEASE_VERSION ||
    typeof r.windowId !== 'string' ||
    typeof r.runId !== 'string' ||
    typeof r.roadmapIssueNumber !== 'number' ||
    !Number.isSafeInteger(r.roadmapIssueNumber) ||
    typeof r.hostname !== 'string' ||
    typeof r.pid !== 'number' ||
    // `process.kill`へ渡すため、小数・巨大値・NaNは読まない
    !Number.isSafeInteger(r.pid) ||
    typeof r.acquiredAt !== 'string' ||
    typeof r.heartbeatAt !== 'string'
  ) {
    return undefined;
  }
  return {
    version: LEASE_VERSION,
    windowId: r.windowId,
    runId: r.runId,
    roadmapIssueNumber: r.roadmapIssueNumber,
    hostname: r.hostname,
    // 追加前に書かれたリースファイルにはhostIdentityが無い。無ければ''（未識別）として読む
    hostIdentity: typeof r.hostIdentity === 'string' ? r.hostIdentity : '',
    pid: r.pid,
    acquiredAt: r.acquiredAt,
    heartbeatAt: r.heartbeatAt,
  };
}

/** heartbeatからの経過ミリ秒。時刻が読めなければ`Infinity`（失効扱い）。 */
function heartbeatAge(lease: RoadmapRunLease, now: Date): number {
  const at = Date.parse(lease.heartbeatAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now.getTime() - at;
}

/**
 * 専有権ファイルについて、このウィンドウが観測した変化の記録。heartbeatの時刻は持ち主の
 * 時計で書かれているため、自分の時計と比べるだけでは時計のずれに左右される。
 */
export interface RoadmapLeaseObservation {
  /** 同じ中身（windowId・runId・heartbeatAt）を最初に読んでから、自分の時計で経ったミリ秒。 */
  unchangedMs: number;
}

/**
 * 失効しているか。heartbeatが`staleMs`以上止まっていれば失効。同じホストのものに限り、
 * PIDが生きていなければheartbeatを待たずに失効とする（別ホストのPIDは確かめようがない）。
 * 双方の`hostIdentity`が読めている場合はそれも一致を確かめる。`--network=host`のdevcontainer等、
 * hostnameを共有しつつPID名前空間が違う相手にPIDだけで即時失効と誤判定しないため。
 *
 * `observation`があれば、自分の時計で測って`staleMs`の間中身が変わっていないものも失効とする。
 * 持ち主の時計が進んでいてheartbeatの時刻が未来になっていても、いつまでも取れなくならないため。
 * 持ち主の時計が遅れていて早く失効と判定した場合は、持ち主が次のheartbeatで取られたことに
 * 気づいて止まる（`onLost`）。
 */
export function isRoadmapRunLeaseStale(
  lease: RoadmapRunLease,
  self: Pick<RoadmapLeaseOwner, 'hostname' | 'hostIdentity'>,
  now: Date,
  isPidAlive: (pid: number) => boolean,
  staleMs: number = ROADMAP_LEASE_STALE_MS,
  observation?: RoadmapLeaseObservation,
): boolean {
  if (heartbeatAge(lease, now) >= staleMs || (observation?.unchangedMs ?? 0) >= staleMs) {
    return true;
  }
  if (lease.hostname !== self.hostname || lease.pid <= 0) {
    return false;
  }
  if (lease.hostIdentity !== '' && self.hostIdentity !== '' && lease.hostIdentity !== self.hostIdentity) {
    return false;
  }
  return !isPidAlive(lease.pid);
}

/**
 * 既存の専有権に対して、このウィンドウがどうするかを決める。
 *
 * 自分の専有権でも、heartbeatが`staleMs`の半分以上止まっていたら（スリープ明けなど）上書き
 * せず`stale`として取り直す。失効の間際に上書きすると、失効と判定して取り直した別の
 * ウィンドウの専有権を`rename`で潰しうるため。
 *
 * 同じウィンドウでも`runId`が`targetRunId`と違えば、heartbeatの新しさを問わず`stale`とする。
 * 同じウィンドウの別のrun（マルチルートで同じrepoの別フォルダ等）が持っているもので、取り直すと
 * そちらのrunは次のheartbeatで`onLost`になる。同じウィンドウの中では後から操作したrunを優先する。
 */
export function judgeRoadmapRunLease(
  existing: RoadmapRunLease | undefined,
  self: RoadmapLeaseOwner,
  targetRunId: string,
  now: Date,
  isPidAlive: (pid: number) => boolean,
  staleMs: number = ROADMAP_LEASE_STALE_MS,
  observation?: RoadmapLeaseObservation,
): RoadmapLeaseJudgement {
  if (existing === undefined) {
    return 'free';
  }
  if (existing.windowId === self.windowId) {
    // 同windowでも別runId（マルチルートの別フォルダ等）は自分のものではない。stale扱いで取り直す
    if (existing.runId !== targetRunId) {
      return 'stale';
    }
    return heartbeatAge(existing, now) < staleMs / 2 ? 'own' : 'stale';
  }
  return isRoadmapRunLeaseStale(existing, self, now, isPidAlive, staleMs, observation)
    ? 'stale'
    : 'busy';
}

/**
 * originのURLを、ホストをまたいで同じrepoを指す文字列へそろえる。
 * `git@github.com:Owner/Repo.git`と`https://github.com/owner/repo`は同じになる。
 * 読めない形なら`undefined`。
 */
export function normalizeRepoIdentity(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  if (trimmed === '') {
    return undefined;
  }
  let host: string;
  let repoPath: string;
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/u.exec(trimmed);
  if (scp !== null) {
    host = scp[1] ?? '';
    repoPath = scp[2] ?? '';
  } else {
    try {
      const url = new URL(trimmed);
      // `ssh://git@host:2222/owner/repo`と`git@host:owner/repo`を同じにするため、sshではポートを落とす
      host = url.protocol === 'ssh:' || url.protocol === 'git+ssh:' ? url.hostname : url.host;
      repoPath = url.pathname;
    } catch {
      return undefined;
    }
  }
  const normalizedPath = repoPath.replace(/\/+$/u, '').replace(/\.git$/u, '').replace(/^\/+/u, '');
  if (host === '' || normalizedPath === '') {
    return undefined;
  }
  return `${host}/${normalizedPath}`.toLowerCase();
}

/** ロードマップごとの専有権ファイル名。repoの識別子を名前へ出さないようハッシュにする。 */
export function roadmapLeaseFileName(repoIdentity: string, roadmapIssueNumber: number): string {
  const digest = createHash('sha256')
    .update(`${repoIdentity}\n${String(roadmapIssueNumber)}`)
    .digest('hex');
  return `${digest.slice(0, 32)}.json`;
}

/** 専有権を持っているウィンドウを、人が見分けられる形にする。 */
export function formatRoadmapLeaseHolder(lease: RoadmapRunLease | undefined, now: Date): string {
  if (lease === undefined) {
    return '別のウィンドウ';
  }
  const age = heartbeatAge(lease, now);
  const seconds = Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : undefined;
  // 専有権ファイルは共有ディレクトリにあり、別のウィンドウ（別ホスト）が書ける。
  // 制御文字や長すぎる値を通知へそのまま出さないよう、表示の前に整える
  const host = sanitizeInlineText(lease.hostname, HOLDER_HOSTNAME_MAX_LENGTH);
  const windowId = sanitizeInlineText(
    lease.windowId.slice(0, HOLDER_WINDOW_ID_LENGTH),
    HOLDER_WINDOW_ID_LENGTH,
  );
  const parts = [
    `ホスト ${host === '' ? '不明' : host}`,
    lease.pid > 0 ? `PID ${String(lease.pid)}` : undefined,
    windowId === '' ? undefined : `ウィンドウ ${windowId}`,
    seconds === undefined ? undefined : `最終応答 ${String(seconds)}秒前`,
  ].filter((p): p is string => p !== undefined);
  return `別のウィンドウ（${parts.join('、')}）`;
}

/** 専有権が取れなかったときに出す文。 */
export function formatRoadmapLeaseRejection(
  roadmapIssueNumber: number,
  holder: RoadmapRunLease | undefined,
  now: Date,
): string {
  return (
    `ロードマップ #${String(roadmapIssueNumber)}は${formatRoadmapLeaseHolder(holder, now)}が専有権を持っているため、` +
    `このウィンドウでは実行できません。そのウィンドウで操作するか、そのウィンドウが閉じてから` +
    `（落ちた場合は応答が${String(ROADMAP_LEASE_STALE_MS / 1000)}秒途絶えてから）もう一度実行してください`
  );
}

export type AcquireRoadmapLeaseOutcome =
  | { ok: true }
  | { ok: false; holder: RoadmapRunLease | undefined };

/** 専有権を取る対象のrun（`RoadmapRun`の一部）。 */
export interface RoadmapLeaseTarget {
  runId: string;
  workspaceRoot: string;
  roadmapIssueNumber: number;
}

export interface RoadmapRunLeaseManagerDeps {
  /** 専有権ファイルの置き場（`sessionHubRoot`の下の`ROADMAP_LEASE_DIR_NAME`）。 */
  dir: string;
  owner: RoadmapLeaseOwner;
  /** ワークスペースのrepoの識別子（originのURLをそろえたもの）。ホストをまたいで同じ値になること。 */
  resolveRepoIdentity(workspaceRoot: string): Promise<string>;
  /** 持っていたはずの専有権が、別のウィンドウに取られていた（heartbeatで気づいた）。 */
  onLost(runId: string, holder: RoadmapRunLease | undefined): void;
  log(message: string): void;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  staleMs?: number;
}

interface HeldLease {
  file: string;
  target: RoadmapLeaseTarget;
  acquiredAt: string;
  /** 最後に自分のものだと確かめられた時刻（ミリ秒）。heartbeatが失敗し続けたときの判断に使う。 */
  confirmedAtMs: number;
}

/** `RoadmapRunLeaseManager`が専有権ファイルごとに覚える、最後に読んだ中身と読み始めた時刻。 */
interface LeaseSighting {
  key: string;
  firstSeenMs: number;
}

function errorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;
}

/** `process.kill(pid, 0)`で生存を確かめる。権限が無い（`EPERM`）のは生きている。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === 'EPERM';
  }
}

function sameLease(a: RoadmapRunLease, b: RoadmapRunLease): boolean {
  return a.windowId === b.windowId && a.runId === b.runId && a.heartbeatAt === b.heartbeatAt;
}

/**
 * このウィンドウが持つ専有権の取得・heartbeat・解放。ファイル操作は1本のキューで直列化し、
 * 同じウィンドウの中で取得とheartbeatが入れ違わないようにする。
 */
export class RoadmapRunLeaseManager {
  private readonly held = new Map<string, HeldLease>();
  private readonly identities = new Map<string, Promise<string>>();
  private readonly sightings = new Map<string, LeaseSighting>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: RoadmapRunLeaseManagerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private get staleMs(): number {
    return this.deps.staleMs ?? ROADMAP_LEASE_STALE_MS;
  }

  private isPidAlive(pid: number): boolean {
    return (this.deps.isPidAlive ?? isProcessAlive)(pid);
  }

  holds(runId: string): boolean {
    return this.held.has(runId);
  }

  /** runの専有権を取る。取れなければ持っているウィンドウの情報を返す。 */
  async acquire(target: RoadmapLeaseTarget): Promise<AcquireRoadmapLeaseOutcome> {
    if (this.disposed) {
      return { ok: false, holder: undefined };
    }
    const identity = await this.identityOf(target.workspaceRoot);
    const file = path.join(this.deps.dir, roadmapLeaseFileName(identity, target.roadmapIssueNumber));
    return this.serialize(async () => {
      await this.sweepLeftovers();
      const outcome = await this.acquireFile(file, target, this.now().toISOString());
      if (!outcome.ok) {
        return outcome;
      }
      if (this.disposed) {
        // 取っている間に`dispose`が済んだ。`dispose`は`held`に無いこのファイルを消さない
        await this.removeIfMine(file, target.runId);
        return { ok: false, holder: undefined };
      }
      this.hold(target, file);
      return outcome;
    });
  }

  /** runの専有権を手放す。ファイルは自分のものであるときだけ消す。 */
  async release(runId: string): Promise<void> {
    const entry = this.held.get(runId);
    if (entry === undefined) {
      return;
    }
    this.held.delete(runId);
    this.stopTimerIfIdle();
    await this.serialize(() => this.removeIfMine(entry.file, runId));
  }

  private async removeIfMine(file: string, runId: string): Promise<void> {
    const current = await this.readLease(file);
    if (current !== undefined && this.isMine(current, runId)) {
      await unlink(file).catch(() => undefined);
    }
  }

  /** 拡張機能の終了。終了処理は待ってもらえないため、同期I/Oで自分の専有権だけ消す。 */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const [runId, entry] of this.held) {
      try {
        const current = parseRoadmapRunLease(readFileSync(entry.file, 'utf8'));
        if (current !== undefined && this.isMine(current, runId)) {
          unlinkSync(entry.file);
        }
      } catch (e) {
        this.deps.log(`専有権を解放できませんでした（${runId}）: ${String(e)}`);
      }
    }
    this.held.clear();
  }

  private isMine(lease: RoadmapRunLease, runId: string): boolean {
    return lease.windowId === this.deps.owner.windowId && lease.runId === runId;
  }

  private identityOf(workspaceRoot: string): Promise<string> {
    let identity = this.identities.get(workspaceRoot);
    if (identity === undefined) {
      identity = this.deps.resolveRepoIdentity(workspaceRoot);
      // 失敗は覚えない（次回に取り直す）
      void identity.catch(() => this.identities.delete(workspaceRoot));
      this.identities.set(workspaceRoot, identity);
    }
    return identity;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private hold(target: RoadmapLeaseTarget, file: string): void {
    const previous = this.held.get(target.runId);
    this.held.set(target.runId, {
      file,
      target,
      acquiredAt: previous?.acquiredAt ?? this.now().toISOString(),
      confirmedAtMs: this.now().getTime(),
    });
    if (this.timer === undefined && !this.disposed) {
      this.timer = setInterval(() => {
        void this.serialize(() => this.heartbeat()).catch((e: unknown) => {
          this.deps.log(`専有権のheartbeatに失敗しました: ${String(e)}`);
        });
      }, this.deps.heartbeatMs ?? ROADMAP_LEASE_HEARTBEAT_MS);
      this.timer.unref?.();
    }
  }

  private stopTimerIfIdle(): void {
    if (this.held.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private newLease(target: RoadmapLeaseTarget, acquiredAt: string): RoadmapRunLease {
    const { owner } = this.deps;
    return {
      version: LEASE_VERSION,
      windowId: owner.windowId,
      runId: target.runId,
      roadmapIssueNumber: target.roadmapIssueNumber,
      hostname: owner.hostname,
      hostIdentity: owner.hostIdentity,
      pid: owner.pid,
      acquiredAt,
      heartbeatAt: this.now().toISOString(),
    };
  }

  /** 作成・判定・退避を、取れるか他のウィンドウのものと分かるまで繰り返す。 */
  private async acquireFile(
    file: string,
    target: RoadmapLeaseTarget,
    acquiredAt: string,
  ): Promise<AcquireRoadmapLeaseOutcome> {
    await mkdir(this.deps.dir, { recursive: true });
    let last: RoadmapRunLease | undefined;
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const lease = this.newLease(target, acquiredAt);
      if (await this.tryCreate(file, lease)) {
        return { ok: true };
      }
      const existing = await this.readLease(file);
      last = existing;
      switch (
        judgeRoadmapRunLease(
          existing,
          this.deps.owner,
          target.runId,
          this.now(),
          (pid) => this.isPidAlive(pid),
          this.staleMs,
          existing === undefined ? undefined : this.observe(file, existing),
        )
      ) {
        case 'free':
          // 読む前に消えた。作り直す
          continue;
        case 'busy':
          return { ok: false, holder: existing };
        case 'own':
          // 自分のもの（heartbeatの書き直しを含む）。新しいうちは他のウィンドウが触らないので上書きしてよい
          await this.writeAtomic(file, lease);
          return { ok: true };
        case 'stale':
          if (existing !== undefined) {
            await this.evict(file, existing);
          }
          continue;
      }
    }
    return { ok: false, holder: last };
  }

  /** 読んだ専有権の中身が、自分の時計でどれだけ変わっていないか（`isRoadmapRunLeaseStale`参照）。 */
  private observe(file: string, lease: RoadmapRunLease): RoadmapLeaseObservation {
    const key = `${lease.windowId}\n${lease.runId}\n${lease.heartbeatAt}`;
    const nowMs = this.now().getTime();
    const seen = this.sightings.get(file);
    if (seen === undefined || seen.key !== key) {
      this.sightings.set(file, { key, firstSeenMs: nowMs });
      return { unchangedMs: 0 };
    }
    return { unchangedMs: nowMs - seen.firstSeenMs };
  }

  /**
   * 作成・退避の途中でウィンドウが落ちて残った一時ファイルを消す。作成中・退避中のものを
   * 消さないよう、更新から`staleMs`以上経ったものに限る。掃除の失敗は取得を止めない。
   */
  private async sweepLeftovers(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch {
      return;
    }
    const nowMs = this.now().getTime();
    for (const name of names.filter((n) => LEFTOVER_FILE_PATTERN.test(n))) {
      const file = path.join(this.deps.dir, name);
      try {
        if (nowMs - (await stat(file)).mtimeMs >= this.staleMs) {
          await unlink(file);
        }
      } catch {
        // 他のウィンドウが先に消した等。次の取得でまた見る
      }
    }
  }

  /** 一時ファイルを書いてから`link`で名前を付ける。既にあれば`false`。 */
  private async tryCreate(file: string, lease: RoadmapRunLease): Promise<boolean> {
    const tmp = `${file}.tmp-${this.deps.owner.windowId}-${String(this.seq++)}`;
    await writeFile(tmp, JSON.stringify(lease), 'utf8');
    try {
      await link(tmp, file);
      return true;
    } catch (e) {
      if (errorCode(e) === 'EEXIST') {
        return false;
      }
      throw e;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  private async writeAtomic(file: string, lease: RoadmapRunLease): Promise<void> {
    const tmp = `${file}.tmp-${this.deps.owner.windowId}-${String(this.seq++)}`;
    await writeFile(tmp, JSON.stringify(lease), 'utf8');
    await rename(tmp, file);
  }

  /**
   * 失効と判定した専有権を退避して消す。退避したものが判定したものと違えば、判定の後に
   * 別のウィンドウが取り直していたので元へ戻す（戻せなければ、さらに別のウィンドウが作った
   * ものが正になる）。
   */
  private async evict(file: string, judged: RoadmapRunLease): Promise<void> {
    const moved = `${file}.stale-${this.deps.owner.windowId}-${String(this.seq++)}`;
    try {
      await rename(file, moved);
    } catch (e) {
      if (errorCode(e) === 'ENOENT') {
        return;
      }
      throw e;
    }
    try {
      const got = await this.readLease(moved);
      if (got !== undefined && !sameLease(got, judged)) {
        await link(moved, file).catch(() => undefined);
      }
    } finally {
      await unlink(moved).catch(() => undefined);
    }
  }

  /**
   * 専有権ファイルを読む。無ければ`undefined`。中身が読めないもの（壊れたファイル）は、
   * 更新時刻をheartbeatとみなした持ち主不明の専有権として扱う（新しいうちは取らない）。
   */
  private async readLease(file: string): Promise<RoadmapRunLease | undefined> {
    let text: string;
    let mtime: Date;
    try {
      [text, mtime] = await Promise.all([readFile(file, 'utf8'), stat(file).then((s) => s.mtime)]);
    } catch (e) {
      if (errorCode(e) === 'ENOENT') {
        return undefined;
      }
      throw e;
    }
    return (
      parseRoadmapRunLease(text) ?? {
        version: LEASE_VERSION,
        windowId: '',
        runId: '',
        roadmapIssueNumber: 0,
        hostname: '',
        hostIdentity: '',
        pid: 0,
        acquiredAt: mtime.toISOString(),
        heartbeatAt: mtime.toISOString(),
      }
    );
  }

  /**
   * 持っている専有権のheartbeatを書き直す。別のウィンドウのものに替わっていたら手放して
   * `onLost`で知らせる。自分のものが失効間際・消えていた場合は、取得と同じ手順で取り直す。
   * 1件の失敗で残りの専有権のheartbeatを止めない。
   */
  private async heartbeat(): Promise<void> {
    for (const [runId, entry] of [...this.held]) {
      if (this.disposed) {
        return;
      }
      if (this.held.get(runId) !== entry) {
        // 待っている間に解放された
        continue;
      }
      try {
        await this.heartbeatOne(runId, entry);
      } catch (e) {
        this.deps.log(`専有権のheartbeatに失敗しました（${runId}）: ${String(e)}`);
        this.dropIfUnconfirmed(runId, entry);
      }
    }
    this.stopTimerIfIdle();
  }

  private async heartbeatOne(runId: string, entry: HeldLease): Promise<void> {
    const current = await this.readLease(entry.file);
    let lost = current !== undefined && !this.isMine(current, runId);
    let holder = current;
    if (!lost) {
      const outcome = await this.acquireFile(entry.file, entry.target, entry.acquiredAt);
      if (this.disposed) {
        // 書き直している間に`dispose`が済んだ。書き直しで復活したファイルを消す
        await this.removeIfMine(entry.file, runId);
        return;
      }
      if (!outcome.ok) {
        lost = true;
        holder = outcome.holder;
      }
    }
    if (this.held.get(runId) !== entry) {
      return;
    }
    if (lost) {
      this.held.delete(runId);
      this.deps.onLost(runId, holder);
    } else {
      this.held.set(runId, { ...entry, confirmedAtMs: this.now().getTime() });
    }
  }

  /**
   * heartbeatが失敗し続け、最後に自分のものと確かめてから`staleMs`以上経った専有権は、
   * 別のウィンドウに失効と判定されて取られうる。持ち続けずに手放して`onLost`で知らせる。
   */
  private dropIfUnconfirmed(runId: string, entry: HeldLease): void {
    if (this.held.get(runId) !== entry) {
      return;
    }
    if (this.now().getTime() - entry.confirmedAtMs >= this.staleMs) {
      this.held.delete(runId);
      this.deps.onLost(runId, undefined);
    }
  }
}
