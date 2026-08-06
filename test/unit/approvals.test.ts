import { describe, expect, it } from 'vitest';
import {
  APPROVAL_METHODS,
  buildApprovalResponse,
  defaultDenyResponse,
  describeApproval,
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
    expect(defaultDenyResponse(APPROVAL_METHODS.command)).toEqual({ decision: 'decline' });
    expect(defaultDenyResponse(APPROVAL_METHODS.permissions)).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });
});
