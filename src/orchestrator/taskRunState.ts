/**
 * オーケストレータモード（Issue #1505）のController側の状態。自由な指示をタスクへ分解し、
 * 各タスクを5つの工程（Issue計画 → Issue作成 → 実装とPR作成 → レビュー → mergeとcleanup）で
 * 進める。1工程＝1セッション系列で、工程ごとに実行回（attempt）を持つ。
 *
 * 状態の正本はこのファイルの型で表すControllerの状態だけとする。Orchestratorの会話履歴や
 * 工程セッションの自己申告は正本にしない。工程セッションからの報告は`checkStageReport`で
 * 現在の実行（`executionId`）・工程・実行回（`attemptId`）に一致するものだけを受け付け、
 * 自動引き継ぎ前の古いセッションから遅れて届いた報告で状態が変わらないようにする。
 *
 * ロードマップ実行（Issue #1465、`roadmapRunState.ts`）とは別の型にする。あちらはノードの
 * キーがIssue番号で1ノード＝1セッション系列を前提にしており、共通化すると#1465の退行
 * リスクが大きいため。遷移関数はすべて純粋関数で、変化が無ければ同じ参照を返す。
 * 永続化は`taskRunStore.ts`が担う。`workspaceState`は素の`JSON`を通るため`Record`で持ち、
 * キーは`taskId`（`T1`、`T2`…）だけに限る（`__proto__`等の危険なキーが入らない）。
 */

import { sanitizeInlineText } from './untrustedText';

/** 工程セッションの実行エンジン。runの開始時に1つ選び、全工程で共通にする。 */
export type TaskRunEngine = 'codex' | 'claude';

/** 並列上限として受け付ける最大値。 */
export const MAX_TASK_RUN_PARALLEL = 8;

/** runの表示名の上限（文字数）。 */
export const TASK_RUN_TITLE_MAX_LENGTH = 80;

/** 工程。この順に進む。 */
export const TASK_STAGES = [
  'issuePlan',
  'issueCreate',
  'implement',
  'review',
  'mergeCleanup',
] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/** 依存先のタスクが終わるまで始めない工程。コードに依存しない工程は依存に関係なく進める。 */
export const DEPENDENCY_GATED_STAGES: readonly TaskStage[] = ['implement'];

/**
 * 工程の状態: 未着手 / 実行中 / 止まっている / 終わった / 飛ばした。
 * 既存のIssue番号を指定したタスクは「Issue計画」「Issue作成」を飛ばす。
 */
export type StageStatus = 'notStarted' | 'running' | 'halted' | 'done' | 'skipped';

/**
 * タスクの注意: なし / ユーザー判断待ち / 要対応（報告が完了条件を満たさない、報告なしに
 * セッションが終わった） / 失敗 / 停止処理中 / 停止。
 */
export const TASK_ATTENTIONS = [
  'none',
  'awaitingUser',
  'needsAction',
  'failed',
  'stopping',
  'stopped',
] as const;
export type TaskAttention = (typeof TASK_ATTENTIONS)[number];

/** 実行回の種類。最初の実行、自動引き継ぎで替わったセッション、やり直しを別の実行回にする。 */
export type StageAttemptKind = 'initial' | 'handoff' | 'retry';

/** 工程を始める前にOrchestratorが決めた設定。判断の記録としてKanbanから見られるように残す。 */
export interface StageDecision {
  model: string;
  effort: string;
  /** Orchestratorが選んだ理由。外部由来（LLMの出力）のテキスト。 */
  reason: string;
  /** 工程への追加の指示。外部由来（LLMの出力）のテキスト。 */
  instruction: string | undefined;
  /** Controllerが示した推奨値。求めていなければ`undefined`。 */
  recommended: { model: string; effort: string } | undefined;
  /** ISO8601。 */
  decidedAt: string;
}

export interface StageAttempt {
  attemptId: string;
  kind: StageAttemptKind;
  /** ISO8601。 */
  startedAt: string;
  /** ISO8601。現在の実行回なら`undefined`。 */
  endedAt: string | undefined;
  /** この実行回を担うセッションタブの識別子。まだ開いていなければ`undefined`。 */
  sessionRef: string | undefined;
  /** この実行回で使った設定。自動引き継ぎの実行回は前の実行回の設定を引き継ぐ。 */
  decision: StageDecision;
}

