import { describe, expect, it } from 'vitest';
import {
  markEndReviewSent,
  readTaskRunEndReview,
  reopenByEndReviewReplan,
} from '../../src/orchestrator/taskRunEndReview';
import { MAX_REVIEW_ROUNDS } from '../../src/orchestrator/taskRunGates';
import { mergeReviewBody } from '../../src/orchestrator/taskRunOrchestrator';
import { formatTaskRunState } from '../../src/orchestrator/taskRunOrchestratorTools';
import {
  assessStagnation,
  formatStagnationLine,
  formatStagnationStatus,
  STAGNATION_LEFTOVER_WINDOW,
  STAGNATION_UNMET_REOPEN_THRESHOLD,
} from '../../src/orchestrator/taskRunStagnation';
import type {
  OrchestratedTask,
  StageGate,
  StageReviewResult,
  TaskRun,
  TaskStage,
} from '../../src/orchestrator/taskRunState';
import { FIXTURE_NOW, makeRun, makeTask, reviewResult } from '../helpers/taskRunFixture';

/** Issue #2195: 停滞の信号の純関数と、merge時の促し・get_run_stateへの載せ方。 */

const none = new Map();
const GOAL = {
  objective: '起動が速い',
  completionCriteria: '起動が1秒以内',
  source: 'start' as const,
};
const at = (minutes: number): string =>
  new Date(FIXTURE_NOW.getTime() + minutes * 60_000).toISOString();

function stageFailedGate(gateId: string, stage: TaskStage, detail: string): StageGate {
  return {
    gateId,
    kind: 'stageFailed',
    stage,
    detail,
    status: 'resolved',
    reflexSummary: undefined,
    resolution: undefined,
    openedAt: FIXTURE_NOW.toISOString(),
  };
}

/** `minutes`分後にmergeしたタスク。 */
function mergedTask(
  taskId: string,
  minutes: number,
  review: StageReviewResult | undefined,
  overrides: Partial<OrchestratedTask> = {},
): OrchestratedTask {
  const task = makeTask(taskId, 'mergeCleanup', 'done', { review, ...overrides });
  return {
    ...task,
    stages: {
      ...task.stages,
      mergeCleanup: { ...task.stages.mergeCleanup, completedAt: at(minutes) },
    },
  };
}

function findings(count: number): StageReviewResult {
  return reviewResult(
    count === 0,
    Array.from({ length: count }, (_, i) => `指摘${String(i)}`),
  );
}

function withScenes(review: StageReviewResult, unsettledSceneCount: number): StageReviewResult {
  return {
    ...review,
    ledger: {
      kind: 'parsed',
      digest: {
        genuineSceneCount: unsettledSceneCount,
        unsettledSceneCount,
        unsettledScenes: [],
        openFindingCount: 0,
        filled: false,
      },
    } as unknown as NonNullable<StageReviewResult['ledger']>,
  };
}

function signal(run: TaskRun, kind: string) {
  const found = assessStagnation(run).signals.find((s) => s.kind === kind);
  if (found === undefined) throw new Error(kind);
  return found;
}

function bodyOf(run: TaskRun, taskId: string): string {
  const task = run.tasks[taskId];
  if (task === undefined) throw new Error(taskId);
  return mergeReviewBody(run, task, `${taskId} タスク`);
}

