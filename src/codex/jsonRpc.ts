export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface FrameResult {
  messages: JsonRpcMessage[];
  /** 次のチャンクと連結するために残す、行として完成していない部分。 */
  rest: string;
  /**
   * `rest`が上限（{@link MAX_LINE_BUFFER_BYTES}）を超えたか（issue #402）。
   *
   * 立ったら呼び出し側は`rest`をそのまま使い続けず、接続を切って再起動すること。
   * ここでは切断はしない（このモジュールは純粋なパース処理に留め、プロセスの
   * 生死を扱わないため）。
   */
  overflow: boolean;
}

/**
 * 改行を含まない1行分のバッファ上限（issue #402、1点目）。
 *
 * app-serverは改行までbufferへ無制限に連結し続けるため、CLI側が改行を含まない
 * 巨大な非JSON出力（診断ログの乱れ・バイナリ混入等）を吐き続けると際限なく
 * メモリを消費する。一方で正常な1メッセージ（大きめの差分やbase64画像を含む
 * ツール結果など）を誤って切り捨てたくない。
 *
 * このリポジトリでは同種の「1個の塊」の上限をいずれも10MBに揃えている
 * （`src/orchestrator/worktree.ts` の `GIT_MAX_BUFFER_BYTES`、
 * `src/orchestrator/forge.ts` の `CLI_MAX_BUFFER_BYTES`、
 * `src/provider/imageRefs.ts` の `MAX_IMAGE_BYTES`、
 * `src/provider/attachments.ts` の `MAX_TOTAL_BYTES`）。1メッセージの中に
 * 最大10MBの画像が1枚含まれていても壊れないよう、同じ10MBを踏襲する。
 */
export const MAX_LINE_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * 改行区切りJSONのストリームを、完成した行だけメッセージに変換する。
 * パースできない行は捨てる（app-serverは診断メッセージを混ぜることがあるため）。
 */
export function consumeFrames(buffer: string): FrameResult {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;

  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline === -1) {
      break;
    }
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line === '') {
      continue;
    }
    const parsed = parseMessage(line);
    if (parsed !== undefined) {
      messages.push(parsed);
    }
  }

  const overflow = Buffer.byteLength(rest, 'utf8') > MAX_LINE_BUFFER_BYTES;
  return { messages, rest, overflow };
}

function parseMessage(line: string): JsonRpcMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  return raw as JsonRpcMessage;
}

export function encodeRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

export function encodeNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}

/** サーバーからの要求への応答。返さないとCodexは待ち続ける。 */
export function encodeResponse(id: number | string, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

export function encodeErrorResponse(id: number | string, message: string): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })}\n`;
}

/** サーバー要求か（idを持つ通知）。応答が必須のものを見分ける。 */
export function isServerRequest(message: JsonRpcMessage): boolean {
  return message.method !== undefined && message.id !== undefined;
}

/**
 * `kill()`（既定SIGTERM）を送ってからSIGKILLへエスカレーションするまでの猶予（issue #402、2点目）。
 *
 * 短すぎると正常終了処理中のプロセスも巻き込みかねず、長すぎるとハングしたプロセスの
 * 回収が遅れる。他の要求系タイムアウト（`REQUEST_TIMEOUT_MS`=120秒等）よりずっと短くてよい
 * （SIGTERM後の後始末は一瞬で終わるはずで、応答を待つ種類の待ち時間ではないため）。
 */
export const KILL_ESCALATION_DELAY_MS = 3_000;

/**
 * `kill()`/`once('exit', ...)`を持つ、子プロセスの最小限の形。
 *
 * `ChildProcessWithoutNullStreams`はこれを満たすため、実装側は何も変えずそのまま渡せる。
 * テストでは`EventEmitter`ベースのフェイクをそのまま使える。
 */
export interface KillableProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * プロセスをSIGTERMで止め、一定時間内に`exit`が発火しなければSIGKILLへエスカレーション
 * する共通処理（issue #402、2点目）。
 *
 * `connection.ts` / `streamSession.ts` / `appServerClient.ts` の全`proc.kill()`呼び出しが
 * ここを経由する。ハングした子プロセス（SIGTERMに応答しない）を回収するためのもので、
 * 正常に`exit`したプロセスにはSIGKILLを送らない。
 *
 * タイマーは`unref()`し、`exit`が先に届いたら`clearTimeout`する。これによりプロセスが
 * 正常終了した後にタイマーだけがイベントループに残ることはない（自己レビュー: SIGKILL
 * タイマーの残留確認）。
 *
 * 注意: Node.jsの`ChildProcess#killed`は「シグナル送信に成功したか」を表すフラグで、
 * `kill()`を呼んだ時点で真になる（実際にexitしたかどうかは表さない）。そのため
 * ここでは`killed`を見ず、`exit`イベント自体で終了を判定する。
 */
export function killWithEscalation(proc: KillableProcess): void {
  let exited = false;
  proc.once('exit', () => {
    exited = true;
    clearTimeout(timer);
  });
  proc.kill();
  const timer = setTimeout(() => {
    if (!exited) {
      proc.kill('SIGKILL');
    }
  }, KILL_ESCALATION_DELAY_MS);
  timer.unref();
}

/** `thread/fork` の応答から新しいスレッドidを取り出す。 */
export function readForkedThreadId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const thread = (result as Record<string, unknown>)['thread'];
  if (typeof thread !== 'object' || thread === null) {
    return undefined;
  }
  const t = thread as Record<string, unknown>;
  const id = t['id'] ?? t['sessionId'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}
