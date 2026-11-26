import { describe, expect, it } from 'vitest';
import {
  extractRoadmapGoal,
  GOAL_TEXT_MAX_LENGTH,
  MAX_GOAL_REVISIONS,
  parseGoalInput,
  readTaskRunGoal,
  readTaskRunGoalRevisions,
  setTaskRunGoal,
} from '../../src/orchestrator/taskRunGoal';
import { mergeReviewBody } from '../../src/orchestrator/taskRunOrchestrator';
import {
  AUTO_APPROVED_TASK_RUN_ORCHESTRATOR_TOOLS,
  formatTaskRunState,
  parseTaskRunOrchestratorCall,
  TASK_RUN_ORCHESTRATOR_TOOLS,
} from '../../src/orchestrator/taskRunOrchestratorTools';
import {
  approveTaskPlan,
  createTaskRun,
  proposeTaskPlan,
  type TaskRun,
} from '../../src/orchestrator/taskRunState';
import { buildTaskRunKanban } from '../../src/view/taskRunKanbanModel';

/** Issue #2193: runの目的（goal）の受け取り・既定値・修正・表示。 */

const NOW = new Date('2026-11-26T00:00:00Z');
const none = new Map();

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  const created = createTaskRun({
    runId: 'run-1',
    workspaceRoot: '/ws',
    engine: 'codex',
    maxParallel: 2,
    now: NOW,
  });
  const run = approveTaskPlan(
    proposeTaskPlan(
      created,
      [
        {
          taskId: 'T1',
          title: 'タスクT1',
          summary: '要約',
          acceptanceCriteria: ['基準'],
          dependsOn: [],
          existingIssueNumber: undefined,
        },
      ],
      (id) => `exec-${id}`,
      NOW,
    ),
  );
  return { ...run, ...overrides };
}

function task(run: TaskRun) {
  const t = run.tasks['T1'];
  if (t === undefined) {
    throw new Error('T1が無い');
  }
  return t;
}

/** 以前の版（Issue #2088）がロードマップのrunへ入れていた固定文のgoal。 */
const LEGACY_GOAL = {
  objective: 'ロードマップの題',
  completionCriteria: 'ロードマップIssue #1457の目的を満たす観測できる結果が揃う',
};

describe('parseGoalInput', () => {
  it('省略はgoalなし、両方の文があれば1行へ均して出所を付ける', () => {
    expect(parseGoalInput(undefined, 'start')).toEqual({ ok: true, value: undefined });
    expect(
      parseGoalInput({ objective: '速く\nする', completionCriteria: ' 1秒以内 ' }, 'start'),
    ).toEqual({
      ok: true,
      value: { objective: '速く する', completionCriteria: '1秒以内', source: 'start' },
    });
  });

  it('形が違う・空・上限超えは断る', () => {
    expect(parseGoalInput('目的', 'start').ok).toBe(false);
    expect(parseGoalInput({ objective: '目的' }, 'start').ok).toBe(false);
    expect(parseGoalInput({ objective: ' ', completionCriteria: 'x' }, 'start').ok).toBe(false);
    expect(
      parseGoalInput(
        { objective: 'あ'.repeat(GOAL_TEXT_MAX_LENGTH + 1), completionCriteria: 'x' },
        'start',
      ).ok,
    ).toBe(false);
    expect(
      parseGoalInput(
        { objective: 'あ'.repeat(GOAL_TEXT_MAX_LENGTH), completionCriteria: 'x' },
        'start',
      ).ok,
    ).toBe(true);
  });
});

