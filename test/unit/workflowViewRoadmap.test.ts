import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import type { RoadmapIssueSummary } from '../../src/orchestrator/roadmap';
import type {
  LiveRunSummary,
  WorkflowRunner,
  WorkflowRunSnapshot,
} from '../../src/orchestrator/runner';
import { WorkflowViewManager, type RoadmapViewPort } from '../../src/view/workflowView';
import { __mock } from '../mocks/vscode';

/**
 * ワークフローViewのロードマップ欄（Issue #1257）の非同期まわりの確認。
 *
 * ロードマップ本体の表示（ファイルの読み取り）と、Issueの状態の照合（`gh`/`glab`の起動）は
 * 別便で送る。ここでは「遅れて届いた結果が古いrunの表示を上書きしないか」「取得に失敗しても
 * ロードマップ本体は出るか」「人が押した更新でキャッシュを無視して取り直すか」「Issueを開く
 * 導線が`https://`以外を弾くか」を、実際の`WorkflowViewManager`とフェイクのWebviewパネルで
 * 確かめる。
 */

const quietLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const MARKDOWN = ['# 目標', '', '## フェーズ1', '', '- [ ] R1 やる', '  - Issue: #7'].join('\n');

function snapshot(runId: string, roadmapPath: string | undefined): WorkflowRunSnapshot {
  return {
    runId,
    name: runId,
    defPath: `/w/${runId}.yaml`,
    outcome: 'running',
    startedAt: new Date(0).toISOString(),
    tasks: [],
    warnings: [],
    haltedByUser: false,
    roadmapPath,
  };
}

function summary(runId: string): LiveRunSummary {
  return { runId, name: runId, defPath: `/w/${runId}.yaml`, outcome: 'running' };
}

/** 指定のrunだけを持つ最小の`WorkflowRunner`。 */
function fakeRunner(snapshots: readonly WorkflowRunSnapshot[]): WorkflowRunner {
  return {
    onChanged: () => () => undefined,
    listLive: () => snapshots.map((s) => summary(s.runId)),
    getSnapshot: (runId: string) => snapshots.find((s) => s.runId === runId),
  } as unknown as WorkflowRunner;
}

/** ロードマップのメッセージだけを新しい順で取り出す。 */
function roadmapMessages(sent: readonly unknown[]) {
  return sent.filter(
    (
      m,
    ): m is {
      type: 'roadmap';
      roadmap?: { phases: { items: { issueState: string }[] }[] };
      pending?: boolean;
      error?: string;
    } => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'roadmap',
  );
}

const ISSUE_7: RoadmapIssueSummary = {
  number: 7,
  title: 'やる',
  state: 'open',
  url: 'https://example.com/issues/7',
};

