import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApprovalDecision } from '../appserver/approvals';
import type { Logger } from '../log';
import { isApprovalLevel, type ApprovalLevel } from '../provider/approvalLevel';
import { parseAttachmentInputs, type AttachmentInput } from '../provider/attachments';
import {
  parseAskUserQuestionAnswers,
  parsePendingItems,
  type PendingAnswerMode,
  type PendingItem,
} from './pendingItem';
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
  /**
   * この会話で人の回答を待っている項目（Issue #2135）。要約だけを載せ、全文は
   * `approvalDetail`で取り寄せる。古い版のウィンドウが書いたファイルには無い。
   */
  pending?: PendingItem[] | undefined;
  /**
   * 最後の出力の1行（Issue #2137）。Mission Controlの一覧に出す。外部由来のテキストなので
   * 読み手は文字列として表示するだけにする。古い版のウィンドウが書いたファイルには無い。
   */
  lastOutput?: string | undefined;
  /** 出力が最後に変わったのを書き手が見た時刻（ms）。停滞の判定に使う。 */
  lastOutputAt?: number | undefined;
  /**
   * CLIが通知した、実際に使っているmodel（Issue #2151のカード表示）。通知が無ければ無い。
   * 外部由来のテキストなので、読み手は1行へ畳んで文字列として表示するだけにする。
   */
  model?: string | undefined;
  /** セッション累計のトークン数（Codexだけ。Claude Codeは費用を出す）。 */
  tokens?: number | undefined;
  /** セッションの推定費用（USD。Claude Codeだけ）。 */
  costUsd?: number | undefined;
  /**
   * オーケストレータ配下の子セッションか（Issue #2171）。Mission Controlは返事待ちに出さない。
   * 古い版のウィンドウが書いたファイルには無い（無ければ`false`として扱う）。
   */
  taskManaged?: boolean | undefined;
  /** 引き継ぎ後に旧タブとして残っているか（Issue #2171）。返事待ちに出さない。 */
  handoffKept?: boolean | undefined;
  /**
   * 返事待ちのまま人がまだ見ていないか（Issue #2171）。会話を持つウィンドウが判定して書き、
   * 既読（タブの表示・Mission Controlの詳細ペインでの表示）で下げる。
   */
  unread?: boolean | undefined;
  /**
   * セッションの目的の1文要約（Issue #2172）。別のAIが利用者の発話から作った文なので外部由来の
   * テキストとして扱い、読み手は1行へ畳んで文字列として表示するだけにする。古い版のファイルには無い。
   */
  purpose?: string | undefined;
  /** 目的を要約したときの作業ディレクトリのブランチ名（Issue #2172）。似た要約を見分けるのに使う。 */
  branch?: string | undefined;
}

/** `purpose`の上限（文字数）。書き手の上限（`MAX_SESSION_PURPOSE_CHARS`）に省略記号の分を足す。 */
export const MAX_SHARED_PURPOSE_CHARS = 81;

/** `branch`の上限（文字数）。 */
export const MAX_SHARED_BRANCH_CHARS = 120;

/** `lastOutput`の上限（文字数）。共有ファイルと画面へ長い行を流さない。 */
export const MAX_SHARED_LAST_OUTPUT_CHARS = 200;

/** `model`の上限（文字数）。 */
export const MAX_SHARED_MODEL_CHARS = 80;

/** 0以上の有限の数だけを通す（共有ファイルの中身は別ウィンドウ由来で信用しない）。 */
function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface SharedSessionFile {
  windowId: string;
  updatedAt: number;
  sessions: SharedSession[];
  /**
   * 会話に属さない待ち項目（task runの質問。Issue #2135）。古い版のファイルには無い。
   */
  pending?: PendingItem[] | undefined;
}

/** 読み込み側が扱う、他ウィンドウ1つ分のスナップショット。 */
export interface SharedWindowSessions {
  windowId: string;
  updatedAt: number;
  sessions: SharedSession[];
  /** 会話に属さない待ち項目（Issue #2135）。無ければ空配列。 */
  pending?: PendingItem[] | undefined;
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
/**
 * これを超えて`updatedAt`が更新されていないウィンドウは、落ちたものとして除外する。
 *
 * heartbeatは`HEARTBEAT_MS`（15秒）ごと。高負荷でheartbeatが1〜2回遅れても
 * stale⇔生存を行き来しないよう、3回分の余裕を持たせる（Issue #1461）。
 */
const STALE_MS = 45_000;
/** `fs.watch`通知による読み直しの間引き間隔（Issue #1461）。 */
const RELOAD_DEBOUNCE_MS = 300;
/**
 * 通知の取りこぼしに備えた全件照合の周期。60〜120秒の間で選ぶ（Issue #1461）。
 * `fs.watch`はホストをまたぐ書き込み（NFS）を通知しないため、これが実質的な追従手段になる。
 */
const FULL_RECONCILE_MS = 90_000;
/** これより古い`sessions/*.json`・その`.tmp-*`は使われていないとみなして消す（Issue #1461）。 */
const SESSION_FILE_MAX_AGE_MS = 60 * 60 * 1000;

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

/**
 * `windowId`と`requestId`の形（Issue #1258）。どちらも`randomUUID()`で作る。
 *
 * この2つはファイルパスの一部になる（`requests/<windowId>/<requestId>.json`、
 * `replies/<requestId>.json`）。共有ディレクトリへ書けるのは同じPCの別プロセスで、
 * 拡張機能の版が違えば中身も違う。`/`や`..`を含む値をそのまま`path.join`へ渡すと
 * 共有ディレクトリの外へ書かせられるため、パスに使う前に形で弾く。
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSafeId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** ウィンドウid（`generateWindowId`が作るUUID）の形か。画面から届いた宛先の検証に使う。 */
export function isWindowIdShape(value: unknown): value is string {
  return typeof value === 'string' && isSafeId(value);
}

const ACTIVITY_STATES: readonly SessionActivityState[] = [
  'idle',
  'running',
  'approvalPending',
  'handoffPending',
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

/**
 * 形の合わない`loop`を落として取り込む（1項目の不整合でセッションごと消さない）。
 *
 * `pending`は要素ごとに確かめる（Issue #2135）。宛先（`session.windowId`）は中身を信じず、
 * ファイル名から取った`windowId`で上書きする（要求ファイルの置き場所になるため）。
 */
function normalizeSharedSession(session: SharedSession, windowId: string): SharedSession {
  const pending = withOwnerWindow(parsePendingItems(session.pending), windowId);
  const loop = isSharedLoopState(session.loop) ? session.loop : undefined;
  // 最終出力（Issue #2137）は形と長さを確かめ、合わなければ無かったものとして落とす
  const lastOutput =
    typeof session.lastOutput === 'string'
      ? session.lastOutput.replace(/[\r\n]+/gu, ' ').slice(0, MAX_SHARED_LAST_OUTPUT_CHARS)
      : undefined;
  const lastOutputAt =
    typeof session.lastOutputAt === 'number' && Number.isFinite(session.lastOutputAt)
      ? session.lastOutputAt
      : undefined;
  // カードの補足（Issue #2151）も同じく、形の合わないものは無かったものとして落とす
  const model = inlineText(session.model, MAX_SHARED_MODEL_CHARS);
  const tokens = nonNegativeNumber(session.tokens);
  const costUsd = nonNegativeNumber(session.costUsd);
  // 返事待ちの判定に使う印（Issue #2171）。`true`以外は立っていないものとして扱う
  const taskManaged = session.taskManaged === true ? true : undefined;
  const handoffKept = session.handoffKept === true ? true : undefined;
  const unread = session.unread === true ? true : undefined;
  // 目的の1文要約とブランチ名（Issue #2172）も1行へ畳んで長さを切る
  const purpose = inlineText(session.purpose, MAX_SHARED_PURPOSE_CHARS);
  const branch = inlineText(session.branch, MAX_SHARED_BRANCH_CHARS);
  return {
    ...session,
    loop,
    pending,
    lastOutput,
    lastOutputAt,
    model,
    tokens,
    costUsd,
    taskManaged,
    handoffKept,
    unread,
    purpose,
    branch,
  };
}

/** 文字列なら改行・制御文字を空白へ畳み、長さを切る。空・文字列以外は`undefined`。 */
function inlineText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value
    // eslint-disable-next-line no-control-regex -- 改行・制御文字で一覧の行を崩さない
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, max);
  return text === '' ? undefined : text;
}

function withOwnerWindow(items: readonly PendingItem[], windowId: string): PendingItem[] {
  return items.map((item) => ({ ...item, session: { ...item.session, windowId } }));
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
function parseSharedSessionFile(raw: string, windowId: string): SharedSessionFile | undefined {
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
    sessions: v.sessions
      .filter(isSharedSession)
      .map((session) => normalizeSharedSession(session, windowId)),
    pending: withOwnerWindow(parsePendingItems(v.pending), windowId),
  };
}

