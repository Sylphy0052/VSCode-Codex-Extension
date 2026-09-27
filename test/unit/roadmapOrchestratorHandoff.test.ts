import { describe, expect, it, vi } from 'vitest';
import type { ChatState } from '../../src/appserver/chatState';
import { MAX_ORCHESTRATOR_EVENTS_PER_RUN } from '../../src/orchestrator/orchestratorSession';
import {
  RoadmapOrchestrator,
  type RoadmapOrchestratorDeps,
  type RoadmapOrchestratorEvent,
} from '../../src/orchestrator/roadmapOrchestrator';
import { ROADMAP_RUN_SCHEMA_VERSION, type RoadmapRun } from '../../src/orchestrator/roadmapRunState';
import type { ExtensionSafetyBaseline } from '../../src/orchestrator/taskConfig';
import type { TaskSession, TaskSessionHost, TaskSessionInput } from '../../src/orchestrator/taskSession';
import type { RoadmapKanbanBoard } from '../../src/view/roadmapKanbanModel';

/**
 * Issue #1580 のroadmapOrchestrator向け単体テスト。
 * - 世代をまたいだイベント総数の上限（run全体でMAX_ORCHESTRATOR_EVENTS_PER_RUNを超えない）
 * - 自動引き継ぎに失敗したときrearmAutoHandoffを呼び、前の世代を使い続けられること
 * - handoffPrecheck（runが終わっていれば自動引き継ぎを見送る）
 * - 引き継ぎ中（handingOff）に届いたイベントは前の世代へ送らず、次の世代へ持ち越すこと
 */

const LOOSE_BASELINE: ExtensionSafetyBaseline = {
  codexSandbox: 'danger-full-access',
  codexApprovalMode: 'never',
  claudePermissionMode: 'bypassPermissions',
  allowAutoApprove: true,
  allowClaudeBypassPermissions: true,
};

function makeRun(overrides: Partial<RoadmapRun> = {}): RoadmapRun {
  return {
    schemaVersion: ROADMAP_RUN_SCHEMA_VERSION,
    runId: 'run-1',
    roadmapIssueNumber: 1,
    workspaceRoot: '/tmp/ws',
    engine: 'codex',
    mode: 'auto',
    maxParallel: 1,
    startedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    finishedAt: undefined,
    plan: { nodes: [], source: 'generated' },
    issues: {},
    haltedByUser: false,
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

/** テスト用の`RoadmapOrchestratorDeps`。runの状態は`runBox`越しに書き換えられる。 */
function makeDeps(host: TaskSessionHost, runBox: { current: RoadmapRun }): RoadmapOrchestratorDeps {
  let tokenSeq = 0;
  return {
    hosts: { codex: host, claude: host },
    controller: {
      updateRun: vi.fn(async (_runId: string, updater: (run: RoadmapRun) => RoadmapRun) => {
        runBox.current = updater(runBox.current);
        return runBox.current;
      }),
      board: vi.fn((): RoadmapKanbanBoard => ({ runs: [], run: undefined, events: [] })),
      startIssue: vi.fn(),
      pauseIssue: vi.fn(),
      stopIssue: vi.fn(),
      instructIssue: vi.fn(),
      answerQuestion: vi.fn(),
      setMode: vi.fn(),
      setHalted: vi.fn(),
      recordOrchestratorCommand: vi.fn(),
      runEvents: vi.fn(),
    },
    findRun: (runId: string) => (runId === runBox.current.runId ? runBox.current : undefined),
    server: {
      registerTools: vi.fn(async () => {
        tokenSeq += 1;
        return { url: `http://fake/${String(tokenSeq)}`, token: `token-${String(tokenSeq)}` };
      }),
      unregister: vi.fn(),
    },
    readBaseline: () => LOOSE_BASELINE,
    confirmAnswer: vi.fn(async () => true),
    onDidChange: vi.fn(),
    log: vi.fn(),
  };
}

function issueDone(body: string): RoadmapOrchestratorEvent {
  return { kind: 'issueDone', body };
}

describe('RoadmapOrchestratorの引き継ぎ（Issue #1580）', () => {
  it('世代をまたいでもイベント総数の上限はrun全体で効き、上限到達は1回だけ知らせる', async () => {
    const runBox = { current: makeRun() };
    const s1 = makeFakeSession('s1');
    const s2 = makeFakeSession('s2');
    const openTaskSession = vi.fn().mockResolvedValueOnce(s1.session).mockResolvedValueOnce(s2.session);
    const deps = makeDeps({ openTaskSession }, runBox);
    const orch = new RoadmapOrchestrator(deps);

    await orch.open('run-1');
    // 第1世代で498件送る（上限500まで残り2件）
    const gen1Events = Array.from({ length: 498 }, (_, i) => issueDone(`E${String(i + 1)}`));
    orch.handleRunEvents('run-1', gen1Events);

    const input1 = openTaskSession.mock.calls[0]?.[0] as TaskSessionInput;
    await input1.handoffDelegate?.({ model: '', effort: '', prompt: '', trigger: 'auto' });
    await vi.waitFor(() => expect(openTaskSession).toHaveBeenCalledTimes(2));

    // 第2世代で4件届ける。合計500件目までは通り、501件目以降は上限で捨てられる
    orch.handleRunEvents('run-1', [issueDone('E499'), issueDone('E500'), issueDone('E501'), issueDone('E502')]);
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
    const orch = new RoadmapOrchestrator(deps);

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

  it('handoffPrecheckはrunが終わっていなければautoでtrue、終わっていればfalse。manualは常にtrue', async () => {
    const runBox = { current: makeRun() };
    const s1 = makeFakeSession('s1');
    const openTaskSession = vi.fn().mockResolvedValueOnce(s1.session);
    const deps = makeDeps({ openTaskSession }, runBox);
    const orch = new RoadmapOrchestrator(deps);

    await orch.open('run-1');
    const input1 = openTaskSession.mock.calls[0]?.[0] as TaskSessionInput;
    expect(input1.handoffPrecheck).toBeDefined();

    expect(input1.handoffPrecheck?.('auto')).toBe(true);
    runBox.current = { ...runBox.current, finishedAt: new Date('2026-01-02T00:00:00Z').toISOString() };
    expect(input1.handoffPrecheck?.('auto')).toBe(false);
    expect(input1.handoffPrecheck?.('manual')).toBe(true);
  });

  it('引き継ぎ中に届いたイベントは前の世代へ送らず、次の世代の送信で持ち越す', async () => {
    const runBox = { current: makeRun() };
    const s1 = makeFakeSession('s1');
    const s2 = makeFakeSession('s2');
    const openTaskSession = vi.fn().mockResolvedValueOnce(s1.session).mockResolvedValueOnce(s2.session);
    const deps = makeDeps({ openTaskSession }, runBox);
    const orch = new RoadmapOrchestrator(deps);

    await orch.open('run-1');
    s1.emitState({ busy: false });

    const input1 = openTaskSession.mock.calls[0]?.[0] as TaskSessionInput;
    await input1.handoffDelegate?.({ model: '', effort: '', prompt: '', trigger: 'auto' });
    expect(orch.status('run-1')).toBe('handingOff');

    orch.handleRunEvents('run-1', [issueDone('CARRIED-EVENT')]);
    expect(s1.sentTexts.some((t) => t.includes('CARRIED-EVENT'))).toBe(false);

    await vi.waitFor(() => expect(openTaskSession).toHaveBeenCalledTimes(2));
    s2.emitState({ busy: false });

    const sent2 = s2.sentTexts.join('\n');
    expect(sent2).toContain('CARRIED-EVENT');
  });
});
