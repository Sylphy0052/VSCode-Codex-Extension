import {
  integrationBranchName,
  integrationWorktreePath,
  reconcileMergingTaskOnReload,
} from './integration';
import { resolvePseudoState } from './runnerWorkingDirectory';
import { sanitizeForLog } from './sanitize';
import { startMerge } from './runnerMerge';
import { setupOrchestratorForStart } from './runnerOrchestrator';
import {
  applyAutoResume,
  initialTaskRunState,
  markMergeBlocked,
  type RunState,
  type TaskRunState,
} from './runState';
import type { PersistedRun } from './runStore';
import { getRunOutcome } from './scheduler';
import { isGitWorkingTree, resolveHeadCommit } from './worktree';
import {
  MAX_WORKFLOW_FILE_BYTES,
  parseWorkflowYaml,
  validateWorkflow,
  type WorkflowDefinition,
} from './workflow';
import {
  resolveBranchNamingAndDraft,
  type LiveRun,
  type LiveRunForgeState,
  type WorkflowWarning,
} from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';

/**
 * ウィンドウのリロード後の実行再開（design.md §16.11、Issue #147）を集めたモジュール。
 * `WorkflowRunner`から機能単位で切り出した1本。
 *
 * `self: WorkflowRunnerInternals`を第一引数に取るのは、`WorkflowRunner`のメソッドから機械的に
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
export async function restoreRunsForView(self: WorkflowRunnerInternals): Promise<void> {
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
    // 自動再開（design.md §16.35、roadmap W10、Issue #584）。`reloadInterrupted`で
    // `failed`になったタスクを`pending`へ戻し、オーケストレーターセッションも立て直す。
    // マージのやり直し（下の`merging`分岐）とは無関係な経路のため、`await`せず並行に
    // 走らせる（`restoreRunsForView`の完了をここでも引き延ばさない。上のマージ再開と
    // 同じ方針）
    void autoResumeIfEligible(self, p, rebuilt).catch((e: unknown) => {
      self.deps.log.error(
        `[workflow ${p.runId}] 自動再開に失敗しました: ${sanitizeForLog(
          e instanceof Error ? e.message : String(e),
        )}`,
      );
    });
    // `rebuildLiveRun`が統合ブランチの実際の状態から判定し直してもなお`merging`のまま
    // 残ったタスクは、マージが実行途中で切れていたと分かっているもの。ライブなセッションは
    // 無い（リロードで失われた）ため、永続化された`branch`/`cwd`だけを頼りにマージを
    // やり直す（design.md §16.11「`merging`からやり直す」）
    const merging = [...rebuilt.runState.tasks]
      .filter(([, s]) => s.state === 'merging')
      .map(([taskId]) => taskId);
    if (merging.length > 0) {
      // 複数件を一斉に投げない（Issue #412の指摘3）。1件目が衝突すると衝突解決セッションが
      // 立ち、統合worktreeは未解決のまま長く占有される。2件目以降は`startMerge`が取る
      // 占有（`IntegrationMergeQueue.acquireLease`）で順番待ちになるが、ここでも直列に
      // 呼び出して「復元時のやり直しは1件ずつ」という意図をコードの形でも残す。
      // `restoreRunsForView`自体は待たない（衝突解決は数分〜数十分かかりうるため、
      // 復元の完了をそこまで引き延ばさない）
      // rejectを回収する（Issue #412のレビュー指摘7）。`void`のままだと、1件目が投げた
      // 時点でunhandled rejectionになり、2件目以降の復元も走らなくなる
      const runId = p.runId;
      void resumeMergesSequentially(self, runId, merging).catch((e: unknown) => {
        self.deps.log.error(
          `[workflow ${runId}] リロード後のマージのやり直しに失敗しました: ${sanitizeForLog(
            e instanceof Error ? e.message : String(e),
          )}`,
        );
      });
    }
  }
}

/**
 * 復元後にやり直すマージを1件ずつ順番に走らせる（Issue #412）。`startMerge`は衝突した
 * 場合でも「衝突解決セッションを開いたところ」で解決するため、この直列化はマージの
 * git操作までの部分に効く。解決セッションが握り続ける占有は`acquireLease`側が守る。
 */