export interface TaskStageRecord {
  status: StageStatus;
  attempts: readonly StageAttempt[];
  /**
   * Controllerが受け付け、並列枠（mergeとcleanupはmergeの鍵も）の空きを待っている設定。
   * 工程を始めると実行回へ移して`undefined`に戻す。
   */
  pendingDecision: StageDecision | undefined;
  /** ISO8601。終わっていなければ`undefined`。 */
  completedAt: string | undefined;
}

/** レビュー工程の結果。 */
export interface StageReviewResult {
  /** 外部由来（LLMの出力）のテキスト。 */
  summary: string;
  /** 直さずに残した指摘。外部由来のテキスト。 */
  remainingFindings: readonly string[];
  /** high・mediumの指摘を残さずに終わった。 */
  passed: boolean;
}

/** 1つのタスク。runの中でタスク1件につき1つだけ作る。 */
export interface OrchestratedTask {
  taskId: string;
  /** 外部由来（LLMの出力）のテキスト。表示やプロンプトへ入れるときは`formatUntrusted`等を通す。 */
  title: string;
  /** 目的の要約。外部由来のテキスト。 */
  summary: string;
  /** 受入基準の案。外部由来のテキスト。 */
  acceptanceCriteria: readonly string[];
  /** 依存するタスクの`taskId`。「実装とPR作成」だけに効く。 */
  dependsOn: readonly string[];
  /** 計画の時点で指定された既存のIssue番号。 */
  existingIssueNumber: number | undefined;
  executionId: string;
  stages: Record<TaskStage, TaskStageRecord>;
  /** 報告を受け付ける実行回。実行中のセッションが無ければ`undefined`（どの報告も受け付けない）。 */
  currentAttemptId: string | undefined;
  attention: TaskAttention;
  /** `attention`が`needsAction`・`failed`のときの理由。 */
  failure: string | undefined;
  /** 「Issue計画」の成果。外部由来のテキスト。 */
  issueDraft: { title: string; body: string } | undefined;
  /** 「Issue作成」の成果、または既存のIssue番号。 */
  issueNumber: number | undefined;
  worktreePath: string | undefined;
  branch: string | undefined;
  pullRequest: { number: number; url: string } | undefined;
  review: StageReviewResult | undefined;
  /**
   * 工程セッションが`ask_orchestrator`で尋ねた質問（新しい順ではなく受け付けた順）。
   * 追加前に保存したrunには無い。操作は`taskRunQuestions.ts`。
   */
  questions?: readonly StageQuestion[];
  /**
   * 工程の失敗とレビュー後の残った指摘で開いた判断の関門（開いた順）。追加前に保存したrunには
   * 無い。操作は`taskRunGates.ts`。
   */
  gates?: readonly StageGate[];
  /** レビュー後に実装へ差し戻した回数。追加前に保存したrunには無い（0回として扱う）。 */
  reviewRounds?: number;
  /** ISO8601。 */
  updatedAt: string;
}

/** 関門の種類: レビューで直さずに残した指摘がある / 工程が失敗・要対応で止まった。 */
export type StageGateKind = 'reviewFindings' | 'stageFailed';

/** 関門の決着: 実装へ差し戻す / 指摘を残したまま進める / 同じ工程をやり直す。 */
export type StageGateChoice = 'sendBack' | 'proceed' | 'retry';

/** 関門の状態。`judging`はReflexの判定中、`awaitingUser`はユーザーの判断待ち。 */
export type StageGateStatus = 'judging' | 'awaitingUser' | 'resolved';

export interface StageGate {
  gateId: string;
  kind: StageGateKind;
  /** 関門を開いた工程（`reviewFindings`なら`review`、`stageFailed`なら止まった工程）。 */
  stage: TaskStage;
  status: StageGateStatus;
  /** 残った指摘の一覧、または止まった理由。外部由来のテキストを含む。 */
  detail: string;
  /** Reflexの判定の要約（人へ回した理由を含む）。 */
  reflexSummary: string | undefined;
  resolution: { choice: StageGateChoice; by: 'reflex' | 'user'; at: string } | undefined;
  /** ISO8601。 */
  openedAt: string;
}

/**
 * 質問の状態。`judging`はReflexの判定中、`awaitingUser`はユーザーの判断待ち。
 * 回答済み・取り消し済みは変えない。
 */
