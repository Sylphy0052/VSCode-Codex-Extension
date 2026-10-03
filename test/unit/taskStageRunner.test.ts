import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type { AnswererQuestion, AnswererVerdict } from '../../src/reflex/answererJudge';
import type { RoadmapAskOutcome } from '../../src/orchestrator/roadmapQuestionMcp';
import { ROADMAP_ASK_ORCHESTRATOR_TOOL } from '../../src/orchestrator/roadmapQuestionMcp';
import { RELOAD_HALT_REASON } from '../../src/orchestrator/taskRunReload';
import { TaskRunMergeKeys } from '../../src/orchestrator/taskRunMergeKey';
import {
  currentStage,
  isTaskRunActive,
  markStageReloadResuming,
  type OrchestratedTask,
  type StageDecision,
  type TaskRun,
  type TaskRunEngine,
  type TaskStage,
} from '../../src/orchestrator/taskRunState';
import type {
  ApprovalHandler,
  LockedTabAction,
  TaskHandoffRequest,
  TaskSession,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import { REPORT_STAGE_RESULT_TOOL } from '../../src/orchestrator/taskStagePrompts';
import { TaskStageRunner, type TaskStageRunnerDeps } from '../../src/orchestrator/taskStageRunner';
import { FIXTURE_NOW, makeRun, makeTask } from '../helpers/taskRunFixture';

/**
 * `TaskStageRunner`の工程の実行・状態遷移・エラー処理（Issue #1854）。依存（`TaskStageRunnerDeps`）は
 * すべてモックにし、状態の保存先はメモリ上のストアにする。工程セッションは`FakeSession`で、
 * ループの開始・状態の通知・終了を試験側から起こす。判定（関門・質問の振り分け）は
 * `taskStageRunnerJudge.test.ts`が担うため、ここでは判定の口を渡さない既定の経路だけを通す。
 */

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 7;

const DECISION: StageDecision = {
  model: 'opus',
  effort: '',
  reason: '理由',
  instruction: undefined,
  recommended: undefined,
  decidedAt: FIXTURE_NOW.toISOString(),
};

/** 設定を受け付け、空きを待っている工程（`pendingDecision`あり）を現在の工程に持つタスク。 */
function queuedTask(
  taskId: string,
  stage: TaskStage,
  overrides: Partial<OrchestratedTask> = {},
): OrchestratedTask {
  const base = makeTask(taskId, stage, 'notStarted', overrides);
  return {
    ...base,
    stages: { ...base.stages, [stage]: { ...base.stages[stage], pendingDecision: DECISION } },
  };
}

/** worktree・ブランチ・PRを持つタスクの上書き。 */
const WORKTREE_TASK: Partial<OrchestratedTask> = {
  worktreePath: '/tmp/ws/.worktrees/T1',
  branch: 'feat/1/x',
  pullRequest: { number: 5, url: 'https://example.com/pull/5' },
  issueNumber: 1,
};

class FakeSession {
  readonly plans: LoopPlan[] = [];
  readonly stateListeners: ((state: ChatState) => void)[] = [];
  readonly finishedListeners: ((reason: LoopStopReason, state: ChatState) => void)[] = [];
  readonly lockedListeners: ((action: LockedTabAction) => void)[] = [];
  transform: ((text: string) => string) | undefined;
  approval: ApprovalHandler | undefined;
  reflex: boolean | undefined;
  process: { pid: number; shared: boolean } | undefined;
  releaseForPause: (() => Promise<{ memoryFreed: boolean }>) | undefined;

  runLoop = vi.fn((plan: LoopPlan) => {
    this.plans.push(plan);
  });
  pauseLoop = vi.fn();
  resumeLoop = vi.fn();
  stopLoop = vi.fn(() => true);
  interrupt = vi.fn(async () => undefined);
  open = vi.fn();
  reveal = vi.fn();
  dispose = vi.fn();
  note = vi.fn();
  setApprovalHandler = vi.fn((handler: ApprovalHandler) => {
    this.approval = handler;
  });
  setMcpElicitationHandler = vi.fn();
  setPromptTransform = vi.fn((fn: (text: string) => string) => {
    this.transform = fn;
  });
  onStateChanged = vi.fn((listener: (state: ChatState) => void) => {
    this.stateListeners.push(listener);
  });
  onFinished = vi.fn((listener: (reason: LoopStopReason, state: ChatState) => void) => {
    this.finishedListeners.push(listener);
  });
  onLockedAction = vi.fn((listener: (action: LockedTabAction) => void) => {
    this.lockedListeners.push(listener);
  });

  constructor(readonly sessionId: string) {}

  reflexEnabled(): boolean | undefined {
    return this.reflex;
  }

  processInfo(): { pid: number; shared: boolean } | undefined {
    return this.process;
  }

  emitState(busy: boolean): void {
    this.stateListeners.forEach((l) => l({ busy } as ChatState));
  }

  emitFinished(reason: LoopStopReason): void {
    this.finishedListeners.forEach((l) => l(reason, {} as ChatState));
  }

  emitLocked(action: LockedTabAction): void {
    this.lockedListeners.forEach((l) => l(action));
  }

  asSession(): TaskSession {
    return this as unknown as TaskSession;
  }
}

type ToolCall = (name: string, rawArgs: unknown) => Promise<RoadmapAskOutcome>;

interface Channel {
  connectionId: string;
  call: ToolCall;
  token: string;
}

interface HarnessOptions {
  deps?: Partial<TaskStageRunnerDeps>;
  /** セッションを作った直後（`openTaskSession`が解決する前）に呼ぶ。 */
  sessionSetup?: (session: FakeSession, index: number) => void;
}

const OK_GIT = { code: 0, stdout: '', stderr: '' };

function build(initial: readonly TaskRun[], options: HarnessOptions = {}) {
  const runs = new Map(initial.map((r) => [r.runId, r]));
  const store = {
    find: (runId: string) => runs.get(runId),
    update: async (runId: string, fn: (run: TaskRun | undefined) => TaskRun) => {
      const next = fn(runs.get(runId));
      runs.set(runId, next);
      return next;
    },
    list: () => [...runs.values()],
    listActive: (root: string) =>
      [...runs.values()].filter((r) => r.workspaceRoot === root && isTaskRunActive(r)),
    listInFolder: (root: string) => [...runs.values()].filter((r) => r.workspaceRoot === root),
  };
  const sessions: FakeSession[] = [];
  const ctl: { openError: Error | undefined } = { openError: undefined };
  const openImpl = async (_input: TaskSessionInput): Promise<TaskSession> => {
    if (ctl.openError !== undefined) {
      throw ctl.openError;
    }
    const session = new FakeSession(`sess-${String(sessions.length + 1)}`);
    sessions.push(session);
    options.sessionSetup?.(session, sessions.length - 1);
    return session.asSession();
  };
  const openClaude = vi.fn(openImpl);
  const openCodex = vi.fn(openImpl);
  const channels: Channel[] = [];
  const mcpServer = {
    registerTools: vi.fn(async (connectionId: string, _tools: unknown, call: ToolCall) => {
      const token = `tok-${String(channels.length + 1)}`;
      channels.push({ connectionId, call, token });
      return { url: `http://mcp.local/${token}`, token };
    }),
    unregister: vi.fn(),
  };
  const git = { run: vi.fn(async (_args: readonly string[], _cwd: string) => OK_GIT) };
  const fs = { pathExists: vi.fn(async (_path: string) => true) };
  const worktreeQueue = {
    create: vi.fn(async (_request: unknown, _git: unknown, _fs: unknown) => ({
      ok: true as const,
      cwd: '/tmp/ws/.worktrees/T1',
      branch: 'feat/1/x',
    })),
    remove: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
  };
  const observation = {
    fetchIssueTitle: vi.fn(async (_root: string, _n: number): Promise<string | undefined> => '題'),
    fetchIssueState: vi.fn(async () => 'open'),
    findPullRequest: vi.fn(async () => undefined),
    fetchPullRequestState: vi.fn(async () => 'open'),
    remoteBranchHead: vi.fn(async (): Promise<string | null | undefined> => 'sha1'),
    localHead: vi.fn(async (): Promise<string | undefined> => 'sha1'),
  };
  const warnings: string[] = [];
  const onWarning = vi.fn((_runId: string, _taskId: string, message: string) => {
    warnings.push(message);
  });
  const onRunChanged = vi.fn();
  const onTaskMerged = vi.fn();
  let idCounter = 0;
  const deps = {
    hosts: { claude: { openTaskSession: openClaude }, codex: { openTaskSession: openCodex } },
    store,
    mergeKeys: new TaskRunMergeKeys(),
    worktreeQueue,
    git,
    fs,
    observation,
    resolveBaseCommit: vi.fn(async (_repoRoot: string): Promise<string | undefined> => 'abc1234'),
    sessionConfig: () => ({
      config: { model: 'default-model', effort: 'default-effort', approvalMode: 'auto' },
      sandbox: 'sandbox-x',
    }),
    autoApprove: () => true,
    maxIterations: MAX_ITERATIONS,
    mcpServer,
    onRunChanged,
    onWarning,
    onTaskMerged,
    now: () => FIXTURE_NOW,
    newId: () => {
      idCounter += 1;
      return `id-${String(idCounter)}`;
    },
    ...options.deps,
  } as unknown as TaskStageRunnerDeps;
  const runner = new TaskStageRunner(deps);
  const run = (runId = 'run-1'): TaskRun => {
    const found = runs.get(runId);
    if (found === undefined) {
      throw new Error(`runが無い: ${runId}`);
    }
    return found;
  };
  return {
    runner,
    deps,
    runs,
    store,
    sessions,
    ctl,
    openClaude,
    openCodex,
    channels,
    mcpServer,
    git,
    fs,
    worktreeQueue,
    observation,
    warnings,
    onRunChanged,
    onTaskMerged,
    run,
    task: (taskId = 'T1'): OrchestratedTask => {
      const task = run().tasks[taskId];
      if (task === undefined) {
        throw new Error(`タスクが無い: ${taskId}`);
      }
      return task;
    },
    session: (index = 0): FakeSession => {
      const session = sessions[index];
      if (session === undefined) {
        throw new Error(`セッションが無い: ${String(index)}`);
      }
      return session;
    },
  };
}

type Harness = ReturnType<typeof build>;

/** 非公開メソッドを呼ぶための型。 */
interface RunnerInternals {
  judgeMergeCommand(entry: unknown, command: string): Promise<boolean>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function refArgs(t: Harness, taskId = 'T1'): Record<string, unknown> {
  const task = t.task(taskId);
  return {
    taskId,
    executionId: task.executionId,
    stage: currentStage(task),
    attemptId: task.currentAttemptId,
  };
}

function lastChannel(t: Harness, index = -1): Channel {
  const channel = t.channels.at(index);
  if (channel === undefined) {
    throw new Error('MCPの接続が無い');
  }
  return channel;
}

function callTool(
  t: Harness,
  name: string,
  args: Record<string, unknown>,
  channelIndex = -1,
): Promise<RoadmapAskOutcome> {
  return lastChannel(t, channelIndex).call(name, args);
}

const ISSUE_BODY = '## 受入基準\n- 動くこと';

function reportDone(
  t: Harness,
  extra: Record<string, unknown> = {},
  channelIndex = -1,
): Promise<RoadmapAskOutcome> {
  return callTool(
    t,
    REPORT_STAGE_RESULT_TOOL,
    {
      ...refArgs(t),
      outcome: 'done',
      summary: '要約',
      issueTitle: '題',
      issueBody: ISSUE_BODY,
      ...extra,
    },
    channelIndex,
  );
}

const ASK = { question: 'どちらにするか', reason: '迷った', blocking: true, options: ['A', 'B'] };

function ask(t: Harness, extra: Record<string, unknown> = {}): Promise<RoadmapAskOutcome> {
  return callTool(t, ROADMAP_ASK_ORCHESTRATOR_TOOL.name, { ...ASK, ...extra });
}

/** 「Issue計画」の工程を1つ始めた状態。 */
async function startedHarness(options: HarnessOptions = {}): Promise<Harness> {
  const t = build([makeRun([queuedTask('T1', 'issuePlan')])], options);
  await t.runner.pump('run-1');
  return t;
}

const runners: TaskStageRunner[] = [];
afterEach(() => {
  runners.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
});

async function started(options: HarnessOptions = {}): Promise<Harness> {
  const t = await startedHarness(options);
  runners.push(t.runner);
  return t;
}

// ---------------------------------------------------------------------------
// 工程の開始（pump）
// ---------------------------------------------------------------------------

describe('TaskStageRunner.pump 工程の開始', () => {
  it('設定を受け付けた工程のセッションを開き、実行回とセッションを記録してループを始める', async () => {
    const t = await started();
    expect(t.openClaude).toHaveBeenCalledTimes(1);
    expect(t.openClaude.mock.calls[0]?.[0]).toMatchObject({
      role: 'task',
      taskId: 'T1',
      cwd: '/tmp/ws',
      cliSandbox: 'read-only',
      sandbox: 'sandbox-x',
      inputLock: true,
      lowPriority: false,
      // Orchestratorが決めたModelは上書きし、空のEffortは既定値のまま
      config: { model: 'opus', effort: 'default-effort', approvalMode: 'auto' },
    });
    const record = t.task().stages.issuePlan;
    expect(record.status).toBe('running');
    expect(record.pendingDecision).toBeUndefined();
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toMatchObject({ kind: 'initial', sessionRef: 'sess-1' });
    expect(t.task().currentAttemptId).toBe(record.attempts[0]?.attemptId);
    expect(t.session().open).toHaveBeenCalledWith({ preserveFocus: true, viewColumn: 2 });
    const plan = t.session().plans[0];
    expect(plan).toMatchObject({ maxIterations: MAX_ITERATIONS, backgroundWaitLimitMs: 1_800_000 });
    expect(plan?.continuePrompt.startsWith('続けて。')).toBe(true);
    expect(t.onRunChanged).toHaveBeenCalled();
  });

  it('同じタスクの工程を二重に始めない', async () => {
    const t = await started();
    await t.runner.pump('run-1');
    expect(t.openClaude).toHaveBeenCalledTimes(1);
  });

  it('runのエンジンに合うホストでセッションを開く', async () => {
    const run = { ...makeRun([queuedTask('T1', 'issuePlan')]), engine: 'codex' as TaskRunEngine };
    const t = build([run]);
    await t.runner.pump('run-1');
    expect(t.openCodex).toHaveBeenCalledTimes(1);
    expect(t.openClaude).not.toHaveBeenCalled();
    t.runner.dispose();
  });

  it('工程セッションのツール承認・MCPの確認・プロンプト変換・終了の口を取り付ける', async () => {
    const t = await started();
    const s = t.session();
    expect(s.setApprovalHandler).toHaveBeenCalledTimes(1);
    expect(s.setMcpElicitationHandler).toHaveBeenCalledTimes(1);
    expect(s.setPromptTransform).toHaveBeenCalledTimes(1);
    expect(s.onStateChanged).toHaveBeenCalledTimes(1);
    expect(s.onFinished).toHaveBeenCalledTimes(1);
    expect(s.onLockedAction).toHaveBeenCalledTimes(1);
    expect(t.channels).toHaveLength(1);
    expect(lastChannel(t).connectionId).toBe('task:run-1#T1:' + t.task().currentAttemptId);
  });

  it('承認ハンドラは質問ツールを拒否し、通常のコマンドは自動で許可する', async () => {
    const t = await started();
    const handler = t.session().approval;
    expect(await handler?.({ kind: 'askUserQuestion' } as never, {})).toMatchObject({
      kind: 'auto',
      decision: 'decline',
    });
    expect(await handler?.({ kind: 'command' } as never, { input: { command: 'ls' } })).toEqual({
      kind: 'auto',
      decision: 'accept',
    });
  });

  it('finishedAt・suspendedAtのあるrun、存在しないrunからは始めない', async () => {
    const finished = {
      ...makeRun([queuedTask('T1', 'issuePlan')]),
      finishedAt: '2026-09-30T01:00:00Z',
    };
    const suspended = {
      ...makeRun([queuedTask('T1', 'issuePlan')]),
      runId: 'run-2',
      suspendedAt: '2026-09-30T01:00:00Z',
    };
    const t = build([finished, suspended]);
    await t.runner.pump('run-1');
    await t.runner.pump('run-2');
    await t.runner.pump('none');
    expect(t.openClaude).not.toHaveBeenCalled();
  });

  it('disposeした後は始めない', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])]);
    t.runner.dispose();
    await t.runner.pump('run-1');
    expect(t.openClaude).not.toHaveBeenCalled();
  });

  it('別のウィンドウが専有権を持つrunは始めない', async () => {
    const canDrive = vi.fn(async () => false);
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], {
      deps: { drive: { canDrive, holds: () => true } },
    });
    await t.runner.pump('run-1');
    expect(canDrive).toHaveBeenCalledWith('run-1');
    expect(t.openClaude).not.toHaveBeenCalled();
  });

  it('ロックの中で専有権を失っていたら始めない', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], {
      deps: { drive: { canDrive: async () => true, holds: () => false } },
    });
    await t.runner.pump('run-1');
    expect(t.openClaude).not.toHaveBeenCalled();
    expect(t.task().stages.issuePlan.status).toBe('notStarted');
  });

  it('資源の監視がholdなら何も始めない', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], {
      deps: {
        startGate: {
          policy: () => 'hold',
          tryAcquireLivenessLane: vi.fn(() => true),
          releaseLivenessLane: vi.fn(),
        },
      },
    });
    await t.runner.pump('run-1');
    expect(t.openClaude).not.toHaveBeenCalled();
  });

  it('limit_to_1ならウィンドウ全体で1本までにする', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan'), queuedTask('T2', 'issuePlan')])], {
      deps: {
        startGate: {
          policy: () => 'limit_to_1',
          tryAcquireLivenessLane: vi.fn(() => true),
          releaseLivenessLane: vi.fn(),
        },
      },
    });
    await t.runner.pump('run-1');
    expect(t.openClaude).toHaveBeenCalledTimes(1);
    t.runner.dispose();
  });

  it('livenessなら例外の1本を低い優先度で始める', async () => {
    const gate = {
      policy: () => 'liveness' as const,
      tryAcquireLivenessLane: vi.fn(() => true),
      releaseLivenessLane: vi.fn(),
    };
    const t = build([makeRun([queuedTask('T1', 'issuePlan'), queuedTask('T2', 'issuePlan')])], {
      deps: { startGate: gate },
    });
    await t.runner.pump('run-1');
    expect(t.openClaude).toHaveBeenCalledTimes(1);
    expect(t.openClaude.mock.calls[0]?.[0].lowPriority).toBe(true);
    expect(gate.releaseLivenessLane).not.toHaveBeenCalled();
    // 動いている工程があるあいだは例外の枠を使わない
    await t.runner.pump('run-1');
    expect(t.openClaude).toHaveBeenCalledTimes(1);
    t.runner.dispose();
  });

  it('livenessの枠が取れなければ始めず、始められなかったら枠を返す', async () => {
    const gate = {
      policy: () => 'liveness' as const,
      tryAcquireLivenessLane: vi.fn(() => false),
      releaseLivenessLane: vi.fn(),
    };
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], { deps: { startGate: gate } });
    await t.runner.pump('run-1');
    expect(t.openClaude).not.toHaveBeenCalled();

    gate.tryAcquireLivenessLane.mockReturnValue(true);
    t.ctl.openError = new Error('起動不可');
    await t.runner.pump('run-1');
    expect(gate.releaseLivenessLane).toHaveBeenCalledTimes(1);
  });

  it('同じフォルダの並列上限を超えて始めない', async () => {
    const tasks = [queuedTask('T1', 'issuePlan'), queuedTask('T2', 'issuePlan')];
    const none = build([makeRun(tasks)], { deps: { maxParallelPerFolder: () => 0 } });
    await none.runner.pump('run-1');
    expect(none.openClaude).not.toHaveBeenCalled();

    const one = build([makeRun(tasks)], { deps: { maxParallelPerFolder: () => 1 } });
    await one.runner.pump('run-1');
    expect(one.openClaude).toHaveBeenCalledTimes(1);
    one.runner.dispose();
  });

  it('設定でlowPriorityが有効なら通常の工程も低い優先度で起動する', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], {
      deps: { lowPriority: () => true },
    });
    await t.runner.pump('run-1');
    expect(t.openClaude.mock.calls[0]?.[0].lowPriority).toBe(true);
    t.runner.dispose();
  });

  it('pumpAllは動いているすべてのrunの工程を始める', async () => {
    const second = { ...makeRun([queuedTask('T1', 'issuePlan')]), runId: 'run-2' };
    const finished = {
      ...makeRun([queuedTask('T1', 'issuePlan')]),
      runId: 'run-3',
      finishedAt: '2026-09-30T01:00:00Z',
    };
    const t = build([makeRun([queuedTask('T1', 'issuePlan')]), second, finished]);
    await t.runner.pumpAll();
    expect(t.openClaude).toHaveBeenCalledTimes(2);
    t.runner.dispose();
  });

  it('工程が終わると、同じフォルダで空きを待っていた工程を始める', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan'), queuedTask('T2', 'issuePlan')])], {
      deps: { maxParallelPerFolder: () => 1 },
    });
    runners.push(t.runner);
    await t.runner.pump('run-1');
    expect(t.openClaude).toHaveBeenCalledTimes(1);
    await reportDone(t);
    t.session().emitState(false);
    await flush();
    expect(t.openClaude).toHaveBeenCalledTimes(2);
    expect(t.task('T2').stages.issuePlan.status).toBe('running');
  });

  it('動いている工程のプロセスを一覧にする', async () => {
    const t = await started({
      sessionSetup: (s) => {
        s.process = { pid: 4242, shared: true };
      },
    });
    expect(t.runner.listStageProcesses()).toEqual([
      { runId: 'run-1', taskId: 'T1', stage: 'issuePlan', pid: 4242, shared: true },
    ]);
  });

  it('タブを前面に出せるのは動いている工程だけ', async () => {
    const t = await started();
    expect(t.runner.revealStageSession('run-1', 'T1')).toBe(true);
    expect(t.session().reveal).toHaveBeenCalledTimes(1);
    expect(t.runner.revealStageSession('run-1', 'T9')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// worktree
// ---------------------------------------------------------------------------

describe('TaskStageRunner worktreeの用意', () => {
  it('「実装とPR作成」はworktreeを作って記録し、そこで書き込める設定で動かす', async () => {
    const t = build([makeRun([queuedTask('T1', 'implement', { issueNumber: 12 })])]);
    runners.push(t.runner);
    await t.runner.pump('run-1');
    expect(t.worktreeQueue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: '/tmp/ws',
        runId: 'run-1',
        taskId: 'T1',
        headCommit: 'abc1234',
        branchNaming: { naming: 'conventional', type: 'feat', issue: 12 },
      }),
      t.deps.git,
      t.deps.fs,
    );
    expect(t.task()).toMatchObject({
      worktreePath: '/tmp/ws/.worktrees/T1',
      branch: 'feat/1/x',
    });
    expect(t.openClaude.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/tmp/ws/.worktrees/T1',
      cliSandbox: 'workspace-write',
      issue: 12,
    });
  });

  it('記録済みのworktreeがあれば作らずに使う', async () => {
    const t = build([makeRun([queuedTask('T1', 'implement', WORKTREE_TASK)])]);
    runners.push(t.runner);
    await t.runner.pump('run-1');
    expect(t.worktreeQueue.create).not.toHaveBeenCalled();
    expect(t.openClaude.mock.calls[0]?.[0].cwd).toBe('/tmp/ws/.worktrees/T1');
  });

  it.each([
    [
      '記録済みのworktreeが無くなっている',
      (t: Harness) => t.fs.pathExists.mockResolvedValue(false),
      'implement' as TaskStage,
      WORKTREE_TASK,
      'worktreeが見つかりません',
    ],
    [
      '分岐元のcommitを解決できない',
      (t: Harness) =>
        (t.deps.resolveBaseCommit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
          undefined,
        ),
      'implement' as TaskStage,
      {},
      '分岐元のcommitを解決できませんでした',
    ],
    [
      'worktreeの作成に失敗する',
      (t: Harness) =>
        t.worktreeQueue.create.mockResolvedValue({
          ok: false,
          reason: 'gitError',
          message: 'boom',
        } as never),
      'implement' as TaskStage,
      {},
      'gitError',
    ],
    [
      '「実装とPR作成」以降でworktreeが記録されていない',
      () => undefined,
      'review' as TaskStage,
      {},
      'worktreeが記録されていません',
    ],
  ])('%sと、工程を止めて失敗の関門を開く', async (_label, arrange, stage, overrides, message) => {
    const t = build([makeRun([queuedTask('T1', stage, overrides)])]);
    arrange(t);
    await t.runner.pump('run-1');
    await flush();
    expect(t.openClaude).not.toHaveBeenCalled();
    expect(t.task().stages[stage].status).toBe('halted');
    expect(t.task().attention).toBe('failed');
    expect(t.task().failure).toContain(message);
    expect(t.task().gates?.[0]).toMatchObject({ kind: 'stageFailed', status: 'awaitingUser' });
    t.runner.dispose();
  });
});

