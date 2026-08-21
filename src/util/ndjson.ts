import { MAX_LINE_BUFFER_BYTES } from '../process/childProcess';

export interface NdjsonResult<T> {
  values: T[];
  /** 次のチャンクと連結するために残す、行として完成していない部分。 */
  rest: string;
  /**
   * `rest`が上限（{@link MAX_LINE_BUFFER_BYTES}）を超えたか（issue #402）。
   *
   * 立ったら呼び出し側は`rest`をそのまま使い続けず、セッションを切って再起動すること。
   * ここでは切断はしない（このモジュールは純粋なパース処理に留め、プロセスの
   * 生死を扱わないため）。
   */
  overflow: boolean;
}

/**
 * 改行区切りJSONのストリームから、完成した行だけを取り出す。
 *
 * パースできない行は捨てる。CLIは診断メッセージを標準出力に混ぜることがあり、
 * そこで全体を止めるとチャットが死ぬため。
 */
export function consumeNdjson(buffer: string): NdjsonResult<Record<string, unknown>> {
  const values: Record<string, unknown>[] = [];
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
    const parsed = parseObject(line);
    if (parsed !== undefined) {
      values.push(parsed);
    }
  }

  const overflow = Buffer.byteLength(rest, 'utf8') > MAX_LINE_BUFFER_BYTES;
  return { values, rest, overflow };
}

function parseObject(line: string): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}