export type StageQuestionStatus =
  | 'judging'
  | 'awaitingUser'
  | 'answeredByReflex'
  | 'answeredByUser'
  | 'cancelled';

export interface StageQuestion {
  questionId: string;
  stage: TaskStage;
  attemptId: string;
  question: string;
  reason: string;
  options: readonly string[];
  recommended: string | undefined;
  blocking: boolean;
  evidence: string | undefined;
  status: StageQuestionStatus;
  /** Reflexの判定の要約（人へ回した理由を含む）。 */
  reflexSummary: string | undefined;
  answer: string | undefined;
  /** ISO8601。 */
  askedAt: string;
  answeredAt: string | undefined;
}

/** 計画の状態: Orchestratorが作成中 / ユーザーの承認待ち / 承認済み。 */
export type TaskPlanStatus = 'drafting' | 'awaitingApproval' | 'approved';

export const TASK_RUN_SCHEMA_VERSION = 1;

/** Controllerの実行（run）。1ワークスペースにつき実行中は1つ。 */
export interface TaskRun {
  schemaVersion: typeof TASK_RUN_SCHEMA_VERSION;
  runId: string;
  /** ワークスペースフォルダの絶対パス。mergeの鍵のキーにもする。 */
  workspaceRoot: string;
  engine: TaskRunEngine;
  maxParallel: number;
  /** ISO8601。 */
  startedAt: string;
  /** 実行中は`undefined`。 */
  finishedAt: string | undefined;
  /**
   * 人がrunを中断した時刻（ISO8601、Issue #1560）。中断中は動いているrunとして数えず、同じフォルダで
   * 新しいrunを始められる。再開すると外す。項目の無い保存データは中断していないと読む。
   */
  suspendedAt?: string;
  /**
   * 人が付けた表示名（Issue #1561）。1行へ均して保存する。無ければ開始時刻とエンジンで表示する。
   * 項目の無い保存データは名前なしと読む。
   */
  title?: string;
  planStatus: TaskPlanStatus;
  /** 着手順（計画の並び）の`taskId`。 */
  taskOrder: readonly string[];
  /** キーは`taskId`。 */
  tasks: Record<string, OrchestratedTask>;
  /** 次に採番する`taskId`の番号。削除したタスクの番号を使い回さない。 */
  nextTaskNumber: number;
  /** 人がrun全体を止めた。真の間は新しい工程を始めない。 */
  haltedByUser: boolean;
  /** Orchestratorセッションを開いた回数。開くたびに+1する。 */
  orchestratorGeneration: number;
  /** 開いたOrchestratorセッションのsessionId（全世代）。リロード後の汎用復元から外す判定に使う。 */
  orchestratorSessionRefs: readonly string[];
}

/** 工程セッションからの報告に必ず付ける識別子。 */
export interface StageReportRef {
  taskId: string;
  executionId: string;
  stage: TaskStage;
  attemptId: string;
}

export type StageReportRejection =
  'unknownTask' | 'executionMismatch' | 'stageMismatch' | 'noActiveAttempt' | 'attemptMismatch';

const TASK_ID = /^T[1-9][0-9]{0,5}$/;

export function isValidTaskId(taskId: string): boolean {
  return TASK_ID.test(taskId);
}

export function isValidMaxParallel(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_TASK_RUN_PARALLEL;
}

