import type { RoadmapAskArgs } from './roadmapQuestionMcp';
import { STAGE_LABELS } from './taskStagePrompts';
import {
  currentStage,
  getTask,
  isTaskDone,
  resetStageForRetry,
  type OrchestratedTask,
  type StageGate,
  type StageGateChoice,
  type StageGateKind,
  type StageReviewResult,
  type TaskRun,
  type TaskStage,
} from './taskRunState';
import { sanitizeInlineText } from './untrustedText';

/**
 * オーケストレータモード（Issue #1505）の判断の関門の状態遷移（純粋関数）。
 *
 * 工程が失敗・要対応で止まったとき（`stageFailed`）と、レビューが直さずに残した指摘を持って
 * 終わったとき（`reviewFindings`）に関門を開き、次の手が決まるまでそのタスクの工程を始めない。
 * 関門は`judging`（Reflexの判定中）で開き、Reflexが決めれば決着、決められなければ
 * `awaitingUser`（ユーザーの判断待ち）にする。差し戻しと自動のやり直しには上限を設け、
 * 上限に達したら判定せずにユーザーへ回す。
 */

/** レビュー後に実装へ差し戻す回数の上限。超えたらユーザーへ回す。 */
export const MAX_REVIEW_ROUNDS = 3;

/** 1つの工程をReflexの判定でやり直す回数の上限。超えたらユーザーへ回す。 */
export const MAX_AUTO_RETRIES = 3;

/** 1タスクに残す関門の上限。古い決着済みの関門から捨てる。 */
export const MAX_GATES_PER_TASK = 30;

const MAX_DETAIL_ITEM_LENGTH = 300;
const MAX_DETAIL_ITEMS = 20;

/** Reflexへ示す選択肢。全角の括弧を入れない（Reflexが半角へ書き換えて照合できなくなる）。 */
export const GATE_OPTION_SEND_BACK = '実装へ差し戻す';
export const GATE_OPTION_PROCEED = '指摘を残したまま進める';
export const GATE_OPTION_RETRY = '同じ工程をやり直す';
export const GATE_OPTION_ASK_USER = 'ユーザーに判断を上げる';

/** 関門の種類ごとに受け付ける決着。 */
const ALLOWED_CHOICES: Record<StageGateKind, readonly StageGateChoice[]> = {
  reviewFindings: ['sendBack', 'proceed'],
  stageFailed: ['retry'],
};

export function isGateChoiceAllowed(kind: StageGateKind, choice: StageGateChoice): boolean {
  return ALLOWED_CHOICES[kind].includes(choice);
}

function isOpen(gate: StageGate): boolean {
  return gate.status === 'judging' || gate.status === 'awaitingUser';
}

/** 条件に合う最後の関門（`findLast`はES2022のlibに無い）。 */
function lastGate(
  task: OrchestratedTask,
  predicate: (gate: StageGate) => boolean,
): StageGate | undefined {
  const gates = task.gates ?? [];
  for (let i = gates.length - 1; i >= 0; i--) {
    const gate = gates[i];
    if (gate !== undefined && predicate(gate)) {
      return gate;
    }
  }
  return undefined;
}

/** 決着していない関門。タスクが終わっていれば無い。 */
export function findOpenGate(task: OrchestratedTask): StageGate | undefined {
  return isTaskDone(task) ? undefined : lastGate(task, isOpen);
}

/** 最後に決着した関門（Kanbanに直前の判断として出す）。 */
export function findLastResolvedGate(task: OrchestratedTask): StageGate | undefined {
  return lastGate(task, (gate) => gate.status === 'resolved');
}

export function findStageGate(run: TaskRun, taskId: string, gateId: string): StageGate | undefined {
  return getTask(run, taskId)?.gates?.find((gate) => gate.gateId === gateId);
}

