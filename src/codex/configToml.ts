export interface CodexDefaults {
  model: string | undefined;
  reasoningEffort: string | undefined;
  approvalMode: string | undefined;
  sandbox: string | undefined;
}

export const noDefaults: CodexDefaults = {
  model: undefined,
  reasoningEffort: undefined,
  approvalMode: undefined,
  sandbox: undefined,
};

/**
 * `~/.codex/config.toml` のトップレベルにある文字列値だけを読む。
 *
 * 目的は「拡張機能側を空にしたとき、実際に何が使われるか」の表示のみ。完全なTOML解析は
 * 不要なので、最初のテーブルヘッダ（`[section]`）に達したら読み終える。TOMLの意味論として
 * ヘッダ以降のキーはそのテーブルに属するため、これは正しい打ち切り方になる。
 */
export function parseTopLevelStrings(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (line === '') {
      continue;
    }
    if (line.startsWith('[')) {
      break; // ここから先はテーブル内のキー
    }

    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key !== '' && value !== '') {
      result[key] = value;
    }
  }

  return result;
}

/** 文字列の外側にある `#` 以降をコメントとして落とす。 */
function stripComment(line: string): string {
  let inQuote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote !== undefined) {
      if (ch === inQuote) {
        inQuote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** 表示に使うキーだけを取り出す。 */
export function extractDefaults(content: string): CodexDefaults {
  const values = parseTopLevelStrings(content);
  const pick = (key: string): string | undefined => {
    const v = values[key];
    return v === undefined || v === '' ? undefined : v;
  };
  return {
    model: pick('model'),
    reasoningEffort: pick('model_reasoning_effort'),
    approvalMode: pick('approval_policy'),
    sandbox: pick('sandbox_mode'),
  };
}