function isValidIssueNumber(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

export interface CreateTaskRunInput {
  runId: string;
  workspaceRoot: string;
  engine: TaskRunEngine;
  maxParallel: number;
  /** 表示名。空なら付けない。 */
  title?: string;
  now: Date;
}

/** runの初期状態を作る。計画はOrchestratorが作るまで空。並列上限の範囲外は例外にする。 */
export function createTaskRun(input: CreateTaskRunInput): TaskRun {
  if (!isValidMaxParallel(input.maxParallel)) {
    throw new Error(`並列上限は1〜${MAX_TASK_RUN_PARALLEL}の整数: ${String(input.maxParallel)}`);
  }
  const title = normalizeTaskRunTitle(input.title);
  return {
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
    engine: input.engine,
    maxParallel: input.maxParallel,
    startedAt: input.now.toISOString(),
    finishedAt: undefined,
    ...(title === undefined ? {} : { title }),
    planStatus: 'drafting',
    taskOrder: [],
    tasks: {},
    nextTaskNumber: 1,
    haltedByUser: false,
    orchestratorGeneration: 0,
    orchestratorSessionRefs: [],
  };
}

export function getTask(run: TaskRun, taskId: string): OrchestratedTask | undefined {
  if (!isValidTaskId(taskId)) {
    return undefined;
  }
  return Object.hasOwn(run.tasks, taskId) ? run.tasks[taskId] : undefined;
}

/** 計画の並びでタスクを返す。 */
export function listTasks(run: TaskRun): OrchestratedTask[] {
  return run.taskOrder
    .map((taskId) => getTask(run, taskId))
    .filter((task): task is OrchestratedTask => task !== undefined);
}

/** いま進めている工程（終わっても飛ばしてもいない最初の工程）。すべて終わっていれば`undefined`。 */
export function currentStage(task: OrchestratedTask): TaskStage | undefined {
  return TASK_STAGES.find((stage) => {
    const status = task.stages[stage].status;
    return status !== 'done' && status !== 'skipped';
  });
}

/** mergeとcleanupまで終わった。依存先として満たされている。 */
export function isTaskDone(task: OrchestratedTask): boolean {
  return currentStage(task) === undefined;
}

function withTask(run: TaskRun, next: OrchestratedTask): TaskRun {
  if (!isValidTaskId(next.taskId)) {
    throw new Error(`不正なtaskId: ${next.taskId}`);
  }
  return { ...run, tasks: { ...run.tasks, [next.taskId]: next } };
}

function withStage(
  task: OrchestratedTask,
  stage: TaskStage,
  next: Partial<TaskStageRecord>,
): OrchestratedTask {
  return { ...task, stages: { ...task.stages, [stage]: { ...task.stages[stage], ...next } } };
}

/** 計画に載せるタスクの内容。`taskId`は`allocateTaskIds`で採番済みの前提。 */
export interface TaskDraft {
  taskId: string;
  title: string;
  summary: string;
  acceptanceCriteria: readonly string[];
  dependsOn: readonly string[];
  existingIssueNumber: number | undefined;
}

/**
 * 新しいタスクへ`taskId`を`count`個採番する。削除したタスクの番号は使い回さない
 * （古い報告やOrchestratorの記憶が別のタスクを指さないように）。
 */
export function allocateTaskIds(run: TaskRun, count: number): { run: TaskRun; taskIds: string[] } {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`不正な件数: ${String(count)}`);
  }
  const taskIds = Array.from({ length: count }, (_, i) => `T${String(run.nextTaskNumber + i)}`);
  return count === 0
    ? { run, taskIds }
    : { run: { ...run, nextTaskNumber: run.nextTaskNumber + count }, taskIds };
}

function emptyStage(status: StageStatus): TaskStageRecord {
  return { status, attempts: [], pendingDecision: undefined, completedAt: undefined };
}

function newTask(draft: TaskDraft, executionId: string, at: string): OrchestratedTask {
  const skipIssueStages = draft.existingIssueNumber !== undefined;
  const issueStage = skipIssueStages ? 'skipped' : 'notStarted';
  return {
    ...draft,
    executionId,
    stages: {
      issuePlan: emptyStage(issueStage),
      issueCreate: emptyStage(issueStage),
      implement: emptyStage('notStarted'),
      review: emptyStage('notStarted'),
      mergeCleanup: emptyStage('notStarted'),
    },
    currentAttemptId: undefined,
    attention: 'none',
    failure: undefined,
    issueDraft: undefined,
    issueNumber: draft.existingIssueNumber,
    worktreePath: undefined,
    branch: undefined,
    pullRequest: undefined,
    review: undefined,
    updatedAt: at,
  };
}

/**
 * 検証を通った計画を承認待ちとして置く。載っていない未着手のタスクは消し、既存のタスクは
 * 内容（タイトル、要約、受入基準、依存）だけを差し替える。着手済みのタスクを消す計画、
 * 不正な`taskId`・Issue番号・依存先は例外にする（形式、重複、循環の検証は呼び出し側が
 * 先に済ませる前提）。
 */
