import { describe, expect, it } from 'vitest';
import { isSandboxRelaxed, sandboxPolicyFor } from '../../src/codex/sandboxPolicy';

describe('sandboxPolicyFor', () => {
  it('設定が空なら何も返さない（CLI側の設定へ委ねる）', () => {
    expect(sandboxPolicyFor('')).toBeUndefined();
  });

  it('読み取り専用', () => {
    expect(sandboxPolicyFor('read-only')).toEqual({ type: 'readOnly' });
  });

  it('作業フォルダへの書き込み', () => {
    // 既定は writableRoots: [] / networkAccess: false（thread/start の実効値と同じ形）
    expect(sandboxPolicyFor('workspace-write')).toEqual({ type: 'workspaceWrite' });
  });

  it('全許可', () => {
    expect(sandboxPolicyFor('danger-full-access')).toEqual({ type: 'dangerFullAccess' });
  });

  it('知らない値は何も返さない', () => {
    expect(sandboxPolicyFor('yolo')).toBeUndefined();
  });

  it('書き込みを許す範囲とネットワークを指定できる', () => {
    expect(
      sandboxPolicyFor('workspace-write', { writableRoots: ['/tmp/work'], networkAccess: true }),
    ).toEqual({ type: 'workspaceWrite', writableRoots: ['/tmp/work'], networkAccess: true });
  });

  it('絶対パスでない書き込み先は捨てる', () => {
    expect(
      sandboxPolicyFor('workspace-write', { writableRoots: ['rel/dir', ''], networkAccess: false }),
    ).toEqual({ type: 'workspaceWrite' });
  });

  it('読み取り専用と全許可では書き込み範囲を渡さない', () => {
    const options = { writableRoots: ['/tmp/work'], networkAccess: true };
    expect(sandboxPolicyFor('read-only', options)).toEqual({ type: 'readOnly' });
    expect(sandboxPolicyFor('danger-full-access', options)).toEqual({ type: 'dangerFullAccess' });
  });
});

describe('isSandboxRelaxed', () => {
  it('権限が広がる向きだけ true', () => {
    expect(isSandboxRelaxed('read-only', 'workspace-write')).toBe(true);
    expect(isSandboxRelaxed('read-only', 'danger-full-access')).toBe(true);
    expect(isSandboxRelaxed('workspace-write', 'danger-full-access')).toBe(true);
  });

  it('狭める向きと据え置きは false', () => {
    expect(isSandboxRelaxed('danger-full-access', 'read-only')).toBe(false);
    expect(isSandboxRelaxed('workspace-write', 'workspace-write')).toBe(false);
  });

  it('いまの値が判らないときは読み取り専用以外を確認対象にする', () => {
    // 空文字は config.toml へ委譲した状態。何が効いているか画面からは判らない
    expect(isSandboxRelaxed('', 'read-only')).toBe(false);
    expect(isSandboxRelaxed('', 'workspace-write')).toBe(true);
    expect(isSandboxRelaxed('', 'danger-full-access')).toBe(true);
  });

  it('委譲へ戻すのは確認しない', () => {
    expect(isSandboxRelaxed('danger-full-access', '')).toBe(false);
    expect(isSandboxRelaxed('read-only', '')).toBe(false);
  });
});
