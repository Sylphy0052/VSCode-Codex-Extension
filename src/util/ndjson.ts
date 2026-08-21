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
 * 改行を含まない1行分のバッファ上限（issue #402、1点目）。
 *
 * CLIは改行までbufferへ無制限に連結し続けるため、改行を含まない巨大な非JSON出力
 * （診断ログの乱れ・バイナリ混入等）を吐き続けると際限なくメモリを消費する。一方で
 * 正常な1メッセージ（大きめの差分やbase64画像を含むツール結果など）を誤って
 * 切り捨てたくない。
 *
 * `src/codex/jsonRpc.ts` の `MAX_LINE_BUFFER_BYTES` と同じ10MBに揃える（根拠は
 * そちらのコメント参照）。値をimportで共有せずここでも定義しているのは、`src/util/`
 * 配下を特定ドメイン（`codex/`）へ依存させない、末端utilとしての位置付けを保つため。
 */
export const MAX_LINE_BUFFER_BYTES = 10 * 1024 * 1024;

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
