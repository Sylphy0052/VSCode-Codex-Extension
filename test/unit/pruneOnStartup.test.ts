import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { pruneMetaCacheOnStartup } from '../../src/session/pruneOnStartup';
import type { SessionStore } from '../../src/session/sessionStore';

const fakeLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  show: vi.fn(),
});

describe('pruneMetaCacheOnStartup', () => {
  it('pruneCacheを呼び、削除があれば永続化する', async () => {
    const pruneCache = vi.fn().mockResolvedValue(3);
    const store: Pick<SessionStore, 'pruneCache'> = { pruneCache };
    const persistIfChanged = vi.fn().mockResolvedValue(undefined);
    const log = fakeLogger();

    await pruneMetaCacheOnStartup(store, persistIfChanged, log);

    expect(pruneCache).toHaveBeenCalledTimes(1);
    expect(persistIfChanged).toHaveBeenCalledWith(3);
  });

  it('削除件数が0なら永続化しない', async () => {
    const store: Pick<SessionStore, 'pruneCache'> = {
      pruneCache: vi.fn().mockResolvedValue(0),
    };
    const persistIfChanged = vi.fn().mockResolvedValue(undefined);

    await pruneMetaCacheOnStartup(store, persistIfChanged, fakeLogger());

    expect(persistIfChanged).not.toHaveBeenCalled();
  });

  it('pruneCacheが失敗しても例外を外へ出さず、警告ログだけ残す', async () => {
    const store: Pick<SessionStore, 'pruneCache'> = {
      pruneCache: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const persistIfChanged = vi.fn().mockResolvedValue(undefined);
    const log = fakeLogger();

    await expect(pruneMetaCacheOnStartup(store, persistIfChanged, log)).resolves.toBeUndefined();

    expect(persistIfChanged).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it(
    '警告ログはsanitizeForLogを通す（絶対パス中のユーザー名・制御文字を残さない、' + 'Issue #433）',
    async () => {
      const store: Pick<SessionStore, 'pruneCache'> = {
        pruneCache: vi
          .fn()
          .mockRejectedValue(
            new Error("EACCES: permission denied, open '/home/victim/.codex/meta.json'\u202E"),
          ),
      };
      const log = fakeLogger();

      await pruneMetaCacheOnStartup(store, vi.fn().mockResolvedValue(undefined), log);

      const message = vi.mocked(log.warn).mock.calls[0]?.[0] ?? '';
      expect(message).toContain('/home/***/.codex/meta.json');
      expect(message).not.toContain('victim');
      expect(message).not.toContain('\u202E');
    },
  );

  it('persistIfChangedが失敗しても例外を外へ出さない', async () => {
    const store: Pick<SessionStore, 'pruneCache'> = {
      pruneCache: vi.fn().mockResolvedValue(2),
    };
    const persistIfChanged = vi.fn().mockRejectedValue(new Error('persist failed'));
    const log = fakeLogger();

    await expect(pruneMetaCacheOnStartup(store, persistIfChanged, log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
