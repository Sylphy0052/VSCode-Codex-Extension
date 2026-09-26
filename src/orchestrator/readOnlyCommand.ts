import { normalizeCommand } from './escalation';

/**
 * 読み取りだけのシェルコマンドか（Issue #1535）。
 *
 * オーケストレータモードとロードマップ実行のセッションは、`allowAutoApprove`が無効だと
 * `cat`や`sed -n`まで人へ回していた。ここで読み取り専用と言い切れるものだけを自動で許可する。
 *
 * 危険パターンを探す`classifyApprovalRequest`（escalation.ts）とは逆に、許可リストに
 * 当たるものだけを通す。シェルの構文木を持たない判定なので、少しでも読み切れない記法
 * （リダイレクト、`$`展開、コマンド置換、クォート外のglob、改行など）があれば`false`にする。
 * 読み取りでも、作業ディレクトリの外（絶対パス・`~`・`..`）を指す引数は通さない。
 */

interface Segment {
  words: string[];
}

/** クォートを外した語の列を、`;` `&&` `||` `|` で区切った段にする。読み切れなければ`undefined`。 */
function lex(command: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;

  const endWord = (): void => {
    if (inWord) {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = (): boolean => {
    endWord();
    if (words.length === 0) {
      return false;
    }
    segments.push({ words });
    words = [];
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) {
        return undefined;
      }
      word += command.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length; j++) {
        const c = command[j] ?? '';
        if (c === '"') {
          break;
        }
        if (c === '$' || c === '`') {
          return undefined;
        }
        if (c === '\\') {
          const next = command[j + 1] ?? '';
          if (next === '"' || next === '\\') {
            word += next;
            j++;
            continue;
          }
        }
        word += c;
      }
      if (j >= command.length) {
        return undefined;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (ch === '\\') {
      const next = command[i + 1];
      if (next === undefined || next === '\n' || next === '\r') {
        return undefined;
      }
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (ch === ';') {
      if (!endSegment()) {
        return undefined;
      }
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        i++;
      }
      if (!endSegment()) {
        return undefined;
      }
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] !== '&') {
        return undefined;
      }
      i++;
      if (!endSegment()) {
        return undefined;
      }
      continue;
    }
    if (ch === '#' && !inWord) {
      return undefined;
    }
    // リダイレクト、展開、サブシェル、クォート外のglob（ファイル名がオプションとして
    // 解釈される経路がある）、改行は読み切らずに人へ回す
    if ('<>$`()*?[\n\r'.includes(ch)) {
      return undefined;
    }
    word += ch;
    inWord = true;
  }
  endWord();
  if (words.length > 0) {
    segments.push({ words });
  }
  return segments.length > 0 ? segments : undefined;
}

/** 作業ディレクトリの外を指しうる値か。 */
function escapesWorkingDirectory(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.split(/[\\/]/).includes('..')
  );
}

/** 引数（オプションの値を含む）が作業ディレクトリの外を指すか。 */
function argEscapes(arg: string): boolean {
  if (escapesWorkingDirectory(arg)) {
    return true;
  }
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    return eq >= 0 && escapesWorkingDirectory(arg.slice(eq + 1));
  }
  // `-f/etc/x`のように短いオプションへ値を続けた形
  return arg.startsWith('-') && escapesWorkingDirectory(arg.slice(2));
}

function anyArgEscapes(args: readonly string[]): boolean {
  return args.some(argEscapes);
}

/** 短いオプションの束（`-no`等）に、いずれかの文字が含まれるか。 */
function shortFlagIncludes(arg: string, letters: string): boolean {
  return /^-[^-]/.test(arg) && [...arg.slice(1)].some((c) => letters.includes(c));
}

/** 引数を見ずに通してよいコマンド（パスだけ確かめる）。 */
const PLAIN_COMMANDS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'nl',
  'cut',
  'tr',
  'tac',
  'rev',
  'column',
  'basename',
  'dirname',
  'pwd',
  'echo',
  'printf',
  'true',
  'stat',
  'du',
  'diff',
  'comm',
  'realpath',
  'readlink',
  'which',
  'cd',
  'grep',
  'egrep',
  'fgrep',
]);

const FIND_FORBIDDEN: ReadonlySet<string> = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log',
  'show',
  'diff',
  'status',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'blame',
  'grep',
  'cat-file',
  'merge-base',
  'describe',
  'shortlog',
]);

