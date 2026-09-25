import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { GitCommandRunner } from './worktree';

/**
 * タスクのworktreeを一時的に分岐元の状態へ戻し、処理を走らせてから元へ戻す（Issue #1468）。
 *
 * `verify.revertCheck`（本番側の変更だけを戻して `verify.commands` を再実行する）と
 * `verify.baseline`（変更全体を戻して分岐元で測る）の両方がこれを使う。別のworktreeを
 * 作らないのは、タスクのworktreeには依存物（`node_modules` など）が入っておらず、新しく
 * 作ったworktreeではコマンドがそのままでは動かないため。
 *
 * ## スナップショット
 *
 * 作業ツリーの内容は、一時index（`GIT_INDEX_FILE`）へ `git add -A` してから `git write-tree` で
 * tree として取る。一時indexは本物のindexの写しから始める（stat情報を使い回して全ファイルの
 * 再ハッシュを避けるため）。本物のindexには触れない。未追跡のファイルも含めて取れる
 * （ignoreされたファイルは含まない）。blobはobjectDBへ書かれるが、参照されないのでgcで消える。
 *
 * ## 戻し方
 *
 * 状態Aから状態Bへ動かすときは、`git diff --name-status --no-renames A B` で出たパスだけを
 * 触る。Bにあるパスは `git restore --source=B --worktree` で書き、Bに無いパスは消す。
 * `--worktree` だけを指定するので、本物のindexは変わらない。
 *
 * 復元は「今の作業ツリー」から「戻す前のtree」へ動かす。戻した状態で走らせたコマンドが
 * 未追跡のファイルを足していても、それも消える。復元の後にもう一度スナップショットを取り、
 * 戻す前のtreeと一致することを確かめる（Issue #1468 受入基準5）。一致しなければもう一度だけ
 * 試み、それでも駄目なら `restoreError` を返す。
 *
 * ## 対象外
 *
 * サブモジュール（gitlink）は戻さず、中身の変化もスナップショットに入らない。一致確認は
 * サブモジュールの中を見ない。戻した状態でコマンドがサブモジュールの中を書き換えても
 * 検知できないが、これは通常の `verify.commands` の実行と同じ扱いである。
 * ignoreされたファイル（ビルド成果物など）も同じく戻さず、確認もしない。
 */

/** 変更を戻す範囲。`production` はテスト以外のファイルだけ、`all` は変更全体 */
export type RevertScope = 'production' | 'all';

export type TemporaryRevertResult<T> =
  /** 戻した状態で `body` を走らせた。`restoreError` があれば作業ツリーを元へ戻せていない */
  | {
      readonly kind: 'ran';
      readonly value: T;
      readonly revertedPaths: readonly string[];
      readonly restoreError?: string;
    }
  /** 戻す対象が無かった（`body` は走らせていない） */
  | { readonly kind: 'noChanges' }
  /** 戻す前に中断された（`body` は走らせていない。作業ツリーは元のまま） */
  | { readonly kind: 'aborted' }
  /** 戻せなかった（`body` は走らせていない）。`restoreError` があれば作業ツリーを元へ戻せていない */
  | { readonly kind: 'failed'; readonly error: string; readonly restoreError?: string };

const ENV_WITHOUT_REPO_OVERRIDES = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
} as const;

/**
 * テストのファイルか。既定のglob（`**\/*.test.*`、`**\/*.spec.*`、`test/**`、`tests/**`、
 * `__tests__/**`）に相当する判定を、ディレクトリの区切りごとに見る。
 */
export function isTestPath(file: string): boolean {
  const segments = file.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (/\.(test|spec)\./u.test(base)) {
    return true;
  }
  return segments
    .slice(0, -1)
    .some((segment) => segment === 'test' || segment === 'tests' || segment === '__tests__');
}

class GitStepError extends Error {}

/** サブモジュールを指すtreeの要素のmode */
const GITLINK_MODE = '160000';

