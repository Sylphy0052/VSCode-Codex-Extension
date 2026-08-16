import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDiffToIntegration,
  cloneWorkspace,
  DEFAULT_PSEUDO_WORKTREE_EXCLUDE,
  deserializeManifest,
  diffSnapshots,
  ensureIntegrationDir,
  integrationPath,
  IntegrationQueue,
  isExcludedPath,
  nodePseudoWorktreeFileSystem,
  planIntegration,
  pseudoWorktreePath,
  pseudoWorktreesRootDir,
  reflectIntegrationToWorkspace,
  removePseudoWorktree,
  serializeManifest,
  takeSnapshot,
  type DiffEntry,
  type IntegrationManifest,
  type Snapshot,
} from '../../src/orchestrator/pseudoWorktree';

/** `runId` はUUID形式で検証されるため、テスト全体で1つの妥当なUUIDを使い回す。 */
const RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('pseudoWorktreesRootDir / pseudoWorktreePath / integrationPath', () => {
  it('置き場はgitの場合と同じ<workspace>/.agents/worktrees/<runId>/<taskId>になる', () => {
    expect(pseudoWorktreePath('/ws', RUN_ID, 'T2')).toBe(
      path.join('/ws', '.agents', 'worktrees', RUN_ID, 'T2'),
    );
  });

  it('統合先は<runId>/_integrationになる', () => {
    expect(integrationPath('/ws', RUN_ID)).toBe(
      path.join('/ws', '.agents', 'worktrees', RUN_ID, '_integration'),
    );
  });

  it('rootDirは.agents/worktrees', () => {
    expect(pseudoWorktreesRootDir('/ws')).toBe(path.join('/ws', '.agents', 'worktrees'));
  });

  it('不正なrunId（UUID形式でない）は例外になる', () => {
    expect(() => pseudoWorktreePath('/ws', 'not-a-uuid', 'T2')).toThrow(/runId/);
    expect(() => integrationPath('/ws', 'not-a-uuid')).toThrow(/runId/);
  });

  it('不正なtaskId（パストラバーサル等）は例外になる', () => {
    expect(() => pseudoWorktreePath('/ws', RUN_ID, '../../../../etc/evil')).toThrow(/taskId/);
  });

  it('並列の2タスクが別のパスになる', () => {
    const t2 = pseudoWorktreePath('/ws', RUN_ID, 'T2');
    const t3 = pseudoWorktreePath('/ws', RUN_ID, 'T3');
    expect(t2).not.toBe(t3);
  });
});

describe('isExcludedPath', () => {
  it('.agents/worktrees自身とその配下は常に除外する（無限再帰の防止）', () => {
    expect(isExcludedPath('.agents/worktrees', [])).toBe(true);
    expect(isExcludedPath('.agents/worktrees/run-1/T1', [])).toBe(true);
  });

  it('.agents自体（worktrees以外）は除外しない', () => {
    expect(isExcludedPath('.agents/config.json', [])).toBe(false);
  });

  it('設定された除外ディレクトリ名は深さを問わず一致する', () => {
    expect(isExcludedPath('node_modules', DEFAULT_PSEUDO_WORKTREE_EXCLUDE)).toBe(true);
    expect(
      isExcludedPath('packages/foo/node_modules/bar.js', DEFAULT_PSEUDO_WORKTREE_EXCLUDE),
    ).toBe(true);
    expect(isExcludedPath('.venv/lib/x.py', DEFAULT_PSEUDO_WORKTREE_EXCLUDE)).toBe(true);
    expect(isExcludedPath('dist/index.js', DEFAULT_PSEUDO_WORKTREE_EXCLUDE)).toBe(true);
    expect(isExcludedPath('out/main.js', DEFAULT_PSEUDO_WORKTREE_EXCLUDE)).toBe(true);
  });

  it('除外対象に含まれない通常のファイルは除外しない', () => {
    expect(isExcludedPath('src/index.ts', DEFAULT_PSEUDO_WORKTREE_EXCLUDE)).toBe(false);
    expect(isExcludedPath('node_modules_backup/x.js', DEFAULT_PSEUDO_WORKTREE_EXCLUDE)).toBe(false);
  });
});