export function proposeTaskPlan(
  run: TaskRun,
  drafts: readonly TaskDraft[],
  newExecutionId: (taskId: string) => string,
  now: Date,
): TaskRun {
  const at = now.toISOString();
  const proposedIds = new Set(drafts.map((d) => d.taskId));
  for (const draft of drafts) {
    if (!isValidTaskId(draft.taskId)) {
      throw new Error(`不正なtaskId: ${draft.taskId}`);
    }
    if (draft.existingIssueNumber !== undefined && !isValidIssueNumber(draft.existingIssueNumber)) {
      throw new Error(`不正なIssue番号: ${String(draft.existingIssueNumber)}`);
    }
    const unknown = draft.dependsOn.find((dep) => !proposedIds.has(dep));
    if (unknown !== undefined) {
      throw new Error(`存在しない依存先: ${draft.taskId} → ${unknown}`);
    }
  }
  if (proposedIds.size !== drafts.length) {
    throw new Error('taskIdが重複しています');
  }
  const removedStarted = listTasks(run).find(
    (task) => !proposedIds.has(task.taskId) && hasStarted(task),
  );
  if (removedStarted !== undefined) {
    throw new Error(`着手済みのタスクは削除できません: ${removedStarted.taskId}`);
  }
  const relinkedStarted = drafts.find((draft) => {
    const existing = getTask(run, draft.taskId);
    return (
      existing !== undefined &&
      hasStarted(existing) &&
      existing.existingIssueNumber !== draft.existingIssueNumber
    );
  });
  if (relinkedStarted !== undefined) {
    throw new Error(`着手済みのタスクの既存Issueは変えられません: ${relinkedStarted.taskId}`);
  }
  const tasks: Record<string, OrchestratedTask> = {};
  for (const draft of drafts) {
    const existing = getTask(run, draft.taskId);
    // 未着手のタスクで既存Issueが変わったら、Issue工程を飛ばすかどうかから作り直す
    tasks[draft.taskId] =
      existing === undefined
        ? newTask(draft, newExecutionId(draft.taskId), at)
        : existing.existingIssueNumber !== draft.existingIssueNumber
          ? newTask(draft, existing.executionId, at)
          : {
              ...existing,
              title: draft.title,
              summary: draft.summary,
              acceptanceCriteria: draft.acceptanceCriteria,
              dependsOn: draft.dependsOn,
              updatedAt: at,
            };
  }
  return {
    ...run,
    planStatus: 'awaitingApproval',
    taskOrder: drafts.map((d) => d.taskId),
    tasks,
  };
}

/** 工程を1つでも始めた（飛ばした工程は数えない）。 */
export function hasStarted(task: OrchestratedTask): boolean {
  return TASK_STAGES.some((stage) => {
    const status = task.stages[stage].status;
    return status !== 'notStarted' && status !== 'skipped';
  });
}

/** 承認待ちの計画を承認する。承認待ちでなければそのまま返す。 */
export function approveTaskPlan(run: TaskRun): TaskRun {
  return run.planStatus === 'awaitingApproval' ? { ...run, planStatus: 'approved' } : run;
}

/**
 * 工程セッションからの報告を受け付けてよいかを判定する。現在の実行・工程・実行回に一致する
 * ものだけを受け付ける。
 */
export function checkStageReport(
  run: TaskRun,
  ref: StageReportRef,
): { ok: true; task: OrchestratedTask } | { ok: false; reason: StageReportRejection } {
  const task = getTask(run, ref.taskId);
  if (task === undefined) {
    return { ok: false, reason: 'unknownTask' };
  }
  if (task.executionId !== ref.executionId) {
    return { ok: false, reason: 'executionMismatch' };
  }
  if (currentStage(task) !== ref.stage || task.stages[ref.stage].status !== 'running') {
    return { ok: false, reason: 'stageMismatch' };
  }
  if (task.currentAttemptId === undefined) {
    return { ok: false, reason: 'noActiveAttempt' };
  }
  if (task.currentAttemptId !== ref.attemptId) {
    return { ok: false, reason: 'attemptMismatch' };
  }
  return { ok: true, task };
}

