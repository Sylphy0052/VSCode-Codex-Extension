/**
 * `~/.claude/settings.json` のうち、拡張機能側を空にしたときに実際に使われる値だけを読む。
 *
 * 目的は表示のみ。設定の全体像を扱うのはCLIの責務なので、ここでは3つのキーしか見ない。
 */
export interface ClaudeDefaults {
  model: string | undefined;
  effort: string | undefined;
  permissionMode: string | undefined;
}

export const noClaudeDefaults: ClaudeDefaults = {
  model: undefined,
  effort: undefined,
  permissionMode: undefined,
};

export function extractClaudeDefaults(content: string): ClaudeDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 壊れていても表示が消えるだけで済むよう、既定値なしとして扱う
    return noClaudeDefaults;
  }

  const root = rec(parsed);
  if (root === undefined) {
    return noClaudeDefaults;
  }

  return {
    model: str(root['model']),
    effort: str(root['effortLevel']),
    permissionMode: str(rec(root['permissions'])?.['defaultMode']),
  };
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