describe('diffSnapshots', () => {
  function snap(entries: Record<string, { size: number; mtimeMs: number }>): Snapshot {
    return new Map(Object.entries(entries));
  }

  it('追加・変更・削除を検出する', () => {
    const baseline = snap({
      unchanged: { size: 10, mtimeMs: 100 },
      changed: { size: 10, mtimeMs: 100 },
      removed: { size: 5, mtimeMs: 50 },
    });
    const current = snap({
      unchanged: { size: 10, mtimeMs: 100 },
      changed: { size: 20, mtimeMs: 100 },
      added: { size: 1, mtimeMs: 1 },
    });

    expect(diffSnapshots(baseline, current)).toEqual([
      { path: 'added', kind: 'added' },
      { path: 'changed', kind: 'modified' },
      { path: 'removed', kind: 'deleted' },
    ]);
  });

  it('サイズが同じでも更新時刻が違えば変更とみなす', () => {
    const baseline = snap({ f: { size: 10, mtimeMs: 100 } });
    const current = snap({ f: { size: 10, mtimeMs: 200 } });
    expect(diffSnapshots(baseline, current)).toEqual([{ path: 'f', kind: 'modified' }]);
  });

  it('差分が無ければ空配列', () => {
    const baseline = snap({ f: { size: 10, mtimeMs: 100 } });
    expect(diffSnapshots(baseline, baseline)).toEqual([]);
  });
});

describe('planIntegration', () => {
  const diffA: DiffEntry[] = [
    { path: 'a.txt', kind: 'added' },
    { path: 'b.txt', kind: 'modified' },
  ];

  it('マニフェストが空なら全て適用でき、マニフェストへ記録される', () => {
    const plan = planIntegration('T1', diffA, new Map());
    expect(plan.toApply).toEqual(diffA);
    expect(plan.conflicts).toEqual([]);
    expect(plan.manifest.get('a.txt')).toEqual({ taskId: 'T1', kind: 'added' });
    expect(plan.manifest.get('b.txt')).toEqual({ taskId: 'T1', kind: 'modified' });
  });

  it('別タスクが既に統合済みの同じパスは衝突になる（3-way mergeはしない）', () => {
    const manifest: IntegrationManifest = new Map([['b.txt', { taskId: 'T2', kind: 'modified' }]]);
    const plan = planIntegration('T1', diffA, manifest);
    expect(plan.toApply).toEqual([{ path: 'a.txt', kind: 'added' }]);
    expect(plan.conflicts).toEqual([{ path: 'b.txt', kind: 'modified', conflictingTaskId: 'T2' }]);
    // 衝突したパスはマニフェストを書き換えない（T2の記録のまま）
    expect(plan.manifest.get('b.txt')).toEqual({ taskId: 'T2', kind: 'modified' });
  });

  it('同じタスクが同じパスを再度適用する場合（リトライ等）は衝突にしない', () => {
    const manifest: IntegrationManifest = new Map([['b.txt', { taskId: 'T1', kind: 'modified' }]]);
    const plan = planIntegration('T1', diffA, manifest);
    expect(plan.conflicts).toEqual([]);
    expect(plan.toApply).toEqual(diffA);
  });
});

describe('serializeManifest / deserializeManifest', () => {
  it('直列化・復元で内容が保たれる', () => {
    const manifest: IntegrationManifest = new Map([
      ['a.txt', { taskId: 'T1', kind: 'added' }],
      ['b.txt', { taskId: 'T2', kind: 'deleted' }],
    ]);
    const json = serializeManifest(manifest);
    expect(deserializeManifest(json)).toEqual(manifest);
  });

  it('壊れたJSONは空のマニフェストとして扱う（安全側）', () => {
    expect(deserializeManifest('not json')).toEqual(new Map());
    expect(deserializeManifest('[]')).toEqual(new Map());
    expect(deserializeManifest('null')).toEqual(new Map());
  });
});

describe('IntegrationQueue（直列化）', () => {
  it('integrateが直列化され、同時に複数要求してもマニフェスト更新が重ならない', async () => {
    let active = 0;
    let maxActive = 0;
    const queue = new IntegrationQueue();
    const fs = nodePseudoWorktreeFileSystem;

    const originalEnqueue = (
      queue as unknown as { enqueue<T>(task: () => Promise<T>): Promise<T> }
    ).enqueue.bind(queue);
    (queue as unknown as { enqueue<T>(task: () => Promise<T>): Promise<T> }).enqueue = <T>(
      task: () => Promise<T>,
    ) =>
      originalEnqueue(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return task();
      });

    const results = await Promise.all([
      queue.integrate('T1', '/nowhere', '/nowhere-int', [], fs),
      queue.integrate('T2', '/nowhere', '/nowhere-int', [], fs),
      queue.integrate('T3', '/nowhere', '/nowhere-int', [], fs),
    ]);

    expect(maxActive).toBe(1);
    expect(results).toHaveLength(3);
  });
});