/** 現在の実行回を閉じる。実行回が無ければそのまま返す。 */
function endCurrentAttempt(task: OrchestratedTask, at: string): OrchestratedTask {
  const id = task.currentAttemptId;
  if (id === undefined) {
    return task;
  }
  const next: OrchestratedTask = { ...task, currentAttemptId: undefined };
  const stage = TASK_STAGES.find((s) => task.stages[s].attempts.some((a) => a.attemptId === id));
  if (stage === undefined) {
    return next;
  }
  return withStage(next, stage, {
    attempts: task.stages[stage].attempts.map((a) =>
      a.attemptId === id && a.endedAt === undefined ? { ...a, endedAt: at } : a,
    ),
  });
}

/**
 * Orchestratorが決めた設定を、現在の工程の待ちとして受け付ける。始められるかどうかの検証
 * （`decideStageStart`）は呼び出し側が先に済ませる前提で、現在の工程でない・未着手でない
 * 工程にはそのまま返す。
 */
export function recordStageDecision(
  run: TaskRun,
  taskId: string,
  stage: TaskStage,
  decision: StageDecision,
  now: Date,
): TaskRun {
  const task = getTask(run, taskId);
  if (task === undefined || currentStage(task) !== stage) {
    return run;
  }
  if (task.stages[stage].status !== 'notStarted') {
    return run;
  }
  return withTask(run, {
    ...withStage(task, stage, { pendingDecision: decision }),
    updatedAt: now.toISOString(),
  });
}

/**
 * 現在の工程の新しい実行回を始める。前の実行回は閉じ、以後は新しい`attemptId`の報告だけを
 * 受け付ける。`initial`・`retry`は待っていた設定（`pendingDecision`）を使い、無ければ
 * 何もしない。`handoff`は実行中の工程で、直前の実行回の設定を引き継ぐ。
 */
export function startStageAttempt(
  run: TaskRun,
  taskId: string,
  stage: TaskStage,
  attempt: { attemptId: string; kind: StageAttemptKind; sessionRef: string | undefined },
  now: Date,
): TaskRun {
  const task = getTask(run, taskId);
  if (task === undefined || currentStage(task) !== stage) {
    return run;
  }
  const record = task.stages[stage];
  const decision =
    attempt.kind === 'handoff'
      ? record.status === 'running'
        ? record.attempts.at(-1)?.decision
        : undefined
      : record.status === 'notStarted'
        ? record.pendingDecision
        : undefined;
  if (decision === undefined) {
    return run;
  }
  const at = now.toISOString();
  const closed = endCurrentAttempt(task, at);
  return withTask(run, {
    ...withStage(closed, stage, {
      status: 'running',
      pendingDecision: undefined,
      attempts: [
        ...closed.stages[stage].attempts,
        {
          attemptId: attempt.attemptId,
          kind: attempt.kind,
          startedAt: at,
          endedAt: undefined,
          sessionRef: attempt.sessionRef,
          decision,
        },
      ],
    }),
    currentAttemptId: attempt.attemptId,
    attention: 'none',
    failure: undefined,
    updatedAt: at,
  });
}

/** 実行回を担うセッションタブを記録する（セッションを開いた後に分かる場合）。 */
export function recordAttemptSession(
  run: TaskRun,
  ref: StageReportRef,
  sessionRef: string,
  now: Date,
): TaskRun {
  const checked = checkStageReport(run, ref);
  if (!checked.ok) {
    return run;
  }
  const { task } = checked;
  const attempt = task.stages[ref.stage].attempts.find((a) => a.attemptId === ref.attemptId);
  if (attempt === undefined || attempt.sessionRef === sessionRef) {
    return run;
  }
  return withTask(run, {
    ...withStage(task, ref.stage, {
      attempts: task.stages[ref.stage].attempts.map((a) =>
        a.attemptId === ref.attemptId ? { ...a, sessionRef } : a,
      ),
    }),
    updatedAt: now.toISOString(),
  });
}

/** 工程が残す成果。工程ごとに持つ値が違う。 */
export type StageOutput =
  | { stage: 'issuePlan'; issueDraft: { title: string; body: string } }
  | { stage: 'issueCreate'; issueNumber: number }
  | { stage: 'implement'; pullRequest: { number: number; url: string } }
  | { stage: 'review'; review: StageReviewResult }
  | { stage: 'mergeCleanup' };

/**
 * 工程の完了を確定する。報告の受付（`checkStageReport`）と、Controllerが観測した事実による
 * 完了条件の確認（forgeのIssue・PR、ブランチ）は呼び出し側が先に済ませる前提。
 * mergeとcleanupが終わるとタスクは終わる。
 */