async function resumeMergesSequentially(
  self: WorkflowRunnerInternals,
  runId: string,
  taskIds: readonly string[],
): Promise<void> {
  for (const taskId of taskIds) {
    // 1件が投げても残りのやり直しは続ける（Issue #412のレビュー指摘7）。ここで抜けると、
    // 直列化したぶんだけ「1件目の失敗で2件目以降が永久に`merging`のまま」になる
    try {
      await resumeMergeAfterReload(self, runId, taskId);
    } catch (e) {
      self.deps.log.error(
        `[workflow ${runId}/${taskId}] リロード後のマージのやり直しに失敗しました: ${sanitizeForLog(
          e instanceof Error ? e.message : String(e),
        )}`,
      );
    }
  }
}

/**
 * リロード直後、まだ`merging`のまま残ったタスクのマージをやり直す
 * （design.md §16.11。`restoreRunsForView`から呼ぶ）。ライブなセッション
 * （`LiveTask`）は無いため、永続化された`branch`/`cwd`を直接使う。どちらか欠けている
 * （古い永続化形式・作成前に中断した等）場合は再開できないため、安全側で`blocked`にする。
 */
async function resumeMergeAfterReload(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
): Promise<void> {
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
  await startMerge(self, runId, taskId, task, cwd, branch, '');
}

/**
 * `rebuildLiveRun`の前半（design.md §16.11の受入基準）。定義ファイルの読み込み・解析・
 * 検証を行う。`start()`と同じ上限チェックをここでも通す（レビュー指摘: medium 2）。
 * `MAX_WORKFLOW_FILE_BYTES`のコメントどおり「巨大なYAMLで拡張機能ホスト（シングルスレッド）
 * を固まらせない」ための防御であり、復元経路だけ素通りさせない。
 */
