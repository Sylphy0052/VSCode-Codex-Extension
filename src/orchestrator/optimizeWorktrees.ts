import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 最適化の計測用worktree（Issue #2110）。基準・最良・候補の3本を持ち、それぞれ拡張が作った
 * commitをdetachedで指す。1つのworktreeで木を行き来すると、準備のし直しと、gitignoreされた
 * ビルド成果物の混入が起きるため。
 *
 * 木のcommitは`GIT_INDEX_FILE`の一時indexへ作業ツリーを入れて`write-tree`・`commit-tree`で作る。
 * HEADもブランチも動かさず、hookも走らない。commitは`refs/optimize/<runId>/`の下に置く。
 */

export type MeasureTreeRole = 'baseline' | 'best' | 'candidate';

export const MEASURE_TREE_ROLES: readonly MeasureTreeRole[] = ['baseline', 'best', 'candidate'];

/** 依存のディレクトリ。gitignoreされていても、準備前の掃除で消さない。 */
export const DEFAULT_DEPENDENCY_DIRS: readonly string[] = ['node_modules'];

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type GitRunner = (
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<string>;

export const runGit: GitRunner = (cwd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(`git ${args.join(' ')} に失敗しました: ${stderr.trim() || error.message}`),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`runIdは英数字と . _ - だけで指定してください: ${runId}`);
  }
}

/** `refs/optimize/<runId>/baseline`・`best`・`trial/<n>`。 */
export function optimizeRef(runId: string, kind: 'baseline' | 'best' | { trial: number }): string {
  assertRunId(runId);
  if (typeof kind === 'string') {
    return `refs/optimize/${runId}/${kind}`;
  }
  if (!Number.isInteger(kind.trial) || kind.trial < 0) {
    throw new Error(`試行の番号が不正です: ${kind.trial}`);
  }
  return `refs/optimize/${runId}/trial/${kind.trial}`;
}

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'optimize-harness',
  GIT_AUTHOR_EMAIL: 'optimize-harness@localhost',
  GIT_COMMITTER_NAME: 'optimize-harness',
  GIT_COMMITTER_EMAIL: 'optimize-harness@localhost',
} as const;

export interface SnapshotInput {
  /** 木を取る作業ツリー。 */
  workDir: string;
  ref: string;
  message: string;
  /** 親にするcommit。無ければルートcommit。 */
  parent?: string;
  git?: GitRunner;
}

/**
 * 作業ツリー（gitignoreを除く）をcommitにして`ref`に固定し、そのSHAを返す。HEAD・ブランチ・
 * 本物のindexは動かさない。
 */
export async function snapshotTree(input: SnapshotInput): Promise<string> {
  const git = input.git ?? runGit;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'optimize-index-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index'), ...COMMIT_ENV };
  try {
    await git(input.workDir, ['add', '-A', '--', '.'], env);
    const tree = (await git(input.workDir, ['write-tree'], env)).trim();
    const args = ['commit-tree', tree, '-m', input.message];
    if (input.parent !== undefined) {
      args.push('-p', input.parent);
    }
    const sha = (await git(input.workDir, args, env)).trim();
    await git(input.workDir, ['update-ref', input.ref, sha], env);
    return sha;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** 掃除で残すパス（変更してよいパスと依存のディレクトリ）を相対パスへ正規化する。 */
export function normalizeKeepPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of paths) {
    const normalized = path.posix.normalize(raw.replace(/\\/g, '/')).replace(/\/+$/, '');
    if (
      normalized === '' ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`残すパスはworktree内の相対パスで指定してください: ${raw}`);
    }
    result.push(normalized);
  }
  return result;
}

/** `entry`（`dir/`の形もある）が、残すパスそのもの・内側・祖先のどれかか。 */
function touchesKeep(entry: string, keep: readonly string[]): 'keep' | 'ancestor' | 'none' {
  const e = entry.replace(/\/+$/, '');
  for (const k of keep) {
    if (e === k || e.startsWith(`${k}/`)) {
      return 'keep';
    }
  }
  for (const k of keep) {
    if (k.startsWith(`${e}/`)) {
      return 'ancestor';
    }
  }
  return 'none';
}

/**
 * gitignoreされたファイルのうち、`keepPaths`以外を消す（`git clean -fdX`に除外を付けたもの。
 * `-e`は`-X`と併用すると無視の追加になり除外にならないため、一覧を取って自分で消す）。
 * 残すパスを含む祖先のディレクトリは、中へ降りて残すパス以外を消す。
 */
