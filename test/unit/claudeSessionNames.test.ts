import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    const store = new ClaudeSessionNameStore();
    expect(store.get('unknown-session')).toBeUndefined();
  });

  it('保存した名前を読み戻せる', async () => {
    const store = new ClaudeSessionNameStore();
    await store.set('s1', '設計方針の相談');
    expect(store.get('s1')).toBe('設計方針の相談');
  });

  it('セッションごとに独立して保持する（他のセッションを上書きしない）', async () => {
    const store = new ClaudeSessionNameStore();
    await store.set('s1', '名前A');
    await store.set('s2', '名前B');
    expect(store.get('s1')).toBe('名前A');
    expect(store.get('s2')).toBe('名前B');
  });

  it('空白のみの値は「付けていない」扱いにする', async () => {
    const store = new ClaudeSessionNameStore();
    await store.set('s1', '   ');
    expect(store.get('s1')).toBeUndefined();
  });

  it('既定（引数無し）はファイルを作らず、そのインスタンスの中だけで保持する', async () => {
    const store = new ClaudeSessionNameStore();
    await store.set('s1', 'メモリだけ');
    expect(store.get('s1')).toBe('メモリだけ');
    expect(new ClaudeSessionNameStore().get('s1')).toBeUndefined();
  });

  it('ファイルへ保存し、別インスタンス（別ウィンドウ・リロード）からも読める', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'claude-names-')), 'names.json');
    await new ClaudeSessionNameStore(path).set('s1', '永続する名前');
    expect(new ClaudeSessionNameStore(path).get('s1')).toBe('永続する名前');
  });

  it('旧globalStateの名前をファイルへ移し、書けたら旧キーを消す', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'claude-names-')), 'names.json');
    const legacy = fakeMemento();
    await legacy.update('claude.sessionNames', { old: '旧名', bad: 1 });
    const store = new ClaudeSessionNameStore(path, legacy);

    await vi.waitFor(() => {
      expect(legacy.get('claude.sessionNames', undefined)).toBeUndefined();
    });
    expect(store.get('old')).toBe('旧名');
    expect(new ClaudeSessionNameStore(path).get('old')).toBe('旧名');
    expect(store.get('bad')).toBeUndefined();
  });

  it('1000文字を超える旧名は捨てずに切り詰めて移す', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'claude-names-')), 'names.json');
    const legacy = fakeMemento();
    await legacy.update('claude.sessionNames', { long: 'あ'.repeat(1_500) });
    const store = new ClaudeSessionNameStore(path, legacy);

    await vi.waitFor(() => {
      expect(legacy.get('claude.sessionNames', undefined)).toBeUndefined();
    });
    expect(new ClaudeSessionNameStore(path).get('long')).toBe('あ'.repeat(1_000));
    expect(store.get('long')).toHaveLength(1_000);
  });
});
