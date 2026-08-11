import { integrationBranchName, integrationWorktreePath, reconcileMergingTaskOnReload } from './integration';
import { resolvePseudoState } from './runnerWorkingDirectory';
import { startMerge } from './runnerMerge';
import { markMergeBlocked, type RunState, type TaskRunState } from './runState';
import type { PersistedRun } from './runStore';
import { getRunOutcome } from './scheduler';
import { isGitWorkingTree, resolveHeadCommit } from './worktree';
import {
  MAX_WORKFLOW_FILE_BYTES,
  parseWorkflowYaml,
  validateWorkflow,
  type WorkflowDefinition,
} from './workflow';
import type { LiveRun, LiveRunForgeState, WorkflowRunner } from './runner';

/**
 * ウィンドウのリロード後の実行再開（design.md §16.11、Issue #147）を集めたモジュール。
 * `WorkflowRunner`から機能単位で切り出した1本。
 *
 * `self: WorkflowRunner`を第一引数に取るのは、`WorkflowRunner`のメソッドから機械的に
 * 切り出したままの形を保ち、挙動を変えないため（最終報告に記載）。
 */

/**
 * リロード直後に呼ぶ（design.md §16.11「リロード後の実行再開」）。
 *
 * `workspaceState` に残っているrun（`reconcileAfterReload` で走行中タスクを
 * 中断扱いへ倒し済み）をメモリ上へ復元し、ワークフローViewが表示・「再実行」
 * できるようにする。#56では中断扱いに倒すところまでしか実装していなかった。
 *
 * 定義ファイルが読めない・検証を通らないrunは復元をあきらめる（ログにだけ残す）。
 * そのrunはこのウィンドウのライブな状態には現れないが、`workspaceState`自体からは
 * 消さない（ファイルを直して次回リロードすれば復元できる余地を残す）。
 */
export async function restoreRunsForView(self: WorkflowRunner): Promise<void> {
  const persisted = await self.deps.store.reconcileAfterReload();
  for (const p of persisted) {
    if (self.runs.has(p.runId)) {
      continue;
    }
    const rebuilt = await rebuildLiveRun(self, p);
    if (rebuilt === undefined) {
      continue;
    }
    self.runs.set(p.runId, rebuilt);
    // `rebuildLiveRun`が統合ブランチの実際の状態から判定し直してもなお`merging`のまま
    // 残ったタスクは、マージが実行途中で切れていたと分かっているもの。ライブなセッションは
    // 無い（リロードで失われた）ため、永続化された`branch`/`cwd`だけを頼りにマージを
    // やり直す（design.md §16.11「`merging`からやり直す」）
    for (const [taskId, s] of rebuilt.runState.tasks) {
      if (s.state === 'merging') {
        resumeMergeAfterReload(self, p.runId, taskId);
      }
    }
  }
}

/**
 * リロード直後、まだ`merging`のまま残ったタスクのマージをやり直す
 * （design.md §16.11。`restoreRunsForView`から呼ぶ）。ライブなセッション
 * （`LiveTask`）は無いため、永続化された`branch`/`cwd`を直接使う。どちらか欠けている
 * （古い永続化形式・作成前に中断した等）場合は再開できないため、安全側で`blocked`にする。
 */
function resumeMergeAfterReload(self: WorkflowRunner, runId: string, taskId: string): void {
  const live = self.runs.get(runId);
  if (live === undefined || live.integration === undefined) {
    return;
  }
  const task = live.def.tasks.find((t) => t.id === taskId);
  const persistedTask = self.deps.store.find(runId)?.tasks[taskId];
  const branch = persistedTask?.branch;
  const cwd = persistedTask?.cwd;
  if (task === undefined || branch === undefined || branch === '' || cwd === undefined) {
    self.deps.log.warn(
      `[workflow ${runId}/${taskId}] マージを再開するための情報が不足しているため blocked にします`,
    );
    live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
    void self.persist(runId);
    self.notify(runId);
    return;
  }
  void startMerge(self, runId, taskId, task, cwd, branch, '');
}

