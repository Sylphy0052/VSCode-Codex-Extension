import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import type { RunNotesStore } from '../../src/orchestrator/runNotes';
import { createTaskRun, type TaskRun } from '../../src/orchestrator/taskRunState';
import { setupTaskRun, type TaskRunSetupDeps } from '../../src/view/taskRunSetup';
import { __mock } from '../mocks/vscode';

/**
 * `setupTaskRun`（Issue #1505）の組み立てとコマンド登録（Issue #1854）。
 *
 * Controller・Orchestrator・Kanban・Runner等の実体は別のテストで確かめているため、ここでは
 * それらを差し替え、`setupTaskRun`が各部品へ渡す設定（コールバック）と、登録するコマンドの
 * 振る舞いを確かめる。コンストラクタへ渡された設定を`captured`へ取り込み、テストから呼ぶ。
 */

type Loose = Record<string, unknown>;

const hoisted = vi.hoisted(() => {
  const captured: Record<string, Record<string, unknown>> = {};
  const fn = () => vi.fn();
  const fakes = {
    controller: {
      find: fn(),
      board: fn(),
      listActive: fn(),
      startRun: fn(),
      onTransition: fn(),
      restore: fn(),
      handleLeaseLost: fn(),
      handleRunChanged: fn(),
      handleTaskMerged: fn(),
      finishRun: fn(),
      suspendRun: fn(),
      resumeRun: fn(),
    },
    orchestrator: {
      canDecide: fn(),
      open: fn(),
      close: fn(),
      handleRunTransition: fn(),
      notifyResourcePressure: fn(),
      dispose: fn(),
    },
    view: {
      show: fn(),
      refresh: fn(),
      resumeRun: fn(),
      restorePanel: fn(),
      dispose: fn(),
    },
    monitor: {
      refresh: fn(),
      dispose: fn(),
      tryAcquireLivenessLane: fn(),
      releaseLivenessLane: fn(),
      startPolicy: 'unrestricted' as string,
      snapshot: undefined as unknown,
      sampleFailure: undefined as unknown,
    },
    runner: {
      pumpAll: fn(),
      listStageProcesses: fn(),
      revealStageSession: fn(),
      dispose: fn(),
    },
    lease: { holds: fn(), acquire: fn(), dispose: fn() },
    questionServer: { dispose: fn() },
    judges: { judgeByReflex: fn(), judgeAnswerer: fn() },
  };
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const serializers: { viewType: string; serializer: Loose }[] = [];
  return {
    captured,
    fakes,
    commands,
    serializers,
    config: {
      answerer: vi.fn(),
      reflexEnabled: vi.fn(),
      planAutoApprove: vi.fn(),
      claude: vi.fn(),
      codex: vi.fn(),
    },
    judgeQuestionAnswerer: vi.fn(),
    judgeTurnEndAnswerer: vi.fn(),
    proposeHandoffModelSettings: vi.fn(),
    startRoadmapRunCommand: vi.fn(),
    showWorkspaceFolderPick: vi.fn(),
    describeResourceChange: vi.fn(),
    assessTaskRun: vi.fn(),
    resolveRoadmapBaseCommit: vi.fn(),
  };
});

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mocks/vscode')>();
  Object.assign(actual.window, {
    registerWebviewPanelSerializer: (viewType: string, serializer: Loose) => {
      hoisted.serializers.push({ viewType, serializer });
      return { dispose: () => undefined };
    },
    showWorkspaceFolderPick: hoisted.showWorkspaceFolderPick,
  });
  Object.assign(actual.commands, {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      hoisted.commands.set(id, handler);
      return { dispose: () => hoisted.commands.delete(id) };
    },
  });
  return { ...actual, QuickPickItemKind: { Separator: -1, Default: 0 } };
});

vi.mock('../../src/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config')>()),
  readAnswererJudgeConfig: hoisted.config.answerer,
  readReflexEnabled: hoisted.config.reflexEnabled,
  readTaskRunPlanAutoApproveEnabled: hoisted.config.planAutoApprove,
  readClaudeConfig: hoisted.config.claude,
  readConfig: hoisted.config.codex,
  readTaskRunMaxParallelPerFolder: () => 3,
  readTaskRunLowPriorityEnabled: () => true,
  readTaskRunResourceIntervalMs: () => 1234,
  readTaskRunResourceThresholds: () => ({ marker: 'thresholds' }),
}));

vi.mock('../../src/reflex/answererJudge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reflex/answererJudge')>()),
  judgeQuestionAnswerer: hoisted.judgeQuestionAnswerer,
  judgeTurnEndAnswerer: hoisted.judgeTurnEndAnswerer,
}));

vi.mock('../../src/view/handoffModelChoice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/handoffModelChoice')>()),
  proposeHandoffModelSettings: hoisted.proposeHandoffModelSettings,
}));

vi.mock('../../src/view/taskRunRoadmapStart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/taskRunRoadmapStart')>()),
  startRoadmapRunCommand: hoisted.startRoadmapRunCommand,
}));

vi.mock('../../src/view/taskRunStageJudges', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/taskRunStageJudges')>()),
  createStageReflexJudges: vi.fn((opts: Loose) => {
    hoisted.captured.judges = opts;
    return hoisted.fakes.judges;
  }),
}));

vi.mock('../../src/orchestrator/taskRunScheduler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/taskRunScheduler')>()),
  assessTaskRun: hoisted.assessTaskRun,
}));

vi.mock('../../src/orchestrator/taskStageObservation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/taskStageObservation')>()),
  createStageObservationPorts: vi.fn(() => ({ marker: 'observation' })),
}));

vi.mock('../../src/orchestrator/taskRunRoadmapForge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/taskRunRoadmapForge')>()),
  createTaskRunRoadmapPort: vi.fn(() => ({ marker: 'roadmap' })),
}));

vi.mock('../../src/orchestrator/roadmapRunForge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/roadmapRunForge')>()),
  resolveRoadmapBaseCommit: hoisted.resolveRoadmapBaseCommit,
}));

vi.mock('../../src/orchestrator/resourceSampler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/resourceSampler')>()),
  ResourceSampler: vi.fn(function () {
    return { marker: 'sampler' };
  }),
}));

vi.mock('../../src/orchestrator/roadmapQuestionMcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/roadmapQuestionMcp')>()),
  RoadmapQuestionMcpServer: vi.fn(function (opts: Loose) {
    hoisted.captured.questionServer = opts;
    return hoisted.fakes.questionServer;
  }),
}));

vi.mock('../../src/orchestrator/taskRunController', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/taskRunController')>()),
  TaskRunController: vi.fn(function (opts: Loose) {
    hoisted.captured.controller = opts;
    return hoisted.fakes.controller;
  }),
}));

vi.mock('../../src/orchestrator/taskRunOrchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/taskRunOrchestrator')>()),
  TaskRunOrchestrator: vi.fn(function (opts: Loose) {
    hoisted.captured.orchestrator = opts;
    return hoisted.fakes.orchestrator;
  }),
}));

vi.mock('../../src/orchestrator/taskStageRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/taskStageRunner')>()),
  TaskStageRunner: vi.fn(function (opts: Loose) {
    hoisted.captured.runner = opts;
    return hoisted.fakes.runner;
  }),
}));

vi.mock('../../src/orchestrator/taskRunLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/taskRunLease')>()),
  TaskRunLeaseManager: vi.fn(function (opts: Loose) {
    hoisted.captured.lease = opts;
    return hoisted.fakes.lease;
  }),
}));

vi.mock('../../src/orchestrator/resourceMonitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/resourceMonitor')>()),
  describeResourceChange: hoisted.describeResourceChange,
  ResourceMonitor: vi.fn(function (opts: Loose) {
    hoisted.captured.monitor = opts;
    return hoisted.fakes.monitor;
  }),
}));

vi.mock('../../src/view/taskRunKanbanView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/view/taskRunKanbanView')>();
  const Manager = vi.fn(function (opts: Loose) {
    hoisted.captured.view = opts;
    return hoisted.fakes.view;
  });
  Object.assign(Manager, { viewType: 'agent.taskRunKanban.test' });
  return { ...actual, TaskRunKanbanViewManager: Manager };
});

const call = <T = unknown>(fn: unknown, ...args: unknown[]): T =>
  (fn as (...a: unknown[]) => T)(...args);
const opt = (name: string, key: string): unknown => hoisted.captured[name]?.[key];
const fakes = hoisted.fakes;

const ROOT = '/work/repo';
const log: Logger & { warnings: string[]; infos: string[] } = {
  warnings: [],
  infos: [],
  info(message: string) {
    this.infos.push(message);
  },
  warn(message: string) {
    this.warnings.push(message);
  },
  error: () => undefined,
  show: () => undefined,
};

const sessionConfig = vi.fn((engine: string) => ({
  config: { marker: engine },
  sandbox: `sandbox-${engine}`,
}));
const readBaseline = vi.fn(() => ({ allowAutoApprove: true }));
const git = vi.fn();
const cli = vi.fn();
const snapshot = vi.fn(() => ({ models: ['codex-model'] }));
const claudeSnapshot = vi.fn(() => ({ models: ['claude-model'] }));
const worktreeQueue = { marker: 'queue' };

