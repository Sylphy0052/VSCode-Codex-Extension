import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  handoffPath,
  handoffRunDir,
  MAX_HANDOFF_BYTES,
  MAX_HANDOFF_FILES_PER_RUN,
  parseHandoffFileName,
  TeamHandoffStore,
  type HandoffFileSystemPort,
} from '../../src/orchestrator/teamHandoff';

/** `runId`はUUID形式で検証されるため、テスト全体で1つの妥当なUUIDを使い回す。 */
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ROOT = '/repo';

/**
 * `HandoffFileSystemPort`のインメモリfake。`fsGuards.test.ts`の`FakeSymlinkPort`と同じ
 * 「実ファイルシステムに触れない」方針で、ディレクトリ・ファイルの状態をMapで持つ。
 */
class FakeHandoffFileSystem implements HandoffFileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  private readonly symlinks: Set<string>;
  /**
   * 書き換える操作を失敗させたいテスト用。ここへ操作名を入れると、その操作が`false`を
   * 返す（実ファイルシステムの権限エラー・容量不足に相当する）。
   */
  readonly failing = new Set<
    'makeDirectory' | 'writeTextFile' | 'removeFile' | 'removeDirectory'
  >();

  constructor(symlinks: readonly string[] = []) {
    this.symlinks = new Set(symlinks);
  }

  async isSymbolicLink(target: string): Promise<boolean> {
    return this.symlinks.has(target);
  }

  async makeDirectory(target: string): Promise<boolean> {
    if (this.failing.has('makeDirectory')) {
      return false;
    }
    this.dirs.add(target);
    return true;
  }

  async writeTextFile(target: string, content: string): Promise<boolean> {
    if (this.failing.has('writeTextFile')) {
      return false;
    }
    this.files.set(target, content);
    return true;
  }

  async readTextFile(target: string): Promise<string | undefined> {
    return this.files.get(target);
  }

  async listDirectory(target: string): Promise<string[]> {
    const prefix = target.endsWith(path.sep) ? target : target + path.sep;
    const names: string[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes(path.sep)) {
        names.push(filePath.slice(prefix.length));
      }
    }
    return names;
  }

  async removeFile(target: string): Promise<boolean> {
    if (this.failing.has('removeFile')) {
      return false;
    }
    this.files.delete(target);
    return true;
  }

  async removeDirectory(target: string): Promise<boolean> {
    if (this.failing.has('removeDirectory')) {
      return false;
    }
    const prefix = target.endsWith(path.sep) ? target : target + path.sep;
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
      }
    }
    this.dirs.delete(target);
    return true;
  }

  /** テストの検証用：直接書き込んだ本文を取り出す。 */
  raw(target: string): string | undefined {
    return this.files.get(target);
  }
}

describe('handoffPath / handoffRunDir', () => {
  it('runId/taskId/slugから `<taskId>-<slug>.md` のパスを組み立てる', () => {
    const p = handoffPath(REPO_ROOT, RUN_ID, 'T1', 'design-note');
    expect(p).toBe(path.join(REPO_ROOT, '.agents', 'handoff', 'runs', RUN_ID, 'T1-design-note.md'));
  });

  it('不正なrunIdは例外を投げる', () => {
    expect(() => handoffPath(REPO_ROOT, 'not-a-uuid', 'T1', 'slug')).toThrow('不正なrunId');
  });

  it('不正なtaskIdは例外を投げる', () => {
    expect(() => handoffPath(REPO_ROOT, RUN_ID, '-bad', 'slug')).toThrow('不正なtaskId');
  });

  it('不正な文字を含むslugは例外を投げる', () => {
    expect(() => handoffPath(REPO_ROOT, RUN_ID, 'T1', '../escape')).toThrow('不正なスラッグ');
    expect(() => handoffPath(REPO_ROOT, RUN_ID, 'T1', 'has/slash')).toThrow('不正なスラッグ');
    expect(() => handoffPath(REPO_ROOT, RUN_ID, 'T1', '')).toThrow('不正なスラッグ');
  });
});

describe('parseHandoffFileName（最後のハイフンで分割する）', () => {
  it('taskId-slug.md を分解する', () => {
    expect(parseHandoffFileName('T1-note.md')).toEqual({ taskId: 'T1', slug: 'note' });
  });

  it('taskIdがハイフンを含んでいても、最後のハイフンで区切ってslugを取り出す', () => {
    // taskId自体に`-`が入りうる（`TASK_ID_PATTERN`はハイフンを許すため）。
    // `handoffPath`が組み立てる形（スラッグは末尾）に合わせ、最後のハイフンで割る
    expect(parseHandoffFileName('implement-feature-note.md')).toEqual({
      taskId: 'implement-feature',
      slug: 'note',
    });
  });

  it('.mdで終わらない名前はundefined', () => {
    expect(parseHandoffFileName('T1-note.txt')).toBeUndefined();
  });

  it('ハイフンを含まない名前はundefined（区切りが定まらない）', () => {
    expect(parseHandoffFileName('note.md')).toBeUndefined();
  });

  it('ハイフンが先頭または末尾直前にしか無い場合はundefined（taskId/slugが空になる）', () => {
    expect(parseHandoffFileName('-note.md')).toBeUndefined();
    expect(parseHandoffFileName('T1-.md')).toBeUndefined();
  });

  it('slugの字種が不正ならundefined', () => {
    expect(parseHandoffFileName('T1-has/slash.md')).toBeUndefined();
  });
});