export async function cleanIgnored(
  worktreeDir: string,
  keepPaths: readonly string[],
  git: GitRunner = runGit,
): Promise<string[]> {
  const keep = normalizeKeepPaths(keepPaths);
  const removed: string[] = [];
  // 残すパスを含む祖先のディレクトリは、中が全部ignoredなので自分で降りて残すパス以外を消す
  const sweep = async (relDir: string): Promise<void> => {
    for (const name of await readdir(path.join(worktreeDir, relDir))) {
      const rel = `${relDir}/${name}`;
      const kind = touchesKeep(rel, keep);
      if (kind === 'keep') {
        continue;
      }
      if (kind === 'ancestor') {
        await sweep(rel);
        continue;
      }
      await rm(path.join(worktreeDir, rel), { recursive: true, force: true });
      removed.push(rel);
    }
  };
  const out = await git(worktreeDir, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ]);
  for (const entry of out.split('\0').filter((e) => e !== '')) {
    const kind = touchesKeep(entry, keep);
    if (kind === 'keep') {
      continue;
    }
    if (kind === 'ancestor' && entry.endsWith('/')) {
      await sweep(entry.replace(/\/+$/, ''));
      continue;
    }
    await rm(path.join(worktreeDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface PrepareWorktreeInput {
  /** 本体のリポジトリ（`git worktree add`を実行する場所）。 */
  repoDir: string;
  worktreeDir: string;
  /** 指すcommit。 */
  commit: string;
  /** 掃除で残すパス（変更してよいパス）。依存のディレクトリは`dependencyDirs`で足す。 */
  allowedPaths: readonly string[];
  dependencyDirs?: readonly string[];
  /** 準備のコマンド。掃除の後に実行する。 */
  runSetup?: (worktreeDir: string) => Promise<void>;
  git?: GitRunner;
}

/**
 * 計測用のworktreeを、`commit`を指すdetachedの状態に整える。無ければ作り、あれば
 * `checkout --detach`と`clean`で戻す。続けて、残すパス以外のgitignoreされたファイルを消し、
 * 準備のコマンドを実行する。
 */
export async function prepareMeasureWorktree(input: PrepareWorktreeInput): Promise<void> {
  const git = input.git ?? runGit;
  if (await exists(path.join(input.worktreeDir, '.git'))) {
    await git(input.worktreeDir, ['checkout', '--detach', '--force', input.commit]);
    await git(input.worktreeDir, ['clean', '-fd']);
  } else {
    await git(input.repoDir, ['worktree', 'add', '--detach', input.worktreeDir, input.commit]);
  }
  await cleanIgnored(
    input.worktreeDir,
    [...input.allowedPaths, ...(input.dependencyDirs ?? DEFAULT_DEPENDENCY_DIRS)],
    git,
  );
  await input.runSetup?.(input.worktreeDir);
}

export interface PrepareMeasureWorktreesInput {
  repoDir: string;
  /** 3本のworktreeを置く親ディレクトリ。`<root>/<role>`になる。 */
  root: string;
  commits: Readonly<Record<MeasureTreeRole, string>>;
  allowedPaths: readonly string[];
  dependencyDirs?: readonly string[];
  runSetup?: (worktreeDir: string, role: MeasureTreeRole) => Promise<void>;
  git?: GitRunner;
}

/** 基準・最良・候補の3本を準備し、役割ごとのパスを返す。 */
export async function prepareMeasureWorktrees(
  input: PrepareMeasureWorktreesInput,
): Promise<Record<MeasureTreeRole, string>> {
  const dirs = {} as Record<MeasureTreeRole, string>;
  for (const role of MEASURE_TREE_ROLES) {
    const worktreeDir = path.join(input.root, role);
    await prepareMeasureWorktree({
      repoDir: input.repoDir,
      worktreeDir,
      commit: input.commits[role],
      allowedPaths: input.allowedPaths,
      ...(input.dependencyDirs === undefined ? {} : { dependencyDirs: input.dependencyDirs }),
      ...(input.runSetup === undefined
        ? {}
        : { runSetup: (dir: string) => input.runSetup!(dir, role) }),
      ...(input.git === undefined ? {} : { git: input.git }),
    });
    dirs[role] = worktreeDir;
  }
  return dirs;
}

/** 候補を試行のたびに`best`のcommitへ戻す。 */
export async function resetCandidateToBest(
  input: Omit<PrepareWorktreeInput, 'worktreeDir' | 'commit'> & {
    candidateDir: string;
    bestCommit: string;
  },
): Promise<void> {
  await prepareMeasureWorktree({
    ...input,
    worktreeDir: input.candidateDir,
    commit: input.bestCommit,
  });
}
