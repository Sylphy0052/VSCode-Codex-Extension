import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MementoLike } from '../../src/util/memento';
import type { ReflexJudgeDeps } from '../../src/orchestrator/planReflexReview';
import {
  TaskRunController,
  type TaskRunControllerDeps,
} from '../../src/orchestrator/taskRunController';
import type { TaskRunLease } from '../../src/orchestrator/taskRunLease';
import { findStageGate } from '../../src/orchestrator/taskRunGates';
import { reviewGateResolution } from '../../src/orchestrator/taskRunGateReview';
import { reviewTaskRunPlanProposal } from '../../src/orchestrator/taskRunPlanReview';
import {
  addStageQuestion,
  findStageQuestion,
  markQuestionAwaitingUser,
} from '../../src/orchestrator/taskRunQuestions';
import { TaskRunStore } from '../../src/orchestrator/taskRunStore';
import {
  MAX_TASK_RUN_PARALLEL,
  createTaskRun,
  getTask,
  type OrchestratedTask,
  type StageGate,
  type TaskRun,
} from '../../src/orchestrator/taskRunState';
import type { PauseStageOutcome, TaskStageRunner } from '../../src/orchestrator/taskStageRunner';
import {
  FIXTURE_NOW,
  haltedTask,
  makeRun,
  makeTask,
  reviewResult,
  withOpenGate,
} from '../helpers/taskRunFixture';

/**
 * Issue #1854・#1856: `TaskRunController`の単体テスト。storeは実物の`TaskRunStore`（メモリ上の
 * memento）、runner・観測・専有権・ロードマップはモックにする。Reflexの審査（`taskRunPlanReview`・
 * `taskRunGateReview`）は審査の中身ではなくControllerの扱いを見るためモックにする。
 */

vi.mock('../../src/orchestrator/taskRunPlanReview', () => ({
  reviewTaskRunPlanProposal: vi.fn(),
}));
vi.mock('../../src/orchestrator/taskRunGateReview', () => ({
  reviewGateResolution: vi.fn(),
}));

const reviewPlan = vi.mocked(reviewTaskRunPlanProposal);
const reviewGate = vi.mocked(reviewGateResolution);

const REFLEX = {} as ReflexJudgeDeps;
const RUN_ID = 'run-1';
const ROOT = '/tmp/ws';