/**
 * 書き込みは常に一時ファイル→`rename`で行う。読み手が書きかけの内容を拾わないようにする。
 *
 * `tmpId`省略時はpidと時刻で作る。同じファイルへ繰り返し書くもの（`SessionHubWriter`）は
 * 世代番号を渡し、同一ミリ秒内の衝突を避ける（Issue #1461）。
 */
async function writeAtomic(
  filePath: string,
  content: string,
  tmpId: string = `${process.pid}-${Date.now()}`,
): Promise<void> {
  const tmp = `${filePath}.tmp-${tmpId}`;
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
  /**
   * 実行中の書き込み。同じファイルへの書き込みを直列化し、`dispose()`はこれを待ってから
   * `unlink`する（待たないと、後から`rename`が済んで消したファイルが復活する。Issue #1461）。
   */
  private writeInFlight: Promise<void> | undefined;
  /** 実行中に次の状態が来た印。終わった直後にもう1回だけ書く。 */
  private writePending = false;
  /** tmpファイル名の一意性をpidと組み合わせて保つための世代番号。 */
  private writeGeneration = 0;

  constructor(
    private readonly root: string,
    private readonly windowId: string,
    private readonly getSessions: () => readonly SharedSession[],
    private readonly log: Logger,
    /** 会話に属さない待ち項目（task runの質問。Issue #2135）。省略時は書かない。 */
    private readonly getWindowPending: () => readonly PendingItem[] = () => [],
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

  /**
   * 実行中に呼ばれたら、印だけ付けて即座に戻る。終わった側がもう1回書き直すため、
   * 同じファイルへの`writeAtomic`が重ならない（Issue #1461）。
   */
  async write(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.writeInFlight !== undefined) {
      this.writePending = true;
      return;
    }
    this.writeInFlight = this.writeLoop();
    try {
      await this.writeInFlight;
    } finally {
      this.writeInFlight = undefined;
    }
  }

  private async writeLoop(): Promise<void> {
    do {
      this.writePending = false;
      this.lastWriteAt = Date.now();
      const payload: SharedSessionFile = {
        windowId: this.windowId,
        updatedAt: Date.now(),
        sessions: [...this.getSessions()],
        pending: [...this.getWindowPending()],
      };
      try {
        await mkdir(sessionsDir(this.root), { recursive: true });
        await writeAtomic(
          this.filePath,
          JSON.stringify(payload),
          `${process.pid}-${this.writeGeneration++}`,
        );
      } catch (e) {
        this.log.warn(`セッション統括: 共有ファイルの書き込みに失敗しました: ${String(e)}`);
      }
    } while (this.writePending && !this.disposed);
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
    // `disposed`が立ったので、実行中の書き込みは今の1回で止まる
    await this.writeInFlight?.catch(() => undefined);
    try {
      await unlink(this.filePath);
    } catch {
      // 既に無い・消せない場合もheartbeat失効に委ねる
    }
  }
}

/**
 * 他ウィンドウ1つ分の読み込み状態。`mtimeMs`・`size`・`ino`が前回と同じなら読み直さない（Issue #1461）。
 *
 * 書き込みは`rename`で置き換えるので、書くたびに`ino`が変わる。同じ長さの中身への
 * 書き換えや、mtimeの分解能が粗いファイルシステム（NFS等）でも変化を見落とさない。
 */
interface SessionFileCacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  /** 読めた・staleでなかった場合の中身。stale判定だけ通った場合は無い（キャッシュから消す）。 */
  state: SharedWindowSessions | undefined;
}

