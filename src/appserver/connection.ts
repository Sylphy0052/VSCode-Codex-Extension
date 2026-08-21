import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '../log';
import {
  consumeFrames,
  encodeErrorResponse,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  isServerRequest,
  type JsonRpcMessage,
} from '../codex/jsonRpc';
import { killWithEscalation, MAX_LINE_BUFFER_BYTES } from '../process/childProcess';
import { guardStdinErrors, safeWriteStdin } from '../process/stdinSafety';

export interface ServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
/** 応答を返さないとCodexは待ち続けるため、必ず値を解決すること。 */
export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown>;

/**
 * `ChatSession` が実際に使う面だけを切り出した抽象。
 *
 * `AppServerConnection` は構造的にこれを満たすため、実装側は何も変えずそのまま渡せる。
 * テストでは子プロセスを立てないフェイクに差し替え、`thread/start` 等の応答を
 * その場で組み立てられるようにする（design.md §16.10、開始待ちの複数化のテストで使う）。
 */
export interface AppServerConnectionPort {
  ensureStarted(): Promise<void>;
  request(method: string, params: unknown): Promise<JsonRpcMessage>;
  dispose(): void;
}

const CLIENT_NAME = 'vscode-codex-extension';
const CLIENT_VERSION = '0.0.1';
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * `codex app-server` との接続を1本維持する。
 *
 * 会話のストリーミング（item系の通知）と承認要求（requestApproval系）を扱うため、
 * forkだけを行う AppServerClient と違いプロセスを常駐させる。スレッドは複数を
 * 1接続で扱えるので、拡張機能全体で1プロセスに収める。
 */
export class AppServerConnection {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();
  private starting: Promise<void> | undefined;
  /**
   * `reset()`が後始末すべき状態を持っているか（issue #354のレビュー指摘・LOW）。
   *
   * `proc`/`starting`/`pending`の3フィールドから推測するより、`start()`で明示的に
   * 立てて`reset()`で明示的に倒すほうが、将来経路が増えても壊れにくい。
   */
  private connected = false;

  constructor(
    private readonly codexPath: () => string,
    private readonly log: Logger,
    private readonly onNotification: NotificationHandler,
    private readonly onServerRequest: ServerRequestHandler,
    /**
     * 接続断（`reset()`が実際に状態を巻き戻したとき）を知らせる（issue #354）。
     *
     * `AppServerConnection` は全スレッドで共有される単一プロセスのため、ここで各
     * `ChatSession` の待機Promise（承認カード・問い合わせフォーム）を解放しないと、
     * app-serverがクラッシュしたときに開いている全スレッドの承認待ちが永久にハングする。
     */
    private readonly onDisconnect: () => void = () => undefined,
  ) {}

  /** 起動と初期化。多重呼び出しは同じ処理を共有する。 */
  async ensureStarted(): Promise<void> {
    if (this.proc !== undefined) {
      return;
    }
    this.starting ??= this.start();
    try {
      await this.starting;
    } catch (e) {
      // `initialize`失敗（`reset()`経由）は`reset()`内で既に`this.starting`を
      // `undefined`へ戻しているためここでは実質no-opだが、`spawn()`自体が同期的に
      // 投げる場合（EACCES等）は`reset()`を通らない。その経路は`start()`が最初の
      // `await`へ到達する前に例外を投げるため、`start()`内で`this.starting`を
      // 書き換えても、その代入は呼び出し元（この関数）の`this.starting ??= this.start()`
      // が返り値を代入するより前に走ってしまい、直後に上書きされて意味を持たない
      // （`??=`の右辺評価はメソッド呼び出しが返ってから代入される）。そのため
      // `ensureStarted()`側で`await`の失敗を捕まえて戻すことで、両経路を一箇所で
      // 確実にカバーする（issue #419、レビュー指摘・LOW）。ここで戻さないと、
      // 以降の`ensureStarted()`が同じ失敗したPromiseを返し続けるだけで、再起動を
      // 試みなくなる
      this.starting = undefined;
      throw e;
    }
  }