describe('TeamHandoffStore', () => {
  const runDir = handoffRunDir(REPO_ROOT, RUN_ID);

  it('write→readの正常系: 書いた内容がそのまま読める', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const writeResult = await store.write(RUN_ID, 'T1', 'note', '内容');
    expect(writeResult.ok).toBe(true);
    if (writeResult.ok) {
      expect(writeResult.value).toEqual({
        taskId: 'T1',
        slug: 'note',
        relativePath: path.join('.agents', 'handoff', 'runs', RUN_ID, 'T1-note.md'),
      });
    }

    const readResult = await store.read(RUN_ID, 'T1', 'note');
    expect(readResult).toEqual({ ok: true, value: '内容' });
  });

  it('write→listの正常系: 一覧に登場する', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    await store.write(RUN_ID, 'T1', 'note', '内容1');
    await store.write(RUN_ID, 'T2', 'design', '内容2');

    const entries = await store.list(RUN_ID);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          taskId: 'T1',
          slug: 'note',
          relativePath: path.join('.agents', 'handoff', 'runs', RUN_ID, 'T1-note.md'),
        },
        {
          taskId: 'T2',
          slug: 'design',
          relativePath: path.join('.agents', 'handoff', 'runs', RUN_ID, 'T2-design.md'),
        },
      ]),
    );
  });

  it('listは想定外の名前のファイルを除外する', async () => {
    const fs = new FakeHandoffFileSystem();
    await fs.makeDirectory(runDir);
    await fs.writeTextFile(path.join(runDir, '人が置いたファイル.txt'), 'x');
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const entries = await store.list(RUN_ID);
    expect(entries).toEqual([]);
  });

  it('write→removeの正常系: 消した後は読めなくなる', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    await store.write(RUN_ID, 'T1', 'note', '内容');

    const removeResult = await store.remove(RUN_ID, 'T1', 'note');
    expect(removeResult).toEqual({ ok: true, value: undefined });

    const readResult = await store.read(RUN_ID, 'T1', 'note');
    expect(readResult).toEqual({
      ok: false,
      error: '受け渡しファイルが見つかりません: T1-note.md',
    });
  });

  it('存在しないファイルのremoveも成功として扱う', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    const removeResult = await store.remove(RUN_ID, 'T1', 'note');
    expect(removeResult).toEqual({ ok: true, value: undefined });
  });

  it('removeRunの正常系: runのディレクトリごと消え、listが空になる', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    await store.write(RUN_ID, 'T1', 'note', '内容1');
    await store.write(RUN_ID, 'T2', 'design', '内容2');

    const removeRunResult = await store.removeRun(RUN_ID);
    expect(removeRunResult).toEqual({ ok: true, value: undefined });

    const entries = await store.list(RUN_ID);
    expect(entries).toEqual([]);
  });

  it('不正なslugのwriteは書き込まずにエラーを返す', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    const result = await store.write(RUN_ID, 'T1', '../escape', '内容');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不正なスラッグ');
    }
    expect(await store.list(RUN_ID)).toEqual([]);
  });

  it('不正なtaskIdのwriteは書き込まずにエラーを返す', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    const result = await store.write(RUN_ID, '-bad', 'note', '内容');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不正なtaskId');
    }
  });

  it('MAX_HANDOFF_BYTESを超える本文は拒否する', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    const tooLarge = 'a'.repeat(MAX_HANDOFF_BYTES + 1);

    const result = await store.write(RUN_ID, 'T1', 'note', tooLarge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`上限(${MAX_HANDOFF_BYTES}バイト)`);
    }
    expect(await store.read(RUN_ID, 'T1', 'note')).toEqual({
      ok: false,
      error: '受け渡しファイルが見つかりません: T1-note.md',
    });
  });

  it('ちょうどMAX_HANDOFF_BYTESの本文は許容する', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    const exact = 'a'.repeat(MAX_HANDOFF_BYTES);

    const result = await store.write(RUN_ID, 'T1', 'note', exact);
    expect(result.ok).toBe(true);
  });

  it('MAX_HANDOFF_FILES_PER_RUNを超える新規ファイルは拒否する', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    for (let i = 0; i < MAX_HANDOFF_FILES_PER_RUN; i++) {
      const result = await store.write(RUN_ID, `T${i}`, 'note', '内容');
      expect(result.ok).toBe(true);
    }

    const overflow = await store.write(RUN_ID, 'TOVER', 'note', '内容');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error).toContain(`上限(${MAX_HANDOFF_FILES_PER_RUN}件)`);
    }
  });

  it('上限に達していても既存ファイルの上書きは許容する（件数を増やさないため）', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    for (let i = 0; i < MAX_HANDOFF_FILES_PER_RUN; i++) {
      await store.write(RUN_ID, `T${i}`, 'note', '内容');
    }

    const overwrite = await store.write(RUN_ID, 'T0', 'note', '更新後の内容');
    expect(overwrite.ok).toBe(true);
    expect(await store.read(RUN_ID, 'T0', 'note')).toEqual({ ok: true, value: '更新後の内容' });
  });

  it('祖先にシンボリックリンクがあるとwriteを拒否する', async () => {
    const linkedRunsDir = path.join(REPO_ROOT, '.agents', 'handoff', 'runs');
    const fs = new FakeHandoffFileSystem([linkedRunsDir]);
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const result = await store.write(RUN_ID, 'T1', 'note', '内容');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('シンボリックリンク');
    }
  });

  it('祖先にシンボリックリンクがあるとreadを拒否する', async () => {
    const linkedRunsDir = path.join(REPO_ROOT, '.agents', 'handoff', 'runs');
    const fs = new FakeHandoffFileSystem([linkedRunsDir]);
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const result = await store.read(RUN_ID, 'T1', 'note');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('シンボリックリンク');
    }
  });

  it('祖先にシンボリックリンクがあるとlistは空配列を返す', async () => {
    const linkedRunsDir = path.join(REPO_ROOT, '.agents', 'handoff', 'runs');
    const fs = new FakeHandoffFileSystem([linkedRunsDir]);
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    expect(await store.list(RUN_ID)).toEqual([]);
  });

  it('祖先にシンボリックリンクがあるとremoveを拒否する', async () => {
    const linkedRunsDir = path.join(REPO_ROOT, '.agents', 'handoff', 'runs');
    const fs = new FakeHandoffFileSystem([linkedRunsDir]);
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const result = await store.remove(RUN_ID, 'T1', 'note');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('シンボリックリンク');
    }
  });

  it('祖先にシンボリックリンクがあるとremoveRunを拒否する', async () => {
    const linkedRunsDir = path.join(REPO_ROOT, '.agents', 'handoff', 'runs');
    const fs = new FakeHandoffFileSystem([linkedRunsDir]);
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const result = await store.removeRun(RUN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('シンボリックリンク');
    }
  });
});

