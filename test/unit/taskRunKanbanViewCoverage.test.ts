import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { MAX_USER_ANSWER_LENGTH } from '../../src/orchestrator/roadmapQuestionMcp';
import { TASK_LEASE_HEARTBEAT_MS } from '../../src/orchestrator/taskRunLease';
import type { TaskRun } from '../../src/orchestrator/taskRunState';
import {
  currentWorkspaceFolders,
  TaskRunKanbanViewManager,
  type TaskRunKanbanViewDeps,
} from '../../src/view/taskRunKanbanView';
import {
  TASK_RUN_KANBAN_COLUMNS,
  type TaskRunKanbanBoard,
  type TaskRunKanbanCard,
  type TaskRunKanbanColumn,
  type TaskRunKanbanRun,
  type TaskRunKanbanRunSummary,
} from '../../src/view/taskRunKanbanModel';
import { __mock, type FakeWebviewPanel } from '../mocks/vscode';

/**
 * オーケストレータモードのKanban（`TaskRunKanbanViewManager`）の配線（Issue #1854）。
 *
 * パネルの生成と復元、盤面の送信（まとめ送信・非表示中の保留・古い送信の破棄）、webviewからの
 * メッセージの検証と`TaskRunController`・Orchestratorへの受け渡し、確認ダイアログの分岐を、
 * webviewの`onDidReceiveMessage`経由で確かめる。`closeTask`は`taskRunKanbanViewCloseTask.test.ts`が持つ。
 */

const warnLog = vi.fn();
const fakeLogger: Logger = {
  info: () => undefined,
  warn: (message: string) => warnLog(message),
  error: () => undefined,
  show: () => undefined,
};

type Result = { ok: boolean; message: string };
const OK: Result = { ok: true, message: 'できた' };
const NG: Result = { ok: false, message: '失敗した' };

function card(taskId: string, overrides: Partial<TaskRunKanbanCard> = {}): TaskRunKanbanCard {
  return {
    taskId,
    title: `${taskId}のタイトル`,
    summary: '',
    column: 'implement',
    badges: [],
    dependsOn: [],
    issueNumber: undefined,
    pullRequest: undefined,
    failure: undefined,
    pauseReason: undefined,
    attempts: 1,
    canStop: true,
    canRetry: false,
    canReveal: true,
    canInstruct: false,
    questions: [],
    gate: undefined,
    lastGateDecision: undefined,
    closedReason: undefined,
    reviewRounds: undefined,
    ...overrides,
  };
}

function columnsOf(
  cards: Partial<Record<TaskRunKanbanColumn, TaskRunKanbanCard[]>> = {},
): Record<TaskRunKanbanColumn, TaskRunKanbanCard[]> {
  const columns = {} as Record<TaskRunKanbanColumn, TaskRunKanbanCard[]>;
  for (const column of TASK_RUN_KANBAN_COLUMNS) {
    columns[column] = cards[column] ?? [];
  }
  return columns;
}

function kanbanRun(runId: string, cards: TaskRunKanbanCard[] = []): TaskRunKanbanRun {
  return {
    runId,
    title: undefined,
    label: runId,
    workspaceRoot: '/work',
    engine: 'codex',
    maxParallel: 2,
    planStatus: 'approved',
    planReview: undefined,
    haltedByUser: false,
    finished: false,
    suspended: false,
    assessment: {} as TaskRunKanbanRun['assessment'],
    activeSessions: 0,
    orchestratorGeneration: 1,
    orchestratorAutoHandoffs: undefined,
    columns: columnsOf({ implement: cards }),
    roadmap: undefined,
  };
}

function summary(runId: string, finished = false): TaskRunKanbanRunSummary {
  return {
    runId,
    workspaceRoot: '/work',
    engine: 'codex',
    startedAt: '2026-01-01T00:00:00.000Z',
    finished,
    suspended: false,
    label: runId,
    status: '実行中',
    inCurrentFolder: true,
  };
}

function storedRun(runId: string, overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId,
    workspaceRoot: '/work',
    title: undefined,
    startedAt: '2026-01-01T00:00:00.000Z',
    engine: 'codex',
    ...overrides,
  } as unknown as TaskRun;
}

interface Harness {
  view: TaskRunKanbanViewManager;
  panel: FakeWebviewPanel;
  controller: Record<string, ReturnType<typeof vi.fn>>;
  orchestrator: Record<string, ReturnType<typeof vi.fn>>;
  deps: {
    revealStage: ReturnType<typeof vi.fn>;
    finishRun: ReturnType<typeof vi.fn>;
    suspendRun: ReturnType<typeof vi.fn>;
    resumeRun: ReturnType<typeof vi.fn>;
  };
}

interface OpenOptions {
  board?: TaskRunKanbanBoard;
  runs?: Record<string, TaskRun>;
  active?: TaskRun[];
  leaseHeld?: Record<string, boolean>;
  show?: boolean;
}

