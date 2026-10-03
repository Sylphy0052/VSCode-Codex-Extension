import { spawn } from 'node:child_process';
import { type Dirent, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { killWithEscalation } from '../process/childProcess';

/**
 * 読み取り専用のsandboxを付けられない作業ディレクトリを、セッションの起動前に見つける（Issue #1630）。
 *
 * CLIは利用者の`permissions.deny`にある`Read(...)`のうち、作業ディレクトリ配下の実在パスに
 * 一致したものをsandboxのdenyReadへ変換する。一致したのがディレクトリだと`--tmpfs`で覆われ、
 * そのときCLIは存在しない`<cwd>/.gitconfig`・`.bashrc`などへ`--ro-bind /dev/null`を足す。
 * 読み取り専用のセッションは作業ディレクトリを`--ro-bind`するため、bwrapがマウント先を作れず、
 * sandbox内のBashが`bwrap: Can't create file at <cwd>/.gitconfig: Read-only file system`で
 * 全て失敗する（CLI 2.1.280で実測）。一致したのがファイル（`.env`など）なら`/dev/null`の
 * bindで済み、失敗しない。
 *
 * 設定で避ける方法は無く、作業ディレクトリ直下のエントリごとに書き込みを塞ぐ方式では直下への
 * 新規作成を防げなかった。そこで、この条件に当たる作業ディレクトリではsandboxを付けない。
 * CLIのsandboxを実際に動かして確かめるにはAPIを呼ぶ必要があるため、CLIから`Read`のdeny
 * ルールだけを取り出し、実在するディレクトリとの照合は拡張機能で行う。照合はCLIのglobの
 * 解釈を写したもので、判断に迷う形は一致する側（sandboxを付けない側）へ倒す。
 *
 * CLIの版を上げたときは、作業ディレクトリに`Read(./secrets/**)`へ一致する`secrets/`
 * ディレクトリを置き、`filesystem.denyWrite: [cwd]`付きのsandboxでBashが上のエラーになるかを
 * 確かめる。ならなくなっていれば、この確認は外してよい。
 */

export type ReadOnlyCwdInspection = { ok: true } | { ok: false; reason: string };

/** CLIの空起動で`Read`のdenyルールを取り出す時間上限。空起動の実測1.4秒（`probeClaudeSandbox`）に余裕を持たせる。 */
export const LIST_RULES_TIMEOUT_MS = 30_000;

/** 照合で辿るディレクトリの数の上限。超えたら確かめきれないとしてsandboxを付けない。 */
export const MAX_SCANNED_DIRECTORIES = 200_000;

/** 空起動のstdoutで1行として溜める上限。ルールの一覧は数十KBに収まる。 */
export const MAX_STDOUT_LINE_LENGTH = 4 * 1024 * 1024;

/** 空起動のstderrを溜める上限。 */
export const MAX_STDERR_LENGTH = 1200;

const LIST_RULES_REQUEST_ID = 'list_permission_rules';

type ReadDenyRulesResult = { ok: true; rules: string[] } | { ok: false; detail: string };

/**
 * CLIを作業ディレクトリで空起動し、全ての設定ソースを合わせた`Read(...)`のdenyルールを得る。
 * `list_permission_rules`はAPIを呼ばずに応答する（CLI 2.1.280で実測）。`--bare`は利用者の
 * hookを走らせないため。利用者設定・プロジェクト設定のルールはこれでも返る。
 */
function listReadDenyRules(
  claudePath: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ReadDenyRulesResult> {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--bare',
    '--no-session-persistence',
  ];
  const aborted: ReadDenyRulesResult = {
    ok: false,
    detail: '拡張機能の終了により確認を中止しました',
  };
  if (signal.aborted) {
    return Promise.resolve(aborted);
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdoutLine = '';
    let stderr = '';
    const proc = spawn(claudePath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (result: ReadDenyRulesResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // 応答を得た後はCLIの終了を待たない
      if (proc.exitCode === null && proc.signalCode === null) {
        killWithEscalation(proc);
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        detail: `${String(LIST_RULES_TIMEOUT_MS)}ms以内に応答がありませんでした`,
      });
    }, LIST_RULES_TIMEOUT_MS);
    // 確認の途中でも拡張ホストの終了を引き留めない
    timer.unref();
    const onAbort = (): void => {
      finish(aborted);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const handleLine = (line: string): void => {
      const rules = parseListRulesResponse(line);
      if (rules !== undefined) {
        finish(rules);
      }
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      const lines = (stdoutLine + chunk).split('\n');
      stdoutLine = lines.pop() ?? '';
      if (stdoutLine.length > MAX_STDOUT_LINE_LENGTH) {
        finish({ ok: false, detail: 'CLIの出力の1行が長すぎます' });
        return;
      }
      for (const line of lines) {
        handleLine(line);
      }
    });
    proc.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_LENGTH) {
        // 1回のchunkが上限を超えても、溜めた結果が上限に収まるように切る
        stderr = (stderr + chunk).slice(0, MAX_STDERR_LENGTH);
      }
    });
    proc.on('error', (e) => {
      finish({ ok: false, detail: e.message });
    });
    // 'exit'はstdoutを読み終える前に届きうるため、stdioが閉じた'close'で判定する
    proc.on('close', (code) => {
      finish({
        ok: false,
        detail: `ルールの一覧を返す前に終了しました（exit code ${String(code)}）: ${stderr.trim()}`,
      });
    });
    // 起動に失敗した場合の書き込みエラー（EPIPE）は、'error'・'close'の側で結果にする
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(
      [
        { type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } },
        {
          type: 'control_request',
          request_id: LIST_RULES_REQUEST_ID,
          request: { subtype: 'list_permission_rules' },
        },
      ]
        .map((message) => JSON.stringify(message))
        .join('\n') + '\n',
    );
  });
}

