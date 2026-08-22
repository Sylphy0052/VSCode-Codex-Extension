import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  integrationManifestPath,
  integrationPath,
  IntegrationQueue,
  isExcludedPath,
  loadPersistedManifest,
  nodePseudoWorktreeFileSystem,
  persistManifest,
  planIntegration,
  pseudoWorktreePath,
  pseudoWorktreesRootDir,
  reflectIntegrationToWorkspace,
  removePseudoIntegration,
  removePseudoWorktree,
  removePseudoWorktreeAttempts,
  serializeManifest,
  takeSnapshot,
  type DiffEntry,
  type IntegrationManifest,
  type PseudoWorktreeFileSystemPort,
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

  /**
   * `worktree.ts`の`worktreePath`と対称にする（Issue #396）。`retry`を渡すと
   * ディレクトリ名にも`-retry<n>`が付き、再試行のたびに別ディレクトリになる。
   */
  it('retryを渡すとディレクトリ名に-retry<n>が付く（worktree.tsのworktreePathと対称）', () => {
    expect(pseudoWorktreePath('/ws', RUN_ID, 'T1', 0)).toBe(
      path.join('/ws', '.agents', 'worktrees', RUN_ID, 'T1-retry0'),
    );
    expect(pseudoWorktreePath('/ws', RUN_ID, 'T1', 1)).toBe(
      path.join('/ws', '.agents', 'worktrees', RUN_ID, 'T1-retry1'),
    );
    expect(pseudoWorktreePath('/ws', RUN_ID, 'T1', undefined)).toBe(
      pseudoWorktreePath('/ws', RUN_ID, 'T1'),
    );
  });

  /**
   * `_integration`はタスクidとして予約済み（design.md §16.17）で、再試行という概念が
   * 無い。誤って接尾辞が付くと`integrationPath`が指す場所とずれてしまう。
   */
  it('_integrationにretryを渡しても接尾辞は付かない（予約済みタスクidのため）', () => {
    expect(pseudoWorktreePath('/ws', RUN_ID, '_integration', 3)).toBe(
      integrationPath('/ws', RUN_ID),
    );
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

  /**
   * Issue #440: 以前は壊れたJSONを黙って空のマニフェストへ倒していた（fail-open）。
   * これは`loadPersistedManifest`（Issue #380）が「復元できなかった」ことを呼び出し側へ
   * 伝えるfail-closedと正反対の方針であり、#380が問題視した「黙って0件成功にすると
   * 統合済みだった成果が消えたことに気づけない」動きそのものだったため、例外を投げる
   * fail-closedへ揃えた。`[]`・`null`は「対象がオブジェクトでない」だけで内容が
   * 壊れているわけではないため、こちらは従来どおり空のマニフェスト（`ok: true`）として
   * 扱われる（`manifestFromParsedJson`の分岐を参照）。
   */
  it('壊れたJSON（解析できない文字列）は例外を投げる（fail-closed、Issue #440）', () => {
    expect(() => deserializeManifest('not json')).toThrow(/復元できません/);
  });

  it('配列・nullはオブジェクトではないため空のマニフェストとして扱う（壊れているわけではない）', () => {
    expect(deserializeManifest('[]')).toEqual(new Map());
    expect(deserializeManifest('null')).toEqual(new Map());
  });
});

