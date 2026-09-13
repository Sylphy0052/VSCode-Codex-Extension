import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileRewindJournal } from '../../src/appserver/fileRewind';
import { normalizeItem as normalize, readRewindChanges } from '../../src/appserver/chatState';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

function normalizeItem(value: unknown) {
  const item = normalize(value);
  if (!item) throw new Error('Invalid fixture');
  return item;
}

const roots: string[] = [];
function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'file-rewind-'));
  roots.push(cwd);
  const journal = new FileRewindJournal();
  const items = [normalizeItem({ id: 'u1', type: 'userMessage' })];
  const write = (name: string, text: string) => fs.writeFileSync(path.join(cwd, name), text);
  const read = (name: string) => fs.readFileSync(path.join(cwd, name), 'utf8');
  const capture = (id: string, name: string, kind: string, diff: string, move?: string) => {
    journal.capture(
      cwd,
      id,
      readRewindChanges([{ path: name, kind: { type: kind, move_path: move }, diff }]),
    );
    items.push(normalizeItem({ id, type: 'fileChange', status: 'completed' }));
  };
  return { cwd, journal, items, write, read, capture };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex file rewind', () => {
  it('対象発言以降を新しい順に逆適用する', () => {
    const s = setup();
    s.write('a', 'two\n');
    s.capture('e1', 'a', 'update', '@@ -1 +1 @@\n-one\n+two\n');
    s.items.push(normalizeItem({ id: 'u2', type: 'userMessage' }));
    s.write('a', 'three\n');
    s.capture('e2', 'a', 'update', '@@ -1 +1 @@\n-two\n+three\n');
    s.journal.prepare(s.cwd, s.items, 'u2').apply();
    expect(s.read('a')).toBe('two\n');
  });
  it('同一ファイルの複数ターンを一括で戻す', () => {
    const s = setup();
    s.write('a', 'two\n');
    s.capture('e1', 'a', 'update', '@@ -1 +1 @@\n-one\n+two\n');
    s.write('a', 'three\n');
    s.capture('e2', 'a', 'update', '@@ -1 +1 @@\n-two\n+three\n');
    s.journal.prepare(s.cwd, s.items, 'u1').apply();
    expect(s.read('a')).toBe('one\n');
  });
  it('空ファイル・末尾改行なしの新規と削除、移動を戻す', () => {
    const s = setup();
    s.write('new', '');
    s.capture('e1', 'new', 'add', '');
    s.capture('e2', 'deleted', 'delete', 'no newline');
    s.write('moved', 'after\n');
    s.capture(
      'e3',
      'original',
      'update',
      '@@ -1 +1 @@\n-before\n+after\n\n\nMoved to: moved',
      'moved',
    );
    s.journal.prepare(s.cwd, s.items, 'u1').apply();
    expect(fs.existsSync(path.join(s.cwd, 'new'))).toBe(false);
    expect(fs.existsSync(path.join(s.cwd, 'moved'))).toBe(false);
    expect(s.read('deleted')).toBe('no newline');
    expect(s.read('original')).toBe('before\n');
  });
  it('ハンク外の外部編集でも全ファイルを変更せず中止する', () => {
    const s = setup();
    s.write('a', 'after\nunchanged\n');
    s.capture('e1', 'a', 'update', '@@ -1 +1 @@\n-before\n+after\n');
    s.write('b', 'new\n');
    s.capture('e2', 'b', 'add', 'new\n');
    s.write('a', 'after\nexternal\n');
    expect(() => s.journal.prepare(s.cwd, s.items, 'u1')).toThrow('内容が変わっています');
    expect(s.read('b')).toBe('new\n');
  });
  it('確認中の変更を適用直前に再検証する', () => {
    const s = setup();
    s.write('a', 'new');
    s.capture('e1', 'a', 'add', 'new');
    const plan = s.journal.prepare(s.cwd, s.items, 'u1');
    s.write('a', 'external');
    expect(() => plan.apply()).toThrow();
    expect(s.read('a')).toBe('external');
  });
  it('編集間にコマンド等の変更が入れば全体中止する', () => {
    const s = setup();
    s.write('a', 'two\n');
    s.capture('e1', 'a', 'update', '@@ -1 +1 @@\n-one\n+two\n');
    s.write('a', 'four\n');
    s.capture('e2', 'a', 'update', '@@ -1 +1 @@\n-three\n+four\n');
    expect(() => s.journal.prepare(s.cwd, s.items, 'u1')).toThrow('連続していません');
  });
  it('再読込された編集や未知の形式を安全に拒否する', () => {
    const s = setup();
    s.items.push(normalizeItem({ id: 'old', type: 'fileChange', status: 'completed' }));
    expect(() => s.journal.prepare(s.cwd, s.items, 'u1')).toThrow('記録がありません');
  });
  it('拒否・失敗した編集は復元しない', () => {
    const s = setup();
    s.items.push(normalizeItem({ id: 'old', type: 'fileChange', status: 'declined' }));
    expect(s.journal.prepare(s.cwd, s.items, 'u1').images).toEqual([]);
  });
  it('同じ完了通知が再送されても後像を上書きしない', () => {
    const s = setup();
    s.write('a', 'one');
    s.capture('e1', 'a', 'add', 'one');
    s.write('a', 'external');
    s.capture('e1', 'a', 'add', 'external');
    expect(() => s.journal.prepare(s.cwd, s.items, 'u1')).toThrow();
  });
  it('途中の書込み失敗では変更済みファイルも適用前へ戻す', async () => {
    const s = setup();
    for (const name of ['a', 'b']) {
      s.write(name, 'after\n');
      s.capture(name, name, 'update', '@@ -1 +1 @@\n-before\n+after\n');
    }
    const plan = s.journal.prepare(s.cwd, s.items, 'u1');
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeFileSync;
    let writes = 0;
    const spy = vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (++writes === 2) throw new Error('write failed');
      original(file, data, options);
    });
    try {
      expect(() => plan.apply()).toThrow('write failed');
      expect(s.read('a')).toBe('after\n');
      expect(s.read('b')).toBe('after\n');
    } finally {
      spy.mockImplementation(original);
    }
  });

  it('作業ディレクトリ外、symlink、管理領域を拒否する', () => {
    const s = setup();
    fs.symlinkSync(s.cwd, path.join(s.cwd, 'link'));
    for (const target of ['../outside', 'link/file', '.git/config']) {
      const journal = new FileRewindJournal();
      journal.capture(s.cwd, 'bad', [
        { path: target, kind: 'delete', diff: 'x', movePath: undefined },
      ]);
      expect(() =>
        journal.prepare(
          s.cwd,
          [...s.items, normalizeItem({ id: 'bad', type: 'fileChange' })],
          'u1',
        ),
      ).toThrow();
    }
  });
});
