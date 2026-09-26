import type { RoadmapAskArgs } from './roadmapQuestionMcp';
import {
  getTask,
  type OrchestratedTask,
  type StageQuestion,
  type StageReportRef,
  type TaskRun,
} from './taskRunState';

/**
 * オーケストレータモード（Issue #1505）の工程セッションの質問の状態遷移（純粋関数）。
 *
 * 質問は受け付けた時点で`judging`として残し、Reflexが答えれば`answeredByReflex`、人へ回すと
 * `awaitingUser`にする。カードの「ユーザー判断待ち」は`awaitingUser`の質問の有無から導き、
 * タスクの`attention`は変えない（実行中の工程を止めた扱いにしないため）。
 */

/** 1タスクに残す質問の上限。古い回答済みの質問から捨てる。 */
export const MAX_QUESTIONS_PER_TASK = 50;

function withQuestions(
  run: TaskRun,
  task: OrchestratedTask,
  questions: readonly StageQuestion[],
  at: string,
): TaskRun {
  return {
    ...run,
    tasks: { ...run.tasks, [task.taskId]: { ...task, questions, updatedAt: at } },
  };
}

function isOpen(question: StageQuestion): boolean {
  return question.status === 'judging' || question.status === 'awaitingUser';
}

/** 上限を超えた分を、答えの出た古い質問から捨てる。未回答の質問は捨てない。 */
function trimQuestions(questions: readonly StageQuestion[]): StageQuestion[] {
  const result = [...questions];
  while (result.length > MAX_QUESTIONS_PER_TASK) {
    const index = result.findIndex((q) => !isOpen(q));
    if (index < 0) {
      break;
    }
    result.splice(index, 1);
  }
  return result;
}

/** 質問を`judging`として受け付ける。タスクが無ければそのまま返す。 */
export function addStageQuestion(
  run: TaskRun,
  ref: StageReportRef,
  questionId: string,
  args: RoadmapAskArgs,
  now: Date,
): TaskRun {
  const task = getTask(run, ref.taskId);
  if (task === undefined) {
    return run;
  }
  const at = now.toISOString();
  const question: StageQuestion = {
    questionId,
    stage: ref.stage,
    attemptId: ref.attemptId,
    question: args.question,
    reason: args.reason,
    options: args.options,
    recommended: args.recommended,
    blocking: args.blocking,
    evidence: args.evidence,
    status: 'judging',
    reflexSummary: undefined,
    answer: undefined,
    askedAt: at,
    answeredAt: undefined,
  };
  return withQuestions(run, task, trimQuestions([...(task.questions ?? []), question]), at);
}

export function findStageQuestion(
  run: TaskRun,
  taskId: string,
  questionId: string,
): StageQuestion | undefined {
  return getTask(run, taskId)?.questions?.find((q) => q.questionId === questionId);
}

function updateQuestion(
  run: TaskRun,
  taskId: string,
  questionId: string,
  now: Date,
  update: (question: StageQuestion) => StageQuestion | undefined,
): TaskRun {
  const task = getTask(run, taskId);
  const questions = task?.questions;
  const index = questions?.findIndex((q) => q.questionId === questionId) ?? -1;
  const current = index < 0 ? undefined : questions?.[index];
  if (task === undefined || questions === undefined || current === undefined) {
    return run;
  }
  const next = update(current);
  if (next === undefined) {
    return run;
  }
  const at = now.toISOString();
  return withQuestions(run, task, questions.map((q, i) => (i === index ? next : q)), at);
}

/** Reflexの判定中の質問をユーザーの判断待ちにする。 */
export function markQuestionAwaitingUser(
  run: TaskRun,
  taskId: string,
  questionId: string,
  reflexSummary: string | undefined,
  now: Date,
): TaskRun {
  return updateQuestion(run, taskId, questionId, now, (q) =>
    q.status === 'judging' ? { ...q, status: 'awaitingUser', reflexSummary } : undefined,
  );
}

/**
 * 質問に回答する。Reflexは判定中の質問に、ユーザーは判断待ちの質問にだけ答えられる。
 * 回答済みの質問はそのまま返す（呼び出し側は戻り値が元のrunかどうかで受理を判定する）。
 */
export function answerStageQuestion(
  run: TaskRun,
  taskId: string,
  questionId: string,
  answer: { by: 'reflex' | 'user'; text: string; reflexSummary?: string },
  now: Date,
): TaskRun {
  return updateQuestion(run, taskId, questionId, now, (q) => {
    const expected = answer.by === 'reflex' ? 'judging' : 'awaitingUser';
    if (q.status !== expected) {
      return undefined;
    }
    return {
      ...q,
      status: answer.by === 'reflex' ? 'answeredByReflex' : 'answeredByUser',
      answer: answer.text,
      reflexSummary: answer.reflexSummary ?? q.reflexSummary,
      answeredAt: now.toISOString(),
    };
  });
}

/**
 * 未回答の質問を取り消す（工程セッションが終わった・止まったとき）。`releasedAttemptId`は
 * 終わったセッションの実行回。取り消しは非同期に遅れて走るため、その間に別のセッションが
 * 始めた実行回（タスクの現在の実行回が`releasedAttemptId`と異なる）の質問は残す。
 */
export function cancelOpenQuestions(
  run: TaskRun,
  taskId: string,
  releasedAttemptId: string,
  now: Date,
): TaskRun {
  const task = getTask(run, taskId);
  const questions = task?.questions;
  const current = task?.currentAttemptId;
  const keep = current !== undefined && current !== releasedAttemptId ? current : undefined;
  const cancellable = (q: StageQuestion): boolean => isOpen(q) && q.attemptId !== keep;
  if (task === undefined || questions === undefined || !questions.some(cancellable)) {
    return run;
  }
  const at = now.toISOString();
  return withQuestions(
    run,
    task,
    questions.map((q) => (cancellable(q) ? { ...q, status: 'cancelled' } : q)),
    at,
  );
}

/** ユーザーの判断待ちの質問。 */
export function listQuestionsAwaitingUser(task: OrchestratedTask): StageQuestion[] {
  return (task.questions ?? []).filter((q) => q.status === 'awaitingUser');
}
