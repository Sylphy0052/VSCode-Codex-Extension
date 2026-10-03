import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { sanitizeInlineText } from './untrustedText';

/**
 * オーケストレータモード（Issue #1505）のrunの、ウィンドウごとの専有権（lease）。
 *
 * 同じrunを複数のVS Codeウィンドウから同時に動かさないよう、工程の起動・計画の変更の前に
 * runIdごとに1つのファイルを排他的に作る。置き場はセッション統括の共有ディレクトリ
 * （`sessionHub.ts`の`sessionHubRoot`）の下で、`workspaceState`は使わない（ウィンドウ間で
 * 変更通知が飛ばず、書き込みの排他も取れないため）。
 *
 * 廃止したロードマップ実行（Issue #1465、#1623で削除）の`roadmapRunLease.ts`をrunId単位へ
 * 移植したもの。旧実装はrepo＋ロードマップIssue番号でグルーピングしていたが、オーケストレータ
 * モードはrun自体が既に一意なグルーピング単位のため、`resolveRepoIdentity`等のrepo識別は
 * 持たない（Issue #1628）。
 *
 * - 作成は一時ファイルを書いてから`link`で本来の名前を付ける。`link`は既に名前があれば
 *   `EEXIST`で失敗するため`open(..., 'wx')`と同じく排他になり、そのうえ中身の無い
 *   ファイルを他のウィンドウに読ませる瞬間が無い（NFS上でも`link`は不可分）
 * - 保持中は`TASK_LEASE_HEARTBEAT_MS`ごとに`heartbeatAt`を書き直す（一時ファイル→`rename`）
 * - `heartbeatAt`が`TASK_LEASE_STALE_MS`以上古いものは、持ち主のウィンドウが落ちたと
 *   みなして取り直せる。同じホストならPIDの生存確認で早めに失効とみなす。globalStorageは
 *   NFSで複数ホストに共有されうるため、ホストが違えばheartbeatだけで判断する
 * - 取り直しは、失効と判定したファイルを`rename`で退避してから作り直す。退避した中身が判定
 *   したものと違えば（判定の後に別のウィンドウが取り直していた）、元へ戻して諦める。作成は
 *   常に`link`なので、2つのウィンドウが同時に取れることは無い
 * - `forceAcquire`は、専有権を移す操作（受入基準4）向けに、持ち主が生きていても無条件で
 *   退避して取り直す。旧ロードマップ実行には無かった操作（Issue #1628で新設）
 *
 * heartbeatの時刻は各ホストの時計で書く。失効はその時刻に加えて、このウィンドウが自分の
 * 時計で観測した「中身が変わらない時間」でも判定する（`isTaskRunLeaseStale`、時計のずれ対策）。
 */

/** heartbeatを書き直す間隔。 */
export const TASK_LEASE_HEARTBEAT_MS = 15_000;
/** これより長くheartbeatが止まっている専有権は失効とみなす。 */
export const TASK_LEASE_STALE_MS = 60_000;
/** `sessionHubRoot`の下の、専有権ファイルの置き場。 */
export const TASK_LEASE_DIR_NAME = 'task-run-leases';

const LEASE_VERSION = 1;
/** 取り合いが続いたときに作成・退避を繰り返す上限。 */
const MAX_ACQUIRE_ATTEMPTS = 3;
/** 専有権を持つウィンドウの表示で、hostnameを切り詰める長さ。 */
const HOLDER_HOSTNAME_MAX_LENGTH = 64;
/** 専有権を持つウィンドウの表示で、windowIdの先頭から見せる長さ。 */
const HOLDER_WINDOW_ID_LENGTH = 8;
/** 作成・退避の途中で残った一時ファイル（`*.tmp-*` / `*.stale-*`）。 */
const LEFTOVER_FILE_PATTERN = /^[0-9a-f]{32}\.json\.(?:tmp|stale)-/u;

export interface TaskRunLease {
  version: typeof LEASE_VERSION;
  windowId: string;
  runId: string;
  hostname: string;
  /** boot_id＋PID名前空間から作る識別子。読めない環境では''（`computeHostIdentity`参照）。 */
  hostIdentity: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
}

/** 専有権を取る側（このウィンドウ）。 */
export interface TaskLeaseOwner {
  windowId: string;
  hostname: string;
  hostIdentity: string;
  pid: number;
}

/** `computeHostIdentity`が読む2つの値の取得元（テストで差し替える）。 */
export interface HostIdentitySource {
  readBootId: () => string;
  readPidNamespace: () => string;
}