  private async start(): Promise<void> {
    const proc = spawn(this.codexPath(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.connected = true;

    // `proc.on('error')`は起動失敗しか拾わない。起動後に相手が終了した状態へ書き込むと
    // 飛ぶEPIPE等はここで捕まえないとNodeの未捕捉例外になる（issue #155、design.md §14.31）。
    // 常駐接続なので、接続が死んだものとして既存のexitハンドラと同じ経路（reset）へ寄せる。
    //
    // 以下の5ハンドラは、`start()`のこの呼び出しでクロージャに捕まえた`proc`（この世代の
    // プロセス）を対象とする。overflow等で`reset()`済みの後、`ensureStarted()`が次の
    // プロセスを起動し終えてから、古い世代のexit/error/stdinエラー・stdout/stderrの
    // 出力が遅れて届くことがある（issue #419、CRITICAL）。その時点で`this.proc`は
    // 既に新しいプロセスを指しているため、素通りで`reset()`を呼ぶ・`this.receive()`へ
    // 流すと新しい接続を巻き込んで壊す。`connected`はグローバルなラッチで世代を識別
    // できないため、`this.proc !== proc`で世代のずれを検出し、古い世代からの通知は
    // 捨てる（stdout/stderrも、overflow reset後にkillWithEscalation()がexitさせる
    // までの間に古いprocが吐き残す出力を無視するため同様に見る）。
    guardStdinErrors(proc, (e) => {
      if (this.proc !== proc) {
        return;
      }
      this.log.error(`app-serverへの書き込みに失敗しました: ${e.message}`);
      this.reset();
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) {
        return;
      }
      this.receive(chunk.toString('utf8'));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) {
        return;
      }
      const line = chunk.toString('utf8').trim();
      if (line !== '') {
        this.log.info(`[app-server] ${line.slice(0, 300)}`);
      }
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) {
        return;
      }
      this.log.warn(`app-serverが終了しました (code ${code ?? 'unknown'})`);
      this.reset();
    });
    proc.on('error', (e) => {
      if (this.proc !== proc) {
        return;
      }
      this.log.error(`app-serverを起動できません: ${e.message}`);
      this.reset();
    });

