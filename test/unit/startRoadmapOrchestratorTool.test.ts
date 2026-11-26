import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  parseStartRoadmapOrchestratorToolArgs,
  START_ROADMAP_ORCHESTRATOR_TOOL,
} from '../../src/orchestrator/messaging';
import { startRoadmapOrchestratorFromTool } from '../../src/view/startRoadmapOrchestratorTool';

/** Issue #2193: `start_roadmap_orchestrator`のgoal。 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseStartRoadmapOrchestratorToolArgs', () => {
  it('goalは任意で、渡せば均して出所を付ける', () => {
    expect(parseStartRoadmapOrchestratorToolArgs({ reason: '実装へ進む' })).toEqual({
      ok: true,
      value: { roadmapIssueNumber: undefined, reason: '実装へ進む', goal: undefined },
    });
    expect(
      parseStartRoadmapOrchestratorToolArgs({
        reason: 'r',
        goal: { objective: '目的', completionCriteria: '条件' },
      }),
    ).toMatchObject({
      ok: true,
      value: { goal: { objective: '目的', completionCriteria: '条件', source: 'start' } },
    });
    expect(
      parseStartRoadmapOrchestratorToolArgs({ reason: 'r', goal: { objective: '目的' } }).ok,
    ).toBe(false);
  });

  it('ツールの説明に完了条件の書き方を載せる', () => {
    expect(START_ROADMAP_ORCHESTRATOR_TOOL.description).toContain('タスクの消化を完了条件にしない');
  });
});

describe('startRoadmapOrchestratorFromTool', () => {
  function host() {
    return {
      engine: 'codex' as const,
      folder: () => '/ws',
      note: vi.fn(),
      log: vi.fn(),
    };
  }

  it('goalと起動の理由をコマンドへ渡し、記録されたら会話へ目的を残す', async () => {
    const exec = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockResolvedValue({ accepted: true, reason: 'ok', runId: 'r1', goalApplied: true } as never);
    const h = host();
    const goal = { objective: '目的', completionCriteria: '条件', source: 'start' as const };
    await startRoadmapOrchestratorFromTool(h, {
      roadmapIssueNumber: 7,
      reason: '利用者の依頼',
      goal,
    });
    expect(exec).toHaveBeenCalledWith('agent.taskRun.startRoadmapFromChat', {
      folder: '/ws',
      engine: 'codex',
      issueNumber: 7,
      goal: { objective: '目的', completionCriteria: '条件' },
      reason: '利用者の依頼',
    });
    expect(h.note).toHaveBeenCalledWith(expect.stringContaining('目的: 目的 / 完了条件: 条件'));
  });

  it('goalを渡さなければコマンドへも渡さず、会話にも目的を出さない', async () => {
    const exec = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockResolvedValue({ accepted: true, reason: 'ok', runId: 'r1' } as never);
    const h = host();
    await startRoadmapOrchestratorFromTool(h, {
      roadmapIssueNumber: undefined,
      reason: 'r',
      goal: undefined,
    });
    expect(exec).toHaveBeenCalledWith('agent.taskRun.startRoadmapFromChat', {
      folder: '/ws',
      engine: 'codex',
    });
    expect(h.note).toHaveBeenCalledWith(expect.not.stringContaining('目的:'));
  });
});
