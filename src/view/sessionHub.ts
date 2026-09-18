import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApprovalDecision } from '../appserver/approvals';
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
        // 監視先が消える・権限が変わると非同期の`error`が飛ぶ。拾わないと拡張ホストごと落ちる
        this.watcher.on('error', (e: unknown) => {
          this.log.warn(`セッション統括: 共有ディレクトリの監視が止まりました: ${String(e)}`);
        });
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
      // 形の合わないファイル名は読まない。この値は要求の置き場所になる（Issue #1258）
      if (windowId === this.selfWindowId || !isSafeId(windowId)) {
        continue;
      }
      try {
        const raw = await readFile(path.join(sessionsDir(this.root), name), 'utf8');
        const parsed = parseSharedSessionFile(raw);
        if (parsed === undefined || now - parsed.updatedAt > STALE_MS) {
          continue;
        }
        // 採用するのはファイル名から取った`windowId`で、ファイルの中身の値ではない
        // （Issue #1258）。この値は要求ファイルの置き場所（`requests/<windowId>/`）を
        // 組み立てるのに使われるため、中身を信じると共有ディレクトリの外へ書かせられる
        results.push({ ...parsed, windowId });
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
  | 'handoffDecision';

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
 * 会話の直近のやり取り1件（Issue #1260）。
 *
 * 載せるのは人の発言とエージェントの応答だけで、コマンド実行・思考・ファイル変更は
 * 含めない。カードは会話の流れを掴むためのもので、詳細はタブ側で読む。
 */
export interface SessionRecentTurn {
  role: 'user' | 'agent';
  /** 本文。長いものは送る前に切り詰める（`truncated`が立つ）。 */
  text: string;
  /** 本文を切り詰めたか。画面は全文をタブ側で読むよう促す。 */
  truncated: boolean;
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
  /** `kind === 'sideQuestion'` / `'sideQuestionResult'`の応答（Issue #1261）。 */
  sideQuestion?: SessionSideQuestion | undefined;
  /** `kind === 'handoffDetail'`の応答（Issue #1280）。保留が無ければ`undefined`。 */
  handoff?: SessionHandoffDetail | undefined;
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
    sideQuestionId: typeof v.sideQuestionId === 'string' ? v.sideQuestionId : undefined,
    handoffRequestId: typeof v.handoffRequestId === 'string' ? v.handoffRequestId : undefined,
    handoffDecision: typeof v.handoffDecision === 'string' ? v.handoffDecision : undefined,
    handoffModel: typeof v.handoffModel === 'string' ? v.handoffModel : undefined,
    handoffEffort: typeof v.handoffEffort === 'string' ? v.handoffEffort : undefined,
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
 */
const MAX_REPLY_TURNS = 40;
const MAX_REPLY_TEXT_CHARS = 2_000;

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
    return {
      turns: parseRecentTurns(v.turns),
      capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : undefined,
    };
  }
  if (v.handoff !== undefined) {
    const handoff = parseHandoffDetail(v.handoff);
    return handoff === undefined ? undefined : { handoff };
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
    });
  }
  return { approvals };
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
    if ((v.role !== 'user' && v.role !== 'agent') || typeof v.text !== 'string') {
      continue;
    }
    const capped = v.text.length > MAX_REPLY_TEXT_CHARS;
    turns.push({
      role: v.role,
      text: capped ? v.text.slice(0, MAX_REPLY_TEXT_CHARS) : v.text,
      // こちらで切った分も「続きがある」ものとして扱う
      truncated: capped || v.truncated === true,
    });
  }
  return turns;
}

/** 選び直しの候補の上限（Issue #1280）。モデル一覧がこの数を超えることは実際には無い。 */
const MAX_REPLY_MODEL_OPTIONS = 100;

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
          .map((r) => (r.length > MAX_REPLY_TEXT_CHARS ? r.slice(0, MAX_REPLY_TEXT_CHARS) : r))
      : [],
    trigger: typeof v.trigger === 'string' ? v.trigger : '',
    canReclassify: v.canReclassify === true,
    models: Array.isArray(v.models) ? parseHandoffModelOptions(v.models) : [],
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
      sideQuestionId?: string | undefined;
      handoffRequestId?: string | undefined;
      handoffDecision?: string | undefined;
      handoffModel?: string | undefined;
      handoffEffort?: string | undefined;
    },
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