export function completeStage(
  run: TaskRun,
  ref: StageReportRef,
  output: StageOutput,
  now: Date,
): TaskRun {
  const checked = checkStageReport(run, ref);
  if (!checked.ok || output.stage !== ref.stage) {
    return run;
  }
  if (output.stage === 'issueCreate' && !isValidIssueNumber(output.issueNumber)) {
    return run;
  }
  const at = now.toISOString();
  const closed = withStage(endCurrentAttempt(checked.task, at), ref.stage, {
    status: 'done',
    completedAt: at,
  });
  const withOutput: OrchestratedTask =
    output.stage === 'issuePlan'
      ? { ...closed, issueDraft: output.issueDraft }
      : output.stage === 'issueCreate'
        ? { ...closed, issueNumber: output.issueNumber }
        : output.stage === 'implement'
          ? { ...closed, pullRequest: output.pullRequest }
          : output.stage === 'review'
            ? { ...closed, review: output.review }
            : closed;
  return withTask(run, { ...withOutput, attention: 'none', failure: undefined, updatedAt: at });
}

/** 「実装とPR作成」の開始時に作ったworktreeとブランチを記録する。 */
export function recordTaskWorktree(
  run: TaskRun,
  taskId: string,
  worktree: { worktreePath: string; branch: string },
  now: Date,
): TaskRun {
  const task = getTask(run, taskId);
  if (task === undefined) {
    return run;
  }
  if (task.worktreePath === worktree.worktreePath && task.branch === worktree.branch) {
    return run;
  }
  return withTask(run, { ...task, ...worktree, updatedAt: now.toISOString() });
}

/**
 * 現在の工程を止めた状態にする。実行回（あれば）を閉じ、待っていた設定を捨て、工程を
 * `halted`にして理由を残す。
 * - `needsAction`: 報告が完了条件を満たさない、または報告なしにセッションが終わった
 * - `failed`: 工程の実行に失敗した（セッションを開けなかった等）
 * - `stopped`: 人が止めた（worktreeとブランチは残す）
 * - `awaitingUser`: ユーザーの判断を待つ
 *
 * 既に止まっている工程はそのまま返す。人が止めた直後に古いセッションから遅れて届いた失敗で
 * `stopped`を上書きしないため。止めた状態から動かすのは`resetStageForRetry`だけにする。
 */
export function haltStage(
  run: TaskRun,
  taskId: string,
  attention: Extract<TaskAttention, 'needsAction' | 'failed' | 'stopped' | 'awaitingUser'>,
  failure: string | undefined,
  now: Date,
): TaskRun {
  const task = getTask(run, taskId);
  const stage = task === undefined ? undefined : currentStage(task);
  if (task === undefined || stage === undefined || task.stages[stage].status === 'halted') {
    return run;
  }
  const at = now.toISOString();
  return withTask(run, {
    ...withStage(endCurrentAttempt(task, at), stage, {
      status: 'halted',
      pendingDecision: undefined,
    }),
    attention,
    failure,
    updatedAt: at,
  });
}

/** 実行中の工程の停止を始めた。セッションが終わるまで並列枠は空かない。 */
export function markStageStopping(run: TaskRun, taskId: string, now: Date): TaskRun {
  const task = getTask(run, taskId);
  const stage = task === undefined ? undefined : currentStage(task);
  if (task === undefined || stage === undefined || task.stages[stage].status !== 'running') {
    return run;
  }
  if (task.attention === 'stopping') {
    return run;
  }
  return withTask(run, { ...task, attention: 'stopping', updatedAt: now.toISOString() });
}

/**
 * 止まった工程をやり直せる状態へ戻す。工程は未着手に戻り、Orchestratorが設定を決め直してから
 * `retry`の実行回で始める。
 */
export function resetStageForRetry(run: TaskRun, taskId: string, now: Date): TaskRun {
  const task = getTask(run, taskId);
  const stage = task === undefined ? undefined : currentStage(task);
  if (task === undefined || stage === undefined || task.stages[stage].status !== 'halted') {
    return run;
  }
  return withTask(run, {
    ...withStage(task, stage, { status: 'notStarted', pendingDecision: undefined }),
    attention: 'none',
    failure: undefined,
    updatedAt: now.toISOString(),
  });
}