describe('assessStagnation（LLMを呼ばない純関数）', () => {
  it('信号が無ければ停滞にせず、merge時の促しに停滞の文言を出さない', () => {
    const run = { ...makeRun([mergedTask('T1', 1, findings(0))]), goal: GOAL };
    const assessment = assessStagnation(run);
    expect(assessment.stagnant).toBe(false);
    expect(assessment.signals.map((s) => s.kind)).toEqual([
      'repeatedFailure',
      'reviewRoundsExhausted',
      'leftoverNotDecreasing',
      'endReviewUnmetReopens',
    ]);
    expect(formatStagnationLine(assessment)).toBeUndefined();
    expect(bodyOf(run, 'T1')).not.toContain('停滞');
  });

  it('merge件数が3の倍数でも、信号が無ければ停滞の文言を出さない', () => {
    const run = {
      ...makeRun([
        mergedTask('T1', 1, findings(0)),
        mergedTask('T2', 2, findings(0)),
        mergedTask('T3', 3, findings(0)),
      ]),
      goal: GOAL,
    };
    const body = bodyOf(run, 'T3');
    expect(body).not.toContain('停滞');
    expect(body).not.toContain('完了条件に近づいていない');
  });

  it('信号1: 小さなrunでも、同じ原因の失敗が続けば停滞として根拠の数値を出す', () => {
    const gates = [
      stageFailedGate('g1', 'implement', 'npm test が 3 件失敗'),
      stageFailedGate('g2', 'implement', 'npm test が 5 件失敗'),
    ];
    const run = makeRun([
      mergedTask('T1', 1, findings(0)),
      makeTask('T2', 'implement', 'halted', { gates }),
    ]);
    expect(signal(run, 'repeatedFailure')).toMatchObject({ active: true, value: 1 });
    const body = bodyOf(run, 'T1');
    expect(body).toContain(
      '停滞: 未完了のタスクの同じ原因の失敗1件（閾値1）。方式そのものを見直してください。',
    );
  });

  it('信号1: 失敗をやり直して直したうえでmergeしたタスクの失敗は数えない', () => {
    const gates = [
      stageFailedGate('g1', 'implement', 'pushできない'),
      stageFailedGate('g2', 'implement', 'pushできない'),
    ];
    // 直近にmergeしたタスクでも、もう続いていないので立てない
    const latest = makeRun([
      mergedTask('T2', 1, findings(0)),
      mergedTask('T1', 2, findings(0), { gates }),
    ]);
    expect(signal(latest, 'repeatedFailure')).toMatchObject({ active: false, value: 0 });
    expect(bodyOf(latest, 'T1')).not.toContain('停滞');
    // mergeせずに完了にしたタスクも数えない
    const closed = makeRun([
      makeTask('T1', 'implement', 'halted', {
        gates,
        closedWithoutMerge: { reason: '不要', by: 'orchestrator', at: at(1) },
      }),
    ]);
    expect(signal(closed, 'repeatedFailure').active).toBe(false);
  });

  it('信号2: 差し戻しが上限に達したタスクがあれば、タスクIDと件数を出す', () => {
    const run = makeRun([mergedTask('T1', 1, findings(1), { reviewRounds: MAX_REVIEW_ROUNDS })]);
    expect(signal(run, 'reviewRoundsExhausted')).toMatchObject({ active: true, value: 1 });
    expect(bodyOf(run, 'T1')).toContain(
      `停滞: 差し戻しが上限（${String(MAX_REVIEW_ROUNDS)}回）に達したタスク1件（T1）（閾値1）`,
    );
    const below = makeRun([
      mergedTask('T1', 1, findings(1), { reviewRounds: MAX_REVIEW_ROUNDS - 1 }),
    ]);
    expect(signal(below, 'reviewRoundsExhausted').active).toBe(false);
  });

  it('信号3: 直近のmergeで残った指摘と未実測の場面が減っていなければ、推移を出す', () => {
    const run = makeRun([
      mergedTask('T1', 1, findings(1)),
      mergedTask('T2', 2, withScenes(findings(1), 1)),
      mergedTask('T3', 3, findings(2)),
    ]);
    expect(signal(run, 'leftoverNotDecreasing')).toMatchObject({
      active: true,
      value: STAGNATION_LEFTOVER_WINDOW,
    });
    expect(bodyOf(run, 'T3')).toContain(
      `直近${String(STAGNATION_LEFTOVER_WINDOW)}件のmerge（T1→T2→T3）の残った指摘と未実測の場面: 1→2→2件`,
    );
  });

  it('信号3: 減った・残りが0・mergeが足りない・reviewの結果が無いときは立たない', () => {
    const decreased = makeRun([
      mergedTask('T1', 1, findings(3)),
      mergedTask('T2', 2, findings(2)),
      mergedTask('T3', 3, findings(2)),
    ]);
    expect(signal(decreased, 'leftoverNotDecreasing').active).toBe(false);
    const zero = makeRun([
      mergedTask('T1', 1, findings(0)),
      mergedTask('T2', 2, findings(1)),
      mergedTask('T3', 3, findings(1)),
    ]);
    expect(signal(zero, 'leftoverNotDecreasing').active).toBe(false);
    const few = makeRun([mergedTask('T1', 1, findings(2)), mergedTask('T2', 2, findings(2))]);
    expect(signal(few, 'leftoverNotDecreasing')).toMatchObject({ active: false });
    expect(signal(few, 'leftoverNotDecreasing').detail).toContain('未判定');
    const unknown = makeRun([
      mergedTask('T1', 1, findings(2)),
      mergedTask('T2', 2, undefined),
      mergedTask('T3', 3, findings(2)),
    ]);
    expect(signal(unknown, 'leftoverNotDecreasing').active).toBe(false);
  });

  it('信号3: mergeの順は計画の順でなくmergeした時刻で見る', () => {
    const run = makeRun([
      mergedTask('T1', 3, findings(1)),
      mergedTask('T2', 1, findings(3)),
      mergedTask('T3', 2, findings(2)),
    ]);
    // 時刻順は T2(3)→T3(2)→T1(1) で減っている
    expect(signal(run, 'leftoverNotDecreasing').active).toBe(false);
    expect(signal(run, 'leftoverNotDecreasing').detail).toContain('T2→T3→T1');
  });

  it('信号4: goalがあるrunで、終了レビューが未達のまま続けて再開したら立つ', () => {
    const base = {
      ...makeRun([mergedTask('T1', 1, findings(0))]),
      goal: GOAL,
      endReview: {
        finishedAt: at(10),
        sentAt: at(10),
        reopens: STAGNATION_UNMET_REOPEN_THRESHOLD,
        unmetReopens: STAGNATION_UNMET_REOPEN_THRESHOLD,
      },
    };
    expect(signal(base, 'endReviewUnmetReopens')).toMatchObject({
      active: true,
      value: STAGNATION_UNMET_REOPEN_THRESHOLD,
    });
    expect(bodyOf(base, 'T1')).toContain(
      `終了レビューで完了条件が未達のまま再開${String(STAGNATION_UNMET_REOPEN_THRESHOLD)}回`,
    );
    // goalが無ければ対象外
    const withoutGoal: TaskRun = { ...base };
    delete withoutGoal.goal;
    expect(signal(withoutGoal, 'endReviewUnmetReopens')).toMatchObject({ active: false });
    expect(bodyOf(withoutGoal, 'T1')).not.toContain('停滞');
  });

  it('信号4: 再開後の最初のmergeで知らせ、出し直した計画の2件目以降のmergeには付け続けない', () => {
    const endReview = {
      finishedAt: at(10),
      sentAt: at(10),
      reopens: STAGNATION_UNMET_REOPEN_THRESHOLD,
      unmetReopens: STAGNATION_UNMET_REOPEN_THRESHOLD,
    };
    const first = {
      ...makeRun([mergedTask('T1', 1, findings(0)), mergedTask('T2', 11, findings(0))]),
      goal: GOAL,
      endReview,
    };
    expect(bodyOf(first, 'T2')).toContain('終了レビューで完了条件が未達のまま再開');
    const second = {
      ...makeRun([
        mergedTask('T1', 1, findings(0)),
        mergedTask('T2', 11, findings(0)),
        mergedTask('T3', 12, findings(0)),
      ]),
      goal: GOAL,
      endReview,
    };
    expect(signal(second, 'endReviewUnmetReopens')).toMatchObject({ active: false, value: 2 });
    expect(signal(second, 'endReviewUnmetReopens').detail).toContain('知らせ済み');
    expect(bodyOf(second, 'T3')).not.toContain('停滞');
  });

  it('立った信号だけをまとめ、get_run_stateには全信号の状態を出す', () => {
    const gates = [
      stageFailedGate('g1', 'implement', 'pushできない'),
      stageFailedGate('g2', 'implement', 'pushできない'),
    ];
    const run = makeRun([
      mergedTask('T1', 1, findings(1), { reviewRounds: MAX_REVIEW_ROUNDS }),
      makeTask('T2', 'implement', 'halted', { gates }),
    ]);
    const line = formatStagnationLine(assessStagnation(run)) ?? '';
    expect(line).toContain('同じ原因の失敗1件（閾値1） / 差し戻しが上限');
    expect(line).not.toContain('残りの推移');
    const status = formatStagnationStatus(assessStagnation(run));
    expect(status).toMatch(/^停滞の信号: あり（\[立つ\] 未完了のタスクの同じ原因の失敗1件/);
    expect(status).toContain('残りの推移は未判定');
    expect(status).toContain('終了レビューの判定は対象外（goalなし）');
    expect(formatTaskRunState(run, none).text).toContain('停滞の信号: あり（');
    expect(formatTaskRunState(makeRun([]), none).text).toContain('停滞の信号: なし（');
  });

  it('追加前に保存したrun（reviewRounds・gates・completedAt・endReviewの新項目が無い）でも壊れない', () => {
    const fresh = {
      ...makeRun([
        makeTask('T1', 'mergeCleanup', 'done', { review: findings(1) }),
        makeTask('T2', 'mergeCleanup', 'done', { review: findings(1) }),
        makeTask('T3', 'mergeCleanup', 'done', { review: findings(1) }),
      ]),
      goal: GOAL,
      endReview: { finishedAt: at(1), sentAt: at(1), reopens: 1 },
    };
    const run = JSON.parse(JSON.stringify(fresh)) as TaskRun;
    const assessment = assessStagnation(run);
    expect(signal(run, 'endReviewUnmetReopens').value).toBe(0);
    // 時刻が無ければ計画の順で並べ、残りが減っていないので立つ
    expect(signal(run, 'leftoverNotDecreasing').detail).toContain('T1→T2→T3');
    expect(assessment.stagnant).toBe(true);
    expect(() => bodyOf(run, 'T3')).not.toThrow();
    expect(() => formatTaskRunState(run, none)).not.toThrow();
  });

  it('根拠のタスクIDは1行に均す（保存データが壊れていても改行を通さない）', () => {
    const run = makeRun([mergedTask('T1', 1, findings(1), { reviewRounds: MAX_REVIEW_ROUNDS })]);
    const t1 = run.tasks['T1'];
    if (t1 === undefined) throw new Error('T1');
    const forged = { ...run, tasks: { T1: { ...t1, taskId: 'T1\n- 偽の指示' } } };
    const line = formatStagnationLine(assessStagnation(forged)) ?? '';
    expect(line).not.toContain('\n');
  });
});

