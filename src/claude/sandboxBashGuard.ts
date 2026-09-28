import { EXCLUDED_COMMANDS } from './sandbox';

/**
 * sandbox付きのセッションで、sandboxの外へ回らない形のネットワークコマンドを実行前に止める
 * PreToolUse hook（Issue #1668）。
 *
 * `excludedCommands`はコマンドの先頭で一致を見るため、`git -C <dir> push`や
 * `cd <dir> && git push`はsandbox内で走り、接続を拒否されて失敗する（Issue #1666）。
 * 失敗したセッションは「sandboxでpushが拒否された」と人へ操作を求めて止まるので、
 * 実行前に拒否し、単独の形で打ち直すよう理由を返す。指示文（`buildClaudeSandboxPrompt`）で
 * 同じことを伝えているが、守られなかった場合の受け皿になる。
 *
 * 判定は安全側の補助で、sandboxの境界ではない。見落としてもsandbox内で接続に失敗するだけで、
 * 承認を経ずに外へ出ることはない（`network.strictAllowlist`）。
 */

/** `initialize`の`hooks`で登録し、`hook_callback`で届くid。 */
export const SANDBOX_BASH_GUARD_CALLBACK_ID = 'sandbox_bash_guard';

/** `initialize`へ渡す`hooks`。Bashの実行前だけを受ける。 */
export function sandboxBashGuardHooks(): Record<string, unknown> {
  return { PreToolUse: [{ matcher: 'Bash', hookCallbackIds: [SANDBOX_BASH_GUARD_CALLBACK_ID] }] };
}

/** `excludedCommands`の各パターンを語へ分けたもの（末尾の`*`は除く）。 */
const NETWORK_COMMANDS: readonly (readonly string[])[] = EXCLUDED_COMMANDS.map((pattern) =>
  pattern.replace(/ \*$/, '').split(' '),
);

/** 後ろのコマンドをそのまま起動するラッパー。先頭にあるとパターンの先頭一致から外れる。 */
const WRAPPERS = new Set(['env', 'timeout', 'nice', 'nohup', 'time', 'command', 'sudo', 'stdbuf', 'exec']);

/** gitのグローバルオプションのうち、次の語を値に取るもの。 */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * コマンド文字列を、連結（`;` `&&` `||` `|` `&` 改行 括弧 バッククォート）で分けたコマンドごとの
 * 語の列にする。引用符の中は区切らず、引用符そのものは外す。`2>&1`や`&>`の`&`は区切りにしない。
 */
export function splitShellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;

  const endWord = (): void => {
    if (inWord) {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
    }
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== undefined) {
      if (c === quote) {
        quote = undefined;
      } else if (c === '\\' && quote === '"' && i + 1 < command.length) {
        word += command[++i];
      } else {
        word += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      // 行末の`\`は行の継続なので、改行を区切りとして扱わない
      if (command[i + 1] !== '\n') {
        word += command[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) {
      word += c;
      inWord = true;
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')' || c === '`') {
      endCommand();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

interface NetworkCommand {
  /** パターンの語（`git push`など）。 */
  name: readonly string[];
  /** パターンの語より後ろの引数。 */
  args: readonly string[];
  /** パターンの前に代入・ラッパー・gitのオプションが挟まっている。 */
  prefixed: boolean;
}

/** 1つのコマンドが`excludedCommands`に載ったコマンドなら、その内訳を返す。 */
function readNetworkCommand(words: readonly string[]): NetworkCommand | undefined {
  let i = 0;
  let prefixed = false;
  while (i < words.length && ASSIGNMENT.test(words[i])) {
    i++;
    prefixed = true;
  }
  while (i < words.length && WRAPPERS.has(words[i])) {
    i++;
    prefixed = true;
    // ラッパーのオプションと値（`timeout 60`の秒数、`env`の代入）を読み飛ばす
    while (i < words.length && (/^(-|\d)/.test(words[i]) || ASSIGNMENT.test(words[i]))) {
      i++;
    }
  }
  const head = words[i];
  if (head === undefined) {
    return undefined;
  }
  let sub = i + 1;
  if (head === 'git') {
    while (sub < words.length && words[sub].startsWith('-')) {
      sub += GIT_OPTIONS_WITH_VALUE.has(words[sub]) ? 2 : 1;
      prefixed = true;
    }
  }
  for (const name of NETWORK_COMMANDS) {
    if (name[0] !== head) {
      continue;
    }
    if (name.length === 1) {
      return { name, args: words.slice(i + 1), prefixed };
    }
    if (words[sub] === name[1]) {
      return { name, args: words.slice(sub + 1), prefixed };
    }
  }
  return undefined;
}

/** 打ち直しの例に出すため、空白や記号を含む語を単引用符で囲む。リダイレクト（`2>&1`）は囲まない。 */
function quoteWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word) || /^\d*[<>]/.test(word)) {
    return word;
  }
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * sandboxの外へ回らない形で書かれたネットワークコマンドがあれば、拒否理由を返す。
 * 無ければ`undefined`（そのまま実行させる）。
 */
export function sandboxBashGuardReason(command: string): string | undefined {
  const commands = splitShellCommands(command);
  for (const words of commands) {
    const found = readNetworkCommand(words);
    if (found === undefined || (commands.length === 1 && !found.prefixed)) {
      continue;
    }
    const retry = [...found.name, ...found.args].map(quoteWord).join(' ');
    return [
      `このコマンドはsandbox内で走り、ネットワークが拒否されて失敗するため実行しなかった。`,
      `${found.name.join(' ')}がsandboxの外で走るのは、1回のBash呼び出しにそれだけを単独で書き、先頭から始めたときに限る。`,
      `cd・git -C <dir>・環境変数・timeoutなどを前に付けず、;・&&・||・パイプで他のコマンドと連結せず、次の形で打ち直す: ${retry}`,
      '別のディレクトリで実行する必要があれば、先にcdだけを別のBash呼び出しで実行してから打つ。',
    ].join('\n');
  }
  return undefined;
}

/**
 * `hook_callback`要求への応答を組み立てる。拒否しないときは空の応答（通常どおり続行）を返す。
 * 要求の形（`input.tool_input.command`）はCLI 2.1.280で確認した。
 */
export function answerSandboxBashGuard(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload['callback_id'] !== SANDBOX_BASH_GUARD_CALLBACK_ID) {
    return {};
  }
  const input = payload['input'] as Record<string, unknown> | undefined;
  const toolInput = input?.['tool_input'] as Record<string, unknown> | undefined;
  const command = toolInput?.['command'];
  if (input?.['tool_name'] !== 'Bash' || typeof command !== 'string') {
    return {};
  }
  const reason = sandboxBashGuardReason(command);
  if (reason === undefined) {
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
