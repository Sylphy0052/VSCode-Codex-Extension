import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoadmapRunStartDeps } from '../../src/view/taskRunRoadmapStart';

/**
 * `startRoadmapRunFromChat`（Issue #2070）の分岐。外部のforge・CLIは差し替え、
 * 返す`accepted`と`reason`、Controllerへ渡す値を確かめる。
 */

const h = vi.hoisted(() => ({
  detect: vi.fn(),
  importRoadmap: vi.fn(),
  listIssues: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  readWorkflowsConfig: () => ({ roadmapIssueLabel: 'roadmap' }),
}));
vi.mock('../../src/orchestrator/roadmapRunForge', () => ({
  detectRoadmapForgeHost: h.detect,
}));
vi.mock('../../src/orchestrator/roadmapImport', () => ({
  importRoadmap: h.importRoadmap,
}));
vi.mock('../../src/orchestrator/roadmap', () => ({
  createCliIssueListPort: () => ({ listIssues: h.listIssues }),
}));

import { startRoadmapRunFromChat } from '../../src/view/taskRunRoadmapStart';

function makeDeps(overrides: Record<string, unknown> = {}) {
  const controller = {
    findRoadmapRun: vi.fn(() => undefined as { runId: string; suspendedAt?: number } | undefined),
    startRoadmapRun: vi.fn(async () => ({ ok: true, runId: 'r1', reused: false })),
    syncRoadmap: vi.fn(async () => ({ ok: true })),
    setGoal: vi.fn(async () => ({ ok: true, message: 'ok' })),
    ...overrides,
  };
  const deps = {
    controller,
    git: vi.fn(),
    cli: vi.fn(),
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    askSettings: vi.fn(),
    resumeRun: vi.fn(async () => ({ ok: true })),
    showRun: vi.fn(),
  };
  return { deps: deps as unknown as RoadmapRunStartDeps, controller, raw: deps };
}

const input = { folder: '/w', engine: 'codex' as const, issueNumber: undefined, maxParallel: 2 };

const validImport = {
  kind: 'imported',
  body: '',
  children: [],
  plan: { kind: 'valid', nodes: [], content: ['x'] },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.detect.mockResolvedValue('github');
  h.importRoadmap.mockResolvedValue(validImport);
  h.listIssues.mockResolvedValue([{ number: 7, title: 'RM', labels: ['Roadmap'] }]);
});