/** `gh <対象> <操作>`のうち読み取りだけのもの。 */
const GH_READ_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['issue', new Set(['view', 'list', 'status'])],
  ['pr', new Set(['view', 'list', 'diff', 'checks', 'status'])],
  ['run', new Set(['view', 'list'])],
  ['repo', new Set(['view'])],
]);

/** sedのスクリプト1つ分。行番号・`$`・`/正規表現/`の範囲指定と`p` `d` `q` `=`、`s///`（フラグは`g` `p` `I` `i` 数字だけ）。 */
function isReadOnlySedScript(script: string): boolean {
  const address = String.raw`(?:\d+|\$|/[^/]*/)`;
  const range = `(?:${address}(?:\\s*,\\s*${address})?)?`;
  const simple = new RegExp(`^${range}\\s*!?\\s*[pdq=]?$`);
  const substitute = new RegExp(`^${range}\\s*s/[^/]*/[^/]*/[gpIi0-9]*$`);
  return script
    .split(';')
    .map((part) => part.trim())
    .every((part) => part === '' || simple.test(part) || substitute.test(part));
}

function isReadOnlySed(args: readonly string[]): boolean {
  const scripts: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-e' || arg === '--expression') {
      const script = args[i + 1];
      if (script === undefined) {
        return false;
      }
      scripts.push(script);
      i++;
    } else if (arg.startsWith('--expression=')) {
      scripts.push(arg.slice('--expression='.length));
    } else if (['-n', '-E', '-r', '-s', '-u', '-z', '--quiet', '--silent', '--posix', '--regexp-extended'].includes(arg)) {
      continue;
    } else if (/^-[nErsuz]+$/.test(arg)) {
      continue;
    } else if (arg.startsWith('-')) {
      // -i（その場で書き換え）・-f（スクリプトをファイルから読む）ほか
      return false;
    } else {
      files.push(arg);
    }
  }
  if (scripts.length === 0) {
    const script = files.shift();
    if (script === undefined) {
      return false;
    }
    scripts.push(script);
  }
  return scripts.every(isReadOnlySedScript) && !anyArgEscapes(files);
}

function isReadOnlyAwk(args: readonly string[]): boolean {
  let program: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (program === undefined && (arg === '-F' || arg === '-v')) {
      i++;
      if (args[i] === undefined) {
        return false;
      }
      continue;
    }
    if (program === undefined && /^-[Fv]./.test(arg)) {
      continue;
    }
    if (program === undefined && arg.startsWith('-')) {
      // -f（プログラムをファイルから読む）ほか
      return false;
    }
    if (program === undefined) {
      program = arg;
    } else {
      rest.push(arg);
    }
  }
  if (program === undefined) {
    return false;
  }
  // コマンド実行・ファイル入出力・環境変数の読み出しに当たる語。比較の`>`も巻き込むが安全側に倒す
  if (/system|getline|ENVIRON|[|>]/.test(program)) {
    return false;
  }
  return !anyArgEscapes(rest);
}

function isReadOnlyFind(args: readonly string[]): boolean {
  return !args.some((arg) => FIND_FORBIDDEN.has(arg)) && !anyArgEscapes(args);
}

function isReadOnlySort(args: readonly string[]): boolean {
  return (
    !args.some(
      (arg) =>
        arg.startsWith('--output') ||
        arg.startsWith('--compress-program') ||
        shortFlagIncludes(arg, 'o'),
    ) && !anyArgEscapes(args)
  );
}

function isReadOnlyUniq(args: readonly string[]): boolean {
  // 2つ目の位置引数は出力先のファイルになる
  return args.filter((arg) => !arg.startsWith('-')).length <= 1 && !anyArgEscapes(args);
}

function isReadOnlyRg(args: readonly string[]): boolean {
  return (
    !args.some((arg) => arg.startsWith('--pre') || arg.startsWith('--hostname-bin')) &&
    !anyArgEscapes(args)
  );
}

