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

/** `NETWORK_COMMANDS`の先頭の語（`git`・`gh`など）。 */
const NETWORK_HEADS = new Set(NETWORK_COMMANDS.map((name) => name[0]));

/** 後ろのコマンドをそのまま起動するラッパー。先頭にあるとパターンの先頭一致から外れる。 */
const WRAPPERS = new Set(['env', 'timeout', 'nice', 'nohup', 'time', 'command', 'sudo', 'stdbuf', 'exec']);

/** gitのグローバルオプションのうち、次の語を値に取るもの。 */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** fdの複製（`2>&1` `>&2`）と閉じる形（`>&-`）。ファイルを作らない。 */
const FD_DUPLICATE = /^\d*>&(\d+|-)$/;

export interface ShellCommand {
  /** 語の列。出力をファイルへ書くリダイレクトとその行き先は含めない。 */
  words: readonly string[];
  /** 出力をファイルへ書くリダイレクト（`>` `>>` `&>` `N>` `>&file`）がある。 */
  redirected: boolean;
}

/**
 * コマンド文字列を、連結（`;` `&&` `||` `|` `&` 改行 括弧 バッククォート）で分けたコマンドごとの
 * 語の列にする。引用符の中は区切らず、引用符そのものは外す。`2>&1`や`&>`の`&`は区切りにしない。
 *
 * 引用符の外の`>`で始まる出力のリダイレクトは、行き先と合わせて語から除き、`redirected`で示す。
 * リダイレクトの付いたネットワークコマンドはsandbox内で走り、ネットワークを拒否されて失敗する
 * （Issue #1674）。fdの複製は語に残す。`2>/dev/null`も、sandboxの外で走るかを実測していないので
 * ファイルへの書き込みとして扱う。
 */
export function splitShellCommands(command: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  /** いまの語が引用符の外の`>`から始まったリダイレクト。 */
  let redirect = false;
  /** 次の語が、行き先を離して書いたリダイレクト（`> out.json`）の行き先。 */
  let skipTarget = false;
  let redirected = false;

  const endWord = (): void => {
    if (inWord) {
      if (skipTarget) {
        skipTarget = false;
      } else if (redirect && !FD_DUPLICATE.test(word)) {
        redirected = true;
        skipTarget = /^(\d*|&)>>?&?$/.test(word);
      } else {
        words.push(word);
      }
    }
    word = '';
    inWord = false;
    redirect = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) {
      commands.push({ words, redirected });
    }
    words = [];
    skipTarget = false;
    redirected = false;
  };
  /** 引用符の外の`>`（`&>`では`&`）でリダイレクトを始める。`x>out`の`x`は別の語にする。 */
  const startRedirect = (): void => {
    if (!/^(\d*|&)$/.test(word)) {
      endWord();
    }
    redirect = true;
    inWord = true;
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
    } else if (c === '>' && !redirect) {
      startRedirect();
      word += c;
    } else if (c === '&' && command[i + 1] === '>' && !redirect) {
      startRedirect();
      word += c;
    } else if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<')) {
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
  /** 出力をファイルへリダイレクトしている。 */
  redirected: boolean;
}

/** 1つのコマンドが`excludedCommands`に載ったコマンドなら、その内訳を返す。 */
function readNetworkCommand({ words, redirected }: ShellCommand): NetworkCommand | undefined {
  let i = 0;
  let prefixed = false;
  while (ASSIGNMENT.test(words[i] ?? '')) {
    i++;
    prefixed = true;
  }
  if (i < words.length && WRAPPERS.has(words[i])) {
    // ラッパーのオプションは値を取るもの（`timeout -s SIGKILL 60`、`sudo -u <user>`）があり、
    // 語の形だけでは読み飛ばす数を決められない。後ろで最初に現れるネットワークコマンド名を
    // 起動されるコマンドとみなす
    const next = words.findIndex((word, k) => k > i && NETWORK_HEADS.has(word));
    if (next < 0) {
      return undefined;
    }
    i = next;
    prefixed = true;
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
      return { name, args: words.slice(i + 1), prefixed, redirected };
    }
    if (words[sub] === name[1]) {
      return { name, args: words.slice(sub + 1), prefixed, redirected };
    }
  }
  return undefined;
}

