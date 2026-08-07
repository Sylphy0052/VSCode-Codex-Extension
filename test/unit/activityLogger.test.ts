import { describe, expect, it } from 'vitest';
import {
  ActivityLogger,
  InMemoryLoggedSessions,
  resolveBufferDir,
} from '../../src/activity/activityLogger';

interface Appended {
  filePath: string;
  line: string;
}

const makeLogger = (options?: { enabled?: boolean; dir?: string }) => {
  const appended: Appended[] = [];
  const logged = new InMemoryLoggedSessions();
  const logger = new ActivityLogger(
    {
      append: async (filePath, line) => {
        appended.push({ filePath, line });
      },
    },
    logged,
    () => ({ enabled: options?.enabled ?? true, dir: options?.dir ?? '/buf' }),
    { now: () => new Date('2026-08-06T15:30:00Z'), timeZoneOffsetMinutes: () => -540 },
  );
  return { logger, appended, logged };
};

describe('ActivityLogger', () => {
  it('セッションごとに1行、ローカル日付のファイルへ追記する', async () => {
    const { logger, appended } = makeLogger();

    await logger.record({
      sessionId: 'a',
      source: 'codex',
      cwd: '/w/repo',
      text: '実装を依頼',
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]?.filePath).toBe('/buf/2026-08-07.jsonl');
    expect(JSON.parse(appended[0]!.line)).toEqual({
      ts: '2026-08-07T00:30:00+09:00',
      source: 'codex',
      cwd: '/w/repo',
      text: '実装を依頼',
      ref: 'vscode',
    });
  });

  it('同じセッションを二重に記録しない', async () => {
    const { logger, appended } = makeLogger();
    const entry = { sessionId: 'a', source: 'codex' as const, cwd: '/w/repo', text: '一度目' };

    await logger.record(entry);
    await logger.record({ ...entry, text: '二度目' });

    expect(appended).toHaveLength(1);
    expect(JSON.parse(appended[0]!.line).text).toBe('一度目');
  });

  it('別セッションは別行として記録する', async () => {
    const { logger, appended } = makeLogger();
    await logger.record({ sessionId: 'a', source: 'codex', cwd: '/w/repo', text: 'A' });
    await logger.record({ sessionId: 'b', source: 'claude-code', cwd: '/w/repo', text: 'B' });
    expect(appended).toHaveLength(2);
  });

  it('本文が空のセッションは記録せず、既記録にもしない', async () => {
    const { logger, appended, logged } = makeLogger();

    await logger.record({ sessionId: 'a', source: 'codex', cwd: '/w/repo', text: '  ' });
    expect(appended).toHaveLength(0);
    expect(logged.has('a')).toBe(false);

    // 後から本文が判ったら記録できる
    await logger.record({ sessionId: 'a', source: 'codex', cwd: '/w/repo', text: '要約' });
    expect(appended).toHaveLength(1);
  });

  it('設定で無効化されていれば何も書かない', async () => {
    const { logger, appended, logged } = makeLogger({ enabled: false });
    await logger.record({ sessionId: 'a', source: 'codex', cwd: '/w/repo', text: 'x' });
    expect(appended).toHaveLength(0);
    expect(logged.has('a')).toBe(false);
  });

  it('書き込みに失敗しても例外を投げない（会話を止めない）', async () => {
    const logged = new InMemoryLoggedSessions();
    const logger = new ActivityLogger(
      {
        append: () => Promise.reject(new Error('EACCES')),
      },
      logged,
      () => ({ enabled: true, dir: '/buf' }),
      { now: () => new Date('2026-08-06T15:30:00Z'), timeZoneOffsetMinutes: () => -540 },
    );

    await expect(
      logger.record({ sessionId: 'a', source: 'codex', cwd: '/w/repo', text: 'x' }),
    ).resolves.toBeUndefined();
    // 失敗したものは既記録にしない（次の契機で書き直せる）
    expect(logged.has('a')).toBe(false);
  });
});

describe('resolveBufferDir', () => {
  const home = '/home/u';

  it('設定を最優先する', () => {
    expect(resolveBufferDir('/explicit', { DAILY_BUFFER_DIR: '/env' }, home)).toBe('/explicit');
  });

  it('設定が空なら DAILY_BUFFER_DIR を使う', () => {
    expect(resolveBufferDir('', { DAILY_BUFFER_DIR: '/env' }, home)).toBe('/env');
  });

  it('どちらも無ければ ~/workspace/dairy/.buffer', () => {
    expect(resolveBufferDir('', {}, home)).toBe('/home/u/workspace/dairy/.buffer');
  });
});

describe('InMemoryLoggedSessions', () => {
  it('保持期間を過ぎたエントリを掃除する', () => {
    const logged = new InMemoryLoggedSessions({ old: '2026-06-01', fresh: '2026-08-06' });
    logged.prune('2026-07-08');
    expect(logged.has('old')).toBe(false);
    expect(logged.has('fresh')).toBe(true);
  });
});
