import { describe, expect, it } from 'vitest';
import type { WorkflowRunSnapshot } from '../../src/orchestrator/runner';
import { attentionBadge, buildAttentionItems } from '../../src/view/attentionIndex';
import type { ManagedChatSession } from '../../src/view/chatManagerBase';

function chat(
  overrides: Partial<ManagedChatSession> = {},
): ManagedChatSession & { provider: 'codex' } {
  return {
    threadId: 'thread-1',
    title: 'Codex会話',
    cwd: '/workspace',
    activity: 'idle',
    handoffKept: undefined,
    provider: 'codex',
    ...overrides,
  };
}

function snapshot(tasks: readonly { id: string; state: string }[]): WorkflowRunSnapshot {
  return {
    runId: 'run-1',
    name: 'ワークフロー',
    defPath: '/workspace/workflow.yml',
    outcome: 'running',
    startedAt: '2026-09-15T00:00:00.000Z',
    tasks,
    warnings: [],
    haltedByUser: false,
  } as unknown as WorkflowRunSnapshot;
}

describe('buildAttentionItems（Issue#1236）', () => {
  it('承認待ちの会話とワークフローだけを、発生源の識別子付きで返す', () => {
    const items = buildAttentionItems(
      [
        chat({ threadId: 'waiting-chat', activity: 'approvalPending' }),
        chat({ threadId: 'running-chat', activity: 'running' }),
      ],
      [
        snapshot([
          { id: 'approve', state: 'waitingApproval' },
          { id: 'reply', state: 'waitingReply' },
        ]),
      ],
    );

    expect(items).toEqual([
      {
        label: 'Codex会話',
        detail: 'Codex・承認待ち',
        target: { kind: 'chat', provider: 'codex', threadId: 'waiting-chat' },
      },
      {
        label: 'approve',
        detail: 'ワークフロー・承認待ち',
        target: { kind: 'workflow', runId: 'run-1', taskId: 'approve' },
      },
    ]);
  });

  it('表示順を会話とワークフローの安定識別子で固定する', () => {
    const items = buildAttentionItems(
      [
        chat({ threadId: 'z', title: 'Z', activity: 'approvalPending' }),
        chat({ threadId: 'a', title: 'A', activity: 'approvalPending' }),
      ],
      [
        snapshot([
          { id: 'z-task', state: 'waitingApproval' },
          { id: 'a-task', state: 'waitingApproval' },
        ]),
      ],
    );

    expect(items.map((item) => item.target)).toEqual([
      { kind: 'chat', provider: 'codex', threadId: 'a' },
      { kind: 'chat', provider: 'codex', threadId: 'z' },
      { kind: 'workflow', runId: 'run-1', taskId: 'a-task' },
      { kind: 'workflow', runId: 'run-1', taskId: 'z-task' },
    ]);
  });

  it('引き継ぎ元として残った会話を理由付きで出す（Issue#1165）', () => {
    const items = buildAttentionItems([chat({ handoffKept: 'noResponse' })], []);

    expect(items).toEqual([
      {
        label: 'Codex会話',
        detail: 'Codex・引き継ぎ元が残存・引き継ぎ先が無応答',
        target: { kind: 'chat', provider: 'codex', threadId: 'thread-1' },
      },
    ]);
  });

  it('承認待ちと引き継ぎ元の残存は同じ会話でも別々の項目にする（Issue#1165）', () => {
    const items = buildAttentionItems(
      [chat({ activity: 'approvalPending', handoffKept: 'oldBusy' })],
      [],
    );

    expect(items.map((item) => item.detail)).toEqual([
      'Codex・引き継ぎ元が残存・実行中のため閉じず',
      'Codex・承認待ち',
    ]);
  });
});

describe('attentionBadge（Issue#1165）', () => {
  it('承認待ち以外も数えるため「要対応」と名乗る', () => {
    expect(attentionBadge(3)).toEqual({ value: 3, tooltip: '要対応 3件' });
  });

  it('0件以下ではバッジを付けない', () => {
    expect(attentionBadge(0)).toBeUndefined();
    expect(attentionBadge(-1)).toBeUndefined();
  });
});
