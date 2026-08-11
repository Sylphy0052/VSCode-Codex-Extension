import { execFile } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import type { TaskBoundary } from './escalation';
import type { TaskState } from './runState';
import type { CleanupMode, Isolation } from './workflow';

/**
 * タスクごとの作業ディレクトリ分離とgit外フォールバック（design.md §16.6）。
 *
 * `escalation.ts` と同じく、VSCode APIには依存しない。gitの呼び出し（`execFile`。
 * シェルを経由しない。§8「引数インジェクション」と同じ方針）とファイルシステムへの
 * アクセス（実パス解決・`.gitignore` の確認）はポート越しにし、テストで差し替える。
 *
 * worktreeの作成・撤去のスケジューリング（誰の完了を待ってから始めるか）は
 * `scheduler.ts` / `runState.ts` の責務で、ここには置かない。このモジュールが持つのは
 * 「1件の作成・1件の撤去をどう安全に行うか」と、複数の作成要求を1本のキューへ通す
 * 直列化だけ。
 */

/** gitコマンドの実行結果。`stdout` を含む点が `session/sessionActions.ts` の `CommandResult` と違う。 */
export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * gitコマンド実行の抽象。`nodeCommandRunner`（`src/session/sessionActions.ts`）と同じく
 * `execFile` にargv配列を渡す実装を既定にし、テストでは呼ばれた引数列を記録する
 * フェイクに差し替える。
 */
export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

const GIT_TIMEOUT_MS = 30_000;

export const nodeGitCommandRunner: GitCommandRunner = {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    return new Promise((resolve) => {
      // execFileはシェルを経由せず、argv配列をそのままプロセスへ渡す。`exec` と違い
      // `;` `&&` 等のシェルメタ文字は引数の中身としてしか解釈されない（design.md §8）。
      execFile('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
      });
    });
  },
};

/** ファイルシステムへのアクセスの抽象。実パス解決と `.gitignore` の読み取りだけに絞る。 */
export interface WorktreeFileSystemPort {
  /** シンボリックリンクを解決した実パス。存在しなければ undefined。 */
  realpath(target: string): Promise<string | undefined>;
  /** ファイル全体をUTF-8で読む。存在しなければ undefined。 */
  readTextFile(target: string): Promise<string | undefined>;
}

export const nodeWorktreeFileSystem: WorktreeFileSystemPort = {
  async realpath(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.realpath(target);
    } catch {
      return undefined;
    }
  },
  async readTextFile(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(target, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** worktreeを置くディレクトリ（design.md §16.6）。 */
export function worktreesRootDir(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'worktrees');
}

/** タスク1件のworktreeの絶対パス。 */
export function worktreePath(repoRoot: string, runId: string, taskId: string): string {
  return path.join(worktreesRootDir(repoRoot), runId, taskId);
}

/**
 * worktreeのブランチ名。再試行時は `-retry<n>` を付ける（design.md §16.5）。
 * `retry` を渡さない1回目の実行と、`retry: 0` 以降の再試行を区別するため `undefined` を既定にする。
 */
export function branchName(runId: string, taskId: string, retry?: number): string {
  return retry === undefined ? `wf/${runId}/${taskId}` : `wf/${runId}/${taskId}-retry${retry}`;
}

/** ワークスペースがgitの作業ツリーかどうか（ベアリポジトリを除く）。 */
export async function isGitWorkingTree(repoRoot: string, git: GitCommandRunner): Promise<boolean> {
  const result = await git.run(['rev-parse', '--is-inside-work-tree'], repoRoot);
  return result.code === 0 && result.stdout.trim() === 'true';
}

/**
 * 実行開始時のHEADコミットを解決する。
 *
 * **呼び出し側が実行開始時に一度だけ呼び、その値を全タスクの `createWorktree` へ
 * 使い回すこと。** 実行中にHEADが動いても全タスクが同じ地点から分岐する（design.md §16.6）
 * という要件は、この関数自体ではなく「1回だけ呼んで使い回す」呼び出し側の責務で満たす。
 */
export async function resolveHeadCommit(
  repoRoot: string,
  git: GitCommandRunner,
): Promise<string | undefined> {
  const result = await git.run(['rev-parse', 'HEAD'], repoRoot);
  const sha = result.stdout.trim();
  return result.code === 0 && sha !== '' ? sha : undefined;
}

/**
 * `git rev-parse --git-common-dir` を実パス解決した結果。worktreeの `.git` は実体がファイルで、
 * hooksなどの実データは親リポジトリの共有領域にある（design.md §16.7）。`escalation.ts` の
 * `TaskBoundary.gitCommonDir` はこの値をそのまま使う想定。
 *
 * gitでない、または取得できない場合は undefined。`git rev-parse --git-common-dir` は
 * gitの作業ツリーでないディレクトリでは非ゼロ終了するため、`isGitWorkingTree` を別途
 * 呼ばなくてもここで自然に undefined へ落ちる。
 */
export async function resolveGitCommonDir(
  repoRoot: string,
  git: GitCommandRunner,
  fsPort: WorktreeFileSystemPort,
): Promise<string | undefined> {
  const result = await git.run(['rev-parse', '--git-common-dir'], repoRoot);
  const raw = result.stdout.trim();
  if (result.code !== 0 || raw === '') {
    return undefined;
  }
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  return fsPort.realpath(absolute);
}

/**
 * タスクごとの `TaskBoundary`（`escalation.ts`）を組み立てる。#54 のパス境界判定・
 * `.git` 保護はこの値を前提にしているため、`gitCommonDir` を供給し忘れると
 * worktreeの `.git`（実体はファイル）配下の共有領域への書き込みが素通りする。
 *
 * `roots` は解決前の候補（タスクの作業ディレクトリ、worktreeのルートなど）。
 * 実パス解決に失敗したもの（存在しない等）は黙って除く。全滅した場合、
 * `escalation.ts` 側は `allowedRoots` が空の境界を「常に境界外」として安全側に扱う。
 */
export async function buildTaskBoundary(
  roots: readonly string[],
  repoRoot: string,
  git: GitCommandRunner,
  fsPort: WorktreeFileSystemPort,
): Promise<TaskBoundary> {
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    const resolved = await fsPort.realpath(root);
    if (resolved !== undefined && !resolvedRoots.includes(resolved)) {
      resolvedRoots.push(resolved);
    }
  }
  return {
    allowedRoots: resolvedRoots,
    gitCommonDir: await resolveGitCommonDir(repoRoot, git, fsPort),
  };
}

