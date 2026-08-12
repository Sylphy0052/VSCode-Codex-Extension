import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import type { Logger } from '../../src/log';
import { ProviderRegistry } from '../../src/provider/registry';
import type { AgentProvider } from '../../src/provider/types';
import type { ListResult } from '../../src/session/sessionStore';

const logger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  show: vi.fn(),
});

const session = (id: string, updatedAt: string, provider: 'codex' | 'claude'): SessionSummary => ({
  id,
  provider,
  threadName: id,
  updatedAt,
  cwd: '/w/alpha',
  archived: false,
});

const fake = (
  id: 'codex' | 'claude',
  options: { found?: boolean; sessions?: SessionSummary[]; fail?: boolean } = {},
): AgentProvider =>
  ({
    id,
    label: id,
    installUrl: '',
    executableSettingKey: '',
    capabilities: { fork: true, forkFromTurn: false, archive: false, delete: false },
    locate: () =>
      options.found === false
        ? { ok: false, reason: 'not-found', attempted: id }
        : { ok: true, path: `/bin/${id}`, source: 'path' },
    listSessions: async (): Promise<ListResult> => {
      if (options.fail === true) {
        throw new Error('読めない');
      }
      return { sessions: options.sessions ?? [], skippedIndexLines: 0, unresolved: 0 };
    },
    buildLaunch: () => ({ args: [], env: {}, sessionId: undefined, warnings: [] }),
    tabTitle: (s) => `${id}: ${s.id}`,
  }) as AgentProvider;

const options = { scope: 'workspace' as const, workspaceFolders: ['/w/alpha'], maxEntries: 10 };

describe('ProviderRegistry', () => {
  it('両プロバイダのセッションを更新の新しい順に混ぜる', async () => {
    const registry = new ProviderRegistry([
      fake('codex', { sessions: [session('c1', '2026-08-06T10:00:00Z', 'codex')] }),
      fake('claude', { sessions: [session('k1', '2026-08-07T10:00:00Z', 'claude')] }),
    ]);

    const sessions = await registry.listSessions(options, logger());
    expect(sessions.map((s) => s.id)).toEqual(['k1', 'c1']);
  });

  // 一覧はファイル読みだけで作れるため、CLIの実行ファイルが解決できるかどうかで
  // プロバイダを絞らない（issue #164）。絞ると、CLIをPATHから外しただけで過去の
  // 履歴が丸ごと消える。
  it('実行ファイルが見つからないプロバイダのセッションも一覧に出す', async () => {
    const registry = new ProviderRegistry([
      fake('codex', { sessions: [session('c1', '2026-08-06T10:00:00Z', 'codex')] }),
      fake('claude', { found: false, sessions: [session('k1', '2026-08-07T10:00:00Z', 'claude')] }),
    ]);

    const sessions = await registry.listSessions(options, logger());
    expect(sessions.map((s) => s.id)).toEqual(['k1', 'c1']);
  });

  it('どのプロバイダも実行ファイルを解決できなくても一覧は空にならない', async () => {
    const registry = new ProviderRegistry([
      fake('codex', { found: false, sessions: [session('c1', '2026-08-06T10:00:00Z', 'codex')] }),
      fake('claude', { found: false, sessions: [session('k1', '2026-08-07T10:00:00Z', 'claude')] }),
    ]);

    const sessions = await registry.listSessions(options, logger());
    expect(sessions.map((s) => s.id)).toEqual(['k1', 'c1']);
  });

  it('片方が失敗しても、もう片方の一覧を返す', async () => {
    const log = logger();
    const registry = new ProviderRegistry([
      fake('codex', { fail: true }),
      fake('claude', { sessions: [session('k1', '2026-08-07T10:00:00Z', 'claude')] }),
    ]);

    const sessions = await registry.listSessions(options, log);
    expect(sessions.map((s) => s.id)).toEqual(['k1']);
    expect(log.error).toHaveBeenCalled();
  });

  it('上限で切り詰める', async () => {
    const registry = new ProviderRegistry([
      fake('codex', {
        sessions: [
          session('c1', '2026-08-06T10:00:00Z', 'codex'),
          session('c2', '2026-08-05T10:00:00Z', 'codex'),
        ],
      }),
      fake('claude', { sessions: [session('k1', '2026-08-07T10:00:00Z', 'claude')] }),
    ]);

    const sessions = await registry.listSessions({ ...options, maxEntries: 2 }, logger());
    expect(sessions.map((s) => s.id)).toEqual(['k1', 'c1']);
  });
});