/** `rebuildCacheAndFire`の比較で、`fileState`の並び順の違いを変化と見なさないための並べ替え。 */
function compareBySignatureKey(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * 全ウィンドウの共有ファイルを読み、`fs.watch`で追従する。
 *
 * 通知ごとの全件読み直しをやめ、通知に付くファイル名だけを`stat`し、`mtimeMs`・`size`が
 * 変わっていなければ読まない（Issue #1461）。取りこぼしに備え、通知が無い・ファイル名が
 * 取れない・起動時・定期の場合だけ全件を照合する。
 */
export class SessionHubReader implements vscode.Disposable {
  private cache: SharedWindowSessions[] = [];
  /** ウィンドウごとの読み込み状態。キーはファイル名から取った`windowId`。 */
  private readonly fileState = new Map<string, SessionFileCacheEntry>();
  private watcher: FSWatcher | undefined;
  /** `dispose()`済みか。監視の通知で走り出した読み込みが、破棄後に発火しないようにする。 */
  private disposed = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** 他ウィンドウの一覧が変わったとき。呼び出し側は`getOthers()`を読み直して再描画する。 */
  readonly onDidChange = this.emitter.event;

  /** 次に読むべきファイル名。全件照合が要る場合は`pendingFullScan`だけを立てる。 */
  private readonly pendingNames = new Set<string>();
  private pendingFullScan = false;
  private reloadRunning = false;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReloadAt = 0;
  private fullReconcileTimer: ReturnType<typeof setInterval> | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  /** 直近に発火したときの一覧の中身（`updatedAt`を除く）。同じなら発火しない（Issue #1809）。 */
  private lastFiredSignature: string | undefined;

  constructor(
    private readonly root: string,
    private readonly selfWindowId: string,
    private readonly log: Logger,
  ) {}

  start(): void {
    // 起動時は全件照合。取りこぼしなく最初の一覧を作る
    this.scheduleReload(null);
    void mkdir(sessionsDir(this.root), { recursive: true })
      .then(() => {
        // `mkdir`を待つ間に破棄されていれば、監視とタイマーを張らない（張ると後から消せない）
        if (this.disposed) {
          return;
        }
        this.watcher = watch(sessionsDir(this.root), (_eventType, filename) => {
          this.scheduleReload(filename);
        });
        // 監視先が消える・権限が変わると非同期の`error`が飛ぶ。拾わないと拡張ホストごと落ちる
        this.watcher.on('error', (e: unknown) => {
          this.log.warn(`セッション統括: 共有ディレクトリの監視が止まりました: ${String(e)}`);
        });
        // 通知の取りこぼし（NFS越しの他ホストからの書き込み等）に備えた定期の全件照合
        this.fullReconcileTimer = setInterval(() => this.scheduleReload(null), FULL_RECONCILE_MS);
      })
      .catch((e: unknown) => {
        this.log.warn(`セッション統括: 共有ディレクトリの監視開始に失敗しました: ${String(e)}`);
      });
    void this.cleanupStaleSessionFiles();
    this.cleanupTimer = setInterval(() => void this.cleanupStaleSessionFiles(), REQUEST_TTL_MS);
  }

  /** 直近に読み込んだ、自分以外のウィンドウのセッション一覧（同期・キャッシュ値）。 */
  getOthers(): readonly SharedWindowSessions[] {
    return this.cache;
  }

  /**
   * `fs.watch`の通知（または`null`＝全件照合の要求）を受け、読み直しを予約する。
   *
   * 一時ファイル・無関係な拡張子の通知はここで捨てる。実行中に来た分は`pendingNames`/
   * `pendingFullScan`に積むだけにし、終わった直後の1回にまとめる（Issue #1461）。
   */
  private scheduleReload(filename: string | Buffer | null): void {
    if (this.disposed) {
      return;
    }
    if (filename === null) {
      this.pendingFullScan = true;
    } else {
      const name = typeof filename === 'string' ? filename : filename.toString('utf8');
      if (name.includes('.tmp-') || !name.endsWith('.json')) {
        return;
      }
      this.pendingNames.add(name);
    }
    this.requestReload();
  }

  private requestReload(): void {
    if (this.disposed || this.reloadRunning || this.reloadTimer !== undefined) {
      // 実行中・予約済みなら何もしない。積んだ分は終了後の再実行で拾われる
      return;
    }
    const since = Date.now() - this.lastReloadAt;
    if (since >= RELOAD_DEBOUNCE_MS) {
      void this.runReload();
      return;
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.runReload();
    }, RELOAD_DEBOUNCE_MS - since);
  }

  private async runReload(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.reloadRunning = true;
    this.lastReloadAt = Date.now();
    try {
      if (this.pendingFullScan) {
        this.pendingFullScan = false;
        this.pendingNames.clear();
        await this.reconcileAll();
      } else if (this.pendingNames.size > 0) {
        const names = [...this.pendingNames];
        this.pendingNames.clear();
        await this.reconcileNames(names);
      }
    } finally {
      this.reloadRunning = false;
      // 実行中に新しい通知が積まれていれば、間引きを挟んでもう1回だけ実行する
      if (!this.disposed && (this.pendingFullScan || this.pendingNames.size > 0)) {
        this.requestReload();
      }
    }
  }

  /** 通知の取りこぼし対策の全件照合。`stat`で変化を見て、変わったファイルだけ読む。 */
  private async reconcileAll(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(sessionsDir(this.root));
    } catch {
      this.fileState.clear();
      this.rebuildCacheAndFire();
      return;
    }
    const jsonNames = names.filter((name) => name.endsWith('.json'));
    const present = new Set(jsonNames);
    // 消えたファイルはキャッシュからも消す
    for (const windowId of this.fileState.keys()) {
      if (!present.has(`${windowId}.json`)) {
        this.fileState.delete(windowId);
      }
    }
    for (const name of jsonNames) {
      await this.checkFile(name);
    }
    this.rebuildCacheAndFire();
  }

  private async reconcileNames(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await this.checkFile(name);
    }
    this.rebuildCacheAndFire();
  }

  /**
   * 1ファイルだけ`stat`し、`mtimeMs`・`size`が前回と同じなら読まない。staleなら読まずに
   * 除外する（Issue #1461 受入基準1・3）。
   */
  private async checkFile(name: string): Promise<void> {
    const windowId = name.slice(0, -'.json'.length);
    // 形の合わないファイル名は読まない。この値は要求の置き場所になる（Issue #1258）
    if (windowId === this.selfWindowId || !isSafeId(windowId)) {
      return;
    }
    const filePath = path.join(sessionsDir(this.root), name);
    let info: { mtimeMs: number; size: number; ino: number };
    try {
      info = await stat(filePath);
    } catch {
      // 消えた
      this.fileState.delete(windowId);
      return;
    }
    if (Date.now() - info.mtimeMs > STALE_MS) {
      // staleなファイルは読まずに除外する
      this.fileState.delete(windowId);
      return;
    }
    const cached = this.fileState.get(windowId);
    if (
      cached !== undefined &&
      cached.mtimeMs === info.mtimeMs &&
      cached.size === info.size &&
      cached.ino === info.ino
    ) {
      return; // 変化なし。読み直さない
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = parseSharedSessionFile(raw, windowId);
      const now = Date.now();
      if (parsed === undefined || now - parsed.updatedAt > STALE_MS) {
        this.fileState.delete(windowId);
        return;
      }
      // 採用するのはファイル名から取った`windowId`で、ファイルの中身の値ではない
      // （Issue #1258）。この値は要求ファイルの置き場所（`requests/<windowId>/`）を
      // 組み立てるのに使われるため、中身を信じると共有ディレクトリの外へ書かせられる
      this.fileState.set(windowId, {
        mtimeMs: info.mtimeMs,
        size: info.size,
        ino: info.ino,
        state: { ...parsed, windowId },
      });
    } catch {
      // 書き込み途中・破損したファイルは無視する（次の通知・heartbeatで直る）
    }
  }

  private rebuildCacheAndFire(): void {
    // 変化の無いファイルは読み直さないため、落ちたウィンドウの分はここで失効させる
    const now = Date.now();
    this.cache = [...this.fileState.values()]
      .map((entry) => entry.state)
      .filter(
        (state): state is SharedWindowSessions =>
          state !== undefined && now - state.updatedAt <= STALE_MS,
      );
    // 他ウィンドウはheartbeatのたびに`updatedAt`だけを変えて書き直す。購読側（統括ページ）は
    // 発火のたびに盤面を組み直して送るため、ウィンドウとセッションの中身が変わったときだけ
    // 知らせる（Issue #1809）
    const signature = JSON.stringify(
      this.cache
        .map((state): [string, unknown] => [state.windowId, [state.sessions, state.pending]])
        .sort(compareBySignatureKey),
    );
    if (signature === this.lastFiredSignature) {
      return;
    }
    this.lastFiredSignature = signature;
    this.fireIfAlive();
  }

  /**
   * mtimeが`SESSION_FILE_MAX_AGE_MS`より古い`sessions/*.json`と`.tmp-*`を消す（Issue #1461）。
   *
   * 生きているウィンドウは`HEARTBEAT_MS`ごとに自分のファイルを書き直すため、閾値を
   * 1時間に取れば誤って消さない。起動時と`REQUEST_TTL_MS`と同じ周期で呼ぶ。
   */
  private async cleanupStaleSessionFiles(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let names: string[];
    try {
      names = await readdir(sessionsDir(this.root));
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const isSessionFile = name.endsWith('.json');
      if (!isSessionFile && !name.includes('.tmp-')) {
        continue; // 無関係のファイルには触れない
      }
      const filePath = path.join(sessionsDir(this.root), name);
      try {
        const info = await stat(filePath);
        if (now - info.mtimeMs <= SESSION_FILE_MAX_AGE_MS) {
          continue;
        }
        await unlink(filePath);
        if (isSessionFile) {
          this.fileState.delete(name.slice(0, -'.json'.length));
        }
      } catch {
        // 統計・削除に失敗しても次の周回に任せる（他ウィンドウが同時に書き換えた等）
      }
    }
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
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    if (this.fullReconcileTimer !== undefined) {
      clearInterval(this.fullReconcileTimer);
      this.fullReconcileTimer = undefined;
    }
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.emitter.dispose();
  }
}

/**
 * 別ウィンドウのセッションへ送る操作の種類（Issue #1258）。
 *
 * 版の違うウィンドウ同士が同じディレクトリを共有するため、受け取った側が知らない
 * `kind`は必ず`ok: false`で返す（黙って捨てると、送った側が5秒待たされる）。
 */
export type SessionHubRequestKind =
  | 'open'
  | 'interrupt'
  | 'pauseLoop'
  | 'resumeLoop'
  | 'send'
  | 'approvalDetail'
  | 'approvalDecision'
  | 'recentTurns'
  | 'sideQuestion'
  | 'sideQuestionResult'
  | 'handoffDetail'
  | 'handoffDecision'
  | 'answerQuestion'
  | 'answerPrompt'
  | 'answerTaskRunQuestion'
  /** Mission Controlから会話を閉じる・archive・delete（Issue #2149の1）。 */
  | 'close'
  | 'archive'
  | 'delete'
  /** Mission ControlのComposer: 添付・補完・送信キュー（Issue #2158）。 */
  | 'sendWithAttachments'
  | 'fileCandidates'
  | 'commandCandidates'
  | 'queuedMessages'
  | 'cancelQueued'
  /** Mission Controlから実行中セッションの設定を見る・変える（Issue #2159）。 */
  | 'sessionSettings'
  | 'changeSetting'
  /**
   * Mission Controlで選んだセッションへの操作（Issue #2160）。`pin` / `unpin`は履歴の印で
   * 会話に属さないため要求元のウィンドウで済ませるが、版の違う相手から届いても扱えるよう列挙する。
   */
  | 'rename'
  | 'fork'
  | 'pin'
  | 'unpin'
  | 'clear'
  | 'handoff'
  | 'rewindPreview'
  | 'rewind'
  /** Mission Controlの詳細ペインで表示した返事待ちを既読にする（Issue #2171）。 */
  | 'markRead';

/**
 * 承認待ち1件の中身（Issue #1259）。
 *
 * 会話本文は共有ファイルへ常駐させない方針のため、これは`SharedSession`のような
 * 常駐ファイルには書かない。`approvalDetail`の要求から応答を読み取るまでの間だけ
 * `replies/<requestId>.json`に載り、読んだ側が消す（`SessionHubRequestPort.waitForReply`）。
 */
export interface SessionApprovalDetail {
  /**
   * 承認要求のid（`PendingApproval.requestId`）。
   *
   * 元の型は`number | string`だが、JSONを跨ぐと数値と文字列が混ざるため、
   * 文字列へ寄せて運ぶ。受け取った側は`String(...)`で突き合わせて元の値を引き直す。
   */
  requestId: string;
  /** `PendingApproval.kind`。版の違うウィンドウが知らない種別を送ってくるため`string`で受ける。 */
  kind: string;
  title: string;
  /** コマンド全文・変更理由など、承認カードの本文にあたる文字列。 */
  detail: string;
  /** 変更対象のパス。`kind === 'fileChange'`のときに対応する項目から引いたもの。 */
  paths: string[];
  /**
   * 承認・拒否の4値（`ApprovalDecision`）で解決できるか。
   *
   * `askUserQuestion`（選択式の問い合わせ）は専用の応答経路を持ち、この4値では
   * 答えられない。統括ページからは中身だけ出し、ボタンは出さない。
   */
  decidable: boolean;
  /**
   * 回答の形（Issue #2135）。`decision`は承認・拒否、`choices`はAskUserQuestionの選択肢、
   * `text`はCodexの問い合わせのフォーム。古い版のウィンドウからの応答には無い。
   */
  answer?: PendingAnswerMode | undefined;
  /** `kind === 'askUserQuestion'`のときの質問一覧（Issue #2135）。 */
  questions?: SharedAskUserQuestion[] | undefined;
  /** `kind === 'codexPrompt'`のときの入力欄（Issue #2135）。 */
  fields?: SharedPromptField[] | undefined;
  /**
   * 統括ページからは答えられない理由（Issue #2135）。伏せ字の入力欄を持つ問い合わせは、
   * 値を共有ディレクトリへ書かせないためタブ側で答えさせる。
   */
  answerBlockedReason?: string | undefined;
}

