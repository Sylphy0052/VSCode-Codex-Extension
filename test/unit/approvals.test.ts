import { describe, expect, it } from 'vitest';
import {
  APPROVAL_METHODS,
  buildApprovalResponse,
  defaultDenyResponse,
  describeApproval,
  SERVER_REQUEST_METHODS,
} from '../../src/appserver/approvals';

describe('describeApproval', () => {
  it('コマンド実行の要求をコマンドとcwd付きで表す', () => {
    const approval = describeApproval(1, APPROVAL_METHODS.command, {
      command: 'rm -rf build',
      cwd: '/work',
    });
    expect(approval).toMatchObject({ requestId: 1, kind: 'command' });
    expect(approval?.detail).toContain('rm -rf build');
    expect(approval?.detail).toContain('/work');
  });

  it('ファイル変更の要求で対象パスを並べる', () => {
    const approval = describeApproval(2, APPROVAL_METHODS.fileChange, {
      changes: [{ path: '/a.ts' }, { path: '/b.ts' }],
    });
    expect(approval?.kind).toBe('fileChange');
    expect(approval?.detail).toBe('/a.ts\n/b.ts');
  });

  it('権限昇格の要求を理由付きで表す', () => {
    const approval = describeApproval(3, APPROVAL_METHODS.permissions, { reason: 'ネットワーク' });
    expect(approval).toMatchObject({ kind: 'permissions', detail: 'ネットワーク' });
  });

  it('知らない要求はundefined（勝手に許可しないため）', () => {
    expect(describeApproval(4, 'item/tool/call', {})).toBeUndefined();
  });
});

describe('buildApprovalResponse', () => {
  it('コマンドとファイル変更はdecisionをそのまま返す', () => {
    expect(buildApprovalResponse('command', 'accept', {})).toEqual({ decision: 'accept' });
    expect(buildApprovalResponse('fileChange', 'decline', {})).toEqual({ decision: 'decline' });
    expect(buildApprovalResponse('command', 'acceptForSession', {})).toEqual({
      decision: 'acceptForSession',
    });
  });

  it('権限要求は形が異なり、許可時のみ要求された権限を与える', () => {
    const params = { permissions: { network: true } };
    expect(buildApprovalResponse('permissions', 'accept', params)).toEqual({
      permissions: { network: true },
      scope: 'turn',
    });
    expect(buildApprovalResponse('permissions', 'acceptForSession', params)).toEqual({
      permissions: { network: true },
      scope: 'session',
    });
  });

  it('権限要求を拒否したら権限を与えない', () => {
    expect(
      buildApprovalResponse('permissions', 'decline', { permissions: { network: true } }),
    ).toEqual({ permissions: {}, scope: 'turn' });
  });
});

describe('defaultDenyResponse', () => {
  it('ユーザーに聞けない場合は拒否側に倒す', () => {
    expect(defaultDenyResponse(APPROVAL_METHODS.command, {})).toEqual({ decision: 'decline' });
    expect(defaultDenyResponse(APPROVAL_METHODS.permissions, {})).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });
});

describe('旧形式の承認要求', () => {
  it('applyPatchApproval を変更内容付きの承認カードにする', () => {
    const approval = describeApproval(10, APPROVAL_METHODS.applyPatch, {
      callId: 'c1',
      conversationId: 't1',
      fileChanges: { '/a.ts': { type: 'update' }, '/b.ts': { type: 'add' } },
      reason: 'パッチの適用',
    });
    expect(approval).toMatchObject({ requestId: 10, kind: 'applyPatch' });
    expect(approval?.detail).toContain('/a.ts');
    expect(approval?.detail).toContain('/b.ts');
  });

  it('execCommandApproval を配列のコマンドから組み立てる', () => {
    const approval = describeApproval(11, APPROVAL_METHODS.execCommand, {
      callId: 'c2',
      conversationId: 't1',
      command: ['rm', '-rf', 'build'],
      cwd: '/work',
      parsedCmd: [],
    });
    expect(approval).toMatchObject({ requestId: 11, kind: 'execCommand' });
    expect(approval?.detail).toContain('rm -rf build');
    expect(approval?.detail).toContain('/work');
  });

  it('旧形式はReviewDecisionの語彙で応答する', () => {
    expect(buildApprovalResponse('applyPatch', 'accept', {})).toEqual({ decision: 'approved' });
    expect(buildApprovalResponse('execCommand', 'acceptForSession', {})).toEqual({
      decision: 'approved_for_session',
    });
    expect(buildApprovalResponse('execCommand', 'cancel', {})).toEqual({ decision: 'abort' });

    const declined = buildApprovalResponse('applyPatch', 'decline', {}) as {
      decision: { denied: { rejection: string } };
    };
    expect(declined.decision.denied.rejection).not.toBe('');
  });
});

describe('app-serverが投げうる要求すべてに形の合う応答を返す', () => {
  it('旧形式の承認は denied を返す', () => {
    for (const method of [APPROVAL_METHODS.applyPatch, APPROVAL_METHODS.execCommand]) {
      const response = defaultDenyResponse(method, {}) as {
        decision: { denied: { rejection: string } };
      };
      expect(response.decision.denied.rejection).not.toBe('');
    }
  });

  it('ツールからの問い合わせは質問idごとに空の回答を返す', () => {
    const response = defaultDenyResponse(SERVER_REQUEST_METHODS.requestUserInput, {
      itemId: 'i1',
      isBlocking: true,
      questions: [
        { id: 'q1', header: 'h', question: '？' },
        { id: 'q2', header: 'h', question: '？' },
      ],
    });
    expect(response).toEqual({ answers: { q1: { answers: [] }, q2: { answers: [] } } });
  });

  it('質問が無くても answers を持つ形で返す', () => {
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.requestUserInput, {})).toEqual({
      answers: {},
    });
  });

  it('MCPのelicitationは action で拒否する', () => {
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.elicitation, {})).toEqual({
      action: 'decline',
    });
  });

  it('拡張が実行できないツール呼び出しは失敗として返す', () => {
    const response = defaultDenyResponse(SERVER_REQUEST_METHODS.toolCall, {
      tool: 'something',
    }) as {
      success: boolean;
      contentItems: { type: string; text: string }[];
    };
    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.type).toBe('inputText');
    expect(response.contentItems[0]?.text).not.toBe('');
  });

  it('値を作れない要求は応答せず undefined を返す（呼び出し側がエラーで解放する）', () => {
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.attestation, {})).toBeUndefined();
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.authTokensRefresh, {})).toBeUndefined();
    expect(defaultDenyResponse('まったく知らない要求', {})).toBeUndefined();
  });

  it('ServerRequestの10種を網羅している', () => {
    // codex app-server generate-json-schema の ServerRequest より
    const all = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'applyPatchApproval',
      'execCommandApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/tool/call',
      'attestation/generate',
      'account/chatgptAuthTokens/refresh',
    ];
    expect(new Set(Object.values(SERVER_REQUEST_METHODS))).toEqual(new Set(all));
  });
});