    // `initialize`がタイムアウト等で失敗しても、プロセス自体は生きていて`exit`は
    // 発火しない（issue #354）。ここで捕まえて明示的に殺し、`this.proc`を残さない
    // ようにしないと、以降の`ensureStarted()`が`proc !== undefined`だけを見て
    // ハンドシェイク未完了の壊れた接続を使い続けてしまう。
    try {
      await this.request('initialize', {
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
    } catch (e) {
      this.log.error(`app-serverの初期化に失敗しました: ${errorMessage(e)}`);
      // `initialize`待ちの間にoverflow（`receive()`）が起きていた場合、そちらで既に
      // `killWithEscalation(proc)` + `reset()`が済んでおり、`this.proc`は既にこの
      // `proc`とは別（`undefined`）になっている。ここで無条件にもう一度killすると、
      // 同じプロセスへ`kill()`を二重に呼び、3秒のエスカレーションタイマーと
      // `once('exit', ...)`リスナも2組残ってしまう（`exit`が来るまで解除されない）。
      // `this.proc === proc`の間だけ、まだ誰も後始末していない世代と判断してkillする
      // （issue #419、レビュー指摘・LOW）
      if (this.proc === proc) {
        // SIGTERMに応答しないハングしたプロセスも回収できるよう、SIGKILLへの
        // エスカレーションを共通処理へ寄せる（issue #402、2点目）。
        killWithEscalation(proc);
      }
      // `this.proc`が既に`undefined`（上のoverflow経由の`reset()`が先に済んでいる）
      // 場合はここは何もしない。まだこの`proc`のままなら、ここで`reset()`することで
      // `this.proc`を`undefined`に戻す。`proc.kill()`は非同期に`exit`を発火させるが、
      // その時点では`this.proc !== proc`（世代のずれ）としてexitハンドラ側の
      // 世代判定で素通りされるため、二重発火にはならない（自己レビュー: 再入時の
      // 無限ループなし）。
      this.reset();
      throw e;
    }
    this.write(encodeNotification('initialized', {}));
    this.log.info('app-serverに接続しました');
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    const { messages, rest, overflow } = consumeFrames(this.buffer);
    this.buffer = rest;

    try {
      // 完成した行（messages）は、上限超過の判定より先に処理する（レビュー指摘・MEDIUM）。
      // overflowを先に見て早期returnすると、同じチャンクの中に「正常に完成したメッセージ」と
      // 「上限超過の未完成行」が同居していた場合、正常に届いていた応答まで握りつぶしてしまう
      // （後続のreset()による一括エラー解決で待機自体は解けるが、本来成功していた応答が
      // 失敗応答へすり替わってしまう）。
      for (const message of messages) {
        if (isServerRequest(message)) {
          void this.handleServerRequest(message);
          continue;
        }
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
          continue;
        }
        if (message.method !== undefined) {
          this.onNotification(message.method, asRecord(message.params));
        }
      }
    } finally {
      // `finally`へ置くのは、forループ中のハンドラ（`onNotification`等、呼び出し側が
      // 渡すコールバック）が同期的に例外を投げた場合でも、overflow時の後始末（接続の
      // 切断・再起動）を必ず実行するため（レビュー指摘・LOW）。ループを先に処理する形へ
      // 入れ替えた際、例外で`if (overflow)`まで到達しない経路ができていた
      if (overflow) {
        // 改行を含まない出力（診断ログの乱れ・バイナリ混入等）が上限を超えて溜まり続けた
        // （issue #402、1点目）。このまま連結し続けると無制限にメモリを消費するため、
        // 接続を切って回収する。`reset()`が`this.buffer`も`''`へ戻すため、上のforループで
        // 処理済みの`messages`とは別に、上限超過分の`rest`がバッファに残り続けることはない。
        // `this.proc`も`undefined`へ戻るので、次の`ensureStarted()`が新しいプロセスを
        // 起動し直す（＝「切って再起動」はここで達成する）
        this.log.error(
          `app-serverからの出力が上限（${MAX_LINE_BUFFER_BYTES}バイト）を超えて改行なしで届いたため、接続を切って再起動します`,
        );
        if (this.proc !== undefined) {
          killWithEscalation(this.proc);
        }
        this.reset();
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    const method = message.method;
    if (id === undefined || method === undefined) {
      return;
    }
    try {
      const result = await this.onServerRequest({ id, method, params: asRecord(message.params) });
      this.write(encodeResponse(id, result));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.error(`要求 ${method} の処理に失敗しました: ${reason}`);
      this.write(encodeErrorResponse(id, reason));
    }
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-serverが応答しません: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) {
          reject(new Error(message.error.message));
          return;
        }
        resolve(message);
      });
      this.write(encodeRequest(id, method, params));
    });
  }

  notify(method: string, params: unknown): void {
    this.write(encodeNotification(method, params));
  }

  /**
   * 書き込み前に生存判定を行う（issue #155）。判定と書き込みの間の競合までは防げないため、
   * `start()`で購読した`guardStdinErrors`と併用する。
   */
  private write(line: string): void {
    if (this.proc !== undefined) {
      safeWriteStdin(this.proc, line);
    }
  }

  /**
   * 接続断の後始末。`proc`の`exit`/`error`ハンドラと、`start()`内の初期化失敗の両方から
   * 呼ばれうるため、既に後始末済みなら何もしない（二重発火防止。自己レビュー参照）。
   */
  private reset(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.proc = undefined;
    this.starting = undefined;
    this.buffer = '';
    for (const resolve of this.pending.values()) {
      resolve({ error: { code: -1, message: 'app-serverとの接続が切れました' } });
    }
    this.pending.clear();
    // `onDisconnect`は呼び出し側（`ChatViewManager`等）が用意したコールバック。ここは
    // `proc`の`exit`ハンドラから同期的に呼ばれるため、投げられた例外を捕まえ損ねると
    // Nodeの未捕捉例外になる（呼び出し側でも個別にtry/catchしているが、二重の安全策）。
    try {
      this.onDisconnect();
    } catch (e) {
      this.log.error(`接続断の通知処理に失敗しました: ${errorMessage(e)}`);
    }
  }

  dispose(): void {
    if (this.proc !== undefined) {
      killWithEscalation(this.proc);
    }
    this.reset();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