function open(options: OpenOptions = {}): Harness {
  const board = options.board ?? { runs: [], run: undefined };
  const runs = options.runs ?? {};
  const controller: Record<string, ReturnType<typeof vi.fn>> = {
    board: vi.fn(() => board),
    find: vi.fn((runId: string) => runs[runId]),
    listActive: vi.fn(() => options.active ?? []),
    leaseStatus: vi.fn((runId: string) =>
      Promise.resolve({ heldByOther: options.leaseHeld?.[runId] === true }),
    ),
    approvePlan: vi.fn(() => Promise.resolve(OK)),
    syncRoadmap: vi.fn(() => Promise.resolve(OK)),
    setMaxParallel: vi.fn(() => Promise.resolve(OK)),
    setHalted: vi.fn(() => Promise.resolve(OK)),
    transferLease: vi.fn(() => Promise.resolve(OK)),
    retryStage: vi.fn(() => Promise.resolve(OK)),
    stopStage: vi.fn(() => Promise.resolve(OK)),
    closeTask: vi.fn(() => Promise.resolve(OK)),
    answerQuestion: vi.fn(() => Promise.resolve(OK)),
    instructTask: vi.fn(() => Promise.resolve(OK)),
    resolveGate: vi.fn(() => Promise.resolve(OK)),
    setTitle: vi.fn(() => Promise.resolve(true)),
  };
  const orchestrator: Record<string, ReturnType<typeof vi.fn>> = {
    open: vi.fn(() => Promise.resolve(true)),
    status: vi.fn(() => 'idle'),
    notifyTaskInstructed: vi.fn(),
  };
  const deps = {
    revealStage: vi.fn(() => true),
    finishRun: vi.fn(() => Promise.resolve(OK)),
    suspendRun: vi.fn(() => Promise.resolve(OK)),
    resumeRun: vi.fn(() => Promise.resolve(OK)),
  };
  const view = new TaskRunKanbanViewManager({
    controller,
    orchestrator,
    ...deps,
    log: fakeLogger,
  } as unknown as TaskRunKanbanViewDeps);
  view.show();
  const panel = __mock.lastCreatedPanel();
  if (panel === undefined) {
    throw new Error('パネルが作られていない');
  }
  if (options.show === false) {
    // パネルを閉じた状態（復元や開き直しの前）から始める
    panel.dispose();
  }
  return { view, panel, controller, orchestrator, deps };
}

function send(h: Harness, message: unknown): void {
  h.panel.webview.simulateMessage(message);
}

function sentBoards(h: Harness): Array<Record<string, unknown>> {
  return h.panel.webview.sent.filter(
    (m): m is Record<string, unknown> =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'board',
  );
}