/** 上限を超えた分を、決着した古い関門から捨てる。決着していない関門は捨てない。 */
function trimGates(gates: readonly StageGate[]): StageGate[] {
  const result = [...gates];
  while (result.length > MAX_GATES_PER_TASK) {
    const index = result.findIndex((gate) => !isOpen(gate));
    if (index < 0) {
      break;
    }
    result.splice(index, 1);
  }
  return result;
}

function withTaskUpdate(run: TaskRun, next: OrchestratedTask): TaskRun {
  return { ...run, tasks: { ...run.tasks, [next.taskId]: next } };
}

/** その工程をReflexの判定でやり直した回数。 */
export function countAutoRetries(task: OrchestratedTask, stage: TaskStage): number {
  return (task.gates ?? []).filter(
    (gate) =>
      gate.kind === 'stageFailed' &&
      gate.stage === stage &&
      gate.resolution?.by === 'reflex' &&
      gate.resolution.choice === 'retry',
  ).length;
}

/** レビューの結果が関門を要するか（直さずに残した指摘がある、または通過しなかった）。 */
export function needsReviewGate(review: StageReviewResult | undefined): boolean {
  return review !== undefined && (!review.passed || review.remainingFindings.length > 0);
}

/** 残った指摘を関門の詳細にする。 */
export function reviewGateDetail(review: StageReviewResult): string {
  const findings = review.remainingFindings
    .slice(0, MAX_DETAIL_ITEMS)
    .map((f) => `- ${sanitizeInlineText(f, MAX_DETAIL_ITEM_LENGTH)}`);
  const omitted = review.remainingFindings.length - findings.length;
  return [
    review.passed ? 'high・mediumの指摘は残っていない' : 'high・mediumの指摘が残っている',
    ...findings,
    ...(omitted > 0 ? [`（ほか${String(omitted)}件）`] : []),
  ].join('\n');
}

/**
 * 上限に達しているなら、その理由。Reflexに判定させずにユーザーへ回す。
 */
function limitReached(task: OrchestratedTask, kind: StageGateKind, stage: TaskStage): string | undefined {
  if (kind === 'reviewFindings') {
    const rounds = task.reviewRounds ?? 0;
    return rounds >= MAX_REVIEW_ROUNDS
      ? `実装への差し戻しが上限（${String(MAX_REVIEW_ROUNDS)}回）に達した`
      : undefined;
  }
  return countAutoRetries(task, stage) >= MAX_AUTO_RETRIES
    ? `自動のやり直しが上限（${String(MAX_AUTO_RETRIES)}回）に達した`
    : undefined;
}

/**
 * 関門を開く。`reviewFindings`はレビューを終えて「mergeとcleanup」が未着手のとき、
 * `stageFailed`は現在の工程が止まっているときだけ開く。決着していない関門が既にあれば
 * そのまま返す。上限に達していれば、判定中を飛ばしてユーザーの判断待ちで開く。
 */
export function openStageGate(
  run: TaskRun,
  taskId: string,
  input: { gateId: string; kind: StageGateKind; detail: string },
  now: Date,
): TaskRun {
  const task = getTask(run, taskId);
  const stage = task === undefined ? undefined : currentStage(task);
  if (task === undefined || stage === undefined || findOpenGate(task) !== undefined) {
    return run;
  }
  const gateStage: TaskStage = input.kind === 'reviewFindings' ? 'review' : stage;
  const expected =
    input.kind === 'reviewFindings'
      ? stage === 'mergeCleanup' && task.stages.mergeCleanup.status === 'notStarted'
      : task.stages[stage].status === 'halted' && task.attention !== 'stopped';
  if (!expected) {
    return run;
  }
  const at = now.toISOString();
  const limit = limitReached(task, input.kind, gateStage);
  const gate: StageGate = {
    gateId: input.gateId,
    kind: input.kind,
    stage: gateStage,
    status: limit === undefined ? 'judging' : 'awaitingUser',
    detail: input.detail,
    reflexSummary: limit,
    resolution: undefined,
    openedAt: at,
  };
  const attention =
    limit !== undefined && input.kind === 'reviewFindings' ? 'awaitingUser' : task.attention;
  return withTaskUpdate(run, {
    ...task,
    gates: trimGates([...(task.gates ?? []), gate]),
    attention,
    updatedAt: at,
  });
}

