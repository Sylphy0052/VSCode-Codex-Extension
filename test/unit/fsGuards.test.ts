import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertValidIdentifiers,
  findSymlinkedAncestor,
  identifierError,
  RUN_ID_PATTERN,
  runIdError,
  type SymlinkCheckPort,
} from '../../src/orchestrator/fsGuards';

/** `runId`はUUID形式で検証されるため、テスト全体で1つの妥当なUUIDを使い回す。 */
const RUN_ID = '11111111-1111-4111-8111-111111111111';

/**
 * `isSymbolicLink`だけを実装するフェイク。`WorktreeFileSystemPort` /
 * `PseudoWorktreeFileSystemPort` のどちらも、この最小限の`SymlinkCheckPort`を
 * 構造的に満たすことを確かめるのが目的の1つ（Issue #146の統合前は、`worktree.ts` /
 * `integration.ts` / `pseudoWorktree.ts` の3箇所へそれぞれ別の型で複製されていた）。
 */
class FakeSymlinkPort implements SymlinkCheckPort {
  private readonly symlinks: Set<string>;

  constructor(symlinks: readonly string[]) {
    this.symlinks = new Set(symlinks);
  }

  async isSymbolicLink(target: string): Promise<boolean> {
    return this.symlinks.has(target);
  }
}

describe('RUN_ID_PATTERN / runIdError / identifierError', () => {
  it('妥当なUUID形式のrunIdはエラーなし', () => {
    expect(RUN_ID_PATTERN.test(RUN_ID)).toBe(true);
    expect(runIdError(RUN_ID)).toBeUndefined();
  });

  it('UUID形式でないrunIdはエラーメッセージを返す', () => {
    const message = runIdError('not-a-uuid');
    expect(message).toBeDefined();
    expect(message).toContain('不正なrunId');
    expect(message).toContain('not-a-uuid');
  });

  it('大文字混じりのUUIDも許容する（16進数の大文字小文字を区別しない）', () => {
    const upper = '11111111-1111-4111-8111-11111111111A';
    expect(runIdError(upper)).toBeUndefined();
  });

  it('妥当なrunId・taskIdの組はエラーなし', () => {
    expect(identifierError(RUN_ID, 'T1')).toBeUndefined();
  });

  it('runIdが不正なら、taskIdを見るまでもなくrunIdのエラーを返す', () => {
    const message = identifierError('bad', '-leading-hyphen');
    expect(message).toContain('不正なrunId');
  });

  it('runIdが妥当でもtaskIdの字種が不正ならエラーを返す（先頭ハイフンは引数インジェクション対策で拒否）', () => {
    const message = identifierError(RUN_ID, '-leading-hyphen');
    expect(message).toBeDefined();
    expect(message).toContain('不正なtaskId');
  });

  it('taskIdが空文字だとエラーになる', () => {
    expect(identifierError(RUN_ID, '')).toContain('不正なtaskId');
  });

  it('taskIdが51文字以上（上限50文字を超える）だとエラーになる', () => {
    const tooLong = 'a'.repeat(51);
    expect(identifierError(RUN_ID, tooLong)).toContain('不正なtaskId');
  });

  it('taskIdがちょうど50文字ならエラーにならない', () => {
    const exact = 'a'.repeat(50);
    expect(identifierError(RUN_ID, exact)).toBeUndefined();
  });
});

describe('assertValidIdentifiers', () => {
  it('妥当な組では例外を投げない', () => {
    expect(() => assertValidIdentifiers(RUN_ID, 'T1')).not.toThrow();
  });

  it('不正な組では identifierError と同じメッセージで例外を投げる', () => {
    expect(() => assertValidIdentifiers('bad-run-id', 'T1')).toThrow('不正なrunId');
    expect(() => assertValidIdentifiers(RUN_ID, '-bad')).toThrow('不正なtaskId');
  });
});

describe('findSymlinkedAncestor', () => {
  const root = '/repo';

  it('祖先にシンボリックリンクが無ければundefinedを返す', async () => {
    const fs = new FakeSymlinkPort([]);
    const target = path.join(root, '.agents', 'worktrees', 'run', 'T1');
    await expect(findSymlinkedAncestor(root, target, fs)).resolves.toBeUndefined();
  });

  it('中間ディレクトリ（.agents/worktrees）がシンボリックリンクなら、そのパスを返す', async () => {
    const linkedDir = path.join(root, '.agents', 'worktrees');
    const fs = new FakeSymlinkPort([linkedDir]);
    const target = path.join(linkedDir, 'run', 'T1');
    await expect(findSymlinkedAncestor(root, target, fs)).resolves.toBe(linkedDir);
  });

  it('祖先の複数セグメントのうち、rootに近い方を最初に見つけて返す（浅い順に走査する）', async () => {
    const agentsDir = path.join(root, '.agents');
    const worktreesDir = path.join(agentsDir, 'worktrees');
    // 両方がリンクでも、rootに近い`.agents`が先に見つかる
    const fs = new FakeSymlinkPort([agentsDir, worktreesDir]);
    const target = path.join(worktreesDir, 'run', 'T1');
    await expect(findSymlinkedAncestor(root, target, fs)).resolves.toBe(agentsDir);
  });

  it('target自身（まだ存在しない前提の末端セグメント）がリンクとして登録されていても、末端は無害に扱う', async () => {
    // targetそのもの（作成前提のディレクトリ）は判定対象に含まれる実装だが、
    // 存在しない前提であれば`isSymbolicLink`はfalseを返すだけで安全（フェイクでは未登録=false）
    const fs = new FakeSymlinkPort([]);
    const target = path.join(root, '.agents', 'worktrees', 'run', 'T1');
    await expect(findSymlinkedAncestor(root, target, fs)).resolves.toBeUndefined();
  });

  it('root自身が祖先セグメントの走査対象に含まれない（rootから見て相対的な祖先だけを見る）', async () => {
    // rootそのものがリンクとして登録されていても、rel計算の対象にならないため無関係
    const fs = new FakeSymlinkPort([root]);
    const target = path.join(root, 'plain', 'path');
    await expect(findSymlinkedAncestor(root, target, fs)).resolves.toBeUndefined();
  });
});
