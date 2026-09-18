import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import type { SessionActivityState } from './sessionActivity';

/**
 * このPCで開いている全VS Codeウィンドウのセッションを1画面で統括する
 * （Issue #1244）。ウィンドウごとの拡張ホストは別プロセスで、`globalState`は
 * ウィンドウ間で変更通知が飛ばないため、共有ファイル＋監視で集約する。
 *
 * 共有ディレクトリは拡張機能の`globalStorageUri`配下に置く。`~/.codex` /
 * `~/.claude`とは別にすることで、CLI側の領域を汚さない（確認点1への回答）。
 */

/**
 * ループの走行状態（Issue #1258）。統括ページで一時停止と再開のボタンを出し分ける。
 *
 * `LoopController`は`pause()`中も`running`が`true`のままのため、両方を持つ
 * （「いま指示を送り続けているか」は`running && !paused`）。
 */
export interface SharedLoopState {
  running: boolean;
  paused: boolean;
}

/**
 * 1ウィンドウ分の、共有ファイルへ書き出すセッション情報。会話本文は含めない（タイトルとcwdまで）。
 *
 * ループの走行状態（`loop`）は会話本文ではないため、この方針の範囲内として載せる。
 */
export interface SharedSession {
  threadId: string;
  title: string;
  cwd: string | undefined;
  provider: 'codex' | 'claude';
  activity: SessionActivityState;
  /**
   * 古い版のウィンドウが書いたファイルには無いため任意にする。
   * 読み手は「無ければ走っていない」として扱う。
   */
  loop?: SharedLoopState | undefined;
}

interface SharedSessionFile {
  windowId: string;
  updatedAt: number;
  sessions: SharedSession[];
}

/** 読み込み側が扱う、他ウィンドウ1つ分のスナップショット。 */
export interface SharedWindowSessions {
  windowId: string;
  updatedAt: number;
  sessions: SharedSession[];
}

/** heartbeatの間隔。状態変化時はこれを待たず、下の間引きの範囲で書く。 */
const HEARTBEAT_MS = 15_000;
/**
 * 状態変化による書き込みをまとめる間隔（Issue #1244）。
 *
 * 更新の元は`chatView.ts`の`flushState`で、`STATE_POST_INTERVAL_MS`（50ms）ごとに
 * 発火しうる。そのまま繋ぐと1セッションあたり毎秒20回ファイルを書き直すことになる。
 * 「最初の1件はすぐ書き、以降は間隔ごとにまとめ、最後の1回は必ず書く」形にする
 * （`sessionKanbanView.ts`の`schedulePost`と同じ流儀）。
 */
const WRITE_INTERVAL_MS = 1_000;
/** これを超えて`updatedAt`が更新されていないウィンドウは、落ちたものとして除外する。 */
const STALE_MS = 30_000;

export function generateWindowId(): string {
  return randomUUID();
}

export function sessionHubRoot(globalStorageDir: string): string {
  return path.join(globalStorageDir, 'session-hub');
}

function sessionsDir(root: string): string {
  return path.join(root, 'sessions');
}

function requestsDir(root: string): string {
  return path.join(root, 'requests');
}

const ACTIVITY_STATES: readonly SessionActivityState[] = [
  'idle',
  'running',
  'approvalPending',
  'backgroundRunning',
];

/** `loop`は任意。付いていれば形だけ確かめ、壊れていれば無かったものとして落とす。 */
function isSharedLoopState(value: unknown): value is SharedLoopState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.running === 'boolean' && typeof v.paused === 'boolean';
}

function isSharedSession(value: unknown): value is SharedSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.threadId === 'string' &&
    typeof v.title === 'string' &&
    (v.cwd === undefined || typeof v.cwd === 'string') &&
    (v.provider === 'codex' || v.provider === 'claude') &&
    ACTIVITY_STATES.includes(v.activity as SessionActivityState)
  );
}

/** 形の合わない`loop`を落として取り込む（1項目の不整合でセッションごと消さない）。 */
function normalizeSharedSession(session: SharedSession): SharedSession {
  return isSharedLoopState(session.loop) ? session : { ...session, loop: undefined };
}