describe('TaskStageRunner セッションを開けないとき', () => {
  it('MCPの登録を外し、工程を止めて失敗の関門を開く', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])]);
    t.ctl.openError = new Error('起動に失敗');
    await t.runner.pump('run-1');
    await flush();
    expect(t.mcpServer.unregister).toHaveBeenCalledWith('tok-1');
    expect(t.task().stages.issuePlan.status).toBe('halted');
    expect(t.task().failure).toContain('セッションを開けませんでした');
    expect(t.task().failure).toContain('起動に失敗');
    expect(t.task().gates?.[0]?.kind).toBe('stageFailed');
    // 再び始めない（止まっているため）
    t.ctl.openError = undefined;
    await t.runner.pump('run-1');
    expect(t.sessions).toHaveLength(0);
  });

  it('開く途中でdisposeされたら、開いたセッションを閉じて始めない', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], {
      sessionSetup: () => t.runner.dispose(),
    });
    await t.runner.pump('run-1');
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
    expect(t.session().runLoop).not.toHaveBeenCalled();
    expect(t.runner.revealStageSession('run-1', 'T1')).toBe(false);
  });

  it('開く途中に届いた報告・質問は準備中として拒否する', async () => {
    let early: Promise<RoadmapAskOutcome[]> | undefined;
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], {
      sessionSetup: () => {
        early = Promise.all([
          callTool(t, REPORT_STAGE_RESULT_TOOL, {
            ...refArgs(t),
            outcome: 'failed',
            summary: '早すぎる報告',
          }),
          ask(t),
        ]);
      },
    });
    runners.push(t.runner);
    await t.runner.pump('run-1');
    const [report, question] = (await early) ?? [];
    expect(report).toMatchObject({ isError: true });
    expect(report?.text).toContain('準備中');
    expect(question).toMatchObject({ isError: true });
    expect(question?.text).toContain('準備中');
  });
});