function updateGate(
  run: TaskRun,
  taskId: string,
  gateId: string,
  update: (task: OrchestratedTask, gate: StageGate) => OrchestratedTask | undefined,
): TaskRun {
  const task = getTask(run, taskId);
  const gate = task?.gates?.find((g) => g.gateId === gateId);
  if (task === undefined || gate === undefined || findOpenGate(task)?.gateId !== gateId) {
    return run;
  }
  const next = update(task, gate);
  return next === undefined ? run : withTaskUpdate(run, next);
}

function replaceGate(task: OrchestratedTask, next: StageGate): readonly StageGate[] {
  return (task.gates ?? []).map((g) => (g.gateId === next.gateId ? next : g));
}

/**
 * Reflexの判定中の関門をユーザーの判断待ちにする。`reviewFindings`はタスクの注意も
 * ユーザー判断待ちにする（`stageFailed`は止めたときの要対応・失敗のまま）。
 */
export function escalateStageGate(
  run: TaskRun,
  taskId: string,
  gateId: string,
  reflexSummary: string | undefined,
  now: Date,
): TaskRun {
  return updateGate(run, taskId, gateId, (task, gate) => {
    if (gate.status !== 'judging') {
      return undefined;
    }
    const at = now.toISOString();
    return {
      ...task,
      gates: replaceGate(task, { ...gate, status: 'awaitingUser', reflexSummary }),
      attention: gate.kind === 'reviewFindings' && task.attention === 'none' ? 'awaitingUser' : task.attention,
      updatedAt: at,
    };
  });
}

/** 「実装とPR作成」と「レビュー」を未着手へ戻す（差し戻し）。 */
function sendBackToImplement(task: OrchestratedTask): OrchestratedTask {
  const reset = { status: 'notStarted' as const, pendingDecision: undefined, completedAt: undefined };
  return {
    ...task,
    stages: {
      ...task.stages,
      implement: { ...task.stages.implement, ...reset },
      review: { ...task.stages.review, ...reset },
    },
    reviewRounds: (task.reviewRounds ?? 0) + 1,
  };
}

/**
 * 関門を決着させる。Reflexは判定中の関門に、ユーザーは判定中・判断待ちの関門に決着を付けられる
 * （ユーザーの判断を優先し、遅れて届いたReflexの判定は捨てる）。関門の種類に合わない決着と、
 * タスクが関門を開いたときの状態から動いているときはそのまま返す（呼び出し側は戻り値が元の
 * runかどうかで受理を判定する）。
 * - `sendBack`: 「実装とPR作成」から やり直す（同じworktree・ブランチ・PRを使う）
 * - `proceed`: 指摘を残したまま「mergeとcleanup」へ進む
 * - `retry`: 止まった工程を未着手へ戻す（`resetStageForRetry`）
 */
export function resolveStageGate(
  run: TaskRun,
  taskId: string,
  gateId: string,
  resolution: { choice: StageGateChoice; by: 'reflex' | 'user'; reflexSummary?: string },
  now: Date,
): TaskRun {
  const at = now.toISOString();
  return updateGate(run, taskId, gateId, (task, gate) => {
    if (resolution.by === 'reflex' && gate.status !== 'judging') {
      return undefined;
    }
    if (!isGateChoiceAllowed(gate.kind, resolution.choice)) {
      return undefined;
    }
    const resolved: StageGate = {
      ...gate,
      status: 'resolved',
      reflexSummary: resolution.reflexSummary ?? gate.reflexSummary,
      resolution: { choice: resolution.choice, by: resolution.by, at },
    };
    const closed: OrchestratedTask = { ...task, gates: replaceGate(task, resolved), updatedAt: at };
    const stage = currentStage(task);
    if (stage === undefined || task.attention === 'stopping') {
      return undefined;
    }
    const status = task.stages[stage].status;
    if (gate.kind === 'reviewFindings') {
      // 関門を開いた後に再読み込みで「mergeとcleanup」が止まった（PRが閉じられた等）場合も決着させる
      if (stage !== 'mergeCleanup' || (status !== 'notStarted' && status !== 'halted')) {
        return undefined;
      }
      const reset = getTask(resetStageForRetry(withTaskUpdate(run, closed), taskId, now), taskId);
      const base: OrchestratedTask = { ...(reset ?? closed), attention: 'none', failure: undefined };
      return resolution.choice === 'sendBack' ? sendBackToImplement(base) : base;
    }
    if (status !== 'halted') {
      return undefined;
    }
    return getTask(resetStageForRetry(withTaskUpdate(run, closed), taskId, now), taskId);
  });
}