describe('WorkflowViewManager: ロードマップ欄（Issue #1257）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('ロードマップ本体を先に送り、Issueの照合結果で上書きする', async () => {
    const port: RoadmapViewPort = {
      readRoadmap: async () => MARKDOWN,
      listIssues: async () => [ISSUE_7],
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md')]),
      quietLog,
      undefined,
      port,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;

    await vi.waitFor(() => {
      const messages = roadmapMessages(panel.webview.sent);
      expect(messages.some((m) => m.pending === false)).toBe(true);
    });
    const messages = roadmapMessages(panel.webview.sent);
    // 1通目は照合前（pending）で、Issueの状態は不明のまま
    expect(messages[0]?.pending).toBe(true);
    expect(messages[0]?.roadmap?.phases[0]?.items[0]?.issueState).toBe('unknown');
    const last = messages[messages.length - 1]!;
    expect(last.pending).toBe(false);
    expect(last.roadmap?.phases[0]?.items[0]?.issueState).toBe('open');
    view.dispose();
  });

  it('Issue一覧が取れなくてもロードマップ本体は出る', async () => {
    const port: RoadmapViewPort = {
      readRoadmap: async () => MARKDOWN,
      listIssues: async () => {
        throw new Error('gh: command not found');
      },
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md')]),
      quietLog,
      undefined,
      port,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;

    await vi.waitFor(() => {
      expect(roadmapMessages(panel.webview.sent).some((m) => m.pending === false)).toBe(true);
    });
    const last = roadmapMessages(panel.webview.sent).at(-1)!;
    expect(last.roadmap?.phases[0]?.items[0]?.issueState).toBe('unknown');
    view.dispose();
  });

  it('ロードマップを読めなければ理由だけを送る', async () => {
    const port: RoadmapViewPort = {
      readRoadmap: async () => undefined,
      listIssues: async () => [ISSUE_7],
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md')]),
      quietLog,
      undefined,
      port,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;

    await vi.waitFor(() => {
      expect(roadmapMessages(panel.webview.sent).some((m) => m.error !== undefined)).toBe(true);
    });
    expect(roadmapMessages(panel.webview.sent).at(-1)?.roadmap).toBeUndefined();
    view.dispose();
  });

  it('roadmapを持たない定義では欄を隠す指示だけを送る', async () => {
    const port: RoadmapViewPort = {
      readRoadmap: async () => MARKDOWN,
      listIssues: async () => [ISSUE_7],
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', undefined)]),
      quietLog,
      undefined,
      port,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;

    const messages = roadmapMessages(panel.webview.sent);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.roadmap).toBeUndefined();
    expect(messages[0]?.error).toBeUndefined();
    view.dispose();
  });

  it('遅れて届いた古いrunの照合結果で上書きしない', async () => {
    let releaseFirst: (() => void) | undefined;
    let call = 0;
    const port: RoadmapViewPort = {
      readRoadmap: async (relativePath: string) => {
        call += 1;
        if (call === 1) {
          // 1件目（run-1）の読み取りだけを、run-2への切り替え後まで待たせる
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return `# ${relativePath}\n\n## フェーズ\n\n- [ ] R1 ${relativePath}\n`;
      },
      listIssues: async () => [ISSUE_7],
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md'), snapshot('run-2', 'docs/roadmap/b.md')]),
      quietLog,
      undefined,
      port,
    );
    view.show('run-1');
    const panel = __mock.createdPanels[0]!;
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());

    // run-2へ切り替えてから、止めていたrun-1の読み取りを解放する
    view.show('run-2');
    await vi.waitFor(() => {
      expect(roadmapMessages(panel.webview.sent).some((m) => m.pending === false)).toBe(true);
    });
    releaseFirst!();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const paths = roadmapMessages(panel.webview.sent).map(
      (m) => (m as { path?: string }).path ?? '',
    );
    expect(paths).not.toContain('docs/roadmap/a.md');
    view.dispose();
  });

  it('更新の要求でキャッシュを無視して取り直す', async () => {
    let calls = 0;
    const port: RoadmapViewPort = {
      readRoadmap: async () => MARKDOWN,
      listIssues: async () => {
        calls += 1;
        return [ISSUE_7];
      },
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md')]),
      quietLog,
      undefined,
      port,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;
    await vi.waitFor(() => expect(calls).toBe(1));

    // 同じrunの再描画ではキャッシュを使う（CLIを起こし直さない）
    view.show();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);

    panel.webview.simulateMessage({ type: 'roadmapRefresh' });
    await vi.waitFor(() => expect(calls).toBe(2));
    view.dispose();
  });

  it('更新に失敗しても直前に取れていたIssueの状態を保つ', async () => {
    let succeed = true;
    const port: RoadmapViewPort = {
      readRoadmap: async () => MARKDOWN,
      listIssues: async () => (succeed ? [ISSUE_7] : undefined),
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md')]),
      quietLog,
      undefined,
      port,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;
    await vi.waitFor(() => {
      expect(roadmapMessages(panel.webview.sent).at(-1)?.pending).toBe(false);
    });

    succeed = false;
    const before = roadmapMessages(panel.webview.sent).length;
    panel.webview.simulateMessage({ type: 'roadmapRefresh' });
    await vi.waitFor(() => {
      expect(roadmapMessages(panel.webview.sent).length).toBeGreaterThan(before + 1);
    });
    expect(
      roadmapMessages(panel.webview.sent).at(-1)?.roadmap?.phases[0]?.items[0]?.issueState,
    ).toBe('open');
    view.dispose();
  });

  it('Issueを開く要求はhttpsのURLだけを開く', async () => {
    const port: RoadmapViewPort = {
      readRoadmap: async () => MARKDOWN,
      listIssues: async () => [ISSUE_7, { number: 8, title: 'x', state: 'open', url: 'file:///x' }],
    };
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md')]),
      quietLog,
      undefined,
      port,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;
    await vi.waitFor(() => {
      expect(roadmapMessages(panel.webview.sent).at(-1)?.pending).toBe(false);
    });

    panel.webview.simulateMessage({ type: 'openRoadmapIssue', issue: 8 });
    panel.webview.simulateMessage({ type: 'openRoadmapIssue', issue: 999 });
    panel.webview.simulateMessage({ type: 'openRoadmapIssue', issue: 7 });
    await vi.waitFor(() => expect(__mock.openedExternalUris).toHaveLength(1));
    expect(__mock.openedExternalUris[0]).toBe('https://example.com/issues/7');
    view.dispose();
  });

  it('ポートが未注入なら欄を出さない', () => {
    const view = new WorkflowViewManager(
      fakeRunner([snapshot('run-1', 'docs/roadmap/a.md')]),
      quietLog,
    );
    view.show();
    const panel = __mock.createdPanels[0]!;

    const messages = roadmapMessages(panel.webview.sent);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.roadmap).toBeUndefined();
    view.dispose();
  });
});
