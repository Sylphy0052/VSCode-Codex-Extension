import { describe, expect, it } from 'vitest';
import { SessionModelSettingsStore } from '../../src/sessionModelSettings';
import type { MementoLike } from '../../src/util/memento';

function fakeMemento(initial: Record<string, unknown> = {}): MementoLike {
  const data = new Map(Object.entries(initial));
  return {
    get: <T>(key: string, defaultValue: T): T =>
      data.has(key) ? (data.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('SessionModelSettingsStore（issue #844）', () => {
  it('プロバイダとセッションIDの組ごとにmodelとeffortを分離する', async () => {
    const store = new SessionModelSettingsStore(fakeMemento());

    await store.set('codex', 'same', { model: 'gpt-a', effort: 'high' });
    await store.set('claude', 'same', { model: 'sonnet', effort: 'medium' });
    await store.set('codex', 'other', { model: 'gpt-b', effort: 'low' });

    expect(store.get('codex', 'same')).toEqual({ model: 'gpt-a', effort: 'high' });
    expect(store.get('claude', 'same')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(store.get('codex', 'other')).toEqual({ model: 'gpt-b', effort: 'low' });
  });

  it('壊れた保存値は使わない', () => {
    const store = new SessionModelSettingsStore(
      fakeMemento({
        'agent.sessionModelSettings.codex.broken': { model: 1, effort: 'high' },
      }),
    );

    expect(store.get('codex', 'broken')).toBeUndefined();
  });

  it('同じセッションへの連続変更は呼出順に保存する', async () => {
    const values = new Map<string, unknown>();
    const pending: Array<() => void> = [];
    const memento: MementoLike = {
      get: <T>(key: string, defaultValue: T): T =>
        values.has(key) ? (values.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> =>
        new Promise((resolve) => {
          pending.push(() => {
            values.set(key, value);
            resolve();
          });
        }),
    };
    const store = new SessionModelSettingsStore(memento);

    const first = store.set('codex', 's1', { model: 'model-a', effort: 'low' });
    await Promise.resolve();
    const second = store.set('codex', 's1', { model: 'model-b', effort: 'high' });
    await Promise.resolve();

    expect(pending).toHaveLength(1);
    expect(store.get('codex', 's1')).toEqual({ model: 'model-b', effort: 'high' });
    pending.shift()?.();
    await first;
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await second;

    expect(store.get('codex', 's1')).toEqual({ model: 'model-b', effort: 'high' });
  });
});
