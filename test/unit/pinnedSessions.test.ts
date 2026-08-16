import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import type { MementoLike } from '../../src/util/memento';
import { PinnedSessionStore, partitionPinned, pinKeyFor } from '../../src/util/pinnedSessions';

/** `vscode.Memento` 互換のフェイク（`test/unit/claudeSessionNames.test.ts` と同じ流儀）。 */
function fakeMemento(): MementoLike {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T => (data.has(key) ? (data.get(key) as T) : defaultValue),
    update: (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    provider: 'codex',
    threadName: undefined,
    updatedAt: new Date(0).toISOString(),
    cwd: '/tmp/example',
    archived: false,
    ...overrides,
  };
}

describe('PinnedSessionStore（issue #293）', () => {
  it('初期状態は何もピン留めされていない', () => {
    const store = new PinnedSessionStore(fakeMemento());
    expect(store.list()).toEqual([]);
    expect(store.isPinned('codex:s1')).toBe(false);
  });

  it('pinすると読み戻せる', async () => {
    const store = new PinnedSessionStore(fakeMemento());
    await store.pin('codex:s1');
    expect(store.isPinned('codex:s1')).toBe(true);
    expect(store.list()).toEqual(['codex:s1']);
  });

  it('同じキーを二重にpinしても重複しない', async () => {
    const store = new PinnedSessionStore(fakeMemento());
    await store.pin('codex:s1');
    await store.pin('codex:s1');
    expect(store.list()).toEqual(['codex:s1']);
  });

  it('unpinで外れる', async () => {
    const store = new PinnedSessionStore(fakeMemento());
    await store.pin('codex:s1');
    await store.pin('codex:s2');
    await store.unpin('codex:s1');
    expect(store.list()).toEqual(['codex:s2']);
  });

  it('既定（引数無し）はno-opで永続化しない', async () => {
    const store = new PinnedSessionStore();
    await store.pin('codex:s1');
    expect(store.isPinned('codex:s1')).toBe(false);
  });
});

describe('pinKeyFor', () => {
  it('プロバイダとidの組にする', () => {
    expect(pinKeyFor({ provider: 'codex', id: 'abc' })).toBe('codex:abc');
    expect(pinKeyFor({ provider: 'claude', id: 'abc' })).toBe('claude:abc');
  });
});

describe('partitionPinned（issue #293）', () => {
  it('ピン留め済みとそれ以外に分ける', () => {
    const sessions = [
      session({ id: 's1', provider: 'codex' }),
      session({ id: 's2', provider: 'codex' }),
      session({ id: 's3', provider: 'codex' }),
    ];

    const { pinned, rest } = partitionPinned(sessions, ['codex:s2']);

    expect(pinned.map((s) => s.id)).toEqual(['s2']);
    expect(rest.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('各グループ内は入力順（更新時刻降順）を保つ', () => {
    const sessions = [
      session({ id: 's3', provider: 'codex' }),
      session({ id: 's1', provider: 'codex' }),
      session({ id: 's2', provider: 'codex' }),
    ];

    const { pinned } = partitionPinned(sessions, ['codex:s1', 'codex:s2']);

    expect(pinned.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('実体が消えたピン（アーカイブ済み・削除済み等で一覧から落ちたもの）は黙って無視する', () => {
    const sessions = [session({ id: 's1', provider: 'codex' })];

    const { pinned, rest } = partitionPinned(sessions, ['codex:s1', 'codex:ghost']);

    expect(pinned.map((s) => s.id)).toEqual(['s1']);
    expect(rest).toEqual([]);
  });

  it('ピン留めが無ければpinnedは空、restは元の順のまま', () => {
    const sessions = [session({ id: 's1' }), session({ id: 's2' })];

    const { pinned, rest } = partitionPinned(sessions, []);

    expect(pinned).toEqual([]);
    expect(rest.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('プロバイダが違えばidが同じでも混同しない', () => {
    const sessions = [
      session({ id: 'same', provider: 'codex' }),
      session({ id: 'same', provider: 'claude' }),
    ];

    const { pinned, rest } = partitionPinned(sessions, ['claude:same']);

    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.provider).toBe('claude');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.provider).toBe('codex');
  });
});