/** AskUserQuestionの質問1件（`AskUserQuestionItem`と同じ形。Issue #2135）。 */
export interface SharedAskUserQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** Codexの問い合わせの入力欄1つ（`PromptField`の表示に要る分だけ。Issue #2135）。 */
export interface SharedPromptField {
  id: string;
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  multiple: boolean;
  allowOther: boolean;
  required: boolean;
}

/**
 * 共有ディレクトリ経由で通す承認の決定（Issue #1259）。
 *
 * `ApprovalDecision`は4値あるが、この経路では`accept`と`decline`だけを通す。
 * `acceptForSession`は以後の承認を自動で許可する最も強い決定で、統括ページにも
 * ボタンが無い。要求ファイルを直接置ける立場（design.md §14.111）へ、画面に無い
 * 強い決定まで渡す理由が無い。`cancel`はターンの取り消しで、中断（`interrupt`）が
 * 別にあるため要らない。
 */
export type SharedApprovalDecision = Extract<ApprovalDecision, 'accept' | 'decline'>;

export function isSharedApprovalDecision(value: unknown): value is SharedApprovalDecision {
  return value === 'accept' || value === 'decline';
}

/**
 * 保留中の引き継ぎ確認の中身（Issue #1280）。
 *
 * `SessionApprovalDetail`と同じく常駐ファイルには書かず、`handoffDetail`の応答にだけ
 * 載せる。判定理由（`reasons`）は分類器の見立てをそのまま含むため、会話本文に準じる
 * 扱いにする。
 */
export interface SessionHandoffDetail {
  /**
   * この保留1件のid（推測できない値）。
   *
   * 中身を取り寄せてから決定を押すまでの間に、タブ側のモーダルで答えられていたり
   * 「再判定」で提案が入れ替わっていたりすると一致しなくなる。承認の
   * `ApprovalDisclosureLog`にあたる「表示してから操作する」の担保も、この値を
   * `handoffDetail`の応答でしか配らないことで兼ねる。
   */
  requestId: string;
  /** 提案された引き継ぎ先のmodel。空文字はCLIの既定。 */
  model: string;
  /** 提案された引き継ぎ先のeffort。空文字はCLIの既定。 */
  effort: string;
  /** そうなった理由（分類器の見立て・コスト方針・設定によるoverride）。 */
  reasons: string[];
  /** 引き継ぎの契機を人が読める文にしたもの（`triggerLabel`）。 */
  trigger: string;
  /** 「再判定」を出してよいか（`agent.autoHandoff.router`が有効なときだけ）。 */
  canReclassify: boolean;
  /**
   * 選び直しの候補（Issue #1280の確認点3）。
   *
   * VS CodeのQuickPickは操作した本人のウィンドウにしか出せないため、別ウィンドウ宛ての
   * 選び直しは統括ページの中で選ばせる。候補は保留を持っているウィンドウが作る
   * （モデル一覧はそちらのCLIの設定で決まるため）。
   */
  models: SessionHandoffModelOption[];
}

/** 選び直しの候補1件（Issue #1280）。 */
export interface SessionHandoffModelOption {
  /** CLIへ渡す値。空文字はCLIの既定。 */
  slug: string;
  /** 画面へ出す名前。 */
  label: string;
  /** そのモデルで選べるeffort。空配列なら既定しか選べない。 */
  efforts: string[];
}

/**
 * 統括ページから返せる、引き継ぎ確認への決定（Issue #1280）。
 *
 * モーダルのボタン（続行 / 選び直す / 再判定）に「中止」を足した4種。モーダルは
 * 閉じることで中止できるが、カードには閉じる操作が無いためボタンとして出す。
 */
export type SharedHandoffDecision = 'proceed' | 'repick' | 'reclassify' | 'cancel';

export function isSharedHandoffDecision(value: unknown): value is SharedHandoffDecision {
  return value === 'proceed' || value === 'repick' || value === 'reclassify' || value === 'cancel';
}

/**
 * 会話のやり取り1件（Issue #1260、#2157）。
 *
 * 人の発言とエージェントの応答に加え、ツール呼び出し（`tool`）とファイル変更（`diff`）も
 * 載せる（Issue #2157。Mission Controlの詳細ペインで折りたたんで出す）。思考は含めない。
 * 古い版の読み手は`tool` / `diff`を知らないので、形の合わない要素として落とす。
 */
export interface SessionRecentTurn {
  role: 'user' | 'agent' | 'tool' | 'diff';
  /** 本文。`tool`は出力、`diff`はunified diff。長いものは送る前に切り詰める（`truncated`が立つ）。 */
  text: string;
  /** 本文を切り詰めたか。画面は全文をタブ側で読むよう促す。 */
  truncated: boolean;
  /** `tool` / `diff`の見出し（コマンド行・ツール名・変更したファイル）。 */
  title?: string | undefined;
  /**
   * 人の発言（`role === 'user'`）の固定のid（Issue #2160）。巻き戻しの起点の指定に使う。
   * 表示テキストや位置では、取り寄せてから選ぶまでに会話が進むと別の発言を指すため。
   */
  id?: string | undefined;
}

/** 発言のidの長さの上限。ClaudeのメッセージidはUUIDで、これより十分短い（Issue #2160）。 */
export const MAX_TURN_ID_CHARS = 256;

/** セッション名の長さの上限（Issue #2160）。タブ・履歴に出して読める長さ。 */
export const MAX_SESSION_NAME_CHARS = 200;

/**
 * 名前の変更で届いた名前を、信用せずに読み解く（Issue #2160）。前後の空白を落とし、空・改行入り・
 * 上限超えは`undefined`にする。webviewと別ウィンドウの要求ファイルのどちらから届いた値もここを通す。
 */
export function parseSessionName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim();
  return name === '' || name.length > MAX_SESSION_NAME_CHARS || /[\r\n]/u.test(name)
    ? undefined
    : name;
}

/** 巻き戻しの起点の発言のidを形だけ確かめる（Issue #2160）。会話との突き合わせは受信側が行う。 */
export function parseTurnId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_TURN_ID_CHARS &&
    !/[\r\n]/u.test(value)
    ? value
    : undefined;
}

/**
 * 送信キューの1件（Issue #2158）。応答中に送って待たせている指示。
 *
 * 取り消しの`cancelQueued`は、この`id`を添えて送り、受け取った側がidで突き合わせる。
 */
export interface SessionQueuedMessage {
  /** 項目の安定したid。 */
  id: string;
  /** 本文。長いものは`MAX_QUEUED_TEXT_CHARS`で切り詰める（`truncated`が立つ）。 */
  text: string;
  truncated: boolean;
  /** 添えた画像の枚数。中身は運ばない。 */
  attachments: number;
}

/** 送信キューの1件の本文を運ぶ上限。画面で見分けられれば足りる。 */
export const MAX_QUEUED_TEXT_CHARS = 2000;

/**
 * 承認レベルの変更が効く範囲（Issue #2159）。
 *
 * - `session` — このセッションだけ（Claude。`applyApprovalLevel`がタブの値を変える）
 * - `global` — Codex全体の設定（`settings.updateApprovalLevel('codex', ...)`がユーザー設定を
 *   書き換え、タスク設定を持たない全Codexセッションの次のターンへ効く）
 * - `task` — タスクの設定で起動したCodexセッション。全体の設定を変えても効かないため変えられない
 */
export type SessionApprovalScope = 'session' | 'global' | 'task';

/** 実行中セッションの今の設定（Issue #2159）。`sessionSettings` / `changeSetting`の応答に載る。 */
export interface SessionSettingsDetail {
  /** 空文字はCLIの既定。 */
  model: string;
  /** 空文字はCLIの既定。 */
  effort: string;
  /** 選べるmodel。先頭は既定（`slug: ''`）。各要素の`efforts`がそのmodelで選べるeffort。 */
  models: SessionHandoffModelOption[];
  /** `ask` / `auto` / `full`。どれにも当たらなければ空文字（カスタム）。 */
  approvalLevel: string;
  approvalScope: SessionApprovalScope;
  planMode: boolean;
  /** fast modeの今の値。`undefined`はこのセッションで使えない（Codex・CLIが未対応）。 */
  fastMode?: boolean | undefined;
  /** 変更を受け付けるか。入力欄を閉じたタブは見るだけ。 */
  editable: boolean;
}