/**
 * 他ウィンドウが書いた共有ファイルを、信用せずに読み解く。
 *
 * 同じ利用者の別プロセスが書いた値とはいえ、拡張機能の版が違えばスキーマも違う。
 * 未知の`activity`をそのまま通すと、列（`SessionKanbanColumn`）に無いキーへ
 * カードを積もうとして統括ページの描画ごと落ちる。読み取り口で弾いておけば、
 * 内側（`buildSessionKanban`）は型どおりの値だけを扱える。
 *
 * 形の合わない`sessions`の要素だけを落とし、ファイル全体は捨てない
 * （1件の不整合で、そのウィンドウのセッションが丸ごと消えないようにする）。
 */
function parseSharedSessionFile(raw: string): SharedSessionFile | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const v = parsed as Record<string, unknown>;
  if (typeof v.windowId !== 'string' || typeof v.updatedAt !== 'number') {
    return undefined;
  }
  if (!Array.isArray(v.sessions)) {
    return undefined;
  }
  return {
    windowId: v.windowId,
    updatedAt: v.updatedAt,
    sessions: v.sessions.filter(isSharedSession).map(normalizeSharedSession),
  };
}

/** 書き込みは常に一時ファイル→`rename`で行う。読み手が書きかけの内容を拾わないようにする。 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

/** 自ウィンドウのセッション一覧を共有ファイルへ書く。 */
export class SessionHubWriter {
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * `dispose()`済みか。
   *
   * 走っている最中の`write()`が`dispose()`の`unlink`より後に`rename`まで進むと、
   * 消したはずの自分のファイルが復活する。復活しても失効で消えるが、その間だけ
   * 閉じたウィンドウのセッションが一覧に残るので、書き込み側で止める。
   */
  private disposed = false;
  /** 状態変化による書き込みの間引き（`requestWrite`）。予約中のタイマー。 */
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWriteAt = 0;
  private readonly filePath: string;

  constructor(
    private readonly root: string,
    private readonly windowId: string,
    private readonly getSessions: () => readonly SharedSession[],
    private readonly log: Logger,
  ) {
    this.filePath = path.join(sessionsDir(this.root), `${this.windowId}.json`);
  }

  start(): void {
    void this.write();
    this.timer = setInterval(() => void this.write(), HEARTBEAT_MS);
  }

  /**
   * 状態が変わったことを知らせる。実際の書き込みは`WRITE_INTERVAL_MS`ごとにまとめる。
   *
   * 呼び出し側（`extension.ts`）は状態変化のたびに呼んでよい。
   */
  requestWrite(): void {
    if (this.writeTimer !== undefined) {
      return;
    }
    const since = Date.now() - this.lastWriteAt;
    if (since >= WRITE_INTERVAL_MS) {
      void this.write();
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.write();
    }, WRITE_INTERVAL_MS - since);
  }

  async write(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.lastWriteAt = Date.now();
    const payload: SharedSessionFile = {
      windowId: this.windowId,
      updatedAt: Date.now(),
      sessions: [...this.getSessions()],
    };
    try {
      await mkdir(sessionsDir(this.root), { recursive: true });
      await writeAtomic(this.filePath, JSON.stringify(payload));
    } catch (e) {
      this.log.warn(`セッション統括: 共有ファイルの書き込みに失敗しました: ${String(e)}`);
    }
  }

  /** 拡張機能の終了時（`deactivate`）に呼ぶ。消せなくてもheartbeat失効で自然に除外される。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    try {
      await unlink(this.filePath);
    } catch {
      // 既に無い・消せない場合もheartbeat失効に委ねる
    }
  }
}

/** 全ウィンドウの共有ファイルを読み、`fs.watch`で追従する。 */
export class SessionHubReader implements vscode.Disposable {
  private cache: SharedWindowSessions[] = [];
  private watcher: FSWatcher | undefined;
  /** `dispose()`済みか。監視の通知で走り出した読み込みが、破棄後に発火しないようにする。 */
  private disposed = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** 他ウィンドウの一覧が変わったとき。呼び出し側は`getOthers()`を読み直して再描画する。 */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly root: string,
    private readonly selfWindowId: string,
    private readonly log: Logger,
  ) {}

  start(): void {
    void this.reload();
    void mkdir(sessionsDir(this.root), { recursive: true })
      .then(() => {
        this.watcher = watch(sessionsDir(this.root), () => void this.reload());
      })
      .catch((e: unknown) => {
        this.log.warn(`セッション統括: 共有ディレクトリの監視開始に失敗しました: ${String(e)}`);
      });
  }

  /** 直近に読み込んだ、自分以外のウィンドウのセッション一覧（同期・キャッシュ値）。 */
  getOthers(): readonly SharedWindowSessions[] {
    return this.cache;
  }

  private async reload(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let names: string[];
    try {
      names = await readdir(sessionsDir(this.root));
    } catch {
      this.cache = [];
      this.fireIfAlive();
      return;
    }
    const now = Date.now();
    const results: SharedWindowSessions[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const windowId = name.slice(0, -'.json'.length);
      if (windowId === this.selfWindowId) {
        continue;
      }
      try {
        const raw = await readFile(path.join(sessionsDir(this.root), name), 'utf8');
        const parsed = parseSharedSessionFile(raw);
        if (parsed === undefined || now - parsed.updatedAt > STALE_MS) {
          continue;
        }
        results.push(parsed);
      } catch {
        // 書き込み途中・破損したファイルは無視する（次のheartbeatで直る）
        continue;
      }
    }
    this.cache = results;
    this.fireIfAlive();
  }

  /** 読み込みの待ち時間のうちに破棄されていることがあるため、発火の直前にも確かめる。 */
  private fireIfAlive(): void {
    if (this.disposed) {
      return;
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.emitter.dispose();
  }
}