function makeDeps(overrides: Partial<TaskRunSetupDeps> = {}): TaskRunSetupDeps {
  return {
    store: { list: () => [] } as unknown as TaskRunSetupDeps['store'],
    windowId: 'window-1',
    globalStorageDir: '/tmp/global-storage',
    hosts: {} as TaskRunSetupDeps['hosts'],
    worktreeQueue: worktreeQueue as unknown as TaskRunSetupDeps['worktreeQueue'],
    git: git as unknown as TaskRunSetupDeps['git'],
    cli: cli as unknown as TaskRunSetupDeps['cli'],
    sessionConfig: sessionConfig as unknown as TaskRunSetupDeps['sessionConfig'],
    readBaseline: readBaseline as unknown as TaskRunSetupDeps['readBaseline'],
    settings: { snapshot, claudeSnapshot } as unknown as TaskRunSetupDeps['settings'],
    log,
    ...overrides,
  };
}

function runOf(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    ...createTaskRun({
      runId: 'run-1',
      workspaceRoot: ROOT,
      engine: 'claude',
      maxParallel: 2,
      title: 'テストrun',
      now: new Date('2026-10-01T00:00:00.000Z'),
    }),
    ...overrides,
  };
}

function taskWithQuestions(
  taskId: string,
  title: string,
  statuses: Record<string, string>,
): TaskRun['tasks'][string] {
  return {
    taskId,
    title,
    stages: {},
    questions: Object.entries(statuses).map(([questionId, status]) => ({ questionId, status })),
  } as unknown as TaskRun['tasks'][string];
}

function resetFakes(): void {
  for (const key of Object.keys(hoisted.captured)) {
    delete hoisted.captured[key];
  }
  hoisted.commands.clear();
  hoisted.serializers.length = 0;
  for (const group of Object.values(fakes)) {
    for (const value of Object.values(group)) {
      if (typeof value === 'function' && 'mockReset' in value) {
        (value as ReturnType<typeof vi.fn>).mockReset();
      }
    }
  }
  fakes.monitor.startPolicy = 'unrestricted';
  fakes.monitor.snapshot = undefined;
  fakes.monitor.sampleFailure = undefined;
  fakes.controller.restore.mockResolvedValue(undefined);
  fakes.controller.onTransition.mockImplementation((listener: unknown) => {
    hoisted.captured.transition = { listener };
    return { dispose: vi.fn() };
  });
  fakes.controller.board.mockReturnValue({ runs: [] });
  fakes.controller.listActive.mockReturnValue([]);
  fakes.orchestrator.open.mockResolvedValue(true);
  fakes.orchestrator.close.mockResolvedValue(undefined);
  fakes.runner.pumpAll.mockResolvedValue(undefined);
  fakes.runner.listStageProcesses.mockReturnValue([]);
  fakes.lease.holds.mockReturnValue(false);
  fakes.lease.acquire.mockResolvedValue({ ok: false });
  for (const mock of Object.values(hoisted.config)) {
    mock.mockReset();
  }
  hoisted.config.answerer.mockReturnValue({ enabled: true, threshold: 0.8 });
  hoisted.config.reflexEnabled.mockReturnValue(true);
  hoisted.config.planAutoApprove.mockReturnValue(true);
  hoisted.config.claude.mockReturnValue({
    executablePath: 'claude-bin',
    claude: { model: 'opus', effort: 'high' },
  });
  hoisted.config.codex.mockReturnValue({
    executablePath: 'codex-bin',
    codex: { model: 'gpt-x', reasoningEffort: 'low' },
  });
  for (const mock of [
    hoisted.judgeQuestionAnswerer,
    hoisted.judgeTurnEndAnswerer,
    hoisted.proposeHandoffModelSettings,
    hoisted.startRoadmapRunCommand,
    hoisted.showWorkspaceFolderPick,
    hoisted.describeResourceChange,
    hoisted.assessTaskRun,
    hoisted.resolveRoadmapBaseCommit,
  ]) {
    mock.mockReset();
  }
  hoisted.startRoadmapRunCommand.mockResolvedValue(undefined);
  hoisted.assessTaskRun.mockReturnValue({ kind: 'progressing' });
  log.warnings.length = 0;
  log.infos.length = 0;
}

let disposables: vscode.Disposable[] = [];

function setup(overrides: Partial<TaskRunSetupDeps> = {}): vscode.Disposable[] {
  disposables = setupTaskRun(makeDeps(overrides));
  return disposables;
}

