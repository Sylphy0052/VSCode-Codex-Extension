import { describe, expect, it, vi } from 'vitest';
import type { AnswererQuestion, AnswererVerdict } from '../../src/reflex/answererJudge';
import type { RoadmapAskArgs, RoadmapQuestionVerdict } from '../../src/orchestrator/roadmapQuestionMcp';
import {
  GATE_OPTION_ASK_USER,
  GATE_OPTION_PROCEED,
  GATE_OPTION_RETRY,
  GATE_OPTION_SEND_BACK,
  findStageGate,
  type GateJudgeQuestion,
} from '../../src/orchestrator/taskRunGates';
import { addStageQuestion, findStageQuestion } from '../../src/orchestrator/taskRunQuestions';
import type { StageQuestion, TaskRun, TaskRunEngine } from '../../src/orchestrator/taskRunState';
import { TaskStageRunner, type TaskStageRunnerDeps } from '../../src/orchestrator/taskStageRunner';
import {
  FIXTURE_NOW,
  haltedTask,
  makeRun,
  reviewResult,
  reviewedTask,
  withOpenGate,
} from '../helpers/taskRunFixture';

/**
 * Issue #1717: 工程の関門（`judgeGate`）と質問（`routeQuestion`）の振り分け。どちらも
 * `TaskStageRunner`のprivateメソッドのため、判定の口（`judgeGate`・`judgeQuestion`・
 * `judgeAnswerer`）をモックにして直接呼ぶ。`reflexEnabled`は工程セッションのタブの値で、
 * 判定の口へそのまま渡る（Issue #1727）。
 */

type GateJudge = (
  engine: TaskRunEngine,
  question: GateJudgeQuestion,
  reflexEnabled: boolean | undefined,
) => Promise<RoadmapQuestionVerdict>;
type QuestionJudge = (
  engine: TaskRunEngine,
  question: StageQuestion,
  reflexEnabled: boolean | undefined,
) => Promise<RoadmapQuestionVerdict>;
type AnswererJudge = (
  runId: string,
  engine: TaskRunEngine,
  question: AnswererQuestion,
  reflexEnabled: boolean | undefined,
) => Promise<AnswererVerdict>;

interface Judges {
  judgeGate?: GateJudge;
  judgeQuestion?: QuestionJudge;
  judgeAnswerer?: AnswererJudge;
}

/** privateメソッドを呼ぶための型。 */
interface RunnerInternals {
  judgeGate(runId: string, taskId: string, gateId: string, reflexEnabled: boolean | undefined): Promise<void>;
  routeQuestion(entry: unknown, question: StageQuestion, args: RoadmapAskArgs): Promise<void>;
  deliverAnswer(entry: unknown, question: StageQuestion): Promise<void>;
}

function setup(initial: TaskRun, judges: Judges) {
  let current: TaskRun | undefined = initial;
  const store = {
    find: (runId: string) => (current?.runId === runId ? current : undefined),
    update: async (_runId: string, fn: (run: TaskRun | undefined) => TaskRun) => {
      current = fn(current);
      return current;
    },
  };
  const deps = {
    store,
    now: () => FIXTURE_NOW,
    ...judges,
  } as unknown as TaskStageRunnerDeps;
  const runner = new TaskStageRunner(deps);
  return {
    internals: runner as unknown as RunnerInternals,
    run: () => {
      if (current === undefined) {
        throw new Error('runが無い');
      }
      return current;
    },
  };
}

// ---------------------------------------------------------------------------
// 関門
// ---------------------------------------------------------------------------

function stageFailedRun(): TaskRun {
  return withOpenGate(makeRun([haltedTask('T1')]), 'T1', 'g1', 'stageFailed', 'テストが落ちた');
}

function reviewGateRun(passed: boolean): TaskRun {
  return withOpenGate(
    makeRun([reviewedTask('T1', reviewResult(passed, ['残った指摘']))]),
    'T1',
    'g1',
    'reviewFindings',
  );
}

const answer = (label: string, summary = `${label} 0.90`): RoadmapQuestionVerdict => ({
  kind: 'answer',
  answer: label,
  summary,
});