/** `list_permission_rules`への応答なら結果を、それ以外の行なら`undefined`を返す。 */
function parseListRulesResponse(line: string): ReadDenyRulesResult | undefined {
  if (!line.includes(LIST_RULES_REQUEST_ID)) {
    return undefined;
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || message['type'] !== 'control_response') {
    return undefined;
  }
  const response = message['response'];
  if (!isRecord(response) || response['request_id'] !== LIST_RULES_REQUEST_ID) {
    return undefined;
  }
  if (response['subtype'] !== 'success') {
    return {
      ok: false,
      detail: `list_permission_rulesが失敗しました: ${String(response['error'])}`,
    };
  }
  const payload = response['response'];
  const state = isRecord(payload) ? payload['state'] : undefined;
  const rules = isRecord(state) ? state['rules'] : undefined;
  if (!Array.isArray(rules)) {
    return { ok: false, detail: 'list_permission_rulesの応答にrulesがありません' };
  }
  return {
    ok: true,
    rules: rules.flatMap((rule: unknown) =>
      isRecord(rule) &&
      rule['behavior'] === 'deny' &&
      typeof rule['rule'] === 'string' &&
      rule['rule'].startsWith('Read(')
        ? [rule['rule']]
        : [],
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ReadDenyPattern {
  /** 元のルール（`Read(./secrets/**)`など）。ログに出す。 */
  rule: string;
  /** 絶対パスに当てる正規表現。 */
  pattern: RegExp;
}

/**
 * `Read(...)`のルールを、ディレクトリの絶対パスに当てる正規表現にする。パスの形はCLIの
 * 権限ルールに合わせる（`//`は絶対パス、`~/`はホーム、`./`と無印は作業ディレクトリ基準、
 * `/`を含まない無印は任意の深さ）。`/`始まりは設定ファイル基準だが、照合を広く取るため
 * 作業ディレクトリ基準で見る。末尾の`/**`はそのディレクトリ自体を覆うので外して照合する。
 */
export function compileReadDenyRule(
  rule: string,
  cwd: string,
  home: string,
): ReadDenyPattern | undefined {
  const content = /^Read\((.*)\)$/.exec(rule)?.[1]?.trim();
  if (content === undefined || content === '') {
    return undefined;
  }
  let base = cwd;
  let glob = content;
  let anyDepth = false;
  if (glob.startsWith('//')) {
    base = '/';
    glob = glob.slice(2);
  } else if (glob === '~' || glob.startsWith('~/')) {
    base = home;
    glob = glob.slice(2);
  } else if (glob.startsWith('/')) {
    glob = glob.slice(1);
  } else if (glob.startsWith('./')) {
    glob = glob.slice(2);
  } else {
    anyDepth = !glob.replace(/\/+$/, '').includes('/');
  }
  glob = glob.replace(/(\/\*\*)+\/?$/, '').replace(/\/+$/, '');
  const prefix = escapeRegExp(base.replace(/\/+$/, ''));
  if (glob === '') {
    // 基点が`/`だとprefixが空になるため、`/`自身に一致させるには`/`を補う
    return { rule, pattern: new RegExp(`^${prefix === '' ? '/' : prefix}$`) };
  }
  if (glob === '**') {
    return { rule, pattern: new RegExp(`^${prefix}(?:/.*)?$`) };
  }
  const body = globToRegExpSource(glob);
  return { rule, pattern: new RegExp(`^${prefix}/${anyDepth ? '(?:.*/)?' : ''}${body}$`) };
}

/** gitignore風のglobを正規表現の本体にする。`**`・`*`・`?`・`[...]`・`{a,b}`を扱う。 */
function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        i++;
        if (glob.charAt(i + 1) === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2);
      const body = glob.slice(i + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      out += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&')}]`;
      i = end;
    } else if (c === '{' && glob.indexOf('}', i) !== -1) {
      // 入れ子を数えて対応する`}`を探す。無ければ、照合を広く取るため（判定を狭めないため）、
      // 最初の`}`で閉じて`,`で分ける旧来の解釈にする。CLIの実挙動は実測していない
      const nestedEnd = findClosingBrace(glob, i);
      const end = nestedEnd !== -1 ? nestedEnd : glob.indexOf('}', i);
      const inner = glob.slice(i + 1, end);
      const alternatives = nestedEnd !== -1 ? splitTopLevelCommas(inner) : inner.split(',');
      out += `(?:${alternatives.map(globToRegExpSource).join('|')})`;
      i = end;
    } else {
      out += escapeRegExp(c);
    }
  }
  return out;
}

/** `open`位置の`{`に対応する`}`の位置を、入れ子を数えて返す。対応するものが無ければ-1。 */
function findClosingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** 入れ子の`{}`の中にある`,`では分けず、最上位の`,`だけで分ける。 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export interface DeniedDirectory {
  directory: string;
  rule: string;
}

export type DeniedDirectorySearch =
  | { kind: 'found'; denied: DeniedDirectory }
  | { kind: 'none' }
  | { kind: 'limit' }
  | { kind: 'aborted' };

/**
 * 作業ディレクトリ自身とその祖先、配下の全ディレクトリから、ルールに一致する最初のものを探す。
 * CLIは`.gitignore`の対象（`node_modules`など）やsymlinkの先も一致させるため（Issue #1630の
 * 実測）、除外せずに辿り、symlinkも追う。同じ実体は1回だけ辿る。
 */
export async function findDeniedDirectory(
  cwd: string,
  patterns: readonly ReadDenyPattern[],
  signal: AbortSignal,
): Promise<DeniedDirectorySearch> {
  const match = (directory: string): DeniedDirectory | undefined => {
    const hit = patterns.find(({ pattern }) => pattern.test(directory));
    return hit === undefined ? undefined : { directory, rule: hit.rule };
  };
  const root = path.resolve(cwd);
  for (let dir = root; ; dir = path.dirname(dir)) {
    const denied = match(dir);
    if (denied !== undefined) {
      return { kind: 'found', denied };
    }
    if (path.dirname(dir) === dir) {
      break;
    }
  }
  const visited = new Set<string>([await realpathOr(root)]);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    if (signal.aborted) {
      return { kind: 'aborted' };
    }
    const dir = queue[index] as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // 読めないディレクトリはCLIも中を照合できないので、ここでも辿らない
      continue;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDirectory(child)))) {
        continue;
      }
      const denied = match(child);
      if (denied !== undefined) {
        return { kind: 'found', denied };
      }
      const real = await realpathOr(child);
      if (visited.has(real)) {
        continue;
      }
      visited.add(real);
      if (queue.length >= MAX_SCANNED_DIRECTORIES) {
        return { kind: 'limit' };
      }
      queue.push(child);
    }
  }
  return { kind: 'none' };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOr(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/**
 * 読み取り専用のsandboxを`cwd`へ付けられるかを確かめる。確かめられなかったときも付けない側に
 * 倒す（sandbox無しでも承認が人へ回るだけだが、付けて失敗すると全てのBashが動かない）。
 */
export async function inspectReadOnlyCwd(
  claudePath: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ReadOnlyCwdInspection> {
  const listed = await listReadDenyRules(claudePath, cwd, signal);
  if (!listed.ok) {
    return { ok: false, reason: `Readのdenyルールを確かめられません: ${listed.detail}` };
  }
  const home = homedir();
  const patterns = listed.rules.flatMap((rule) => compileReadDenyRule(rule, cwd, home) ?? []);
  if (patterns.length === 0) {
    return { ok: true };
  }
  const search = await findDeniedDirectory(cwd, patterns, signal);
  switch (search.kind) {
    case 'none':
      return { ok: true };
    case 'found':
      return {
        ok: false,
        reason: `${search.denied.directory}が${search.denied.rule}に一致し、読み取り専用のsandboxではBashが全て失敗するため（Issue #1630）`,
      };
    case 'limit':
      return {
        ok: false,
        reason: `作業ディレクトリ配下のディレクトリが${String(MAX_SCANNED_DIRECTORIES)}を超え、Readのdenyルールとの照合を終えられません`,
      };
    case 'aborted':
      return { ok: false, reason: '拡張機能の終了により確認を中止しました' };
  }
}
