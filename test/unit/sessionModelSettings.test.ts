import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    const store = new SessionModelSettingsStore();

    await store.set('codex', 'same', { model: 'gpt-a', effort: 'high' });
    await store.set('claude', 'same', { model: 'sonnet', effort: 'medium' });
    await store.set('codex', 'other', { model: 'gpt-b', effort: 'low' });

    expect(store.get('codex', 'same')).toEqual({ model: 'gpt-a', effort: 'high' });
    expect(store.get('claude', 'same')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(store.get('codex', 'other')).toEqual({ model: 'gpt-b', effort: 'low' });
  });

  it('壊れた旧保存値は移行しない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-settings-'));
    const store = new SessionModelSettingsStore(
      join(dir, 'settings.json'),
      fakeMemento({
        'agent.sessionModelSettings.codex.broken': { model: 1, effort: 'high' },
      }),
    );

    expect(store.get('codex', 'broken')).toBeUndefined();
  });

  it('同じセッションへの連続変更は呼出順に保存し、作り直しても最後の値を読める', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-settings-'));
    const path = join(dir, 'settings.json');
    const store = new SessionModelSettingsStore(path);

    const first = store.set('codex', 's1', { model: 'model-a', effort: 'low' });
    const second = store.set('codex', 's1', { model: 'model-b', effort: 'high' });
    expect(store.get('codex', 's1')).toEqual({ model: 'model-b', effort: 'high' });
    await Promise.all([first, second]);

    expect(new SessionModelSettingsStore(path).get('codex', 's1')).toEqual({
      model: 'model-b',
      effort: 'high',
    });
  });

  it('旧globalStateのキーをファイルへ移し、書けたら旧キーを消す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-settings-'));
    const path = join(dir, 'settings.json');
    const legacy = fakeMemento({
      'agent.sessionModelSettings.claude.old': { model: 'sonnet', effort: 'low' },
      'unrelated.key': 1,
    });
    const keys = ['agent.sessionModelSettings.claude.old', 'unrelated.key'];
    const store = new SessionModelSettingsStore(path, Object.assign(legacy, { keys: () => keys }));

    await vi.waitFor(() => {
      expect(legacy.get('agent.sessionModelSettings.claude.old', undefined)).toBeUndefined();
    });
    expect(store.get('claude', 'old')).toEqual({ model: 'sonnet', effort: 'low' });
    expect(new SessionModelSettingsStore(path).get('claude', 'old')).toEqual({
      model: 'sonnet',
      effort: 'low',
    });
    expect(legacy.get('unrelated.key', undefined)).toBe(1);
  });

  it('セッション削除後は保存値を返さない', async () => {
    const store = new SessionModelSettingsStore();
    await store.set('codex', 'deleted', { model: 'gpt-a', effort: 'high' });

    await store.delete('codex', 'deleted');

    expect(store.get('codex', 'deleted')).toBeUndefined();
  });

  it('上限を超えて移行が拒否されても、旧キーから読み続け、旧キーは残す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-settings-'));
    const initial: Record<string, unknown> = {};
    for (let i = 0; i < 10_001; i += 1) {
      initial[`agent.sessionModelSettings.claude.s${i}`] = { model: 'sonnet', effort: 'low' };
    }
    const legacy = fakeMemento(initial);
    const errors: unknown[] = [];
    const store = new SessionModelSettingsStore(
      join(dir, 'settings.json'),
      Object.assign(legacy, { keys: () => Object.keys(initial) }),
      (error) => errors.push(error),
    );

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(store.get('claude', 's0')).toEqual({ model: 'sonnet', effort: 'low' });
    expect(legacy.get('agent.sessionModelSettings.claude.s0', undefined)).toBeDefined();
  });

  it('移行前でも旧キーから読み、deleteは旧キーも消す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-settings-'));
    const legacy = fakeMemento({
      'agent.sessionModelSettings.codex.old': { model: 'gpt-a', effort: 'high' },
    });
    // keys()を持たないので移行は走らず、旧キーが残り続ける
    const store = new SessionModelSettingsStore(join(dir, 'settings.json'), legacy);

    expect(store.get('codex', 'old')).toEqual({ model: 'gpt-a', effort: 'high' });
    await store.delete('codex', 'old');

    expect(store.get('codex', 'old')).toBeUndefined();
    expect(legacy.get('agent.sessionModelSettings.codex.old', undefined)).toBeUndefined();
  });
});
