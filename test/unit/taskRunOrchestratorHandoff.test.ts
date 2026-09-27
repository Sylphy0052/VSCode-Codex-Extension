import { describe, expect, it, vi } from 'vitest';
import type { ChatState } from '../../src/appserver/chatState';
import { MAX_ORCHESTRATOR_EVENTS_PER_RUN } from '../../src/orchestrator/orchestratorSession';
import type { ExtensionSafetyBaseline } from '../../src/orchestrator/taskConfig';
import {
  TaskRunOrchestrator,
  type TaskRunOrchestratorDeps,
  type TaskRunOrchestratorEvent,
} from '../../src/orchestrator/taskRunOrchestrator';
import { TASK_RUN_SCHEMA_VERSION, type TaskRun } from '../../src/orchestrator/taskRunState';
import type { TaskSession, TaskSessionHost, TaskSessionInput } from '../../src/orchestrator/taskSession';

/**
 * Issue #1580 のtaskRunOrchestrator向け単体テスト。次の2点を確かめる:
 * - 世代をまたいだイベント総数の上限（run全体でMAX_ORCHESTRATOR_EVENTS_PER_RUNを超えない）
 * - 自動引き継ぎに失敗したときrearmAutoHandoffを呼び、前の世代を使い続けられること
 * （taskRunOrchestratorにはhandoffPrecheckが渡されていない）
 */

const LOOSE_BASELINE: ExtensionSafetyBaseline = {
  codexSandbox: 'danger-full-access',
  codexApprovalMode: 'never',
  claudePermissionMode: 'bypassPermissions',
  allowAutoApprove: true,
  allowClaudeBypassPermissions: true,
};

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    runId: 'run-1',
    workspaceRoot: '/tmp/ws',
    engine: 'codex',
    maxParallel: 1,
    startedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    finishedAt: undefined,
    planStatus: 'approved',
    taskOrder: [],
    tasks: {},
    nextTaskNumber: 1,
    haltedByUser: false,
    orchestratorGeneration: 0,
    orchestratorSessionRefs: [],
    ...overrides,
  };
}

/** テスト用の`TaskSession`。送った本文と状態変化リスナーを外から見られるようにする。 */
interface FakeSession {
  session: TaskSession;
  sentTexts: string[];
  emitState(state: Partial<ChatState>): void;
}

function makeFakeSession(id: string): FakeSession {
  const sentTexts: string[] = [];
  let listener: ((state: ChatState) => void) | undefined;
  const session: TaskSession = {
    sessionId: id,
    runLoop: vi.fn(),
    send: (text: string) => {
      sentTexts.push(text);
    },
    setPromptTransform: vi.fn(),
    onFinished: vi.fn(),
    onStateChanged: (l) => {
      listener = l;
    },
    setApprovalHandler: vi.fn(),
    setMcpElicitationHandler: vi.fn(),
    onApprovalResolved: vi.fn(),
    interrupt: vi.fn(async () => {}),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    checkMessagingToolVisible: vi.fn(async () => true),
    stopLoop: vi.fn(() => true),
    decideApproval: vi.fn(),
    compact: vi.fn(async () => {}),
    note: vi.fn(),
    reveal: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    rearmAutoHandoff: vi.fn(),
  };
  return {
    session,
    sentTexts,
    emitState(state) {
      listener?.({ busy: false, threadId: undefined, name: undefined, turnId: undefined, ...state } as ChatState);
    },
  };
}