describe('extractRoadmapGoal', () => {
  it('「目的」「完了条件」の節を次の同じレベルの見出しまで読み、行を1行へつなぐ', () => {
    const body = [
      '# ロードマップ',
      '## 目的',
      '- 起動を速くする',
      '<!-- 計画区画 -->',
      '### 補足',
      '1. 体感で分かる',
      '## 完了条件',
      '- 起動が1秒以内',
      '- 計測が残る',
      '## 子Issue',
      '- [ ] #1 子',
    ].join('\n');
    expect(extractRoadmapGoal(body, '題')).toEqual({
      objective: '起動を速くする / 補足 / 体感で分かる',
      completionCriteria: '起動が1秒以内 / 計測が残る',
      source: 'roadmap',
    });
  });

  it('完了条件の節だけなら目的はロードマップの題、目的の節だけなら完了条件を省く', () => {
    expect(extractRoadmapGoal('## 完了条件\n- 動く', '題')).toEqual({
      objective: '題',
      completionCriteria: '動く',
      source: 'roadmap',
    });
    expect(extractRoadmapGoal('## 目的\n速くする', '題')).toEqual({
      objective: '速くする',
      source: 'roadmap',
    });
  });

  it('節が無い・空・コードブロックの中の見出しだけならgoalを置かない', () => {
    expect(extractRoadmapGoal('# RM\n- [ ] #1 子', '題')).toBeUndefined();
    expect(extractRoadmapGoal('## 目的\n\n## 完了条件\n', '題')).toBeUndefined();
    expect(extractRoadmapGoal('```\n## 目的\n偽\n```\n- [ ] #1', '題')).toBeUndefined();
  });
});

describe('readTaskRunGoal（保存済みrunの読み込み）', () => {
  it('項目の無い・形の壊れた保存データは目的なしと読む', () => {
    expect(readTaskRunGoal(makeRun())).toBeUndefined();
    expect(readTaskRunGoal({ goal: { objective: 1 } as never })).toBeUndefined();
    expect(readTaskRunGoal({ goal: 'x' as never })).toBeUndefined();
    expect(readTaskRunGoalRevisions({ goalRevisions: 'x' as never })).toEqual([]);
    expect(
      readTaskRunGoalRevisions({ goalRevisions: [{ reason: 'r', at: 'a' }, 3] as never }),
    ).toEqual([{ reason: 'r', at: 'a' }]);
  });

  it('以前の版の固定文のgoalは目的なしと読み、get_run_stateとmerge時の促しは壊れない', () => {
    const run = makeRun({ goal: LEGACY_GOAL });
    expect(readTaskRunGoal(run)).toBeUndefined();
    const { text } = formatTaskRunState(run, none);
    expect(text).toContain('goal: なし（以前の版が入れた固定文');
    const body = mergeReviewBody(run, task(run), 'T1 タスクT1');
    expect(body).not.toContain('目的:');
    expect(body).not.toContain('観測できる結果が揃う');
    expect(body).toContain('run全体の集計:');
    expect(buildTaskRunKanban([run], 'run-1', ['/ws']).run?.goal).toBeUndefined();
  });

  it('出所の無いgoalでも固定文でなければ使う（保存データの文に改行があっても1行に均す）', () => {
    const run = makeRun({ goal: { objective: '目的\n- 偽', completionCriteria: '条件' } });
    expect(readTaskRunGoal(run)).toEqual({ objective: '目的 - 偽', completionCriteria: '条件' });
  });
});

describe('get_run_stateとmerge時の促しのgoal', () => {
  const goal = {
    objective: '起動が速い',
    completionCriteria: '起動が1秒以内',
    source: 'start' as const,
  };

  it('goalをタスク一覧と同じ囲いの中に出所と一緒に出す', () => {
    const { text } = formatTaskRunState(makeRun({ goal }), none);
    const open = text.search(/taskRun\.tasksの出力（[^）]*）ここから/);
    const at = text.indexOf('目的: 起動が速い');
    const close = text.indexOf('taskRun.tasksの出力ここまで');
    expect(text).toContain('goal（起動時に指定）:');
    expect(text).toContain('完了条件: 起動が1秒以内');
    expect(open).toBeGreaterThan(-1);
    expect(open < at && at < close).toBe(true);
  });

  it('goalが無いrunは置き方を案内する', () => {
    expect(formatTaskRunState(makeRun(), none).text).toContain('goal: なし（');
  });

  it('merge時の促しはgoalをformatUntrustedで囲み、完了条件に照らすよう求める', () => {
    const run = makeRun({ goal });
    const body = mergeReviewBody(run, task(run), 'T1 タスクT1');
    const open = body.search(/run-1\.goalの出力（[^）]*）ここから/);
    const at = body.indexOf('完了条件: 起動が1秒以内');
    const close = body.indexOf('run-1.goalの出力ここまで');
    expect(open).toBeGreaterThan(-1);
    expect(open < at && at < close).toBe(true);
    expect(body).toContain('完了条件を満たしたか確かめ');
  });

  it('goalが無いrunのmerge時の促しは目的の文を出さず集計だけを添える', () => {
    const run = makeRun();
    const body = mergeReviewBody(run, task(run), 'T1 タスクT1');
    expect(body).not.toContain('目的:');
    expect(body).not.toContain('完了条件');
    expect(body).toContain('run全体の集計:');
  });
});