describe('TaskStageRunner mergeの鍵', () => {
  it('「mergeとcleanup」はmergeの鍵を持って動かし、失敗したら鍵を放す', async () => {
    const t = build([makeRun([queuedTask('T1', 'mergeCleanup', WORKTREE_TASK)])]);
    runners.push(t.runner);
    await t.runner.pump('run-1');
    expect(t.openClaude).toHaveBeenCalledTimes(1);
    expect((t.deps.mergeKeys as TaskRunMergeKeys).isBusy('/tmp/ws')).toBe(true);
    t.runner.dispose();

    const failing = build([makeRun([queuedTask('T1', 'mergeCleanup', WORKTREE_TASK)])]);
    failing.ctl.openError = new Error('起動不可');
    await failing.runner.pump('run-1');
    await flush();
    expect((failing.deps.mergeKeys as TaskRunMergeKeys).isBusy('/tmp/ws')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 報告（report_stage_result）
// ---------------------------------------------------------------------------

describe('TaskStageRunner 工程の報告', () => {
  it('完了の報告を観測で確かめて工程を確定し、ターンが終わったらセッションを閉じる', async () => {
    const t = await started();
    const outcome = await reportDone(t);
    expect(outcome).toMatchObject({ isError: false });
    expect(outcome.text).toContain('完了を受け付けました');
    expect(t.task().stages.issuePlan.status).toBe('done');
    expect(t.task().issueDraft).toEqual({ title: '題', body: ISSUE_BODY });
    expect(t.session().pauseLoop).toHaveBeenCalledTimes(1);
    // ターンの途中ではまだ閉じない
    t.session().emitState(true);
    await flush();
    expect(t.session().dispose).not.toHaveBeenCalled();
    t.session().emitState(false);
    await flush();
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
    expect(t.mcpServer.unregister).toHaveBeenCalledWith('tok-1');
    expect(t.runner.revealStageSession('run-1', 'T1')).toBe(false);
  });

  it('失敗の報告は工程を止めて関門を開く', async () => {
    const t = await started();
    const outcome = await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      outcome: 'failed',
      summary: 'テストが通らない',
    });
    expect(outcome).toMatchObject({ isError: false });
    expect(outcome.text).toContain('失敗の報告を受け付けました');
    await flush();
    expect(t.task().stages.issuePlan.status).toBe('halted');
    expect(t.task().attention).toBe('needsAction');
    expect(t.task().failure).toContain('テストが通らない');
    expect(t.task().gates?.[0]).toMatchObject({ kind: 'stageFailed', status: 'awaitingUser' });
    t.session().emitState(false);
    await flush();
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
  });

  it('完了条件を満たさない報告は理由を返して続けさせる', async () => {
    const t = await started();
    const outcome = await reportDone(t, { issueBody: '受入基準の節が無い本文' });
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.text).toContain('完了条件を満たしていません');
    expect(t.task().stages.issuePlan.status).toBe('running');
    expect(t.session().pauseLoop).not.toHaveBeenCalled();
  });

  it('観測が例外を投げても理由として返す', async () => {
    const t = build([makeRun([queuedTask('T1', 'issueCreate')])]);
    runners.push(t.runner);
    await t.runner.pump('run-1');
    t.observation.fetchIssueTitle.mockRejectedValue(new Error('forgeに届かない'));
    const outcome = await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      outcome: 'done',
      summary: '起票した',
      issueNumber: 5,
    });
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.text).toContain('観測に失敗しました: forgeに届かない');
  });

  it('観測した事実で「Issue作成」の成果を記録する', async () => {
    const t = build([makeRun([queuedTask('T1', 'issueCreate')])]);
    runners.push(t.runner);
    await t.runner.pump('run-1');
    const outcome = await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      outcome: 'done',
      summary: '起票した',
      issueNumber: 5,
    });
    expect(outcome).toMatchObject({ isError: false });
    expect(t.observation.fetchIssueTitle).toHaveBeenCalledWith('/tmp/ws', 5);
    expect(t.task().issueNumber).toBe(5);
  });

  it('引数が不正な報告・担当の違う報告・未知のツールは拒否する', async () => {
    const t = await started();
    expect(await callTool(t, REPORT_STAGE_RESULT_TOOL, { outcome: 'done' })).toMatchObject({
      isError: true,
    });
    const mismatch = await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      attemptId: 'other',
      outcome: 'failed',
      summary: 's',
    });
    expect(mismatch.text).toContain('担当と異なる');
    expect(await callTool(t, 'unknown_tool', {})).toEqual({
      text: '未知のツールです: unknown_tool',
      isError: true,
    });
  });

  it('報告を受け付けた後の報告と、runが無くなった後の報告は受け付けない', async () => {
    const t = await started();
    await reportDone(t);
    // 完了済みで`currentAttemptId`が空のため、実行回の記録から取る
    const second = await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      taskId: 'T1',
      executionId: 'exec-T1',
      attemptId: lastAttemptId(t),
      stage: 'issuePlan',
      outcome: 'failed',
      summary: 's',
    });
    expect(second.text).toContain('受け付けを終えています');

    const gone = await started();
    const goneAttemptId = lastAttemptId(gone);
    gone.runs.delete('run-1');
    const outcome = await callTool(gone, REPORT_STAGE_RESULT_TOOL, {
      taskId: 'T1',
      executionId: 'exec-T1',
      stage: 'issuePlan',
      attemptId: goneAttemptId,
      outcome: 'failed',
      summary: 's',
    });
    expect(outcome.text).toContain('unknownRun');
  });

  it('reviewの報告は残った指摘を残件へ積み、レビュー後の関門を開く', async () => {
    const runNotes = { recordRemaining: vi.fn(async () => ({ ok: true as const })) };
    const t = build([makeRun([queuedTask('T1', 'review', WORKTREE_TASK)])], { deps: { runNotes } });
    runners.push(t.runner);
    await t.runner.pump('run-1');
    const outcome = await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      outcome: 'done',
      summary: 'レビューした',
      reviewSummary: '指摘が残った',
      reviewPassed: false,
      remainingFindings: ['指摘A'],
    });
    expect(outcome).toMatchObject({ isError: false });
    expect(runNotes.recordRemaining).toHaveBeenCalledWith('/tmp/ws', [
      { runId: 'run-1', runKind: 'taskRun', source: 'reviewFinding', text: '指摘A', taskId: 'T1' },
    ]);
    await flush();
    expect(t.task().review).toMatchObject({ passed: false, remainingFindings: ['指摘A'] });
    expect(t.task().gates?.[0]).toMatchObject({ kind: 'reviewFindings', status: 'awaitingUser' });
  });

  it('reviewが指摘を残さなければ残件へ積まない', async () => {
    const runNotes = { recordRemaining: vi.fn(async () => ({ ok: true as const })) };
    const t = build([makeRun([queuedTask('T1', 'review', WORKTREE_TASK)])], { deps: { runNotes } });
    runners.push(t.runner);
    await t.runner.pump('run-1');
    await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      outcome: 'done',
      summary: 'レビューした',
      reviewSummary: '問題なし',
      reviewPassed: true,
      remainingFindings: [],
    });
    expect(runNotes.recordRemaining).not.toHaveBeenCalled();
    expect(t.task().gates).toBeUndefined();
  });
});