/**
 * 別ウィンドウのセッションへ送る操作の種類（Issue #1258）。
 *
 * 版の違うウィンドウ同士が同じディレクトリを共有するため、受け取った側が知らない
 * `kind`は必ず`ok: false`で返す（黙って捨てると、送った側が5秒待たされる）。
 */
export type SessionHubRequestKind = 'open' | 'interrupt' | 'pauseLoop' | 'resumeLoop' | 'send';

/** 1件の要求。`kind`ごとの追加項目は`text`（`send`が使う）だけ。 */
export interface SessionHubRequest {
  requestId: string;
  kind: SessionHubRequestKind;
  /** 要求元のwindowId。受信側のOutputへ必ず残す（誰の操作かを後から追えるようにする）。 */
  from: string;
  issuedAt: number;
  provider: 'codex' | 'claude';
  threadId: string;
  /** `kind === 'send'`のときの本文。 */
  text?: string | undefined;
}

/**
 * 要求に対する応答。
 *
 * Phase 2以降（承認の中身・会話の直近N件・btwの回答）は、ここへ`payload`を足して運ぶ。
 */
export interface SessionHubReply {
  requestId: string;
  ok: boolean;
  error?: string | undefined;
}

/** 受信側のハンドラが返す結果。応答ファイルの中身は`requestId`を添えてこれから作る。 */
export interface SessionHubRequestOutcome {
  ok: boolean;
  error?: string | undefined;
}

/** 応答を待つ上限。これを過ぎたら要求ファイルを取り下げる。 */
const REPLY_TIMEOUT_MS = 5_000;
/** 応答ファイルの確認間隔。 */
const REPLY_POLL_MS = 150;
/**
 * 取り残されたファイルを掃除するまでの時間。
 *
 * 送信側が応答を待たずに閉じた場合の要求・応答が残る。`REPLY_TIMEOUT_MS`より十分長く
 * とり、まだ待っている相手の応答を消さないようにする。
 */
const REQUEST_TTL_MS = 60_000;

function requestsDirFor(root: string, windowId: string): string {
  return path.join(requestsDir(root), windowId);
}