/** 動いているrunについて、再描画を待ってから非同期の後続処理を流し切る。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  __mock.reset();
  resetFakes();
});

afterEach(() => {
  disposables = [];
});

describe('setupTaskRun: 組み立てと破棄', () => {
  it('4つのコマンドとKanbanのシリアライザを登録する', () => {
    setup();
    expect([...hoisted.commands.keys()].sort()).toEqual([
      'agent.taskRun.kanban',
      'agent.taskRun.start',
      'agent.taskRun.startFromRoadmap',
      'agent.taskRun.switch',
    ]);
    expect(hoisted.serializers.map((s) => s.viewType)).toEqual(['agent.taskRunKanban.test']);
  });

  it('復元が済んだらresourceMonitorを更新する', async () => {
    setup();
    await flush();
    expect(fakes.controller.restore).toHaveBeenCalledTimes(1);
    expect(fakes.monitor.refresh).toHaveBeenCalledTimes(1);
  });

  it('復元に失敗したら警告を残し、monitorは更新しない', async () => {
    fakes.controller.restore.mockRejectedValue(new Error('壊れた'));
    setup();
    await flush();
    expect(fakes.monitor.refresh).not.toHaveBeenCalled();
    expect(log.warnings).toContain('[task run] 再読み込み後の復元に失敗: Error: 壊れた');
  });

  it('返したDisposableを破棄すると各部品を片付ける', () => {
    const result = setup();
    for (const d of result) {
      d.dispose();
    }
    expect(fakes.monitor.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.lease.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.runner.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.orchestrator.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.questionServer.dispose).toHaveBeenCalledTimes(1);
    expect(fakes.view.dispose).toHaveBeenCalledTimes(1);
  });

  it('Orchestratorは工程セッションの後ろのトークンを外すためサーバより先に破棄する', () => {
    const order: string[] = [];
    fakes.orchestrator.dispose.mockImplementation(() => order.push('orchestrator'));
    fakes.questionServer.dispose.mockImplementation(() => order.push('server'));
    for (const d of setup()) {
      d.dispose();
    }
    expect(order).toEqual(['orchestrator', 'server']);
  });

  it('専有権の置き場とownerをwindowIdから決める', () => {
    setup();
    const owner = opt('lease', 'owner') as Loose;
    expect(owner.windowId).toBe('window-1');
    expect(owner.hostname).toBe(os.hostname());
    expect(owner.pid).toBe(process.pid);
    expect(String(opt('lease', 'dir'))).toContain('/tmp/global-storage');
  });

  it('専有権を失ったらControllerへ伝え、ログへは[task run]を付ける', () => {
    setup();
    call(opt('lease', 'onLost'), 'run-1', { marker: 'lease' });
    expect(fakes.controller.handleLeaseLost).toHaveBeenCalledWith('run-1', { marker: 'lease' });
    call(opt('lease', 'log'), 'msg');
    expect(log.warnings).toEqual(['[task run] msg']);
  });
});

describe('setupTaskRun: Reflex判定の依存', () => {
  it('エンジンごとの実行ファイルを設定から引く', () => {
    setup();
    const reflexDeps = opt('judges', 'reflexDeps');
    expect(call<Loose>(reflexDeps, 'claude')).toMatchObject({
      provider: 'claude',
      executable: 'claude-bin',
    });
    expect(call<Loose>(reflexDeps, 'codex')).toMatchObject({
      provider: 'codex',
      executable: 'codex-bin',
    });
  });

  it('判定器の警告は[task run]を付けて残す', () => {
    setup();
    const deps = call<{ logWarn: (m: string) => void }>(opt('judges', 'reflexDeps'), 'codex');
    deps.logWarn('遅い');
    expect(log.warnings).toEqual(['[task run] 遅い']);
  });

  it('canDecideとlogInfoはOrchestratorとログへ繋ぐ', () => {
    fakes.orchestrator.canDecide.mockReturnValue(true);
    setup();
    expect(call(opt('judges', 'canDecide'), 'run-1')).toBe(true);
    expect(fakes.orchestrator.canDecide).toHaveBeenCalledWith('run-1');
    call(opt('judges', 'logInfo'), '判定した');
    expect(log.infos).toEqual(['[task run] 判定した']);
  });
});

describe('setupTaskRun: Orchestratorの回答者判定', () => {
  const verdict = { kind: 'orchestrator', summary: '妥当' };

  it('ターン末: 無効ならユーザーへ回す', async () => {
    hoisted.config.answerer.mockReturnValue({ enabled: false, threshold: 0.8 });
    fakes.controller.find.mockReturnValue(runOf());
    setup();
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeTurnEndAnswerer'),
      'run-1',
      '終わり',
    );
    expect(result).toEqual({ kind: 'user', summary: undefined });
    expect(hoisted.judgeTurnEndAnswerer).not.toHaveBeenCalled();
  });

  it('ターン末: runが見つからなければユーザーへ回す', async () => {
    fakes.controller.find.mockReturnValue(undefined);
    setup();
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeTurnEndAnswerer'),
      'run-x',
      '終わり',
    );
    expect(result).toEqual({ kind: 'user', summary: undefined });
    expect(hoisted.judgeTurnEndAnswerer).not.toHaveBeenCalled();
  });

  it('ターン末: 有効なら、runのエンジンと閾値で判定する', async () => {
    fakes.controller.find.mockReturnValue(runOf({ engine: 'codex' }));
    hoisted.judgeTurnEndAnswerer.mockResolvedValue(verdict);
    setup();
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeTurnEndAnswerer'),
      'run-1',
      '完了です',
    );
    expect(result).toBe(verdict);
    const args = hoisted.judgeTurnEndAnswerer.mock.calls[0] as unknown[];
    expect(args[0]).toMatchObject({ provider: 'codex', executable: 'codex-bin' });
    expect(args[1]).toBe('完了です');
    expect(args[2]).toBe(0.8);
  });

  const items = [
    {
      question: '進める？',
      options: [
        { label: 'はい', description: '' },
        { label: 'いいえ', description: '止める' },
      ],
    },
  ];

  it('AskUserQuestion: 無効・runなし・質問なしはユーザーへ回す', async () => {
    setup();
    const judge = opt('orchestrator', 'judgeAskUserQuestionAnswerer');
    fakes.controller.find.mockReturnValue(undefined);
    expect(await call<Promise<unknown>>(judge, 'r', items)).toMatchObject({ kind: 'user' });
    fakes.controller.find.mockReturnValue(runOf());
    expect(await call<Promise<unknown>>(judge, 'r', [])).toMatchObject({ kind: 'user' });
    hoisted.config.answerer.mockReturnValue({ enabled: false, threshold: 0.5 });
    expect(await call<Promise<unknown>>(judge, 'r', items)).toMatchObject({ kind: 'user' });
    expect(hoisted.judgeQuestionAnswerer).not.toHaveBeenCalled();
  });

  it('AskUserQuestion: 選択肢は説明があれば括弧書きで添えて問いごとに判定する', async () => {
    fakes.controller.find.mockReturnValue(runOf());
    hoisted.judgeQuestionAnswerer.mockResolvedValue(verdict);
    setup();
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeAskUserQuestionAnswerer'),
      'r',
      items,
    );
    expect(result).toBe(verdict);
    const [, question, threshold] = hoisted.judgeQuestionAnswerer.mock.calls[0] as unknown[];
    expect(question).toEqual({
      source: 'orchestrator',
      route: 'askUserQuestion',
      question: '進める？',
      options: ['はい', 'いいえ（止める）'],
    });
    expect(threshold).toBe(0.8);
  });

  it('AskUserQuestion: 1問でもorchestrator以外ならその結果を返す', async () => {
    fakes.controller.find.mockReturnValue(runOf());
    const userVerdict = { kind: 'user', summary: '危険' };
    hoisted.judgeQuestionAnswerer.mockResolvedValueOnce(verdict).mockResolvedValueOnce(userVerdict);
    setup();
    const two = [...items, { question: '消す？', options: [] }];
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeAskUserQuestionAnswerer'),
      'r',
      two,
    );
    expect(result).toBe(userVerdict);
    expect(hoisted.judgeQuestionAnswerer).toHaveBeenCalledTimes(2);
  });

  const target = {
    engine: 'claude',
    question: 'どちら？',
    reason: '迷う',
    options: ['A', 'B'],
    evidence: '根拠',
    escalationNote: '昇格理由',
    reflexSummary: '要約',
  };

  it('Orchestratorの回答案: 無効ならユーザーへ回す', async () => {
    hoisted.config.answerer.mockReturnValue({ enabled: false, threshold: 0.8 });
    setup();
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeQuestionAnswerByOrchestrator'),
      target,
      'A',
    );
    expect(result).toEqual({ kind: 'user', summary: undefined });
    expect(hoisted.judgeQuestionAnswerer).not.toHaveBeenCalled();
  });

  it('Orchestratorの回答案: 回答案と過去の判定を根拠へ足して判定し直す', async () => {
    hoisted.judgeQuestionAnswerer.mockResolvedValue(verdict);
    setup();
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeQuestionAnswerByOrchestrator'),
      target,
      'Aにする',
    );
    expect(result).toBe(verdict);
    const [deps, question] = hoisted.judgeQuestionAnswerer.mock.calls[0] as [Loose, Loose];
    expect(deps).toMatchObject({ provider: 'claude' });
    expect(question).toEqual({
      source: 'stageSession',
      route: 'questionAnswer',
      question: 'どちら？',
      reason: '迷う',
      options: ['A', 'B'],
      evidence: '根拠\n昇格理由\nこれまでの判定: 要約\nオーケストレーターの回答案: Aにする',
    });
  });

  it('Orchestratorの回答案: 根拠が未設定の項目は行ごと外す', async () => {
    hoisted.judgeQuestionAnswerer.mockResolvedValue(verdict);
    setup();
    await call(
      opt('orchestrator', 'judgeQuestionAnswerByOrchestrator'),
      { ...target, evidence: undefined, escalationNote: undefined, reflexSummary: undefined },
      'B',
    );
    const [, question] = hoisted.judgeQuestionAnswerer.mock.calls[0] as [Loose, Loose];
    expect(question.evidence).toBe('オーケストレーターの回答案: B');
  });

  it('stop_stage: runとタスクが分かれば止めてよいか判定し、タイトルは1行化する', async () => {
    const task = taskWithQuestions('T1', '長い\n題名', {});
    fakes.controller.find.mockReturnValue(
      runOf({ taskOrder: ['T1'], tasks: { T1: task } as TaskRun['tasks'] }),
    );
    hoisted.judgeQuestionAnswerer.mockResolvedValue(verdict);
    setup();
    const result = await call<Promise<unknown>>(
      opt('orchestrator', 'judgeStopStageAnswerer'),
      'run-1',
      'T1',
      '不要になった',
    );
    expect(result).toBe(verdict);
    const [, question] = hoisted.judgeQuestionAnswerer.mock.calls[0] as [Loose, Loose];
    expect(question).toMatchObject({
      source: 'orchestrator',
      route: 'stopStage',
      reason: '不要になった',
      options: ['止める', '止めない'],
    });
    expect(String(question.question)).toContain('タスクT1「');
    expect(String(question.question)).not.toContain('\n');
    expect(String(question.question)).toContain('止めてよいか');
  });

  it('stop_stage: 無効・runなし・タスクなしはユーザーへ回す', async () => {
    setup();
    const judge = opt('orchestrator', 'judgeStopStageAnswerer');
    fakes.controller.find.mockReturnValue(undefined);
    expect(await call<Promise<unknown>>(judge, 'r', 'T1', undefined)).toMatchObject({
      kind: 'user',
    });
    fakes.controller.find.mockReturnValue(runOf());
    expect(await call<Promise<unknown>>(judge, 'r', 'T9', undefined)).toMatchObject({
      kind: 'user',
    });
    expect(hoisted.judgeQuestionAnswerer).not.toHaveBeenCalled();
  });
});

describe('setupTaskRun: TaskStageRunnerの設定', () => {
  it('専有権を持っていれば取り直さず、持っていなければ取得を試みて結果を返す', async () => {
    setup();
    const canDrive = (opt('runner', 'drive') as Loose).canDrive;
    fakes.lease.holds.mockReturnValue(true);
    expect(await call<Promise<boolean>>(canDrive, 'run-1')).toBe(true);
    expect(fakes.lease.acquire).not.toHaveBeenCalled();
    fakes.lease.holds.mockReturnValue(false);
    expect(await call<Promise<boolean>>(canDrive, 'run-1')).toBe(false);
    fakes.lease.acquire.mockResolvedValue({ ok: true });
    expect(await call<Promise<boolean>>(canDrive, 'run-1')).toBe(true);
    const holds = (opt('runner', 'drive') as Loose).holds;
    fakes.lease.holds.mockReturnValue(true);
    expect(call(holds, 'run-1')).toBe(true);
  });

  it('固定値と設定の読み取りを渡す', () => {
    setup();
    expect(opt('runner', 'maxIterations')).toBe(10);
    expect(call(opt('runner', 'maxParallelPerFolder'))).toBe(3);
    expect(call(opt('runner', 'lowPriority'))).toBe(true);
    expect(call(opt('runner', 'autoApprove'))).toBe(true);
    readBaseline.mockReturnValueOnce({ allowAutoApprove: false });
    expect(call(opt('runner', 'autoApprove'))).toBe(false);
    expect(call(opt('runner', 'sessionConfig'), 'codex')).toEqual({
      config: { marker: 'codex' },
      sandbox: 'sandbox-codex',
    });
  });

  it('基点commitはロードマップ側の解決へ渡す', () => {
    hoisted.resolveRoadmapBaseCommit.mockReturnValue('base');
    setup();
    expect(call(opt('runner', 'resolveBaseCommit'), ROOT)).toBe('base');
    const [ports, root] = hoisted.resolveRoadmapBaseCommit.mock.calls[0] as [Loose, string];
    expect(ports).toEqual({ git, cli });
    expect(root).toBe(ROOT);
  });

  it('runNotesは渡されたときだけRunner・Orchestratorへ渡す', () => {
    setup();
    expect('runNotes' in (hoisted.captured.runner ?? {})).toBe(false);
    expect('runNotes' in (hoisted.captured.orchestrator ?? {})).toBe(false);
    const runNotes = { marker: 'notes' } as unknown as RunNotesStore;
    setup({ runNotes });
    expect(opt('runner', 'runNotes')).toBe(runNotes);
    expect(opt('orchestrator', 'runNotes')).toBe(runNotes);
  });

  it('runの変更とタスクのmergeはControllerへ伝え、警告はrunとタスクを添える', () => {
    setup();
    call(opt('runner', 'onRunChanged'), { runId: 'run-1' });
    expect(fakes.controller.handleRunChanged).toHaveBeenCalledWith({ runId: 'run-1' });
    call(opt('runner', 'onTaskMerged'), 'run-1', 'T2');
    expect(fakes.controller.handleTaskMerged).toHaveBeenCalledWith('run-1', 'T2');
    call(opt('runner', 'onWarning'), 'run-1', 'T2', '競合');
    expect(log.warnings).toEqual(['[task run] run-1 T2: 競合']);
  });

  it('startGate: monitorの扱いと生存確認の枠を渡す', () => {
    setup();
    const gate = opt('runner', 'startGate') as Loose;
    fakes.monitor.startPolicy = 'hold';
    expect(call(gate.policy)).toBe('hold');
    fakes.monitor.tryAcquireLivenessLane.mockReturnValue(true);
    expect(call(gate.tryAcquireLivenessLane)).toBe(true);
    fakes.monitor.tryAcquireLivenessLane.mockReturnValue(false);
    expect(call(gate.tryAcquireLivenessLane)).toBe(false);
    call(gate.releaseLivenessLane);
    expect(fakes.monitor.releaseLivenessLane).toHaveBeenCalledTimes(1);
  });
});

describe('setupTaskRun: TaskRunControllerの設定', () => {
  it('モデル一覧はエンジンごとの設定から取る', () => {
    setup();
    const catalog = opt('controller', 'modelCatalog');
    expect(call<Loose>(catalog, 'claude').models).toEqual(['claude-model']);
    expect(call<Loose>(catalog, 'codex').models).toEqual(['codex-model']);
    expect(call<Loose>(catalog, 'codex').fallbackEfforts).toBeDefined();
  });

  it('計画の自動承認は設定が有効なときだけ判定器と閾値を返す', () => {
    setup();
    const auto = opt('controller', 'planAutoApprove');
    const enabled = call<Loose>(auto, 'claude');
    expect(enabled.reflex).toMatchObject({ provider: 'claude' });
    expect(typeof enabled.threshold).toBe('number');
    hoisted.config.planAutoApprove.mockReturnValue(false);
    expect(call(auto, 'claude')).toBeUndefined();
  });

  it('計画・関門の審査はReflexモードが有効なときだけ行う', () => {
    setup();
    expect(opt('controller', 'gateReview')).toBe(opt('controller', 'planReview'));
    const review = opt('controller', 'planReview');
    expect(call<Loose>(review, 'codex').reflex).toMatchObject({ provider: 'codex' });
    hoisted.config.reflexEnabled.mockReturnValue(false);
    expect(call(review, 'codex')).toBeUndefined();
  });

  it('工程の推奨設定: Claudeは現在の設定を渡して提案を整形する', async () => {
    hoisted.proposeHandoffModelSettings.mockResolvedValue({
      settings: { model: 'sonnet', effort: 'low' },
      reasons: ['軽い'],
    });
    setup();
    const result = await call<Promise<unknown>>(
      opt('controller', 'recommendStageSettings'),
      'claude',
      { marker: 'input' },
    );
    expect(result).toEqual({ model: 'sonnet', effort: 'low', reasons: ['軽い'] });
    const [current, input, options] = hoisted.proposeHandoffModelSettings.mock.calls[0] as [
      Loose,
      Loose,
      Loose,
    ];
    expect(current).toEqual({ model: 'opus', effort: 'high' });
    expect(input).toEqual({ marker: 'input' });
    expect(options).toMatchObject({
      provider: 'claude',
      executable: 'claude-bin',
      models: ['claude-model'],
    });
  });

  it('工程の推奨設定: Codexはreasoning effortを現在値にする', async () => {
    hoisted.proposeHandoffModelSettings.mockResolvedValue({
      settings: { model: 'gpt-y', effort: 'high' },
      reasons: [],
    });
    setup();
    await call(opt('controller', 'recommendStageSettings'), 'codex', {});
    const [current, , options] = hoisted.proposeHandoffModelSettings.mock.calls[0] as [
      Loose,
      Loose,
      Loose,
    ];
    expect(current).toEqual({ model: 'gpt-x', effort: 'low' });
    expect(options).toMatchObject({
      provider: 'codex',
      executable: 'codex-bin',
      models: ['codex-model'],
    });
  });

  describe('pathExists', () => {
    it('あればtrue、無ければfalse、親がファイルでもfalse', async () => {
      setup();
      const pathExists = opt('controller', 'pathExists');
      const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'task-run-setup-'));
      try {
        const file = path.join(dir, 'a.txt');
        await fsPromises.writeFile(file, 'x');
        expect(await call<Promise<boolean>>(pathExists, dir)).toBe(true);
        expect(await call<Promise<boolean>>(pathExists, path.join(dir, 'none'))).toBe(false);
        expect(await call<Promise<boolean>>(pathExists, path.join(file, 'child'))).toBe(false);
      } finally {
        await fsPromises.rm(dir, { recursive: true, force: true });
      }
    });

    it('ENOENT・ENOTDIR以外のI/Oエラーは「消えた」と見なさず再送出する', async () => {
      setup();
      await expect(
        call<Promise<boolean>>(opt('controller', 'pathExists'), 'a\0b'),
      ).rejects.toThrow();
    });
  });

  it('Controllerのログはinfoへ出す', () => {
    setup();
    call(opt('controller', 'log'), 'メッセージ');
    expect(log.infos).toEqual(['メッセージ']);
  });
});

describe('setupTaskRun: Orchestratorと資源monitorの設定', () => {
  it('KanbanはOrchestratorが自分で開く・変更で再描画する', () => {
    setup();
    call(opt('orchestrator', 'showKanban'), 'run-1');
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    call(opt('orchestrator', 'onDidChange'));
    expect(fakes.view.refresh).toHaveBeenCalledTimes(1);
    call(opt('orchestrator', 'log'), 'msg');
    expect(log.warnings).toEqual(['msg']);
  });

  it('資源の行はmonitorのsnapshotから作る', () => {
    setup();
    fakes.monitor.snapshot = undefined;
    const lines = call<string[]>(opt('orchestrator', 'resourceLines'), 'run-1');
    expect(lines).toEqual(['資源: 未計測']);
    fakes.monitor.sampleFailure = {
      since: new Date('2026-10-01T00:00:00.000Z'),
      count: 3,
      lastMessage: 'ps失敗',
    };
    const failed = call<string[]>(opt('orchestrator', 'resourceLines'), 'run-1');
    expect(failed[0]).toBe('資源: 未計測');
    expect(failed[1]).toContain('計測失敗: 2026-10-01T00:00:00.000Zから3回続けて失敗');
    expect(failed[1]).toContain('最後: ps失敗');
  });

  it('新規開始の扱いはmonitorが無ければunrestricted', () => {
    setup();
    fakes.monitor.startPolicy = 'hold';
    expect(call(opt('orchestrator', 'startPolicy'))).toBe('hold');
  });

  it('動いているrunがある間だけ計測し、工程プロセスはRunnerから取る', () => {
    const active = runOf();
    const done = runOf({ finishedAt: '2026-10-01T01:00:00.000Z' });
    fakes.runner.listStageProcesses.mockReturnValue([{ pid: 1 }]);
    setup({ store: { list: () => [done] } as unknown as TaskRunSetupDeps['store'] });
    expect(call(opt('monitor', 'hasActiveRuns'))).toBe(false);
    expect(call(opt('monitor', 'listStageProcesses'))).toEqual([{ pid: 1 }]);
    setup({ store: { list: () => [done, active] } as unknown as TaskRunSetupDeps['store'] });
    expect(call(opt('monitor', 'hasActiveRuns'))).toBe(true);
    expect(opt('monitor', 'intervalMs')).toBeDefined();
    expect(call(opt('monitor', 'intervalMs'))).toBe(1234);
    expect(call(opt('monitor', 'thresholds'))).toEqual({ marker: 'thresholds' });
  });

  it('状態が変わったらログへ残し、Orchestratorへrunごとの本文で知らせる', () => {
    hoisted.describeResourceChange.mockReturnValue('本文');
    setup();
    const next = {
      cpuLevel: 'warning',
      memoryLevel: 'ok',
      cpu: { method: 'loadavg' },
      startPolicy: 'hold',
    };
    call(opt('monitor', 'onLevelChanged'), undefined, next);
    expect(log.infos[0]).toBe(
      '[task run] 資源の状態: CPU ok -> warning（loadavg） / メモリ ok -> ok / 新規開始 hold',
    );
    const builder = fakes.orchestrator.notifyResourcePressure.mock.calls[0]?.[0] as (
      id: string,
    ) => string;
    expect(builder('run-7')).toBe('本文');
    expect(hoisted.describeResourceChange).toHaveBeenCalledWith(undefined, next, 'run-7');
    const prev = { cpuLevel: 'critical', memoryLevel: 'warning' };
    call(opt('monitor', 'onLevelChanged'), prev, next);
    expect(log.infos[1]).toContain('CPU critical -> warning');
    expect(log.infos[1]).toContain('メモリ warning -> ok');
  });

  it('計測のたび、保留した工程を始められる扱いのときだけ開始を促す', () => {
    setup();
    const sampled = opt('monitor', 'onSampled');
    // unrestricted -> unrestricted: 変化なし
    call(sampled, { startPolicy: 'unrestricted' });
    expect(fakes.runner.pumpAll).not.toHaveBeenCalled();
    // 変化: holdへ（促さない）
    call(sampled, { startPolicy: 'hold' });
    expect(fakes.runner.pumpAll).not.toHaveBeenCalled();
    // hold -> unrestricted: 変化したので促す
    call(sampled, { startPolicy: 'unrestricted' });
    expect(fakes.runner.pumpAll).toHaveBeenCalledTimes(1);
    // livenessは変化がなくても毎回促す
    call(sampled, { startPolicy: 'liveness' });
    call(sampled, { startPolicy: 'liveness' });
    expect(fakes.runner.pumpAll).toHaveBeenCalledTimes(3);
  });

  it('保留した工程の開始に失敗したら警告を残す', async () => {
    fakes.runner.pumpAll.mockRejectedValue(new Error('失敗'));
    setup();
    call(opt('monitor', 'onSampled'), { startPolicy: 'liveness' });
    await flush();
    expect(log.warnings).toContain('[task run] 保留した工程の開始に失敗: Error: 失敗');
    call(opt('monitor', 'log'), 'm');
    expect(log.warnings).toContain('m');
  });
});

describe('setupTaskRun: runの終了・中断・再開', () => {
  it('終了: 成功したらOrchestratorを閉じ、失敗なら閉じない', async () => {
    setup();
    const finishRun = opt('view', 'finishRun');
    fakes.controller.finishRun.mockResolvedValue({ ok: true, message: '' });
    expect(await call<Promise<unknown>>(finishRun, 'run-1')).toEqual({ ok: true, message: '' });
    expect(fakes.orchestrator.close).toHaveBeenCalledWith('run-1');
    fakes.orchestrator.close.mockClear();
    fakes.controller.finishRun.mockResolvedValue({ ok: false, message: '無理' });
    expect(await call<Promise<unknown>>(finishRun, 'run-1')).toEqual({
      ok: false,
      message: '無理',
    });
    expect(fakes.orchestrator.close).not.toHaveBeenCalled();
  });

  it('中断: 成功したらOrchestratorを閉じ、失敗なら閉じない', async () => {
    setup();
    const suspendRun = opt('view', 'suspendRun');
    fakes.controller.suspendRun.mockResolvedValue({ ok: true, message: '' });
    await call(suspendRun, 'run-1');
    expect(fakes.orchestrator.close).toHaveBeenCalledWith('run-1');
    fakes.orchestrator.close.mockClear();
    fakes.controller.suspendRun.mockResolvedValue({ ok: false, message: 'だめ' });
    expect(await call<Promise<unknown>>(suspendRun, 'run-1')).toEqual({
      ok: false,
      message: 'だめ',
    });
    expect(fakes.orchestrator.close).not.toHaveBeenCalled();
  });

  it('再開: 成功したらKanbanとOrchestratorへ出し、オプションを渡す', async () => {
    setup();
    const resumeRun = opt('view', 'resumeRun');
    fakes.controller.resumeRun.mockResolvedValue({ ok: true, message: '' });
    await call(resumeRun, 'run-1', { parallel: true });
    expect(fakes.controller.resumeRun).toHaveBeenCalledWith('run-1', { parallel: true });
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    expect(fakes.orchestrator.open).toHaveBeenCalledWith('run-1');
  });

  it('再開に失敗したら何も開かない', async () => {
    setup();
    fakes.controller.resumeRun.mockResolvedValue({ ok: false, message: 'だめ' });
    await call(opt('view', 'resumeRun'), 'run-1');
    expect(fakes.view.show).not.toHaveBeenCalled();
    expect(fakes.orchestrator.open).not.toHaveBeenCalled();
  });

  it('Orchestratorを開けなかったら警告を出す', async () => {
    fakes.orchestrator.open.mockResolvedValue(false);
    fakes.controller.resumeRun.mockResolvedValue({ ok: true, message: '' });
    setup();
    await call(opt('view', 'resumeRun'), 'run-1');
    await flush();
    expect(__mock.messages.warnings).toEqual([
      'オーケストレータモード: Orchestratorを開けませんでした。Kanbanの「Orchestratorを開く」で開き直せます',
    ]);
  });

  it('工程の表示はRunnerへ委ねる', () => {
    setup();
    call(opt('view', 'revealStage'), 'run-1', 'T1');
    expect(fakes.runner.revealStageSession).toHaveBeenCalledWith('run-1', 'T1');
  });

  it('Kanbanのタブ復元はviewへ委ねる', async () => {
    setup();
    const panel = { marker: 'panel' };
    await call(hoisted.serializers[0]?.serializer.deserializeWebviewPanel, panel, { s: 1 });
    expect(fakes.view.restorePanel).toHaveBeenCalledWith(panel, { s: 1 });
  });
});

describe('setupTaskRun: runの遷移の通知', () => {
  const transition = (prev: TaskRun | undefined, next: TaskRun): void => {
    call(opt('transition', 'listener'), prev, next);
  };

  it('遷移のたびにmonitor・Orchestrator・Kanbanを更新する', () => {
    setup();
    const next = runOf();
    transition(undefined, next);
    expect(fakes.monitor.refresh).toHaveBeenCalled();
    expect(fakes.orchestrator.handleRunTransition).toHaveBeenCalledWith(undefined, next);
    expect(fakes.view.refresh).toHaveBeenCalledTimes(1);
  });

  it('動いていないrunでは通知しない', () => {
    setup();
    transition(
      undefined,
      runOf({ finishedAt: '2026-10-01T01:00:00.000Z', planStatus: 'awaitingApproval' }),
    );
    transition(
      undefined,
      runOf({ suspendedAt: '2026-10-01T01:00:00.000Z', planStatus: 'awaitingApproval' }),
    );
    expect(__mock.messages.warnings).toEqual([]);
  });

  it('計画が承認待ちになったときだけ通知し、すでに承認待ちなら通知しない', () => {
    setup();
    const waiting = runOf({ planStatus: 'awaitingApproval' });
    transition(runOf(), waiting);
    expect(__mock.messages.warnings).toEqual([
      'オーケストレータモード「テストrun」: 計画の承認待ちです。Kanbanで確かめて承認してください',
    ]);
    transition(waiting, waiting);
    expect(__mock.messages.warnings).toHaveLength(1);
  });

  it('ユーザー判断待ちの質問が新しく増えたタスクを通知する', () => {
    setup();
    const prev = runOf({
      taskOrder: ['T1', 'T2'],
      tasks: {
        T1: taskWithQuestions('T1', '既存', { q1: 'awaitingUser' }),
        T2: taskWithQuestions('T2', '別', { q2: 'answered' }),
      } as TaskRun['tasks'],
    });
    const next = runOf({
      taskOrder: ['T1', 'T2'],
      tasks: {
        T1: taskWithQuestions('T1', '既存', { q1: 'awaitingUser' }),
        T2: taskWithQuestions('T2', '別\nタイトル', { q2: 'awaitingUser', q3: 'awaitingUser' }),
      } as TaskRun['tasks'],
    });
    transition(prev, next);
    expect(__mock.messages.warnings).toEqual([
      'オーケストレータモード「テストrun」: ユーザー判断待ちの質問があります（T2 別 タイトル）',
    ]);
  });

  it('質問を持たないタスクは数えない', () => {
    setup();
    const task = { taskId: 'T1', title: 't', stages: {} } as unknown as TaskRun['tasks'][string];
    transition(undefined, runOf({ taskOrder: ['T1'], tasks: { T1: task } as TaskRun['tasks'] }));
    expect(__mock.messages.warnings).toEqual([]);
  });

  it('人の対応待ちで止まったときだけ通知する（すでに止まっていれば通知しない）', () => {
    setup();
    const stalled = { kind: 'stalled', blockers: ['T1', 'T3'] };
    // 呼び出し順は prev -> next
    hoisted.assessTaskRun.mockReturnValueOnce({ kind: 'progressing' }).mockReturnValueOnce(stalled);
    transition(runOf(), runOf());
    expect(__mock.messages.warnings).toEqual([
      'オーケストレータモード「テストrun」: 人の対応待ちで止まりました（T1, T3）',
    ]);
    // 前もstalledなら通知しない
    hoisted.assessTaskRun.mockReturnValue(stalled);
    transition(runOf(), runOf());
    expect(__mock.messages.warnings).toHaveLength(1);
  });

  it('prevが無く止まっているrunは通知する', () => {
    setup();
    hoisted.assessTaskRun.mockReturnValue({ kind: 'stalled', blockers: [] });
    transition(undefined, runOf());
    expect(__mock.messages.warnings).toHaveLength(1);
  });

  it('「Kanbanを開く」を押すと、動いているrunはOrchestratorも開く', async () => {
    setup();
    const active = runOf({ planStatus: 'awaitingApproval' });
    fakes.controller.find.mockReturnValue(active);
    transition(undefined, active);
    await flush();
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    expect(fakes.orchestrator.open).toHaveBeenCalledWith('run-1');
  });

  it('「Kanbanを開く」を押しても、中断中のrunはKanbanだけを開く', async () => {
    setup();
    const next = runOf({ planStatus: 'awaitingApproval' });
    fakes.controller.find.mockReturnValue(runOf({ suspendedAt: '2026-10-01T01:00:00.000Z' }));
    transition(undefined, next);
    await flush();
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    expect(fakes.orchestrator.open).not.toHaveBeenCalled();
  });

  it('「Kanbanを開く」を押さなければ何も切り替えない', async () => {
    __mock.showWarningMessageAnswer = undefined;
    setup();
    transition(undefined, runOf({ planStatus: 'awaitingApproval' }));
    await flush();
    expect(fakes.view.show).not.toHaveBeenCalled();
  });
});

const command = (id: string): ((...args: unknown[]) => Promise<void>) => {
  const handler = hoisted.commands.get(id);
  if (handler === undefined) {
    throw new Error(`コマンド未登録: ${id}`);
  }
  return handler as (...args: unknown[]) => Promise<void>;
};

/** `showQuickPick`へ渡された項目から、条件に合う1件を選ぶ。選んだ項目の履歴を返す。 */
function answerQuickPicks(
  chooser: (items: readonly Loose[], index: number) => unknown,
): readonly (readonly Loose[])[] {
  const seen: (readonly Loose[])[] = [];
  __mock.showQuickPickAnswer = (items) => {
    seen.push(items as readonly Loose[]);
    return chooser(items as readonly Loose[], seen.length - 1);
  };
  return seen;
}

