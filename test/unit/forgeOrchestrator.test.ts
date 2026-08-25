import { describe, expect, it } from 'vitest';

import type { ChatState } from '../../src/appserver/chatState';
import { ForgeOrchestrator } from '../../src/forge/orchestrator';
import type { TaskSession, TaskSessionHost } from '../../src/orchestrator/taskSession';

function makeHost(sessionId: string): {
  host: TaskSessionHost;
  sent: string[];
  inputs: Array<{ cwd: string; role?: string; taskId?: string }>;
  emit: (state: ChatState) => void;
} {
  const sent: string[] = [];
  const inputs: Array<{ cwd: string; role?: string; taskId?: string }> = [];
  let listener: ((state: ChatState) => void) | undefined;
  const session = {
    sessionId,
    send: (text: string) => sent.push(text),
    onStateChanged: (next: (state: ChatState) => void) => {
      listener = next;
    },
  } as unknown as TaskSession;
  return {
    host: {
      openTaskSession: async (input) => {
        inputs.push({
          cwd: input.cwd,
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        });
        return session;
      },
    },
    sent,
    inputs,
    emit: (state) => listener?.(state),
  };
}

const baseline = {
  codexSandbox: 'workspace-write',
  codexApprovalMode: 'on-request',
  claudePermissionMode: 'manual',
  allowAutoApprove: false,
  allowClaudeBypassPermissions: false,
} as const;

describe('ForgeOrchestrator', () => {
  it('同じproviderとworkspaceでは1つのheadless会話を再利用する', async () => {
    const codex = makeHost('codex-forge');
    const claude = makeHost('claude-forge');
    const orchestrator = new ForgeOrchestrator(
      { codex: codex.host, claude: claude.host },
      () => baseline,
    );

    await orchestrator.send('codex', '/repo', '最初の依頼');
    await orchestrator.send('codex', '/repo', '次の依頼');

    expect(codex.sent).toEqual(['最初の依頼', '次の依頼']);
    expect(claude.sent).toEqual([]);
  });

  it('Issue作業はHub共通会話を切り替えず、worktreeをcwdにした専用会話を作る', async () => {
    const codex = makeHost('codex-work');
    const claude = makeHost('claude-forge');
    const orchestrator = new ForgeOrchestrator(
      { codex: codex.host, claude: claude.host },
      () => baseline,
    );

    await orchestrator.send('codex', '/repo', 'Hub会話');
    const sessionId = await orchestrator.startWork(
      'codex',
      '/repo/.worktrees/issue-12',
      'issue-12',
      '着手',
    );

    expect(sessionId).toBe('codex-work');
    expect(codex.inputs).toEqual([
      { cwd: '/repo', role: 'orchestrator' },
      { cwd: '/repo/.worktrees/issue-12', role: 'task', taskId: 'issue-12' },
    ]);
    expect(codex.sent).toEqual(['Hub会話', '着手']);
  });

  it('応答と承認要求をHub向けの安全な表示状態へ写す', async () => {
    const codex = makeHost('codex-forge');
    const claude = makeHost('claude-forge');
    const orchestrator = new ForgeOrchestrator(
      { codex: codex.host, claude: claude.host },
      () => baseline,
    );
    await orchestrator.send('codex', '/repo', '状態を送る');
    codex.emit({
      busy: false,
      turnFailed: false,
      items: [{ kind: 'agentMessage', text: '結果', id: '1' }],
      approvals: [{ requestId: 'a1', title: '確認', detail: '対象' }],
    } as unknown as ChatState);

    expect(orchestrator.getSnapshot()).toMatchObject({
      provider: 'codex',
      messages: [{ kind: 'agentMessage', text: '結果' }],
      approvals: [{ requestId: 'a1', title: '確認' }],
    });
  });
});