function repliesDir(root: string): string {
  return path.join(root, 'replies');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 他ウィンドウが書いた要求を、信用せずに読み解く（`parseSharedSessionFile`と同じ方針）。
 *
 * `kind`だけは未知の値もそのまま通す。ここで弾くと「知らない操作だった」ことを応答で
 * 返せなくなり、送った側がタイムアウトまで待つことになる。
 */
function parseRequest(raw: string): SessionHubRequest | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const v = parsed as Record<string, unknown>;
  if (typeof v.requestId !== 'string' || typeof v.kind !== 'string') {
    return undefined;
  }
  if (typeof v.from !== 'string' || typeof v.issuedAt !== 'number') {
    return undefined;
  }
  if ((v.provider !== 'codex' && v.provider !== 'claude') || typeof v.threadId !== 'string') {
    return undefined;
  }
  return {
    requestId: v.requestId,
    kind: v.kind as SessionHubRequestKind,
    from: v.from,
    issuedAt: v.issuedAt,
    provider: v.provider,
    threadId: v.threadId,
    text: typeof v.text === 'string' ? v.text : undefined,
  };
}

function parseReply(raw: string): SessionHubReply | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const v = parsed as Record<string, unknown>;
  if (typeof v.requestId !== 'string' || typeof v.ok !== 'boolean') {
    return undefined;
  }
  return {
    requestId: v.requestId,
    ok: v.ok,
    error: typeof v.error === 'string' ? v.error : undefined,
  };
}

/** そのファイルが`REQUEST_TTL_MS`より古いか。掃除の対象を決めるのに使う。 */
async function isStaleFile(filePath: string, now: number): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return now - info.mtimeMs > REQUEST_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * 別ウィンドウのセッションを操作するよう要求し、応答を待つ送信口（Issue #1258）。
 *
 * 要求は`requests/<targetWindowId>/<requestId>.json`へ1件1ファイルで書く。以前は
 * ファイル名がウィンドウidで固定だったため、続けて送ると上書きで取りこぼしていた。
 */
export class SessionHubRequestPort {
  constructor(
    private readonly root: string,
    private readonly selfWindowId: string,
    private readonly log: Logger,
  ) {}

  /**
   * 要求を書いて応答を待つ。相手が落ちている・古い版で応答を返さない場合は
   * `REPLY_TIMEOUT_MS`で打ち切り、要求ファイルを取り下げる（後から実行されないように）。
   */
  async request(
    targetWindowId: string,
    input: Pick<SessionHubRequest, 'kind' | 'provider' | 'threadId'> & {
      text?: string | undefined;
    },
  ): Promise<SessionHubReply> {
    const requestId = randomUUID();
    const request: SessionHubRequest = {
      ...input,
      requestId,
      from: this.selfWindowId,
      issuedAt: Date.now(),
    };
    const filePath = path.join(requestsDirFor(this.root, targetWindowId), `${requestId}.json`);
    try {
      await mkdir(requestsDirFor(this.root, targetWindowId), { recursive: true });
      await mkdir(repliesDir(this.root), { recursive: true });
      await writeAtomic(filePath, JSON.stringify(request));
    } catch (e) {
      this.log.warn(`セッション統括: 要求の送信に失敗しました（${input.kind}）: ${String(e)}`);
      return { requestId, ok: false, error: '要求を送れませんでした' };
    }
    const reply = await this.waitForReply(requestId);
    if (reply !== undefined) {
      return reply;
    }
    try {
      await unlink(filePath);
    } catch {
      // 既に相手が取っていた場合。応答だけが遅れているので、そのまま失敗として返す
    }
    return { requestId, ok: false, error: '相手のウィンドウから応答がありませんでした' };
  }

  /**
   * `replies/<requestId>.json`が現れるのを待つ。
   *
   * 要求ごとに`fs.watch`を張らず、短い間隔の読み直しで待つ。監視は張り直しのたびに
   * 取りこぼしの余地があり（`SessionHubReader`が`filename`無しのイベントを想定して
   * いるのと同じ事情）、5秒という上限の中では読み直しの方が単純で確実。
   */
  private async waitForReply(requestId: string): Promise<SessionHubReply | undefined> {
    const replyPath = path.join(repliesDir(this.root), `${requestId}.json`);
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(replyPath, 'utf8');
        const parsed = parseReply(raw);
        if (parsed !== undefined) {
          try {
            await unlink(replyPath);
          } catch {
            // 消せなくても`REQUEST_TTL_MS`を過ぎれば受信側の掃除で消える
          }
          return parsed;
        }
      } catch {
        // まだ書かれていない・書きかけ。次の周回で読み直す
      }
      await delay(REPLY_POLL_MS);
    }
    return undefined;
  }
}

