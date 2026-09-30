import { describe, expect, it } from 'vitest';
import {
  GATE_OPTION_ASK_USER,
  GATE_OPTION_PROCEED,
  GATE_OPTION_RETRY,
  GATE_OPTION_SEND_BACK,
  buildGateQuestion,
  escalateJudgingGatesOnReload,
  findStageGate,
  gateChoiceFromAnswer,
  markGateAwaitingOrchestrator,
} from '../../src/orchestrator/taskRunGates';
import { getTask, type StageGate, type TaskRun } from '../../src/orchestrator/taskRunState';
import {
  FIXTURE_NOW,
  haltedTask,
  makeRun,
  resolvedRetryGate,
  reviewResult,
  reviewedTask,
  withOpenGate,
} from '../helpers/taskRunFixture';

/** Issue #1717: 関門の問い（`buildGateQuestion`）と、再読み込み時の関門の扱い。 */

function gateOf(run: TaskRun, taskId: string, gateId: string): StageGate {
  const gate = findStageGate(run, taskId, gateId);
  if (gate === undefined) {
    throw new Error(`関門が無い: ${gateId}`);
  }
  return gate;
}

describe('buildGateQuestion', () => {
  it('レビューが通過した関門は「進める」を選択肢に入れて推奨にする', () => {
    const task = reviewedTask('T1', reviewResult(true, ['lowの指摘']), { reviewRounds: 1 });
    const run = withOpenGate(makeRun([task]), 'T1', 'g1', 'reviewFindings', '残った指摘');
    const question = buildGateQuestion(task, gateOf(run, 'T1', 'g1'));
    expect(question).toEqual({
      question: 'T1のレビューが直さずに残した指摘がある。次にどうするか。',
      reason:
        'レビューを終えたが指摘が残った。実装への差し戻しはこれまで1回（上限3回）。' +
        '差し戻すと同じPRへ追加の修正をしてからレビューし直す。',
      options: [GATE_OPTION_SEND_BACK, GATE_OPTION_PROCEED, GATE_OPTION_ASK_USER],
      recommended: GATE_OPTION_PROCEED,
      evidence: 'レビューの結果:\n残った指摘',
    });
  });

  it('レビューが通過しなかった関門は「進める」を選択肢から外し、差し戻しを推奨にする（Issue #1711）', () => {
    const task = reviewedTask('T1', reviewResult(false, ['mediumの指摘']));
    const run = withOpenGate(makeRun([task]), 'T1', 'g1', 'reviewFindings');
    const question = buildGateQuestion(task, gateOf(run, 'T1', 'g1'));
    expect(question.options).toEqual([GATE_OPTION_SEND_BACK, GATE_OPTION_ASK_USER]);
    expect(question.recommended).toBe(GATE_OPTION_SEND_BACK);
    expect(question.reason).toContain('これまで0回');
  });

  it('工程の失敗の関門はやり直すかユーザーに上げるかを聞き、推奨を付けない', () => {
    const task = haltedTask('T1');
    const run = withOpenGate(makeRun([task]), 'T1', 'g1', 'stageFailed', 'テストが落ちた');
    const question = buildGateQuestion(task, gateOf(run, 'T1', 'g1'));
    expect(question).toEqual({
      question: 'T1の「実装とPR作成」が止まった。次にどうするか。',
      reason:
        '工程が失敗または要対応で止まった。自動のやり直しはこれまで0回（上限3回）。' +
        '一時的な失敗ならやり直し、同じ原因で繰り返しそうならユーザーに上げる。',
      options: [GATE_OPTION_RETRY, GATE_OPTION_ASK_USER],
      recommended: undefined,
      evidence: '止まった理由: テストが落ちた',
    });
  });

  it('自動のやり直しの回数はReflexとオーケストレーターの分だけ数える', () => {
    const task = haltedTask('T1', {
      gates: [
        resolvedRetryGate('old1', 'implement', 'reflex'),
        resolvedRetryGate('old2', 'implement', 'orchestrator'),
        resolvedRetryGate('old3', 'implement', 'user'),
        resolvedRetryGate('old4', 'review', 'reflex'),
      ],
    });
    const run = withOpenGate(makeRun([task]), 'T1', 'g1', 'stageFailed');
    const opened = getTask(run, 'T1');
    if (opened === undefined) {
      throw new Error('タスクが無い');
    }
    expect(buildGateQuestion(opened, gateOf(run, 'T1', 'g1')).reason).toContain('これまで2回');
  });
});

