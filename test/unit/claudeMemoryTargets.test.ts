import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMemoryAppendConfirmMessage,
  buildMemoryAppendContent,
  buildMemoryAppendItem,
  listMemoryTargets,
  nodeMemoryFilePort,
  orderMemoryTargets,
  resolveUserMemoryPath,
  type MemoryFilePort,
} from '../../src/claude/memoryTargets';

function fakePort(existingPaths: readonly string[]): MemoryFilePort {
  const existing = new Set(existingPaths);
  return {
    exists: async (filePath) => existing.has(filePath),
    readTextFile: async () => undefined,
    writeTextFile: async () => undefined,
    resolveSymlinkTarget: async () => undefined,
  };
}

describe('resolveUserMemoryPath', () => {
  it('configDirが空でなければそちら配下のCLAUDE.mdを指す', () => {
    expect(resolveUserMemoryPath('/custom/config')).toBe(path.join('/custom/config', 'CLAUDE.md'));
  });

  it('configDirが空ならホームディレクトリの.claude配下を指す', () => {
    const result = resolveUserMemoryPath('');
    expect(result.endsWith(path.join('.claude', 'CLAUDE.md'))).toBe(true);
  });
});

describe('listMemoryTargets', () => {
  it('複数のworkspaceFolderそれぞれのCLAUDE.mdとユーザーメモリを列挙する', async () => {
    const port = fakePort([]);
    const targets = await listMemoryTargets(
      [
        { name: 'proj-a', path: '/ws/proj-a' },
        { name: 'proj-b', path: '/ws/proj-b' },
      ],
      '/config',
      port,
    );

    expect(targets).toHaveLength(3);
    expect(targets[0]?.filePath).toBe(path.join('/ws/proj-a', 'CLAUDE.md'));
    expect(targets[0]?.label).toContain('proj-a');
    expect(targets[1]?.filePath).toBe(path.join('/ws/proj-b', 'CLAUDE.md'));
    expect(targets[2]?.filePath).toBe(path.join('/config', 'CLAUDE.md'));
    expect(targets[2]?.label).toContain('ユーザーメモリ');
  });

  it('実在するファイルは「既存」、無いファイルは「新規作成」とラベルに出す', async () => {
    const projPath = path.join('/ws/proj-a', 'CLAUDE.md');
    const userPath = path.join('/config', 'CLAUDE.md');
    const port = fakePort([projPath]);
    const targets = await listMemoryTargets(
      [{ name: 'proj-a', path: '/ws/proj-a' }],
      '/config',
      port,
    );

    expect(targets[0]?.exists).toBe(true);
    expect(targets[0]?.label).toContain('既存');
    expect(targets[1]?.exists).toBe(false);
    expect(targets[1]?.label).toContain('新規作成');
    expect(targets[1]?.filePath).toBe(userPath);
  });

  it('workspaceFolderが無ければユーザーメモリだけを返す', async () => {
    const targets = await listMemoryTargets([], '', fakePort([]));
    expect(targets).toHaveLength(1);
    expect(targets[0]?.label).toContain('ユーザーメモリ');
  });
});

describe('orderMemoryTargets', () => {
  const targets = [
    { label: 'a', description: '/a', filePath: '/a', exists: true },
    { label: 'b', description: '/b', filePath: '/b', exists: true },
    { label: 'c', description: '/c', filePath: '/c', exists: true },
  ];

  it('前回選んだ追記先があれば先頭へ並べ替える', () => {
    const ordered = orderMemoryTargets(targets, '/c');
    expect(ordered.map((t) => t.filePath)).toEqual(['/c', '/a', '/b']);
  });

  it('前回の選択が既に先頭なら並びは変わらない', () => {
    const ordered = orderMemoryTargets(targets, '/a');
    expect(ordered.map((t) => t.filePath)).toEqual(['/a', '/b', '/c']);
  });

  it('前回の選択が候補に無ければ元の順のまま', () => {
    const ordered = orderMemoryTargets(targets, '/not-found');
    expect(ordered.map((t) => t.filePath)).toEqual(['/a', '/b', '/c']);
  });

  it('前回の選択が無ければ元の順のまま', () => {
    const ordered = orderMemoryTargets(targets, undefined);
    expect(ordered.map((t) => t.filePath)).toEqual(['/a', '/b', '/c']);
  });
});

describe('buildMemoryAppendContent', () => {
  it('ファイルが無ければ箇条書き1行を新規作成する', () => {
    expect(buildMemoryAppendContent(undefined, 'メモ')).toBe('- メモ\n');
  });

  it('既存ファイルの末尾が改行で終わっていれば、そのまま追記する', () => {
    expect(buildMemoryAppendContent('既存の内容\n', 'メモ')).toBe('既存の内容\n- メモ\n');
  });

  it('既存ファイルの末尾が改行で終わっていなければ、改行を1つ足してから追記する', () => {
    expect(buildMemoryAppendContent('既存の内容', 'メモ')).toBe('既存の内容\n- メモ\n');
  });

  it('複数行のノートは2行目以降を2スペースインデントして1つの箇条書きに収める', () => {
    expect(buildMemoryAppendContent(undefined, '見出し\n詳細1\n詳細2')).toBe(
      '- 見出し\n  詳細1\n  詳細2\n',
    );
  });
});