describe('ファイルシステムの失敗を握り潰さない（PR #711 自己レビュー指摘: high）', () => {
  it('書き込みに失敗したらok: falseを返す（「書き込みました」と嘘をつかない）', async () => {
    const fs = new FakeHandoffFileSystem();
    fs.failing.add('writeTextFile');
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const result = await store.write(RUN_ID, 'T1', 'notes', '本文');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('書き込めませんでした');
    }
  });

  it('置き場を作れなければ、書き込みを試みる前にok: falseを返す', async () => {
    const fs = new FakeHandoffFileSystem();
    fs.failing.add('makeDirectory');
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const result = await store.write(RUN_ID, 'T1', 'notes', '本文');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('置き場を作れませんでした');
    }
    // 書き込みまで進んでいないこと（後片付けの対象になるファイルを作らない）
    expect(fs.raw(handoffPath(REPO_ROOT, RUN_ID, 'T1', 'notes'))).toBeUndefined();
  });

  it('書き込みに失敗したファイルは実体としても残らない', async () => {
    const fs = new FakeHandoffFileSystem();
    fs.failing.add('writeTextFile');
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    await store.write(RUN_ID, 'T1', 'notes', '本文');

    expect(fs.raw(handoffPath(REPO_ROOT, RUN_ID, 'T1', 'notes'))).toBeUndefined();
  });

  it('削除に失敗したらok: falseを返す', async () => {
    const fs = new FakeHandoffFileSystem();
    const store = new TeamHandoffStore(REPO_ROOT, fs);
    await store.write(RUN_ID, 'T1', 'notes', '本文');
    fs.failing.add('removeFile');

    const result = await store.remove(RUN_ID, 'T1', 'notes');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('削除できませんでした');
    }
  });

  it('runの片付けに失敗したらok: falseを返す（呼び出し側がログに残せる）', async () => {
    const fs = new FakeHandoffFileSystem();
    fs.failing.add('removeDirectory');
    const store = new TeamHandoffStore(REPO_ROOT, fs);

    const result = await store.removeRun(RUN_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('削除できませんでした');
    }
  });
});
