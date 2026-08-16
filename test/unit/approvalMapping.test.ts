import { describe, expect, it } from 'vitest';
import { buildEscalationRequest } from '../../src/orchestrator/approvalMapping';
import type { ChatItem, PendingApproval } from '../../src/appserver/chatState';
import type { WorktreeFileSystemPort } from '../../src/orchestrator/worktree';

/** 実パス解決の代わりに、そのままの文字列を返すフェイク（境界チェックの対象にするだけなら十分）。 */
const identityFs: WorktreeFileSystemPort = {
  realpath: async (target) => target,
  readTextFile: async () => undefined,
  isSymbolicLink: async () => false,
  pathExists: async () => true,
};

function commandApproval(itemId?: string): PendingApproval {
  return { requestId: 1, kind: 'command', title: '', detail: '', itemId };
}
function fileChangeApproval(itemId: string | undefined): PendingApproval {
  return { requestId: 1, kind: 'fileChange', title: '', detail: '', itemId };
}
function permissionsApproval(): PendingApproval {
  return { requestId: 1, kind: 'permissions', title: '', detail: '', itemId: undefined };
}

describe('buildEscalationRequest（design.md §16.7: 判定へは生の要求パラメータを渡す）', () => {
  it('Codexのcommand要求は command/cwd をそのまま読む', async () => {
    const request = await buildEscalationRequest(
      'codex',
      commandApproval(),
      { command: 'ls -la', cwd: '/repo/task' },
      '/repo/task',
      [],
      identityFs,
    );
    expect(request).toMatchObject({ kind: 'command', command: 'ls -la', cwd: '/repo/task' });
  });

  it('Codexのfile Change要求は itemId からChatState.itemsの差分パスを解決する（変更対象パスを持たないため）', async () => {
    const items: ChatItem[] = [
      {
        id: 'item-1',
        kind: 'fileChange',
        text: '',
        detail: '',
        status: undefined,
        turnId: undefined,
        diffs: [
          {
            path: '/repo/task/a.ts',
            kind: 'update',
            movePath: undefined,
            diff: '',
            editReplace: undefined,
          },
          {
            path: '/repo/task/b.ts',
            kind: 'add',
            movePath: undefined,
            diff: '',
            editReplace: undefined,
          },
        ],
      },
    ];
    const request = await buildEscalationRequest(
      'codex',
      fileChangeApproval('item-1'),
      { itemId: 'item-1', reason: '' },
      '/repo/task',
      items,
      identityFs,
    );
    expect(request.kind).toBe('fileChange');
    expect(request.paths).toEqual(['/repo/task/a.ts', '/repo/task/b.ts']);
  });

  it('itemIdに対応する項目が無ければpathsは空になる（判定関数側でaskへ倒れる想定）', async () => {
    const request = await buildEscalationRequest(
      'codex',
      fileChangeApproval('missing'),
      { itemId: 'missing' },
      '/repo/task',
      [],
      identityFs,
    );
    expect(request.paths).toEqual([]);
  });

  it('Codexのgrant Root / networkApprovalContext / execpolicyの構造化フィールドを読む', async () => {
    const request = await buildEscalationRequest(
      'codex',
      commandApproval(),
      {
        command: 'curl https://example.com',
        cwd: '/repo/task',
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
        proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'example.com' }],
        proposedExecpolicyAmendment: ['curl'],
      },
      '/repo/task',
      [],
      identityFs,
    );
    expect(request.networkApprovalContext).toEqual({ host: 'example.com', protocol: 'https' });
    expect(request.proposedNetworkPolicyAmendments).toEqual([
      { action: 'allow', host: 'example.com' },
    ]);
    expect(request.proposedExecpolicyAmendment).toEqual(['curl']);
  });

  it('Codexのpermissions要求はkind: permissionsになる', async () => {
    const request = await buildEscalationRequest(
      'codex',
      permissionsApproval(),
      { reason: 'x' },
      '/repo/task',
      [],
      identityFs,
    );
    expect(request.kind).toBe('permissions');
  });

  it('Claudeのcommand要求（Bash）はtool_name/inputから読み、cwdはタスクのcwdを使う', async () => {
    const request = await buildEscalationRequest(
      'claude',
      commandApproval(),
      { tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
      '/repo/task',
      [],
      identityFs,
    );
    expect(request).toMatchObject({
      kind: 'command',
      command: 'rm -rf /tmp/x',
      cwd: '/repo/task',
    });
  });

  it('ClaudeのEdit要求はinput.file_pathを変更対象パスとして使う（itemIdの参照は不要）', async () => {
    const request = await buildEscalationRequest(
      'claude',
      fileChangeApproval(undefined),
      {
        tool_name: 'Edit',
        input: { file_path: '/repo/task/a.ts', old_string: 'x', new_string: 'y' },
      },
      '/repo/task',
      [],
      identityFs,
    );
    expect(request.kind).toBe('fileChange');
    expect(request.paths).toEqual(['/repo/task/a.ts']);
  });

  it('ClaudeのNotebookEdit要求はinput.notebook_pathを使う', async () => {
    const request = await buildEscalationRequest(
      'claude',
      fileChangeApproval(undefined),
      { tool_name: 'NotebookEdit', input: { notebook_path: '/repo/task/n.ipynb' } },
      '/repo/task',
      [],
      identityFs,
    );
    expect(request.paths).toEqual(['/repo/task/n.ipynb']);
  });

  it('旧形式（applyPatch/execCommand相当）はkind: unknownとして安全側に倒す', async () => {
    const legacy: PendingApproval = {
      requestId: 1,
      kind: 'applyPatch',
      title: '',
      detail: '',
      itemId: undefined,
    };
    const request = await buildEscalationRequest('codex', legacy, {}, '/repo/task', [], identityFs);
    expect(request.kind).toBe('unknown');
  });

  it('パスは実パス解決を通す', async () => {
    const resolvingFs: WorktreeFileSystemPort = {
      realpath: async (target) => `/resolved${target}`,
      readTextFile: async () => undefined,
      isSymbolicLink: async () => false,
      pathExists: async () => true,
    };
    const request = await buildEscalationRequest(
      'claude',
      commandApproval(),
      { tool_name: 'Bash', input: { command: 'ls' } },
      '/repo/task',
      [],
      resolvingFs,
    );
    expect(request.cwd).toBe('/resolved/repo/task');
  });
});
