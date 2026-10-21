import { mkdtempSync, readFileSync, statSync, utimesSync } from 'node:fs';
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
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{broken', 'utf8');

    const file = new KeyedStateFile(path, parseString, 10);
    expect(file.get('a')).toBeUndefined();
    await file.set('b', '2');
    expect(new KeyedStateFile(path, parseString, 10).get('b')).toBe('2');
    expect(statSync(path).size).toBeGreaterThan(0);
  });
});