function isReadOnlyJq(args: readonly string[]): boolean {
  let filter: string | undefined;
  const files: string[] = [];
  for (const arg of args) {
    if (/^-[rcesnjSMCa]+$/.test(arg) || ['--raw-output', '--compact-output', '--slurp', '--null-input', '--tab', '--exit-status', '--join-output', '--sort-keys'].includes(arg)) {
      continue;
    }
    if (arg.startsWith('-')) {
      // --arg・--rawfile・-f など値や別ファイルを取るもの
      return false;
    }
    if (filter === undefined) {
      filter = arg;
    } else {
      files.push(arg);
    }
  }
  // 環境変数（トークン等）を出せる`env` / `$ENV`
  return filter !== undefined && !/env/i.test(filter) && !anyArgEscapes(files);
}

function isReadOnlyGit(args: readonly string[]): boolean {
  let i = 0;
  while (args[i] === '--no-pager') {
    i++;
  }
  const sub = args[i];
  if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) {
    return false;
  }
  const rest = args.slice(i + 1);
  return (
    !rest.some(
      (arg) =>
        arg.startsWith('--output') ||
        arg === '--ext-diff' ||
        arg === '--open-files-in-pager' ||
        (sub === 'grep' && shortFlagIncludes(arg, 'O')),
    ) && !anyArgEscapes(rest)
  );
}

function isReadOnlyGh(args: readonly string[]): boolean {
  const [group, action] = args;
  if (group === 'api') {
    return !args
      .slice(1)
      .some(
        (arg) =>
          ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].includes(arg) ||
          /^(-X|-f|-F).|^--(method|field|raw-field|input)=/.test(arg),
      );
  }
  const actions = group === undefined ? undefined : GH_READ_SUBCOMMANDS.get(group);
  return actions !== undefined && action !== undefined && actions.has(action) && !anyArgEscapes(args.slice(2));
}

function isReadOnlySegment(words: readonly string[]): boolean {
  const [name, ...args] = words;
  if (name === undefined) {
    return false;
  }
  if (PLAIN_COMMANDS.has(name)) {
    return !anyArgEscapes(args);
  }
  switch (name) {
    case 'sed':
      return isReadOnlySed(args);
    case 'awk':
      return isReadOnlyAwk(args);
    case 'find':
      return isReadOnlyFind(args);
    case 'sort':
      return isReadOnlySort(args);
    case 'uniq':
      return isReadOnlyUniq(args);
    case 'rg':
      return isReadOnlyRg(args);
    case 'jq':
      return isReadOnlyJq(args);
    case 'git':
      return isReadOnlyGit(args);
    case 'gh':
      return isReadOnlyGh(args);
    default:
      return false;
  }
}

const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh', '/usr/bin/bash', '/usr/bin/zsh']);

/** Codexが包む`bash -lc '<スクリプト>'`の形なら中身のスクリプトを返す。 */
function shellWrappedScript(words: readonly string[]): string | undefined {
  const [shell, flag, script, ...rest] = words;
  return shell !== undefined && SHELLS.has(shell) && (flag === '-c' || flag === '-lc') && script !== undefined && rest.length === 0
    ? script
    : undefined;
}

export function isReadOnlyCommand(command: string): boolean {
  const segments = lex(command.trim());
  if (segments === undefined) {
    return false;
  }
  const only = segments.length === 1 ? segments[0] : undefined;
  const script = only === undefined ? undefined : shellWrappedScript(only.words);
  if (script !== undefined) {
    return isReadOnlyCommand(script);
  }
  return segments.every((s) => isReadOnlySegment(s.words));
}

/**
 * 承認要求の生パラメータが、読み取り専用のコマンドの実行か。Claudeは`Bash`ツールの
 * `input.command`、Codexは`command`（文字列か配列）にコマンドを載せる。
 */
export function isReadOnlyCommandApproval(rawParams: Record<string, unknown>): boolean {
  const toolName = rawParams['tool_name'];
  if (typeof toolName === 'string') {
    const input = rawParams['input'];
    const command =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['command'] : undefined;
    return toolName === 'Bash' && typeof command === 'string' && isReadOnlyCommand(command);
  }
  const raw = rawParams['command'];
  if (Array.isArray(raw)) {
    // 配列を空白で結合するとクォートが失われるので、`["bash", "-lc", "..."]`の形だけ中身を見る
    const script = raw.every((part) => typeof part === 'string') ? shellWrappedScript(raw) : undefined;
    return script !== undefined && isReadOnlyCommand(script);
  }
  const command = normalizeCommand(raw);
  return command !== '' && isReadOnlyCommand(command);
}