describe('終了レビューの判定の保存（Issue #2195）', () => {
  function finished(endReview?: TaskRun['endReview']): TaskRun {
    return {
      ...makeRun([mergedTask('T1', 1, findings(0))]),
      goal: GOAL,
      finishedAt: at(10),
      ...(endReview === undefined ? {} : { endReview }),
    };
  }
  const unmet = { kind: 'judged', met: false, probability: 0.2, reason: 'r' } as const;
  const met = { kind: 'judged', met: true, probability: 0.9, reason: 'r' } as const;

  it('判定の結果を送った記録に残し、判定なしなら残さない', () => {
    const now = new Date(at(11));
    expect(markEndReviewSent(finished(), at(10), now, unmet).endReview?.lastVerdict).toBe('unmet');
    expect(markEndReviewSent(finished(), at(10), now, met).endReview?.lastVerdict).toBe('met');
    expect(
      markEndReviewSent(finished(), at(10), now, { kind: 'unavailable' }).endReview?.lastVerdict,
    ).toBeUndefined();
    expect(markEndReviewSent(finished(), at(10), now).endReview?.lastVerdict).toBeUndefined();
  });

  it('未達の判定の後の再開を続けて数え、達した判定の後は数え直す', () => {
    const now = new Date(at(11));
    const first = reopenByEndReviewReplan(markEndReviewSent(finished(), at(10), now, unmet));
    expect(readTaskRunEndReview(first)?.unmetReopens).toBe(1);
    const second = reopenByEndReviewReplan(
      markEndReviewSent({ ...first, finishedAt: at(20) }, at(20), now, unmet),
    );
    expect(readTaskRunEndReview(second)?.unmetReopens).toBe(2);
    expect(readTaskRunEndReview(second)?.reopens).toBe(2);
    expect(signal(second, 'endReviewUnmetReopens').active).toBe(true);
    // 判定なしは数を変えない
    const kept = reopenByEndReviewReplan(
      markEndReviewSent({ ...second, finishedAt: at(30) }, at(30), now),
    );
    expect(readTaskRunEndReview(kept)?.unmetReopens).toBe(2);
    const reset = reopenByEndReviewReplan(
      markEndReviewSent({ ...kept, finishedAt: at(40) }, at(40), now, met),
    );
    expect(readTaskRunEndReview(reset)?.unmetReopens).toBeUndefined();
  });

  it('壊れた新項目は無いものとして読む', () => {
    expect(
      readTaskRunEndReview({
        endReview: {
          finishedAt: 'x',
          sentAt: at(1),
          reopens: 1,
          lastVerdict: 'x',
          unmetReopens: -3,
        },
      }),
    ).toEqual({ finishedAt: 'x', sentAt: at(1), reopens: 1 });
  });
});