const byValue =
  (value: string) =>
  (items: readonly Loose[]): unknown =>
    items.find((i) => i.value === value);

describe('コマンド: agent.taskRun.kanban', () => {
  it('Kanbanを開く', async () => {
    setup();
    await command('agent.taskRun.kanban')();
    expect(fakes.view.show).toHaveBeenCalledWith();
  });
});

describe('コマンド: agent.taskRun.startFromRoadmap', () => {
  it('フォルダが無ければエラーを出して何もしない', async () => {
    setup();
    await command('agent.taskRun.startFromRoadmap')(12);
    expect(__mock.messages.errors).toEqual([
      'オーケストレータモード: フォルダを開いてから実行してください',
    ]);
    expect(hoisted.startRoadmapRunCommand).not.toHaveBeenCalled();
  });

  it('Issue番号を検証して渡す（正の安全な整数だけ）', async () => {
    __mock.setWorkspaceFolder(ROOT);
    setup();
    const start = command('agent.taskRun.startFromRoadmap');
    await start(12);
    await start(0);
    await start(1.5);
    await start('12');
    await start();
    expect(hoisted.startRoadmapRunCommand.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [ROOT, 12],
      [ROOT, undefined],
      [ROOT, undefined],
      [ROOT, undefined],
      [ROOT, undefined],
    ]);
  });

  it('複数フォルダならピッカーで選んだフォルダを使い、取り消したら何もしない', async () => {
    __mock.setWorkspaceFolders([
      { fsPath: '/a', name: 'a' },
      { fsPath: '/b', name: 'b' },
    ]);
    setup();
    hoisted.showWorkspaceFolderPick.mockResolvedValueOnce({ uri: { fsPath: '/b' } });
    await command('agent.taskRun.startFromRoadmap')(3);
    expect(hoisted.startRoadmapRunCommand.mock.calls[0]?.[1]).toBe('/b');
    expect(hoisted.showWorkspaceFolderPick).toHaveBeenCalledWith({
      placeHolder: '実行するリポジトリ',
    });
    hoisted.showWorkspaceFolderPick.mockResolvedValueOnce(undefined);
    await command('agent.taskRun.startFromRoadmap')(3);
    expect(hoisted.startRoadmapRunCommand).toHaveBeenCalledTimes(1);
  });

  it('ロードマップ開始へ渡す依存はController・設定の尋ね方・再開・表示を繋ぐ', async () => {
    __mock.setWorkspaceFolder(ROOT);
    setup();
    await command('agent.taskRun.startFromRoadmap')(5);
    const deps = hoisted.startRoadmapRunCommand.mock.calls[0]?.[0] as Loose;
    expect(deps.controller).toBe(fakes.controller);
    expect(deps.git).toBe(git);
    expect(deps.cli).toBe(cli);
    expect(deps.log).toBe(log);
    fakes.controller.resumeRun.mockResolvedValue({ ok: true, message: '' });
    await call(deps.resumeRun, 'run-9');
    expect(fakes.controller.resumeRun).toHaveBeenCalledWith('run-9', { parallel: true });
    call(deps.showRun, 'run-9');
    expect(fakes.view.show).toHaveBeenCalledWith('run-9');
    expect(fakes.orchestrator.open).toHaveBeenCalledWith('run-9');
  });
});

