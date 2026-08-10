import { describe, expect, it } from 'vitest';
import { parseSessionIndex, sortByUpdatedAtDesc } from '../../src/codex/sessionIndex';

const line = (id: string, name: string, updated: string) =>
  JSON.stringify({ id, thread_name: name, updated_at: updated });

describe('parseSessionIndex', () => {
  it('実データ形式をパースできる', () => {
    const content = [
      line('019fd79f-1e16-7b60-b9d2-0324b275ed81', 'Set up environment', '2026-08-06T15:09:29Z'),
      line('019fd7a6-d25e-7bd2-b181-751e467277f3', '環境構築手順を確認', '2026-08-06T15:17:53Z'),
    ].join('\n');

    const { entries, skipped } = parseSessionIndex(content);
    expect(skipped).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.threadName).toBe('Set up environment');
  });

  it('追記中の不完全な末尾行を捨てて続行する', () => {
    const content = `${line('019fd79f-1e16-7b60-b9d2-0324b275ed81', 'ok', '2026-08-06T15:09:29Z')}\n{"id":"019fd7a6-d25e-7b`;
    const { entries, skipped } = parseSessionIndex(content);
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('空行を無視する', () => {
    const content = `\n${line('019fd79f-1e16-7b60-b9d2-0324b275ed81', 'ok', '2026-08-06T15:09:29Z')}\n\n`;
    const { entries, skipped } = parseSessionIndex(content);
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it('必須フィールド欠損の行を捨てる', () => {
    const content = ['{"thread_name":"idなし"}', '{"id":"","updated_at":"x"}', '[]', 'null'].join(
      '\n',
    );
    const { entries, skipped } = parseSessionIndex(content);
    expect(entries).toEqual([]);
    expect(skipped).toBe(4);
  });

  it('thread_name が無い/空ならundefinedにする', () => {
    const content =
      '{"id":"019fd79f-1e16-7b60-b9d2-0324b275ed81","updated_at":"2026-08-06T15:09:29Z"}';
    const { entries } = parseSessionIndex(content);
    expect(entries[0]?.threadName).toBeUndefined();
  });

  it('空文字列でも落ちない', () => {
    expect(parseSessionIndex('')).toEqual({ entries: [], skipped: 0 });
  });
});

describe('sortByUpdatedAtDesc', () => {
  it('更新時刻の降順に並べる', () => {
    const { entries } = parseSessionIndex(
      [
        line('019fd79f-1e16-7b60-b9d2-0324b275ed81', 'old', '2026-08-06T15:09:29Z'),
        line('019fd7a6-d25e-7bd2-b181-751e467277f3', 'new', '2026-08-06T15:17:53Z'),
      ].join('\n'),
    );
    expect(sortByUpdatedAtDesc(entries).map((e) => e.threadName)).toEqual(['new', 'old']);
  });

  it('元の配列を破壊しない', () => {
    const { entries } = parseSessionIndex(
      [
        line('019fd79f-1e16-7b60-b9d2-0324b275ed81', 'a', '2026-08-06T15:09:29Z'),
        line('019fd7a6-d25e-7bd2-b181-751e467277f3', 'b', '2026-08-06T15:17:53Z'),
      ].join('\n'),
    );
    const before = entries.map((e) => e.id);
    sortByUpdatedAtDesc(entries);
    expect(entries.map((e) => e.id)).toEqual(before);
  });
});
