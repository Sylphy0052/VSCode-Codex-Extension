/**
 * 入力欄で `/` を打ったときに出す候補。
 *
 * 送信そのものはCLIに任せる。`/name` をそのまま渡せば、Codexはカスタムプロンプトを
 * 展開し、Claude Codeはコマンドとして解釈する（どちらも実機で確認）。拡張機能側の
 * 仕事は「何が使えるか」を見せるところまで。
 */
export interface SlashCommand {
  name: string;
  description: string;
  /** 引数の書き方のヒント（`[readme | adr]` など）。無ければ空。 */
  argumentHint: string;
}

/**
 * プロンプト/スキルのファイルから候補を1件作る。
 *
 * frontmatterのうち `name` / `description` / `argument-hint` だけを見る。完全なYAML解析は
 * 不要で、値が複数行に折り返している場合は先頭行だけを採る。
 */
export function parseCommandFile(fileName: string, content: string): SlashCommand | undefined {
  const front = frontmatter(content);
  return {
    name: front['name'] || fileName,
    description: front['description'] ?? '',
    argumentHint: front['argument-hint'] ?? '',
  };
}

function frontmatter(content: string): Record<string, string> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') {
      break;
    }
    // 折り返しの継続行はインデントされる。先頭行だけを採るので読み飛ばす
    if (/^\s/.test(line)) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key !== '') {
      result[key] = unquote(line.slice(separator + 1).trim());
    }
  }
  return result;
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return quoted?.[1] ?? value;
}

/**
 * 入力に合う候補を絞る。
 *
 * 前方一致を先に並べる。打ち始めの数文字で目当てのものが上に来るようにするため。
 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.toLowerCase();
  if (needle === '') {
    return [...commands];
  }

  const prefix: SlashCommand[] = [];
  const partial: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) {
      prefix.push(command);
    } else if (name.includes(needle)) {
      partial.push(command);
    }
  }
  return [...prefix, ...partial];
}
