import { beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/log';
import type {
  LiveRunSummary,
  TaskSnapshot,
  WorkflowRunner,
  WorkflowRunSnapshot,
} from '../../src/orchestrator/runner';
import type { GraphLayout } from '../../src/view/workflowGraph';
import { NODE_GAP_X, NODE_WIDTH } from '../../src/view/workflowGraph';
import { WorkflowViewManager } from '../../src/view/workflowView';
import { __mock } from '../mocks/vscode';

/**
 * グラフがパネル幅に収まらない場合の表示（design.md §16.8「依存グラフ」）。
 *
 * 拡張機能側はパネルの幅を知らないため、Webviewが `viewport` メッセージで描画領域の幅を
 * 伝え、`layoutGraph` がその幅に合わせて段を折り返す。ここではその往復を、実際の
 * `WorkflowViewManager` とフェイクのWebviewパネルで確かめる。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const makeTask = (id: string, dependsOn: readonly string[]): TaskSnapshot =>
  ({
    id,
    dependsOn,
    provider: 'codex',
    state: 'pending',
    cwd: undefined,
    branch: undefined,
    submissionCount: 0,
    retryCount: 0,
    startedAt: undefined,
    lastResponseSummary: '',
    failure: undefined,
    pendingApproval: undefined,
    hasLiveSession: false,
    expandedPrompt: undefined,
    expandedContinuePrompt: undefined,
  }) as unknown as TaskSnapshot;

/** rank1に6タスクが並ぶ実行。折り返さなければ 1252px 必要になる。 */
const SNAPSHOT: WorkflowRunSnapshot = {
  runId: 'run-1',
  name: '幅の広いワークフロー',
  defPath: '/w/wf.yaml',
  outcome: 'running',
  startedAt: new Date(0).toISOString(),
  tasks: [
    makeTask('T1', []),
    ...Array.from({ length: 6 }, (_, i) => makeTask('W' + (i + 1), ['T1'])),
  ],
  warnings: [],
  haltedByUser: false,
};

const SUMMARY: LiveRunSummary = {
  runId: 'run-1',
  name: SNAPSHOT.name,
  defPath: SNAPSHOT.defPath,
  outcome: 'running',
};

/** Viewが使う3つの口だけを持つ最小の`WorkflowRunner`。 */
const fakeRunner = {
  onChanged: () => () => undefined,
  listLive: () => [SUMMARY],
  getSnapshot: (runId: string) => (runId === SNAPSHOT.runId ? SNAPSHOT : undefined),
} as unknown as WorkflowRunner;

const lastLayout = (sent: readonly unknown[]): GraphLayout => {
  const states = sent.filter(
    (m): m is { type: 'state'; layout: GraphLayout } =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
  );
  const last = states[states.length - 1];
  expect(last).toBeDefined();
  return (last as { layout: GraphLayout }).layout;
};

/** n個のノードを1行に並べるのに要する幅。 */
const rowWidthFor = (count: number): number =>
  count * NODE_WIDTH + (count - 1) * NODE_GAP_X + NODE_GAP_X * 2;

describe('WorkflowViewManager: グラフが幅に収まらない場合（design.md §16.8）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('幅の通知が無ければ折り返さない（従来どおりの段レイアウト）', () => {
    const view = new WorkflowViewManager(fakeRunner, fakeLogger);
    view.show();

    const panel = __mock.createdPanels[0];
    expect(panel).toBeDefined();
    const layout = lastLayout(panel!.webview.sent);
    expect(layout.wrapped).toBe(false);
    view.dispose();
  });

  it('Webviewが伝えた描画幅に合わせて段を折り返して送り直す', () => {
    const view = new WorkflowViewManager(fakeRunner, fakeLogger);
    view.show();
    const panel = __mock.createdPanels[0]!;

    panel.webview.simulateMessage({ type: 'viewport', width: rowWidthFor(3) });

    const layout = lastLayout(panel.webview.sent);
    expect(layout.wrapped).toBe(true);
    expect(layout.width).toBeLessThanOrEqual(rowWidthFor(3));
    const rows = new Set(layout.nodes.filter((n) => n.rank === 1).map((n) => n.row));
    expect(rows.size).toBe(2);
    view.dispose();
  });

  it('同じ幅が再送されても状態を送り直さない（往復の振動を防ぐ）', () => {
    const view = new WorkflowViewManager(fakeRunner, fakeLogger);
    view.show();
    const panel = __mock.createdPanels[0]!;

    panel.webview.simulateMessage({ type: 'viewport', width: 640 });
    const afterFirst = panel.webview.sent.length;
    panel.webview.simulateMessage({ type: 'viewport', width: 640 });

    expect(panel.webview.sent.length).toBe(afterFirst);
    view.dispose();
  });

  it('Webviewから届いた不正な幅（NaN・負値）でレイアウトを壊さない', () => {
    const view = new WorkflowViewManager(fakeRunner, fakeLogger);
    view.show();
    const panel = __mock.createdPanels[0]!;

    panel.webview.simulateMessage({ type: 'viewport', width: Number.NaN });
    panel.webview.simulateMessage({ type: 'viewport', width: -5000 });

    const layout = lastLayout(panel.webview.sent);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.nodes).toHaveLength(SNAPSHOT.tasks.length);
    view.dispose();
  });

  it('初期HTMLにグラフのズーム操作を置く（全体表示・拡大・縮小）', () => {
    const view = new WorkflowViewManager(fakeRunner, fakeLogger);
    view.show();
    const panel = __mock.createdPanels[0]!;

    expect(panel.webview.html).toContain('id="graphZoomFitBtn"');
    expect(panel.webview.html).toContain('id="graphZoomInBtn"');
    expect(panel.webview.html).toContain('id="graphZoomOutBtn"');
    view.dispose();
  });
});
