import type { TaskState } from './runState';
import type { GitCommandRunner } from './worktree';

/**
 * 走行中のタスクが触っているファイルの実測と、その交差の判定（Issue #1469、ロードマップH2）。
 *
 * 触るファイルを事前に宣言させる方式は実運用で3回続けて外れた（Issueの背景参照）ため、
 * 交差は実測した集合だけで判定する。`WorkflowTask`の`evidence`等の記述は使わない。
 *
 * このファイルは測定（gitの呼び出し）と純粋な判定だけを持つ。状態遷移・セッションの一時停止・
 * 再開は`runnerOverlap.ts`が担う。
 */

/** `agent.workflows.overlapCheckIntervalSec`の既定値（秒） */
export const DEFAULT_OVERLAP_CHECK_INTERVAL_SEC = 30;

/** 交差で待たせている理由。Viewへそのまま出す。 */
export interface OverlapWait {
  /** 交差した相手（先に走り始めた方）のタスクid */
  readonly withTaskId: string;
  /** 交差したファイル（リポジトリ相対、`/`区切り、昇順） */
  readonly files: readonly string[];
}

/** 判定の入力。1タスク分の実測値。 */
export interface OverlapEntry {
  readonly taskId: string;
  /** 走り始めた順。小さいほど先発 */
  readonly startSeq: number;
  readonly state: TaskState;
  readonly files: ReadonlySet<string>;
}

/**
 * 統合ブランチへまだ入っていない変更を抱えている状態。この状態の先発タスクと交差したら、
 * 後発は待つ。`done`はマージ済み（統合ブランチへ入った）なので含めない。
 */
const HOLDING_STATES: ReadonlySet<TaskState> = new Set([
  'running',
  'waitingApproval',
  'waitingReply',
  'waitingOverlap',
  'merging',
]);

/** 相手がこの状態の間は待機を続ける。外れたら（`done`・`failed`等）待機を解く。 */
export function isOverlapHoldingState(state: TaskState | undefined): boolean {
  return state !== undefined && HOLDING_STATES.has(state);
}

/**
 * 交差の判定から外すパスか。`ignore`の要素は、リポジトリ相対のパスと完全一致するか、
 * `/`で終わる要素ならその配下すべてに一致する（`docs/design.md`のように多くのタスクが
 * 追記するだけのファイルで待機が増えすぎないようにするため。Issueの確認点）。
 */
export function isOverlapIgnored(file: string, ignore: readonly string[]): boolean {
  return ignore.some((entry) =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry,
  );
}

/**
 * 待たせるべき後発タスクと、その理由を返す。
 *
 * - 待たせる対象は`running`のタスクだけ（承認待ち・返信待ちは既に止まっているので触らない）
 * - 相手は、自分より先に走り始め、まだ統合ブランチへ入っていない変更を抱えているタスク
 *   （`isOverlapHoldingState`）。複数あれば最も先に走り始めた相手を理由にする
 * - 開始順で向きが決まるため、互いに待ち合う循環は起きない
 */
export function findOverlapWaits(
  entries: readonly OverlapEntry[],
  ignore: readonly string[],
): ReadonlyMap<string, OverlapWait> {
  const ordered = [...entries].sort((a, b) => a.startSeq - b.startSeq);
  const result = new Map<string, OverlapWait>();
  for (const [index, follower] of ordered.entries()) {
    if (follower.state !== 'running') {
      continue;
    }
    for (const leader of ordered.slice(0, index)) {
      if (!isOverlapHoldingState(leader.state)) {
        continue;
      }
      const files = [...follower.files]
        .filter((file) => leader.files.has(file) && !isOverlapIgnored(file, ignore))
        .sort();
      if (files.length > 0) {
        result.set(follower.taskId, { withTaskId: leader.taskId, files });
        break;
      }
    }
  }
  return result;
}

/** 呼び出し元の環境変数で別のリポジトリを指さないようにする（`runnerRevert.ts`と同じ） */
const ENV_WITHOUT_REPO_OVERRIDES = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
} as const;

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

/**
 * gitのworktreeで、分岐元からの変更ファイルを実測する。commit済み・未commit・未追跡の
 * すべてを含む。取れなければ`undefined`（交差の判定に使わない）。
 *
 * `--no-optional-locks`を付けるのは、走行中のエージェントが同じworktreeでgitを使っている
 * ところへ`index.lock`を取りに行かないため。
 */
export async function measureWorktreeFiles(
  git: GitCommandRunner,
  cwd: string,
  originCommit: string,
): Promise<ReadonlySet<string> | undefined> {
  const options = { env: ENV_WITHOUT_REPO_OVERRIDES };
  try {
    const [tracked, untracked] = await Promise.all([
      git.run(
        ['--no-optional-locks', 'diff', '--name-only', '-z', '--no-renames', originCommit, '--'],
        cwd,
        options,
      ),
      git.run(
        ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z'],
        cwd,
        options,
      ),
    ]);
    if (tracked.code !== 0 || untracked.code !== 0) {
      return undefined;
    }
    return new Set([...splitNul(tracked.stdout), ...splitNul(untracked.stdout)]);
  } catch {
    return undefined;
  }
}