describe('TaskStageRunner.judgeGate', () => {
  it('判定の口が無ければユーザーの判断待ちにする', async () => {
    const t = setup(stageFailedRun(), {});
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({ status: 'awaitingUser', reflexSummary: undefined });
  });

  it('やり直しの判定なら、Reflexの決着として工程を未着手へ戻す', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => answer(GATE_OPTION_RETRY));
    const judgeAnswerer = vi.fn<AnswererJudge>();
    const t = setup(stageFailedRun(), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', true);
    expect(judgeGate).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ options: [GATE_OPTION_RETRY, GATE_OPTION_ASK_USER] }),
      true,
    );
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'resolved',
      reflexSummary: `${GATE_OPTION_RETRY} 0.90`,
      resolution: { choice: 'retry', by: 'reflex' },
    });
    expect(t.run().tasks['T1']?.stages.implement.status).toBe('notStarted');
    expect(judgeAnswerer).not.toHaveBeenCalled();
  });

  it('レビューが通過した関門で「進める」の判定なら決着させる', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => answer(GATE_OPTION_PROCEED));
    const t = setup(reviewGateRun(true), { judgeGate });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'resolved',
      resolution: { choice: 'proceed', by: 'reflex' },
    });
  });

  it('差し戻しの判定なら実装とレビューを未着手へ戻す', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => answer(GATE_OPTION_SEND_BACK));
    const t = setup(reviewGateRun(false), { judgeGate });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(findStageGate(t.run(), 'T1', 'g1')?.resolution).toMatchObject({ choice: 'sendBack', by: 'reflex' });
    expect(t.run().tasks['T1']?.stages.implement.status).toBe('notStarted');
    expect(t.run().tasks['T1']?.stages.review.status).toBe('notStarted');
  });

  it('レビューが通過しなかった関門で「進める」の判定は採らず、回答者判定にかけずにユーザーへ回す（Issue #1711）', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => answer(GATE_OPTION_PROCEED));
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'orchestrator', summary: '決めてよい' }));
    const t = setup(reviewGateRun(false), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(judgeGate.mock.calls[0]?.[1].options).not.toContain(GATE_OPTION_PROCEED);
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: `レビューが通過していないため、Reflexの判定（${GATE_OPTION_PROCEED}）を採らなかった`,
    });
    expect(judgeAnswerer).not.toHaveBeenCalled();
  });

  it.each([
    ['人へ回す判定', async (): Promise<RoadmapQuestionVerdict> => ({ kind: 'human', summary: '確信度不足' })],
    ['「ユーザーに判断を上げる」の判定', async () => answer(GATE_OPTION_ASK_USER)],
    [
      '判定の失敗',
      async (): Promise<RoadmapQuestionVerdict> => {
        throw new Error('timeout');
      },
    ],
  ])('レビューが通過しなかった関門は、%sなら回答者判定にかけ、オーケストレーターが決めてよければその判断待ちにする（Issue #1763・#1771）', async (_label, verdict) => {
    const judgeGate = vi.fn<GateJudge>(verdict);
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'orchestrator', summary: '決めてよい' }));
    const t = setup(reviewGateRun(false), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(judgeAnswerer).toHaveBeenCalledTimes(1);
    expect(judgeAnswerer.mock.calls[0]?.[2].evidence).toContain('オーケストレーターは実装への差し戻しのほか、指摘を残したまま進めることも選べる');
    expect(findStageGate(t.run(), 'T1', 'g1')?.status).toBe('awaitingOrchestrator');
  });

  it('関門の種類に合わない選択肢の判定は決着させず、回答者判定にかける', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => answer(GATE_OPTION_SEND_BACK));
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'user', summary: undefined }));
    const t = setup(stageFailedRun(), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(judgeAnswerer).toHaveBeenCalledTimes(1);
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: `${GATE_OPTION_SEND_BACK} 0.90`,
    });
  });

  it('「ユーザーに判断を上げる」で回答者判定がオーケストレーターならその判断待ちにする', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => answer(GATE_OPTION_ASK_USER, '上げる 0.70'));
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'orchestrator', summary: '決めてよい 0.90' }));
    const t = setup(stageFailedRun(), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', false);
    expect(judgeAnswerer).toHaveBeenCalledWith(
      'run-1',
      'claude',
      expect.objectContaining({
        source: 'stageSession',
        options: [GATE_OPTION_RETRY, GATE_OPTION_ASK_USER],
        evidence: '止まった理由: テストが落ちた\nReflexの選択肢判定: 上げる 0.70',
      }),
      false,
    );
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'awaitingOrchestrator',
      reflexSummary: '上げる 0.70\n回答者判定: 決めてよい 0.90',
    });
  });

  it('回答者判定がユーザーなら、判定の要約を足してユーザーの判断待ちにする', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => ({ kind: 'human', summary: '確信度不足' }));
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'user', summary: 'ユーザー 0.80' }));
    const t = setup(stageFailedRun(), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: '確信度不足\n回答者判定: ユーザー 0.80',
    });
  });

  it('判定が例外を投げたら失敗を要約に残し、回答者判定にかける', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => {
      throw new Error('timeout');
    });
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'user', summary: undefined }));
    const t = setup(stageFailedRun(), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(judgeAnswerer).toHaveBeenCalledTimes(1);
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: 'Reflexの判定に失敗: timeout',
    });
  });

  it('回答者判定が例外を投げたらユーザーの判断待ちにする', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => ({ kind: 'human', summary: undefined }));
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => {
      throw new Error('boom');
    });
    const t = setup(stageFailedRun(), { judgeGate, judgeAnswerer });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    expect(findStageGate(t.run(), 'T1', 'g1')).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: '回答者判定: 回答者判定に失敗: boom',
    });
  });

  it('判定中でない関門は判定しない', async () => {
    const judgeGate = vi.fn<GateJudge>(async () => answer(GATE_OPTION_RETRY));
    const t = setup(stageFailedRun(), { judgeGate });
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    await t.internals.judgeGate('run-1', 'T1', 'g1', undefined);
    await t.internals.judgeGate('run-1', 'T1', 'missing', undefined);
    await t.internals.judgeGate('run-x', 'T1', 'g1', undefined);
    expect(judgeGate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 質問
// ---------------------------------------------------------------------------

const ASK: RoadmapAskArgs = {
  question: 'どちらの案で進めるか',
  reason: '仕様が2通りに読める',
  options: ['案A', '案B'],
  recommended: '案A',
  blocking: true,
  evidence: '設計メモ',
  escalation: [],
};

function questionRun(
  args: RoadmapAskArgs,
  reflexEnabled: boolean | undefined,
): { run: TaskRun; question: StageQuestion; entry: unknown } {
  const task = haltedTask('T1');
  const ref = { taskId: 'T1', executionId: task.executionId, stage: 'implement' as const, attemptId: 'a1' };
  const run = addStageQuestion(makeRun([task]), ref, 'q1', args, FIXTURE_NOW);
  const question = findStageQuestion(run, 'T1', 'q1');
  if (question === undefined) {
    throw new Error('質問を足せなかった');
  }
  return { run, question, entry: { runId: 'run-1', ref, session: { reflexEnabled: () => reflexEnabled } } };
}

/** `reflexEnabled`は工程セッションのタブの上書き（Issue #1727）。 */
function setupQuestion(
  args: RoadmapAskArgs,
  judges: Judges,
  tab: { reflexEnabled: boolean | undefined } = { reflexEnabled: true },
) {
  const { run, question, entry } = questionRun(args, tab.reflexEnabled);
  const t = setup(run, judges);
  const deliverAnswer = vi.spyOn(t.internals, 'deliverAnswer').mockResolvedValue(undefined);
  return {
    ...t,
    deliverAnswer,
    route: () => t.internals.routeQuestion(entry, question, args),
    question: () => findStageQuestion(t.run(), 'T1', 'q1'),
  };
}

describe('TaskStageRunner.routeQuestion', () => {
  it('判定の答えで回答し、工程セッションへ届ける。推奨はReflexへ渡さない（Issue #1712）', async () => {
    const judgeQuestion = vi.fn<QuestionJudge>(async () => answer('案B'));
    const judgeAnswerer = vi.fn<AnswererJudge>();
    const t = setupQuestion(ASK, { judgeQuestion, judgeAnswerer });
    await t.route();
    expect(judgeQuestion).toHaveBeenCalledWith('claude', expect.objectContaining({ recommended: undefined }), true);
    expect(t.question()).toMatchObject({ status: 'answeredByReflex', answer: '案B', reflexSummary: '案B 0.90' });
    expect(t.deliverAnswer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ answer: '案B' }));
    expect(judgeAnswerer).not.toHaveBeenCalled();
  });

  it('secrets・破壊的操作のescalationの付いた質問はReflexにも回答者判定にもかけずにユーザーへ回す', async () => {
    const judgeQuestion = vi.fn<QuestionJudge>();
    const judgeAnswerer = vi.fn<AnswererJudge>();
    const t = setupQuestion({ ...ASK, escalation: ['secrets'] }, { judgeQuestion, judgeAnswerer });
    await t.route();
    expect(judgeQuestion).not.toHaveBeenCalled();
    expect(judgeAnswerer).not.toHaveBeenCalled();
    expect(t.question()).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: 'ユーザーが決めるescalationが付いているためReflexを通さなかった（secrets）',
    });
  });

  it('それ以外のescalationの付いた質問はReflexにかけず、回答者判定にかける', async () => {
    const judgeQuestion = vi.fn<QuestionJudge>();
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'orchestrator', summary: '決めてよい' }));
    const t = setupQuestion({ ...ASK, escalation: ['specConflict'] }, { judgeQuestion, judgeAnswerer });
    await t.route();
    expect(judgeQuestion).not.toHaveBeenCalled();
    expect(judgeAnswerer).toHaveBeenCalledTimes(1);
    expect(t.question()).toMatchObject({ status: 'awaitingOrchestrator' });
  });

  it('secrets・破壊的操作の危険語を含む質問はescalationが無くてもユーザーへ回し、理由を残す（Issue #1712・#1771）', async () => {
    const judgeQuestion = vi.fn<QuestionJudge>();
    const judgeAnswerer = vi.fn<AnswererJudge>();
    const t = setupQuestion({ ...ASK, options: ['案A', 'mainへforce pushする'] }, { judgeQuestion, judgeAnswerer });
    await t.route();
    expect(judgeQuestion).not.toHaveBeenCalled();
    expect(judgeAnswerer).not.toHaveBeenCalled();
    expect(t.question()).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: 'secretsか破壊的操作に関わる語を含むためReflexを通さなかった（リモートへの強制push）',
    });
  });

  it('選択肢の無い質問はReflexにかけず、回答者判定がオーケストレーターならその判断待ちにする', async () => {
    const judgeQuestion = vi.fn<QuestionJudge>();
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'orchestrator', summary: '決めてよい' }));
    const t = setupQuestion({ ...ASK, options: [], recommended: undefined }, { judgeQuestion, judgeAnswerer });
    await t.route();
    expect(judgeQuestion).not.toHaveBeenCalled();
    expect(judgeAnswerer).toHaveBeenCalledWith(
      'run-1',
      'claude',
      expect.objectContaining({ source: 'stageSession', evidence: '設計メモ' }),
      true,
    );
    expect(t.question()).toMatchObject({ status: 'awaitingOrchestrator', reflexSummary: '回答者判定: 決めてよい' });
  });

  it('判定の口が無ければ回答者判定にかける', async () => {
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'user', summary: undefined }));
    const t = setupQuestion(ASK, { judgeAnswerer });
    await t.route();
    expect(judgeAnswerer).toHaveBeenCalledTimes(1);
    expect(t.question()).toMatchObject({ status: 'awaitingUser', reflexSummary: undefined });
  });

  it('人へ回す判定なら、要約を材料に足して回答者判定にかける', async () => {
    const judgeQuestion = vi.fn<QuestionJudge>(async () => ({ kind: 'human', summary: '質問1: 案A 0.60' }));
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'user', summary: 'ユーザー 0.85' }));
    const t = setupQuestion(ASK, { judgeQuestion, judgeAnswerer });
    await t.route();
    expect(judgeAnswerer.mock.calls[0]?.[2].evidence).toBe('設計メモ\nReflexの選択肢判定: 質問1: 案A 0.60');
    expect(t.question()).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: '質問1: 案A 0.60\n回答者判定: ユーザー 0.85',
    });
    expect(t.deliverAnswer).not.toHaveBeenCalled();
  });

  it('判定が例外を投げたら失敗を要約に残し、回答者判定にかける', async () => {
    const judgeQuestion = vi.fn<QuestionJudge>(async () => {
      throw new Error('timeout');
    });
    const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'user', summary: undefined }));
    const t = setupQuestion(ASK, { judgeQuestion, judgeAnswerer });
    await t.route();
    expect(judgeAnswerer).toHaveBeenCalledTimes(1);
    expect(t.question()).toMatchObject({ status: 'awaitingUser', reflexSummary: 'Reflexの判定に失敗: timeout' });
  });

  it.each([false, undefined])(
    'タブの上書き（%s）を判定の口と回答者判定へそのまま渡す（Issue #1727）',
    async (reflexEnabled) => {
      const judgeQuestion = vi.fn<QuestionJudge>(async () => ({ kind: 'human', summary: undefined }));
      const judgeAnswerer = vi.fn<AnswererJudge>(async () => ({ kind: 'user', summary: undefined }));
      const t = setupQuestion(ASK, { judgeQuestion, judgeAnswerer }, { reflexEnabled });
      await t.route();
      expect(judgeQuestion.mock.calls[0]?.[2]).toBe(reflexEnabled);
      expect(judgeAnswerer.mock.calls[0]?.[3]).toBe(reflexEnabled);
    },
  );

  it('既に答えの出た質問へ判定の答えが遅れて届いても上書きしない', async () => {
    const judgeQuestion = vi
      .fn<QuestionJudge>()
      .mockResolvedValueOnce(answer('案B'))
      .mockResolvedValueOnce(answer('案A'));
    const t = setupQuestion(ASK, { judgeQuestion });
    await t.route();
    await t.route();
    expect(judgeQuestion).toHaveBeenCalledTimes(2);
    expect(t.deliverAnswer).toHaveBeenCalledTimes(1);
    expect(t.question()).toMatchObject({ status: 'answeredByReflex', answer: '案B' });
  });
});