describe('コマンド: agent.taskRun.switch', () => {
  const board = (runs: Loose[]) => fakes.controller.board.mockReturnValue({ runs });
  const entry = (overrides: Loose = {}): Loose => ({
    runId: 'run-1',
    label: 'ラベル',
    status: 'running',
    workspaceRoot: ROOT,
    inCurrentFolder: true,
    ...overrides,
  });

  it('runが無ければ案内して終わる', async () => {
    setup();
    await command('agent.taskRun.switch')();
    expect(__mock.messages.infos).toEqual([
      'オーケストレータモード: runがありません。「オーケストレータモードを開始」で始めてください',
    ]);
  });

  it('現在のフォルダ外のrunの前に区切りを入れ、$(はゼロ幅スペースで切る', async () => {
    __mock.setWorkspaceFolder(ROOT);
    board([
      entry({ label: '$(rocket) 速い' }),
      entry({ runId: 'run-2', inCurrentFolder: false, workspaceRoot: '/other' }),
      entry({ runId: 'run-3', inCurrentFolder: false, workspaceRoot: '/other2' }),
    ]);
    setup();
    const seen = answerQuickPicks(() => undefined);
    await command('agent.taskRun.switch')();
    expect(fakes.controller.board).toHaveBeenCalledWith(undefined, [ROOT]);
    expect(seen[0]?.map((i) => [i.label, i.runId, i.kind])).toEqual([
      ['$​(rocket) 速い', 'run-1', undefined],
      ['他のフォルダ', undefined, -1],
      ['ラベル', 'run-2', undefined],
      ['ラベル', 'run-3', undefined],
    ]);
    expect(seen[0]?.[0]).toMatchObject({ description: 'running', detail: ROOT });
  });

  it('選ばなかった・区切りを選んだときは何もしない', async () => {
    board([entry()]);
    setup();
    answerQuickPicks(() => undefined);
    await command('agent.taskRun.switch')();
    answerQuickPicks(() => ({ label: '他のフォルダ' }));
    await command('agent.taskRun.switch')();
    expect(fakes.view.show).not.toHaveBeenCalled();
    expect(fakes.controller.find).not.toHaveBeenCalled();
  });

  it('選んだrunが消えていたら警告する', async () => {
    board([entry()]);
    fakes.controller.find.mockReturnValue(undefined);
    setup();
    answerQuickPicks((items) => items[0]);
    await command('agent.taskRun.switch')();
    expect(__mock.messages.warnings).toEqual([
      'オーケストレータモード: 選んだrunが見つかりません。もう一度一覧を開いてください',
    ]);
  });

  it('動いているrunを選んだらKanbanとOrchestratorへ出す', async () => {
    board([entry()]);
    fakes.controller.find.mockReturnValue(runOf());
    setup();
    answerQuickPicks((items) => items[0]);
    await command('agent.taskRun.switch')();
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    expect(fakes.orchestrator.open).toHaveBeenCalledWith('run-1');
  });

  it('終わったrunを選んだらKanbanだけを開く', async () => {
    board([entry()]);
    fakes.controller.find.mockReturnValue(
      runOf({ finishedAt: '2026-10-01T01:00:00.000Z', suspendedAt: '2026-10-01T00:30:00.000Z' }),
    );
    setup();
    answerQuickPicks((items) => items[0]);
    await command('agent.taskRun.switch')();
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    expect(fakes.orchestrator.open).not.toHaveBeenCalled();
  });

  it('中断中のrunを選んだら再開を尋ね、承諾したら再開する', async () => {
    board([entry()]);
    fakes.controller.find.mockReturnValue(runOf({ suspendedAt: '2026-10-01T00:30:00.000Z' }));
    setup();
    answerQuickPicks((items) => items[0]);
    await command('agent.taskRun.switch')();
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    expect(__mock.messages.infos).toEqual([
      'オーケストレータモード: 「テストrun」は中断中です。再開しますか？',
    ]);
    expect(fakes.view.resumeRun).toHaveBeenCalledWith('run-1');
    expect(fakes.orchestrator.open).not.toHaveBeenCalled();
  });

  it('中断中のrunの再開を断ったら再開しない', async () => {
    board([entry()]);
    fakes.controller.find.mockReturnValue(runOf({ suspendedAt: '2026-10-01T00:30:00.000Z' }));
    __mock.showInformationMessageAnswer = undefined;
    setup();
    answerQuickPicks((items) => items[0]);
    await command('agent.taskRun.switch')();
    expect(fakes.view.show).toHaveBeenCalledWith('run-1');
    expect(fakes.view.resumeRun).not.toHaveBeenCalled();
  });
});