/** 変えられる設定の種別（Issue #2159）。 */
export const SESSION_SETTING_KINDS = [
  'model',
  'effort',
  'approvalLevel',
  'planMode',
  'fastMode',
] as const;
export type SessionSettingKind = (typeof SESSION_SETTING_KINDS)[number];

/** 設定の変更1件（Issue #2159）。 */
export type SessionSettingChange =
  | { setting: 'model'; value: string }
  | { setting: 'effort'; value: string }
  | { setting: 'approvalLevel'; value: ApprovalLevel }
  | { setting: 'planMode'; value: boolean }
  | { setting: 'fastMode'; value: boolean };

/** model・effortの値の長さの上限。CLIのmodel名はこれより十分短い。 */
const MAX_SETTING_VALUE_CHARS = 200;

/**
 * 設定の変更を、信用せずに読み解く（Issue #2159）。webviewと別ウィンドウの要求ファイルの
 * どちらから届いた値も、ここを通してから使う。値が候補にあるかは受信側が確かめる。
 */
export function parseSessionSettingChange(
  setting: unknown,
  value: unknown,
): SessionSettingChange | undefined {
  switch (setting) {
    case 'model':
    case 'effort':
      return typeof value === 'string' && value.length <= MAX_SETTING_VALUE_CHARS
        ? { setting, value }
        : undefined;
    case 'approvalLevel':
      return isApprovalLevel(value) ? { setting, value } : undefined;
    case 'planMode':
    case 'fastMode':
      return typeof value === 'boolean' ? { setting, value } : undefined;
    default:
      return undefined;
  }
}

/**
 * 脇道の質問（btw）1件の進み具合（Issue #1261）。
 *
 * 回答は本流の会話に残さないため、この値が統括ページへ運ぶ唯一の経路になる。
 * `sideQuestion`（質問を投げる）と`sideQuestionResult`（進み具合を取りに行く）の
 * どちらの応答にも同じ形で載る。
 */
export interface SessionSideQuestion {
  /** 受信側が採番する、この質問1件のid。以後の`sideQuestionResult`はこれで引く。 */
  id: string;
  /** `running`は回答待ち。`done`なら`answer`、`failed`なら`error`が入る。 */
  status: 'running' | 'done' | 'failed';
  question: string;
  answer?: string | undefined;
  error?: string | undefined;
}

/** 応答の`payload`（Issue #1259）。 */
export interface SessionHubReplyPayload {
  /** `kind === 'approvalDetail'`の応答。承認待ちが無ければ空配列。 */
  approvals?: SessionApprovalDetail[] | undefined;
  /** `kind === 'recentTurns'`の応答。やり取りが無ければ空配列（Issue #1260）。 */
  turns?: SessionRecentTurn[] | undefined;
  /**
   * `turns`を作った時刻（Issue #1260）。
   *
   * `ChatItem`は項目ごとの時刻を持たないため、やり取り1件ずつの時刻は返せない。
   * 代わりに「いつ時点の内容か」をこれで示す（何秒前の状態を見ているかが判る）。
   */
  capturedAt?: number | undefined;
  /**
   * `turns`の先頭が会話の何件目か（0始まり）と、会話全体の件数（Issue #2157）。
   *
   * 古い版の書き手は返さない。読み手は無ければ「これ以上遡れない」として扱う。
   */
  turnStart?: number | undefined;
  turnTotal?: number | undefined;
  /** `kind === 'sideQuestion'` / `'sideQuestionResult'`の応答（Issue #1261）。 */
  sideQuestion?: SessionSideQuestion | undefined;
  /** `kind === 'handoffDetail'`の応答（Issue #1280）。保留が無ければ`undefined`。 */
  handoff?: SessionHandoffDetail | undefined;
  /** `kind === 'fileCandidates'`の応答（Issue #2158）。作業ディレクトリからの相対パス。 */
  files?: string[] | undefined;
  /** `kind === 'commandCandidates'`の応答（Issue #2158）。 */
  commands?: SessionSlashCommand[] | undefined;
  /** `kind === 'queuedMessages'`の応答（Issue #2158）。 */
  queued?: SessionQueuedMessage[] | undefined;
  /** `kind === 'sessionSettings'` / `'changeSetting'`の応答（Issue #2159）。 */
  settings?: SessionSettingsDetail | undefined;
  /** `kind === 'rewindPreview'`の応答（Issue #2160）。戻すと変わるファイル。 */
  rewindFiles?: string[] | undefined;
}

/** スラッシュコマンドの候補1件（`SlashCommand`と同じ形。Issue #2158）。 */
export interface SessionSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** 1件の要求。`kind`ごとの追加項目はここへ並べる。 */
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
  /**
   * `kind === 'approvalDecision'`のときの、対象の承認要求のid（Issue #1259）。
   *
   * この要求そのもののidである`requestId`とは別物なので名前を分ける。
   */
  approvalRequestId?: string | undefined;
  /** `kind === 'approvalDecision'`のときの決定。受信側が`ApprovalDecision`として検証する。 */
  decision?: string | undefined;
  /** `kind === 'recentTurns'`のときに欲しい件数（Issue #1260）。受信側が範囲へ丸める。 */
  limit?: number | undefined;
  /**
   * `kind === 'recentTurns'`のとき、この件数目より前を取る（Issue #2157。0始まり・含まない）。
   * 省くと末尾から取る。古い版の受信側は無視して末尾を返すが、そのときは応答に
   * `turnStart`が無いので、要求側はそれ以上遡らない。
   */
  before?: number | undefined;
  /**
   * `kind === 'sideQuestionResult'`のときの、進み具合を知りたい質問のid（Issue #1261）。
   *
   * この要求そのもののidである`requestId`とは別物なので名前を分ける
   * （`approvalRequestId`と同じ理由）。
   */
  sideQuestionId?: string | undefined;
  /**
   * `kind === 'handoffDecision'`のときの、対象の保留のid（Issue #1280）。
   *
   * 要求そのもののidである`requestId`とは別物なので名前を分ける（`approvalRequestId`と
   * 同じ事情）。
   */
  handoffRequestId?: string | undefined;
  /** `kind === 'handoffDecision'`のときの決定。受信側が`SharedHandoffDecision`として検証する。 */
  handoffDecision?: string | undefined;
  /** `handoffDecision === 'repick'`のときに指定するmodel。空文字はCLIの既定。 */
  handoffModel?: string | undefined;
  /** `handoffDecision === 'repick'`のときに指定するeffort。空文字はCLIの既定。 */
  handoffEffort?: string | undefined;
  /**
   * `kind === 'answerQuestion'` / `'answerPrompt'`のときの、対象の要求id（Issue #2135）。
   * `answerTaskRunQuestion`では使わず、`pendingId`で引く。
   */
  pendingRequestId?: string | undefined;
  /** `kind === 'answerTaskRunQuestion'`のときの`PendingItem.id`（Issue #2135）。 */
  pendingId?: string | undefined;
  /** `kind === 'answerQuestion'`のときの回答（質問文→選んだラベル）。受信側が質問と突き合わせる。 */
  answers?: Record<string, string[]> | undefined;
  /** `kind === 'answerPrompt'`のときの回答。受信側が形と制約を確かめる。 */
  submission?: unknown;
  /**
   * `kind === 'sendWithAttachments'`のときの画像（データURL。Issue #2158）。
   *
   * パスで渡さず中身を載せる。パスを書けば受信側にそのファイルを読ませられてしまうため。
   * 大きさは`parseAttachmentInputs`の上限（base64で約14MB）に収まり、要求ファイル全体は
   * `MAX_REQUEST_FILE_BYTES`で頭打ちにする。
   */
  attachments?: AttachmentInput[] | undefined;
  /** `kind === 'fileCandidates'`のときの絞り込みの文字列（Issue #2158）。 */
  query?: string | undefined;
  /** `kind === 'cancelQueued'`のときの位置（Issue #2158）。照合には使わず補助。 */
  index?: number | undefined;
  /** `kind === 'changeSetting'`のときの設定の種別（Issue #2159）。受信側が検証する。 */
  setting?: string | undefined;
  /** `kind === 'changeSetting'`のときの値。model・effort・承認レベルは文字列、plan/fastは真偽値。 */
  settingValue?: string | boolean | undefined;
  /** `kind === 'cancelQueued'`のときの項目id。 */
  queuedId?: string | undefined;
  /** `kind === 'rename'`のときの新しい名前（Issue #2160）。受信側が検証する。 */
  name?: string | undefined;
  /** `kind === 'rewindPreview'` / `'rewind'`のときの戻す起点の発言のid（Issue #2160）。 */
  messageId?: string | undefined;
}

