import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyedStateFile } from '../../src/util/keyedStateFile';

const parseString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'keyed-state-')), 'state.json');
}

describe('KeyedStateFile（Issue #2006）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('上限を超えたら最後に書いた時刻の古いものから捨てる', async () => {
    vi.useFakeTimers();
    const path = tmpPath();
    const file = new KeyedStateFile(path, parseString, 2);
    vi.setSystemTime(1_000);
    await file.set('a', '1');
    vi.setSystemTime(2_000);
    await file.set('b', '2');
    vi.setSystemTime(3_000);
    await file.set('c', '3');

    expect(file.has('a')).toBe(false);
    expect(file.get('b')).toBe('2');
    expect(file.get('c')).toBe('3');
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).entries)).toEqual(['b', 'c']);
  });

  it('他インスタンスが足したキーを、書込み時に巻き戻さない', async () => {
    const path = tmpPath();
    const w1 = new KeyedStateFile(path, parseString, 10);
    const w2 = new KeyedStateFile(path, parseString, 10);
    await w1.set('a', '1');
    await w2.set('b', '2');

    expect(new KeyedStateFile(path, parseString, 10).get('a')).toBe('1');
    expect(new KeyedStateFile(path, parseString, 10).get('b')).toBe('2');
  });

  it('他ウィンドウの書込みを、確認間隔を過ぎた後のgetで取り込む', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const path = tmpPath();
    const reader = new KeyedStateFile(path, parseString, 10);
    expect(reader.get('x')).toBeUndefined();

    await new KeyedStateFile(path, parseString, 10).set('x', 'other-window');
    // mtimeが変わったことを確実にする
    const future = new Date(Date.now() + 5_000);
    utimesSync(path, future, future);
    vi.setSystemTime(12_000);

    expect(reader.get('x')).toBe('other-window');
  });

  it('壊れたファイルは空として扱い、次の書込みで作り直す', async () => {
    const path = tmpPath();
    await new KeyedStateFile(path, parseString, 10).set('a', '1');
    writeFileSync(path, '{broken', 'utf8');

    const file = new KeyedStateFile(path, parseString, 10);
    expect(file.get('a')).toBeUndefined();
    await file.set('b', '2');
    expect(new KeyedStateFile(path, parseString, 10).get('b')).toBe('2');
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  it('自分より新しい版のファイルは上書きせず、setを拒否する', async () => {
    const path = tmpPath();
    const newer = JSON.stringify({ version: 99, entries: { a: { v: 'keep', at: 1 } } });
    writeFileSync(path, newer, 'utf8');
    const file = new KeyedStateFile(path, parseString, 10);

    await expect(file.set('b', '2')).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(newer);
    expect(file.get('b')).toBeUndefined();
  });

  it('書込みに失敗したら、保存済みのように見せない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyed-state-'));
    // 置き場所のディレクトリにあたるパスをファイルにして、mkdirを失敗させる
    writeFileSync(join(dir, 'blocker'), 'x', 'utf8');
    const file = new KeyedStateFile(join(dir, 'blocker', 'state.json'), parseString, 10);

    await expect(file.set('a', '1')).rejects.toThrow();
    expect(file.get('a')).toBeUndefined();
  });

  it('2つのインスタンスが同時に書いても、両方の変更が残る', async () => {
    const path = tmpPath();
    const w1 = new KeyedStateFile(path, parseString, 100);
    const w2 = new KeyedStateFile(path, parseString, 100);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? w1 : w2).set(`k${i}`, String(i))),
    );

    const reread = new KeyedStateFile(path, parseString, 100);
    for (let i = 0; i < 10; i += 1) {
      expect(reread.get(`k${i}`)).toBe(String(i));
    }
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('deleteしたキーは再読込後も戻らない', async () => {
    const path = tmpPath();
    const file = new KeyedStateFile(path, parseString, 10);
    await file.set('a', '1');
    await file.delete('a');

    expect(file.get('a')).toBeUndefined();
    expect(new KeyedStateFile(path, parseString, 10).get('a')).toBeUndefined();
  });

  it('移行で上限を超えるときは書かずに拒否する', async () => {
    const path = tmpPath();
    const file = new KeyedStateFile(path, parseString, 2);

    await expect(
      file.importMissing(() => [
        ['a', '1'],
        ['b', '2'],
        ['c', '3'],
      ]),
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