describe('コマンド: agent.taskRun.start', () => {
  const ok = { ok: true, runId: 'run-new', reused: false };
  const answerInput = (value: string | undefined): void => {
    __mock.showInputBoxAnswer = value;
  };

  /** 始め方・CLI・並列上限の順に答える（`pick`の項目は`value`、並列上限は文字列）。 */
  function answerFreeStart(opts: { engine?: string; parallel?: string | undefined } = {}) {
    return answerQuickPicks((items, index) => {
      if (index === 0) {
        return byValue('free')(items);
      }
      if (index === 1) {
        return byValue(opts.engine ?? 'codex')(items);
      }
      return 'parallel' in opts ? opts.parallel : '3';
    });
  }

  it('フォルダが開かれていなければエラーを出して終わる', async () => {
    setup();
    await command('agent.taskRun.start')();
    expect(__mock.messages.errors).toEqual([
      'オーケストレータモード: フォルダを開いてから実行してください',
    ]);
  });

  it('始め方を選ばなければ終わる', async () => {
    __mock.setWorkspaceFolder(ROOT);
    setup();
    const seen = answerQuickPicks(() => undefined);
    await command('agent.taskRun.start')();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((i) => i.value)).toEqual(['free', 'roadmap']);
    expect(fakes.controller.startRun).not.toHaveBeenCalled();
  });

  it('ロードマップから始めるなら、選んだフォルダとエンジンのヒントでロードマップ開始へ渡す', async () => {
    __mock.setWorkspaceFolder(ROOT);
    setup();
    answerQuickPicks(byValue('roadmap'));
    await command('agent.taskRun.start')('claude');
    expect(hoisted.startRoadmapRunCommand).toHaveBeenCalledTimes(1);
    const [deps, folder, issue] = hoisted.startRoadmapRunCommand.mock.calls[0] as [
      Loose,
      string,
      unknown,
    ];
    expect(folder).toBe(ROOT);
    expect(issue).toBeUndefined();
    // エンジンのヒントがCLIの並び順（claudeが先頭）に効く
    const seen = answerQuickPicks(() => undefined);
    await call(deps.askSettings, '既定名');
    expect(seen[0]?.map((i) => i.value)).toEqual(['claude', 'codex']);
    expect(fakes.controller.startRun).not.toHaveBeenCalled();
  });

  it('不正なエンジンのヒントは無視し、codexを先頭にする', async () => {
    __mock.setWorkspaceFolder(ROOT);
    setup();
    answerQuickPicks(byValue('roadmap'));
    await command('agent.taskRun.start')('gemini');
    const deps = hoisted.startRoadmapRunCommand.mock.calls[0]?.[0] as Loose;
    const seen = answerQuickPicks(() => undefined);
    await call(deps.askSettings, undefined);
    expect(seen[0]?.map((i) => i.value)).toEqual(['codex', 'claude']);
  });

  it('自由な指示で始める: 設定を尋ねてrunを始め、KanbanとOrchestratorを開く', async () => {
    __mock.setWorkspaceFolder(ROOT);
    fakes.controller.startRun.mockResolvedValue(ok);
    answerInput('名前');
    setup();
    answerFreeStart({ engine: 'claude', parallel: '4' });
    await command('agent.taskRun.start')();
    expect(fakes.controller.startRun).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      engine: 'claude',
      maxParallel: 4,
      title: '名前',
      parallel: false,
    });
    expect(fakes.view.show).toHaveBeenCalledWith('run-new');
    expect(fakes.orchestrator.open).toHaveBeenCalledWith('run-new');
  });

  it('名前の入力欄は既定名なし・文字数検証つきで出す', async () => {
    __mock.setWorkspaceFolder(ROOT);
    fakes.controller.startRun.mockResolvedValue(ok);
    const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('');
    setup();
    answerFreeStart();
    await command('agent.taskRun.start')();
    const options = showInputBox.mock.calls[0]?.[0] as Loose;
    expect('value' in options).toBe(false);
    expect(call(options.validateInput, 'a'.repeat(81))).toBe('80文字以内で入力してください');
    expect(call(options.validateInput, 'a')).toBeUndefined();
    showInputBox.mockRestore();
  });

  it('ロードマップ側の設定の尋ね方は既定名を入力欄へ入れる', async () => {
    __mock.setWorkspaceFolder(ROOT);
    const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('決めた名前');
    setup();
    answerQuickPicks(byValue('roadmap'));
    await command('agent.taskRun.start')();
    const deps = hoisted.startRoadmapRunCommand.mock.calls[0]?.[0] as Loose;
    answerQuickPicks((items, index) => (index === 0 ? byValue('codex')(items) : '2'));
    const settings = await call<Promise<unknown>>(deps.askSettings, '既定名');
    expect(settings).toEqual({ engine: 'codex', maxParallel: 2, title: '決めた名前' });
    expect((showInputBox.mock.calls[0]?.[0] as Loose).value).toBe('既定名');
    showInputBox.mockRestore();
  });

  it('並列上限の候補は1からMAX_TASK_RUN_PARALLELまで', async () => {
    __mock.setWorkspaceFolder(ROOT);
    setup();
    const seen = answerFreeStart({ parallel: undefined });
    await command('agent.taskRun.start')();
    expect(seen[2]).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(fakes.controller.startRun).not.toHaveBeenCalled();
  });

  it('CLIを選ばなければ終わる', async () => {
    __mock.setWorkspaceFolder(ROOT);
    setup();
    answerQuickPicks((items, index) => (index === 0 ? byValue('free')(items) : undefined));
    await command('agent.taskRun.start')();
    expect(fakes.controller.startRun).not.toHaveBeenCalled();
  });

  it('名前の入力を取り消したら終わる', async () => {
    __mock.setWorkspaceFolder(ROOT);
    answerInput(undefined);
    setup();
    answerFreeStart();
    await command('agent.taskRun.start')();
    expect(fakes.controller.startRun).not.toHaveBeenCalled();
  });

  it('開始に失敗したらログとエラー通知を出し、何も開かない', async () => {
    __mock.setWorkspaceFolder(ROOT);
    fakes.controller.startRun.mockResolvedValue({ ok: false, message: '上限です' });
    answerInput('');
    setup();
    answerFreeStart();
    await command('agent.taskRun.start')();
    expect(log.warnings).toEqual(['[task run] 上限です']);
    expect(__mock.messages.errors).toEqual(['オーケストレータモード: 上限です']);
    expect(fakes.view.show).not.toHaveBeenCalled();
  });

  it('既存のrunが再利用されたら選んだ設定を使わないと知らせる', async () => {
    __mock.setWorkspaceFolder(ROOT);
    fakes.controller.startRun.mockResolvedValue({ ok: true, runId: 'run-old', reused: true });
    answerInput('');
    setup();
    answerFreeStart();
    await command('agent.taskRun.start')();
    expect(__mock.messages.infos).toEqual([
      'このフォルダには動いているrunがあるため、それを開きます（選んだCLI・並列上限・名前は使いません）',
    ]);
    expect(fakes.view.show).toHaveBeenCalledWith('run-old');
  });

  describe('同じフォルダに動いているrunがある', () => {
    const active = (id: string) => runOf({ runId: id, title: `run ${id}` });

    /** 始め方=free → 動いているrunへの対応 → 以降（CLI・並列上限）の順に答える。 */
    function answerWithAction(action: string | undefined, rest: unknown = undefined) {
      return answerQuickPicks((items, index) => {
        if (index === 0) {
          return byValue('free')(items);
        }
        if (index === 1) {
          return action === undefined ? undefined : byValue(action)(items);
        }
        return rest;
      });
    }

    it('1本なら入れ替えを含む4択を出す。選ばなければ終わる', async () => {
      __mock.setWorkspaceFolder(ROOT);
      fakes.controller.listActive.mockReturnValue([active('run-a')]);
      setup();
      const seen = answerWithAction(undefined);
      await command('agent.taskRun.start')();
      expect(fakes.controller.listActive).toHaveBeenCalledWith(ROOT);
      expect(seen[1]?.map((i) => i.value)).toEqual(['parallel', 'open', 'suspend', 'finish']);
      expect(seen[1]?.[1]?.label).toBe('既存のrunを開く');
      expect(fakes.controller.startRun).not.toHaveBeenCalled();
    });

    it('複数なら本数を見出しに、入れ替えを出さない', async () => {
      __mock.setWorkspaceFolder(ROOT);
      fakes.controller.listActive.mockReturnValue([active('run-a'), active('run-b')]);
      const showQuickPick = vi.spyOn(vscode.window, 'showQuickPick');
      setup();
      const seen = answerWithAction(undefined);
      await command('agent.taskRun.start')();
      expect(seen[1]?.map((i) => i.value)).toEqual(['parallel', 'open']);
      expect(seen[1]?.[1]?.label).toBe('既存のrunを選んで開く');
      expect((showQuickPick.mock.calls[1]?.[1] as Loose).title).toBe(
        'このフォルダには動いているrunが2本あります',
      );
      showQuickPick.mockRestore();
    });

    it('1本の「開く」はそのrunを開いて終わる', async () => {
      __mock.setWorkspaceFolder(ROOT);
      fakes.controller.listActive.mockReturnValue([active('run-a')]);
      setup();
      answerWithAction('open');
      await command('agent.taskRun.start')();
      expect(fakes.view.show).toHaveBeenCalledWith('run-a');
      expect(fakes.orchestrator.open).toHaveBeenCalledWith('run-a');
      expect(fakes.controller.startRun).not.toHaveBeenCalled();
    });

    it('複数の「開く」は選んだrunを開く（codiconは切る）。選ばなければ開かない', async () => {
      __mock.setWorkspaceFolder(ROOT);
      fakes.controller.listActive.mockReturnValue([
        runOf({ runId: 'run-a', title: '$(x) a' }),
        active('run-b'),
      ]);
      setup();
      const seen = answerQuickPicks((items, index) => {
        if (index === 0) {
          return byValue('free')(items);
        }
        if (index === 1) {
          return byValue('open')(items);
        }
        return byValue('run-b')(items);
      });
      await command('agent.taskRun.start')();
      expect(seen[2]?.map((i) => [i.value, i.label])).toEqual([
        ['run-a', '$​(x) a'],
        ['run-b', 'run run-b'],
      ]);
      expect(fakes.view.show).toHaveBeenCalledWith('run-b');

      fakes.view.show.mockClear();
      answerQuickPicks((items, index) => {
        if (index === 0) {
          return byValue('free')(items);
        }
        return index === 1 ? byValue('open')(items) : undefined;
      });
      await command('agent.taskRun.start')();
      expect(fakes.view.show).not.toHaveBeenCalled();
    });

    it('「並行して始める」ならparallel:trueで始める', async () => {
      __mock.setWorkspaceFolder(ROOT);
      fakes.controller.listActive.mockReturnValue([active('run-a'), active('run-b')]);
      fakes.controller.startRun.mockResolvedValue(ok);
      answerInput('');
      setup();
      answerQuickPicks((items, index) => {
        if (index === 0) {
          return byValue('free')(items);
        }
        if (index === 1) {
          return byValue('parallel')(items);
        }
        return index === 2 ? byValue('codex')(items) : '1';
      });
      await command('agent.taskRun.start')();
      expect(fakes.controller.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ parallel: true, maxParallel: 1 }),
      );
    });

    it.each(['suspend', 'finish'] as const)(
      '「%s」して始める: 閉じてから新しいrunを始める',
      async (action) => {
        __mock.setWorkspaceFolder(ROOT);
        fakes.controller.listActive.mockReturnValue([active('run-a')]);
        fakes.controller[action === 'suspend' ? 'suspendRun' : 'finishRun'].mockResolvedValue({
          ok: true,
          message: '',
        });
        fakes.controller.startRun.mockResolvedValue(ok);
        answerInput('');
        setup();
        answerQuickPicks((items, index) => {
          if (index === 0) {
            return byValue('free')(items);
          }
          if (index === 1) {
            return byValue(action)(items);
          }
          return index === 2 ? byValue('codex')(items) : '2';
        });
        await command('agent.taskRun.start')();
        expect(
          fakes.controller[action === 'suspend' ? 'suspendRun' : 'finishRun'],
        ).toHaveBeenCalledWith('run-a');
        expect(fakes.orchestrator.close).toHaveBeenCalledWith('run-a');
        expect(fakes.controller.startRun).toHaveBeenCalledWith(
          expect.objectContaining({ parallel: false }),
        );
      },
    );

    it('閉じるのに失敗したらエラーを出して新しいrunを始めない', async () => {
      __mock.setWorkspaceFolder(ROOT);
      fakes.controller.listActive.mockReturnValue([active('run-a')]);
      fakes.controller.finishRun.mockResolvedValue({ ok: false, message: '終えられない' });
      setup();
      answerWithAction('finish');
      await command('agent.taskRun.start')();
      expect(log.warnings).toEqual(['[task run] 終えられない']);
      expect(__mock.messages.errors).toEqual(['オーケストレータモード: 終えられない']);
      expect(fakes.controller.startRun).not.toHaveBeenCalled();
      expect(fakes.orchestrator.close).not.toHaveBeenCalled();
    });
  });
});