/**
 * `isolation` の3値とgit外フォールバックの決定（design.md §16.6の表）。
 * ファイルシステム・gitに触れない純粋関数。`isGitRepo` は呼び出し側が
 * `isGitWorkingTree` で解決済みの値を渡す。
 */
export type WorkingDirectoryDecision =
  /** `cwd` を明示したタスク。`isolation` より優先し、worktreeを作らない。 */
  | { kind: 'explicitCwd' }
  /** worktreeを作る。 */
  | { kind: 'worktree' }
  /** `isolation: shared` が最初から指定されている（フォールバックではない）。 */
  | { kind: 'shared' }
  /** `isolation: worktree` がgit外のため `shared` へ落ちた。警告を伴う。 */
  | { kind: 'sharedFallback'; warning: string }
  /** `isolation: worktree-strict` がgit外のため実行を開始できない。 */
  | { kind: 'error'; message: string };

const NOT_GIT_FALLBACK_WARNING =
  'ワークスペースがgitの作業ツリーではないため、isolation: worktreeをshared（ワークスペース直下）' +
  'へ切り替えました。並列タスクが同じディレクトリで走るためファイル衝突しうります。' +
  '{{T.branch}}は空文字になります。';

const NOT_GIT_STRICT_ERROR =
  'isolation: worktree-strictが指定されていますが、ワークスペースがgitの作業ツリーではないため' +
  '実行を開始できません。';

export function decideWorkingDirectory(
  task: { isolation: Isolation; cwd: string | undefined },
  isGitRepo: boolean,
): WorkingDirectoryDecision {
  if (task.cwd !== undefined) {
    return { kind: 'explicitCwd' };
  }
  if (task.isolation === 'shared') {
    return { kind: 'shared' };
  }
  if (isGitRepo) {
    return { kind: 'worktree' };
  }
  if (task.isolation === 'worktree-strict') {
    return { kind: 'error', message: NOT_GIT_STRICT_ERROR };
  }
  return { kind: 'sharedFallback', warning: NOT_GIT_FALLBACK_WARNING };
}

/** `createWorktree` の入力。 */
export interface CreateWorktreeRequest {
  repoRoot: string;
  runId: string;
  taskId: string;
  /** 実行開始時に一度だけ解決したHEAD（`resolveHeadCommit`）。全タスクで同じ値を渡す。 */
  headCommit: string;
  /** 再試行回数。1回目は undefined（design.md §16.5）。 */
  retry: number | undefined;
}

export type CreateWorktreeResult =
  | { ok: true; cwd: string; branch: string }
  | { ok: false; reason: 'branchExists' | 'gitError'; message: string };

/**
 * worktreeを1件作る。呼び出し側は `WorktreeCreationQueue` を介して呼ぶこと
 * （直列化しないと同時実行で `index.lock` が競合する。design.md §16.6）。
 *
 * 同名のブランチが既にあればエラーで返し、`git worktree add` 自体を試みない
 * （既存の作業を踏まないため）。worktree作成に失敗したときは呼び出し側がそのタスクを
 * 開始しない前提で、この関数自体は後始末をしない（中途半端な状態を隠さず、失敗を
 * そのまま呼び出し側へ返す）。
 */
