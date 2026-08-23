import { describe, expect, it } from 'vitest';
import { ClaudeSessionNameStore } from '../../src/claude/sessionNames';
import type { MementoLike } from '../../src/util/memento';

/** `vscode.Memento` 互換のフェイク。実体はMapだけの単純な実装で足りる。 */
function fakeMemento(): MementoLike {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T =>
      data.has(key) ? (data.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('ClaudeSessionNameStore（issue #199）', () => {
  it('付けていないセッションは undefined を返す', () => {
    const store = new ClaudeSessionNameStore(fakeMemento());
    expect(store.get('unknown-session')).toBeUndefined();
  });

  it('保存した名前を読み戻せる', async () => {
    const store = new ClaudeSessionNameStore(fakeMemento());
    await store.set('s1', '設計方針の相談');
    expect(store.get('s1')).toBe('設計方針の相談');
  });

  it('セッションごとに独立して保持する（他のセッションを上書きしない）', async () => {
    const store = new ClaudeSessionNameStore(fakeMemento());
    await store.set('s1', '名前A');
    await store.set('s2', '名前B');
    expect(store.get('s1')).toBe('名前A');
    expect(store.get('s2')).toBe('名前B');
  });

  it('空白のみの値は「付けていない」扱いにする', async () => {
    const store = new ClaudeSessionNameStore(fakeMemento());
    await store.set('s1', '   ');
    expect(store.get('s1')).toBeUndefined();
  });

  it('既定（引数無し）はno-opで永続化しない', async () => {
    const store = new ClaudeSessionNameStore();
    await store.set('s1', '保存されないはず');
    expect(store.get('s1')).toBeUndefined();
  });
});