describe('gateChoiceFromAnswer', () => {
  it.each([
    ['reviewFindings', GATE_OPTION_SEND_BACK, 'sendBack'],
    ['reviewFindings', GATE_OPTION_PROCEED, 'proceed'],
    ['reviewFindings', GATE_OPTION_RETRY, undefined],
    ['reviewFindings', GATE_OPTION_ASK_USER, undefined],
    ['stageFailed', GATE_OPTION_RETRY, 'retry'],
    ['stageFailed', GATE_OPTION_SEND_BACK, undefined],
    ['stageFailed', GATE_OPTION_PROCEED, undefined],
    ['stageFailed', GATE_OPTION_ASK_USER, undefined],
    ['stageFailed', '未知の選択肢', undefined],
  ] as const)('%sで「%s」は%s', (kind, answer, expected) => {
    expect(gateChoiceFromAnswer(kind, answer)).toBe(expected);
  });
});

describe('escalateJudgingGatesOnReload', () => {
  it('判定中の関門をユーザーの判断待ちにする', () => {
    const run = withOpenGate(makeRun([haltedTask('T1')]), 'T1', 'g1', 'stageFailed');
    const next = escalateJudgingGatesOnReload(run, FIXTURE_NOW);
    expect(gateOf(next, 'T1', 'g1')).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: '再読み込みでReflexの判定が途切れた',
    });
  });

  it('オーケストレーターの判断待ちの関門は、要約へ理由を足してユーザーの判断待ちにする', () => {
    const opened = withOpenGate(
      makeRun([reviewedTask('T1', reviewResult(true, ['lowの指摘']))]),
      'T1',
      'g1',
      'reviewFindings',
    );
    const run = markGateAwaitingOrchestrator(opened, 'T1', 'g1', '回答者判定: オーケストレーター', FIXTURE_NOW);
    expect(gateOf(run, 'T1', 'g1').status).toBe('awaitingOrchestrator');
    const next = escalateJudgingGatesOnReload(run, FIXTURE_NOW);
    expect(gateOf(next, 'T1', 'g1')).toMatchObject({
      status: 'awaitingUser',
      reflexSummary: '回答者判定: オーケストレーター\n再読み込みでオーケストレーターの判断が途切れた',
    });
    expect(getTask(next, 'T1')?.attention).toBe('awaitingUser');
  });

  it('ユーザーの判断待ち・決着済みの関門と関門の無いタスクはそのまま', () => {
    const awaitingUser = withOpenGate(
      makeRun([haltedTask('T1', { gates: [resolvedRetryGate('old', 'implement', 'reflex')] }), haltedTask('T2')]),
      'T1',
      'g1',
      'stageFailed',
    );
    const escalated = escalateJudgingGatesOnReload(awaitingUser, FIXTURE_NOW);
    // 1回目で判断待ちになった関門は、2回目では変わらない
    expect(escalateJudgingGatesOnReload(escalated, FIXTURE_NOW)).toBe(escalated);
    expect(gateOf(escalated, 'T1', 'old').status).toBe('resolved');
    expect(getTask(escalated, 'T2')).toBe(getTask(awaitingUser, 'T2'));
  });

  it('複数のタスクの関門をまとめて扱う', () => {
    let run = makeRun([haltedTask('T1'), haltedTask('T2')]);
    run = withOpenGate(run, 'T1', 'g1', 'stageFailed');
    run = withOpenGate(run, 'T2', 'g2', 'stageFailed');
    const next = escalateJudgingGatesOnReload(run, FIXTURE_NOW);
    expect(gateOf(next, 'T1', 'g1').status).toBe('awaitingUser');
    expect(gateOf(next, 'T2', 'g2').status).toBe('awaitingUser');
  });
});