describe('実ファイルシステムでの統合テスト', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-ws-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspace, ...relPath.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  it('cloneWorkspaceがワークスペースを複製し、node_modules等を除外する', async () => {
    await writeWorkspaceFile('README.md', 'hello\n');
    await writeWorkspaceFile('src/index.ts', 'export {};\n');
    await writeWorkspaceFile('node_modules/pkg/index.js', 'module.exports = {};\n');
    await writeWorkspaceFile('dist/index.js', 'built\n');

    const result = await cloneWorkspace(
      workspace,
      RUN_ID,
      'T1',
      [...DEFAULT_PSEUDO_WORKTREE_EXCLUDE],
      nodePseudoWorktreeFileSystem,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cwd).toBe(pseudoWorktreePath(workspace, RUN_ID, 'T1'));
    expect(await readFile(path.join(result.cwd, 'README.md'), 'utf8')).toBe('hello\n');
    expect(await readFile(path.join(result.cwd, 'src', 'index.ts'), 'utf8')).toBe('export {};\n');
    await expect(
      readFile(path.join(result.cwd, 'node_modules', 'pkg', 'index.js')),
    ).rejects.toThrow();
    await expect(readFile(path.join(result.cwd, 'dist', 'index.js'))).rejects.toThrow();
    expect(result.snapshot.has('README.md')).toBe(true);
    expect(result.snapshot.has('node_modules/pkg/index.js')).toBe(false);
  });

  it('並列の2タスクが別々のディレクトリで複製される（受入基準）', async () => {
    await writeWorkspaceFile('a.txt', 'a\n');

    const t1 = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    const t2 = await cloneWorkspace(workspace, RUN_ID, 'T2', [], nodePseudoWorktreeFileSystem);

    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;
    expect(t1.cwd).not.toBe(t2.cwd);
    await expect(readFile(path.join(t1.cwd, 'a.txt'), 'utf8')).resolves.toBe('a\n');
    await expect(readFile(path.join(t2.cwd, 'a.txt'), 'utf8')).resolves.toBe('a\n');
  });

  it('複製先が既に存在する場合はalreadyExistsになる', async () => {
    await writeWorkspaceFile('a.txt', 'a\n');
    const first = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    expect(first.ok).toBe(true);

    const second = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    expect(second).toMatchObject({ ok: false, reason: 'alreadyExists' });
  });

  it('ワークスペース内のシンボリックリンクは複製・スナップショットの対象から除く', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
    try {
      await writeWorkspaceFile('a.txt', 'a\n');
      await writeFile(path.join(outsideDir, 'secret.txt'), 'secret\n');
      await symlink(path.join(outsideDir, 'secret.txt'), path.join(workspace, 'link.txt'));

      const result = await cloneWorkspace(
        workspace,
        RUN_ID,
        'T1',
        [],
        nodePseudoWorktreeFileSystem,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.has('link.txt')).toBe(false);
      await expect(readFile(path.join(result.cwd, 'link.txt'))).rejects.toThrow();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  /**
   * `.agents/worktrees` がシンボリックリンクだと、文字列結合だけで組み立てたパスの実体は
   * リンク先（ワークスペースの外）になる。`worktree.ts` の同種のテストと同じ脅威モデル
   * （design.md §16.6のシンボリックリンク対策をpseudoWorktreeにも適用する、というIssue #96の指示）。
   */
  it('.agents/worktreesがシンボリックリンクだと、複製を拒否しワークスペースの外に何も作らない', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
    try {
      await mkdir(path.join(workspace, '.agents'), { recursive: true });
      await symlink(outsideDir, path.join(workspace, '.agents', 'worktrees'));

      const result = await cloneWorkspace(
        workspace,
        RUN_ID,
        'T1',
        [],
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toMatchObject({ ok: false, reason: 'symlinkDetected' });
      await expect(readdir(outsideDir)).resolves.toEqual([]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('.agents/worktreesがシンボリックリンクだと、統合先の作成も拒否する', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
    try {
      await mkdir(path.join(workspace, '.agents'), { recursive: true });
      await symlink(outsideDir, path.join(workspace, '.agents', 'worktrees'));

      const result = await ensureIntegrationDir(workspace, RUN_ID, nodePseudoWorktreeFileSystem);

      expect(result).toMatchObject({ ok: false, reason: 'symlinkDetected' });
      await expect(readdir(outsideDir)).resolves.toEqual([]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  describe('removePseudoWorktree（Issue #298）', () => {
    it('cloneWorkspaceで作った複製を撤去する', async () => {
      await writeWorkspaceFile('a.txt', 'a\n');
      const cloned = await cloneWorkspace(
        workspace,
        RUN_ID,
        'T1',
        [],
        nodePseudoWorktreeFileSystem,
      );
      expect(cloned.ok).toBe(true);
      if (!cloned.ok) return;

      const result = await removePseudoWorktree(
        workspace,
        RUN_ID,
        'T1',
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toEqual({ ok: true });
      await expect(readdir(cloned.cwd)).rejects.toThrow();
    });

    it('taskIdに_integrationを渡すと統合先も同じ入口で撤去できる', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;

      const result = await removePseudoWorktree(
        workspace,
        RUN_ID,
        '_integration',
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toEqual({ ok: true });
      await expect(readdir(integration.dir)).rejects.toThrow();
    });

    it('撤去対象が既に存在しなければ、消さずに成功として返す（冪等）', async () => {
      const result = await removePseudoWorktree(
        workspace,
        RUN_ID,
        'T1',
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toEqual({ ok: true });
    });

    /**
     * `<runId>`ディレクトリがシンボリックリンクへ差し替えられていると、素朴な文字列結合の
     * パスは`.agents/worktrees`の外（ここでは`outsideDir`）の実体を指す。実パス解決した
     * 結果が`.agents/worktrees`の配下に無ければ、`removeDirRecursive`を呼ばずに
     * `boundaryEscape`として弾く（境界逸脱時に外側の実体を巻き込んで消さないことの確認）。
     */
    it('.agents/worktrees配下の外を指す実体は撤去せずboundaryEscapeを返す', async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        await mkdir(path.join(outsideDir, 'T1'), { recursive: true });
        await writeFile(path.join(outsideDir, 'T1', 'secret.txt'), 'secret\n');
        await mkdir(pseudoWorktreesRootDir(workspace), { recursive: true });
        await symlink(outsideDir, path.join(pseudoWorktreesRootDir(workspace), RUN_ID));

        const result = await removePseudoWorktree(
          workspace,
          RUN_ID,
          'T1',
          nodePseudoWorktreeFileSystem,
        );

        expect(result).toMatchObject({ ok: false, reason: 'boundaryEscape' });
        // 外側の実体は消えず残っている
        await expect(readFile(path.join(outsideDir, 'T1', 'secret.txt'), 'utf8')).resolves.toBe(
          'secret\n',
        );
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it('片方のタスクだけが変えたファイルが、統合先へそのまま入る（受入基準）', async () => {
    await writeWorkspaceFile('shared.txt', 'original\n');
    await writeWorkspaceFile('only-t1.txt', 'original\n');

    const integration = await ensureIntegrationDir(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
    expect(integration.ok).toBe(true);
    if (!integration.ok) return;

    const t1 = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;

    await writeFile(path.join(t1.cwd, 'only-t1.txt'), 'changed by T1 only, longer content\n');
    const t1After = await takeSnapshot(t1.cwd, [], nodePseudoWorktreeFileSystem);
    const diff = diffSnapshots(t1.snapshot, t1After);

    const queue = new IntegrationQueue();
    const plan = await queue.integrate(
      'T1',
      t1.cwd,
      integration.dir,
      diff,
      nodePseudoWorktreeFileSystem,
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.toApply).toEqual([{ path: 'only-t1.txt', kind: 'modified' }]);

    await expect(readFile(path.join(integration.dir, 'only-t1.txt'), 'utf8')).resolves.toBe(
      'changed by T1 only, longer content\n',
    );
  });

  it('両方のタスクが同じファイルを変えた場合に衝突として扱われる（受入基準）', async () => {
    await writeWorkspaceFile('shared.txt', 'original\n');

    const integration = await ensureIntegrationDir(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
    expect(integration.ok).toBe(true);
    if (!integration.ok) return;

    const t1 = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    const t2 = await cloneWorkspace(workspace, RUN_ID, 'T2', [], nodePseudoWorktreeFileSystem);
    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;

    await writeFile(path.join(t1.cwd, 'shared.txt'), 'changed by T1, this is longer\n');
    await writeFile(path.join(t2.cwd, 'shared.txt'), 'changed by T2, this is also longer\n');

    const t1Diff = diffSnapshots(
      t1.snapshot,
      await takeSnapshot(t1.cwd, [], nodePseudoWorktreeFileSystem),
    );
    const t2Diff = diffSnapshots(
      t2.snapshot,
      await takeSnapshot(t2.cwd, [], nodePseudoWorktreeFileSystem),
    );

    const queue = new IntegrationQueue();
    const firstPlan = await queue.integrate(
      'T1',
      t1.cwd,
      integration.dir,
      t1Diff,
      nodePseudoWorktreeFileSystem,
    );
    expect(firstPlan.conflicts).toEqual([]);

    const secondPlan = await queue.integrate(
      'T2',
      t2.cwd,
      integration.dir,
      t2Diff,
      nodePseudoWorktreeFileSystem,
    );
    expect(secondPlan.conflicts).toEqual([
      { path: 'shared.txt', kind: 'modified', conflictingTaskId: 'T1' },
    ]);

    // 衝突した側の内容で上書きされていない（T1の内容のまま。内容のマージはしない）
    await expect(readFile(path.join(integration.dir, 'shared.txt'), 'utf8')).resolves.toBe(
      'changed by T1, this is longer\n',
    );
  });

  it('runの終了時に統合先の内容をワークスペースへ反映する（受入基準の前段）', async () => {
    await writeWorkspaceFile('a.txt', 'original\n');
    await writeWorkspaceFile('to-delete.txt', 'will be deleted\n');
    const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);

    const integration = await ensureIntegrationDir(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
    expect(integration.ok).toBe(true);
    if (!integration.ok) return;

    const t1 = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;

    await writeFile(path.join(t1.cwd, 'a.txt'), 'updated content, longer than before\n');
    await rm(path.join(t1.cwd, 'to-delete.txt'));
    await writeFile(path.join(t1.cwd, 'new.txt'), 'brand new file\n');

    const diff = diffSnapshots(
      t1.snapshot,
      await takeSnapshot(t1.cwd, [], nodePseudoWorktreeFileSystem),
    );
    const queue = new IntegrationQueue();
    await queue.integrate('T1', t1.cwd, integration.dir, diff, nodePseudoWorktreeFileSystem);

    const result = await reflectIntegrationToWorkspace(
      workspace,
      integration.dir,
      workspaceBaseline,
      queue.getManifest(),
      [],
      nodePseudoWorktreeFileSystem,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedPaths.sort()).toEqual(['a.txt', 'new.txt', 'to-delete.txt'].sort());
    await expect(readFile(path.join(workspace, 'a.txt'), 'utf8')).resolves.toBe(
      'updated content, longer than before\n',
    );
    await expect(readFile(path.join(workspace, 'new.txt'), 'utf8')).resolves.toBe(
      'brand new file\n',
    );
    await expect(readFile(path.join(workspace, 'to-delete.txt'))).rejects.toThrow();
  });

  it('実行中にワークスペース側が変更された場合、反映せず警告が出る（受入基準）', async () => {
    await writeWorkspaceFile('a.txt', 'original\n');
    const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);

    const integration = await ensureIntegrationDir(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
    expect(integration.ok).toBe(true);
    if (!integration.ok) return;

    const t1 = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;

    await writeFile(path.join(t1.cwd, 'a.txt'), 'changed by task, much longer content here\n');
    const diff = diffSnapshots(
      t1.snapshot,
      await takeSnapshot(t1.cwd, [], nodePseudoWorktreeFileSystem),
    );
    const queue = new IntegrationQueue();
    await queue.integrate('T1', t1.cwd, integration.dir, diff, nodePseudoWorktreeFileSystem);

    // 実行中に人がワークスペース側を直接編集した状況を再現する
    await writeFile(path.join(workspace, 'a.txt'), 'edited by a human during the run\n');

    const result = await reflectIntegrationToWorkspace(
      workspace,
      integration.dir,
      workspaceBaseline,
      queue.getManifest(),
      [],
      nodePseudoWorktreeFileSystem,
    );

    expect(result).toMatchObject({ reason: 'workspaceChanged' });
    if (result.ok) return;
    expect(result.changedPaths).toEqual(['a.txt']);
    // 反映されておらず、人の編集がそのまま残っている
    await expect(readFile(path.join(workspace, 'a.txt'), 'utf8')).resolves.toBe(
      'edited by a human during the run\n',
    );
  });
});

describe('applyDiffToIntegration', () => {
  it('deleted差分はファイルシステムへ触れない（統合先は疎な構成のため）', async () => {
    const calls: string[] = [];
    const fs: Parameters<typeof applyDiffToIntegration>[3] = {
      readdir: async () => [],
      statFile: async () => undefined,
      isSymbolicLink: async () => false,
      directoryExists: async () => false,
      realpath: async (t) => t,
      mkdir: async (t) => {
        calls.push(`mkdir:${t}`);
      },
      copyFile: async (from, to) => {
        calls.push(`copy:${from}->${to}`);
      },
      removeFile: async (t) => {
        calls.push(`remove:${t}`);
      },
      removeDirRecursive: async () => {},
    };

    await applyDiffToIntegration(
      '/task',
      '/integration',
      [{ path: 'deleted.txt', kind: 'deleted' }],
      fs,
    );

    expect(calls).toEqual([]);
  });
});