describe('startRoadmapRunFromChat', () => {
  it('originがforgeでなければ拒否する', async () => {
    h.detect.mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r.accepted).toBe(false);
  });

  it('ラベル付きが1本ならそれで始める', async () => {
    const { deps, controller, raw } = makeDeps();
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r).toMatchObject({ accepted: true, runId: 'r1', reused: false });
    expect(controller.startRoadmapRun).toHaveBeenCalledWith(
      expect.objectContaining({ roadmapIssueNumber: 7, maxParallel: 2, engine: 'codex' }),
    );
    expect(raw.showRun).toHaveBeenCalledWith('r1');
  });

  it('計画区画が不正でも子Issueの並びで始める', async () => {
    h.importRoadmap.mockResolvedValue({ ...validImport, plan: { kind: 'invalid', errors: ['e'] } });
    const { deps, controller } = makeDeps();
    await startRoadmapRunFromChat(deps, input);
    expect(controller.startRoadmapRun).toHaveBeenCalledWith(
      expect.objectContaining({ planNodes: undefined, planSectionHash: undefined }),
    );
  });

  it('一覧が取れず番号も無ければ拒否する', async () => {
    h.listIssues.mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain('一覧を取得できません');
  });

  it('候補が0本なら拒否する', async () => {
    h.listIssues.mockResolvedValue([{ number: 1, title: 't', labels: ['bug'] }]);
    const { deps } = makeDeps();
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r.reason).toContain('見つかりません');
  });

  it('候補が複数なら番号の指定を求める', async () => {
    h.listIssues.mockResolvedValue([
      { number: 1, title: 'a', labels: ['roadmap'] },
      { number: 2, title: 'b', labels: ['roadmap'] },
    ]);
    const { deps } = makeDeps();
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain('2本');
    expect(r.reason).toContain('#1 a');
  });

  it('番号指定なら一覧に無くても始める', async () => {
    h.listIssues.mockResolvedValue(undefined);
    const { deps, controller } = makeDeps();
    const r = await startRoadmapRunFromChat(deps, { ...input, issueNumber: 9 });
    expect(r.accepted).toBe(true);
    expect(controller.startRoadmapRun).toHaveBeenCalledWith(
      expect.objectContaining({ roadmapIssueNumber: 9, roadmapTitle: 'ロードマップIssue #9' }),
    );
  });

  it('読み込み失敗は拒否する', async () => {
    h.importRoadmap.mockResolvedValue({ kind: 'failed', message: 'boom' });
    const { deps } = makeDeps();
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r).toMatchObject({ accepted: false, reason: 'boom' });
  });

  it('run作成失敗は警告して拒否する', async () => {
    const { deps, raw } = makeDeps({
      startRoadmapRun: vi.fn(async () => ({ ok: false, message: 'ng' })),
    });
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r).toMatchObject({ accepted: false, reason: 'ng' });
    expect(raw.log.warn).toHaveBeenCalled();
  });

  it('既存runがあれば読み直させる', async () => {
    const { deps, controller, raw } = makeDeps({
      findRoadmapRun: vi.fn(() => ({ runId: 'old' })),
    });
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r).toMatchObject({ accepted: true, runId: 'old', reused: true });
    expect(controller.syncRoadmap).toHaveBeenCalledWith('old');
    expect(raw.resumeRun).not.toHaveBeenCalled();
  });

  it('中断中の既存runは再開してから読み直す', async () => {
    const { deps, raw } = makeDeps({
      findRoadmapRun: vi.fn(() => ({ runId: 'old', suspendedAt: 1 })),
    });
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r.accepted).toBe(true);
    expect(raw.resumeRun).toHaveBeenCalledWith('old');
    expect(r.reason).toContain('再開し');
  });

  it('再開に失敗したら拒否する', async () => {
    const { deps, raw } = makeDeps({
      findRoadmapRun: vi.fn(() => ({ runId: 'old', suspendedAt: 1 })),
    });
    raw.resumeRun.mockResolvedValue({ ok: false, message: 'no' } as never);
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r).toMatchObject({ accepted: false, runId: 'old' });
  });

  it('読み直しに失敗しても既存runを示して拒否する', async () => {
    const { deps } = makeDeps({
      findRoadmapRun: vi.fn(() => ({ runId: 'old' })),
      syncRoadmap: vi.fn(async () => ({ ok: false, message: 'sync' })),
    });
    const r = await startRoadmapRunFromChat(deps, input);
    expect(r).toMatchObject({ accepted: false, reused: true, runId: 'old' });
    expect(r.reason).toContain('sync');
  });

  describe('runの目的（Issue #2193）', () => {
    const goal = {
      objective: '起動が速くなる',
      completionCriteria: '起動が1秒以内',
      source: 'start' as const,
    };

    it('渡したgoalをrunの作成へ渡す', async () => {
      h.importRoadmap.mockResolvedValue({
        ...validImport,
        body: '## 目的\n本文の目的\n## 完了条件\n本文の条件',
      });
      const { deps, controller } = makeDeps();
      const r = await startRoadmapRunFromChat(deps, { ...input, goal });
      expect(r).toMatchObject({ accepted: true, goalApplied: true });
      expect(controller.startRoadmapRun).toHaveBeenCalledWith(expect.objectContaining({ goal }));
    });

    it('goalを渡さなければロードマップ本文の節から取る', async () => {
      h.importRoadmap.mockResolvedValue({
        ...validImport,
        body: '# RM\n## 目的\n- 本文の目的\n## 完了条件\n- 本文の条件\n## 子Issue\n- [ ] #1',
      });
      const { deps, controller } = makeDeps();
      const r = await startRoadmapRunFromChat(deps, input);
      expect(r.goalApplied).toBeUndefined();
      expect(controller.startRoadmapRun).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: { objective: '本文の目的', completionCriteria: '本文の条件', source: 'roadmap' },
        }),
      );
    });

    it('goalも本文の節も無ければgoalを置かない（固定文を入れない）', async () => {
      h.importRoadmap.mockResolvedValue({ ...validImport, body: '# RM\n- [ ] #1 子' });
      const { deps, controller } = makeDeps();
      await startRoadmapRunFromChat(deps, input);
      expect(controller.startRoadmapRun).toHaveBeenCalledWith(
        expect.objectContaining({ goal: undefined }),
      );
    });

    it('既存runへgoalを渡すと、起動の理由を添えて目的を直す', async () => {
      const { deps, controller } = makeDeps({
        findRoadmapRun: vi.fn(() => ({ runId: 'old' })),
      });
      const r = await startRoadmapRunFromChat(deps, { ...input, goal, goalReason: '利用者の依頼' });
      expect(r).toMatchObject({ accepted: true, runId: 'old', reused: true, goalApplied: true });
      expect(controller.setGoal).toHaveBeenCalledWith(
        'old',
        goal,
        expect.stringContaining('利用者の依頼'),
      );
    });

    it('既存runの目的を直せなければ理由へ添え、runの扱いは変えない', async () => {
      const { deps } = makeDeps({
        findRoadmapRun: vi.fn(() => ({ runId: 'old' })),
        setGoal: vi.fn(async () => ({ ok: false, message: '専有権なし' })),
      });
      const r = await startRoadmapRunFromChat(deps, { ...input, goal });
      expect(r).toMatchObject({ accepted: true, goalApplied: false });
      expect(r.reason).toContain('専有権なし');
    });
  });
});
