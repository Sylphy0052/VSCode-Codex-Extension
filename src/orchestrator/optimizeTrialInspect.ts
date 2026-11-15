import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeKeepPaths, runGit, type GitRunner } from './optimizeWorktrees';
import { findProtectedTouches } from './selfImproveGuard';

/**
 * 最適化の試行（Issue #2107）の検査。試行のセッションが終わった後に、拡張が試行前の状態と比べる。
 * HEADを見るだけでは`git push <sha>:refs/heads/x`や`gh`の操作を拾えないため、refと共有の`.git`の
 * 設定、基準・最良のworktreeを試行の前後で比べる。
 *
 * 比べるrefは`refs/optimize/<runId>/`の下とタスクのブランチだけ。他のrefは他のタスクも動かすので見ない。
 */

export interface TrialStateInput {
  candidateDir: string;
  baselineDir: string;
  bestDir: string;
  runId: string;
  /** タスクのブランチのref（`refs/heads/<branch>`）。無ければ省く。 */
  taskBranchRef?: string;
  git?: GitRunner;
}

export interface TrialState {
  candidateHead: string;
  candidateTree: string;
  baselineHead: string;
  baselineTree: string;
  bestHead: string;
  bestTree: string;
  /** 見るrefの値。`refname -> sha`。 */
  refs: Record<string, string>;
  /** 共有の`.git`の`config`・`hooks`・`info/exclude`、`core.hooksPath`の先、worktreeごとの設定のhash。 */
  guard: Record<string, string>;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 作業ツリー（gitignoreを除く）の内容を表す木のhash。一時indexを使うので、本物のindexも
 * HEADも動かさない。
 */
export async function workTreeHash(dir: string, git: GitRunner = runGit): Promise<string> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'optimize-inspect-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    await git(dir, ['add', '-A', '--', '.'], env);
    return (await git(dir, ['write-tree'], env)).trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** `baseCommit`から見た、作業ツリーで変わったファイル（gitignoreを除く。名前の変更は削除と追加に分ける）。 */
export async function listChangedFiles(
  dir: string,
  baseCommit: string,
  git: GitRunner = runGit,
): Promise<string[]> {
  const tree = await workTreeHash(dir, git);
  const out = await git(dir, [
    'diff-tree',
    '-r',
    '--name-only',
    '--no-renames',
    '-z',
    baseCommit,
    tree,
  ]);
  return out.split('\0').filter((f) => f !== '');
}

async function hashFileOrAbsent(file: string): Promise<string> {
  try {
    return sha256(await readFile(file));
  } catch {
    return 'absent';
  }
}

/** ディレクトリの中身（パス・内容・シンボリックリンクの先）をまとめたhash。無ければ`absent`。 */
export async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (rel: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      hash.update(`${child}\0`);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link:${await readlink(path.join(dir, child)).catch(() => '')}`);
      } else {
        hash.update(await readFile(path.join(dir, child)).catch(() => Buffer.alloc(0)));
      }
    }
    return true;
  };
  return (await walk('')) ? hash.digest('hex') : 'absent';
}

async function captureGuard(candidateDir: string, git: GitRunner): Promise<Record<string, string>> {
  const commonDir = path.resolve(
    candidateDir,
    (await git(candidateDir, ['rev-parse', '--git-common-dir'])).trim(),
  );
  const gitDir = path.resolve(
    candidateDir,
    (await git(candidateDir, ['rev-parse', '--absolute-git-dir'])).trim(),
  );
  const guard: Record<string, string> = {
    config: await hashFileOrAbsent(path.join(commonDir, 'config')),
    hooks: await hashDirectory(path.join(commonDir, 'hooks')),
    'info/exclude': await hashFileOrAbsent(path.join(commonDir, 'info', 'exclude')),
    'worktree/config.worktree': await hashFileOrAbsent(path.join(gitDir, 'config.worktree')),
    'worktree/hooks': await hashDirectory(path.join(gitDir, 'hooks')),
  };
  let hooksPath = '';
  try {
    hooksPath = (await git(candidateDir, ['config', '--get', 'core.hooksPath'])).trim();
  } catch {
    // 未設定
  }
  if (hooksPath !== '') {
    guard['core.hooksPath'] = await hashDirectory(path.resolve(candidateDir, hooksPath));
  }
  return guard;
}

async function captureRefs(
  dir: string,
  runId: string,
  taskBranchRef: string | undefined,
  git: GitRunner,
): Promise<Record<string, string>> {
  const patterns = [
    `refs/optimize/${runId}/`,
    ...(taskBranchRef === undefined ? [] : [taskBranchRef]),
  ];
  const out = await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', ...patterns]);
  const refs: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) {
      refs[line.slice(0, space)] = line.slice(space + 1).trim();
    }
  }
  return refs;
}

/** 試行の前後で比べる状態を取る。 */
export async function captureTrialState(input: TrialStateInput): Promise<TrialState> {
  const git = input.git ?? runGit;
  const head = async (dir: string): Promise<string> =>
    (await git(dir, ['rev-parse', 'HEAD'])).trim();
  return {
    candidateHead: await head(input.candidateDir),
    candidateTree: await workTreeHash(input.candidateDir, git),
    baselineHead: await head(input.baselineDir),
    baselineTree: await workTreeHash(input.baselineDir, git),
    bestHead: await head(input.bestDir),
    bestTree: await workTreeHash(input.bestDir, git),
    refs: await captureRefs(input.candidateDir, input.runId, input.taskBranchRef, git),
    guard: await captureGuard(input.candidateDir, git),
  };
}

export type TrialViolationKind =
  | 'outsideAllowedPaths'
  | 'candidateHeadMoved'
  | 'refsChanged'
  | 'gitConfigChanged'
  | 'measureTreeChanged'
  | 'protectedPaths';

export interface TrialViolation {
  kind: TrialViolationKind;
  detail: string;
  /**
   * 候補のworktreeの外の共有の状態（ref・`.git`・基準や最良のworktree）に触れた。
   * 候補を捨てるだけでは戻らないので、ループは止めて人へ回す。
   */
  shared: boolean;
}

export interface InspectTrialInput {
  before: TrialState;
  after: TrialState;
  /** 試行前の最良のcommitから見て、候補の作業ツリーで変わったファイル。 */
  changedFiles: readonly string[];
  /** 変更してよいパス。仮説の段は空にする（何も変えてはならない）。 */
  allowedPaths: readonly string[];
  /** 自己改善の保護パスのパターン（`selfImproveGuard.ts`）。 */
  protectedPatterns?: readonly string[];
  /** 試行前の最良のcommit。 */
  bestCommit: string;
}

function isUnderAllowed(file: string, allowed: readonly string[]): boolean {
  return allowed.some((p) => file === p || file.startsWith(`${p}/`));
}

function diffRecords(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}

const DETAIL_LIST_MAX = 10;

function list(items: readonly string[]): string {
  return `${items.slice(0, DETAIL_LIST_MAX).join(', ')}${items.length > DETAIL_LIST_MAX ? ' ほか' : ''}`;
}

/** 試行を拒否する理由を集める。1件も無ければ検査を通る。 */
export function inspectTrial(input: InspectTrialInput): TrialViolation[] {
  const { before, after } = input;
  const violations: TrialViolation[] = [];
  const allowed = normalizeKeepPaths(input.allowedPaths);

  const outside = input.changedFiles.filter((f) => !isUnderAllowed(f, allowed));
  if (outside.length > 0) {
    violations.push({
      kind: 'outsideAllowedPaths',
      detail: `変更してよいパスの外に差分があります: ${list(outside)}`,
      shared: false,
    });
  }

  if (after.candidateHead !== before.candidateHead || after.candidateHead !== input.bestCommit) {
    violations.push({
      kind: 'candidateHeadMoved',
      detail: `候補のHEADが最良のcommit ${input.bestCommit} から動きました: ${after.candidateHead}`,
      shared: false,
    });
  }

  const refDiff = diffRecords(before.refs, after.refs);
  if (refDiff.length > 0) {
    violations.push({
      kind: 'refsChanged',
      detail: `refs/optimize/<runId>/の下かタスクのブランチのrefが変わりました: ${list(refDiff)}`,
      shared: true,
    });
  }

  const guardDiff = diffRecords(before.guard, after.guard);
  if (guardDiff.length > 0) {
    violations.push({
      kind: 'gitConfigChanged',
      detail: `共有の.gitの設定が変わりました: ${list(guardDiff)}`,
      shared: true,
    });
  }

  const treeDiff = [
    ...(before.baselineHead !== after.baselineHead || before.baselineTree !== after.baselineTree
      ? ['baseline']
      : []),
    ...(before.bestHead !== after.bestHead || before.bestTree !== after.bestTree ? ['best'] : []),
  ];
  if (treeDiff.length > 0) {
    violations.push({
      kind: 'measureTreeChanged',
      detail: `基準・最良のworktreeが変わりました: ${treeDiff.join(', ')}`,
      shared: true,
    });
  }

  const protectedTouches = findProtectedTouches(input.changedFiles, input.protectedPatterns ?? []);
  if (protectedTouches.length > 0) {
    violations.push({
      kind: 'protectedPaths',
      detail: `自己改善の保護パスに触れました: ${list(protectedTouches)}`,
      shared: false,
    });
  }
  return violations;
}

/** 検査の結果を、台帳の`decision.reason`に入れる1つの文にする。 */
export function describeViolations(violations: readonly TrialViolation[]): string {
  return violations.map((v) => v.detail).join(' / ');
}