describe('set_goal（Issue #2193）', () => {
  it('ツールを出し、自動承認の集合に入れる', () => {
    expect(TASK_RUN_ORCHESTRATOR_TOOLS.some((t) => t.name === 'set_goal')).toBe(true);
    expect(AUTO_APPROVED_TASK_RUN_ORCHESTRATOR_TOOLS.has('set_goal')).toBe(true);
  });

  it('目的・完了条件・理由を確かめて受け取る。理由が無ければ断る', () => {
    expect(
      parseTaskRunOrchestratorCall('set_goal', {
        objective: '目的',
        completionCriteria: '条件',
        reason: ' 利用者が示した ',
      }),
    ).toEqual({
      ok: true,
      call: {
        tool: 'set_goal',
        goal: { objective: '目的', completionCriteria: '条件', source: 'orchestrator' },
        reason: '利用者が示した',
      },
    });
    expect(
      parseTaskRunOrchestratorCall('set_goal', { objective: '目的', completionCriteria: '条件' })
        .ok,
    ).toBe(false);
    expect(parseTaskRunOrchestratorCall('set_goal', { objective: '目的', reason: 'r' }).ok).toBe(
      false,
    );
  });

  it('直すと理由と前のgoalを記録し、get_run_stateとKanbanに残る', () => {
    const before = makeRun({
      goal: { objective: '前', completionCriteria: '前の条件', source: 'roadmap' },
    });
    const run = setTaskRunGoal(
      before,
      { objective: '後', completionCriteria: '後の条件', source: 'orchestrator' },
      '観測できる条件にした',
      '2026-11-26T01:00:00.000Z',
    );
    expect(run.goal).toEqual({
      objective: '後',
      completionCriteria: '後の条件',
      source: 'orchestrator',
    });
    expect(run.goalRevisions).toEqual([
      {
        reason: '観測できる条件にした',
        at: '2026-11-26T01:00:00.000Z',
        previous: { objective: '前', completionCriteria: '前の条件', source: 'roadmap' },
      },
    ]);
    const { text } = formatTaskRunState(run, none);
    expect(text).toContain('goal（set_goalで修正）:');
    expect(text).toContain('理由: 観測できる条件にした（前の目的: 前）');
    const kanban = buildTaskRunKanban([run], 'run-1', ['/ws']).run?.goal;
    expect(kanban).toEqual({
      objective: '後',
      completionCriteria: '後の条件',
      revisionCount: 1,
      revisions: [{ reason: '観測できる条件にした', at: '2026-11-26T01:00:00.000Z' }],
    });
  });

  it('記録は上限の件数まで残す', () => {
    let run = makeRun();
    for (let i = 0; i < MAX_GOAL_REVISIONS + 3; i += 1) {
      run = setTaskRunGoal(
        run,
        { objective: `目的${String(i)}`, completionCriteria: 'c', source: 'orchestrator' },
        `理由${String(i)}`,
        NOW.toISOString(),
      );
    }
    const revisions = readTaskRunGoalRevisions(run);
    expect(revisions).toHaveLength(MAX_GOAL_REVISIONS);
    expect(revisions[0]?.reason).toBe('理由3');
    expect(revisions[0]?.previous).toBeDefined();
  });

  it('start_runはgoalを受け取り、不正なgoalは断る', () => {
    const parsed = parseTaskRunOrchestratorCall('start_run', {
      title: '新しいrun',
      goal: { objective: '目的', completionCriteria: '条件' },
    });
    expect(parsed).toMatchObject({
      ok: true,
      call: { goal: { objective: '目的', completionCriteria: '条件', source: 'start' } },
    });
    expect(
      parseTaskRunOrchestratorCall('start_run', { title: 't', goal: { objective: '目的' } }).ok,
    ).toBe(false);
    expect(parseTaskRunOrchestratorCall('start_run', { title: 't' })).toMatchObject({
      ok: true,
      call: { goal: undefined },
    });
  });
});
