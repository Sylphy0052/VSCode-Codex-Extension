import { describe, expect, it } from 'vitest';
import { ActivityLogger, resolveBufferDir } from '../../src/activity/activityLogger';

interface Appended {
  filePath: string;
  line: string;
}

const makeLogger = (options?: { enabled?: boolean; dir?: string }) => {
  const appended: Appended[] = [];
  const logger = new ActivityLogger(
    {
      append: async (filePath, line) => {
        appended.push({ filePath, line });
      },
    },
    () => ({ enabled: options?.enabled ?? true, dir: options?.dir ?? '/buf' }),
    { now: () => new Date('2026-08-06T15:30:00Z'), timeZoneOffsetMinutes: () => -540 },
  );
  return { logger, appended };
};

describe('ActivityLogger', () => {
  it('セッションごとに1行、ローカル日付のファイルへ追記する（kind: prompt）', async () => {
    const { logger, appended } = makeLogger();

    await logger.record({
      sessionId: 'a',
      source: 'codex',
      cwd: '/w/repo',
      kind: 'prompt',
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
      session_id: 'a',
      kind: 'prompt',
    });
  });

  it('同じセッションでも送信のたび毎回記録する（初回だけに絞る抑止は無い）', async () => {
    const { logger, appended } = makeLogger();
    const entry = {
      sessionId: 'a',
      source: 'codex' as const,
      cwd: '/w/repo',
      kind: 'prompt' as const,
      text: '一度目',
    };

    await logger.record(entry);
    await logger.record({ ...entry, text: '二度目' });

    expect(appended).toHaveLength(2);
    expect(JSON.parse(appended[0]!.line).text).toBe('一度目');
    expect(JSON.parse(appended[1]!.line).text).toBe('二度目');
  });

  it('別セッションは別行として記録する', async () => {
    const { logger, appended } = makeLogger();
    await logger.record({
      sessionId: 'a',
      source: 'codex',
      cwd: '/w/repo',
      kind: 'prompt',
      text: 'A',
    });
    await logger.record({
      sessionId: 'b',
      source: 'claude-code',
      cwd: '/w/repo',
      kind: 'prompt',
      text: 'B',
    });
    expect(appended).toHaveLength(2);
  });

  it('本文が空のセッションは記録しない', async () => {
    const { logger, appended } = makeLogger();

    await logger.record({
      sessionId: 'a',
      source: 'codex',
      cwd: '/w/repo',
      kind: 'prompt',
      text: '  ',
    });
    expect(appended).toHaveLength(0);

    // 後から本文が判ったら記録できる
    await logger.record({
      sessionId: 'a',
      source: 'codex',
      cwd: '/w/repo',
      kind: 'prompt',
      text: '要約',
    });
    expect(appended).toHaveLength(1);
  });

  it('設定で無効化されていれば何も書かない', async () => {
    const { logger, appended } = makeLogger({ enabled: false });
    await logger.record({
      sessionId: 'a',
      source: 'codex',
      cwd: '/w/repo',
      kind: 'prompt',
      text: 'x',
    });
    expect(appended).toHaveLength(0);
  });

  it('書き込みに失敗しても例外を投げない（会話を止めない）', async () => {
    const logger = new ActivityLogger(
      {
        append: () => Promise.reject(new Error('EACCES')),
      },
      () => ({ enabled: true, dir: '/buf' }),
      { now: () => new Date('2026-08-06T15:30:00Z'), timeZoneOffsetMinutes: () => -540 },
    );

    await expect(
      logger.record({ sessionId: 'a', source: 'codex', cwd: '/w/repo', kind: 'prompt', text: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('kind: result はそのまま応答テキストを本文にする', async () => {
    const { logger, appended } = makeLogger();
    await logger.record({
      sessionId: 'a',
      source: 'codex',
      cwd: '/w/repo',
      kind: 'result',
      text: '実装を完了しました',
      editedFiles: ['/w/repo/src/a.ts'],
    });
    expect(appended).toHaveLength(1);
    const parsed = JSON.parse(appended[0]!.line);
    expect(parsed.kind).toBe('result');
    expect(parsed.text).toBe('実装を完了しました [edit: src/a.ts]');
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