/** 要求に対する応答。 */
export interface SessionHubReply {
  requestId: string;
  ok: boolean;
  error?: string | undefined;
  /** 取り寄せた中身（Issue #1259）。応答ファイルは読んだ側が消すため、共有領域には残らない。 */
  payload?: SessionHubReplyPayload | undefined;
}

/** 受信側のハンドラが返す結果。応答ファイルの中身は`requestId`を添えてこれから作る。 */
export interface SessionHubRequestOutcome {
  ok: boolean;
  error?: string | undefined;
  payload?: SessionHubReplyPayload | undefined;
}

/**
 * 要求ファイル1つの大きさの上限（Issue #2158）。画像の添付（データURLで合計約14MB。
 * `MAX_TOTAL_DATA_URL_CHARS`）が収まり、それ以上は読まない。
 */
export const MAX_REQUEST_FILE_BYTES = 16 * 1024 * 1024;

/** 応答を待つ上限。これを過ぎたら要求ファイルを取り下げる。 */
const REPLY_TIMEOUT_MS = 5_000;
/**
 * CLIを起動する操作（archive・delete。Issue #2149）の応答を待つ上限。`REQUEST_TTL_MS`より
 * 短くし、受信側の掃除で要求・応答が消される前に打ち切る。受信側はターンの中断（上限5秒）と
 * CLI（`execFile`の上限30秒）を順に待つため、その合計より長くする。
 */
export const LONG_REPLY_TIMEOUT_MS = 45_000;
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
  // `requestId`は応答ファイルの名前になる。形で弾かないと`replies/`の外へ書かされる
  if (typeof v.requestId !== 'string' || !isSafeId(v.requestId) || typeof v.kind !== 'string') {
    return undefined;
  }
  if (typeof v.from !== 'string' || !isSafeId(v.from) || typeof v.issuedAt !== 'number') {
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
    approvalRequestId: typeof v.approvalRequestId === 'string' ? v.approvalRequestId : undefined,
    decision: typeof v.decision === 'string' ? v.decision : undefined,
    limit: typeof v.limit === 'number' ? v.limit : undefined,
    before: typeof v.before === 'number' ? v.before : undefined,
    sideQuestionId: typeof v.sideQuestionId === 'string' ? v.sideQuestionId : undefined,
    handoffRequestId: typeof v.handoffRequestId === 'string' ? v.handoffRequestId : undefined,
    handoffDecision: typeof v.handoffDecision === 'string' ? v.handoffDecision : undefined,
    handoffModel: typeof v.handoffModel === 'string' ? v.handoffModel : undefined,
    handoffEffort: typeof v.handoffEffort === 'string' ? v.handoffEffort : undefined,
    pendingRequestId: typeof v.pendingRequestId === 'string' ? v.pendingRequestId : undefined,
    pendingId: typeof v.pendingId === 'string' ? v.pendingId : undefined,
    answers: parseAskUserQuestionAnswers(v.answers),
    submission: v.submission,
    attachments: parseAttachmentInputs(v.attachments),
    query: typeof v.query === 'string' ? v.query : undefined,
    index: typeof v.index === 'number' ? v.index : undefined,
    queuedId: typeof v.queuedId === 'string' ? v.queuedId : undefined,
    name: typeof v.name === 'string' ? v.name : undefined,
    messageId: typeof v.messageId === 'string' ? v.messageId : undefined,
    setting: typeof v.setting === 'string' ? v.setting : undefined,
    settingValue:
      typeof v.settingValue === 'string' || typeof v.settingValue === 'boolean'
        ? v.settingValue
        : undefined,
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
    payload: parsePayload(v.payload),
  };
}

/**
 * 応答から読み取る上限（Issue #1260）。
 *
 * 書き手側の上限（`chatManagerBase.ts`の`MAX_RECENT_TURNS` / `MAX_RECENT_TURN_CHARS`）
 * とは別に、読み手側でも持つ。共有ディレクトリへ書くのは別プロセスで、その版が同じ
 * 上限で絞っている保証は無い。書き手側より少しだけ緩くして、正しい相手からの応答を
 * 切り落とさないようにする。
 *
 * Issue #2157で会話を範囲指定で遡れるようにしたため、書き手の1回分（50件・本文8,000字）に
 * 合わせて引き上げた。
 */
const MAX_REPLY_TURNS = 60;
const MAX_REPLY_TEXT_CHARS = 2_000;
/** やり取り1件の本文の上限（Issue #2157。書き手の8,000字より少しだけ緩くする）。 */
const MAX_REPLY_TURN_TEXT_CHARS = 10_000;
/** `tool` / `diff`の見出しの上限（Issue #2157）。 */
const MAX_REPLY_TITLE_CHARS = 1_000;

/**
 * 脇道の質問の回答として読み取る上限（Issue #1261）。
 *
 * 直近のやり取り（`MAX_REPLY_TEXT_CHARS`）より緩くする。やり取りは流れを掴むための
 * 抜粋だが、回答はそれ自体が読みたいもので、途中で切れると用を成さない。書き手側
 * （`chatManagerBase.ts`の`MAX_SIDE_QUESTION_ANSWER_CHARS`）より少しだけ緩くして、
 * 正しい相手からの回答を切り落とさないようにする。
 */
const MAX_REPLY_ANSWER_CHARS = 8_000;

/**
 * Composerの候補・送信キューとして読み取る上限（Issue #2158）。書き手の上限（ファイル候補50件・
 * キューの本文`MAX_QUEUED_TEXT_CHARS`）より少しだけ緩くする。
 */
const MAX_REPLY_FILES = 60;
const MAX_REPLY_PATH_CHARS = 1_000;
const MAX_REPLY_COMMANDS = 500;
const MAX_REPLY_COMMAND_NAME_CHARS = 200;
const MAX_REPLY_COMMAND_TEXT_CHARS = 1_000;
const MAX_REPLY_QUEUED = 100;

function parseCandidateFiles(raw: readonly unknown[]): string[] {
  return raw
    .filter(
      (f): f is string => typeof f === 'string' && f !== '' && f.length <= MAX_REPLY_PATH_CHARS,
    )
    .slice(0, MAX_REPLY_FILES);
}

function parseSlashCommands(raw: readonly unknown[]): SessionSlashCommand[] {
  const commands: SessionSlashCommand[] = [];
  for (const entry of raw) {
    if (commands.length >= MAX_REPLY_COMMANDS) {
      break;
    }
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const v = entry as Record<string, unknown>;
    if (
      typeof v.name !== 'string' ||
      v.name === '' ||
      v.name.length > MAX_REPLY_COMMAND_NAME_CHARS
    ) {
      continue;
    }
    commands.push({
      name: v.name,
      description:
        typeof v.description === 'string'
          ? v.description.slice(0, MAX_REPLY_COMMAND_TEXT_CHARS)
          : '',
      argumentHint:
        typeof v.argumentHint === 'string'
          ? v.argumentHint.slice(0, MAX_REPLY_COMMAND_TEXT_CHARS)
          : '',
    });
  }
  return commands;
}

function parseQueuedMessages(raw: readonly unknown[]): SessionQueuedMessage[] {
  const queued: SessionQueuedMessage[] = [];
  for (const entry of raw) {
    if (queued.length >= MAX_REPLY_QUEUED) {
      break;
    }
    // 位置で取り消すため、読めない要素も落とさず空の1件として数える（位置がずれないように）
    const v = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const text = typeof v.text === 'string' ? v.text : '';
    queued.push({
      id: typeof v.id === 'string' ? v.id : '',
      text: text.slice(0, MAX_QUEUED_TEXT_CHARS),
      truncated: v.truncated === true || text.length > MAX_QUEUED_TEXT_CHARS,
      attachments:
        typeof v.attachments === 'number' &&
        Number.isSafeInteger(v.attachments) &&
        v.attachments >= 0
          ? v.attachments
          : 0,
    });
  }
  return queued;
}

/**
 * 応答の`payload`を、信用せずに読み解く（Issue #1259）。
 *
 * 中身は別プロセス（版が違うこともある）が書いた文字列で、そのまま画面へ流す。
 * 形の合わない要素は落とし、1つでも読めた分だけを返す。
 */