const PROC_HOST_IDENTITY_SOURCE: HostIdentitySource = {
  readBootId: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
  readPidNamespace: () => readlinkSync('/proc/self/ns/pid'),
};

/**
 * ホストのboot_idと自分のPID名前空間を組み合わせた識別子。同じhostnameでもPID名前空間が
 * 違えば別プロセス（`--network=host`のdevcontainerがホストとhostnameを共有する場合等）が
 * 同じPIDを名乗りうるため、hostnameだけでのPID生死判定を補う。
 * `/proc`が無い環境（macOS/Windows）や読めない環境では空文字列を返し、呼び出し側は
 * hostnameだけでの判定へフォールバックする。
 */
export function computeHostIdentity(
  source: HostIdentitySource = PROC_HOST_IDENTITY_SOURCE,
): string {
  try {
    const bootId = source.readBootId().trim();
    const pidNamespace = source.readPidNamespace();
    return bootId === '' || pidNamespace === '' ? '' : `${bootId}:${pidNamespace}`;
  } catch {
    return '';
  }
}

export type TaskLeaseJudgement =
  /** 誰も持っていない。 */
  | 'free'
  /** このウィンドウが持っていて、まだ新しい。 */
  | 'own'
  /** 失効している（持ち主を問わない）。退避してから取り直す。 */
  | 'stale'
  /** 別のウィンドウが持っている。 */
  | 'busy';

/** 専有権ファイルの中身を読む。形の合わないものは`undefined`。 */
export function parseTaskRunLease(text: string): TaskRunLease | undefined {
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
    hostname: r.hostname,
    // 追加前に書かれたリースファイルにはhostIdentityが無い。無ければ''（未識別）として読む
    hostIdentity: typeof r.hostIdentity === 'string' ? r.hostIdentity : '',
    pid: r.pid,
    acquiredAt: r.acquiredAt,
    heartbeatAt: r.heartbeatAt,
  };
}