function createMemento(): MementoLike {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T =>
      data.has(key) ? (data.get(key) as T) : defaultValue,
    update: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

type RunnerMock = {
  [K in keyof TaskRunControllerDeps['runner']]: ReturnType<typeof vi.fn<TaskStageRunner[K]>>;
};

interface Harness {
  controller: TaskRunController;
  store: TaskRunStore;
  runner: RunnerMock;
  logs: string[];
  observation: {
    fetchIssueState: ReturnType<
      typeof vi.fn<TaskRunControllerDeps['observation']['fetchIssueState']>
    >;
    fetchPullRequestState: ReturnType<
      typeof vi.fn<TaskRunControllerDeps['observation']['fetchPullRequestState']>
    >;
  };
}

async function setup(
  runs: readonly TaskRun[] = [],
  overrides: Partial<TaskRunControllerDeps> = {},
): Promise<Harness> {
  const store = new TaskRunStore(createMemento());
  for (const run of runs) {
    await store.update(run.runId, () => run);
  }
  const runner: RunnerMock = {
    pump: vi.fn<TaskStageRunner['pump']>().mockResolvedValue(undefined),
    stopStage: vi.fn<TaskStageRunner['stopStage']>().mockResolvedValue(true),
    stopLiveStagesOfRun: vi.fn<TaskStageRunner['stopLiveStagesOfRun']>().mockResolvedValue(0),
    pauseStage: vi
      .fn<TaskStageRunner['pauseStage']>()
      .mockResolvedValue({ ok: true, waitingForTurn: false }),
    resumeStage: vi.fn<TaskStageRunner['resumeStage']>().mockResolvedValue(true),
    instructStage: vi.fn<TaskStageRunner['instructStage']>().mockResolvedValue(true),
    answerQuestion: vi.fn<TaskStageRunner['answerQuestion']>().mockResolvedValue(true),
    cleanupRestoredTask: vi
      .fn<TaskStageRunner['cleanupRestoredTask']>()
      .mockResolvedValue(undefined),
  };
  const observation: Harness['observation'] = {
    fetchIssueState: vi
      .fn<TaskRunControllerDeps['observation']['fetchIssueState']>()
      .mockResolvedValue('open'),
    fetchPullRequestState: vi
      .fn<TaskRunControllerDeps['observation']['fetchPullRequestState']>()
      .mockResolvedValue('open'),
  };
  const logs: string[] = [];
  let seq = 0;
  const controller = new TaskRunController({
    store,
    runner,
    modelCatalog: () => ({ models: [], fallbackEfforts: [] }),
    recommendStageSettings: () => Promise.resolve(undefined),
    observation,
    pathExists: () => Promise.resolve(true),
    log: (message) => logs.push(message),
    now: () => FIXTURE_NOW,
    newId: () => `id-${String((seq += 1))}`,
    planAutoApprove: () => undefined,
    ...overrides,
  });
  return { controller, store, runner, logs, observation };
}

function stored(h: Harness, runId = RUN_ID, taskId?: string): TaskRun | OrchestratedTask {
  const run = h.store.find(runId);
  if (run === undefined) {
    throw new Error('runが無い');
  }
  if (taskId === undefined) {
    return run;
  }
  const task = getTask(run, taskId);
  if (task === undefined) {
    throw new Error('タスクが無い');
  }
  return task;
}

const runOf = (h: Harness, runId = RUN_ID): TaskRun => stored(h, runId) as TaskRun;
const taskOf = (h: Harness, taskId: string): OrchestratedTask =>
  stored(h, RUN_ID, taskId) as OrchestratedTask;

function planArgs(...ids: string[]): { tasks: object[] } {
  return {
    tasks: ids.map((id) => ({
      id,
      title: `タスク${id}`,
      summary: '概要',
      acceptanceCriteria: ['基準を満たす'],
      dependsOn: [],
    })),
  };
}

function drafting(): TaskRun {
  return createTaskRun({
    runId: RUN_ID,
    workspaceRoot: ROOT,
    engine: 'claude',
    maxParallel: 2,
    now: FIXTURE_NOW,
  });
}

function lease(overrides: Partial<TaskRunLease> = {}): TaskRunLease {
  return {
    version: 1,
    windowId: 'window-other',
    runId: RUN_ID,
    hostname: 'host-b',
    hostIdentity: '',
    pid: 4242,
    acquiredAt: FIXTURE_NOW.toISOString(),
    heartbeatAt: FIXTURE_NOW.toISOString(),
    ...overrides,
  } as TaskRunLease;
}

function leasePort(overrides: Partial<NonNullable<TaskRunControllerDeps['lease']>> = {}) {
  return {
    holds: vi.fn(() => false),
    acquire: vi.fn(() => Promise.resolve({ ok: true as const })),
    peek: vi.fn(() => Promise.resolve<TaskRunLease | undefined>(undefined)),
    forceAcquire: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as unknown as NonNullable<TaskRunControllerDeps['lease']>;
}

beforeEach(() => {
  reviewPlan.mockReset();
  reviewGate.mockReset();
});

// ---------------------------------------------------------------------------
// run の開始・一覧
// ---------------------------------------------------------------------------

describe('startRun', () => {
  it('動いているrunが無ければ新しく作って永続化し、購読者へ通知する', async () => {
    const h = await setup();
    const seen: (TaskRun | undefined)[] = [];
    h.controller.onTransition((prev, next) => seen.push(prev, next));

    const outcome = await h.controller.startRun({
      workspaceRoot: ROOT,
      engine: 'codex',
      maxParallel: 3,
      title: '  名前  ',
    });

    expect(outcome).toEqual({ ok: true, runId: 'id-1', reused: false });
    const run = runOf(h, 'id-1');
    expect(run.engine).toBe('codex');
    expect(run.maxParallel).toBe(3);
    expect(run.title).toBe('名前');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.runId).toBe('id-1');
  });

  it('同じフォルダに動いているrunがあれば再利用する。parallelなら新しく作る', async () => {
    const h = await setup([makeRun([])]);

    const reused = await h.controller.startRun({
      workspaceRoot: ROOT,
      engine: 'claude',
      maxParallel: 2,
    });
    const parallel = await h.controller.startRun({
      workspaceRoot: ROOT,
      engine: 'claude',
      maxParallel: 2,
      parallel: true,
    });

    expect(reused).toEqual({ ok: true, runId: RUN_ID, reused: true });
    expect(parallel).toEqual({ ok: true, runId: 'id-1', reused: false });
    expect(
      h.controller
        .listActive(ROOT)
        .map((r) => r.runId)
        .sort(),
    ).toEqual(['id-1', RUN_ID]);
    expect(h.controller.listInFolder(ROOT)).toHaveLength(2);
    expect(h.controller.listInFolder('/other')).toEqual([]);
  });

  it('並列上限が範囲外なら作らずに断る', async () => {
    const h = await setup();

    const outcome = await h.controller.startRun({
      workspaceRoot: ROOT,
      engine: 'claude',
      maxParallel: MAX_TASK_RUN_PARALLEL + 1,
    });

    expect(outcome.ok).toBe(false);
    expect(h.store.list()).toHaveLength(0);
  });
});

describe('通知と状態更新', () => {
  it('購読の解除後は通知しない。購読者が投げてもログに残して続ける', async () => {
    const h = await setup([makeRun([])]);
    const calls: string[] = [];
    const sub = h.controller.onTransition(() => calls.push('a'));
    h.controller.onTransition(() => {
      throw new Error('購読者の失敗');
    });

    h.controller.refreshKanban(RUN_ID);
    sub.dispose();
    h.controller.refreshKanban(RUN_ID);
    h.controller.refreshKanban('missing');

    expect(calls).toEqual(['a']);
    expect(h.logs).toHaveLength(2);
    expect(h.logs[0]).toContain('状態の通知に失敗しました');
  });

  it('updateRunは変化があったときだけ通知し、runが無ければundefinedを返す', async () => {
    const h = await setup([makeRun([])]);
    const listener = vi.fn();
    h.controller.onTransition(listener);

    expect(await h.controller.updateRun('missing', (r) => r)).toBeUndefined();
    await h.controller.updateRun(RUN_ID, (r) => r);
    expect(listener).not.toHaveBeenCalled();
    await h.controller.updateRun(RUN_ID, (r) => ({ ...r, maxParallel: 5 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.controller.find(RUN_ID)?.maxParallel).toBe(5);
  });

  it('setTitleは表示名を付け替え、runが無ければfalse', async () => {
    const h = await setup([makeRun([])]);

    expect(await h.controller.setTitle(RUN_ID, '新しい名前')).toBe(true);
    expect(runOf(h).title).toBe('新しい名前');
    expect(await h.controller.setTitle('missing', 'x')).toBe(false);
  });

  it('boardは保存したrunから盤面を作る', async () => {
    const h = await setup([makeRun([haltedTask('T1')])]);

    const board = h.controller.board(RUN_ID, [ROOT]);

    expect(JSON.stringify(board)).toContain('T1');
  });

  it('forgetは推奨値のキャッシュを捨てる', async () => {
    const recommend = vi.fn().mockResolvedValue({ model: 'm', effort: '', reason: 'r' });
    const h = await setup([makeRun([makeTask('T1', 'implement', 'notStarted')])], {
      recommendStageSettings: recommend,
    });
    const ref = { taskId: 'T1', stage: 'implement' as const };

    await h.controller.recommend(RUN_ID, ref);
    expect(h.controller.recommendations(RUN_ID).size).toBe(1);
    h.controller.forget(RUN_ID);

    expect(h.controller.recommendations(RUN_ID).size).toBe(0);
    await h.controller.recommend(RUN_ID, ref);
    expect(recommend).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 専有権
// ---------------------------------------------------------------------------

describe('専有権', () => {
  it('leaseが無ければ常に許可し、状態は他のウィンドウ保持なしと答える', async () => {
    const h = await setup([makeRun([])]);

    expect(await h.controller.ensureLease(RUN_ID)).toEqual({ ok: true, message: '' });
    expect(await h.controller.leaseStatus(RUN_ID)).toEqual({ heldByOther: false });
    expect((await h.controller.transferLease(RUN_ID)).ok).toBe(false);
  });

  it('持っていれば取り直さず、持っていなければ取る。取れなければ持ち主を示して断る', async () => {
    const port = leasePort();
    const h = await setup([makeRun([])], { lease: port });

    expect((await h.controller.ensureLease(RUN_ID)).ok).toBe(true);
    expect(port.acquire).toHaveBeenCalledTimes(1);

    vi.mocked(port.holds).mockReturnValue(true);
    expect((await h.controller.ensureLease(RUN_ID)).ok).toBe(true);
    expect(port.acquire).toHaveBeenCalledTimes(1);

    vi.mocked(port.holds).mockReturnValue(false);
    (port.acquire as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, holder: lease() });
    const rejected = await h.controller.ensureLease(RUN_ID);
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain('専有権');
  });

  it('専有権を取れない間は、状態を書き換える操作を断る', async () => {
    const port = leasePort({
      acquire: vi.fn(() => Promise.resolve({ ok: false as const, holder: lease() })),
    } as never);
    const h = await setup([makeRun([haltedTask('T1')])], { lease: port });

    const results = [
      await h.controller.setHalted(RUN_ID, true),
      await h.controller.finishRun(RUN_ID),
      await h.controller.suspendRun(RUN_ID),
      await h.controller.retryStage(RUN_ID, 'T1'),
      await h.controller.setMaxParallel(RUN_ID, 3),
      await h.controller.stopStage(RUN_ID, 'T1'),
      await h.controller.instructTask(RUN_ID, 'T1', '指示'),
    ];

    expect(results.every((r) => !r.ok)).toBe(true);
    expect(h.runner.stopStage).not.toHaveBeenCalled();
    expect(runOf(h).haltedByUser).toBe(false);
  });

  it('leaseStatusは新しいheartbeatを持つ別のウィンドウだけを「他が保持」とする', async () => {
    const port = leasePort();
    const h = await setup([makeRun([])], { lease: port });
    const peek = port.peek as ReturnType<typeof vi.fn>;

    expect(await h.controller.leaseStatus(RUN_ID)).toEqual({ heldByOther: false });

    peek.mockResolvedValue(lease());
    const fresh = await h.controller.leaseStatus(RUN_ID);
    expect(fresh.heldByOther).toBe(true);
    expect(fresh.holderText).toBeTruthy();

    peek.mockResolvedValue(lease({ heartbeatAt: '2026-09-29T00:00:00Z' }));
    expect(await h.controller.leaseStatus(RUN_ID)).toEqual({ heldByOther: false });

    peek.mockResolvedValue(lease({ heartbeatAt: 'invalid' }));
    expect(await h.controller.leaseStatus(RUN_ID)).toEqual({ heldByOther: false });

    vi.mocked(port.holds).mockReturnValue(true);
    expect(await h.controller.leaseStatus(RUN_ID)).toEqual({ heldByOther: false });
  });

  it('transferLeaseは無条件で奪い、盤面を再通知する', async () => {
    const port = leasePort();
    const h = await setup([makeRun([])], { lease: port });
    const listener = vi.fn();
    h.controller.onTransition(listener);

    const result = await h.controller.transferLease(RUN_ID);

    expect(result.ok).toBe(true);
    expect(port.forceAcquire).toHaveBeenCalledWith(RUN_ID);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('専有権を失ったら動いていた工程を止めて記録する。止められなくてもログに残す', async () => {
    const h = await setup([makeRun([])]);
    h.runner.stopLiveStagesOfRun.mockResolvedValueOnce(2);
    h.controller.handleLeaseLost(RUN_ID, lease());
    await vi.waitFor(() => expect(h.logs.some((l) => l.includes('2件止めた'))).toBe(true));

    h.runner.stopLiveStagesOfRun.mockRejectedValueOnce(new Error('停止失敗'));
    h.controller.handleLeaseLost(RUN_ID, undefined);
    await vi.waitFor(() =>
      expect(h.logs.some((l) => l.includes('止められませんでした'))).toBe(true),
    );
    expect(h.runner.stopLiveStagesOfRun).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 推奨値
// ---------------------------------------------------------------------------

describe('recommend', () => {
  const ref = { taskId: 'T1', stage: 'implement' as const };

  it('求めた推奨値を1回だけ求めて保存し、runやタスクが無ければundefined', async () => {
    const recommend = vi.fn().mockResolvedValue({ model: 'm1', effort: 'high', reason: '理由' });
    const h = await setup([makeRun([makeTask('T1', 'implement', 'notStarted')])], {
      recommendStageSettings: recommend,
    });

    const first = await h.controller.recommend(RUN_ID, ref);
    const second = await h.controller.recommend(RUN_ID, ref);

    expect(first).toEqual(second);
    expect(recommend).toHaveBeenCalledTimes(1);
    expect([...h.controller.recommendations(RUN_ID).values()]).toHaveLength(1);
    expect(await h.controller.recommend('missing', ref)).toBeUndefined();
    expect(await h.controller.recommend(RUN_ID, { ...ref, taskId: 'T9' })).toBeUndefined();
  });

  it('失敗はログに残して覚えず、次に求め直す', async () => {
    const recommend = vi
      .fn()
      .mockRejectedValueOnce(new Error('失敗'))
      .mockResolvedValueOnce({ model: 'm', effort: '', reason: 'r' });
    const h = await setup([makeRun([makeTask('T1', 'implement', 'notStarted')])], {
      recommendStageSettings: recommend,
    });

    expect(await h.controller.recommend(RUN_ID, ref)).toBeUndefined();
    expect(h.logs[0]).toContain('推奨値を求められませんでした');
    expect(await h.controller.recommend(RUN_ID, ref)).toMatchObject({ model: 'm' });
    expect(recommend).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 計画
// ---------------------------------------------------------------------------

describe('proposePlan・approvePlan', () => {
  it('不正な引数は断り、正しい計画は採番して承認待ちにする', async () => {
    const h = await setup([drafting()]);

    expect((await h.controller.proposePlan(RUN_ID, { tasks: [] })).ok).toBe(false);
    const result = await h.controller.proposePlan(RUN_ID, planArgs('a', 'b'));

    expect(result.ok).toBe(true);
    expect(result.message).toContain('a → T1');
    expect(result.message).toContain('b → T2');
    expect(runOf(h).planStatus).toBe('awaitingApproval');
    expect(runOf(h).taskOrder).toEqual(['T1', 'T2']);
    expect(h.runner.pump).not.toHaveBeenCalled();
  });

  it('runが無ければ断る', async () => {
    const h = await setup();

    const result = await h.controller.proposePlan('missing', planArgs('a'));

    expect(result).toEqual({ ok: false, message: 'runが見つからない' });
  });

  it('既存のIssueがcloseされている・確かめられない計画は断る。openなら受け付ける', async () => {
    const h = await setup([drafting()]);
    const withIssue = (n: number): { tasks: object[] } => ({
      tasks: [{ ...planArgs('a').tasks[0], existingIssueNumber: n }],
    });
    h.observation.fetchIssueState.mockResolvedValueOnce('closed');
    const closed = await h.controller.proposePlan(RUN_ID, withIssue(11));
    h.observation.fetchIssueState.mockResolvedValueOnce('unknown');
    const unknown = await h.controller.proposePlan(RUN_ID, withIssue(12));
    const open = await h.controller.proposePlan(RUN_ID, withIssue(13));

    expect(closed.message).toContain('#11はcloseされている');
    expect(unknown.message).toContain('#12を確かめられない');
    expect(open.ok).toBe(true);
    expect(h.observation.fetchIssueState).toHaveBeenCalledWith(ROOT, 13);
  });

  it('同じフォルダの別のrunが扱っているIssueを含む計画は断る', async () => {
    const other = {
      ...makeRun([makeTask('T1', 'implement', 'running', { existingIssueNumber: 21 })]),
      runId: 'run-other',
    };
    const h = await setup([drafting(), other]);

    const result = await h.controller.proposePlan(RUN_ID, {
      tasks: [{ ...planArgs('a').tasks[0], existingIssueNumber: 21 }],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('#21は別のrun');
  });

  it('planAutoApproveが有効でReflexが妥当とすれば、自動承認して工程を回す', async () => {
    reviewPlan.mockResolvedValue({ kind: 'approved', summary: '妥当' });
    const h = await setup([drafting()], {
      planAutoApprove: () => ({ reflex: REFLEX, threshold: 0.8 }),
    });

    const result = await h.controller.proposePlan(RUN_ID, planArgs('a'));

    expect(result.message).toContain('自動承認');
    expect(runOf(h).planStatus).toBe('approved');
    expect(runOf(h).planReview).toMatchObject({ autoApproved: true, summary: '妥当' });
    expect(h.runner.pump).toHaveBeenCalledWith(RUN_ID);
  });

  it('Reflexが妥当としなければ承認待ちのまま、審査の結果だけ残す', async () => {
    reviewPlan.mockResolvedValue({ kind: 'needsUser', summary: '要確認' });
    const h = await setup([drafting()], {
      planAutoApprove: () => ({ reflex: REFLEX, threshold: 0.8 }),
    });

    await h.controller.proposePlan(RUN_ID, planArgs('a'));

    expect(runOf(h).planStatus).toBe('awaitingApproval');
    expect(runOf(h).planReview).toMatchObject({ autoApproved: false, summary: '要確認' });
  });

  it('approvePlanは承認待ちの計画だけを承認して工程を回す', async () => {
    const h = await setup([drafting()]);

    expect((await h.controller.approvePlan(RUN_ID)).ok).toBe(false);
    await h.controller.proposePlan(RUN_ID, planArgs('a'));
    const approved = await h.controller.approvePlan(RUN_ID);

    expect(approved).toEqual({ ok: true, message: '計画を承認した' });
    expect(runOf(h).planStatus).toBe('approved');
    expect(h.runner.pump).toHaveBeenCalledTimes(1);
    expect((await h.controller.approvePlan(RUN_ID)).ok).toBe(false);
  });

  it('審査した計画から変わっていれば承認しない', async () => {
    const h = await setup([drafting()]);
    await h.controller.proposePlan(RUN_ID, planArgs('a'));

    const result = await h.controller.approvePlan(RUN_ID, '[]');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('計画が変わりました');
    expect(runOf(h).planStatus).toBe('awaitingApproval');
  });

  it('承認時に別のrunが同じIssueを扱い始めていれば承認しない', async () => {
    const h = await setup([drafting()]);
    await h.controller.proposePlan(RUN_ID, {
      tasks: [{ ...planArgs('a').tasks[0], existingIssueNumber: 31 }],
    });
    await h.store.update('run-other', () => ({
      ...makeRun([makeTask('T1', 'implement', 'running', { existingIssueNumber: 31 })]),
      runId: 'run-other',
    }));

    const result = await h.controller.approvePlan(RUN_ID);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('#31');
    expect(runOf(h).planStatus).toBe('awaitingApproval');
  });
});

describe('approvePlanByReview', () => {
  async function awaiting(overrides: Partial<TaskRunControllerDeps> = {}): Promise<Harness> {
    const h = await setup([drafting()], overrides);
    await h.controller.proposePlan(RUN_ID, planArgs('a'));
    return h;
  }
  const config = { planReview: () => ({ reflex: REFLEX, threshold: 0.8 }) };

  it('承認待ちでなければ決着済みとして断る', async () => {
    const h = await setup([makeRun([])]);

    const result = await h.controller.approvePlanByReview(RUN_ID);

    expect(result).toEqual({ decided: { ok: false, message: '承認待ちの計画がありません' } });
  });

  it('Reflexの審査が無効なら人に確かめる（reviewedPlanを返す）', async () => {
    const h = await awaiting();

    const result = await h.controller.approvePlanByReview(RUN_ID);

    expect(result).toMatchObject({ needsUser: { summary: undefined } });
    expect(reviewPlan).not.toHaveBeenCalled();
  });

  it('妥当と判定されれば承認する', async () => {
    reviewPlan.mockResolvedValue({ kind: 'approved', summary: '妥当' });
    const h = await awaiting(config);

    const result = await h.controller.approvePlanByReview(RUN_ID);

    expect(result).toEqual({ decided: { ok: true, message: '計画を承認した' } });
    expect(runOf(h).planReview).toMatchObject({ autoApproved: true });
  });

  it('妥当でなければ人に回し、同じ計画は審査し直さない。判定失敗は覚えず審査し直す', async () => {
    reviewPlan.mockResolvedValue({ kind: 'needsUser', summary: '要確認' });
    const h = await awaiting(config);

    const first = await h.controller.approvePlanByReview(RUN_ID);
    const second = await h.controller.approvePlanByReview(RUN_ID);

    expect(first).toMatchObject({ needsUser: { summary: '要確認' } });
    expect(second).toMatchObject({ needsUser: { summary: '要確認' } });
    expect(reviewPlan).toHaveBeenCalledTimes(1);

    const h2 = await awaiting(config);
    reviewPlan.mockResolvedValue({ kind: 'needsUser', summary: '判定なし', failed: true });
    await h2.controller.approvePlanByReview(RUN_ID);
    await h2.controller.approvePlanByReview(RUN_ID);
    expect(reviewPlan).toHaveBeenCalledTimes(3);
  });

  it('承認を拒まれたら審査の記録を自動承認でなくす', async () => {
    reviewPlan.mockResolvedValue({ kind: 'approved', summary: '妥当' });
    const h = await setup([drafting()], config);
    await h.controller.proposePlan(RUN_ID, {
      tasks: [{ ...planArgs('a').tasks[0], existingIssueNumber: 41 }],
    });
    await h.store.update('run-other', () => ({
      ...makeRun([makeTask('T1', 'implement', 'running', { existingIssueNumber: 41 })]),
      runId: 'run-other',
    }));

    const result = await h.controller.approvePlanByReview(RUN_ID);

    expect(result).toMatchObject({ decided: { ok: false } });
    expect(runOf(h).planReview?.autoApproved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run の停止・終了・中断・再開
// ---------------------------------------------------------------------------

describe('setHalted', () => {
  it('一時停止して、解くと工程を回す。runが無ければ断る', async () => {
    const h = await setup([makeRun([])]);

    expect((await h.controller.setHalted(RUN_ID, true)).message).toBe('runを一時停止した');
    expect(runOf(h).haltedByUser).toBe(true);
    expect(h.runner.pump).not.toHaveBeenCalled();
    expect((await h.controller.setHalted(RUN_ID, false)).message).toBe('runの一時停止を解いた');
    expect(h.runner.pump).toHaveBeenCalledTimes(1);
    expect((await h.controller.setHalted('missing', true)).ok).toBe(false);
  });
});

describe('finishRun', () => {
  it('実行中の工程を止めてからrunを終え、専有権を手放す', async () => {
    const port = leasePort({ holds: vi.fn(() => true) });
    const h = await setup([makeRun([makeTask('T1', 'implement', 'running')])], { lease: port });

    const result = await h.controller.finishRun(RUN_ID);

    expect(result).toEqual({ ok: true, message: 'runを終えた' });
    expect(h.runner.stopStage).toHaveBeenCalledWith(RUN_ID, 'T1');
    expect(runOf(h).finishedAt).toBeDefined();
    expect(port.release).toHaveBeenCalledWith(RUN_ID);
  });

  it('止め損ねてもログに残して終える。終わっていれば何もしない。runが無ければ断る', async () => {
    const h = await setup([makeRun([makeTask('T1', 'implement', 'running')])]);
    h.runner.stopStage.mockRejectedValueOnce(new Error('止まらない'));

    expect((await h.controller.finishRun(RUN_ID)).ok).toBe(true);
    expect(h.logs.some((l) => l.includes('T1の工程を止められませんでした'))).toBe(true);
    expect(await h.controller.finishRun(RUN_ID)).toEqual({
      ok: true,
      message: 'runは終わっている',
    });
    expect((await h.controller.finishRun('missing')).ok).toBe(false);
  });
});

describe('suspendRun・resumeRun・reopenRun', () => {
  it('中断すると工程を止め、再び中断しても成功扱い（冪等）', async () => {
    const h = await setup([makeRun([makeTask('T1', 'implement', 'running')])]);

    expect(await h.controller.suspendRun(RUN_ID)).toEqual({ ok: true, message: 'runを中断した' });
    expect(runOf(h).suspendedAt).toBeDefined();
    expect(h.runner.stopStage).toHaveBeenCalledTimes(1);
    expect(await h.controller.suspendRun(RUN_ID)).toEqual({
      ok: true,
      message: 'runは中断している',
    });
    expect((await h.controller.suspendRun('missing')).ok).toBe(false);
  });

  it('終わったrunは中断できない', async () => {
    const h = await setup([{ ...makeRun([]), finishedAt: FIXTURE_NOW.toISOString() }]);

    expect(await h.controller.suspendRun(RUN_ID)).toEqual({
      ok: false,
      message: 'runは終わっている',
    });
  });

  it('一時停止中でない再開待ちの工程は、中断で一時停止へ戻す', async () => {
    const task = makeTask('T1', 'implement', 'running', {
      currentAttemptId: 'a1',
      pause: { phase: 'resuming', reason: '理由', requestedAt: FIXTURE_NOW.toISOString() },
    } as Partial<OrchestratedTask>);
    const h = await setup([makeRun([task])]);

    await h.controller.suspendRun(RUN_ID);

    expect(taskOf(h, 'T1').pause?.phase).toBe('paused');
    expect(h.runner.stopStage).not.toHaveBeenCalled();
  });

  it('中断したrunを再開し、工程を回す', async () => {
    const h = await setup([makeRun([makeTask('T1', 'implement', 'halted')])]);
    await h.controller.suspendRun(RUN_ID);

    const result = await h.controller.resumeRun(RUN_ID);

    expect(result).toEqual({ ok: true, message: 'runを再開した' });
    expect(runOf(h).suspendedAt).toBeUndefined();
    expect(h.runner.pump).toHaveBeenCalled();
  });

  it('再開できない場合は理由を返す', async () => {
    const suspended = { ...makeRun([]), suspendedAt: FIXTURE_NOW.toISOString() };
    const active = { ...makeRun([]), runId: 'run-active' };
    const h = await setup([
      suspended,
      active,
      { ...makeRun([]), runId: 'run-done', finishedAt: 'x' },
    ]);

    expect((await h.controller.resumeRun('missing')).message).toBe('runが見つからない');
    expect((await h.controller.resumeRun('run-done')).message).toBe('runは終わっている');
    expect((await h.controller.resumeRun('run-active')).message).toBe('runは中断していない');
    const blocked = await h.controller.resumeRun(RUN_ID);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('先にそのrunを中断する');
    expect((await h.controller.resumeRun(RUN_ID, { parallel: true })).ok).toBe(true);
  });

  it('終わったrunを再び動かす。動いているrunは断る', async () => {
    const done = {
      ...makeRun([makeTask('T1', 'implement', 'halted')]),
      finishedAt: FIXTURE_NOW.toISOString(),
    };
    const h = await setup([done, { ...makeRun([]), runId: 'run-active' }]);

    expect((await h.controller.reopenRun('missing')).ok).toBe(false);
    expect((await h.controller.reopenRun('run-active')).message).toBe('runは動いている');
    expect(await h.controller.reopenRun(RUN_ID)).toEqual({ ok: true, message: 'runを再開した' });
    expect(runOf(h).finishedAt).toBeUndefined();
    expect(h.runner.pump).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// やり直し・完了にする
// ---------------------------------------------------------------------------

describe('retryStage', () => {
  it('止まった工程を未着手へ戻す', async () => {
    const h = await setup([makeRun([haltedTask('T1')])]);

    const result = await h.controller.retryStage(RUN_ID, 'T1');

    expect(result.ok).toBe(true);
    expect(taskOf(h, 'T1').stages.implement.status).toBe('notStarted');
  });

  it('失敗の関門が開いていれば、ユーザーの「やり直す」で決着させる', async () => {
    const run = withOpenGate(makeRun([haltedTask('T1')]), 'T1', 'g1', 'stageFailed');
    const h = await setup([run]);

    const result = await h.controller.retryStage(RUN_ID, 'T1');

    expect(result.ok).toBe(true);
    expect(findStageGate(runOf(h), 'T1', 'g1')?.resolution).toMatchObject({
      choice: 'retry',
      by: 'user',
    });
  });

  it('止まっていない・終わった・中断した・停止処理中・runが無いときは断る', async () => {
    const h = await setup([
      makeRun([
        makeTask('T1', 'implement', 'running'),
        haltedTask('T2', { attention: 'stopping' }),
      ]),
      { ...makeRun([haltedTask('T1')]), runId: 'run-done', finishedAt: FIXTURE_NOW.toISOString() },
      {
        ...makeRun([haltedTask('T1')]),
        runId: 'run-suspended',
        suspendedAt: FIXTURE_NOW.toISOString(),
      },
    ]);

    expect((await h.controller.retryStage(RUN_ID, 'T1')).message).toContain(
      '止まっている工程が無い',
    );
    expect((await h.controller.retryStage(RUN_ID, 'T9')).message).toContain(
      '止まっている工程が無い',
    );
    expect((await h.controller.retryStage(RUN_ID, 'T2')).message).toContain('停止処理中');
    expect((await h.controller.retryStage('run-done', 'T1')).message).toContain('終わっている');
    expect((await h.controller.retryStage('run-suspended', 'T1')).message).toContain(
      '中断している',
    );
    expect((await h.controller.retryStage('missing', 'T1')).message).toBe('runが見つからない');
  });
});

describe('closeTask', () => {
  const REASON = '重複Issueのため取り下げ';

  it('正常系: 理由付きでmergeせずに完了にし、記録を残して工程を回す', async () => {
    const h = await setup([makeRun([haltedTask('T1'), makeTask('T2', 'implement', 'notStarted')])]);

    const result = await h.controller.closeTask(RUN_ID, 'T1', REASON);

    expect(result).toEqual({ ok: true, message: 'T1をmergeせずに完了にした' });
    const task = taskOf(h, 'T1');
    expect(task.closedWithoutMerge).toMatchObject({ reason: REASON, by: 'user' });
    expect(task.attention).toBe('none');
    expect(
      Object.values(task.stages).every((s) => s.status === 'done' || s.status === 'skipped'),
    ).toBe(true);
    // 他のタスクが残っているのでrunは終わらない
    expect(runOf(h).finishedAt).toBeUndefined();
    expect(h.runner.pump).toHaveBeenCalledWith(RUN_ID);
  });

  it('正常系: 全タスクが終わればrunも終える', async () => {
    const h = await setup([makeRun([haltedTask('T1')])]);

    await h.controller.closeTask(RUN_ID, 'T1', REASON);

    expect(runOf(h).finishedAt).toBeDefined();
  });

  it('正常系: 失敗の関門が開いていれば、ユーザーの「mergeせずに完了にする」判断として決着させる', async () => {
    const run = withOpenGate(makeRun([haltedTask('T1')]), 'T1', 'g1', 'stageFailed');
    const h = await setup([run]);

    const result = await h.controller.closeTask(RUN_ID, 'T1', REASON);

    expect(result.ok).toBe(true);
    expect(findStageGate(runOf(h), 'T1', 'g1')).toMatchObject({
      status: 'resolved',
      resolution: { choice: 'close', by: 'user' },
    });
    expect(taskOf(h, 'T1').closedWithoutMerge?.reason).toBe(REASON);
  });

  it('異常系: 存在しないタスクは完了にできない', async () => {
    const h = await setup([makeRun([haltedTask('T1')])]);

    const result = await h.controller.closeTask(RUN_ID, 'T9', REASON);

    expect(result).toEqual({ ok: false, message: 'T9を完了にできない: 止まっている工程が無い' });
    expect(h.runner.pump).not.toHaveBeenCalled();
  });

  it('異常系: 存在しないrunは断る', async () => {
    const h = await setup();

    const result = await h.controller.closeTask('missing', 'T1', REASON);

    expect(result).toEqual({ ok: false, message: 'runが見つからない' });
  });

  it('異常系: 理由が空・空白だけなら断り、状態を変えない', async () => {
    const h = await setup([makeRun([haltedTask('T1')])]);

    for (const reason of ['', '   ', '\n\t']) {
      const result = await h.controller.closeTask(RUN_ID, 'T1', reason);
      expect(result).toEqual({ ok: false, message: 'T1を完了にできない: 理由が空' });
    }
    expect(taskOf(h, 'T1').closedWithoutMerge).toBeUndefined();
    expect(taskOf(h, 'T1').stages.implement.status).toBe('halted');
    expect(h.runner.pump).not.toHaveBeenCalled();
  });

  it('異常系: すでに完了済みのタスクは完了にできない（2回目の完了も断る）', async () => {
    const h = await setup([
      makeRun([makeTask('T1', 'mergeCleanup', 'done'), haltedTask('T2'), haltedTask('T3')]),
    ]);

    const merged = await h.controller.closeTask(RUN_ID, 'T1', REASON);
    expect(merged).toEqual({ ok: false, message: 'T1を完了にできない: 止まっている工程が無い' });

    expect((await h.controller.closeTask(RUN_ID, 'T2', REASON)).ok).toBe(true);
    const again = await h.controller.closeTask(RUN_ID, 'T2', REASON);
    expect(again).toEqual({ ok: false, message: 'T2を完了にできない: 止まっている工程が無い' });
    expect(taskOf(h, 'T2').closedWithoutMerge?.reason).toBe(REASON);
  });

  it('異常系: 止まっていない工程・停止処理中のタスクは完了にできない', async () => {
    const h = await setup([
      makeRun([
        makeTask('T1', 'implement', 'running'),
        haltedTask('T2', { attention: 'stopping' }),
      ]),
    ]);

    expect((await h.controller.closeTask(RUN_ID, 'T1', REASON)).message).toContain(
      '止まっている工程が無い',
    );
    expect((await h.controller.closeTask(RUN_ID, 'T2', REASON)).message).toContain('停止処理中');
  });

  it('異常系: 終わったrun・中断したrunでは完了にできない', async () => {
    const h = await setup([
      { ...makeRun([haltedTask('T1')]), runId: 'run-done', finishedAt: FIXTURE_NOW.toISOString() },
      {
        ...makeRun([haltedTask('T1')]),
        runId: 'run-suspended',
        suspendedAt: FIXTURE_NOW.toISOString(),
      },
    ]);

    expect((await h.controller.closeTask('run-done', 'T1', REASON)).message).toContain(
      '終わっている',
    );
    expect((await h.controller.closeTask('run-suspended', 'T1', REASON)).message).toContain(
      '中断している',
    );
  });

  it('異常系: レビュー指摘の関門が開いていれば先に決着させるよう断る', async () => {
    const gate: StageGate = {
      gateId: 'g1',
      kind: 'reviewFindings',
      stage: 'review',
      status: 'awaitingUser',
      detail: '指摘',
      reflexSummary: undefined,
      resolution: undefined,
      openedAt: FIXTURE_NOW.toISOString(),
    };
    const task = makeTask('T1', 'mergeCleanup', 'halted', {
      review: reviewResult(false, ['指摘']),
      gates: [gate],
    });
    const h = await setup([makeRun([task])]);

    const result = await h.controller.closeTask(RUN_ID, 'T1', REASON);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('レビューの関門を先に決着させる');
  });
});

// ---------------------------------------------------------------------------
// 復元
// ---------------------------------------------------------------------------

describe('restore', () => {
  it('終わったrunは復元の対象にせず、動いていたrunは止めたまま外部の状態と突き合わせる', async () => {
    const done = { ...makeRun([]), runId: 'run-done', finishedAt: FIXTURE_NOW.toISOString() };
    const running = makeRun([
      makeTask('T1', 'implement', 'running', {
        worktreePath: '/tmp/ws/wt',
        issueNumber: 5,
      }),
    ]);
    const h = await setup([done, running]);
    h.controller.onTransition(() => undefined);

    await h.controller.restore();

    const task = taskOf(h, 'T1');
    expect(task.stages.implement.status).toBe('halted');
    expect(h.observation.fetchIssueState).toHaveBeenCalledWith(ROOT, 5);
    expect(h.runner.cleanupRestoredTask).not.toHaveBeenCalled();
  });

  it('再読み込みの間にmergeされたタスクは後片付けまで行う。失敗しても続ける', async () => {
    const task = makeTask('T1', 'review', 'running', {
      pullRequest: { number: 7, url: 'https://example.com/pull/7' },
    });
    const h = await setup([makeRun([task])]);
    h.observation.fetchPullRequestState.mockResolvedValue('merged');
    h.runner.cleanupRestoredTask.mockRejectedValueOnce(new Error('後片付け失敗'));

    await h.controller.restore();

    expect(h.runner.cleanupRestoredTask).toHaveBeenCalledWith(RUN_ID, 'T1');
    expect(h.logs.some((l) => l.includes('後片付けに失敗しました'))).toBe(true);
  });

  it('外部の状態を取れなくても復元を止めない', async () => {
    const task = makeTask('T1', 'implement', 'running', {
      pullRequest: { number: 7, url: 'https://example.com/pull/7' },
      worktreePath: '/tmp/ws/wt',
    });
    const h = await setup([makeRun([task])], {
      pathExists: () => Promise.reject(new Error('NFS')),
    });
    h.observation.fetchPullRequestState.mockRejectedValue(new Error('forge'));

    await h.controller.restore();

    expect(taskOf(h, 'T1').stages.implement.status).toBe('halted');
  });
});

// ---------------------------------------------------------------------------
// 工程の操作
// ---------------------------------------------------------------------------

describe('startStage', () => {
  const call = (overrides: Record<string, unknown> = {}) =>
    ({
      tool: 'start_stage',
      taskId: 'T1',
      stage: 'implement',
      model: 'm1',
      effort: 'high',
      reason: '理由',
      instruction: undefined,
      ...overrides,
    }) as never;

  it('設定を記録して受け付け、工程を回す', async () => {
    const h = await setup([makeRun([makeTask('T1', 'implement', 'notStarted')])]);

    const result = await h.controller.startStage(RUN_ID, call());

    expect(result.ok).toBe(true);
    expect(result.message).toContain('model=m1 effort=high');
    expect(taskOf(h, 'T1').stages.implement.pendingDecision).toMatchObject({
      model: 'm1',
      effort: 'high',
      reason: '理由',
    });
    expect(h.runner.pump).toHaveBeenCalledTimes(1);
  });

  it('止まっている工程はやり直しとして受け付ける。effortが空なら既定と表示する', async () => {
    const h = await setup([makeRun([haltedTask('T1')])]);

    const result = await h.controller.startStage(RUN_ID, call({ effort: '' }));

    expect(result.message).toContain('（既定）');
    expect(taskOf(h, 'T1').stages.implement.pendingDecision?.model).toBe('m1');
  });

  it('推奨値があれば決定へ添える', async () => {
    const recommend = vi.fn().mockResolvedValue({ model: 'rec', effort: 'low', reason: 'r' });
    const h = await setup([makeRun([makeTask('T1', 'implement', 'notStarted')])], {
      recommendStageSettings: recommend,
    });
    await h.controller.recommend(RUN_ID, { taskId: 'T1', stage: 'implement' });

    await h.controller.startStage(RUN_ID, call());

    expect(taskOf(h, 'T1').stages.implement.pendingDecision?.recommended).toEqual({
      model: 'rec',
      effort: 'low',
    });
    expect(h.controller.recommendations(RUN_ID).size).toBe(0);
  });

  it('不正な設定・存在しないrun・判定を通らない工程は断る', async () => {
    const h = await setup([makeRun([makeTask('T1', 'implement', 'notStarted')])]);

    expect((await h.controller.startStage(RUN_ID, call({ model: '' }))).ok).toBe(false);
    expect((await h.controller.startStage('missing', call())).message).toBe('runが見つからない');
    const unknown = await h.controller.startStage(RUN_ID, call({ taskId: 'T9' }));
    expect(unknown.message).toContain('そのタスクは計画に無い');
    const wrongStage = await h.controller.startStage(RUN_ID, call({ stage: 'review' }));
    expect(wrongStage.message).toContain('現在の工程ではない');
    expect(h.runner.pump).not.toHaveBeenCalled();
  });

  it('依存先が終わっていなければ、未完了の依存先を示して断る', async () => {
    const h = await setup([
      makeRun([
        makeTask('T1', 'implement', 'notStarted', { dependsOn: ['T2'] }),
        makeTask('T2', 'implement', 'running'),
      ]),
    ]);

    const result = await h.controller.startStage(RUN_ID, call());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('依存先のタスクが終わっていない（T2）');
  });
});

describe('工程の停止・一時停止・再開・指示', () => {
  it('stopStageはrunnerの結果で成否を返す', async () => {
    const h = await setup([makeRun([])]);

    expect((await h.controller.stopStage(RUN_ID, 'T1')).ok).toBe(true);
    h.runner.stopStage.mockResolvedValueOnce(false);
    expect((await h.controller.stopStage(RUN_ID, 'T1')).ok).toBe(false);
  });

  it('pauseStageは進行中のターンの有無とエンジンで案内を変える', async () => {
    const claude = await setup([makeRun([])]);
    const codex = await setup([{ ...makeRun([]), engine: 'codex' }]);
    codex.runner.pauseStage.mockResolvedValue({ ok: true, waitingForTurn: true });

    const a = await claude.controller.pauseStage(RUN_ID, 'T1', '理由');
    const b = await codex.controller.pauseStage(RUN_ID, 'T1', '理由');

    expect(a.message).toContain('セッションを閉じた');
    expect(a.message).toContain('CLIと子プロセスを終了');
    expect(b.message).toContain('進行中のターンが終わったところ');
    expect(b.message).toContain('app-serverを工程間で共有');
  });

  it('pauseStageは一時停止できない理由を示す。runが無ければ断る', async () => {
    const h = await setup([makeRun([])]);
    h.runner.pauseStage.mockResolvedValue({
      ok: false,
      reason: 'alreadyPaused',
    } satisfies PauseStageOutcome);

    expect((await h.controller.pauseStage(RUN_ID, 'T1', '理由')).message).toContain(
      '既に一時停止している',
    );
    expect((await h.controller.pauseStage('missing', 'T1', '理由')).message).toBe(
      'runが見つからない',
    );
  });

  it('resumeStageは受け付けを返し、開き直せず失敗した理由があれば返す', async () => {
    const h = await setup([makeRun([makeTask('T1', 'implement', 'running')])]);

    expect((await h.controller.resumeStage(RUN_ID, 'T1')).ok).toBe(true);

    h.runner.resumeStage.mockImplementationOnce(async () => {
      await h.controller.updateRun(RUN_ID, (r) => ({
        ...r,
        tasks: {
          ...r.tasks,
          T1: { ...taskOf(h, 'T1'), attention: 'failed', failure: '会話が無い' },
        },
      }));
      return true;
    });
    const failed = await h.controller.resumeStage(RUN_ID, 'T1');
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('会話が無い');

    h.runner.resumeStage.mockResolvedValueOnce(false);
    expect((await h.controller.resumeStage(RUN_ID, 'T1')).message).toContain('一時停止していない');
  });

  it('instructTaskはrunnerの結果で成否を返す', async () => {
    const h = await setup([makeRun([])]);

    expect((await h.controller.instructTask(RUN_ID, 'T1', '指示')).ok).toBe(true);
    expect(h.runner.instructStage).toHaveBeenCalledWith(RUN_ID, 'T1', '指示');
    h.runner.instructStage.mockResolvedValueOnce(false);
    expect((await h.controller.instructTask(RUN_ID, 'T1', '指示')).ok).toBe(false);
  });

  it('setMaxParallelは範囲を検証して反映し、工程を回す', async () => {
    const h = await setup([makeRun([])]);

    expect((await h.controller.setMaxParallel(RUN_ID, 0)).ok).toBe(false);
    expect((await h.controller.setMaxParallel('missing', 3)).message).toBe('runが見つからない');
    expect((await h.controller.setMaxParallel(RUN_ID, 4)).message).toBe('並列上限を4にした');
    expect(runOf(h).maxParallel).toBe(4);
    expect(h.runner.pump).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 質問
// ---------------------------------------------------------------------------

describe('質問', () => {
  const ASK = {
    question: 'どちらの案で進めるか',
    reason: '仕様が2通り',
    options: ['案A', '案B'],
    recommended: '案A',
    blocking: true,
    evidence: '設計メモ',
    escalation: [],
  };

  async function withQuestion(userOnly = false): Promise<Harness> {
    const task = haltedTask('T1');
    const ref = {
      taskId: 'T1',
      executionId: task.executionId,
      stage: 'implement' as const,
      attemptId: 'a1',
    };
    let run = addStageQuestion(makeRun([task]), ref, 'q1', ASK, FIXTURE_NOW);
    run = markQuestionAwaitingUser(run, 'T1', 'q1', 'Reflex要約', FIXTURE_NOW, userOnly);
    return setup([run]);
  }

  it('findQuestionAwaitingAnswerは回答待ちの質問だけを返す', async () => {
    const h = await withQuestion();

    expect(h.controller.findQuestionAwaitingAnswer(RUN_ID, 'T1', 'q1')).toMatchObject({
      engine: 'claude',
      question: ASK.question,
      awaitingOrchestrator: false,
      userOnly: false,
    });
    expect(h.controller.findQuestionAwaitingAnswer(RUN_ID, 'T1', 'q9')).toBeUndefined();
    expect(h.controller.findQuestionAwaitingAnswer(RUN_ID, 'T9', 'q1')).toBeUndefined();
    expect(h.controller.findQuestionAwaitingAnswer('missing', 'T1', 'q1')).toBeUndefined();
  });

  it('ユーザーの判断待ちの質問をオーケストレーターの判断待ちへ移す', async () => {
    const h = await withQuestion();

    const result = await h.controller.delegateQuestionToOrchestrator(RUN_ID, 'T1', 'q1', '要約');

    expect(result.ok).toBe(true);
    expect(findStageQuestion(runOf(h), 'T1', 'q1')?.status).toBe('awaitingOrchestrator');
    expect(h.controller.findQuestionAwaitingAnswer(RUN_ID, 'T1', 'q1')?.awaitingOrchestrator).toBe(
      true,
    );
  });

  it('ユーザーだけが答える質問は移さない', async () => {
    const h = await withQuestion(true);

    const result = await h.controller.delegateQuestionToOrchestrator(RUN_ID, 'T1', 'q1', '要約');

    expect(result.ok).toBe(false);
  });

  it('オーケストレーターの判断待ちの質問をユーザーへ回し、ユーザーだけが答える印を付ける', async () => {
    const h = await withQuestion();
    await h.controller.delegateQuestionToOrchestrator(RUN_ID, 'T1', 'q1', '要約');

    const result = await h.controller.escalateToUser(
      RUN_ID,
      'T1',
      { questionId: 'q1' },
      '決められない',
    );

    expect(result.ok).toBe(true);
    const question = findStageQuestion(runOf(h), 'T1', 'q1');
    expect(question?.status).toBe('awaitingUser');
    expect(question?.userOnly).toBe(true);
  });

  it('answerQuestionはrunnerの結果で成否を返し、回答者を渡す', async () => {
    const h = await withQuestion();

    expect((await h.controller.answerQuestion(RUN_ID, 'T1', 'q1', '案A')).ok).toBe(true);
    expect(h.runner.answerQuestion).toHaveBeenCalledWith(RUN_ID, 'T1', 'q1', '案A', 'user');
    h.runner.answerQuestion.mockResolvedValueOnce(false);
    expect((await h.controller.answerQuestion(RUN_ID, 'T1', 'q1', '案A', 'orchestrator')).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 関門
// ---------------------------------------------------------------------------

describe('関門', () => {
  const stageFailedRun = (status: StageGate['status'] = 'judging'): TaskRun => {
    const run = withOpenGate(makeRun([haltedTask('T1')]), 'T1', 'g1', 'stageFailed', '詳細');
    const task = getTask(run, 'T1');
    if (task === undefined) {
      throw new Error('タスクが無い');
    }
    return {
      ...run,
      tasks: {
        ...run.tasks,
        T1: { ...task, gates: (task.gates ?? []).map((g) => ({ ...g, status })) },
      },
    };
  };

  it('findOpenGateForUserは決着待ちの関門だけを返す', async () => {
    const h = await setup([stageFailedRun('awaitingOrchestrator')]);

    expect(h.controller.findOpenGateForUser(RUN_ID, 'T1', 'g1')).toEqual({
      title: 'T1のタイトル',
      detail: '詳細',
      awaitingOrchestrator: true,
    });
    expect(h.controller.findOpenGateForUser(RUN_ID, 'T1', 'g9')).toBeUndefined();
    expect(h.controller.findOpenGateForUser('missing', 'T1', 'g1')).toBeUndefined();
  });

  it('resolveGateはユーザーの「やり直す」で決着し、工程を回す', async () => {
    const h = await setup([stageFailedRun('awaitingUser')]);

    const result = await h.controller.resolveGate(RUN_ID, 'T1', 'g1', 'retry');

    expect(result.ok).toBe(true);
    expect(findStageGate(runOf(h), 'T1', 'g1')?.status).toBe('resolved');
    expect(h.runner.pump).toHaveBeenCalledTimes(1);
  });

  it('resolveGateの「mergeせずに完了にする」には理由が要る。理由があれば完了にする', async () => {
    const h = await setup([stageFailedRun('awaitingUser')]);

    const noReason = await h.controller.resolveGate(RUN_ID, 'T1', 'g1', 'close');
    expect(noReason.message).toContain('理由が要る');
    const closed = await h.controller.resolveGate(
      RUN_ID,
      'T1',
      'g1',
      'close',
      'user',
      undefined,
      '重複',
    );

    expect(closed.ok).toBe(true);
    expect(taskOf(h, 'T1').closedWithoutMerge?.reason).toBe('重複');
    expect(runOf(h).finishedAt).toBeDefined();
  });

  it('resolveGateは種類に合わない決着・存在しない関門・終わった/中断したrunを断る', async () => {
    const h = await setup([
      stageFailedRun('awaitingUser'),
      {
        ...stageFailedRun('awaitingUser'),
        runId: 'run-done',
        finishedAt: FIXTURE_NOW.toISOString(),
      },
      {
        ...stageFailedRun('awaitingUser'),
        runId: 'run-suspended',
        suspendedAt: FIXTURE_NOW.toISOString(),
      },
    ]);

    expect((await h.controller.resolveGate(RUN_ID, 'T1', 'g1', 'proceed')).message).toContain(
      'この関門では',
    );
    expect((await h.controller.resolveGate(RUN_ID, 'T1', 'g9', 'retry')).message).toContain(
      '決着待ちの関門ではない',
    );
    expect((await h.controller.resolveGate('run-done', 'T1', 'g1', 'retry')).message).toContain(
      '終わっている',
    );
    expect(
      (await h.controller.resolveGate('run-suspended', 'T1', 'g1', 'retry')).message,
    ).toContain('中断している');
    expect((await h.controller.resolveGate('missing', 'T1', 'g1', 'retry')).message).toBe(
      'runが見つからない',
    );
  });

  it('オーケストレーターはReflexの承認が無ければユーザーの判断待ちの関門を決着できない', async () => {
    const h = await setup([stageFailedRun('awaitingUser')]);

    const rejected = await h.controller.resolveGate(RUN_ID, 'T1', 'g1', 'retry', 'orchestrator');
    expect(rejected.message).toContain('オーケストレーターの判断待ちの関門ではない');

    const approved = await h.controller.resolveGate(RUN_ID, 'T1', 'g1', 'retry', 'orchestrator', {
      summary: '妥当',
    });
    expect(approved.ok).toBe(true);
    expect(findStageGate(runOf(h), 'T1', 'g1')).toMatchObject({
      resolution: { by: 'orchestrator' },
    });
  });

  it('差し戻しの上限に達した関門は、ユーザー以外が差し戻せない', async () => {
    const task = makeTask('T1', 'mergeCleanup', 'notStarted', {
      review: reviewResult(true, []),
      reviewRounds: 3,
    } as Partial<OrchestratedTask>);
    const run = withOpenGate(makeRun([task]), 'T1', 'g1', 'reviewFindings');
    const h = await setup([
      {
        ...run,
        tasks: {
          ...run.tasks,
          T1: {
            ...(getTask(run, 'T1') as OrchestratedTask),
            gates: (getTask(run, 'T1')?.gates ?? []).map((g) => ({
              ...g,
              status: 'awaitingOrchestrator' as const,
            })),
          },
        },
      },
    ]);

    const result = await h.controller.resolveGate(RUN_ID, 'T1', 'g1', 'sendBack', 'orchestrator');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('差し戻せるのはユーザーだけ');
  });

  it('resolveGateByReview: Reflexが無効・対象外なら人に確かめる', async () => {
    const h = await setup([stageFailedRun('awaitingUser')]);

    expect(await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g9', 'retry', undefined)).toEqual({
      needsUser: { summary: undefined },
    });
    expect(await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g1', 'retry', undefined)).toEqual({
      needsUser: { summary: undefined },
    });
    expect(reviewGate).not.toHaveBeenCalled();
  });

  it('resolveGateByReview: 妥当と判定されれば決着させる', async () => {
    reviewGate.mockResolvedValue({ kind: 'approved', summary: '妥当' });
    const h = await setup([stageFailedRun('awaitingUser')], {
      gateReview: () => ({ reflex: REFLEX, threshold: 0.8 }),
    });

    const result = await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g1', 'retry', '理由');

    expect(result).toMatchObject({ decided: { ok: true } });
    expect(findStageGate(runOf(h), 'T1', 'g1')?.resolution).toMatchObject({
      by: 'orchestrator',
    });
  });

  it('resolveGateByReview: 妥当でなければ覚えて審査し直さない。判定失敗は審査し直す。許されない決着は審査しない', async () => {
    reviewGate.mockResolvedValue({ kind: 'needsUser', summary: '要確認' });
    const h = await setup([stageFailedRun('awaitingUser')], {
      gateReview: () => ({ reflex: REFLEX, threshold: 0.8 }),
    });

    const first = await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g1', 'retry', undefined);
    const second = await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g1', 'retry', undefined);
    expect(first).toEqual({ needsUser: { summary: '要確認' } });
    expect(second).toEqual({ needsUser: { summary: '要確認' } });
    expect(reviewGate).toHaveBeenCalledTimes(1);

    reviewGate.mockResolvedValue({ kind: 'needsUser', summary: '判定なし', failed: true });
    await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g1', 'close', '理由');
    await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g1', 'close', '理由');
    expect(reviewGate).toHaveBeenCalledTimes(3);

    await h.controller.resolveGateByReview(RUN_ID, 'T1', 'g1', 'proceed', undefined);
    expect(reviewGate).toHaveBeenCalledTimes(3);
  });

  it('オーケストレーターの判断待ちの関門をユーザーへ回す。runが無ければ断る', async () => {
    const h = await setup([stageFailedRun('awaitingOrchestrator')]);

    const result = await h.controller.escalateToUser(
      RUN_ID,
      'T1',
      { gateId: 'g1' },
      '決められない',
    );

    expect(result.ok).toBe(true);
    expect(findStageGate(runOf(h), 'T1', 'g1')?.status).toBe('awaitingUser');
    expect((await h.controller.escalateToUser('missing', 'T1', { gateId: 'g1' }, '理由')).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// ロードマップ
// ---------------------------------------------------------------------------

describe('ロードマップ', () => {
  const input = {
    workspaceRoot: ROOT,
    engine: 'claude' as const,
    maxParallel: 2,
    roadmapIssueNumber: 100,
    roadmapTitle: 'ロードマップ',
    children: [
      { issueNumber: 101, title: '子1', checked: false },
      { issueNumber: 102, title: '子2', checked: true },
    ],
    planNodes: undefined,
    planSectionHash: undefined,
  };

  it('ポート無しではsyncできず、handleTaskMergedは何もしない', async () => {
    const h = await setup([makeRun([])]);

    expect((await h.controller.syncRoadmap(RUN_ID)).ok).toBe(false);
    expect(() => h.controller.handleTaskMerged(RUN_ID, 'T1')).not.toThrow();
  });

  it('子Issueから初期計画を作ってrunを始め、同じロードマップのrunは再利用する', async () => {
    const h = await setup();

    const started = await h.controller.startRoadmapRun(input);

    expect(started).toMatchObject({ ok: true, reused: false });
    if (!started.ok) {
      throw new Error('開始できなかった');
    }
    expect(started.planMessage?.ok).toBe(true);
    const run = runOf(h, started.runId);
    expect(run.roadmap?.issueNumber).toBe(100);
    expect(run.taskOrder).toHaveLength(2);
    expect(h.controller.findRoadmapRun(ROOT, 100)?.runId).toBe(started.runId);
    expect(h.controller.findRoadmapRun(ROOT, 999)).toBeUndefined();

    const again = await h.controller.startRoadmapRun(input);
    expect(again).toEqual({ ok: true, runId: started.runId, reused: true });
  });

  it('並列上限が範囲外なら始めない', async () => {
    const h = await setup();

    const outcome = await h.controller.startRoadmapRun({ ...input, maxParallel: 0 });

    expect(outcome.ok).toBe(false);
    expect(h.store.list()).toHaveLength(0);
  });

  it('ポートがあれば読み直せない理由を返す', async () => {
    const roadmap = {
      read: vi.fn().mockResolvedValue({ kind: 'failed', message: '取得できない' }),
      edit: vi.fn(),
      writePlan: vi.fn(),
    };
    const h = await setup([], { roadmap });
    const started = await h.controller.startRoadmapRun(input);
    if (!started.ok) {
      throw new Error('開始できなかった');
    }

    const result = await h.controller.syncRoadmap(started.runId);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('取得できない');
  });
});