/**
 * 工程セッションの外（再読み込みの間など）でPRがmergeされたタスクを終える。実行回（あれば）を
 * 閉じ、終わっていない工程（PRがあるので残りは実装・レビュー・mergeとcleanupだけ）を完了にする。
 */
export function completeMergedTask(run: TaskRun, taskId: string, now: Date): TaskRun {
  const task = getTask(run, taskId);
  if (task === undefined || task.pullRequest === undefined || isTaskDone(task)) {
    return run;
  }
  const at = now.toISOString();
  let next = endCurrentAttempt(task, at);
  for (const stage of TASK_STAGES) {
    const status = next.stages[stage].status;
    if (status !== 'done' && status !== 'skipped') {
      next = withStage(next, stage, { status: 'done', pendingDecision: undefined, completedAt: at });
    }
  }
  return withTask(run, { ...next, attention: 'none', failure: undefined, updatedAt: at });
}

/** 並列上限を変える。範囲外は例外にする。下げても実行中のセッションは止めない。 */
export function setTaskRunMaxParallel(run: TaskRun, maxParallel: number): TaskRun {
  if (!isValidMaxParallel(maxParallel)) {
    throw new Error(`並列上限は1〜${MAX_TASK_RUN_PARALLEL}の整数: ${String(maxParallel)}`);
  }
  return run.maxParallel === maxParallel ? run : { ...run, maxParallel };
}

export function setTaskRunHaltedByUser(run: TaskRun, halted: boolean): TaskRun {
  return run.haltedByUser === halted ? run : { ...run, haltedByUser: halted };
}

/** 承認済みの計画のタスクがすべて終わっていればrunを終える。 */
export function finishTaskRunIfDone(run: TaskRun, now: Date): TaskRun {
  if (run.finishedAt !== undefined || run.planStatus !== 'approved') {
    return run;
  }
  const tasks = listTasks(run);
  if (tasks.length === 0 || !tasks.every(isTaskDone)) {
    return run;
  }
  return { ...run, finishedAt: now.toISOString() };
}

/** 人がrunを終える。実行中の工程セッションは呼び出し側が先に止める前提。 */
export function finishTaskRun(run: TaskRun, now: Date): TaskRun {
  return run.finishedAt !== undefined ? run : { ...run, finishedAt: now.toISOString() };
}

/** 終わっておらず中断もしていない。1フォルダにつき1本だけ持てる。 */
export function isTaskRunActive(run: TaskRun): boolean {
  return run.finishedAt === undefined && run.suspendedAt === undefined;
}

/** 人がrunを中断する。実行中の工程セッションは呼び出し側が先に止める前提。 */
export function suspendTaskRun(run: TaskRun, now: Date): TaskRun {
  return isTaskRunActive(run) ? { ...run, suspendedAt: now.toISOString() } : run;
}

/** 中断を外す。一時停止は呼び出し側が解く。 */
export function resumeTaskRun(run: TaskRun): TaskRun {
  if (run.suspendedAt === undefined) {
    return run;
  }
  const next = { ...run };
  delete next.suspendedAt;
  return next;
}

/** 表示名を1行へ均し、上限で切り詰める。空白だけなら`undefined`（名前なし）。 */
export function normalizeTaskRunTitle(title: string | undefined): string | undefined {
  const trimmed = sanitizeInlineText(title ?? '', TASK_RUN_TITLE_MAX_LENGTH).trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 表示名を付け替える。空なら名前を外す。 */
export function setTaskRunTitle(run: TaskRun, title: string | undefined): TaskRun {
  const next = normalizeTaskRunTitle(title);
  if (next === run.title) {
    return run;
  }
  const updated = { ...run };
  if (next === undefined) {
    delete updated.title;
  } else {
    updated.title = next;
  }
  return updated;
}

/** Orchestratorセッションを開く前に世代を進める。 */
export function nextOrchestratorGeneration(run: TaskRun): TaskRun {
  return { ...run, orchestratorGeneration: run.orchestratorGeneration + 1 };
}

export function recordOrchestratorSession(run: TaskRun, sessionId: string): TaskRun {
  if (sessionId === '' || run.orchestratorSessionRefs.includes(sessionId)) {
    return run;
  }
  return { ...run, orchestratorSessionRefs: [...run.orchestratorSessionRefs, sessionId] };
}