/**
 * `rebuildLiveRun`の前半（design.md §16.11の受入基準）。定義ファイルの読み込み・解析・
 * 検証を行う。`start()`と同じ上限チェックをここでも通す（レビュー指摘: medium 2）。
 * `MAX_WORKFLOW_FILE_BYTES`のコメントどおり「巨大なYAMLで拡張機能ホスト（シングルスレッド）
 * を固まらせない」ための防御であり、復元経路だけ素通りさせない。
 */
async function loadPersistedWorkflowDefinition(
  self: WorkflowRunner,
  p: PersistedRun,
): Promise<WorkflowDefinition | undefined> {
  const size = await self.deps.filePort.fileSize(p.defPath);
  if (size === undefined || size > MAX_WORKFLOW_FILE_BYTES) {
    self.deps.log.warn(
      `[workflow ${p.runId}] 定義ファイルを読み込めないため復元できません: ${p.defPath}`,
    );
    return undefined;
  }
  const text = await self.deps.filePort.readTextFile(p.defPath);
  if (text === undefined) {
    self.deps.log.warn(
      `[workflow ${p.runId}] 定義ファイルを読み込めないため復元できません: ${p.defPath}`,
    );
    return undefined;
  }
  let def: WorkflowDefinition;
  try {
    def = parseWorkflowYaml(text);
  } catch {
    self.deps.log.warn(
      `[workflow ${p.runId}] 定義ファイルの解析に失敗したため復元できません: ${p.defPath}`,
    );
    return undefined;
  }
  if (validateWorkflow(def).errors.length > 0) {
    self.deps.log.warn(
      `[workflow ${p.runId}] 定義ファイルが検証を通らないため復元できません: ${p.defPath}`,
    );
    return undefined;
  }
  return def;
}

/**
 * 永続化されたタスク状態を、統合ブランチの実際の状態から判定し直す
 * （design.md §16.11「`merging`だったタスクは、状態の記録ではなく統合ブランチの実際の
 * 状態から判定し直す」）。
 */
async function reconcileRestoredTaskStates(
  self: WorkflowRunner,
  p: PersistedRun,
  integration: { cwd: string; branch: string } | undefined,
): Promise<Map<string, TaskRunState>> {
  const tasks = new Map<string, TaskRunState>();
  for (const [id, t] of Object.entries(p.tasks)) {
    let state = t.state;
    let failure = t.failure;
    if (state === 'merging') {
      // gitRepoでない（統合worktreeが無い）実行で`merging`が残っているのは想定外の状態
      // のため、安全側で`blocked`にする
      if (integration === undefined) {
        state = 'blocked';
      } else {
        const outcome = await reconcileMergingTaskOnReload(integration.cwd, p.runId, id, self.deps.git);
        if (outcome === 'done') {
          state = 'done';
        } else if (outcome === 'blocked') {
          state = 'blocked';
        } else if (t.cwd === undefined || t.branch === undefined || t.branch === '') {
          // マージをやり直すための情報（タスクのworktreeのcwd・ブランチ名）が無い。
          // `restoreRunsForView`側の再開処理も同じ条件で`blocked`に倒すため、ここで
          // 先に確定させて二重の判定を避ける
          state = 'blocked';
        }
        // それ以外（outcome === 'merging' かつ再開に必要な情報がある）は`merging`のまま
        // 残す。`restoreRunsForView`がこのあとマージをやり直す
      }
      if (state !== 'merging') {
        failure = undefined;
      }
    }
    tasks.set(id, {
      state,
      submissionCount: t.submissionCount,
      retryCount: t.retryCount,
      failure,
      sessionId: t.sessionId,
      cwd: t.cwd,
    });
  }
  return tasks;
}