function parsePayload(value: unknown): SessionHubReplyPayload | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const sideQuestion = parseSideQuestion(v.sideQuestion);
  if (sideQuestion !== undefined) {
    return { sideQuestion };
  }
  if (Array.isArray(v.turns)) {
    const turns = parseRecentTurns(v.turns);
    const range = parseTurnRange(v.turnStart, v.turnTotal, v.turns.length, turns.length);
    return {
      turns,
      capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : undefined,
      turnStart: range?.start,
      turnTotal: range?.total,
    };
  }
  if (v.handoff !== undefined) {
    const handoff = parseHandoffDetail(v.handoff);
    return handoff === undefined ? undefined : { handoff };
  }
  // Issue #2158: Composerの候補・送信キュー
  if (Array.isArray(v.files)) {
    return { files: parseCandidateFiles(v.files) };
  }
  if (Array.isArray(v.commands)) {
    return { commands: parseSlashCommands(v.commands) };
  }
  if (Array.isArray(v.queued)) {
    return { queued: parseQueuedMessages(v.queued) };
  }
  // Issue #2160: 巻き戻しで戻るファイル。形は補完の候補と同じ（相対・絶対のパスの配列）
  if (Array.isArray(v.rewindFiles)) {
    return { rewindFiles: parseCandidateFiles(v.rewindFiles) };
  }
  // Issue #2159: 実行中セッションの設定
  if (v.settings !== undefined) {
    const settings = parseSessionSettingsDetail(v.settings);
    return settings === undefined ? undefined : { settings };
  }
  const raw = v.approvals;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const approvals: SessionApprovalDetail[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const v = entry as Record<string, unknown>;
    if (typeof v.requestId !== 'string' || typeof v.kind !== 'string') {
      continue;
    }
    approvals.push({
      requestId: v.requestId,
      kind: v.kind,
      title: typeof v.title === 'string' ? v.title : '',
      detail: typeof v.detail === 'string' ? v.detail : '',
      paths: Array.isArray(v.paths)
        ? v.paths.filter((p): p is string => typeof p === 'string')
        : [],
      // 読めない版から届いた場合は押せない側へ倒す。誤って承認させない
      decidable: v.decidable === true,
      // 回答の形（Issue #2135）は付いているときだけ載せる。無ければ承認・拒否として扱う
      ...(v.answer === 'choices' || v.answer === 'text' ? { answer: v.answer } : {}),
      ...optionalField('questions', parseSharedQuestions(v.questions)),
      ...optionalField('fields', parseSharedPromptFields(v.fields)),
      ...optionalField(
        'answerBlockedReason',
        typeof v.answerBlockedReason === 'string' ? v.answerBlockedReason : undefined,
      ),
    });
  }
  return { approvals };
}

/** 値があるときだけその項目を持つオブジェクトにする（無い項目を`undefined`で生やさない）。 */
function optionalField<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

const MAX_REPLY_QUESTIONS = 10;
const MAX_REPLY_OPTIONS = 20;
const MAX_REPLY_FIELDS = 20;
const MAX_REPLY_LABEL_CHARS = 500;

function readText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_REPLY_LABEL_CHARS) : '';
}

/** AskUserQuestionの質問一覧を、信用せずに読み解く（Issue #2135）。 */
function parseSharedQuestions(value: unknown): SharedAskUserQuestion[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const questions: SharedAskUserQuestion[] = [];
  for (const entry of value.slice(0, MAX_REPLY_QUESTIONS)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const q = entry as Record<string, unknown>;
    // 質問文は回答のキーになる。切り詰めると送り返したときに一致しないため、長すぎる質問は落とす
    if (typeof q.question !== 'string' || q.question.length > MAX_REPLY_TEXT_CHARS) {
      continue;
    }
    questions.push({
      question: q.question,
      header: readText(q.header),
      options: Array.isArray(q.options)
        ? q.options
            .slice(0, MAX_REPLY_OPTIONS)
            .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
            .filter((o) => typeof o.label === 'string' && o.label.length <= MAX_REPLY_LABEL_CHARS)
            .map((o) => ({ label: o.label as string, description: readText(o.description) }))
        : [],
      multiSelect: q.multiSelect === true,
    });
  }
  return questions;
}

/** Codexの問い合わせの入力欄を、信用せずに読み解く（Issue #2135）。 */
function parseSharedPromptFields(value: unknown): SharedPromptField[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields: SharedPromptField[] = [];
  for (const entry of value.slice(0, MAX_REPLY_FIELDS)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const f = entry as Record<string, unknown>;
    if (typeof f.id !== 'string' || f.id.length > MAX_REPLY_LABEL_CHARS) {
      continue;
    }
    fields.push({
      id: f.id,
      label: readText(f.label),
      description: readText(f.description),
      options: Array.isArray(f.options)
        ? f.options
            .slice(0, MAX_REPLY_OPTIONS)
            .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
            .filter((o) => typeof o.value === 'string' && o.value.length <= MAX_REPLY_LABEL_CHARS)
            .map((o) => ({ value: o.value as string, label: readText(o.label) }))
        : [],
      multiple: f.multiple === true,
      allowOther: f.allowOther === true,
      required: f.required === true,
    });
  }
  return fields;
}

/**
 * 脇道の質問の進み具合を、信用せずに読み解く（Issue #1261）。
 *
 * 形が合わなければ`undefined`を返し、呼び出し側は`payload`そのものを無かったものと
 * して扱う。`status`は3値のホワイトリストで確かめる。知らない値を通すと、画面が
 * 「回答待ち」でも「完了」でもない状態のまま固まる。
 */
function parseSideQuestion(value: unknown): SessionSideQuestion | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.question !== 'string') {
    return undefined;
  }
  if (v.status !== 'running' && v.status !== 'done' && v.status !== 'failed') {
    return undefined;
  }
  return {
    id: v.id,
    status: v.status,
    question: cap(v.question, MAX_REPLY_TEXT_CHARS),
    answer: typeof v.answer === 'string' ? cap(v.answer, MAX_REPLY_ANSWER_CHARS) : undefined,
    error: typeof v.error === 'string' ? cap(v.error, MAX_REPLY_TEXT_CHARS) : undefined,
  };
}

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 直近のやり取りも同じ方針で読み解く。形の合わない要素は落とす（Issue #1260）。
 *
 * 書き手は`readRecentTurns`で件数と文字数を絞ってから書くが、それは同じ版どうしの
 * 約束にすぎない。壊れたファイル・別の版が書いた巨大な配列や長大な文字列をそのまま
 * 画面へ流さないよう、読み手でも上限で切る。
 */
function parseRecentTurns(raw: readonly unknown[]): SessionRecentTurn[] {
  const turns: SessionRecentTurn[] = [];
  for (const entry of raw) {
    if (turns.length >= MAX_REPLY_TURNS) {
      break;
    }
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const v = entry as Record<string, unknown>;
    if (
      (v.role !== 'user' && v.role !== 'agent' && v.role !== 'tool' && v.role !== 'diff') ||
      typeof v.text !== 'string'
    ) {
      continue;
    }
    const capped = v.text.length > MAX_REPLY_TURN_TEXT_CHARS;
    turns.push({
      role: v.role,
      text: capped ? v.text.slice(0, MAX_REPLY_TURN_TEXT_CHARS) : v.text,
      // こちらで切った分も「続きがある」ものとして扱う
      truncated: capped || v.truncated === true,
      title: typeof v.title === 'string' ? cap(v.title, MAX_REPLY_TITLE_CHARS) : undefined,
      // 巻き戻しの起点に使う発言のid（Issue #2160）。受信側が会話と突き合わせるので形だけ見る
      id: v.role === 'user' ? parseTurnId(v.id) : undefined,
    });
  }
  return turns;
}

/**
 * 応答の範囲（`turnStart` / `turnTotal`）を読み解く（Issue #2157）。
 *
 * 形の合わない要素を落とした・件数の上限で切ったときは、位置が実際の会話とずれるため
 * 範囲を捨てる（要求側はそれ以上遡らない。ずれた位置で継ぎ足して会話を壊すよりよい）。
 */
function parseTurnRange(
  rawStart: unknown,
  rawTotal: unknown,
  rawCount: number,
  parsedCount: number,
): { start: number; total: number } | undefined {
  if (!Number.isSafeInteger(rawStart) || !Number.isSafeInteger(rawTotal)) {
    return undefined;
  }
  const start = rawStart as number;
  const total = rawTotal as number;
  if (rawCount !== parsedCount || start < 0 || start + parsedCount > total) {
    return undefined;
  }
  return { start, total };
}

/** 選び直しの候補の上限（Issue #1280）。モデル一覧がこの数を超えることは実際には無い。 */
const MAX_REPLY_MODEL_OPTIONS = 100;

/**
 * 判定理由の件数の上限（Issue #1280）。
 *
 * 1件ずつの長さだけでなく件数も抑える。統括ページは理由を1件1行で並べるため、
 * 巨大な配列がそのまま届くとカードの中に大量の行を作ることになる。
 */
const MAX_REPLY_REASONS = 40;

/**
 * 保留中の引き継ぎ確認を、信用せずに読み解く（Issue #1280）。
 *
 * 版の違うウィンドウが書いた値なので、必須の項目が欠けていれば丸ごと捨てる。
 * 「再判定できる」は読めない版から届いたときに押せない側へ倒す（`decidable`と同じ方針）。
 */