/**
 * 再読み込みでReflexの判定が途切れた関門をユーザーの判断待ちにする（判定し直さない）。
 */
export function escalateJudgingGatesOnReload(run: TaskRun, now: Date): TaskRun {
  let next = run;
  for (const task of Object.values(run.tasks)) {
    const gate = findOpenGate(task);
    if (gate?.status === 'judging') {
      next = escalateStageGate(next, task.taskId, gate.gateId, '再読み込みでReflexの判定が途切れた', now);
    }
  }
  return next;
}

export type GateJudgeQuestion = Pick<
  RoadmapAskArgs,
  'question' | 'reason' | 'options' | 'recommended' | 'evidence'
>;

/** Reflexへ渡す関門の問い。 */
export function buildGateQuestion(task: OrchestratedTask, gate: StageGate): GateJudgeQuestion {
  if (gate.kind === 'reviewFindings') {
    const rounds = task.reviewRounds ?? 0;
    return {
      question: `${task.taskId}のレビューが直さずに残した指摘がある。次にどうするか。`,
      reason:
        `レビューを終えたが指摘が残った。実装への差し戻しはこれまで${String(rounds)}回` +
        `（上限${String(MAX_REVIEW_ROUNDS)}回）。差し戻すと同じPRへ追加の修正をしてからレビューし直す。`,
      options: [GATE_OPTION_SEND_BACK, GATE_OPTION_PROCEED, GATE_OPTION_ASK_USER],
      recommended: task.review?.passed === false ? GATE_OPTION_SEND_BACK : GATE_OPTION_PROCEED,
      evidence: `レビューの結果:\n${gate.detail}`,
    };
  }
  const retries = countAutoRetries(task, gate.stage);
  return {
    question: `${task.taskId}の「${STAGE_LABELS[gate.stage]}」が止まった。次にどうするか。`,
    reason:
      `工程が失敗または要対応で止まった。自動のやり直しはこれまで${String(retries)}回` +
      `（上限${String(MAX_AUTO_RETRIES)}回）。一時的な失敗ならやり直し、同じ原因で繰り返しそうならユーザーに上げる。`,
    options: [GATE_OPTION_RETRY, GATE_OPTION_ASK_USER],
    recommended: undefined,
    evidence: `止まった理由: ${gate.detail}`,
  };
}

/** Reflexが選んだ選択肢を決着へ写す。ユーザーへ回す選択肢と未知の選択肢は`undefined`。 */
export function gateChoiceFromAnswer(kind: StageGateKind, answer: string): StageGateChoice | undefined {
  const choice: StageGateChoice | undefined =
    answer === GATE_OPTION_SEND_BACK
      ? 'sendBack'
      : answer === GATE_OPTION_PROCEED
        ? 'proceed'
        : answer === GATE_OPTION_RETRY
          ? 'retry'
          : undefined;
  return choice !== undefined && isGateChoiceAllowed(kind, choice) ? choice : undefined;
}

/** 決着の表示名。 */
export const GATE_CHOICE_LABELS: Record<StageGateChoice, string> = {
  sendBack: GATE_OPTION_SEND_BACK,
  proceed: GATE_OPTION_PROCEED,
  retry: GATE_OPTION_RETRY,
};