describe('Orchestratorの確認ダイアログ', () => {
  const confirm = (key: string): ((input: Loose) => Promise<boolean>) =>
    opt('orchestrator', key) as (input: Loose) => Promise<boolean>;
  const modalCalls = (spy: ReturnType<typeof vi.spyOn>): unknown[][] =>
    spy.mock.calls as unknown[][];

  it('回答: 回答する、を押したときだけtrue。回答の本文は切り詰めずに見せる', async () => {
    setup();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const answer = 'x'.repeat(2000);
    const input = { taskId: 'T1', title: '題\n名', question: '問\nい', answer };
    expect(await confirm('confirmAnswer')(input)).toBe(true);
    const [message, options, button] = modalCalls(warn)[0] as [string, Loose, string];
    expect(message).toContain('「回答する」を押してください');
    expect(button).toBe('回答する');
    expect(options.modal).toBe(true);
    const detail = String(options.detail);
    expect(detail.startsWith('T1 題 名\n\n質問: 問 い\n\n回答: ')).toBe(true);
    expect(detail.endsWith(answer)).toBe(true);
    __mock.showWarningMessageAnswer = undefined;
    expect(await confirm('confirmAnswer')(input)).toBe(false);
    warn.mockRestore();
  });

  it('関門: 決着させる、を押したときだけtrue。Reflexの有無を表示する', async () => {
    setup();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const base = { taskId: 'T2', title: '題', detail: '関門\nの中身', choiceLabel: '承認' };
    expect(await confirm('confirmGateResolution')({ ...base, reflexSummary: undefined })).toBe(
      true,
    );
    const [, first, button] = modalCalls(warn)[0] as [string, Loose, string];
    expect(button).toBe('決着させる');
    expect(String(first.detail)).toBe(
      'T2 題\n\n関門: 関門 の中身\n\n判断: 承認\n\nReflex: 審査していません（無効、または人だけが選べる判断）',
    );
    await confirm('confirmGateResolution')({ ...base, reflexSummary: '妥当\nです' });
    const [, second] = modalCalls(warn)[1] as [string, Loose];
    expect(String(second.detail)).toContain('Reflex: 妥当 です');
    __mock.showWarningMessageAnswer = undefined;
    expect(await confirm('confirmGateResolution')({ ...base, reflexSummary: undefined })).toBe(
      false,
    );
    warn.mockRestore();
  });

  it('計画: 承認する、を押したときだけtrue。Reflexの有無を表示する', async () => {
    setup();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const base = { runLabel: 'run\n名', taskCount: 3 };
    expect(await confirm('confirmPlanApproval')({ ...base, reflexSummary: undefined })).toBe(true);
    const [, first, button] = modalCalls(warn)[0] as [string, Loose, string];
    expect(button).toBe('承認する');
    expect(String(first.detail)).toBe(
      'run 名（タスク3件）\n\nReflex: 無効のため審査していません\n\n計画の中身はKanbanで確かめてください',
    );
    await confirm('confirmPlanApproval')({ ...base, reflexSummary: '低い' });
    expect(String(((modalCalls(warn)[1] as unknown[])[1] as Loose).detail)).toContain(
      'Reflex: 低い',
    );
    __mock.showWarningMessageAnswer = undefined;
    expect(await confirm('confirmPlanApproval')({ ...base, reflexSummary: undefined })).toBe(false);
    warn.mockRestore();
  });
});
