import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 検証したソースの同一性（Issue #1377）。
 *
 * HEADだけを「検証したソース」と見なさない。同じHEADでも未コミット変更の内容が違えば
 * 別の検証対象として扱うため、変更の内容から `dirtyStateId` を作って組にする。
 */
export interface SourceIdentity {
  /** リポジトリの識別子。同じリポジトリの別worktreeでは同じ値（共有gitディレクトリから作る） */
  readonly repoId: string;
  /** worktreeの識別子（worktreeの最上位ディレクトリから作る） */
  readonly worktreeId: string;
  /** HEADのコミットID。コミットが1つも無いリポジトリでは無い */
  readonly head?: string;
  /** 未コミット変更の内容から作る識別子。変更が無ければ {@link CLEAN_DIRTY_STATE_ID} */
  readonly dirtyStateId: string;
}

export const CLEAN_DIRTY_STATE_ID = 'clean';

/**
 * これより大きいファイルは内容を読まず、サイズと更新時刻で代用する。大きな未追跡ファイル
 * （ビルド成果物・データセット等）があるworktreeで、検証のたびに全量を読むのを避ける。
 */
export const CONTENT_HASH_MAX_BYTES = 32 * 1024 * 1024;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    // `git status` が索引を書き換えるためのロックを取らない。検証の実行中に走る他のgit操作と
    // ぶつからないようにする
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
  });
  return stdout;
}

const shortHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

async function hashFileContent(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** worktree上のファイルの現在の内容を表す文字列。消えたもの・読めないものも区別して返す */
async function describeWorktreeFile(absPath: string): Promise<string> {
  let stats;
  try {
    stats = await lstat(absPath);
  } catch {
    return 'missing';
  }
  if (stats.isSymbolicLink()) {
    return `link:${await readlink(absPath)}`;
  }
  if (stats.isDirectory()) {
    // サブモジュール。中身の変化はサブモジュール側のHEADで表れるので、ここでは印だけ
    return 'dir';
  }
  if (stats.size > CONTENT_HASH_MAX_BYTES) {
    return `large:${stats.size}:${stats.mtimeMs}`;
  }
  try {
    return `sha256:${await hashFileContent(absPath)}`;
  } catch {
    return 'unreadable';
  }
}

/**
 * `git status -z` の出力から変更のあるパスを取り出す。`--no-renames` を付けて呼ぶので、
 * 各項目は `XY <path>` の1つだけで、移動元のパスは続かない。
 */
export function parseStatusPaths(stdout: string): string[] {
  return stdout
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));
}

/**
 * 未コミット変更（追跡中ファイルの変更・削除と、無視されていない未追跡ファイル）の内容から
 * 識別子を作る。索引へ載せたかどうかは見ず、worktree上の内容だけで決める（検証コマンドが
 * 読むのはworktreeの内容なので）。`.gitignore` で無視されたファイルは含めない。
 */
export async function computeDirtyStateId(topLevel: string): Promise<string> {
  const status = await git(topLevel, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  const paths = [...new Set(parseStatusPaths(status))].sort();
  if (paths.length === 0) {
    return CLEAN_DIRTY_STATE_ID;
  }
  const hash = createHash('sha256');
  for (const path of paths) {
    hash
      .update(path)
      .update('\0')
      .update(await describeWorktreeFile(join(topLevel, path)))
      .update('\n');
  }
  return hash.digest('hex');
}

/**
 * `cwd` を含むgitリポジトリのソース同一性を取る。gitリポジトリの外、またはgitを
 * 実行できない場合は `undefined`。
 */
export async function captureSourceIdentity(cwd: string): Promise<SourceIdentity | undefined> {
  let topLevel: string;
  let commonDir: string;
  try {
    const [top, common] = (
      await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
    )
      .trim()
      .split('\n');
    if (top === undefined || common === undefined) {
      return undefined;
    }
    topLevel = await realpath(top);
    commonDir = await realpath(common);
  } catch {
    return undefined;
  }
  let head: string | undefined;
  try {
    head = (await git(topLevel, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim() || undefined;
  } catch {
    // コミットが1つも無い
    head = undefined;
  }
  let dirtyStateId: string;
  try {
    dirtyStateId = await computeDirtyStateId(topLevel);
  } catch {
    // 未コミット変更を数えられなければ、同一性は分からないものとして扱う
    return undefined;
  }
  return {
    repoId: shortHash(commonDir),
    worktreeId: shortHash(topLevel),
    ...(head === undefined ? {} : { head }),
    dirtyStateId,
  };
}