function lastAttemptId(t: Harness): string {
  const attempts = t.task().stages.issuePlan.attempts;
  return attempts.at(-1)?.attemptId ?? '';
}

// ---------------------------------------------------------------------------
// mergeとcleanupの後片付け
// ---------------------------------------------------------------------------

async function mergeCleanupDone(options: HarnessOptions = {}): Promise<Harness> {
  const t = build([makeRun([queuedTask('T1', 'mergeCleanup', WORKTREE_TASK)])], options);
  runners.push(t.runner);
  await t.runner.pump('run-1');
  t.observation.fetchPullRequestState.mockResolvedValue('merged');
  t.observation.remoteBranchHead.mockResolvedValue(null);
  const outcome = await callTool(t, REPORT_STAGE_RESULT_TOOL, {
    ...refArgs(t),
    outcome: 'done',
    summary: 'mergeした',
  });
  expect(outcome).toMatchObject({ isError: false });
  t.session().emitState(false);
  await flush();
  return t;
}

describe('TaskStageRunner merge後の後片付け', () => {
  it('worktree・ローカルのブランチを片付け、鍵を放してタスクのmergeを通知する', async () => {
    const t = await mergeCleanupDone();
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
    expect(t.worktreeQueue.remove).toHaveBeenCalledTimes(1);
    const gitCalls = t.git.run.mock.calls.map((c) => c[0].join(' '));
    expect(gitCalls).toContain('branch -D feat/1/x');
    expect(gitCalls).toContain('fetch origin');
    expect(gitCalls).toContain('pull --ff-only');
    expect(t.onTaskMerged).toHaveBeenCalledWith('run-1', 'T1');
    expect((t.deps.mergeKeys as TaskRunMergeKeys).isBusy('/tmp/ws')).toBe(false);
    expect(t.warnings).toEqual([]);
  });

  it('後片付けの失敗は警告にとどめ、鍵は放す', async () => {
    const t = build([makeRun([queuedTask('T1', 'mergeCleanup', WORKTREE_TASK)])]);
    runners.push(t.runner);
    t.worktreeQueue.remove.mockResolvedValue({ ok: false, message: '使用中' } as never);
    await t.runner.pump('run-1');
    t.observation.fetchPullRequestState.mockResolvedValue('merged');
    t.observation.remoteBranchHead.mockResolvedValue(null);
    await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      outcome: 'done',
      summary: 'mergeした',
    });
    t.session().emitState(false);
    await flush();
    expect(t.warnings.some((w) => w.includes('merge後の後片付けに失敗しました'))).toBe(true);
    expect(t.warnings.some((w) => w.includes('使用中'))).toBe(true);
    expect(t.onTaskMerged).toHaveBeenCalledWith('run-1', 'T1');
    expect((t.deps.mergeKeys as TaskRunMergeKeys).isBusy('/tmp/ws')).toBe(false);
  });

  it('メインのworking treeを進められなければ警告する', async () => {
    const t = build([makeRun([queuedTask('T1', 'mergeCleanup', WORKTREE_TASK)])]);
    runners.push(t.runner);
    t.git.run.mockImplementation(async (args) =>
      args[0] === 'fetch' ? { code: 1, stdout: '', stderr: 'network' } : OK_GIT,
    );
    await t.runner.pump('run-1');
    t.observation.fetchPullRequestState.mockResolvedValue('merged');
    t.observation.remoteBranchHead.mockResolvedValue(null);
    await callTool(t, REPORT_STAGE_RESULT_TOOL, {
      ...refArgs(t),
      outcome: 'done',
      summary: 'mergeした',
    });
    t.session().emitState(false);
    await flush();
    expect(t.warnings.some((w) => w.includes('git fetch originに失敗しました'))).toBe(true);
  });

  it('再読み込みの間にmergeされたタスクを後から片付ける', async () => {
    const done = makeTask('T1', 'mergeCleanup', 'done', WORKTREE_TASK);
    const pending = makeTask('T2', 'mergeCleanup', 'notStarted', WORKTREE_TASK);
    const t = build([makeRun([done, pending])]);
    await t.runner.cleanupRestoredTask('run-1', 'T1');
    expect(t.worktreeQueue.remove).toHaveBeenCalledTimes(1);
    expect(t.onTaskMerged).toHaveBeenCalledWith('run-1', 'T1');
    // 終わっていないタスク・存在しないタスクには何もしない
    await t.runner.cleanupRestoredTask('run-1', 'T2');
    await t.runner.cleanupRestoredTask('run-1', 'T9');
    await t.runner.cleanupRestoredTask('none', 'T1');
    expect(t.onTaskMerged).toHaveBeenCalledTimes(1);
  });

  it('復元後の後片付けの失敗も警告する', async () => {
    const t = build([makeRun([makeTask('T1', 'mergeCleanup', 'done', WORKTREE_TASK)])]);
    t.worktreeQueue.remove.mockResolvedValue({ ok: false, message: '使用中' } as never);
    await t.runner.cleanupRestoredTask('run-1', 'T1');
    expect(t.warnings.some((w) => w.includes('使用中'))).toBe(true);
    expect(t.onTaskMerged).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 質問（ask_orchestrator）と回答・指示
// ---------------------------------------------------------------------------

describe('TaskStageRunner 工程セッションからの質問', () => {
  it('blockingな質問は次の指示を止め、判定の口が無ければユーザーの回答待ちにする', async () => {
    const t = await started();
    const outcome = await ask(t);
    expect(outcome).toMatchObject({ isError: false });
    expect(outcome.text).toContain('回答を待つ');
    expect(t.session().pauseLoop).toHaveBeenCalledTimes(1);
    await flush();
    expect(t.task().questions).toHaveLength(1);
    expect(t.task().questions?.[0]).toMatchObject({
      question: 'どちらにするか',
      blocking: true,
      status: 'awaitingUser',
    });
  });

  it('blockingでない質問は止めずに受け付ける', async () => {
    const t = await started();
    const outcome = await ask(t, { blocking: false });
    expect(outcome.text).toContain('作業を続けてよい');
    expect(t.session().pauseLoop).not.toHaveBeenCalled();
  });

  it('引数が不正な質問は拒否する', async () => {
    const t = await started();
    expect(await ask(t, { question: '' })).toMatchObject({ isError: true });
    expect(t.task().questions).toBeUndefined();
  });

  it('1つの実行回で受け付ける質問の数に上限がある', async () => {
    const t = await started();
    for (let i = 0; i < 20; i += 1) {
      expect(await ask(t, { blocking: false, question: `質問${String(i)}` })).toMatchObject({
        isError: false,
      });
    }
    const over = await ask(t, { blocking: false });
    expect(over).toMatchObject({ isError: true });
    expect(over.text).toContain('上限');
  });

  it('報告を受け付けた後の質問は取り消す', async () => {
    const t = await started();
    await reportDone(t);
    const outcome = await ask(t);
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.text).toContain('取り消された');
  });

  it('回答を記録し、次の指示の頭へ付けて止めていた指示を再開する', async () => {
    const t = await started();
    await ask(t);
    await flush();
    const questionId = t.task().questions?.[0]?.questionId ?? '';
    expect(await t.runner.answerQuestion('run-1', 'T1', questionId, '案Aで進める')).toBe(true);
    expect(t.task().questions?.[0]).toMatchObject({
      status: 'answeredByUser',
      answer: '案Aで進める',
    });
    expect(t.session().resumeLoop).toHaveBeenCalledTimes(1);
    const prompt = t.session().transform?.('本文') ?? '';
    expect(prompt).toContain('ユーザーの回答');
    expect(prompt).toContain('案Aで進める');
    expect(prompt.endsWith('本文')).toBe(true);
    // 付けるのは1回だけ
    expect(t.session().transform?.('次')).toBe('次');
  });

  it('回答待ちのblockingな質問が残っているあいだは再開しない', async () => {
    const t = await started();
    await ask(t);
    await ask(t, { question: 'もう1つ' });
    await flush();
    const [first, second] = t.task().questions ?? [];
    await t.runner.answerQuestion('run-1', 'T1', first?.questionId ?? '', 'A');
    expect(t.session().resumeLoop).not.toHaveBeenCalled();
    await t.runner.answerQuestion('run-1', 'T1', second?.questionId ?? '', 'B');
    expect(t.session().resumeLoop).toHaveBeenCalledTimes(1);
  });

  it('存在しない質問・回答済みの質問への回答は受け付けない', async () => {
    const t = await started();
    await ask(t);
    await flush();
    const questionId = t.task().questions?.[0]?.questionId ?? '';
    expect(await t.runner.answerQuestion('run-1', 'T1', 'none', 'A')).toBe(false);
    expect(await t.runner.answerQuestion('run-1', 'T1', questionId, 'A')).toBe(true);
    expect(await t.runner.answerQuestion('run-1', 'T1', questionId, 'B')).toBe(false);
  });

  it('工程セッションが無くても回答は記録する', async () => {
    const t = await started();
    await ask(t);
    await flush();
    const questionId = t.task().questions?.[0]?.questionId ?? '';
    await t.runner.stopStage('run-1', 'T1');
    // 停止で未回答の質問は取り消される
    expect(t.task().questions?.[0]?.status).toBe('cancelled');
    expect(await t.runner.answerQuestion('run-1', 'T1', questionId, 'A')).toBe(false);
  });
});

describe('TaskStageRunner タブからの指示', () => {
  it('入力を閉じたタブからの指示を次の指示の頭へ付ける', async () => {
    const t = await started();
    expect(await t.runner.instructStage('run-1', 'T1', 'こちらを優先して')).toBe(true);
    expect(await t.runner.instructStage('run-1', 'T1', '次に別の件')).toBe(true);
    const prompt = t.session().transform?.('本文') ?? '';
    expect(prompt).toContain('ユーザーが送った追加の指示');
    expect(prompt).toContain('こちらを優先して');
    expect(prompt).toContain('次に別の件');
    expect(t.session().transform?.('次')).toBe('次');
  });

  it('動いていない工程への指示は受け付けない', async () => {
    const t = await started();
    expect(await t.runner.instructStage('run-1', 'T9', '指示')).toBe(false);
    await reportDone(t);
    expect(await t.runner.instructStage('run-1', 'T1', '指示')).toBe(false);
  });

  it('タブの指示操作は工程へ渡し、渡せなければ警告する', async () => {
    const t = await started();
    t.session().emitLocked({ kind: 'instruct', text: 'こっちを先に' });
    await flush();
    expect(t.session().transform?.('本文')).toContain('こっちを先に');
    await reportDone(t);
    t.session().emitLocked({ kind: 'instruct', text: '遅い指示' });
    await flush();
    expect(t.warnings.some((w) => w.includes('タブからの指示を渡せませんでした'))).toBe(true);
  });

  it('タブの停止操作は工程を止める', async () => {
    const t = await started();
    t.session().emitLocked({ kind: 'stop' });
    await flush();
    expect(t.task().stages.issuePlan.status).toBe('halted');
    expect(t.task().attention).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// 停止
// ---------------------------------------------------------------------------

describe('TaskStageRunner 工程の停止', () => {
  it('動いている工程はループを止めて中断し、タブは残して状態を止める', async () => {
    const t = await started();
    expect(await t.runner.stopStage('run-1', 'T1')).toBe(true);
    const s = t.session();
    expect(s.stopLoop).toHaveBeenCalledTimes(1);
    expect(s.interrupt).toHaveBeenCalledTimes(1);
    expect(s.dispose).not.toHaveBeenCalled();
    expect(t.mcpServer.unregister).toHaveBeenCalledWith('tok-1');
    expect(t.task()).toMatchObject({ attention: 'stopped', failure: '人が止めました' });
    expect(t.task().stages.issuePlan.status).toBe('halted');
    expect(t.runner.revealStageSession('run-1', 'T1')).toBe(false);
    // 止めた後に届いたセッションの終了は工程を上書きしない
    s.emitFinished('manual');
    await flush();
    expect(t.task().attention).toBe('stopped');
  });

  it('理由を指定でき、中断が失敗しても止められる', async () => {
    const t = await started();
    t.session().interrupt.mockRejectedValue(new Error('既に終わっている'));
    expect(await t.runner.stopStage('run-1', 'T1', { reason: '依存が変わった' })).toBe(true);
    expect(t.task().failure).toBe('依存が変わった');
  });

  it('報告を受け付けた工程は止めない', async () => {
    const t = await started();
    await reportDone(t);
    expect(await t.runner.stopStage('run-1', 'T1')).toBe(false);
  });

  it('セッションの無い（空きを待つ）工程は状態だけ止め、liveOnlyなら触らない', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan')])], {
      deps: {
        startGate: {
          policy: () => 'hold',
          tryAcquireLivenessLane: vi.fn(() => true),
          releaseLivenessLane: vi.fn(),
        },
      },
    });
    expect(await t.runner.stopStage('run-1', 'T1', { liveOnly: true })).toBe(false);
    expect(t.task().stages.issuePlan.status).toBe('notStarted');
    expect(await t.runner.stopStage('run-1', 'T1')).toBe(true);
    expect(t.task().stages.issuePlan.status).toBe('halted');
    expect(t.task().attention).toBe('stopped');
    expect(await t.runner.stopStage('none', 'T1')).toBe(false);
  });

  it('専有権を失ったときは、このウィンドウで動いている工程をすべて止める', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan'), queuedTask('T2', 'issuePlan')])]);
    await t.runner.pump('run-1');
    expect(t.sessions).toHaveLength(2);
    expect(await t.runner.stopLiveStagesOfRun('run-1', '専有権を失った')).toBe(2);
    expect(t.task('T1').failure).toBe('専有権を失った');
    expect(t.task('T2').stages.issuePlan.status).toBe('halted');
    expect(await t.runner.stopLiveStagesOfRun('run-1', '再度')).toBe(0);
  });

  it('止められない工程があれば警告して数えない', async () => {
    const t = await started();
    t.session().stopLoop.mockImplementation(() => {
      throw new Error('止められない');
    });
    expect(await t.runner.stopLiveStagesOfRun('run-1', '専有権を失った')).toBe(0);
    expect(t.warnings.some((w) => w.includes('止められませんでした'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 一時停止・再開
// ---------------------------------------------------------------------------

describe('TaskStageRunner 一時停止と再開', () => {
  it('ターンの途中なら終わるのを待ち、終わったらセッションを閉じて並列枠を放す', async () => {
    const t = await started();
    const outcome = await t.runner.pauseStage('run-1', 'T1', '資源を空ける\n改行');
    expect(outcome).toEqual({ ok: true, waitingForTurn: true });
    expect(t.task().pause).toMatchObject({ phase: 'requested', reason: '資源を空ける 改行' });
    expect(t.session().pauseLoop).toHaveBeenCalledTimes(1);
    expect(t.session().dispose).not.toHaveBeenCalled();
    t.session().emitState(false);
    await flush();
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
    expect(t.task().pause?.phase).toBe('paused');
    expect(t.task().stages.issuePlan.status).toBe('running');
    expect(await t.runner.pauseStage('run-1', 'T1', '再度')).toEqual({
      ok: false,
      reason: 'alreadyPaused',
    });
  });

  it('ターンの途中でなければすぐ閉じる。会話を残せるセッションは残す形で閉じる', async () => {
    const t = await started({
      sessionSetup: (s) => {
        s.releaseForPause = vi.fn(async () => ({ memoryFreed: true }));
      },
    });
    t.session().emitState(false);
    const outcome = await t.runner.pauseStage('run-1', 'T1', '休む');
    expect(outcome).toEqual({ ok: true, waitingForTurn: false });
    await flush();
    expect(t.session().releaseForPause).toHaveBeenCalledTimes(1);
    expect(t.session().dispose).not.toHaveBeenCalled();
    expect(t.task().pause?.phase).toBe('paused');
  });

  it('会話を残して閉じられなければ警告してdisposeする', async () => {
    const t = await started({
      sessionSetup: (s) => {
        s.releaseForPause = vi.fn(async () => {
          throw new Error('閉じられない');
        });
      },
    });
    t.session().emitState(false);
    await t.runner.pauseStage('run-1', 'T1', '休む');
    await flush();
    expect(t.warnings.some((w) => w.includes('一時停止でセッションを閉じられませんでした'))).toBe(
      true,
    );
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
    expect(t.task().pause?.phase).toBe('paused');
  });

  it('受け付けられない一時停止は理由を返す', async () => {
    const t = await started();
    expect(await t.runner.pauseStage('run-1', 'T9', 'x')).toEqual({
      ok: false,
      reason: 'noSession',
    });
    await reportDone(t);
    expect(await t.runner.pauseStage('run-1', 'T1', 'x')).toEqual({
      ok: false,
      reason: 'finishing',
    });

    const merge = build([makeRun([queuedTask('T1', 'mergeCleanup', WORKTREE_TASK)])]);
    runners.push(merge.runner);
    await merge.runner.pump('run-1');
    expect(await merge.runner.pauseStage('run-1', 'T1', 'x')).toEqual({
      ok: false,
      reason: 'mergeCleanup',
    });
  });

  it('一時停止した工程の再開は、同じ会話を開き直して続きを送る', async () => {
    const t = await started();
    await t.runner.pauseStage('run-1', 'T1', '休む');
    t.session().emitState(false);
    await flush();
    expect(await t.runner.resumeStage('run-1', 'T1')).toBe(true);
    expect(t.sessions).toHaveLength(2);
    expect(t.openClaude.mock.calls[1]?.[0]).toMatchObject({ resume: { sessionId: 'sess-1' } });
    expect(t.session(1).plans[0]?.initialPrompt).toContain('一時停止していた工程を再開した');
    expect(t.task().pause).toBeUndefined();
    expect(t.task().stages.issuePlan.status).toBe('running');
    // 開き直したセッションで報告できる
    expect(await reportDone(t)).toMatchObject({ isError: false });
  });

  it('ターンの終わりを待っているあいだの再開は、一時停止を取り消してそのまま続ける', async () => {
    const t = await started();
    await t.runner.pauseStage('run-1', 'T1', '休む');
    expect(await t.runner.resumeStage('run-1', 'T1')).toBe(true);
    expect(t.session().resumeLoop).toHaveBeenCalledTimes(1);
    expect(t.task().pause).toBeUndefined();
    t.session().emitState(false);
    await flush();
    expect(t.session().dispose).not.toHaveBeenCalled();
    expect(t.sessions).toHaveLength(1);
  });

  it('一時停止していない工程の再開は受け付けない', async () => {
    const t = await started();
    expect(await t.runner.resumeStage('run-1', 'T1')).toBe(false);
    expect(await t.runner.resumeStage('none', 'T1')).toBe(false);
  });

  it('再開で会話を開き直せなければ工程を止めて関門を開く', async () => {
    const t = await started();
    await t.runner.pauseStage('run-1', 'T1', '休む');
    t.session().emitState(false);
    await flush();
    t.ctl.openError = new Error('会話が無い');
    expect(await t.runner.resumeStage('run-1', 'T1')).toBe(true);
    await flush();
    expect(t.task().stages.issuePlan.status).toBe('halted');
    expect(t.task().failure).toContain('セッションを再開できませんでした: 会話が無い');
    expect(t.task().gates?.[0]?.kind).toBe('stageFailed');
  });

  it('一時停止を受け付けた後にループが終わったら、一時停止として閉じる', async () => {
    const t = await started();
    await t.runner.pauseStage('run-1', 'T1', '休む');
    t.session().emitFinished('maxReached');
    await flush();
    expect(t.task().pause?.phase).toBe('paused');
    expect(t.task().stages.issuePlan.status).toBe('running');
  });

  describe('再読み込みで終わった工程', () => {
    async function reloaded(): Promise<{ t: Harness; second: TaskStageRunner }> {
      const t = await started();
      await t.store.update('run-1', (r) => {
        if (r === undefined) {
          throw new Error('run-1が無い');
        }
        return markStageReloadResuming(r, 'T1', RELOAD_HALT_REASON, FIXTURE_NOW);
      });
      const second = new TaskStageRunner(t.deps);
      runners.push(second);
      return { t, second };
    }

    it('同じ会話を開き直して再読み込み後の指示を送る', async () => {
      const { t, second } = await reloaded();
      await second.pump('run-1');
      expect(t.sessions).toHaveLength(2);
      expect(t.openClaude.mock.calls[1]?.[0]).toMatchObject({ resume: { sessionId: 'sess-1' } });
      expect(t.session(1).plans[0]?.initialPrompt).not.toContain('一時停止していた工程を再開した');
      expect(t.task().pause).toBeUndefined();
    });

    it('開き直せなければ人が「やり直す」まで止め、関門は開かない', async () => {
      const { t, second } = await reloaded();
      t.ctl.openError = new Error('会話が無い');
      await second.pump('run-1');
      await flush();
      expect(t.warnings.some((w) => w.includes('セッションを再開できませんでした'))).toBe(true);
      expect(t.task()).toMatchObject({ attention: 'stopped', failure: RELOAD_HALT_REASON });
      expect(t.task().gates).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 引き継ぎ
// ---------------------------------------------------------------------------

const HANDOFF: TaskHandoffRequest = {
  model: 'next-model',
  effort: '',
  prompt: '引き継ぎの本文',
  trigger: 'auto',
};

function delegateOf(t: Harness, index = 0): (request: TaskHandoffRequest) => Promise<boolean> {
  const delegate = t.openClaude.mock.calls[index]?.[0].handoffDelegate;
  if (delegate === undefined) {
    throw new Error('引き継ぎの委譲先が無い');
  }
  return delegate;
}

describe('TaskStageRunner 引き継ぎ', () => {
  it('新しいセッションを同じ工程のhandoffの実行回として開き、古いセッションは残す', async () => {
    const t = await started();
    const oldAttemptId = lastAttemptId(t);
    expect(await delegateOf(t)(HANDOFF)).toBe(true);
    expect(t.sessions).toHaveLength(2);
    expect(t.openClaude.mock.calls[1]?.[0]).toMatchObject({
      generation: 2,
      config: { model: 'next-model', effort: 'default-effort' },
    });
    const attempts = t.task().stages.issuePlan.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ kind: 'handoff', sessionRef: 'sess-2' });
    expect(t.task().currentAttemptId).toBe(attempts[1]?.attemptId);
    expect(t.session(0).pauseLoop).toHaveBeenCalledTimes(1);
    expect(t.session(0).note).toHaveBeenCalledTimes(1);
    expect(t.session(0).dispose).not.toHaveBeenCalled();
    expect(t.session(1).open).toHaveBeenCalledWith({ preserveFocus: true, viewColumn: 2 });
    expect(t.session(1).plans[0]?.initialPrompt).toContain('引き継ぎの本文');
    expect(t.mcpServer.unregister).toHaveBeenCalledWith('tok-1');

    // 古いタブからの報告・終了・状態の通知は受けない
    const stale = await callTool(
      t,
      REPORT_STAGE_RESULT_TOOL,
      {
        ...refArgs(t),
        attemptId: oldAttemptId,
        outcome: 'failed',
        summary: '古い報告',
      },
      0,
    );
    expect(stale.text).toContain('受け付けを終えています');
    t.session(0).emitFinished('failed');
    t.session(0).emitState(false);
    await flush();
    expect(t.task().stages.issuePlan.status).toBe('running');

    // 新しいセッションで完了できる
    expect(await reportDone(t)).toMatchObject({ isError: false });
  });

  it('引き継ぎ先のModel・Effortが空なら元のセッションの設定を使う', async () => {
    const t = await started();
    await delegateOf(t)({ ...HANDOFF, model: '' });
    expect(t.openClaude.mock.calls[1]?.[0].config).toMatchObject({
      model: 'opus',
      effort: 'default-effort',
    });
  });

  it('引き継ぎ先を開けなければ元のセッションで続ける', async () => {
    const t = await started();
    t.ctl.openError = new Error('開けない');
    expect(await delegateOf(t)(HANDOFF)).toBe(false);
    expect(t.session(0).resumeLoop).toHaveBeenCalledTimes(1);
    expect(t.mcpServer.unregister).toHaveBeenCalledWith('tok-2');
    expect(t.warnings.some((w) => w.includes('引き継ぎに失敗しました'))).toBe(true);
    expect(t.task().stages.issuePlan.attempts).toHaveLength(1);
  });

  it('報告済み・停止中・一時停止中の工程は引き継がない', async () => {
    const reported = await started();
    await reportDone(reported);
    expect(await delegateOf(reported)(HANDOFF)).toBe(false);

    const paused = await started();
    await paused.runner.pauseStage('run-1', 'T1', '休む');
    expect(await delegateOf(paused)(HANDOFF)).toBe(false);
    expect(paused.sessions).toHaveLength(1);
  });

  it('runが無くなっていたら引き継がない', async () => {
    const t = await started();
    t.runs.delete('run-1');
    expect(await delegateOf(t)(HANDOFF)).toBe(false);
  });

  it('引き継ぎの途中でdisposeされたら、開いたセッションを閉じて元のセッションへ戻す', async () => {
    const t = await started({
      sessionSetup: (_s, index) => {
        if (index === 1) {
          // 引き継ぎ先のセッションを開く途中で拡張機能が終了する
          t.runner.dispose();
        }
      },
    });
    expect(await delegateOf(t)(HANDOFF)).toBe(false);
    expect(t.session(1).dispose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// セッションの終了
// ---------------------------------------------------------------------------

describe('TaskStageRunner セッションの終了', () => {
  it.each([
    ['maxReached', `上限${String(MAX_ITERATIONS)}回に達した`],
    ['timedOut', '背景タスクの完了を30分待っても'],
    ['failed', '（failed）'],
  ] as const)(
    '報告なしに%sで終わったら工程を止め、理由を関門へ載せる',
    async (reason, expected) => {
      const t = await started();
      t.session().emitFinished(reason);
      await flush();
      expect(t.task().stages.issuePlan.status).toBe('halted');
      expect(t.task().attention).toBe('needsAction');
      expect(t.task().failure).toContain('報告なしに終わりました');
      expect(t.task().failure).toContain(expected);
      expect(t.task().gates?.[0]).toMatchObject({ kind: 'stageFailed', status: 'awaitingUser' });
      // タブは残して経緯を見られるようにする
      expect(t.session().dispose).not.toHaveBeenCalled();
      expect(t.mcpServer.unregister).toHaveBeenCalledWith('tok-1');
    },
  );

  it('報告を受け付けた後にループが終わったら、閉じて後片付けする', async () => {
    const t = await started();
    await reportDone(t);
    t.session().emitFinished('done');
    await flush();
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
  });

  it('人の停止の結果としての終了は何もしない', async () => {
    const t = await started();
    await t.runner.stopStage('run-1', 'T1');
    t.session().emitFinished('taskStopped');
    await flush();
    expect(t.task().gates).toBeUndefined();
  });

  it('終わった工程の枠は同じフォルダの他の工程へ回る', async () => {
    const t = build([makeRun([queuedTask('T1', 'issuePlan'), queuedTask('T2', 'issuePlan')])], {
      deps: { maxParallelPerFolder: () => 1 },
    });
    runners.push(t.runner);
    await t.runner.pump('run-1');
    t.session().emitFinished('failed');
    await flush();
    expect(t.openClaude).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// mergeコマンドの回答者判定
// ---------------------------------------------------------------------------

describe('TaskStageRunner mergeコマンドの承認', () => {
  async function implementStarted(verdict: AnswererVerdict | Error | undefined) {
    const judgeAnswerer = vi.fn(
      async (
        _runId: string,
        _engine: TaskRunEngine,
        _question: AnswererQuestion,
        _reflex: boolean | undefined,
      ): Promise<AnswererVerdict> => {
        if (verdict === undefined) {
          return { kind: 'user', summary: undefined };
        }
        if (verdict instanceof Error) {
          throw verdict;
        }
        return verdict;
      },
    );
    const t = build([makeRun([queuedTask('T1', 'implement', WORKTREE_TASK)])], {
      deps: { judgeAnswerer },
    });
    runners.push(t.runner);
    await t.runner.pump('run-1');
    return { t, judgeAnswerer };
  }

  const MERGE = { input: { command: 'gh pr merge 5' } };

  it('オーケストレーターが決めてよいと判定されたら承認なしで実行させ、警告で残す', async () => {
    const { t, judgeAnswerer } = await implementStarted({ kind: 'orchestrator', summary: '妥当' });
    const result = await t.session().approval?.({ kind: 'command' } as never, MERGE);
    expect(result).toEqual({ kind: 'auto', decision: 'accept' });
    expect(judgeAnswerer).toHaveBeenCalledWith(
      'run-1',
      'claude',
      expect.objectContaining({
        source: 'stageSession',
        route: 'mergeCommand',
        command: 'gh pr merge 5',
      }),
      undefined,
    );
    expect(t.warnings.some((w) => w.includes('回答者判定で承認なしに実行させた（妥当）'))).toBe(
      true,
    );
  });

  it('ユーザーへ回す判定・判定の失敗・対象外のコマンドは人の承認に回す', async () => {
    const user = await implementStarted({ kind: 'user', summary: '危険' });
    expect(await user.t.session().approval?.({ kind: 'command' } as never, MERGE)).toEqual({
      kind: 'ask',
    });

    const failing = await implementStarted(new Error('timeout'));
    expect(await failing.t.session().approval?.({ kind: 'command' } as never, MERGE)).toEqual({
      kind: 'ask',
    });

    const other = await implementStarted({ kind: 'orchestrator', summary: '妥当' });
    const result = await other.t
      .session()
      .approval?.({ kind: 'command' } as never, { input: { command: 'gh pr merge 99' } });
    expect(result).toEqual({ kind: 'ask' });
    expect(other.judgeAnswerer).not.toHaveBeenCalled();
  });

  it('判定の間に工程セッションが入れ替わったら人へ回す', async () => {
    const { t } = await implementStarted({ kind: 'orchestrator', summary: '妥当' });
    const internals = t.runner as unknown as RunnerInternals;
    const entry = {
      runId: 'run-1',
      ref: { taskId: 'T1', stage: 'implement' },
      closed: false,
      session: t.session(),
    };
    // 帳簿のエントリと別物
    expect(await internals.judgeMergeCommand(entry, 'gh pr merge 5')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 終了処理
// ---------------------------------------------------------------------------

describe('TaskStageRunner.dispose', () => {
  it('動いている工程セッションを閉じ、MCPの登録を外す', async () => {
    const t = await started();
    t.runner.dispose();
    expect(t.session().dispose).toHaveBeenCalledTimes(1);
    expect(t.mcpServer.unregister).toHaveBeenCalledWith('tok-1');
    expect(t.runner.listStageProcesses()).toEqual([]);
  });
});