export async function createWorktree(
  request: CreateWorktreeRequest,
  git: GitCommandRunner,
): Promise<CreateWorktreeResult> {
  const branch = branchName(request.runId, request.taskId, request.retry);
  const cwd = worktreePath(request.repoRoot, request.runId, request.taskId);

  const verify = await git.run(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    request.repoRoot,
  );
  if (verify.code === 0) {
    return { ok: false, reason: 'branchExists', message: `ブランチ ${branch} は既に存在します` };
  }

  const add = await git.run(
    ['worktree', 'add', '-b', branch, cwd, request.headCommit],
    request.repoRoot,
  );
  if (add.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        add.stderr.trim() !== ''
          ? add.stderr.trim()
          : `git worktree add に失敗しました（終了コード ${add.code}）`,
    };
  }
  return { ok: true, cwd, branch };
}

/**
 * worktree作成だけを1本のキューへ通して直列化する。
 *
 * タスクの並列実行そのものは止めない（`scheduler.ts` の範囲）。同時に依存が解けた
 * 複数タスクが同時に `git worktree add` を叩くと同じリポジトリの `index.lock` で
 * 競合するため、worktree操作だけをこのキューに通す（design.md §16.6）。
 *
 * 前の項目が失敗（例外・エラー結果）しても後続はブロックしない。`this.tail` は
 * 「実行が終わったこと」だけを表す継続用Promiseで、結果や例外は `enqueue` の
 * 戻り値としてそれぞれの呼び出し元へ個別に返る。
 */
export class WorktreeCreationQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * `cleanup: remove` かつタスクが `done` のときだけ撤去してよい（design.md §16.6）。
 * `failed` は必ず残す。純粋関数にしておき、実際の撤去（`removeWorktree`）を呼ぶかどうかは
 * 呼び出し側（`runner.ts`）がこれで判定する。
 */
export function shouldRemoveWorktree(cleanup: CleanupMode, taskState: TaskState): boolean {
  return cleanup === 'remove' && taskState === 'done';
}

export type RemoveWorktreeResult =
  { ok: true } | { ok: false; reason: 'uncommittedChanges' | 'gitError'; message: string };

/**
 * worktreeを1件撤去する。未コミットの変更があれば撤去せず警告として返す。
 * ディレクトリを直接消すことはしない（`git worktree remove` のみを使う。design.md §16.6）。
 * この関数自体はファイルシステムに触れないため、構造的にディレクトリの直接削除ができない
 * （`WorktreeFileSystemPort` に削除メソッドを持たせていない）。
 */
export async function removeWorktree(
  cwd: string,
  repoRoot: string,
  git: GitCommandRunner,
): Promise<RemoveWorktreeResult> {
  const status = await git.run(['status', '--porcelain'], cwd);
  if (status.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        status.stderr.trim() !== ''
          ? status.stderr.trim()
          : `git status の取得に失敗しました（終了コード ${status.code}）`,
    };
  }
  if (status.stdout.trim() !== '') {
    return {
      ok: false,
      reason: 'uncommittedChanges',
      message: `未コミットの変更があるため撤去しませんでした: ${cwd}`,
    };
  }

  const remove = await git.run(['worktree', 'remove', cwd], repoRoot);
  if (remove.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        remove.stderr.trim() !== ''
          ? remove.stderr.trim()
          : `git worktree remove に失敗しました（終了コード ${remove.code}）`,
    };
  }
  return { ok: true };
}

/** `.gitignore` に追記を促す文言に使う1行。 */
const WORKTREES_GITIGNORE_ENTRY = '.agents/worktrees/';

/** `checkWorktreesGitignored` の結果。`.gitignore` を勝手に書き換えないための案内材料。 */
export interface GitignoreCheckResult {
  needsEntry: boolean;
  message: string | undefined;
}

/**
 * `.gitignore` に `.agents/worktrees/` が無ければ追記を促す（design.md §16.6）。
 * 呼び出し側（ログ・ワークフローView）が案内を出せるよう結果を返すだけで、
 * ファイルの書き換えはここでは行わない。
 */
export async function checkWorktreesGitignored(
  repoRoot: string,
  fsPort: WorktreeFileSystemPort,
): Promise<GitignoreCheckResult> {
  const content = await fsPort.readTextFile(path.join(repoRoot, '.gitignore'));
  const lines = (content ?? '').split(/\r?\n/u).map((line) => line.trim());
  const covered = lines.some(
    (line) =>
      line === WORKTREES_GITIGNORE_ENTRY ||
      line === '.agents/worktrees' ||
      line === '.agents/' ||
      line === '.agents',
  );
  if (covered) {
    return { needsEntry: false, message: undefined };
  }
  return {
    needsEntry: true,
    message: `.gitignore に ${WORKTREES_GITIGNORE_ENTRY} がありません。追記を検討してください。`,
  };
}