async function runGit(
  git: GitCommandRunner,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = ENV_WITHOUT_REPO_OVERRIDES,
): Promise<string> {
  const result = await git.run(args, cwd, { env });
  if (result.code !== 0) {
    throw new GitStepError(`git ${args[0] ?? ''} に失敗しました: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** 作業ツリーの今の内容をtreeとして取る（本物のindexは変えない） */
export async function snapshotWorktree(git: GitCommandRunner, cwd: string): Promise<string> {
  const indexPath = (
    await runGit(git, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], cwd)
  ).trim();
  const work = await fs.mkdtemp(path.join(tmpdir(), 'agent-verify-revert-'));
  try {
    const tempIndex = path.join(work, 'index');
    await fs.copyFile(indexPath, tempIndex).catch(async (error: unknown) => {
      // 1度もcommit・stageしていないworktreeにはindexが無い。空のindexから始める
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    const env = { ...ENV_WITHOUT_REPO_OVERRIDES, GIT_INDEX_FILE: tempIndex };
    await runGit(git, ['add', '-A'], cwd, env);
    return (await runGit(git, ['write-tree'], cwd, env)).trim();
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

interface PathChange {
  readonly file: string;
  /** 動かした先に無い（消す）パス */
  readonly deleted: boolean;
}

async function listChanges(
  git: GitCommandRunner,
  cwd: string,
  from: string,
  to: string,
): Promise<PathChange[]> {
  // `--raw` の1件は `:<旧mode> <新mode> <旧sha> <新sha> <状態>\0<パス>\0`
  const out = await runGit(git, ['diff', '--raw', '-z', '--no-renames', from, to], cwd);
  const fields = out.split('\0').filter((field) => field !== '');
  const changes: PathChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode = '', newMode = '', , , status = ''] = (fields[i] ?? '').slice(1).split(' ');
    const file = fields[i + 1] ?? '';
    // サブモジュール（gitlink）は触らない。中身はスナップショットにも入らない
    if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) {
      continue;
    }
    changes.push({ file, deleted: status.startsWith('D') });
  }
  return changes;
}

/** 作業ツリーの `changes` のパスを `to` の内容へ動かす */
async function applyChanges(
  git: GitCommandRunner,
  cwd: string,
  to: string,
  changes: readonly PathChange[],
): Promise<void> {
  // 先に消す。ファイルとディレクトリが入れ替わったパス（`a` と `a/x`）で、書く先の
  // 親がファイルのまま残らないようにする
  for (const change of changes) {
    if (change.deleted) {
      await fs.rm(path.join(cwd, change.file), { recursive: true, force: true });
    }
  }
  const restore = changes.filter((change) => !change.deleted).map((change) => change.file);
  for (const file of restore) {
    // 書く先がディレクトリになっていると `git restore` が書けない
    const stat = await fs.lstat(path.join(cwd, file)).catch(() => undefined);
    if (stat?.isDirectory() === true) {
      await fs.rm(path.join(cwd, file), { recursive: true, force: true });
    }
  }
  // 引数長の上限を避けるため、まとめて渡す数を抑える。パスは字義どおりに解釈させる
  // （`:` で始まる名前や `*` を含む名前をpathspecの記法として読ませない）
  const env = { ...ENV_WITHOUT_REPO_OVERRIDES, GIT_LITERAL_PATHSPECS: '1' };
  for (let i = 0; i < restore.length; i += 200) {
    await runGit(
      git,
      ['restore', `--source=${to}`, '--worktree', '--', ...restore.slice(i, i + 200)],
      cwd,
      env,
    );
  }
}

/** 作業ツリーを `target` と同じ内容へ戻し、スナップショットで一致を確かめる。1回だけ再試行する */
async function restoreWorktree(
  git: GitCommandRunner,
  cwd: string,
  target: string,
): Promise<string | undefined> {
  let lastError = '';
  for (let tries = 0; tries < 2; tries++) {
    try {
      const current = await snapshotWorktree(git, cwd);
      if (current === target) {
        return undefined;
      }
      await applyChanges(git, cwd, target, await listChanges(git, cwd, current, target));
      const after = await snapshotWorktree(git, cwd);
      if (after === target) {
        return undefined;
      }
      lastError = `復元後の作業ツリー（${after}）が戻す前（${target}）と一致しません`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return lastError;
}

/**
 * `originCommit` からの変更（`scope` で絞る）を一時的に戻して `body` を走らせ、必ず元へ戻す。
 * `body` が例外を投げた場合も、元へ戻してから投げ直す（戻せなかったことはメッセージへ足す）。
 */
export async function withTemporaryRevert<T>(input: {
  readonly git: GitCommandRunner;
  readonly cwd: string;
  readonly originCommit: string;
  readonly scope: RevertScope;
  readonly body: () => Promise<T>;
  /**
   * 中断されていれば戻す前に見送る。戻した後の復元は中断されても必ず最後まで行うため、
   * git呼び出しへは渡さない（途中で止めると作業ツリーが戻す前にも後にもならない）
   */
  readonly signal?: AbortSignal;
}): Promise<TemporaryRevertResult<T>> {
  const { git, cwd, originCommit } = input;
  let before: string;
  let targets: PathChange[];
  try {
    before = await snapshotWorktree(git, cwd);
    const changes = await listChanges(git, cwd, before, originCommit);
    targets =
      input.scope === 'all' ? changes : changes.filter((change) => !isTestPath(change.file));
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  if (targets.length === 0) {
    return { kind: 'noChanges' };
  }
  if (input.signal?.aborted === true) {
    return { kind: 'aborted' };
  }

  try {
    await applyChanges(git, cwd, originCommit, targets);
  } catch (error) {
    const restoreError = await restoreWorktree(git, cwd, before);
    return {
      kind: 'failed',
      error: `変更を戻せませんでした: ${error instanceof Error ? error.message : String(error)}`,
      ...(restoreError === undefined ? {} : { restoreError }),
    };
  }

  let value: T;
  try {
    value = await input.body();
  } catch (error) {
    const restoreError = await restoreWorktree(git, cwd, before);
    if (restoreError !== undefined && error instanceof Error) {
      error.message += `（作業ツリーを元へ戻せませんでした: ${restoreError}）`;
    }
    throw error;
  }
  const restoreError = await restoreWorktree(git, cwd, before);
  return {
    kind: 'ran',
    value,
    revertedPaths: targets.map((change) => change.file),
    ...(restoreError === undefined ? {} : { restoreError }),
  };
}