describe('マニフェストのキー検証（レビュー指摘: high、パストラバーサル、Issue #380の追加指摘）', () => {
  /**
   * `manifestFromParsedJson`は`Object.entries(parsed)`の値（`taskId`/`kind`）だけでなく
   * キー（＝ワークスペースへ反映する相対パス）も検証する。このキーは
   * `reflectIntegrationToWorkspace`で`path.join(workspaceRoot, ...segments)`へそのまま
   * 渡るため、`..`を含む・絶対パス・バックスラッシュ区切りのキーは`workspaceRoot`の外を
   * 指しうる。ここでは`deserializeManifest`（Issue #440でfail-closedへ揃えた公開関数）を
   * 通して、不正なキーが1件でもあれば復元全体が失敗することを確認する（他の正当な
   * キーが道連れで失われても、`loadPersistedManifest`と同じく「部分的に復元できた」
   * ことにはしない）。
   */
  it.each([
    ['../../../../home/user/.bashrc', '相対パスの..セグメントによるトラバーサル'],
    ['a/../../etc/passwd', '途中に..を含むトラバーサル'],
    ['/etc/passwd', 'POSIX絶対パス'],
    ['C:\\Windows\\System32\\evil', 'Windowsドライブレター+バックスラッシュ'],
    ['a\\..\\..\\evil', 'バックスラッシュ区切りの相対トラバーサル'],
    ['', '空文字'],
    ['a/./b', '.セグメントを含む'],
  ])('不正なキー（%s: %s）を含むと復元全体が失敗する（fail-closed、Issue #440）', (badKey) => {
    const json = JSON.stringify({
      [badKey]: { taskId: 'T1', kind: 'modified' },
      'ok.txt': { taskId: 'T1', kind: 'added' },
    });
    expect(() => deserializeManifest(json)).toThrow(/復元できません/);
  });

  it('妥当なキー（通常の相対パス）は破棄されない', () => {
    const json = JSON.stringify({
      'src/index.ts': { taskId: 'T1', kind: 'modified' },
      'a/b/c.txt': { taskId: 'T2', kind: 'added' },
    });
    const manifest = deserializeManifest(json);
    expect(manifest.get('src/index.ts')).toEqual({ taskId: 'T1', kind: 'modified' });
    expect(manifest.get('a/b/c.txt')).toEqual({ taskId: 'T2', kind: 'added' });
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

  /**
   * レビュー指摘: risk（Issue #380の追加指摘）。`persistManifest`の呼び出しを
   * `queue.integrate`の`await`解決後・`SerialQueue`の外で行うと、`integrate`自体は
   * 直列化されていても後段の書き込み同士には順序保証が無い。先に完了したタスク
   * （enqueue順で先）の書き込みが遅延し、後から完了した別タスクの書き込みより後に
   * ディスクへ着地すると、統合済みの成果がmanifest.json上から消える
   * （Issue #380が防ごうとした事象の再発）。
   *
   * `IntegrationQueue.integrate`の`onIntegrated`フックへ永続化を渡すことで、
   * 後段の書き込み自体も`SerialQueue`項目の中に収まり、順序が保証されることを確認する。
   */
  it(
    '永続化（onIntegratedフック）が完了するまで次のタスクのintegrateが始まらないため、' +
      '書き込みの順序が保証される',
    async () => {
      const queue = new IntegrationQueue();
      const fs = nodePseudoWorktreeFileSystem;

      let stored = '';
      const writeOrder: string[] = [];
      const persist = async (manifest: IntegrationManifest, delayMs: number): Promise<void> => {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        stored = serializeManifest(manifest);
        writeOrder.push(stored);
      };

      // T1（先にintegrateを呼ぶ）の永続化をわざと遅らせ、T2（後から呼ぶ）の永続化は
      // 即座に終わるようにする。もし永続化がキューの外で行われていれば、T2の速い書き込みが
      // T1の遅い書き込みより先に完了し、最後にT1の（T2を含まない）古い内容で上書きされうる
      const t1 = queue.integrate(
        'T1',
        '/nowhere',
        '/nowhere-int',
        [{ path: 'a.txt', kind: 'deleted' }],
        fs,
        (manifest) => persist(manifest, 20),
      );
      const t2 = queue.integrate(
        'T2',
        '/nowhere',
        '/nowhere-int',
        [{ path: 'b.txt', kind: 'deleted' }],
        fs,
        (manifest) => persist(manifest, 0),
      );

      await Promise.all([t1, t2]);

      // 直列化により、T1の（遅い）永続化がT2のintegrate開始より前に完了しているため、
      // 書き込み順はT1→T2のまま入れ替わらない
      expect(writeOrder).toHaveLength(2);
      expect(deserializeManifest(writeOrder[0] ?? '')).toEqual(
        new Map([['a.txt', { taskId: 'T1', kind: 'deleted' }]]),
      );
      expect(deserializeManifest(writeOrder[1] ?? '')).toEqual(
        new Map([
          ['a.txt', { taskId: 'T1', kind: 'deleted' }],
          ['b.txt', { taskId: 'T2', kind: 'deleted' }],
        ]),
      );
      // 最終的にディスク相当の内容（stored）には両方のタスクの記録が残る
      expect(deserializeManifest(stored)).toEqual(
        new Map([
          ['a.txt', { taskId: 'T1', kind: 'deleted' }],
          ['b.txt', { taskId: 'T2', kind: 'deleted' }],
        ]),
      );
    },
  );
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

  /**
   * Issue #396: `failed`になったタスクを再試行すると、`retry`回数に応じた別ディレクトリへ
   * 複製できる必要がある。`retry`を渡さずに前回の複製が残ったままだと`alreadyExists`で
   * 必ず失敗していた（gitの`worktreePath`は既にretry対応済みで、疑似worktree側だけが
   * 取り残されていた）。
   */
  it('retryを渡すと前回の複製が残っていても別ディレクトリへ複製できる（Issue #396）', async () => {
    await writeWorkspaceFile('a.txt', 'a\n');
    const first = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
    expect(first.ok).toBe(true);

    const retried = await cloneWorkspace(
      workspace,
      RUN_ID,
      'T1',
      [],
      nodePseudoWorktreeFileSystem,
      0,
    );
    expect(retried.ok).toBe(true);
    if (!first.ok || !retried.ok) return;
    expect(retried.cwd).not.toBe(first.cwd);
    expect(retried.cwd).toBe(pseudoWorktreePath(workspace, RUN_ID, 'T1', 0));
    await expect(readFile(path.join(retried.cwd, 'a.txt'), 'utf8')).resolves.toBe('a\n');
  });

  it('同じretry番号への2回目のcloneWorkspaceはalreadyExistsになる', async () => {
    await writeWorkspaceFile('a.txt', 'a\n');
    const first = await cloneWorkspace(
      workspace,
      RUN_ID,
      'T1',
      [],
      nodePseudoWorktreeFileSystem,
      0,
    );
    expect(first.ok).toBe(true);

    const second = await cloneWorkspace(
      workspace,
      RUN_ID,
      'T1',
      [],
      nodePseudoWorktreeFileSystem,
      0,
    );
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
     * Issue #396: `retry`を渡すと、その番号の複製先だけを撤去できる
     * （`cloneWorkspace`が`retry`ごとに別ディレクトリを作るのと対称）。
     */
    it('retryを渡すとその番号の複製先を撤去する', async () => {
      const cloned = await cloneWorkspace(
        workspace,
        RUN_ID,
        'T1',
        [],
        nodePseudoWorktreeFileSystem,
        0,
      );
      expect(cloned.ok).toBe(true);
      if (!cloned.ok) return;

      const result = await removePseudoWorktree(
        workspace,
        RUN_ID,
        'T1',
        nodePseudoWorktreeFileSystem,
        0,
      );

      expect(result).toEqual({ ok: true });
      await expect(readdir(cloned.cwd)).rejects.toThrow();
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

    /**
     * Issue #493（Issue #484 / PR #504の規律の横展開）: `<runId>`ディレクトリが
     * `.agents/worktrees`**配下の**別ディレクトリ（他タスクの複製等）を指すシンボリック
     * リンクへ差し替えられているケース。差し替え先も`.agents/worktrees`配下のため、
     * 「境界内か」（`isPathWithinRoot`）だけを見る旧実装では素通りしてしまい、
     * `removeDirRecursive`が`target`（文字列）を辿って差し替え先の実体を丸ごと
     * 削除してしまう。「実パス確認時点で想定していた場所そのものか」の厳密一致で
     * 検知し、差し替え先の実体には触れずに拒否する。
     */
    it(
      'runIdディレクトリが.agents/worktrees配下の別ディレクトリを指すシンボリックリンクに' +
        '差し替えられていても、境界内リダイレクトとして撤去せず差し替え先の実体も消さない' +
        '（Issue #493）',
      async () => {
        const decoyDir = path.join(pseudoWorktreesRootDir(workspace), '_decoy');
        await mkdir(path.join(decoyDir, 'T1'), { recursive: true });
        await writeFile(path.join(decoyDir, 'T1', 'secret.txt'), 'must-not-be-deleted\n');
        await symlink(decoyDir, path.join(pseudoWorktreesRootDir(workspace), RUN_ID));

        const result = await removePseudoWorktree(
          workspace,
          RUN_ID,
          'T1',
          nodePseudoWorktreeFileSystem,
        );

        expect(result).toMatchObject({ ok: false, reason: 'boundaryEscape' });
        // 差し替え先（他タスクの複製に見立てたディレクトリ）の実体は消えず残っている
        await expect(
          readFile(path.join(decoyDir, 'T1', 'secret.txt'), 'utf8'),
        ).resolves.toBe('must-not-be-deleted\n');
      },
    );

    /**
     * Issue #493の2点目: `fsPromises.rm`は`ENOENT`を握りつぶすが`EACCES`/`EPERM`等は
     * 投げる。呼び出し側に`try/catch`が無いと、この例外が`removePseudoWorktree`を
     * 越えて伝播してしまう（`removePseudoIntegration`、さらに`runner.ts`の
     * `cleanupIntegration`まで巻き込みうる）。削除失敗を例外にせず`Result`型として
     * 返すことを確かめる。
     */
    it('削除自体がEACCES等で失敗しても、例外を投げずに失敗の結果として返す（Issue #493）', async () => {
      const cloned = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
      expect(cloned.ok).toBe(true);
      if (!cloned.ok) return;

      const fs: PseudoWorktreeFileSystemPort = {
        ...nodePseudoWorktreeFileSystem,
        removeDirRecursive: async () => {
          const error = new Error('permission denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      };

      const result = await removePseudoWorktree(workspace, RUN_ID, 'T1', fs);

      expect(result).toMatchObject({ ok: false, reason: 'removalFailed' });
    });
  });

  describe('removePseudoIntegration（統合worktreeとmanifest.jsonをまとめて撤去、Issue #438）', () => {
    it('_integrationとmanifest.jsonの両方を撤去する（受入基準）', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;

      const manifest: IntegrationManifest = new Map([
        ['a.txt', { kind: 'added' as const, taskId: 'T1' }],
      ]);
      await persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem);
      expect(
        await readFile(integrationManifestPath(workspace, RUN_ID), 'utf8'),
      ).not.toHaveLength(0);

      const result = await removePseudoIntegration(workspace, RUN_ID, nodePseudoWorktreeFileSystem);

      expect(result).toEqual({ ok: true });
      await expect(readdir(integration.dir)).rejects.toThrow();
      await expect(readFile(integrationManifestPath(workspace, RUN_ID), 'utf8')).rejects.toThrow();
    });

    /**
     * 撤去後にリロードすると、幽霊マニフェスト（実体の無い`_integration`を指す古い
     * エントリ）を読み戻してはいけない（受入基準）。`loadPersistedManifest`は
     * ファイルが無い場合は空のマニフェストを返す正常系のため、これで確かめられる。
     */
    it('撤去後にloadPersistedManifestで読み戻しても空になる（受入基準）', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;

      const manifest: IntegrationManifest = new Map([
        ['a.txt', { kind: 'deleted' as const, taskId: 'T1' }],
      ]);
      await persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem);

      await removePseudoIntegration(workspace, RUN_ID, nodePseudoWorktreeFileSystem);

      const reloaded = await loadPersistedManifest(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
      expect(reloaded).toEqual({ ok: true, manifest: new Map() });
    });

    it('<runId>ディレクトリに他のタスクの複製が残っていれば、そのディレクトリ自体は消さない', async () => {
      await writeWorkspaceFile('a.txt', 'a\n');
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      const task = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
      expect(task.ok).toBe(true);
      if (!task.ok) return;

      const result = await removePseudoIntegration(workspace, RUN_ID, nodePseudoWorktreeFileSystem);

      expect(result).toEqual({ ok: true });
      const runDir = path.join(pseudoWorktreesRootDir(workspace), RUN_ID);
      await expect(readdir(runDir)).resolves.toEqual(['T1']);
      await expect(readFile(path.join(task.cwd, 'a.txt'), 'utf8')).resolves.toBe('a\n');
    });

    it('他runのmanifest.jsonは巻き込まない', async () => {
      const otherRunId = '22222222-2222-4222-8222-222222222222';
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      const otherIntegration = await ensureIntegrationDir(
        workspace,
        otherRunId,
        nodePseudoWorktreeFileSystem,
      );
      expect(otherIntegration.ok).toBe(true);
      const manifest: IntegrationManifest = new Map([
        ['a.txt', { kind: 'added' as const, taskId: 'T1' }],
      ]);
      await persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem);
      await persistManifest(workspace, otherRunId, manifest, nodePseudoWorktreeFileSystem);

      const result = await removePseudoIntegration(workspace, RUN_ID, nodePseudoWorktreeFileSystem);

      expect(result).toEqual({ ok: true });
      await expect(
        readFile(integrationManifestPath(workspace, otherRunId), 'utf8'),
      ).resolves.not.toHaveLength(0);
    });

    it('.agents/worktrees配下の外を指す実体は撤去せずboundaryEscapeを返す', async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        await writeFile(path.join(outsideDir, 'manifest.json'), '{}');
        await mkdir(pseudoWorktreesRootDir(workspace), { recursive: true });
        await symlink(outsideDir, path.join(pseudoWorktreesRootDir(workspace), RUN_ID));

        const result = await removePseudoIntegration(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );

        expect(result).toMatchObject({ ok: false, reason: 'boundaryEscape' });
        await expect(readFile(path.join(outsideDir, 'manifest.json'), 'utf8')).resolves.toBe('{}');
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    /**
     * レビュー指摘（Issue #438のPRレビュー・medium1）: `_integration`単体がシンボリック
     * リンクに差し替えられ`manifest.json`は正当なファイルのまま、というケース。
     * 撤去順序が`_integration`→`manifest.json`のままだと`removePseudoWorktree`の
     * `boundaryEscape`で打ち切られ、`manifest.json`が一度も撤去されない
     * （Issue #438が塞ごうとした幽霊マニフェストの読み戻しが再現してしまう）。
     * manifest優先の順序であれば、`_integration`側が境界逸脱でも`manifest.json`は
     * 確実に撤去される。
     */
    it('_integrationだけがシンボリックリンク化されmanifest.jsonが正当なファイルの場合、manifest.jsonは確実に撤去される', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;

      const manifest: IntegrationManifest = new Map([
        ['a.txt', { kind: 'added' as const, taskId: 'T1' }],
      ]);
      await persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem);

      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        await rm(integration.dir, { recursive: true, force: true });
        await symlink(outsideDir, integration.dir);

        const result = await removePseudoIntegration(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );

        // _integration側は境界逸脱として撤去を拒否する
        expect(result).toMatchObject({ ok: false, reason: 'boundaryEscape' });
        // manifest.jsonは_integrationより先に撤去されているため、既に消えている
        await expect(
          readFile(integrationManifestPath(workspace, RUN_ID), 'utf8'),
        ).rejects.toThrow();
        const reloaded = await loadPersistedManifest(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
        expect(reloaded).toEqual({ ok: true, manifest: new Map() });
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('_integrationとmanifest.jsonの撤去後、runIdディレクトリが空なら消える', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;

      const result = await removePseudoIntegration(workspace, RUN_ID, nodePseudoWorktreeFileSystem);

      expect(result).toEqual({ ok: true });
      const runDir = path.join(pseudoWorktreesRootDir(workspace), RUN_ID);
      await expect(readdir(runDir)).rejects.toThrow();
    });

    /**
     * レビュー指摘（medium2, low1）: `removeRunDirIfEmpty`はTOCTOU窓の無い非再帰
     * `removeEmptyDir`（`rmdir`）で判定と削除を一体化するため、`<runId>`が境界逸脱と
     * 判定された場合でも`manifest.json`/`_integration`の撤去は既に成功している。
     * この場合は全体を`ok:false`にせず、`warning`として観測できることを確かめる。
     */
    it('runIdディレクトリ自体が境界逸脱と判定されても、manifest.jsonと_integrationの撤去成功はok:falseにならず警告として返る', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      const manifest: IntegrationManifest = new Map([
        ['a.txt', { kind: 'added' as const, taskId: 'T1' }],
      ]);
      await persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem);

      const runDir = path.join(pseudoWorktreesRootDir(workspace), RUN_ID);
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        const fs: PseudoWorktreeFileSystemPort = {
          ...nodePseudoWorktreeFileSystem,
          realpath: async (target: string) => {
            if (target === runDir) {
              return outsideDir;
            }
            return nodePseudoWorktreeFileSystem.realpath(target);
          },
        };

        const result = await removePseudoIntegration(workspace, RUN_ID, fs);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.warning).toBeDefined();
        }
        await expect(readdir(integration.dir)).rejects.toThrow();
        await expect(
          readFile(integrationManifestPath(workspace, RUN_ID), 'utf8'),
        ).rejects.toThrow();
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    /**
     * Issue #493: `removeManifestFile`（非exportのため`removePseudoIntegration`経由で
     * 検証する）も`removePseudoWorktree`と同じ穴を持つ。`<runId>`が`.agents/worktrees`
     * **配下の**別ディレクトリを指すシンボリックリンクに差し替えられていると、
     * 「境界内か」だけを見る旧実装ではmanifest.jsonの撤去が素通りし、差し替え先の
     * manifest.jsonを誤って削除してしまう。
     */
    it(
      'runIdディレクトリが.agents/worktrees配下の別ディレクトリを指すシンボリックリンクに' +
        '差し替えられていても、manifest.jsonの撤去も境界内リダイレクトとして拒否し、' +
        '差し替え先のmanifest.jsonは消さない（Issue #493）',
      async () => {
        const decoyDir = path.join(pseudoWorktreesRootDir(workspace), '_decoy');
        await mkdir(decoyDir, { recursive: true });
        await writeFile(path.join(decoyDir, 'manifest.json'), '{"important":true}');
        await symlink(decoyDir, path.join(pseudoWorktreesRootDir(workspace), RUN_ID));

        const result = await removePseudoIntegration(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );

        expect(result).toMatchObject({ ok: false, reason: 'boundaryEscape' });
        await expect(readFile(path.join(decoyDir, 'manifest.json'), 'utf8')).resolves.toBe(
          '{"important":true}',
        );
      },
    );

    /**
     * Issue #493: `removeRunDirIfEmpty`（非exportのため同じく`removePseudoIntegration`
     * 経由で検証する）にも同じ穴がある。`<runId>`ディレクトリ自体が`.agents/worktrees`
     * 配下の別の空ディレクトリを指すシンボリックリンクに差し替えられていると、
     * 「境界内か」だけを見る旧実装では`removeEmptyDir`が差し替え先を辿って消してしまう
     * （空だからこそ`ENOTEMPTY`で弾かれず実際に消える）。`removeRunDirIfEmpty`の境界逸脱は
     * `removePseudoIntegration`が致命的失敗として扱わない既存設計（PR #492）のため、
     * ここでは`ok:true`かつ`warning`付きで返ることを確認する（既存設計は壊さない）。
     */
    it(
      'runIdディレクトリ自体が.agents/worktrees配下の別の空ディレクトリを指す' +
        'シンボリックリンクに差し替えられていても、差し替え先は消さない（Issue #493）',
      async () => {
        const decoyDir = path.join(pseudoWorktreesRootDir(workspace), '_decoy');
        await mkdir(decoyDir, { recursive: true });
        await symlink(decoyDir, path.join(pseudoWorktreesRootDir(workspace), RUN_ID));

        const result = await removePseudoIntegration(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.warning).toBeDefined();
        }
        // 差し替え先（別runの入れ物に見立てた空ディレクトリ）自体は消えず残っている
        await expect(lstat(decoyDir)).resolves.toBeDefined();
      },
    );

    /**
     * Issue #493の2点目: manifest.jsonの撤去（`removeFile`）が`EACCES`等で失敗しても、
     * 例外を投げずに`removePseudoIntegration`から失敗の結果として返る（呼び出し元の
     * `runner.ts`の`cleanupIntegration`を巻き込まない）ことを確かめる。
     */
    it(
      'manifest.jsonの撤去がEACCES等で失敗しても、例外を投げずに失敗の結果として返す' +
        '（Issue #493）',
      async () => {
        const integration = await ensureIntegrationDir(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );
        expect(integration.ok).toBe(true);
        if (!integration.ok) return;
        const manifest: IntegrationManifest = new Map([
          ['a.txt', { kind: 'added' as const, taskId: 'T1' }],
        ]);
        await persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem);

        const fs: PseudoWorktreeFileSystemPort = {
          ...nodePseudoWorktreeFileSystem,
          removeFile: async () => {
            const error = new Error('permission denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          },
        };

        await expect(removePseudoIntegration(workspace, RUN_ID, fs)).resolves.toMatchObject({
          ok: false,
          reason: 'removalFailed',
        });
      },
    );

    /**
     * Issue #493の2点目: `removeRunDirIfEmpty`側（`removeEmptyDir`）の失敗は、
     * `manifest.json`/`_integration`の撤去が既に成功していれば致命的失敗にせず
     * `warning`として返す既存の設計（PR #492）を壊さないことを確かめる。
     */
    it(
      'runIdディレクトリの撤去(rmdir)がEACCES等で失敗しても、例外を投げず' +
        'warningとして返す（Issue #493）',
      async () => {
        const integration = await ensureIntegrationDir(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );
        expect(integration.ok).toBe(true);
        if (!integration.ok) return;

        const fs: PseudoWorktreeFileSystemPort = {
          ...nodePseudoWorktreeFileSystem,
          removeEmptyDir: async () => {
            const error = new Error('permission denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          },
        };

        const result = await removePseudoIntegration(workspace, RUN_ID, fs);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.warning).toBeDefined();
        }
      },
    );
  });

  describe('removePseudoWorktreeAttempts（全試行分の撤去、Issue #396）', () => {
    /**
     * `worktree.ts`の`removeGitTaskWorktree`（`runner.ts`）と対になる撤去。「retryなし
     * （初回）」と`0..totalAttempts-1`のすべてを撤去対象にする。過去の試行分の複製が
     * 残ったままだと、`.agents/worktrees`配下にワークスペース丸ごとの複製が試行回数分
     * 積み上がってしまう。
     */
    it('初回と全retry分の複製をまとめて撤去する', async () => {
      const initial = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
      const retry0 = await cloneWorkspace(
        workspace,
        RUN_ID,
        'T1',
        [],
        nodePseudoWorktreeFileSystem,
        0,
      );
      const retry1 = await cloneWorkspace(
        workspace,
        RUN_ID,
        'T1',
        [],
        nodePseudoWorktreeFileSystem,
        1,
      );
      expect(initial.ok).toBe(true);
      expect(retry0.ok).toBe(true);
      expect(retry1.ok).toBe(true);
      if (!initial.ok || !retry0.ok || !retry1.ok) return;

      const result = await removePseudoWorktreeAttempts(
        workspace,
        RUN_ID,
        'T1',
        2,
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toEqual({ ok: true });
      await expect(readdir(initial.cwd)).rejects.toThrow();
      await expect(readdir(retry0.cwd)).rejects.toThrow();
      await expect(readdir(retry1.cwd)).rejects.toThrow();
    });

    it('totalAttemptsが0なら初回分だけを撤去する', async () => {
      const initial = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;

      const result = await removePseudoWorktreeAttempts(
        workspace,
        RUN_ID,
        'T1',
        0,
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toEqual({ ok: true });
      await expect(readdir(initial.cwd)).rejects.toThrow();
    });

    it('存在しない試行分が含まれていても冪等に成功する', async () => {
      const result = await removePseudoWorktreeAttempts(
        workspace,
        RUN_ID,
        'T1',
        3,
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toEqual({ ok: true });
    });

    it('いずれかの撤去が失敗すればok:falseで全メッセージをまとめて返す', async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        await mkdir(path.join(outsideDir, 'T1-retry0'), { recursive: true });
        await mkdir(pseudoWorktreesRootDir(workspace), { recursive: true });
        await symlink(outsideDir, path.join(pseudoWorktreesRootDir(workspace), RUN_ID));

        const result = await removePseudoWorktreeAttempts(
          workspace,
          RUN_ID,
          'T1',
          1,
          nodePseudoWorktreeFileSystem,
        );

        expect(result.ok).toBe(false);
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
    if (result.ok || result.reason !== 'workspaceChanged') return;
    expect(result.changedPaths).toEqual(['a.txt']);
    // 反映されておらず、人の編集がそのまま残っている
    await expect(readFile(path.join(workspace, 'a.txt'), 'utf8')).resolves.toBe(
      'edited by a human during the run\n',
    );
  });

  it('マニフェストを永続化し、読み戻すと同じ内容が復元される（受入基準、Issue #380）', async () => {
    const integration = await ensureIntegrationDir(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
    expect(integration.ok).toBe(true);
    if (!integration.ok) return;

    const manifest: IntegrationManifest = new Map([
      ['a.txt', { taskId: 'T1', kind: 'modified' }],
      ['b.txt', { taskId: 'T2', kind: 'added' }],
    ]);
    await persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem);

    const loaded = await loadPersistedManifest(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
    expect(loaded).toEqual({ ok: true, manifest });

    // 永続化先はrunId配下（_integrationと同じ階層）で、.agents/worktrees配下＝
    // スナップショット走査から常に除外される場所にある
    expect(integrationManifestPath(workspace, RUN_ID)).toBe(
      path.join(pseudoWorktreesRootDir(workspace), RUN_ID, 'manifest.json'),
    );
  });

  it(
    'マニフェストがまだ永続化されていない場合（初回実行）は復元できないのではなく、' +
      '空マニフェストで正常に扱う',
    async () => {
      const loaded = await loadPersistedManifest(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
      expect(loaded).toEqual({ ok: true, manifest: new Map() });
    },
  );

  it(
    '永続化されたマニフェストの内容が壊れている場合は「復元できない」ことが' +
      '分かる形で返す（黙って空マニフェストへ倒さない。受入基準、Issue #380）',
    async () => {
      const filePath = integrationManifestPath(workspace, RUN_ID);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, 'not valid json{{{');

      const loaded = await loadPersistedManifest(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.message).toContain('復元できません');
    },
  );

  it(
    '反映が途中で失敗すると、適用済み・未適用のパスの両方が結果に残る' +
      '（受入基準・追加の指摘、Issue #380）',
    async () => {
      await writeWorkspaceFile('a.txt', 'original a\n');
      await writeWorkspaceFile('b.txt', 'original b\n');
      const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);

      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;

      const t1 = await cloneWorkspace(workspace, RUN_ID, 'T1', [], nodePseudoWorktreeFileSystem);
      expect(t1.ok).toBe(true);
      if (!t1.ok) return;

      await writeFile(path.join(t1.cwd, 'a.txt'), 'updated a, longer than before\n');
      await writeFile(path.join(t1.cwd, 'b.txt'), 'updated b, longer than before\n');
      const diff = diffSnapshots(
        t1.snapshot,
        await takeSnapshot(t1.cwd, [], nodePseudoWorktreeFileSystem),
      );
      const queue = new IntegrationQueue();
      await queue.integrate('T1', t1.cwd, integration.dir, diff, nodePseudoWorktreeFileSystem);

      // 2件目（b.txt）のワークスペースへの反映だけが失敗するフェイクへ差し替える
      let copyCount = 0;
      const failingFs: typeof nodePseudoWorktreeFileSystem = {
        ...nodePseudoWorktreeFileSystem,
        copyFile: async (from, to) => {
          copyCount += 1;
          if (copyCount >= 2) {
            throw new Error('ENOSPC: no space left on device');
          }
          await nodePseudoWorktreeFileSystem.copyFile(from, to);
        },
      };

      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        queue.getManifest(),
        [],
        failingFs,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('partialApply');
      if (result.reason !== 'partialApply') return;
      expect(result.appliedPaths).toEqual(['a.txt']);
      expect(result.failedPath).toBe('b.txt');
      expect(result.remainingPaths).toEqual([]);
      // 失敗した1件より前は実際にワークスペースへ反映されている
      await expect(readFile(path.join(workspace, 'a.txt'), 'utf8')).resolves.toBe(
        'updated a, longer than before\n',
      );
      // 失敗した1件はワークスペース側に反映されていない
      await expect(readFile(path.join(workspace, 'b.txt'), 'utf8')).resolves.toBe('original b\n');
    },
  );

  it(
    'マニフェストのキーが..を含んでいても、反映処理自体がワークスペースの外への' +
      '書き込みを拒否する（レビュー指摘: high、多層防御の2段目。1段目のキー検証を' +
      'すり抜けたケースを想定し、ここではmanifestFromParsedJsonを経由せず' +
      'IntegrationManifestを直接組み立てて渡す）',
    async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;

      const escapeMarker = `evil-issue380-${RUN_ID}.txt`;
      const maliciousManifest: IntegrationManifest = new Map([
        [`../${escapeMarker}`, { taskId: 'T1', kind: 'modified' }],
      ]);

      const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        maliciousManifest,
        [],
        nodePseudoWorktreeFileSystem,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('partialApply');

      // ワークスペースの外（親ディレクトリ）に何も作られていない
      const escapedPath = path.join(workspace, '..', escapeMarker);
      try {
        await expect(readFile(escapedPath)).rejects.toThrow();
      } finally {
        await rm(escapedPath, { force: true });
      }
    },
  );

  it(
    '.agents/worktreesがシンボリックリンクだと、マニフェストの永続化・読み込みも' +
      '拒否する（レビュー指摘: medium）',
    async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        await mkdir(path.join(workspace, '.agents'), { recursive: true });
        await symlink(outsideDir, path.join(workspace, '.agents', 'worktrees'));

        const manifest: IntegrationManifest = new Map([
          ['a.txt', { taskId: 'T1', kind: 'added' }],
        ]);
        await expect(
          persistManifest(workspace, RUN_ID, manifest, nodePseudoWorktreeFileSystem),
        ).rejects.toThrow(/シンボリックリンク/);
        // シンボリックリンクの先（実体）には何も書き込まれていない
        await expect(readdir(outsideDir)).resolves.toEqual([]);

        const loaded = await loadPersistedManifest(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
        expect(loaded.ok).toBe(false);
        if (loaded.ok) return;
        expect(loaded.message).toContain('シンボリックリンク');
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'マニフェストのエントリ数が上限を超える場合はパース失敗として扱う' +
      '（レビュー指摘: risk、Issue #380の追加指摘）',
    async () => {
      const filePath = integrationManifestPath(workspace, RUN_ID);
      await mkdir(path.dirname(filePath), { recursive: true });

      const huge: Record<string, { taskId: string; kind: string }> = {};
      for (let i = 0; i < 100_001; i += 1) {
        huge[`f${i}.txt`] = { taskId: 'T1', kind: 'added' };
      }
      await writeFile(filePath, JSON.stringify(huge));

      const loaded = await loadPersistedManifest(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.message).toContain('復元できません');
    },
    20_000,
  );

  it(
    'ファイルサイズが上限を超える場合は内容を解析する前に復元できなかったとして扱う' +
      '（レビュー指摘: medium、Issue #380の追加指摘。エントリ数チェックはJSON.parse後にしか' +
      '効かないため、パース前にファイルサイズで弾く二次防御を確かめる）',
    async () => {
      const filePath = integrationManifestPath(workspace, RUN_ID);
      await mkdir(path.dirname(filePath), { recursive: true });
      // 実際の内容は妥当な小さいJSONにしておき、statFileだけが巨大なサイズを返す
      // ようにする。JSON.parseへ到達する前にstatFileの結果だけで弾かれることを確かめる
      await writeFile(filePath, '{}');

      const fakeFs: typeof nodePseudoWorktreeFileSystem = {
        ...nodePseudoWorktreeFileSystem,
        statFile: async (target) => {
          if (target === filePath) {
            return { size: 500 * 1024 * 1024, mtimeMs: 0 };
          }
          return nodePseudoWorktreeFileSystem.statFile(target);
        },
      };

      const loaded = await loadPersistedManifest(workspace, RUN_ID, fakeFs);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.message).toContain('サイズ');
    },
  );

  it(
    '書き込み直後にrealpathで境界外と判明した場合は撤去して失敗とする' +
      '（レビュー指摘: medium、TOCTOU対策の二段目。cloneWorkspace/ensureIntegrationDirと' +
      '同じ「作成後に実パス解決して境界確認、外れていれば撤去する」二段構えをpersistManifest' +
      'にも対にする）',
    async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-toctou-'));
      try {
        const filePath = integrationManifestPath(workspace, RUN_ID);
        const manifest: IntegrationManifest = new Map([
          ['a.txt', { taskId: 'T1', kind: 'added' }],
        ]);

        // シンボリックリンク検知（一次防御）は通過するが、書き込み直後のrealpathでは
        // 境界外を指すよう差し替え、書き込みと実パス確認の間に経路が差し替えられた
        // 状況（TOCTOU）を再現する
        const fakeFs: typeof nodePseudoWorktreeFileSystem = {
          ...nodePseudoWorktreeFileSystem,
          realpath: async (target) => {
            if (target === filePath) {
              return path.join(outsideDir, 'manifest.json');
            }
            return nodePseudoWorktreeFileSystem.realpath(target);
          },
        };

        await expect(persistManifest(workspace, RUN_ID, manifest, fakeFs)).rejects.toThrow(
          /ワークスペースの外/,
        );

        // 撤去されており、実体としては残っていない
        await expect(readFile(filePath)).rejects.toThrow();
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it(
    '読み込み直後にrealpathで境界外と判明した場合は復元できなかったとして扱う' +
      '（レビュー指摘: medium、TOCTOU対策の二段目）',
    async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-toctou-read-'));
      try {
        const filePath = integrationManifestPath(workspace, RUN_ID);
        await mkdir(path.dirname(filePath), { recursive: true });
        const manifest: IntegrationManifest = new Map([
          ['a.txt', { taskId: 'T1', kind: 'added' }],
        ]);
        await writeFile(filePath, serializeManifest(manifest));

        // シンボリックリンク検知（一次防御）は通過するが、読み込み直後のrealpathでは
        // 境界外を指すよう差し替える（一次防御と実I/Oの間に経路が差し替えられた想定）
        const fakeFs: typeof nodePseudoWorktreeFileSystem = {
          ...nodePseudoWorktreeFileSystem,
          realpath: async (target) => {
            if (target === filePath) {
              return path.join(outsideDir, 'manifest.json');
            }
            return nodePseudoWorktreeFileSystem.realpath(target);
          },
        };

        const loaded = await loadPersistedManifest(workspace, RUN_ID, fakeFs);
        expect(loaded.ok).toBe(false);
        if (loaded.ok) return;
        expect(loaded.message).toContain('復元できません');
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  describe('反映処理の境界検証（Issue #433 / #406）', () => {
    /**
     * `reflectIntegrationToWorkspace`は他の4経路（`cloneWorkspace` /
     * `ensureIntegrationDir` / `loadPersistedManifest` / `persistManifest`）と違い、
     * 字面の判定（`isPathWithinRoot`）しか持っていなかった。マニフェストのキーが
     * 永続化ファイル由来（＝外部入力）になった（Issue #380）ことで、ワークスペース内に
     * 実在するシンボリックリンクを経由して境界外へ書き込む・境界外を削除するキーが
     * 通りうる。`listFiles`がシンボリックリンクを除外するため、`workspaceChanged`の
     * 保護もこの経路を検知できない。
     */
    it('シンボリックリンクのディレクトリを経由して境界外へ書き込まない（受入基準）', async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        // ワークスペース内に、外部ディレクトリを指すシンボリックリンクが実在する状況
        await symlink(outsideDir, path.join(workspace, 'linked-dir'));

        const integration = await ensureIntegrationDir(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );
        expect(integration.ok).toBe(true);
        if (!integration.ok) return;
        await mkdir(path.join(integration.dir, 'linked-dir'), { recursive: true });
        await writeFile(path.join(integration.dir, 'linked-dir', 'evil.txt'), 'evil\n');

        // シンボリックリンクはスナップショットに現れないため、workspaceChangedでは止まらない
        const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
        const maliciousManifest: IntegrationManifest = new Map([
          ['linked-dir/evil.txt', { taskId: 'T1', kind: 'modified' }],
        ]);

        const result = await reflectIntegrationToWorkspace(
          workspace,
          integration.dir,
          workspaceBaseline,
          maliciousManifest,
          [],
          nodePseudoWorktreeFileSystem,
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('partialApply');
        if (result.reason !== 'partialApply') return;
        expect(result.failedPath).toBe('linked-dir/evil.txt');
        expect(result.appliedPaths).toEqual([]);
        // リンク先（ワークスペースの外）には何も書かれていない
        await expect(readdir(outsideDir)).resolves.toEqual([]);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('シンボリックリンクを経由して境界外のファイルを削除しない（受入基準）', async () => {
      const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-outside-'));
      try {
        await writeFile(path.join(outsideDir, 'secret.txt'), 'secret\n');
        await symlink(path.join(outsideDir, 'secret.txt'), path.join(workspace, 'link.txt'));

        const integration = await ensureIntegrationDir(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );
        expect(integration.ok).toBe(true);
        if (!integration.ok) return;

        const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
        const maliciousManifest: IntegrationManifest = new Map([
          ['link.txt', { taskId: 'T1', kind: 'deleted' }],
        ]);

        const result = await reflectIntegrationToWorkspace(
          workspace,
          integration.dir,
          workspaceBaseline,
          maliciousManifest,
          [],
          nodePseudoWorktreeFileSystem,
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('partialApply');
        // リンク先（ワークスペースの外）のファイルが消えていない
        await expect(readFile(path.join(outsideDir, 'secret.txt'), 'utf8')).resolves.toBe(
          'secret\n',
        );
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('.gitセグメントを含むキーは反映しない（受入基準、Issue #406）', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      await mkdir(path.join(integration.dir, '.git', 'hooks'), { recursive: true });
      await writeFile(path.join(integration.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');

      const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
      const maliciousManifest: IntegrationManifest = new Map([
        ['.git/hooks/pre-commit', { taskId: 'T1', kind: 'added' }],
      ]);

      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        maliciousManifest,
        [],
        nodePseudoWorktreeFileSystem,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('partialApply');
      if (result.reason !== 'partialApply') return;
      expect(result.failedPath).toBe('.git/hooks/pre-commit');
      await expect(readFile(path.join(workspace, '.git', 'hooks', 'pre-commit'))).rejects.toThrow();
    });

    it('大文字小文字が違っても.gitセグメントとして拒否する（macOSのAPFS対策）', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      // 実体を用意しておく（用意しないとコピー元が無いというだけで失敗し、
      // 拒否できているのかどうかを検証できない）
      await mkdir(path.join(integration.dir, '.GIT'), { recursive: true });
      await writeFile(path.join(integration.dir, '.GIT', 'config'), '[core]\n');

      const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        new Map([['.GIT/config', { taskId: 'T1', kind: 'added' as const }]]),
        [],
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toMatchObject({ ok: false, reason: 'partialApply' });
      await expect(readFile(path.join(workspace, '.GIT', 'config'))).rejects.toThrow();
    });

    it('除外設定（node_modules等）に該当するキーは反映しない', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      await mkdir(path.join(integration.dir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(path.join(integration.dir, 'node_modules', 'pkg', 'index.js'), 'evil\n');

      const exclude = [...DEFAULT_PSEUDO_WORKTREE_EXCLUDE];
      const workspaceBaseline = await takeSnapshot(
        workspace,
        exclude,
        nodePseudoWorktreeFileSystem,
      );
      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        new Map([['node_modules/pkg/index.js', { taskId: 'T1', kind: 'added' as const }]]),
        exclude,
        nodePseudoWorktreeFileSystem,
      );

      // 中断ではなくスキップ（レビュー指摘: medium、Issue #433）。反映自体は成功として
      // 返し、スキップしたパスを`skippedPaths`で呼び出し側へ渡す
      expect(result).toMatchObject({
        ok: true,
        appliedPaths: [],
        skippedPaths: ['node_modules/pkg/index.js'],
      });
      await expect(
        readFile(path.join(workspace, 'node_modules', 'pkg', 'index.js')),
      ).rejects.toThrow();
    });

    /**
     * `exclude`は起動時に固定される一方、`loadPersistedManifest`はディスク上のマニフェストを
     * `exclude`と無関係に復元する。そのため「前回実行時のexclude設定下で正当に作られたキーが、
     * 設定変更後の今回のexcludeに一致する」設定ドリフトが構造的に起こりうる。ここで反映全体を
     * 中断すると、Mapの反復順で後ろにある正当なエントリまで一律で未適用になってしまう。
     */
    it('除外に該当するキーがあっても、後続の正当なエントリは反映される（受入基準、Issue #433）', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      await mkdir(path.join(integration.dir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(path.join(integration.dir, 'node_modules', 'pkg', 'index.js'), 'evil\n');
      await mkdir(path.join(integration.dir, 'src'), { recursive: true });
      await writeFile(path.join(integration.dir, 'src', 'after.ts'), 'export const after = 1;\n');

      const exclude = [...DEFAULT_PSEUDO_WORKTREE_EXCLUDE];
      const workspaceBaseline = await takeSnapshot(
        workspace,
        exclude,
        nodePseudoWorktreeFileSystem,
      );
      // 除外に該当するキーを**先**に置き、その後ろに正当なキーを置く（Mapは挿入順に反復する）
      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        new Map([
          ['node_modules/pkg/index.js', { taskId: 'T1', kind: 'added' as const }],
          ['src/after.ts', { taskId: 'T1', kind: 'added' as const }],
        ]),
        exclude,
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toMatchObject({
        ok: true,
        appliedPaths: ['src/after.ts'],
        skippedPaths: ['node_modules/pkg/index.js'],
      });
      await expect(readFile(path.join(workspace, 'src', 'after.ts'), 'utf8')).resolves.toBe(
        'export const after = 1;\n',
      );
      await expect(
        readFile(path.join(workspace, 'node_modules', 'pkg', 'index.js')),
      ).rejects.toThrow();
    });

    /**
     * `.git`セグメントは`isExcludedPath`と違い、攻撃シナリオが明確で正当なマニフェストに
     * 入る筋が無いため、1件でも現れたらマニフェスト全体を疑って**反映を中断する**。
     * スキップ扱いにしない（`isExcludedPath`との非対称は意図的）。
     */
    it('.gitセグメントは中断のまま。後続のエントリも適用しない（Issue #433）', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      await mkdir(path.join(integration.dir, '.git', 'hooks'), { recursive: true });
      await writeFile(path.join(integration.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
      await mkdir(path.join(integration.dir, 'src'), { recursive: true });
      await writeFile(path.join(integration.dir, 'src', 'after.ts'), 'export const after = 1;\n');

      const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        new Map([
          ['.git/hooks/pre-commit', { taskId: 'T1', kind: 'added' as const }],
          ['src/after.ts', { taskId: 'T1', kind: 'added' as const }],
        ]),
        [],
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toMatchObject({
        ok: false,
        reason: 'partialApply',
        failedPath: '.git/hooks/pre-commit',
        remainingPaths: ['src/after.ts'],
      });
      await expect(readFile(path.join(workspace, 'src', 'after.ts'))).rejects.toThrow();
    });

    /**
     * `isExcludedPath`（スキップ）と`hasGitSegment`（中断）は扱いが非対称なので、
     * **判定順が意味を持つ**。`isExcludedPath`を先に評価すると、除外対象のディレクトリ名と
     * `.git`セグメントを両方含むキー（`node_modules/.git/hooks/pre-commit`等）がスキップへ
     * 吸われ、`.git`の無条件拒否（Issue #406）へ到達しない。既定の`exclude`のままで成立し、
     * 細工したマニフェストに除外ヒットするダミーを1件混ぜるだけで防御が無効化される。
     */
    /**
     * Issue #445: `realpath`による境界確認と実際の`copyFile`の間にTOCTOU窓があった。
     * `fs.copyFile`はシンボリックリンクを解決して書き込むため、確認直後に反映先
     * （`target`）が外部を指すシンボリックリンクへ差し替えられると、書き込みが
     * 境界外（リンク先）で起きてしまう。一時ファイル+`rename`にすることで、この窓を
     * 実質ゼロにする（`rename`は対象パスの終端がシンボリックリンクであっても解決せず、
     * リンクのエントリそのものを置き換えるため）。
     */
    describe('コピー経路のTOCTOU対策（一時ファイル+rename、Issue #445）', () => {
      it(
        '反映先がコピー直前にシンボリックリンクへ差し替えられても、' +
          'リンク先（ワークスペースの外）を書き換えずに反映が完了する（受入基準）',
        async () => {
          const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-toctou-target-'));
          try {
            await writeFile(path.join(outsideDir, 'secret.txt'), 'original secret\n');

            const integration = await ensureIntegrationDir(
              workspace,
              RUN_ID,
              nodePseudoWorktreeFileSystem,
            );
            expect(integration.ok).toBe(true);
            if (!integration.ok) return;
            await writeFile(path.join(integration.dir, 'a.txt'), 'integrated content\n');

            const workspaceBaseline = await takeSnapshot(
              workspace,
              [],
              nodePseudoWorktreeFileSystem,
            );
            const manifest: IntegrationManifest = new Map([
              ['a.txt', { taskId: 'T1', kind: 'modified' }],
            ]);

            const targetPath = path.join(workspace, 'a.txt');
            let swapped = false;
            // 一次防御（`mkdir`直後の`realTargetDir`確認）を通過した直後、実際の書き込みの
            // 直前に`target`が外部を指すシンボリックリンクへ差し替えられた状況を再現する
            const raceFs: typeof nodePseudoWorktreeFileSystem = {
              ...nodePseudoWorktreeFileSystem,
              mkdir: async (dir) => {
                await nodePseudoWorktreeFileSystem.mkdir(dir);
                if (!swapped && dir === path.dirname(targetPath)) {
                  swapped = true;
                  await symlink(path.join(outsideDir, 'secret.txt'), targetPath);
                }
              },
            };

            const result = await reflectIntegrationToWorkspace(
              workspace,
              integration.dir,
              workspaceBaseline,
              manifest,
              [],
              raceFs,
            );

            expect(result.ok).toBe(true);
            // リンク先（ワークスペースの外）の内容は書き換えられていない
            await expect(readFile(path.join(outsideDir, 'secret.txt'), 'utf8')).resolves.toBe(
              'original secret\n',
            );
            // ワークスペース側はシンボリックリンクではなく実体に置き換わっている
            const stat = await lstat(targetPath);
            expect(stat.isSymbolicLink()).toBe(false);
            await expect(readFile(targetPath, 'utf8')).resolves.toBe('integrated content\n');
          } finally {
            await rm(outsideDir, { recursive: true, force: true });
          }
        },
      );

      it(
        '一時ファイルの書き込み後にrealpathで境界外と判明した場合、' +
          '一時ファイルを残さず取り消す（クリーンアップの確認）',
        async () => {
          const outsideDir = await mkdtemp(path.join(tmpdir(), 'pseudo-worktree-toctou-temp-'));
          try {
            const integration = await ensureIntegrationDir(
              workspace,
              RUN_ID,
              nodePseudoWorktreeFileSystem,
            );
            expect(integration.ok).toBe(true);
            if (!integration.ok) return;
            await writeFile(path.join(integration.dir, 'new.txt'), 'integrated content\n');

            const workspaceBaseline = await takeSnapshot(
              workspace,
              [],
              nodePseudoWorktreeFileSystem,
            );
            const manifest: IntegrationManifest = new Map([
              ['new.txt', { taskId: 'T1', kind: 'added' }],
            ]);

            // 一時ファイルの実パス確認だけを境界外に見せかけ、TOCTOU二段目の
            // ロールバックを強制的に踏ませる
            const raceFs: typeof nodePseudoWorktreeFileSystem = {
              ...nodePseudoWorktreeFileSystem,
              realpath: async (p) => {
                if (p.includes('.pwt-reflect-')) {
                  return path.join(outsideDir, 'escaped');
                }
                return nodePseudoWorktreeFileSystem.realpath(p);
              },
            };

            const result = await reflectIntegrationToWorkspace(
              workspace,
              integration.dir,
              workspaceBaseline,
              manifest,
              [],
              raceFs,
            );

            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe('partialApply');

            // 一時ファイルが残っていない（クリーンアップ済み）
            const entries = await readdir(workspace);
            expect(entries.some((e) => e.includes('.pwt-reflect-'))).toBe(false);
            // 反映先にも実体は作られていない
            await expect(readFile(path.join(workspace, 'new.txt'))).rejects.toThrow();
          } finally {
            await rm(outsideDir, { recursive: true, force: true });
          }
        },
      );

      it(
        '親ディレクトリがワークスペース内の`.git/hooks`へ差し替えられても、' +
          '既存のフックを上書きせずに失敗する（境界内リダイレクト、Issue #484）',
        async () => {
          // `hasGitSegment`（Issue #406）は`relPath`にしか掛からないため、
          // `relPath`自体に`.git`を含まない経路（`sub/pre-commit`）で`targetDir`
          // （`workspace/sub`）を`.git/hooks`へ誘導すれば、事後確認が「境界内か」しか
          // 見ていない旧実装では素通りしてしまう。
          const hooksDir = path.join(workspace, '.git', 'hooks');
          await mkdir(hooksDir, { recursive: true });
          await writeFile(path.join(hooksDir, 'pre-commit'), 'original-hook\n');

          const integration = await ensureIntegrationDir(
            workspace,
            RUN_ID,
            nodePseudoWorktreeFileSystem,
          );
          expect(integration.ok).toBe(true);
          if (!integration.ok) return;
          await mkdir(path.join(integration.dir, 'sub'), { recursive: true });
          await writeFile(path.join(integration.dir, 'sub', 'pre-commit'), 'PWNED-PAYLOAD\n');

          const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
          const manifest: IntegrationManifest = new Map([
            ['sub/pre-commit', { taskId: 'T1', kind: 'added' }],
          ]);

          const targetDir = path.join(workspace, 'sub');
          let swapped = false;
          // `mkdir(targetDir)`直後、`realTargetDir`確認（`fs.realpath(targetDir)`）が
          // まだ差し替え前の実パスを返した直後に、`targetDir`自体を`.git/hooks`への
          // シンボリックリンクへ差し替える（`realTargetDir`確認と一時ファイル書き込みの
          // 間のTOCTOU窓を再現する）
          const raceFs: typeof nodePseudoWorktreeFileSystem = {
            ...nodePseudoWorktreeFileSystem,
            realpath: async (target) => {
              const result = await nodePseudoWorktreeFileSystem.realpath(target);
              if (!swapped && target === targetDir) {
                swapped = true;
                await rm(targetDir, { recursive: true, force: true });
                await symlink(hooksDir, targetDir);
              }
              return result;
            },
          };

          const result = await reflectIntegrationToWorkspace(
            workspace,
            integration.dir,
            workspaceBaseline,
            manifest,
            [],
            raceFs,
          );

          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.reason).toBe('partialApply');

          // 既存のフックは書き換わっていない
          await expect(readFile(path.join(hooksDir, 'pre-commit'), 'utf8')).resolves.toBe(
            'original-hook\n',
          );
          // `.git/hooks`配下に一時ファイルも残っていない
          const hooksEntries = await readdir(hooksDir);
          expect(hooksEntries).toEqual(['pre-commit']);
        },
      );

      it(
        '削除対象の親ディレクトリがワークスペース内の`.git/hooks`へ差し替えられても、' +
          '既存のフックを削除せずに失敗する（削除経路の境界内リダイレクト、Issue #484）',
        async () => {
          // 書き込み側と同じ穴（Issue #484）が`kind: 'deleted'`の削除分岐にも
          // 残っていないことの回帰テスト。`relPath`自体に`.git`を含まない経路
          // （`sub/pre-commit`）で`target`の親ディレクトリ（`workspace/sub`）を
          // `.git/hooks`へ誘導すれば、事後確認が「境界内か」しか見ていない旧実装では
          // 素通りして既存フックが無警告で削除されてしまう。
          const hooksDir = path.join(workspace, '.git', 'hooks');
          await mkdir(hooksDir, { recursive: true });
          await writeFile(path.join(hooksDir, 'pre-commit'), 'original-hook\n');

          const targetDir = path.join(workspace, 'sub');
          await mkdir(targetDir, { recursive: true });
          await writeFile(path.join(targetDir, 'pre-commit'), 'to-be-deleted\n');

          const integration = await ensureIntegrationDir(
            workspace,
            RUN_ID,
            nodePseudoWorktreeFileSystem,
          );
          expect(integration.ok).toBe(true);
          if (!integration.ok) return;

          const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
          const manifest: IntegrationManifest = new Map([
            ['sub/pre-commit', { taskId: 'T1', kind: 'deleted' }],
          ]);

          let swapped = false;
          // `targetDir`の`realpath`確認（削除分岐の`realTargetDir`取得）直後に、
          // `targetDir`自体を`.git/hooks`へのシンボリックリンクへ差し替える
          // （TOCTOU窓の再現。書き込み側の同種テストと同じ形）
          const raceFs: typeof nodePseudoWorktreeFileSystem = {
            ...nodePseudoWorktreeFileSystem,
            realpath: async (target) => {
              const result = await nodePseudoWorktreeFileSystem.realpath(target);
              if (!swapped && target === targetDir) {
                swapped = true;
                await rm(targetDir, { recursive: true, force: true });
                await symlink(hooksDir, targetDir);
              }
              return result;
            },
          };

          const result = await reflectIntegrationToWorkspace(
            workspace,
            integration.dir,
            workspaceBaseline,
            manifest,
            [],
            raceFs,
          );

          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.reason).toBe('partialApply');

          // 既存のフックは削除されていない
          await expect(readFile(path.join(hooksDir, 'pre-commit'), 'utf8')).resolves.toBe(
            'original-hook\n',
          );
          const hooksEntries = await readdir(hooksDir);
          expect(hooksEntries).toEqual(['pre-commit']);
        },
      );

      it(
        '削除対象が既に存在しない場合、エラーにならず正常に処理が続く（`realpath`がundefinedを' +
          '返す正常系。throwにすると壊れる回帰の防止）',
        async () => {
          const integration = await ensureIntegrationDir(
            workspace,
            RUN_ID,
            nodePseudoWorktreeFileSystem,
          );
          expect(integration.ok).toBe(true);
          if (!integration.ok) return;
          await writeFile(path.join(integration.dir, 'kept.txt'), 'kept\n');
          await writeFile(path.join(workspace, 'kept.txt'), 'kept\n');

          const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
          // `already-gone.txt`はワークスペース上に存在しない。削除エントリの対象が
          // 既に無い正常系を再現する
          const manifest: IntegrationManifest = new Map([
            ['already-gone.txt', { taskId: 'T1', kind: 'deleted' }],
            ['kept.txt', { taskId: 'T2', kind: 'modified' }],
          ]);

          const result = await reflectIntegrationToWorkspace(
            workspace,
            integration.dir,
            workspaceBaseline,
            manifest,
            [],
            nodePseudoWorktreeFileSystem,
          );

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          // 既に無い削除対象はエラーにならず処理が続き、後続のエントリも適用される
          expect(result.appliedPaths).toEqual(['kept.txt']);
          // `skippedPaths`は`exclude`に一致したパスを人へ見せるためのものであり、
          // 「削除対象が既に存在しない」はそれとは意味が違うため増えない
          // （`runnerWorkingDirectory.ts`側の警告文言は「除外設定に一致した」前提で
          // 固定されており、ここへ載せると文言と事実が食い違う）
          expect(result.skippedPaths).toEqual([]);
        },
      );

      it(
        '`rename`を持たないポートでは従来の直接コピー経路へフォールバックし、' +
          '`usedLegacyCopyFallback`をtrueで返す（対応漏れ検知用の警告ログの元）',
        async () => {
          const integration = await ensureIntegrationDir(
            workspace,
            RUN_ID,
            nodePseudoWorktreeFileSystem,
          );
          expect(integration.ok).toBe(true);
          if (!integration.ok) return;
          await writeFile(path.join(integration.dir, 'a.txt'), 'integrated content\n');

          const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
          const manifest: IntegrationManifest = new Map([
            ['a.txt', { taskId: 'T1', kind: 'modified' }],
          ]);

          // `rename`を持たないポート実装（`FakePseudoFs`相当）を模して、従来の
          // 直接コピー経路へ意図的にフォールバックさせる。`exactOptionalPropertyTypes`の
          // もとでは`rename: undefined`を代入できないため、プロパティ自体を取り除く
          const noRenameFs: typeof nodePseudoWorktreeFileSystem = {
            ...nodePseudoWorktreeFileSystem,
          };
          delete noRenameFs.rename;

          const result = await reflectIntegrationToWorkspace(
            workspace,
            integration.dir,
            workspaceBaseline,
            manifest,
            [],
            noRenameFs,
          );

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.usedLegacyCopyFallback).toBe(true);
          await expect(readFile(path.join(workspace, 'a.txt'), 'utf8')).resolves.toBe(
            'integrated content\n',
          );
        },
      );

      it('`rename`を持つポート（本番経路）では`usedLegacyCopyFallback`がfalseのまま反映される', async () => {
        const integration = await ensureIntegrationDir(workspace, RUN_ID, nodePseudoWorktreeFileSystem);
        expect(integration.ok).toBe(true);
        if (!integration.ok) return;
        await writeFile(path.join(integration.dir, 'a.txt'), 'integrated content\n');

        const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
        const manifest: IntegrationManifest = new Map([['a.txt', { taskId: 'T1', kind: 'modified' }]]);

        const result = await reflectIntegrationToWorkspace(
          workspace,
          integration.dir,
          workspaceBaseline,
          manifest,
          [],
          nodePseudoWorktreeFileSystem,
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.usedLegacyCopyFallback).toBe(false);
      });
    });

    describe('除外と.gitの判定順（レビュー2巡目の指摘）', () => {
      const gitUnderExcludeCases = [
        ['node_modules', 'node_modules/.git/hooks/pre-commit'],
        ['dist', 'dist/.git/hooks/x'],
      ] as const;

      for (const [dirName, relKey] of gitUnderExcludeCases) {
        it(`既定のexcludeでも${relKey}は中断側に倒れる`, async () => {
          const integration = await ensureIntegrationDir(
            workspace,
            RUN_ID,
            nodePseudoWorktreeFileSystem,
          );
          expect(integration.ok).toBe(true);
          if (!integration.ok) return;
          const keySegments = relKey.split('/');
          await mkdir(path.join(integration.dir, ...keySegments.slice(0, -1)), { recursive: true });
          await writeFile(path.join(integration.dir, ...keySegments), '#!/bin/sh\n');
          await mkdir(path.join(integration.dir, 'src'), { recursive: true });
          await writeFile(
            path.join(integration.dir, 'src', 'after.ts'),
            'export const after = 1;\n',
          );

          const exclude = [...DEFAULT_PSEUDO_WORKTREE_EXCLUDE];
          expect(exclude).toContain(dirName);
          const workspaceBaseline = await takeSnapshot(
            workspace,
            exclude,
            nodePseudoWorktreeFileSystem,
          );
          const result = await reflectIntegrationToWorkspace(
            workspace,
            integration.dir,
            workspaceBaseline,
            new Map([
              [relKey, { taskId: 'T1', kind: 'added' as const }],
              ['src/after.ts', { taskId: 'T1', kind: 'added' as const }],
            ]),
            exclude,
            nodePseudoWorktreeFileSystem,
          );

          // スキップ（`ok: true` + `skippedPaths`）ではなく中断であること
          expect(result).toMatchObject({
            ok: false,
            reason: 'partialApply',
            failedPath: relKey,
            // 中断なので、後ろのエントリは未適用のまま残る
            remainingPaths: ['src/after.ts'],
          });
          await expect(readFile(path.join(workspace, ...keySegments))).rejects.toThrow();
          await expect(readFile(path.join(workspace, 'src', 'after.ts'))).rejects.toThrow();
        });
      }

      /**
       * `agent.workflows.pseudoWorktreeExclude`は`scope: machine-overridable`のユーザー設定で、
       * `normalizePseudoWorktreeExclude`は`.git`を禁止していない。設定側から`.git`を入れても
       * 無条件拒否が効き続けること。
       */
      it('excludeに.gitを明示的に含めた設定でも中断側に倒れる', async () => {
        const integration = await ensureIntegrationDir(
          workspace,
          RUN_ID,
          nodePseudoWorktreeFileSystem,
        );
        expect(integration.ok).toBe(true);
        if (!integration.ok) return;
        await mkdir(path.join(integration.dir, '.git', 'hooks'), { recursive: true });
        await writeFile(path.join(integration.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
        await mkdir(path.join(integration.dir, 'src'), { recursive: true });
        await writeFile(path.join(integration.dir, 'src', 'after.ts'), 'export const after = 1;\n');

        const exclude = [...DEFAULT_PSEUDO_WORKTREE_EXCLUDE, '.git'];
        const workspaceBaseline = await takeSnapshot(
          workspace,
          exclude,
          nodePseudoWorktreeFileSystem,
        );
        const result = await reflectIntegrationToWorkspace(
          workspace,
          integration.dir,
          workspaceBaseline,
          new Map([
            ['.git/hooks/pre-commit', { taskId: 'T1', kind: 'added' as const }],
            ['src/after.ts', { taskId: 'T1', kind: 'added' as const }],
          ]),
          exclude,
          nodePseudoWorktreeFileSystem,
        );

        expect(result).toMatchObject({
          ok: false,
          reason: 'partialApply',
          failedPath: '.git/hooks/pre-commit',
          remainingPaths: ['src/after.ts'],
        });
        await expect(
          readFile(path.join(workspace, '.git', 'hooks', 'pre-commit')),
        ).rejects.toThrow();
        await expect(readFile(path.join(workspace, 'src', 'after.ts'))).rejects.toThrow();
      });
    });

    it('通常のキーは従来どおり反映される（既存の正常系を壊していないことの確認）', async () => {
      const integration = await ensureIntegrationDir(
        workspace,
        RUN_ID,
        nodePseudoWorktreeFileSystem,
      );
      expect(integration.ok).toBe(true);
      if (!integration.ok) return;
      await mkdir(path.join(integration.dir, 'src'), { recursive: true });
      await writeFile(path.join(integration.dir, 'src', 'index.ts'), 'export {};\n');

      const workspaceBaseline = await takeSnapshot(workspace, [], nodePseudoWorktreeFileSystem);
      const result = await reflectIntegrationToWorkspace(
        workspace,
        integration.dir,
        workspaceBaseline,
        new Map([['src/index.ts', { taskId: 'T1', kind: 'added' as const }]]),
        [],
        nodePseudoWorktreeFileSystem,
      );

      expect(result).toMatchObject({ ok: true, appliedPaths: ['src/index.ts'] });
      await expect(readFile(path.join(workspace, 'src', 'index.ts'), 'utf8')).resolves.toBe(
        'export {};\n',
      );
    });
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
      readTextFile: async () => undefined,
      writeTextFile: async () => {},
      removeDirRecursive: async () => {},
      removeEmptyDir: async () => {},
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