/**
 * 打ち直しの例に出すため、空白や記号を含む語を単引用符で囲む。fdの複製（`2>&1`）と入力の
 * リダイレクトは囲まない。出力をファイルへ書くリダイレクトは語に残っていないので、`>`で始まる
 * 残りの語（`--body "> 引用"`の本文など）は囲む。
 */
function quoteWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word) || /^\d*</.test(word) || FD_DUPLICATE.test(word)) {
    return word;
  }
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * 単引用符の外にコマンド置換（`$(…)`・バッククォート）があるか。`$((`の算術展開も含むが、
 * 誤って拒否しても打ち直しで済むので区別しない。
 */
export function hasCommandSubstitution(command: string): boolean {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (singleQuoted) {
      singleQuoted = c !== "'";
      continue;
    }
    if (c === '\\') {
      i++;
    } else if (c === "'" && !doubleQuoted) {
      singleQuoted = true;
    } else if (c === '"') {
      doubleQuoted = !doubleQuoted;
    } else if (c === '`' || (c === '$' && command[i + 1] === '(')) {
      return true;
    }
  }
  return false;
}

/**
 * sandboxの外へ回らない形で書かれたネットワークコマンドがあれば、拒否理由を返す。
 * 無ければ`undefined`（そのまま実行させる）。
 */
export function sandboxBashGuardReason(command: string): string | undefined {
  const commands = splitShellCommands(command);
  // 二重引用符の中の置換は分割されず1つの語に残るため、分割とは別に見る。CLIは置換を別の
  // コマンドとして扱い、`glab mr create --description "$(cat <<'EOF' …)"`は`glab *`に
  // 一致せずsandbox内で走る（Issue #1672）
  if (hasCommandSubstitution(command)) {
    const networkNames = commands
      .map(readNetworkCommand)
      .filter((c): c is NetworkCommand => c !== undefined)
      .map((c) => c.name.join(' '));
    if (networkNames.length > 0) {
      return [
        `このコマンドはsandbox内で走り、ネットワークが拒否されて失敗するため実行しなかった。`,
        `${[...new Set(networkNames)].join('・')}の引数にコマンド置換（$(…)やバッククォート。heredocを包んだ"$(cat <<EOF …)"を含む）があると、sandboxの外で走らない。`,
        '本文や長い値は、先にWriteツールでファイルへ書き、ファイルを読むオプションで渡して単独で打ち直す。' +
          'GitHub: gh pr create --body-file <path> / gh issue create --body-file <path>。' +
          'GitLab: glab api projects/:id/merge_requests -X POST --raw-field source_branch=<branch> --raw-field target_branch=<branch> --raw-field title=<title> --field description=@<path>' +
          '（Issueは projects/:id/issues へ --raw-field title=<title> --field description=@<path>。--fieldは値が@で始まるとファイルを読むので、本文以外は--raw-fieldで渡す）。',
        '短い値なら、置換を使わず値そのものを引数に書く。',
      ].join('\n');
    }
  }
  const found = commands
    .map(readNetworkCommand)
    .filter(
      (c): c is NetworkCommand => c !== undefined && (commands.length > 1 || c.prefixed || c.redirected),
    );
  if (found.length === 0) {
    return undefined;
  }
  // 該当が複数あれば全部を案内する。1つずつ案内すると、打ち直すたびに次の分で拒否される
  const names = [...new Set(found.map((c) => c.name.join(' ')))].join('・');
  const retries = found.map((c) => [...c.name, ...c.args].map(quoteWord).join(' '));
  const lines = [
    `このコマンドはsandbox内で走り、ネットワークが拒否されて失敗するため実行しなかった。`,
    `${names}がsandboxの外で走るのは、1回のBash呼び出しにそれだけを単独で書き、先頭から始め、出力をファイルへリダイレクトしないときに限る。`,
    `cd・git -C <dir>・環境変数・timeoutなどを前に付けず、;・&&・||・パイプで他のコマンドと連結せず、>・>>・&>で出力をファイルへ書かず、次の形で1つずつ別のBash呼び出しとして打ち直す: ${retries.join(' / ')}`,
    '別のディレクトリで実行する必要があれば、先にcdだけを別のBash呼び出しで実行してから打つ。',
  ];
  if (commands.length > 1 || found.some((c) => c.redirected)) {
    lines.push(
      '出力をjqなどで加工したりファイルへ保存したりしたかった場合は、単独で打ち、出力のJSONを直接読む。sandbox下で出力をファイルへ保存する手段は無い。',
    );
  }
  return lines.join('\n');
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