/**
 * 自ウィンドウ宛ての要求を監視し、`onRequest`へ渡して結果を応答ファイルへ書く。
 *
 * 要求ファイルは読む前に`unlink`し、消せた側だけが処理する。`fs.watch`は同じ変更で
 * 複数回発火するため、これで二重実行を防ぐ。
 */
export class SessionHubRequestWatcher implements vscode.Disposable {
  private watcher: FSWatcher | undefined;
  /** `dispose()`済みか。破棄後に届いた要求を実行しないようにする。 */
  private disposed = false;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly dir: string;

  constructor(
    private readonly root: string,
    windowId: string,
    private readonly onRequest: (
      request: SessionHubRequest,
    ) => Promise<SessionHubRequestOutcome> | SessionHubRequestOutcome,
    private readonly log: Logger,
  ) {
    this.dir = requestsDirFor(this.root, windowId);
  }

  start(): void {
    void Promise.all([
      mkdir(this.dir, { recursive: true }),
      mkdir(repliesDir(this.root), { recursive: true }),
    ])
      .then(() => {
        // 監視を始める前に届いていた分も拾う
        void this.drain();
        this.watcher = watch(this.dir, () => void this.drain());
        this.sweepTimer = setInterval(() => void this.sweep(), REQUEST_TTL_MS);
      })
      .catch((e: unknown) => {
        this.log.warn(`セッション統括: 要求の監視開始に失敗しました: ${String(e)}`);
      });
  }

  private async drain(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      await this.handle(path.join(this.dir, name));
    }
  }

  private async handle(filePath: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return;
    }
    try {
      // 消せた側だけが処理する。同じ要求を二度実行しないための取り合い
      await unlink(filePath);
    } catch {
      return;
    }
    let request: SessionHubRequest | undefined;
    try {
      request = parseRequest(raw);
    } catch (e) {
      this.log.warn(`セッション統括: 要求の解析に失敗しました: ${String(e)}`);
      return;
    }
    if (request === undefined) {
      return;
    }
    if (Date.now() - request.issuedAt > REQUEST_TTL_MS) {
      // 送った側はとうに待つのをやめている。いま実行すると、忘れたころに中断や送信が走る
      this.log.info(`セッション統括: 期限切れの要求を捨てました（${request.kind}）`);
      return;
    }
    this.log.info(
      `セッション統括: ${request.kind}の要求を受け付けました` +
        `（要求元 ${request.from}、${request.provider}/${request.threadId}）`,
    );
    let outcome: SessionHubRequestOutcome;
    try {
      outcome = await this.onRequest(request);
    } catch (e) {
      outcome = { ok: false, error: String(e) };
    }
    await this.reply({ requestId: request.requestId, ...outcome });
  }

  private async reply(reply: SessionHubReply): Promise<void> {
    try {
      await mkdir(repliesDir(this.root), { recursive: true });
      await writeAtomic(
        path.join(repliesDir(this.root), `${reply.requestId}.json`),
        JSON.stringify(reply),
      );
    } catch (e) {
      this.log.warn(`セッション統括: 応答の書き込みに失敗しました: ${String(e)}`);
    }
  }

  /**
   * 取り残されたファイルを掃除する。
   *
   * 自分宛ての要求は、監視が動いていない間（拡張機能が落ちていた等）に積まれた分が
   * 残る。応答は、待つのをやめた送信元の分が残る。どちらも読み手がいないので消す。
   */
  private async sweep(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const now = Date.now();
    for (const dir of [this.dir, repliesDir(this.root)]) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const filePath = path.join(dir, name);
        if (!(await isStaleFile(filePath, now))) {
          continue;
        }
        try {
          await unlink(filePath);
        } catch {
          // 消せなければ次の周回で試す
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
