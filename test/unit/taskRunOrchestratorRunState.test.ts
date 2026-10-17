import { describe, expect, it } from 'vitest';
import { openStageGate } from '../../src/orchestrator/taskRunGates';
import {
  formatTaskRunState,
  formatTaskRunSummary,
  parseTaskRunOrchestratorCall,
} from '../../src/orchestrator/taskRunOrchestratorTools';
import {
  approveTaskPlan,
  createTaskRun,
  proposeTaskPlan,
  type TaskDraft,
  type TaskRun,
} from '../../src/orchestrator/taskRunState';

/** Issue #1980: get_run_stateの差分取得・full・taskIds・完了済みタスクの畳み込み。 */

const NOW = new Date('2026-10-18T00:00:00Z');

function draft(taskId: string, overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    taskId,
    title: `タスク${taskId}`,
    summary: '要約',
    acceptanceCriteria: ['基準'],
    dependsOn: [],
    existingIssueNumber: undefined,
    ...overrides,
  };
}

/** T1・T2は未着手、T3はロードマップで完了済み（全工程を飛ばした）のrun。 */
function makeRun(): TaskRun {
  const created = createTaskRun({
    runId: 'run-1',
    workspaceRoot: '/ws',
    engine: 'codex',
    maxParallel: 2,
    now: NOW,
  });
  const run = { ...created, taskOrder: ['T1', 'T2', 'T3'], nextTaskNumber: 4 };
  return approveTaskPlan(
    proposeTaskPlan(
      run,
      [
        draft('T1'),
        draft('T2', { existingIssueNumber: 12 }),
        draft('T3', { existingIssueNumber: 13, completedInRoadmap: true }),
      ],
      (id) => `exec-${id}`,
      NOW,
    ),
  );
}

/** T2の実装工程を実行中にする。 */
function advanceT2(run: TaskRun): TaskRun {
  const t2 = run.tasks['T2'];
  if (t2 === undefined) {
    throw new Error('T2が無い');
  }
  return {
    ...run,
    tasks: {
      ...run.tasks,
      T2: {
        ...t2,
        stages: { ...t2.stages, implement: { ...t2.stages.implement, status: 'running' } },
      },
    },
  };
}

const none = new Map();