/**
 * 疑似worktree（design.md §16.20）。リロード後の再構築はベストエフォートにする
 * （`rebuildLiveRun`自体が「定義ファイルを読めない等は復元をあきらめる」以外は失敗時も
 * 可能な限り表示を続ける方針のため。統合先の再作成に失敗した場合は`pseudo: undefined`の
 * まま続け、ログにだけ残す）。なお、疑似worktreeの`baseline`はrun開始時点ではなく
 * **復元した時点**のワークスペースで取り直す（`headCommit`と同じ「復元時点を基準にする」
 * 簡略化。再実行は新しい複製でやり直す設計のため、この差異は再実行の意味を壊さない）。
 */
async function resolveRestoredPseudoState(
  self: WorkflowRunner,
  p: PersistedRun,
): Promise<LiveRun['pseudo']> {
  const resolved = await resolvePseudoState(self, p.workspaceRoot, p.runId);
  if (resolved.ok) {
    return resolved.state;
  }
  self.deps.log.warn(
    `[workflow ${p.runId}] 疑似worktreeの統合先を復元できませんでした: ${resolved.message}`,
  );
  return undefined;
}

async function rebuildLiveRun(self: WorkflowRunner, p: PersistedRun): Promise<LiveRun | undefined> {
  const def = await loadPersistedWorkflowDefinition(self, p);
  if (def === undefined) {
    return undefined;
  }

  const gitRepo = await isGitWorkingTree(p.workspaceRoot, self.deps.git);
  // 元のHEADは永続化していない（design.md §16.11は応答本文以外も最小限しか保存しない
  // 方針）ため、復元した時点のHEADを分岐元にする。再実行は元々「新しいスレッド・
  // worktreeでやり直す」設計（design.md §16.5）なので、この差異は再実行の意味を壊さない
  const headCommit = gitRepo ? ((await resolveHeadCommit(p.workspaceRoot, self.deps.git)) ?? '') : '';

  // 統合ブランチ・統合worktree（design.md §16.17）。gitRepoでない実行には統合の概念が
  // 無い。永続化された`integrationBranch`（古い形式や空文字なら決定的に導ける値）を使う
  const integrationBranch =
    p.integrationBranch !== '' ? p.integrationBranch : integrationBranchName(p.runId);
  const integration = gitRepo
    ? { cwd: integrationWorktreePath(p.workspaceRoot, p.runId), branch: integrationBranch }
    : undefined;

  const tasks = await reconcileRestoredTaskStates(self, p, integration);
  const runState: RunState = { tasks, haltedByUser: p.haltedByUser };
  const forge: LiveRunForgeState = gitRepo
    ? await self.resolveForgeState(p.workspaceRoot)
    : { kind: 'disabled' };
  const pseudo = gitRepo ? undefined : await resolveRestoredPseudoState(self, p);

  return {
    runId: p.runId,
    def,
    defPath: p.defPath,
    repoRoot: p.workspaceRoot,
    gitRepo,
    headCommit,
    startedAt: p.startedAt,
    runState,
    // このプロセスでまだセッションを開いていない。`hasLiveSession: false`として
    // Viewへ出る（design.md §16.11。再実行すればstartTask()が新しく作る）
    tasks: new Map(),
    finished: getRunOutcome(runState) !== 'running',
    warnings: [],
    integration,
    forge,
    pseudo,
    // タスク間メッセージング（design.md §16.21）はこのウィンドウで新たに始める実行にだけ
    // 立てる（リロード直後の復元では作らない。再実行すればstartTask()相当の経路で
    // 改めてタスクが動き出すが、メッセージングはrunそのものに紐づく短命なサーバのため、
    // 復元だけでは作り直さない。`WorkflowRunnerDeps.messaging`が省略可能なのと同じ
    // 「無くても実行は止めない」設計に揃える）
    messaging: undefined,
    mergeResolutions: new Map(),
    // 統合PR/MRの結果・最終マージの成否はこのプロセスでまだ何も試みていない
    // （design.md §16.11。Viewは`getSnapshot`が読む永続化された値へフォールバックする）
    integrationPullRequest: undefined,
    finalMergeOutcome: undefined,
  };
}
