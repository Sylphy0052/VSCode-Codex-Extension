import { StringDecoder } from 'node:string_decoder';
import { MAX_LINE_BUFFER_BYTES } from '../process/childProcess';

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
   * `rest`が上限（既定は{@link MAX_LINE_BUFFER_BYTES}。`consumeFrames`の第2引数で
   * 変えられる）を超えたか（issue #402）。
   *
   * 立ったら呼び出し側は`rest`をそのまま使い続けず、接続を切って再起動すること。
   * ここでは切断はしない（このモジュールは純粋なパース処理に留め、プロセスの
   * 生死を扱わないため）。
   */
  overflow: boolean;
}

/**
 * 改行区切りJSONのストリームを、完成した行だけメッセージに変換する。
 * パースできない行は捨てる（app-serverは診断メッセージを混ぜることがあるため）。
 *
 * `maxBytes`は未完成行（`rest`）の上限。app-server経路は会話アイテムを全件含む応答が
 * 1行で届くため`MAX_APP_SERVER_LINE_BYTES`を渡す（issue #795）。既定は他の経路と
 * 揃えた{@link MAX_LINE_BUFFER_BYTES}。
 */
export function consumeFrames(
  buffer: string,
  maxBytes: number = MAX_LINE_BUFFER_BYTES,
): FrameResult {
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

  return { messages, rest, overflow: exceedsByteLimit(rest, maxBytes) };
}

/**
 * `rest`のUTF-8バイト数が`maxBytes`を超えるか。
 *
 * `Buffer.byteLength`は文字列全体を走査するため、上限を大きく取ったapp-server経路
 * （`MAX_APP_SERVER_LINE_BYTES`）では、1行が完成するまでの毎チャンクで数十MBを
 * 数え直すことになる（issue #795）。UTF-8のバイト数はUTF-16のcode unit数以上・その3倍
 * 以下に必ず収まるので、まず安い`length`で決着する場合を先に返し、決着しない範囲でだけ
 * 実際に数える。
 */
function exceedsByteLimit(rest: string, maxBytes: number): boolean {
  if (rest.length > maxBytes) {
    return true;
  }
  if (rest.length * 3 <= maxBytes) {
    return false;
  }
  return Buffer.byteLength(rest, 'utf8') > maxBytes;
}

/**
 * 受信チャンクを溜めながら、完成した行だけを取り出す行バッファ（issue #795）。
 *
 * `consumeFrames`をチャンクごとにそのまま呼ぶと、1行が完成するまでの間、毎回バッファ全体を
 * `indexOf('\n')`で走査し直す。1行が数十MBになるapp-server経路（`thread/fork` /
 * `thread/resume` の応答）ではこれが積み上がり、40MBの応答を64KBずつ受けると約12秒かかる
 * （実測、2026-08-25）。改行を含まないチャンクでは行が完成しないと分かっているので、
 * そのときは連結だけして走査を省く。
 *
 * 上限の判定は省かない。改行が来ないまま溜まり続ける出力こそが防ぎたいもの
 * （issue #402、1点目）なので、バイト数を加算で持ち、チャンクごとに必ず見る。
 *
 * 文字列化には`StringDecoder`を使う。`chunk.toString('utf8')`をチャンクごとに呼ぶと、
 * マルチバイト文字がチャンクの境界で分断されたときに置換文字（U+FFFD）へ化けてJSONが
 * 壊れる（実測: `Buffer.from('{"t":"あいう"}')`は14通りの分割位置のうち6通りで壊れる）。
 * 1行が数十MBになる経路ではチャンクの境界が数百回以上できるため、日本語を含む会話では
 * ほぼ確実に踏む。`StringDecoder`は不完全なバイト列を次のチャンクまで持ち越す。
 */
export class FrameBuffer {
  private buffer = '';
  private bytes = 0;
  private decoder = new StringDecoder('utf8');

  constructor(private readonly maxBytes: number = MAX_LINE_BUFFER_BYTES) {}

  /** チャンクを受け取り、そこまでで完成した行を返す。 */
  push(chunk: Buffer): FrameResult {
    const text = this.decoder.write(chunk);
    this.buffer += text;
    // 持ち越されたバイトは`decoder`の中にあり`buffer`には入っていないため、chunkの長さ
    // ではなく実際に文字列化できた分を数える
    this.bytes += Buffer.byteLength(text, 'utf8');

    if (!text.includes('\n')) {
      // 行は完成していない。走査せず、上限の判定だけ行う
      return { messages: [], rest: this.buffer, overflow: this.bytes > this.maxBytes };
    }

    const result = consumeFrames(this.buffer, this.maxBytes);
    this.buffer = result.rest;
    this.bytes = Buffer.byteLength(result.rest, 'utf8');
    return result;
  }

  /** 溜めている未完成分を捨てる（接続を切るとき・上限超過の後始末）。 */
  clear(): void {
    this.buffer = '';
    this.bytes = 0;
    // `decoder`が持ち越している不完全なバイト列も捨てる。残したままだと、次に繋いだ
    // プロセスの最初のチャンクの先頭へ前の世代の残骸がくっつく
    this.decoder = new StringDecoder('utf8');
  }
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