describe('get_run_stateの差分取得（Issue #1980）', () => {
  it('同じ世代で2回続けて呼び状態が変わらなければ、2回目はタスク行が無く「変化なし」の1行だけになる', () => {
    const run = makeRun();
    const first = formatTaskRunState(run, none);
    expect(first.text).toContain('- T1 タスクT1');
    expect(first.text).toContain('- T2 タスクT2');
    expect(first.text).toContain('- T3 タスクT3');
    expect(first.text).toContain('初めての呼出し');

    const second = formatTaskRunState(run, none, [], undefined, first.shown);
    expect(second.text).not.toMatch(/^- T\d/m);
    expect(second.text).not.toContain('現在の工程:');
    expect(second.text).toContain('変化なし: 3件（T1, T2, T3）');
    expect(second.text).toContain('判断待ちの工程:');
  });

  it('2回の間に1タスクの工程が進むと、2回目はそのタスクの行だけが出る', () => {
    const run = makeRun();
    const first = formatTaskRunState(run, none);
    const second = formatTaskRunState(advanceT2(run), none, [], undefined, first.shown);
    expect(second.text).toContain('- T2 タスクT2');
    expect(second.text).toContain('implement=running');
    expect(second.text).not.toContain('- T1 タスクT1');
    expect(second.text).not.toContain('- T3 タスクT3');
    expect(second.text).toContain('変化なし: 2件（T1, T3）');
  });

  it('開いている関門があるタスクは、行が変わらなくても「変化なし」にせず毎回返す', () => {
    const run = advanceT2(makeRun());
    const t2 = run.tasks['T2'];
    if (t2 === undefined) {
      throw new Error('T2が無い');
    }
    const halted = {
      ...run,
      tasks: {
        ...run.tasks,
        T2: {
          ...t2,
          stages: {
            ...t2.stages,
            implement: { ...t2.stages.implement, status: 'halted' as const },
          },
        },
      },
    };
    const gated = openStageGate(
      halted,
      'T2',
      { gateId: 'g1', kind: 'stageFailed', detail: '失敗した' },
      NOW,
    );
    const first = formatTaskRunState(gated, none);
    expect(first.text).toContain('関門 gateId=g1');
    const second = formatTaskRunState(gated, none, [], undefined, first.shown);
    expect(second.text).toContain('関門 gateId=g1');
    expect(second.text).toContain('- T2 タスクT2');
    expect(second.text).toContain('変化なし: 2件（T1, T3）');
  });

  it('前回の記録が無ければ（新しい世代・圧縮の後）全タスクを返す', () => {
    const run = makeRun();
    formatTaskRunState(run, none);
    const fresh = formatTaskRunState(run, none, [], undefined, undefined);
    expect(fresh.text).toContain('- T1 タスクT1');
    expect(fresh.text).toContain('- T2 タスクT2');
    expect(fresh.text).not.toContain('変化なし');
  });

  it('full: trueは全タスクを返し、完了済みのタスクは1行に畳む', () => {
    const run = makeRun();
    const first = formatTaskRunState(run, none);
    const full = formatTaskRunState(run, none, [], { full: true, taskIds: undefined }, first.shown);
    expect(full.text).toContain('- T1 タスクT1');
    expect(full.text).toContain('- T2 タスクT2');
    expect(full.text).toMatch(/- T3 タスクT3 \/ Issue #13 \/ 終わり方: ロードマップで完了済み/);
    expect(full.text).not.toContain('変化なし');
    expect(full.text.match(/現在の工程:/g)?.length).toBe(2);
  });

  it('taskIdsで指定したタスクは完了済みでも全項目で返り、ほかのタスクは出ない', () => {
    const run = makeRun();
    const view = formatTaskRunState(run, none, [], { full: false, taskIds: ['T3', 'T9'] });
    expect(view.text).toContain('- T3 タスクT3');
    expect(view.text).toContain('現在の工程: 完了');
    expect(view.text).toContain('ロードマップで完了済み（全工程を飛ばした');
    expect(view.text).not.toContain('- T1');
    expect(view.text).toContain('見つからないtaskId: T9');
  });

  it('計画から外れたタスクを知らせ、記録から消す', () => {
    const run = makeRun();
    const first = formatTaskRunState(run, none);
    const removed = { ...run, taskOrder: ['T1', 'T2'] };
    const second = formatTaskRunState(removed, none, [], undefined, first.shown);
    expect(second.text).toContain('計画から外れたタスク: T3');
    expect(second.shown.has('T3')).toBe(false);
  });

  it('導入文向けの要約はタスク数と状態別の件数を1行で返す', () => {
    const summary = formatTaskRunSummary(advanceT2(makeRun()));
    expect(summary).toBe(
      'run: run-1 / 計画: approved / タスク: 3件（完了1 / 実行中1 / 停止中0 / 未着手1） / 判断待ちの工程: 1件',
    );
    expect(summary).not.toContain('\n');
  });
});

describe('get_run_stateの引数の検証（Issue #1980）', () => {
  it('引数なしは差分、fullとtaskIdsを受け取る', () => {
    expect(parseTaskRunOrchestratorCall('get_run_state', {})).toEqual({
      ok: true,
      call: { tool: 'get_run_state', request: { full: false, taskIds: undefined } },
    });
    expect(
      parseTaskRunOrchestratorCall('get_run_state', { full: true, taskIds: ['T1', 'T1', 'T2'] }),
    ).toEqual({
      ok: true,
      call: { tool: 'get_run_state', request: { full: true, taskIds: ['T1', 'T2'] } },
    });
  });

  it('不正なfull・taskIdsは断る', () => {
    expect(parseTaskRunOrchestratorCall('get_run_state', { full: 'yes' }).ok).toBe(false);
    expect(parseTaskRunOrchestratorCall('get_run_state', { taskIds: [] }).ok).toBe(false);
    expect(parseTaskRunOrchestratorCall('get_run_state', { taskIds: ['x'] }).ok).toBe(false);
    expect(parseTaskRunOrchestratorCall('get_run_state', { taskIds: 'T1' }).ok).toBe(false);
  });
});