/** heartbeatからの経過ミリ秒。時刻が読めなければ`Infinity`（失効扱い）。 */
function heartbeatAge(lease: TaskRunLease, now: Date): number {
  const at = Date.parse(lease.heartbeatAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now.getTime() - at;
}

/**
 * 専有権ファイルについて、このウィンドウが観測した変化の記録。heartbeatの時刻は持ち主の
 * 時計で書かれているため、自分の時計と比べるだけでは時計のずれに左右される。
 */
export interface TaskLeaseObservation {
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
export function isTaskRunLeaseStale(
  lease: TaskRunLease,
  self: Pick<TaskLeaseOwner, 'hostname' | 'hostIdentity'>,
  now: Date,
  isPidAlive: (pid: number) => boolean,
  staleMs: number = TASK_LEASE_STALE_MS,
  observation?: TaskLeaseObservation,
): boolean {
  if (heartbeatAge(lease, now) >= staleMs || (observation?.unchangedMs ?? 0) >= staleMs) {
    return true;
  }
  if (lease.hostname !== self.hostname || lease.pid <= 0) {
    return false;
  }
  if (
    lease.hostIdentity !== '' &&
    self.hostIdentity !== '' &&
    lease.hostIdentity !== self.hostIdentity
  ) {
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
 */
export function judgeTaskRunLease(
  existing: TaskRunLease | undefined,
  self: TaskLeaseOwner,
  now: Date,
  isPidAlive: (pid: number) => boolean,
  staleMs: number = TASK_LEASE_STALE_MS,
  observation?: TaskLeaseObservation,
): TaskLeaseJudgement {
  if (existing === undefined) {
    return 'free';
  }
  if (existing.windowId === self.windowId) {
    return heartbeatAge(existing, now) < staleMs / 2 ? 'own' : 'stale';
  }
  return isTaskRunLeaseStale(existing, self, now, isPidAlive, staleMs, observation)
    ? 'stale'
    : 'busy';
}

/** 専有権ファイル名。runIdを名前へそのまま出さないようハッシュにする。 */
export function taskRunLeaseFileName(runId: string): string {
  const digest = createHash('sha256').update(runId).digest('hex');
  return `${digest.slice(0, 32)}.json`;
}

/** 専有権を持っているウィンドウを、人が見分けられる形にする。 */
export function formatTaskRunLeaseHolder(lease: TaskRunLease | undefined, now: Date): string {
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
export function formatTaskRunLeaseRejection(holder: TaskRunLease | undefined, now: Date): string {
  return (
    `このrunは${formatTaskRunLeaseHolder(holder, now)}が専有権を持っているため、このウィンドウでは操作できません。` +
    `そのウィンドウで操作するか、そのウィンドウが閉じてから` +
    `（落ちた場合は応答が${String(TASK_LEASE_STALE_MS / 1000)}秒途絶えてから）もう一度実行するか、` +
    `Kanbanの「専有権を移す」を使ってください`
  );
}

export type AcquireTaskLeaseOutcome =
  { ok: true } | { ok: false; holder: TaskRunLease | undefined };

export interface TaskRunLeaseManagerDeps {
  /** 専有権ファイルの置き場（`sessionHubRoot`の下の`TASK_LEASE_DIR_NAME`）。 */
  dir: string;
  owner: TaskLeaseOwner;
  /** 持っていたはずの専有権が、別のウィンドウに取られていた（heartbeatで気づいた）。 */
  onLost(runId: string, holder: TaskRunLease | undefined): void;
  log(message: string): void;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  staleMs?: number;
}

interface HeldLease {
  file: string;
  acquiredAt: string;
  /** 最後に自分のものだと確かめられた時刻（ミリ秒）。heartbeatが失敗し続けたときの判断に使う。 */
  confirmedAtMs: number;
}

/** `TaskRunLeaseManager`が専有権ファイルごとに覚える、最後に読んだ中身と読み始めた時刻。 */
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

function sameLease(a: TaskRunLease, b: TaskRunLease): boolean {
  return a.windowId === b.windowId && a.runId === b.runId && a.heartbeatAt === b.heartbeatAt;
}

/**
 * このウィンドウが持つ専有権の取得・heartbeat・解放。ファイル操作は1本のキューで直列化し、
 * 同じウィンドウの中で取得とheartbeatが入れ違わないようにする。
 */
export class TaskRunLeaseManager {
  private readonly held = new Map<string, HeldLease>();
  private readonly sightings = new Map<string, LeaseSighting>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: TaskRunLeaseManagerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private get staleMs(): number {
    return this.deps.staleMs ?? TASK_LEASE_STALE_MS;
  }

  private isPidAlive(pid: number): boolean {
    return (this.deps.isPidAlive ?? isProcessAlive)(pid);
  }

  holds(runId: string): boolean {
    return this.held.has(runId);
  }

  private fileFor(runId: string): string {
    return path.join(this.deps.dir, taskRunLeaseFileName(runId));
  }

  /** runの専有権を取る。取れなければ持っているウィンドウの情報を返す。 */
  async acquire(runId: string): Promise<AcquireTaskLeaseOutcome> {
    if (this.disposed) {
      return { ok: false, holder: undefined };
    }
    const file = this.fileFor(runId);
    return this.serialize(async () => {
      await this.sweepLeftovers();
      const outcome = await this.acquireFile(file, runId, this.now().toISOString(), false);
      if (!outcome.ok) {
        return outcome;
      }
      if (this.disposed) {
        // 取っている間に`dispose`が済んだ。`dispose`は`held`に無いこのファイルを消さない
        await this.removeIfMine(file, runId);
        return { ok: false, holder: undefined };
      }
      this.hold(runId, file);
      return outcome;
    });
  }

  /**
   * 持ち主が生きていても無条件で専有権を奪う（受入基準4「専有権を移す」）。既存の持ち主は
   * 自分の次のheartbeatで`onLost`に気づいて読み取り専用へ切り替わる。
   */
  async forceAcquire(runId: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const file = this.fileFor(runId);
    await this.serialize(async () => {
      await this.sweepLeftovers();
      const outcome = await this.acquireFile(file, runId, this.now().toISOString(), true);
      if (this.disposed) {
        await this.removeIfMine(file, runId);
        return;
      }
      if (outcome.ok) {
        this.hold(runId, file);
      }
    });
  }

  /** runの専有権ファイルを読む（表示専用。持っていなくても読める）。 */
  async peek(runId: string): Promise<TaskRunLease | undefined> {
    return this.readLease(this.fileFor(runId));
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
      // ファイルを消したので、次に見る中身は別物になる。古い観測を残さない
      this.sightings.delete(file);
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
        const current = parseTaskRunLease(readFileSync(entry.file, 'utf8'));
        if (current !== undefined && this.isMine(current, runId)) {
          unlinkSync(entry.file);
        }
      } catch (e) {
        this.deps.log(`専有権を解放できませんでした（${runId}）: ${String(e)}`);
      }
    }
    this.held.clear();
  }

  private isMine(lease: TaskRunLease, runId: string): boolean {
    return lease.windowId === this.deps.owner.windowId && lease.runId === runId;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private hold(runId: string, file: string): void {
    const previous = this.held.get(runId);
    this.held.set(runId, {
      file,
      acquiredAt: previous?.acquiredAt ?? this.now().toISOString(),
      confirmedAtMs: this.now().getTime(),
    });
    if (this.timer === undefined && !this.disposed) {
      this.timer = setInterval(() => {
        void this.serialize(() => this.heartbeat()).catch((e: unknown) => {
          this.deps.log(`専有権のheartbeatに失敗しました: ${String(e)}`);
        });
      }, this.deps.heartbeatMs ?? TASK_LEASE_HEARTBEAT_MS);
      this.timer.unref?.();
    }
  }

  private stopTimerIfIdle(): void {
    if (this.held.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private newLease(runId: string, acquiredAt: string): TaskRunLease {
    const { owner } = this.deps;
    return {
      version: LEASE_VERSION,
      windowId: owner.windowId,
      runId,
      hostname: owner.hostname,
      hostIdentity: owner.hostIdentity,
      pid: owner.pid,
      acquiredAt,
      heartbeatAt: this.now().toISOString(),
    };
  }

  /**
   * 作成・判定・退避を、取れるか他のウィンドウのものと分かるまで繰り返す。`force`は
   * `judgeTaskRunLease`の結果が`busy`でも退避して取り直す（`forceAcquire`専用）。
   */
  private async acquireFile(
    file: string,
    runId: string,
    acquiredAt: string,
    force: boolean,
  ): Promise<AcquireTaskLeaseOutcome> {
    await mkdir(this.deps.dir, { recursive: true });
    let last: TaskRunLease | undefined;
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const lease = this.newLease(runId, acquiredAt);
      if (await this.tryCreate(file, lease)) {
        return { ok: true };
      }
      const existing = await this.readLease(file);
      last = existing;
      const judgement = judgeTaskRunLease(
        existing,
        this.deps.owner,
        this.now(),
        (pid) => this.isPidAlive(pid),
        this.staleMs,
        existing === undefined ? undefined : this.observe(file, existing),
      );
      if (judgement === 'busy' && force) {
        if (existing !== undefined) {
          await this.evict(file, existing);
        }
        continue;
      }
      switch (judgement) {
        case 'free':
          // 読む前に消えた。古い観測が残っていれば捨てて作り直す
          this.sightings.delete(file);
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

  /** 読んだ専有権の中身が、自分の時計でどれだけ変わっていないか（`isTaskRunLeaseStale`参照）。 */
  private observe(file: string, lease: TaskRunLease): TaskLeaseObservation {
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
  private async tryCreate(file: string, lease: TaskRunLease): Promise<boolean> {
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

  private async writeAtomic(file: string, lease: TaskRunLease): Promise<void> {
    const tmp = `${file}.tmp-${this.deps.owner.windowId}-${String(this.seq++)}`;
    await writeFile(tmp, JSON.stringify(lease), 'utf8');
    await rename(tmp, file);
  }

  /**
   * 失効（または`force`で強制退避）と判定した専有権を退避して消す。退避したものが判定した
   * ものと違えば、判定の後に別のウィンドウが取り直していたので元へ戻す（戻せなければ、
   * さらに別のウィンドウが作ったものが正になる）。
   */
  private async evict(file: string, judged: TaskRunLease): Promise<void> {
    const moved = `${file}.stale-${this.deps.owner.windowId}-${String(this.seq++)}`;
    try {
      await rename(file, moved);
    } catch (e) {
      if (errorCode(e) === 'ENOENT') {
        // 判定した中身は既に無い。観測も古くなっているので捨てる
        this.sightings.delete(file);
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
      // 退避を終えた時点で、判定に使った観測はもう役に立たない
      // （消えたか、他ウィンドウの新しい中身に置き換わったか）
      this.sightings.delete(file);
    }
  }

  /**
   * 専有権ファイルを読む。無ければ`undefined`。中身が読めないもの（壊れたファイル）は、
   * 更新時刻をheartbeatとみなした持ち主不明の専有権として扱う（新しいうちは取らない）。
   */
  private async readLease(file: string): Promise<TaskRunLease | undefined> {
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
      parseTaskRunLease(text) ?? {
        version: LEASE_VERSION,
        windowId: '',
        runId: '',
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
      const outcome = await this.acquireFile(entry.file, runId, entry.acquiredAt, false);
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

/**
 * `TaskRunController`が使う専有権の窓口。`TaskRunLeaseManager`のうち必要な操作だけへ絞る
 * （既存の`roadmap?: TaskRunRoadmapPort`と同じ、省略可能な依存注入のパターン。Issue #1628）。
 */
export type TaskRunLeasePort = Pick<
  TaskRunLeaseManager,
  'holds' | 'acquire' | 'peek' | 'forceAcquire' | 'release'
>;