/** 解決のタイミングをテストが握る専有権の読み取り */
function deferredLease(): {
  promise: Promise<{ heldByOther: boolean }>;
  resolve: (value: { heldByOther: boolean }) => void;
} {
  let resolve: (value: { heldByOther: boolean }) => void = () => undefined;
  const promise = new Promise<{ heldByOther: boolean }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 非同期の後続処理（awaitの連鎖）が走り切るのを待つ */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TaskRunKanbanViewManager', () => {
  let h: Harness | undefined;

  beforeEach(() => {
    __mock.reset();
    warnLog.mockReset();
  });

  afterEach(() => {
    h?.view.dispose();
    h = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('パネルの生成と復元', () => {
    it('show()はKanbanのパネルを作り、CSP付きのHTMLを入れる', () => {
      h = open();
      expect(__mock.createdPanels).toHaveLength(1);
      expect(h.panel.viewType).toBe(TaskRunKanbanViewManager.viewType);
      expect(h.panel.title).toBe('オーケストレータモード');
      const html = h.panel.webview.html;
      expect(html).toContain('Content-Security-Policy');
      expect(html).toContain('id="controls"');
      expect(html).toContain('id="board"');
      expect(html).toContain('id="graph-view"');
      const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
      // randomBytes(16)のbase64は24文字。空のnonceでCSPを素通りさせていないことも兼ねる
      expect(nonce).toMatch(/^[A-Za-z0-9+/=]{24}$/);
      // CSPのnonceとscriptのnonceが同じ値
      expect(html).toContain(`'nonce-${nonce ?? ''}'`);
    });

    it('パネルを開いたままshow()し直すと前面へ出し、新しいパネルは作らない', async () => {
      h = open();
      expect(h.panel.revealCount).toBe(0);
      h.view.show();
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
      expect(h.panel.revealCount).toBe(1);
      expect(__mock.createdPanels).toHaveLength(1);
    });

    it('show(runId)で渡したrunが盤面の選択になる', async () => {
      h = open({ show: false });
      h.view.show('run-7');
      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({ type: 'ready' });
      await vi.waitFor(() => expect(h?.controller.board).toHaveBeenCalled());
      expect(h.controller.board?.mock.calls[0]?.[0]).toBe('run-7');
    });

    it('パネルを閉じるとrefreshしても盤面を送らず、開き直せる', async () => {
      h = open();
      h.panel.dispose();
      h.view.refresh();
      await settle();
      expect(sentBoards(h)).toHaveLength(0);
      h.view.show();
      expect(__mock.createdPanels).toHaveLength(2);
    });

    it('restorePanel: 復元したパネルへ配線し、webviewの状態からrunを戻す', async () => {
      h = open({ show: false });
      const restored = vscode.window.createWebviewPanel(
        TaskRunKanbanViewManager.viewType,
        '復元',
        vscode.ViewColumn.One,
        {},
      ) as unknown as FakeWebviewPanel;
      h.view.restorePanel(restored as unknown as vscode.WebviewPanel, { runId: 'run-restored' });
      expect(restored.webview.options).toEqual({ enableScripts: true });
      expect(restored.webview.html).toContain('id="board"');
      restored.webview.simulateMessage({ type: 'ready' });
      await vi.waitFor(() => expect(h?.controller.board).toHaveBeenCalled());
      expect(h.controller.board?.mock.calls[0]?.[0]).toBe('run-restored');
      expect(restored.disposed).toBe(false);
    });

    it('restorePanel: 状態が不正でも落ちず、選択済みのrunは上書きしない', async () => {
      h = open({ show: false });
      h.view.show('run-1');
      __mock.lastCreatedPanel()?.dispose();
      const restored = vscode.window.createWebviewPanel(
        TaskRunKanbanViewManager.viewType,
        '復元',
        vscode.ViewColumn.One,
        {},
      ) as unknown as FakeWebviewPanel;
      h.view.restorePanel(restored as unknown as vscode.WebviewPanel, { runId: 'other' });
      restored.webview.simulateMessage({ type: 'ready' });
      await vi.waitFor(() => expect(h?.controller.board).toHaveBeenCalled());
      expect(h.controller.board?.mock.calls[0]?.[0]).toBe('run-1');
    });

    it.each([[undefined], [null], [['run-x']], [{ runId: 5 }], ['text']])(
      'restorePanel: 状態が%jならrunを選ばない',
      async (state) => {
        h = open({ show: false });
        const restored = vscode.window.createWebviewPanel(
          TaskRunKanbanViewManager.viewType,
          '復元',
          vscode.ViewColumn.One,
          {},
        ) as unknown as FakeWebviewPanel;
        h.view.restorePanel(restored as unknown as vscode.WebviewPanel, state);
        restored.webview.simulateMessage({ type: 'ready' });
        await vi.waitFor(() => expect(h?.controller.board).toHaveBeenCalled());
        expect(h.controller.board?.mock.calls[0]?.[0]).toBeUndefined();
      },
    );

    it('restorePanel: 既にKanbanを開いていれば復元した方を閉じる', () => {
      h = open();
      const restored = vscode.window.createWebviewPanel(
        TaskRunKanbanViewManager.viewType,
        '復元',
        vscode.ViewColumn.One,
        {},
      ) as unknown as FakeWebviewPanel;
      h.view.restorePanel(restored as unknown as vscode.WebviewPanel, { runId: 'run-2' });
      expect(restored.disposed).toBe(true);
      expect(restored.webview.html).toBe('');
      expect(h.panel.disposed).toBe(false);
    });
  });

  describe('盤面の送信', () => {
    it('ready: 選択中のrunの盤面・Orchestrator状態・グラフ・専有権・他ウィンドウ保有のrunを送る', async () => {
      const t1 = card('T1');
      const t2 = card('T2', { dependsOn: [{ taskId: 'T1', satisfied: false }] });
      const board: TaskRunKanbanBoard = {
        runs: [summary('run-1'), summary('run-2'), summary('run-3'), summary('run-old', true)],
        run: kanbanRun('run-1', [t1, t2]),
      };
      h = open({ board, leaseHeld: { 'run-1': true, 'run-3': true, 'run-old': true } });
      h.orchestrator.status?.mockReturnValue('busy');
      send(h, { type: 'ready' });
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
      const posted = sentBoards(h)[0];
      expect(posted).toMatchObject({
        type: 'board',
        board,
        orchestrator: 'busy',
        lease: { heldByOther: true },
        // 選択中のrunと終わったrunは読まない。他ウィンドウが持っている未終了のrunだけ
        heldElsewhere: ['run-3'],
      });
      expect(h.orchestrator.status).toHaveBeenCalledWith('run-1');
      const leaseCalls = h.controller.leaseStatus?.mock.calls.map((c) => c[0] as string);
      expect(leaseCalls?.sort()).toEqual(['run-1', 'run-2', 'run-3']);
      const graph = posted?.graph as { nodes: Array<{ id: string }> };
      expect(graph.nodes.map((n) => n.id).sort()).toEqual(['T1', 'T2']);
    });

    it('runが無い盤面ではOrchestratorとグラフと専有権を読まない', async () => {
      h = open({ board: { runs: [summary('run-9')], run: undefined } });
      send(h, { type: 'ready' });
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
      const posted = sentBoards(h)[0];
      expect(posted?.orchestrator).toBeUndefined();
      expect(posted?.graph).toBeUndefined();
      expect(posted?.lease).toBeUndefined();
      expect(posted?.heldElsewhere).toEqual([]);
      expect(h.orchestrator.status).not.toHaveBeenCalled();
    });

    it('専有権を読む間に次の送信が始まったら、古い盤面は捨てる', async () => {
      const board: TaskRunKanbanBoard = { runs: [], run: kanbanRun('run-1') };
      h = open({ board });
      const first = deferredLease();
      h.controller.leaseStatus
        ?.mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(Promise.resolve({ heldByOther: false }));
      send(h, { type: 'ready' });
      send(h, { type: 'ready' });
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
      first.resolve({ heldByOther: true });
      await settle();
      const boards = sentBoards(h);
      expect(boards).toHaveLength(1);
      expect(boards[0]?.lease).toEqual({ heldByOther: false });
    });

    it('専有権を読む間にパネルが閉じられたら送らない', async () => {
      h = open({ board: { runs: [], run: kanbanRun('run-1') } });
      const pending = deferredLease();
      h.controller.leaseStatus?.mockReturnValueOnce(pending.promise);
      send(h, { type: 'ready' });
      await vi.waitFor(() => expect(h?.controller.leaseStatus).toHaveBeenCalled());
      h.panel.dispose();
      pending.resolve({ heldByOther: false });
      await settle();
      expect(sentBoards(h)).toHaveLength(0);
    });
  });

  describe('まとめ送信とタイマー', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('最初のrefreshはすぐ送り、250ms以内の続きは1回にまとめる', async () => {
      h = open();
      h.view.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(sentBoards(h)).toHaveLength(1);
      h.view.refresh();
      h.view.refresh();
      await vi.advanceTimersByTimeAsync(100);
      expect(sentBoards(h)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(sentBoards(h)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentBoards(h)).toHaveLength(2);
    });

    it('非表示中のrefreshは保留し、表示に戻ったときに送る', async () => {
      h = open();
      h.panel.simulateVisibilityChange(false);
      h.view.refresh();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentBoards(h)).toHaveLength(0);
      h.panel.simulateVisibilityChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(sentBoards(h)).toHaveLength(1);
      // 保留が無ければ表示に戻っても送らない
      h.panel.simulateVisibilityChange(false);
      h.panel.simulateVisibilityChange(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentBoards(h)).toHaveLength(1);
    });

    it('専有権の表示を追従させるため、定期的に再描画する', async () => {
      h = open();
      await vi.advanceTimersByTimeAsync(TASK_LEASE_HEARTBEAT_MS);
      expect(sentBoards(h)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(TASK_LEASE_HEARTBEAT_MS);
      expect(sentBoards(h)).toHaveLength(2);
    });

    it('dispose後は定期の再描画も保留中の送信も止まる', async () => {
      h = open();
      h.view.refresh();
      await vi.advanceTimersByTimeAsync(0);
      h.view.refresh();
      h.view.dispose();
      await vi.advanceTimersByTimeAsync(TASK_LEASE_HEARTBEAT_MS * 2);
      expect(sentBoards(h)).toHaveLength(1);
    });

    it('パネルが閉じられたらタイマーを止める', async () => {
      h = open();
      h.view.refresh();
      await vi.advanceTimersByTimeAsync(0);
      h.view.refresh();
      h.panel.dispose();
      await vi.advanceTimersByTimeAsync(TASK_LEASE_HEARTBEAT_MS * 2);
      expect(sentBoards(h)).toHaveLength(1);
    });

    it('viewport: 幅を0〜20000へ丸め、同じ幅なら再送しない', async () => {
      h = open({ board: { runs: [], run: kanbanRun('run-1', [card('T1')]) } });
      send(h, { type: 'viewport', width: 800.4 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sentBoards(h)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      send(h, { type: 'viewport', width: 800 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sentBoards(h)).toHaveLength(1);
      send(h, { type: 'viewport', width: 99999 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sentBoards(h)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      send(h, { type: 'viewport', width: -5 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sentBoards(h)).toHaveLength(3);
    });

    it.each([['400'], [Number.NaN], [Number.POSITIVE_INFINITY], [undefined]])(
      'viewport: 幅が%jなら無視する',
      async (width) => {
        h = open();
        send(h, { type: 'viewport', width });
        await vi.advanceTimersByTimeAsync(1000);
        expect(sentBoards(h)).toHaveLength(0);
      },
    );
  });

  describe('webviewからのメッセージの検証', () => {
    it.each([
      ['文字列', 'approvePlan'],
      ['null', null],
      ['配列', ['approvePlan']],
      ['typeなし', { runId: 'run-1' }],
      ['typeが数値', { type: 1, runId: 'run-1' }],
      ['runIdなし', { type: 'approvePlan' }],
      ['runIdが数値', { type: 'approvePlan', runId: 1 }],
    ])('%sは捨てる', async (_name, message) => {
      h = open();
      send(h, message);
      await settle();
      expect(h.controller.approvePlan).not.toHaveBeenCalled();
      expect(__mock.messages.warnings).toEqual([]);
      expect(__mock.messages.errors).toEqual([]);
    });

    it('未知のtypeは何も起こさない', async () => {
      h = open();
      send(h, { type: 'unknown', runId: 'run-1', taskId: 'T1' });
      await settle();
      expect(__mock.messages.warnings).toEqual([]);
      expect(__mock.messages.errors).toEqual([]);
    });

    it('工程の操作はtaskIdの形が不正なら捨てる', async () => {
      h = open();
      for (const taskId of ['t1', 'T0', 'T1; rm', 5, undefined]) {
        send(h, { type: 'retryStage', runId: 'run-1', taskId });
      }
      await settle();
      expect(h.controller.retryStage).not.toHaveBeenCalled();
    });

    it('操作が例外で失敗したらログへ残し、エラーを通知する', async () => {
      h = open();
      h.controller.approvePlan?.mockRejectedValue(new Error('壊れた'));
      send(h, { type: 'approvePlan', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.errors).toHaveLength(1));
      expect(__mock.messages.errors[0]).toBe('オーケストレータモード: 操作に失敗しました');
      expect(warnLog).toHaveBeenCalledTimes(1);
      const logged = String(warnLog.mock.calls[0]?.[0]);
      expect(logged).toContain('approvePlan');
      expect(logged).toContain('壊れた');
    });
  });

  describe('runの操作', () => {
    it('approvePlan: controllerへ渡し、拒否されたら警告する', async () => {
      h = open();
      send(h, { type: 'approvePlan', runId: 'run-1' });
      await vi.waitFor(() => expect(h?.controller.approvePlan).toHaveBeenCalledWith('run-1'));
      await settle();
      expect(__mock.messages.warnings).toEqual([]);
      h.controller.approvePlan?.mockResolvedValue(NG);
      send(h, { type: 'approvePlan', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      expect(__mock.messages.warnings[0]).toBe('オーケストレータモード: 失敗した');
    });

    it('syncRoadmap: 成功は情報通知、失敗は警告', async () => {
      h = open();
      send(h, { type: 'syncRoadmap', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.infos).toHaveLength(1));
      expect(__mock.messages.infos[0]).toBe('オーケストレータモード: できた');
      expect(__mock.messages.warnings).toEqual([]);
      h.controller.syncRoadmap?.mockResolvedValue(NG);
      send(h, { type: 'syncRoadmap', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      expect(__mock.messages.warnings[0]).toBe('オーケストレータモード: 失敗した');
      expect(__mock.messages.infos).toHaveLength(1);
    });

    it('setMaxParallel: 数値だけ渡し、拒否は警告する', async () => {
      h = open();
      send(h, { type: 'setMaxParallel', runId: 'run-1', maxParallel: '3' });
      await settle();
      expect(h.controller.setMaxParallel).not.toHaveBeenCalled();
      h.controller.setMaxParallel?.mockResolvedValue(NG);
      send(h, { type: 'setMaxParallel', runId: 'run-1', maxParallel: 3 });
      await vi.waitFor(() => expect(h?.controller.setMaxParallel).toHaveBeenCalledWith('run-1', 3));
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
    });

    it('setHalted: 真偽値だけ渡す', async () => {
      h = open();
      send(h, { type: 'setHalted', runId: 'run-1', halted: 'true' });
      await settle();
      expect(h.controller.setHalted).not.toHaveBeenCalled();
      send(h, { type: 'setHalted', runId: 'run-1', halted: true });
      await vi.waitFor(() => expect(h?.controller.setHalted).toHaveBeenCalledWith('run-1', true));
      send(h, { type: 'setHalted', runId: 'run-1', halted: false });
      await vi.waitFor(() => expect(h?.controller.setHalted).toHaveBeenCalledWith('run-1', false));
    });

    it('transferLease: 確認したときだけ専有権を移す', async () => {
      h = open();
      __mock.showWarningMessageAnswer = undefined;
      send(h, { type: 'transferLease', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      await settle();
      expect(h.controller.transferLease).not.toHaveBeenCalled();
      __mock.showWarningMessageAnswer = '移す';
      send(h, { type: 'transferLease', runId: 'run-1' });
      await vi.waitFor(() => expect(h?.controller.transferLease).toHaveBeenCalledWith('run-1'));
      expect(__mock.messages.warnings[0]).toContain('専有権をこのウィンドウへ移しますか');
    });

    it('renameRun: 入力した名前を設定し、取消なら何もしない', async () => {
      h = open({ runs: { 'run-1': storedRun('run-1', { title: '旧名' }) } });
      const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce(undefined);
      send(h, { type: 'renameRun', runId: 'run-1' });
      await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));
      await settle();
      expect(h.controller.setTitle).not.toHaveBeenCalled();
      expect(input.mock.calls[0]?.[0]).toMatchObject({ title: 'runの名前', value: '旧名' });
      input.mockResolvedValueOnce('新名');
      send(h, { type: 'renameRun', runId: 'run-1' });
      await vi.waitFor(() => expect(h?.controller.setTitle).toHaveBeenCalledWith('run-1', '新名'));
    });

    it('renameRun: 無いrunは入力欄を出さない。名前が無いrunの初期値は空', async () => {
      h = open({ runs: { 'run-2': storedRun('run-2') } });
      const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
      send(h, { type: 'renameRun', runId: 'missing' });
      await settle();
      expect(input).not.toHaveBeenCalled();
      send(h, { type: 'renameRun', runId: 'run-2' });
      await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));
      expect(input.mock.calls[0]?.[0]).toMatchObject({ value: '' });
      const validate = (input.mock.calls[0]?.[0] as { validateInput: (v: string) => unknown })
        .validateInput;
      expect(validate('短い')).toBeUndefined();
      expect(validate('あ'.repeat(500))).toEqual(expect.any(String));
    });

    it('openPullRequest: httpsのURLだけ開く', async () => {
      h = open();
      const parse = vi.spyOn(vscode.Uri, 'parse');
      const external = vi.spyOn(vscode.env, 'openExternal');
      parse.mockImplementation(
        (value: string) => ({ scheme: value.split(':')[0], fsPath: value }) as vscode.Uri,
      );
      send(h, { type: 'openPullRequest', runId: 'run-1', url: 'https://example.com/pull/1' });
      await vi.waitFor(() => expect(external).toHaveBeenCalledTimes(1));
      expect(external.mock.calls[0]?.[0]).toMatchObject({ fsPath: 'https://example.com/pull/1' });
      send(h, { type: 'openPullRequest', runId: 'run-1', url: 'http://example.com/pull/1' });
      send(h, { type: 'openPullRequest', runId: 'run-1', url: 'javascript:alert(1)' });
      send(h, { type: 'openPullRequest', runId: 'run-1', url: 42 });
      await settle();
      expect(external).toHaveBeenCalledTimes(1);
    });

    it('openPullRequest: URLの解析に失敗したら開かない', async () => {
      h = open();
      vi.spyOn(vscode.Uri, 'parse').mockImplementation(() => {
        throw new Error('bad uri');
      });
      const external = vi.spyOn(vscode.env, 'openExternal');
      send(h, { type: 'openPullRequest', runId: 'run-1', url: 'https://%' });
      await settle();
      expect(external).not.toHaveBeenCalled();
      expect(__mock.messages.errors).toEqual([]);
    });
  });

  describe('Orchestratorを開く', () => {
    it('中断中のrunでは開かず、再開を促す', async () => {
      h = open({
        runs: { 'run-1': storedRun('run-1', { suspendedAt: '2026-01-02T00:00:00.000Z' }) },
      });
      send(h, { type: 'openOrchestrator', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      expect(__mock.messages.warnings[0]).toContain('中断中のrunです');
      expect(h.orchestrator.open).not.toHaveBeenCalled();
    });

    it('renewを渡して開く。開けたら警告せず盤面を再送する', async () => {
      h = open({ runs: { 'run-1': storedRun('run-1') } });
      send(h, { type: 'openOrchestrator', runId: 'run-1', renew: true });
      await vi.waitFor(() => expect(h?.orchestrator.open).toHaveBeenCalledWith('run-1', true));
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
      expect(__mock.messages.warnings).toEqual([]);
      send(h, { type: 'openOrchestrator', runId: 'run-1', renew: 'yes' });
      await vi.waitFor(() => expect(h?.orchestrator.open).toHaveBeenLastCalledWith('run-1', false));
    });

    it('開けなかったら警告する', async () => {
      h = open({ runs: { 'run-1': storedRun('run-1') } });
      h.orchestrator.open?.mockResolvedValue(false);
      send(h, { type: 'openOrchestrator', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      expect(__mock.messages.warnings[0]).toContain('Orchestratorを開けませんでした');
    });
  });

  describe('runの選択', () => {
    it('selectRun: 動いているrunを選び、Orchestratorを前面へ出す', async () => {
      h = open({ runs: { 'run-2': storedRun('run-2') } });
      send(h, { type: 'selectRun', runId: 'run-2' });
      await vi.waitFor(() => expect(h?.orchestrator.open).toHaveBeenCalledWith('run-2', false));
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
      expect(h.controller.board?.mock.calls.at(-1)?.[0]).toBe('run-2');
    });

    it.each([
      ['中断中', { suspendedAt: '2026-01-02T00:00:00.000Z' }],
      ['終了', { finishedAt: '2026-01-02T00:00:00.000Z' }],
    ])('selectRun: %sのrunは選ぶがOrchestratorは開かない', async (_name, overrides) => {
      h = open({ runs: { 'run-2': storedRun('run-2', overrides as Partial<TaskRun>) } });
      send(h, { type: 'selectRun', runId: 'run-2' });
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
      await settle();
      expect(h.controller.board?.mock.calls.at(-1)?.[0]).toBe('run-2');
      expect(h.orchestrator.open).not.toHaveBeenCalled();
    });

    it('selectRun: 消えたrunは選択を変えず、盤面だけ描き直す', async () => {
      h = open();
      h.view.show('run-1');
      send(h, { type: 'selectRun', runId: 'gone' });
      await vi.waitFor(() => expect(sentBoards(h as Harness).length).toBeGreaterThan(0));
      expect(h.controller.board?.mock.calls.at(-1)?.[0]).toBe('run-1');
      expect(h.orchestrator.open).not.toHaveBeenCalled();
    });

    it('selectRun: runIdが文字列でなければ捨てる', async () => {
      h = open();
      send(h, { type: 'selectRun', runId: 3 });
      await settle();
      expect(h.controller.find).not.toHaveBeenCalled();
    });
  });

  describe('runの終了・中断・再開', () => {
    it('finishRun: 確認したときだけ終える', async () => {
      h = open();
      __mock.showWarningMessageAnswer = undefined;
      send(h, { type: 'finishRun', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      await settle();
      expect(h.deps.finishRun).not.toHaveBeenCalled();
      __mock.showWarningMessageAnswer = 'runを終える';
      send(h, { type: 'finishRun', runId: 'run-1' });
      await vi.waitFor(() => expect(h?.deps.finishRun).toHaveBeenCalledWith('run-1'));
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
    });

    it('finishRun: 失敗は警告する', async () => {
      h = open();
      h.deps.finishRun.mockResolvedValue(NG);
      send(h, { type: 'finishRun', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(2));
      expect(__mock.messages.warnings[1]).toBe('オーケストレータモード: 失敗した');
    });

    it('suspendRun: 無いrunと動いていないrunでは確認を出さない', async () => {
      h = open({
        runs: {
          done: storedRun('done', { finishedAt: '2026-01-02T00:00:00.000Z' }),
          paused: storedRun('paused', { suspendedAt: '2026-01-02T00:00:00.000Z' }),
        },
      });
      for (const runId of ['missing', 'done', 'paused']) {
        send(h, { type: 'suspendRun', runId });
      }
      await settle();
      expect(__mock.messages.warnings).toEqual([]);
      expect(h.deps.suspendRun).not.toHaveBeenCalled();
    });

    it('suspendRun: 確認したときだけ中断する', async () => {
      h = open({ runs: { 'run-1': storedRun('run-1') } });
      __mock.showWarningMessageAnswer = undefined;
      send(h, { type: 'suspendRun', runId: 'run-1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      await settle();
      expect(h.deps.suspendRun).not.toHaveBeenCalled();
      __mock.showWarningMessageAnswer = 'runを中断する';
      send(h, { type: 'suspendRun', runId: 'run-1' });
      await vi.waitFor(() => expect(h?.deps.suspendRun).toHaveBeenCalledWith('run-1'));
      await vi.waitFor(() => expect(sentBoards(h as Harness)).toHaveLength(1));
    });

    it('resumeRun: 中断中でないrun・無いrunは何もしない', async () => {
      h = open({
        runs: {
          active: storedRun('active'),
          done: storedRun('done', {
            suspendedAt: '2026-01-02T00:00:00.000Z',
            finishedAt: '2026-01-03T00:00:00.000Z',
          }),
        },
      });
      for (const runId of ['missing', 'active', 'done']) {
        send(h, { type: 'resumeRun', runId });
      }
      await settle();
      expect(h.deps.resumeRun).not.toHaveBeenCalled();
      expect(__mock.messages.warnings).toEqual([]);
    });

    const suspended = { suspendedAt: '2026-01-02T00:00:00.000Z' };

    it('resumeRun: 他に動くrunが無ければそのまま再開し、そのrunを選ぶ', async () => {
      h = open({ runs: { 'run-1': storedRun('run-1', suspended) } });
      await h.view.resumeRun('run-1');
      expect(h.deps.resumeRun).toHaveBeenCalledWith('run-1', { parallel: false });
      expect(__mock.messages.warnings).toEqual([]);
      send(h, { type: 'ready' });
      await vi.waitFor(() => expect(h?.controller.board).toHaveBeenCalled());
      expect(h.controller.board?.mock.calls.at(-1)?.[0]).toBe('run-1');
    });

    it('resumeRun: 再開が拒否されたら警告する', async () => {
      h = open({ runs: { 'run-1': storedRun('run-1', suspended) } });
      h.deps.resumeRun.mockResolvedValue(NG);
      await h.view.resumeRun('run-1');
      expect(__mock.messages.warnings).toEqual(['オーケストレータモード: 失敗した']);
    });

    it('resumeRun: 1本動いていれば並行か入れ替えかを選ばせる（並行）', async () => {
      const other = storedRun('run-2', { title: '別のrun' });
      h = open({
        runs: { 'run-1': storedRun('run-1', suspended) },
        active: [other, storedRun('run-1')],
      });
      const warn = vi
        .spyOn(vscode.window, 'showWarningMessage')
        .mockResolvedValue('並行して再開する' as never);
      await h.view.resumeRun('run-1');
      expect(h.controller.listActive).toHaveBeenCalledWith('/work');
      const call = warn.mock.calls[0] as unknown as [string, { detail: string }, ...string[]];
      expect(call[0]).toContain('「別のrun」');
      expect(call.slice(2)).toEqual(['並行して再開する', 'そのrunを中断して再開する']);
      expect(call[1].detail).toContain('動いているrunの工程セッションとOrchestratorを止めます');
      expect(h.deps.suspendRun).not.toHaveBeenCalled();
      expect(h.deps.resumeRun).toHaveBeenCalledWith('run-1', { parallel: true });
    });

    it('resumeRun: 1本動いていて入れ替えを選ぶと、そちらを中断してから再開する', async () => {
      h = open({
        runs: { 'run-1': storedRun('run-1', suspended) },
        active: [storedRun('run-2')],
      });
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
        'そのrunを中断して再開する' as never,
      );
      await h.view.resumeRun('run-1');
      expect(h.deps.suspendRun).toHaveBeenCalledWith('run-2');
      expect(h.deps.resumeRun).toHaveBeenCalledWith('run-1', { parallel: false });
    });

    it('resumeRun: 入れ替えで相手の中断に失敗したら、警告して再開しない', async () => {
      h = open({
        runs: { 'run-1': storedRun('run-1', suspended) },
        active: [storedRun('run-2')],
      });
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
        'そのrunを中断して再開する' as never,
      );
      h.deps.suspendRun.mockResolvedValue(NG);
      await h.view.resumeRun('run-1');
      expect(h.deps.resumeRun).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(
        'オーケストレータモード: 失敗した',
      );
    });

    it('resumeRun: 選択を取り消したら再開しない', async () => {
      h = open({
        runs: { 'run-1': storedRun('run-1', suspended) },
        active: [storedRun('run-2')],
      });
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
      await h.view.resumeRun('run-1');
      expect(h.deps.suspendRun).not.toHaveBeenCalled();
      expect(h.deps.resumeRun).not.toHaveBeenCalled();
    });

    it('resumeRun: 複数動いていれば並行だけを選択肢に出す', async () => {
      h = open({
        runs: { 'run-1': storedRun('run-1', suspended) },
        active: [storedRun('run-2'), storedRun('run-3')],
      });
      const warn = vi
        .spyOn(vscode.window, 'showWarningMessage')
        .mockResolvedValue('並行して再開する' as never);
      await h.view.resumeRun('run-1');
      const call = warn.mock.calls[0] as unknown as [string, { detail: string }, ...string[]];
      expect(call[0]).toContain('2本');
      expect(call.slice(2)).toEqual(['並行して再開する']);
      expect(call[1].detail).toContain('Kanbanでそのrunを選んで中断してから');
      expect(h.deps.resumeRun).toHaveBeenCalledWith('run-1', { parallel: true });
    });

    it('resumeRun: 複数動いていて、他のボタン文字列が返っても再開しない', async () => {
      h = open({
        runs: { 'run-1': storedRun('run-1', suspended) },
        active: [storedRun('run-2'), storedRun('run-3')],
      });
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(
        'そのrunを中断して再開する' as never,
      );
      await h.view.resumeRun('run-1');
      expect(h.deps.suspendRun).not.toHaveBeenCalled();
      expect(h.deps.resumeRun).not.toHaveBeenCalled();
    });
  });

  describe('工程の操作', () => {
    const t1 = card('T1');
    const stoppable = { runs: [], run: kanbanRun('run-1', [t1, card('T2', { canStop: false })]) };

    it('stopStage: 停止できる工程だけ、確認してから止める', async () => {
      h = open({ board: stoppable });
      __mock.showWarningMessageAnswer = undefined;
      send(h, { type: 'stopStage', runId: 'run-1', taskId: 'T1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      await settle();
      expect(h.controller.stopStage).not.toHaveBeenCalled();
      __mock.showWarningMessageAnswer = '停止する';
      send(h, { type: 'stopStage', runId: 'run-1', taskId: 'T1' });
      await vi.waitFor(() => expect(h?.controller.stopStage).toHaveBeenCalledWith('run-1', 'T1'));
      expect(__mock.messages.warnings[0]).toContain('T1の工程を停止しますか');
    });

    it('stopStage: 停止できない工程・別runの盤面・無いタスクは確認も出さない', async () => {
      h = open({ board: stoppable });
      send(h, { type: 'stopStage', runId: 'run-1', taskId: 'T2' });
      send(h, { type: 'stopStage', runId: 'run-1', taskId: 'T9' });
      send(h, { type: 'stopStage', runId: 'run-other', taskId: 'T1' });
      await settle();
      expect(__mock.messages.warnings).toEqual([]);
      expect(h.controller.stopStage).not.toHaveBeenCalled();
    });

    it('stopStage: 拒否されたら警告する', async () => {
      h = open({ board: stoppable });
      h.controller.stopStage?.mockResolvedValue(NG);
      send(h, { type: 'stopStage', runId: 'run-1', taskId: 'T1' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(2));
      expect(__mock.messages.warnings[1]).toBe('オーケストレータモード: 失敗した');
    });

    it('retryStage: controllerへ渡し、拒否は警告する', async () => {
      h = open();
      send(h, { type: 'retryStage', runId: 'run-1', taskId: 'T3' });
      await vi.waitFor(() => expect(h?.controller.retryStage).toHaveBeenCalledWith('run-1', 'T3'));
      h.controller.retryStage?.mockResolvedValue(NG);
      send(h, { type: 'retryStage', runId: 'run-1', taskId: 'T3' });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
    });

    it('revealStage: 開いていなければ知らせる', async () => {
      h = open();
      send(h, { type: 'revealStage', runId: 'run-1', taskId: 'T3' });
      await vi.waitFor(() => expect(h?.deps.revealStage).toHaveBeenCalledWith('run-1', 'T3'));
      await settle();
      expect(__mock.messages.infos).toEqual([]);
      h.deps.revealStage.mockReturnValue(false);
      send(h, { type: 'revealStage', runId: 'run-1', taskId: 'T3' });
      await vi.waitFor(() => expect(__mock.messages.infos).toHaveLength(1));
      expect(__mock.messages.infos[0]).toContain('T3の工程セッションは開いていません');
    });
  });

  describe('質問・指示・関門', () => {
    it('answerQuestion: 検証を通った回答だけ渡す', async () => {
      h = open();
      send(h, {
        type: 'answerQuestion',
        runId: 'run-1',
        taskId: 'T3',
        questionId: 'q1',
        answer: 'はい',
      });
      await vi.waitFor(() =>
        expect(h?.controller.answerQuestion).toHaveBeenCalledWith('run-1', 'T3', 'q1', 'はい'),
      );
      await settle();
      expect(__mock.messages.infos).toEqual([]);
    });

    it.each([
      ['回答が空', { questionId: 'q1', answer: '' }],
      ['回答が文字列でない', { questionId: 'q1', answer: 5 }],
      ['questionIdが無い', { answer: 'はい' }],
      ['回答が長すぎる', { questionId: 'q1', answer: 'あ'.repeat(MAX_USER_ANSWER_LENGTH + 1) }],
    ])('answerQuestion: %sなら警告して渡さない', async (_name, fields) => {
      h = open();
      send(h, { type: 'answerQuestion', runId: 'run-1', taskId: 'T3', ...fields });
      await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
      expect(__mock.messages.warnings[0]).toBe(
        `オーケストレータモード: 回答は1〜${String(MAX_USER_ANSWER_LENGTH)}文字で入力してください`,
      );
      expect(h.controller.answerQuestion).not.toHaveBeenCalled();
    });

    it('answerQuestion: 回答待ちでなければ理由を知らせる', async () => {
      h = open();
      h.controller.answerQuestion?.mockResolvedValue({ ok: false, message: '回答済みです' });
      send(h, {
        type: 'answerQuestion',
        runId: 'run-1',
        taskId: 'T3',
        questionId: 'q1',
        answer: 'はい',
      });
      await vi.waitFor(() => expect(__mock.messages.infos).toHaveLength(1));
      expect(__mock.messages.infos[0]).toBe('T3: 回答済みです');
    });

    it('instructTask: 届いたらOrchestratorへもイベントとして知らせる', async () => {
      h = open();
      send(h, {
        type: 'instructTask',
        runId: 'run-1',
        taskId: 'T3',
        instruction: 'テストも書いて',
      });
      await vi.waitFor(() =>
        expect(h?.controller.instructTask).toHaveBeenCalledWith('run-1', 'T3', 'テストも書いて'),
      );
      await vi.waitFor(() =>
        expect(h?.orchestrator.notifyTaskInstructed).toHaveBeenCalledWith(
          'run-1',
          'T3',
          'テストも書いて',
        ),
      );
      expect(__mock.messages.infos).toEqual([]);
    });

    it('instructTask: 失敗したらOrchestratorへ知らせず、理由を通知する', async () => {
      h = open();
      h.controller.instructTask?.mockResolvedValue({ ok: false, message: '動いていません' });
      send(h, { type: 'instructTask', runId: 'run-1', taskId: 'T3', instruction: '続けて' });
      await vi.waitFor(() => expect(__mock.messages.infos).toHaveLength(1));
      expect(__mock.messages.infos[0]).toBe('T3: 動いていません');
      expect(h.orchestrator.notifyTaskInstructed).not.toHaveBeenCalled();
    });

    it.each([[''], [undefined], [7]])(
      'instructTask: 指示が%jなら警告して渡さない',
      async (instruction) => {
        h = open();
        send(h, { type: 'instructTask', runId: 'run-1', taskId: 'T3', instruction });
        await vi.waitFor(() => expect(__mock.messages.warnings).toHaveLength(1));
        expect(__mock.messages.warnings[0]).toBe(
          `オーケストレータモード: 指示は1〜${String(MAX_USER_ANSWER_LENGTH)}文字で入力してください`,
        );
        expect(h.controller.instructTask).not.toHaveBeenCalled();
      },
    );

    it.each([['sendBack'], ['proceed']])('resolveGate: %sを渡す', async (choice) => {
      h = open();
      send(h, { type: 'resolveGate', runId: 'run-1', taskId: 'T3', gateId: 'g1', choice });
      await vi.waitFor(() =>
        expect(h?.controller.resolveGate).toHaveBeenCalledWith('run-1', 'T3', 'g1', choice),
      );
    });

    it.each([
      ['choiceが未知の値', { gateId: 'g1', choice: 'abort' }],
      ['gateIdが無い', { choice: 'proceed' }],
    ])('resolveGate: %sなら捨てる', async (_name, fields) => {
      h = open();
      send(h, { type: 'resolveGate', runId: 'run-1', taskId: 'T3', ...fields });
      await settle();
      expect(h.controller.resolveGate).not.toHaveBeenCalled();
    });

    it('resolveGate: 拒否されたら理由を通知する', async () => {
      h = open();
      h.controller.resolveGate?.mockResolvedValue({ ok: false, message: '決着済みです' });
      send(h, {
        type: 'resolveGate',
        runId: 'run-1',
        taskId: 'T3',
        gateId: 'g1',
        choice: 'proceed',
      });
      await vi.waitFor(() => expect(__mock.messages.infos).toHaveLength(1));
      expect(__mock.messages.infos[0]).toBe('T3: 決着済みです');
    });
  });

  describe('currentWorkspaceFolders', () => {
    it('開いているワークスペースフォルダのパスを返す。無ければ空', () => {
      expect(currentWorkspaceFolders()).toEqual([]);
      __mock.setWorkspaceFolders([
        { fsPath: '/a', name: 'a' },
        { fsPath: '/b', name: 'b' },
      ]);
      expect(currentWorkspaceFolders()).toEqual(['/a', '/b']);
    });

    it('盤面の取得へ現在のフォルダを渡す', async () => {
      __mock.setWorkspaceFolder('/work');
      h = open();
      send(h, { type: 'ready' });
      await vi.waitFor(() =>
        expect(h?.controller.board).toHaveBeenCalledWith(undefined, ['/work']),
      );
    });
  });
});