describe('buildMemoryAppendItem', () => {
  it('memoryAppend種別で、追記先パス（detail）とノート本文（text）を持つ項目を作る', () => {
    const item = buildMemoryAppendItem('id-1', '/ws/CLAUDE.md', 'メモ本文');
    expect(item).toMatchObject({
      id: 'id-1',
      kind: 'memoryAppend',
      text: 'メモ本文',
      detail: '/ws/CLAUDE.md',
    });
  });

  it('symlinkTargetを渡すと、detailへリンク先も含める（レビュー指摘: シンボリックリンク追従）', () => {
    const item = buildMemoryAppendItem('id-1', '/ws/CLAUDE.md', 'メモ本文', '/real/CLAUDE.md');
    expect(item.detail).toBe('/ws/CLAUDE.md（リンク先: /real/CLAUDE.md）');
  });
});

describe('buildMemoryAppendConfirmMessage', () => {
  it('symlinkTargetが無ければ追記先パスと本文だけを出す', () => {
    const message = buildMemoryAppendConfirmMessage('/ws/CLAUDE.md', 'メモ本文', undefined);
    expect(message).toContain('追記先: /ws/CLAUDE.md');
    expect(message).toContain('メモ本文');
    expect(message).not.toContain('リンク先');
  });

  it('symlinkTargetがあれば「リンク先」の行を足す（レビュー指摘: シンボリックリンク追従で書き込み先がすり替わる）', () => {
    const message = buildMemoryAppendConfirmMessage('/ws/CLAUDE.md', 'メモ本文', '/real/CLAUDE.md');
    expect(message).toContain('追記先: /ws/CLAUDE.md');
    expect(message).toContain('リンク先: /real/CLAUDE.md');
    expect(message).toContain('メモ本文');
  });
});

/**
 * `nodeMemoryFilePort` は実際のfsを叩く（`nodePseudoWorktreeFileSystem` のテストと同じ流儀）。
 * 一時ディレクトリを毎テスト作り直し、後始末する。
 */
describe('nodeMemoryFilePort', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'memory-file-port-'));
  });

  afterEach(async () => {
    await fsPromises.rm(workDir, { recursive: true, force: true });
  });

  describe('readTextFile', () => {
    it('ファイルが無ければ（ENOENT）undefinedを返す', async () => {
      const missing = path.join(workDir, 'no-such-file.md');
      await expect(nodeMemoryFilePort.readTextFile(missing)).resolves.toBeUndefined();
    });

    it('実在するファイルの中身を返す', async () => {
      const filePath = path.join(workDir, 'CLAUDE.md');
      await fsPromises.writeFile(filePath, '既存の内容\n', 'utf8');
      await expect(nodeMemoryFilePort.readTextFile(filePath)).resolves.toBe('既存の内容\n');
    });

    it('ENOENT以外の例外（EISDIR）は握り潰さず投げる（レビュー指摘: 既存メモリファイルの内容破壊）', async () => {
      // ディレクトリをreadFileすると必ずEISDIRになる（実行ユーザーの権限に依存せず再現できる）
      await expect(nodeMemoryFilePort.readTextFile(workDir)).rejects.toThrow();
    });
  });

  describe('resolveSymlinkTarget', () => {
    it('シンボリックリンクなら実体の絶対パスを返す', async () => {
      const realFile = path.join(workDir, 'real-CLAUDE.md');
      const linkFile = path.join(workDir, 'CLAUDE.md');
      await fsPromises.writeFile(realFile, 'x', 'utf8');
      await fsPromises.symlink(realFile, linkFile);

      const resolved = await nodeMemoryFilePort.resolveSymlinkTarget(linkFile);
      expect(resolved).toBe(await fsPromises.realpath(realFile));
    });

    it('シンボリックリンクでない実ファイルはundefinedを返す', async () => {
      const filePath = path.join(workDir, 'CLAUDE.md');
      await fsPromises.writeFile(filePath, 'x', 'utf8');
      await expect(nodeMemoryFilePort.resolveSymlinkTarget(filePath)).resolves.toBeUndefined();
    });

    it('存在しないパスはundefinedを返す（機能自体は壊さない防御）', async () => {
      const missing = path.join(workDir, 'no-such-file.md');
      await expect(nodeMemoryFilePort.resolveSymlinkTarget(missing)).resolves.toBeUndefined();
    });
  });
});