function parseHandoffDetail(value: unknown): SessionHandoffDetail | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== 'string' || typeof v.model !== 'string') {
    return undefined;
  }
  return {
    requestId: v.requestId,
    model: v.model,
    effort: typeof v.effort === 'string' ? v.effort : '',
    reasons: Array.isArray(v.reasons)
      ? v.reasons
          .filter((r): r is string => typeof r === 'string')
          .slice(0, MAX_REPLY_REASONS)
          .map((r) => (r.length > MAX_REPLY_TEXT_CHARS ? r.slice(0, MAX_REPLY_TEXT_CHARS) : r))
      : [],
    trigger: typeof v.trigger === 'string' ? v.trigger : '',
    canReclassify: v.canReclassify === true,
    models: Array.isArray(v.models) ? parseHandoffModelOptions(v.models) : [],
  };
}

/**
 * 実行中セッションの設定を、信用せずに読み解く（Issue #2159）。
 *
 * 範囲の分からない値は変更できない側へ倒す: 承認の範囲が読めなければ`task`（変えられない）、
 * `editable`は`true`のときだけ変更を受け付ける。
 */
export function parseSessionSettingsDetail(value: unknown): SessionSettingsDetail | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.model !== 'string' || typeof v.effort !== 'string') {
    return undefined;
  }
  const scope = v.approvalScope;
  return {
    model: v.model.slice(0, MAX_SETTING_VALUE_CHARS),
    effort: v.effort.slice(0, MAX_SETTING_VALUE_CHARS),
    models: Array.isArray(v.models) ? parseHandoffModelOptions(v.models) : [],
    approvalLevel: isApprovalLevel(v.approvalLevel) ? v.approvalLevel : '',
    approvalScope: scope === 'session' || scope === 'global' ? scope : 'task',
    planMode: v.planMode === true,
    fastMode: typeof v.fastMode === 'boolean' ? v.fastMode : undefined,
    editable: v.editable === true,
  };
}

function parseHandoffModelOptions(raw: readonly unknown[]): SessionHandoffModelOption[] {
  const options: SessionHandoffModelOption[] = [];
  for (const entry of raw) {
    if (options.length >= MAX_REPLY_MODEL_OPTIONS) {
      break;
    }
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const v = entry as Record<string, unknown>;
    if (typeof v.slug !== 'string') {
      continue;
    }
    options.push({
      slug: v.slug,
      label: typeof v.label === 'string' && v.label !== '' ? v.label : v.slug,
      efforts: Array.isArray(v.efforts)
        ? v.efforts.filter((e): e is string => typeof e === 'string')
        : [],
    });
  }
  return options;
}

/**
 * 中身がすべて期限切れの要求ディレクトリを、ディレクトリごと消す。
 *
 * 空のディレクトリは消さない。`mkdir`から最初の書き込みまでの一瞬を掃除と取り合うと、
 * 送った直後の要求を消してしまう。中身が無いディレクトリ1つが残るだけなので害は無い。
 */
async function removeIfAbandoned(dir: string, now: number): Promise<void> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  if (files.length === 0) {
    return;
  }
  for (const file of files) {
    if (!(await isStaleFile(path.join(dir, file), now))) {
      // 1つでも新しい要求が残っていれば、宛先のウィンドウがこれから拾う可能性がある
      return;
    }
  }
  for (const file of files) {
    try {
      await unlink(path.join(dir, file));
    } catch {
      return;
    }
  }
  try {
    await rmdir(dir);
  } catch {
    // 消せない・使われ始めた場合は次の周回に任せる
  }
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
      approvalRequestId?: string | undefined;
      decision?: string | undefined;
      limit?: number | undefined;
      before?: number | undefined;
      sideQuestionId?: string | undefined;
      handoffRequestId?: string | undefined;
      handoffDecision?: string | undefined;
      handoffModel?: string | undefined;
      handoffEffort?: string | undefined;
      pendingRequestId?: string | undefined;
      pendingId?: string | undefined;
      answers?: Record<string, string[]> | undefined;
      submission?: unknown;
      attachments?: AttachmentInput[] | undefined;
      query?: string | undefined;
      index?: number | undefined;
      queuedId?: string | undefined;
      setting?: string | undefined;
      settingValue?: string | boolean | undefined;
      name?: string | undefined;
      messageId?: string | undefined;
    },
    /** 応答を待つ上限（ms）。既定は`REPLY_TIMEOUT_MS`。`LONG_REPLY_TIMEOUT_MS`を超えない。 */
    timeoutMs: number = REPLY_TIMEOUT_MS,
  ): Promise<SessionHubReply> {
    const requestId = randomUUID();
    if (!isSafeId(targetWindowId)) {
      // 共有ファイルの読み取り口で弾いている値だが、パスを組み立てる直前でも確かめる
      this.log.warn('セッション統括: 宛先のwindowIdの形が不正なため要求を送りませんでした');
      return { requestId, ok: false, error: '宛先のウィンドウを特定できませんでした' };
    }
    const request: SessionHubRequest = {
      ...input,
      requestId,
      from: this.selfWindowId,
      issuedAt: Date.now(),
    };
    const filePath = path.join(requestsDirFor(this.root, targetWindowId), `${requestId}.json`);
    const body = JSON.stringify(request);
    // 受け取る側は上限を超える要求ファイルを読まずに捨てる。書く前に断り、相手を待たない
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_FILE_BYTES) {
      return { requestId, ok: false, error: '送る内容が大きすぎます（画像を減らしてください）' };
    }
    try {
      await mkdir(requestsDirFor(this.root, targetWindowId), { recursive: true });
      await mkdir(repliesDir(this.root), { recursive: true });
      await writeAtomic(filePath, body);
    } catch (e) {
      this.log.warn(`セッション統括: 要求の送信に失敗しました（${input.kind}）: ${String(e)}`);
      return { requestId, ok: false, error: '要求を送れませんでした' };
    }
    const reply = await this.waitForReply(
      requestId,
      Math.min(Math.max(timeoutMs, 0), LONG_REPLY_TIMEOUT_MS),
    );
    if (reply !== undefined) {
      return reply;
    }
    try {
      await unlink(filePath);
    } catch {
      // 既に相手が取っていた場合。応答だけが遅れているので、そのまま失敗として返す
    }
    return {
      requestId,
      ok: false,
      // 応答が来なかっただけで、相手が実行した後に落ちた可能性もある。二重に送る前に
      // 相手の画面を確かめられるよう、断定しない文にする
      error: '相手のウィンドウから応答がありませんでした（実行されている場合があります）',
    };
  }

  /**
   * `replies/<requestId>.json`が現れるのを待つ。
   *
   * 要求ごとに`fs.watch`を張らず、短い間隔の読み直しで待つ。監視は張り直しのたびに
   * 取りこぼしの余地があり（`SessionHubReader`が`filename`無しのイベントを想定して
   * いるのと同じ事情）、5秒という上限の中では読み直しの方が単純で確実。
   */
  private async waitForReply(
    requestId: string,
    timeoutMs: number,
  ): Promise<SessionHubReply | undefined> {
    const replyPath = path.join(repliesDir(this.root), `${requestId}.json`);
    const deadline = Date.now() + timeoutMs;
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
        // 監視先が消える・権限が変わると非同期の`error`が飛ぶ。拾わないと拡張ホストごと落ちる
        this.watcher.on('error', (e: unknown) => {
          this.log.warn(`セッション統括: 要求の監視が止まりました: ${String(e)}`);
        });
        void this.sweep();
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
    // 画像を載せる要求（Issue #2158）があるため大きさを先に見る。上限を超えるものは読まずに捨てる
    // （共有ディレクトリへ書ける誰かが巨大なファイルを置いても、拡張ホストのメモリを食わせない）
    try {
      const info = await stat(filePath);
      if (info.size > MAX_REQUEST_FILE_BYTES) {
        await unlink(filePath);
        this.log.warn(`セッション統括: 大きすぎる要求を捨てました（${info.size} bytes）`);
        return;
      }
    } catch {
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
    await this.sweepAbandonedDirs(now);
  }

  /**
   * 閉じたウィンドウ宛ての要求ディレクトリを消す。
   *
   * `windowId`は拡張ホストの起動ごとに作り直すため（`extension.ts`の`generateWindowId`）、
   * 閉じたウィンドウ宛ての`requests/<windowId>/`は二度と読まれない。自分では掃除しない
   * ので、生きているウィンドウが代わりに消さないと増え続ける。
   */
  private async sweepAbandonedDirs(now: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(requestsDir(this.root));
    } catch {
      return;
    }
    for (const name of names) {
      const dir = path.join(requestsDir(this.root), name);
      if (dir !== this.dir) {
        await removeIfAbandoned(dir, now);
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