/** テスト用の`TaskRunOrchestratorDeps`。runの状態は`runBox`越しに書き換えられる。 */
function makeDeps(host: TaskSessionHost, runBox: { current: TaskRun }): TaskRunOrchestratorDeps {
  let tokenSeq = 0;
  return {
    hosts: { codex: host, claude: host },
    controller: {
      find: (runId: string) => (runId === runBox.current.runId ? runBox.current : undefined),
      updateRun: vi.fn(async (_runId: string, updater: (run: TaskRun) => TaskRun) => {
        runBox.current = updater(runBox.current);
        return runBox.current;
      }),
      recommend: vi.fn(),
      recommendations: vi.fn(() => new Map()),
      proposePlan: vi.fn(),
      approvePlan: vi.fn(),
      refreshKanban: vi.fn(),
      startStage: vi.fn(),
      stopStage: vi.fn(),
      instructTask: vi.fn(),
      setMaxParallel: vi.fn(),
      findQuestionAwaitingUser: vi.fn(),
      answerQuestion: vi.fn(),
      findOpenGateForUser: vi.fn(),
      resolveGate: vi.fn(),
      listInFolder: vi.fn(() => []),
      reopenRun: vi.fn(),
      startRun: vi.fn(),
      syncRoadmap: vi.fn(),
    },
    server: {
      registerTools: vi.fn(async () => {
        tokenSeq += 1;
        return { url: `http://fake/${String(tokenSeq)}`, token: `token-${String(tokenSeq)}` };
      }),
      unregister: vi.fn(),
    },
    readBaseline: () => LOOSE_BASELINE,
    confirmAnswer: vi.fn(async () => true),
    confirmGateResolution: vi.fn(async () => true),
    showKanban: vi.fn(),
    onDidChange: vi.fn(),
    log: vi.fn(),
  };
}

function taskFailed(body: string): TaskRunOrchestratorEvent {
  return { kind: 'taskFailed', body };
}

describe('TaskRunOrchestratorの引き継ぎ（Issue #1580）', () => {
  it('世代をまたいでもイベント総数の上限はrun全体で効き、上限到達は1回だけ知らせる', async () => {
    const runBox = { current: makeRun() };
    const s1 = makeFakeSession('s1');
    const s2 = makeFakeSession('s2');
    const openTaskSession = vi.fn().mockResolvedValueOnce(s1.session).mockResolvedValueOnce(s2.session);
    const deps = makeDeps({ openTaskSession }, runBox);
    const orch = new TaskRunOrchestrator(deps);

    await orch.open('run-1');
    // 第1世代で498件送る（上限500まで残り2件）
    const gen1Events = Array.from({ length: 498 }, (_, i) => taskFailed(`E${String(i + 1)}`));
    for (const e of gen1Events) {
      (orch as unknown as { notify(runId: string, event: TaskRunOrchestratorEvent): void }).notify('run-1', e);
    }

    const input1 = openTaskSession.mock.calls[0]?.[0] as TaskSessionInput;
    await input1.handoffDelegate?.({ model: '', effort: '', prompt: '', trigger: 'auto' });
    await vi.waitFor(() => expect(openTaskSession).toHaveBeenCalledTimes(2));

    // 第2世代で4件届ける。合計500件目までは通り、501件目以降は上限で捨てられる
    for (const e of [taskFailed('E499'), taskFailed('E500'), taskFailed('E501'), taskFailed('E502')]) {
      (orch as unknown as { notify(runId: string, event: TaskRunOrchestratorEvent): void }).notify('run-1', e);
    }
    s2.emitState({ busy: false });

    const sent = s2.sentTexts.join('\n');
    expect(sent).toContain('E500');
    expect(sent).not.toContain('E501');
    expect(sent).not.toContain('E502');
    expect((sent.match(/イベント通知が上限/g) ?? []).length).toBe(1);
    expect(sent).toContain(`（${String(MAX_ORCHESTRATOR_EVENTS_PER_RUN)}件/run）`);
  });

  it('自動引き継ぎで次の世代を開けなかったら、前の世代でrearmAutoHandoffを呼び使い続ける', async () => {
    const runBox = { current: makeRun() };
    const s1 = makeFakeSession('s1');
    const openTaskSession = vi.fn().mockResolvedValueOnce(s1.session).mockRejectedValueOnce(new Error('開けない'));
    const deps = makeDeps({ openTaskSession }, runBox);
    const orch = new TaskRunOrchestrator(deps);

    await orch.open('run-1');
    s1.emitState({ busy: false });
    expect(orch.status('run-1')).toBe('idle');

    const input1 = openTaskSession.mock.calls[0]?.[0] as TaskSessionInput;
    const accepted = await input1.handoffDelegate?.({ model: '', effort: '', prompt: '', trigger: 'auto' });
    expect(accepted).toBe(true);
    expect(orch.status('run-1')).toBe('handingOff');

    await vi.waitFor(() => expect(s1.session.rearmAutoHandoff).toHaveBeenCalledTimes(1));
    expect(orch.status('run-1')).toBe('idle');
    expect(openTaskSession).toHaveBeenCalledTimes(2);
  });
});
