import { describe, expect, it } from 'vitest';

import type { ChatState } from '../../src/appserver/chatState';
import { ForgeOrchestrator } from '../../src/forge/orchestrator';
import type { TaskSession, TaskSessionHost } from '../../src/orchestrator/taskSession';

function makeHost(sessionId: string): {
  host: TaskSessionHost;
  sent: string[];
  emit: (state: ChatState) => void;
} {
  const sent: string[] = [];
  let listener: ((state: ChatState) => void) | undefined;
  const session = {
    sessionId,
    send: (text: string) => sent.push(text),
    onStateChanged: (next: (state: ChatState) => void) => {
      listener = next;
    },
  } as unknown as TaskSession;
  return {
    host: { openTaskSession: async () => session },
    sent,
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