async function loadPersistedWorkflowDefinition(
  self: WorkflowRunnerInternals,
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
 *
 * 以前はここで定義ファイルから該当タスクの`type`を引き、`reconcileMergingTaskOnReload`へ
 * 渡していた（マージ時に使った`type`と揃っていないと`--grep`の完全一致に失敗するため）。
 * `type`は`PersistedTaskState`に永続化されておらず定義ファイルの再パース結果に頼るしか
 * なかったため、「runの実行中にワークフローYAMLの`type:`を書き換えてからリロードする」
 * 経路で不一致が起き、マージ済みタスクを誤って`merging`（やり直し対象）と判定して二重
 * マージが走る事故になっていた。`reconcileMergingTaskOnReload`側が`type`を問わず
 * （`COMMIT_TYPES`のいずれでも）マージコミットを認識するよう改めたため、この関数は
 * `type`の配線には`def`を必要としない。
 *
 * **ただし`def`自体は別の理由で改めて必要になった（design.md §16.29「リロード時の
 * 突き合わせ」、レビューblocking指摘、2026-08-23）。** オーケストレーターの`add_task`/
 * `remove_task`（§16.29）は`live.def`と`live.runState`だけを書き換えYAMLファイルは
 * 書き換えないが、`live.runState`はこの2ツール自身がpersistしなくても、その後に
 * 走る**別の経路**（他タスクの完了・`pump`など、`self.persist`を呼ぶ十数箇所）が
 * `live.runState.tasks`を丸ごと永続化した瞬間に一緒に書き出されてしまう。結果、
 * 永続データと定義ファイルが指すタスク集合がずれうる:
 *
 * - `add_task`で加えたタスクは、YAMLには無いのに永続データにだけ残る
 * - `remove_task`で消したタスクは、YAMLにはあるのに永続データから消えている
 *
 * 前者を無視すると、定義に無いタスクの状態（`pending`は`reconcileRunOnReload`で
 * `skipped`へ倒された後）がいつまでも`run.tasks`に居座り、`getRunOutcome`
 * （`scheduler.ts`）がそれを理由に`succeeded`になるはずのrunを`aborted`と誤判定する。
 * 後者を無視すると、消したはずのタスクが定義には残っているのに永続データには一度も
 * 現れないため、`getRunOutcome`がそのタスクの存在自体に気づけず、一度も走っていない
 * タスクがあるのにrunが完走扱いになりうる。
 *
 * これは人がrunの途中でYAMLを直接編集してからリロードしたときにも起こりうる、
 * 元からあった穴でもある（`add_task`/`remove_task`が新たに踏みやすくしただけ）。
 * 直す場所は1箇所（ここ）で足りる。突き合わせで何かを落とす・補う操作が実際に
 * 起きたときだけ`reloadTaskDefMismatch`警告を返す（`rebuildLiveRun`が`live.warnings`へ積む）。
 */
async function reconcileRestoredTaskStates(
  self: WorkflowRunnerInternals,
  p: PersistedRun,
  integration: { cwd: string; branch: string } | undefined,
  def: WorkflowDefinition,
): Promise<{ tasks: Map<string, TaskRunState>; warnings: WorkflowWarning[] }> {
  const defIds = new Set(def.tasks.map((t) => t.id));
  const tasks = new Map<string, TaskRunState>();
  const droppedIds: string[] = [];
  for (const [id, t] of Object.entries(p.tasks)) {
    if (!defIds.has(id)) {
      // 定義に無いタスク（`add_task`で加えたがYAMLには無い）。復元しない
      droppedIds.push(id);
      continue;
    }
    let state = t.state;
    let failure = t.failure;
    if (state === 'merging') {
      // gitRepoでない（統合worktreeが無い）実行で`merging`が残っているのは想定外の状態
      // のため、安全側で`blocked`にする
      if (integration === undefined) {
        state = 'blocked';
      } else {
        const outcome = await reconcileMergingTaskOnReload(
          integration.cwd,
          p.runId,
          id,
          self.deps.git,
        );
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
      // このフィールドが無い古い永続データは0として扱う（issue #275より前の形式）
      manualRetryCount: t.manualRetryCount ?? 0,
      failure,
      sessionId: t.sessionId,
      cwd: t.cwd,
    });
  }

  // 定義にはあるが永続データに無いタスク（`remove_task`で消したがYAMLには残っている）を
  // `pending`として補う。黙って欠けたままにすると`getRunOutcome`がそのタスクの存在に
  // 気づけず、一度も走っていないタスクがあるのにrunが完走扱いになりうる
  const addedIds: string[] = [];
  for (const task of def.tasks) {
    if (!tasks.has(task.id)) {
      tasks.set(task.id, initialTaskRunState);
      addedIds.push(task.id);
    }
  }

  const warnings: WorkflowWarning[] = [];
  if (droppedIds.length > 0 || addedIds.length > 0) {
    const parts: string[] = [];
    if (droppedIds.length > 0) {
      parts.push(
        `定義（YAML）に無いため復元しなかったタスク: ${droppedIds.join(', ')}` +
          '（オーケストレーターがadd_taskで加えていた可能性があります）',
      );
    }
    if (addedIds.length > 0) {
      parts.push(
        `永続データに無かったため未着手として補ったタスク: ${addedIds.join(', ')}` +
          '（オーケストレーターがremove_taskで消していた可能性があります）',
      );
    }
    warnings.push({
      kind: 'reloadTaskDefMismatch',
      taskId: undefined,
      message:
        'リロード時、実行中に加減されたタスクを定義（YAML）本来の内容へ合わせました。' +
        parts.join(' / '),
    });
  }

  return { tasks, warnings };
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
  self: WorkflowRunnerInternals,
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

async function rebuildLiveRun(
  self: WorkflowRunnerInternals,
  p: PersistedRun,
): Promise<LiveRun | undefined> {
  const def = await loadPersistedWorkflowDefinition(self, p);
  if (def === undefined) {
    return undefined;
  }

  const gitRepo = await isGitWorkingTree(p.workspaceRoot, self.deps.git);
  // 元のHEADは永続化していない（design.md §16.11は応答本文以外も最小限しか保存しない
  // 方針）ため、復元した時点のHEADを分岐元にする。再実行は元々「新しいスレッド・
  // worktreeでやり直す」設計（design.md §16.5）なので、この差異は再実行の意味を壊さない
  const headCommit = gitRepo
    ? ((await resolveHeadCommit(p.workspaceRoot, self.deps.git)) ?? '')
    : '';

  // 統合ブランチ・統合worktree（design.md §16.17）。gitRepoでない実行には統合の概念が
  // 無い。永続化された`integrationBranch`（古い形式や空文字なら決定的に導ける値）を使う
  const integrationBranch =
    p.integrationBranch !== '' ? p.integrationBranch : integrationBranchName(p.runId);
  const integration = gitRepo
    ? { cwd: integrationWorktreePath(p.workspaceRoot, p.runId), branch: integrationBranch }
    : undefined;

  const { tasks, warnings: reconcileWarnings } = await reconcileRestoredTaskStates(
    self,
    p,
    integration,
    def,
  );
  const runState: RunState = { tasks, haltedByUser: p.haltedByUser };
  const forge: LiveRunForgeState = gitRepo
    ? await self.resolveForgeState(p.workspaceRoot)
    : { kind: 'disabled' };
  const { branchNaming, draftPullRequest } = resolveBranchNamingAndDraft(self.deps);
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
    // `finished`とは違い、常に`false`から始める（Issue #432-2）。復元直後に`finished`が
    // `true`になるのは「前のプロセスで終了ブロックが実行済み」だからとは限らない。
    // 中断されていたタスクがここでの再構成（`reconcileRestoredTaskStates`）によって
    // `failed`へ倒れ、その結果`getRunOutcome`が初めて`running`以外を返すようになる
    // ケースがあり（クラッシュ・強制終了で走行中に終わった場合）、この場合は終了ブロックは
    // このプロセスではまだ一度も走っていない。`finishedNotified`を`true`で始めると、
    // その後`retryTask`等で再開して初めて迎える終了で`reflectPseudoWorktree`等が
    // 誤って抑止される。`false`から始めても安全なのは、`pump()`が`live.finished`を
    // 見て早期returnするため、既に終了済みの run はこのプロセスで再開されない限り
    // 終了ブロックへ再入しないから
    finishedNotified: false,
    warnings: reconcileWarnings,
    integration,
    forge,
    branchNaming,
    draftPullRequest,
    pseudo,
    // タスク間メッセージング（design.md §16.21）はこのウィンドウで新たに始める実行にだけ
    // 立てる（リロード直後の復元では作らない。再実行すればstartTask()相当の経路で
    // 改めてタスクが動き出すが、メッセージングはrunそのものに紐づく短命なサーバのため、
    // 復元だけでは作り直さない。`WorkflowRunnerDeps.messaging`が省略可能なのと同じ
    // 「無くても実行は止めない」設計に揃える）
    //
    // 実害が出るのは復元そのものではなく、そのあと`retryTask`等で再開したとき
    // （Issue #475）。`ensureMessaging`（`prepareTaskLaunch`の単一チョークポイント）が
    // このプロセスで初めてhubを作る。復元はプロセスをまたぐため再利用できるhubが
    // そもそも無く、`messagingHub`も`undefined`から始める
    messaging: undefined,
    messagingHub: undefined,
    messagingSetupInFlight: undefined,
    messagingStartupWarnCount: 0,
    // レビューコメントのポーリング（design.md §16.30）もmessagingと同じくこのプロセスで
    // 新たに始める実行にだけ立てる（復元では作らない。`finalizeForge`が統合PR/MR作成後に
    // 改めて開始する）
    reviewCommentPoll: undefined,
    mergeResolutions: new Map(),
    createdTaskIssues: new Map(),
    // 復元した実行にはオーケストレーターセッションを作り直さない（会話は復元できない。
    // design.md §16.23「永続化と復元」）
    orchestrator: undefined,
    orchestratorSeenStates: new Map(),
    // 統合PR/MRの結果・最終マージの成否はこのプロセスでまだ何も試みていない
    // （design.md §16.11。Viewは`getSnapshot`が読む永続化された値へフォールバックする）
    integrationPullRequest: undefined,
    finalMergeOutcome: undefined,
    // 最終マージの判断待ち（design.md §16.26）も会話・警告と同じく実行時専用の状態で、
    // このプロセスでは復元しない（`LiveRun.finalMergeDecision`のJSDoc参照）
    finalMergeDecision: undefined,
    // `ask_user`の回答待ち（design.md §16.33）も、答えを届ける先（オーケストレーター
    // セッション）自体が復元できないため実行時は復元しない。永続化された問いの文言は
    // `PersistedRun.pendingAskUser`に残り、`getSnapshot`が読む（`LiveRun.pendingAskUser`の
    // JSDoc参照）
    pendingAskUser: undefined,
  };
}

/** `agent.workflows.autoResume`の既定値（design.md §16.35、roadmap W10、Issue #584）。 */
export const DEFAULT_AUTO_RESUME = true;
/** `agent.workflows.maxAutoResumeAttempts`の既定値。 */
export const DEFAULT_MAX_AUTO_RESUME_ATTEMPTS = 3;
export const MIN_MAX_AUTO_RESUME_ATTEMPTS = 1;
export const MAX_MAX_AUTO_RESUME_ATTEMPTS = 20;

/**
 * リロード・WSL再起動等からの復元直後、条件を満たせば自動的に再開する
 * （design.md §16.35、roadmap W10、Issue #584）。`restoreRunsForView`から、`self.runs`へ
 * 登録した直後に呼ぶ。
 *
 * 条件（design.mdの受入基準）:
 * 1. `agent.workflows.autoResume`が`false`でない
 * 2. `haltedByUser`（人が「全体停止」で止めた）でない——人が意図して止めたrunを
 *    黙って再開すると、その場に残っている理由（レビュー中・調査中等）を壊す
 * 3. 再開できる状態がある（`applyAutoResume`。他の理由の`failed`が混ざっていれば
 *    見送り、`allow`確認が要るタスクが混ざっていれば見送り——人が居ないその場で
 *    確認を代行できないため）
 * 4. `agent.workflows.maxAutoResumeAttempts`（既定3）に達していない——同じrunが
 *    クラッシュと自動再開を繰り返し続けるのを止める
 *
 * 4つとも満たしたときだけ、`applyAutoResume`が戻した`RunState`を適用し、
 * オーケストレーターセッションを`start()`と同じ手順（`ensureMessaging` →
 * `setupOrchestratorForStart`）で立て直し、`pump()`でスケジューリングを起こす。
 *
 * 条件3（`blockedByOtherFailure`/`blockedByAllowGate`）・条件4（上限超過）のどちらで
 * 見送った場合も`autoResumeBlocked`/`autoResumeLimitExceeded`警告をrunへ積む。
 * どちらも「自動では再開されなかった」という、Viewの既存のfailed/skipped表示だけでは
 * 区別できない事実そのものであり、受入基準「回数上限を超えたら理由が見える」を、
 * 上限超過以外の見送り理由にもそろえた（レビュー指摘。2026-08-23。当初は条件2・3を
 * 完全に無警告としていたが、上限超過だけ理由が見えて他は見えないのは非対称という
 * 指摘を受け改めた）。条件2（`haltedByUser`）だけは引き続き無警告のまま——人が
 * 意図して止めたrunであり、`applyAutoResume`を呼ぶ前に確定しているため「見送った」
 * という新情報が無い。
 */
async function autoResumeIfEligible(
  self: WorkflowRunnerInternals,
  p: PersistedRun,
  rebuilt: LiveRun,
): Promise<void> {
  const autoResume = self.deps.readAutoResume?.() ?? DEFAULT_AUTO_RESUME;
  if (!autoResume) {
    return;
  }
  if (rebuilt.runState.haltedByUser) {
    return;
  }
  const outcome = applyAutoResume(rebuilt.runState, rebuilt.def.tasks);
  if (outcome.kind === 'nothingToResume') {
    return;
  }
  if (outcome.kind !== 'resumed') {
    // `blockedByOtherFailure` / `blockedByAllowGate`。孤立した`pending`を作らないために
    // 見送ったが、「なぜ再開されなかったか」はrunから見えるようにする
    // （レビュー指摘。2026-08-23。上記JSDoc参照）
    const reason =
      outcome.kind === 'blockedByAllowGate'
        ? `再開確認（allow）が必要なタスクがあるため（${outcome.taskIds.join(', ')}）`
        : '他の理由で失敗したタスクが混ざっているため';
    rebuilt.warnings = rebuilt.warnings.filter((w) => w.kind !== 'autoResumeBlocked');
    rebuilt.warnings.push({
      kind: 'autoResumeBlocked',
      taskId: undefined,
      message: `中断からの自動再開を見送りました: ${reason}。Viewから手動で再実行してください。`,
    });
    self.notify(p.runId);
    return;
  }

  const maxAttempts = self.deps.readMaxAutoResumeAttempts?.() ?? DEFAULT_MAX_AUTO_RESUME_ATTEMPTS;
  const attemptsSoFar = p.autoResumeAttempts ?? 0;
  if (attemptsSoFar >= maxAttempts) {
    rebuilt.warnings = rebuilt.warnings.filter((w) => w.kind !== 'autoResumeLimitExceeded');
    rebuilt.warnings.push({
      kind: 'autoResumeLimitExceeded',
      taskId: undefined,
      message: `自動再開の上限（${maxAttempts}回）に達したため、これ以上は自動的に再開しません。Viewから手動で再実行してください。`,
    });
    self.notify(p.runId);
    return;
  }

  rebuilt.runState = outcome.run;
  rebuilt.finished = getRunOutcome(rebuilt.runState) !== 'running';
  rebuilt.warnings = rebuilt.warnings.filter((w) => w.kind !== 'autoResume');
  rebuilt.warnings.push({
    kind: 'autoResume',
    taskId: undefined,
    message: `中断からの自動再開により、次のタスクをpendingへ戻しました: ${outcome.resumedTaskIds.join(', ')}`,
  });
  // `current`が無い（このrunがどこかで消えた等）ことは通常起きないが、`update`の
  // updaterはPersistedRunを必ず返す必要があるため、その場合は`p`（このrunがまだ
  // 存在した時点の値）へ書き戻すことで型を満たしつつ実害の無い形にする
  await self.deps.store.update(p.runId, (current) => ({
    ...(current ?? p),
    autoResumeAttempts: attemptsSoFar + 1,
  }));

  await self.ensureMessaging(p.runId, rebuilt);
  // `exactOptionalPropertyTypes`のため、答え待ちが無ければキー自体を渡さない
  void setupOrchestratorForStart(
    self,
    p.runId,
    rebuilt,
    p.pendingAskUser === undefined ? {} : { pendingAskUser: p.pendingAskUser },
  );
  self.pump(p.runId);
}
