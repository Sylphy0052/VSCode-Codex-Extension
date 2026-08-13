import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import type { Logger } from '../../src/log';
import type { ProviderRegistry } from '../../src/provider/registry';
import { SessionTreeProvider } from '../../src/view/sessionTreeProvider';

/**
 * `TreeItem.id` はメニュー経由のコマンドに要素を渡すための鍵（issue #236）。
 *
 * VS Codeは`id`が無いとラベルと位置から内部ハンドルを組み立てるが、このツリーの
 * ラベルは`threadName ?? '(名称未設定)'`で重複しやすく、`refreshDebounced`によって
 * 並びも変わる。その結果ハンドルと要素の対応がずれ、`view/item/context`から呼ぶ
 * コマンドの引数が`undefined`になっていた。ここでは`id`が常に一意になることを見る。
 */

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    show: () => undefined,
  };
}

function fakeProviders(): ProviderRegistry {
  const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
  return {
    get: (id: string) => (labels[id] === undefined ? undefined : { label: labels[id] }),
  } as unknown as ProviderRegistry;
}

function makeProvider(): SessionTreeProvider {
  return new SessionTreeProvider(fakeProviders(), () => false, fakeLogger());
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'abc12345-0000-0000-0000-000000000000',
    provider: 'codex',
    threadName: undefined,
    updatedAt: new Date(0).toISOString(),
    cwd: '/tmp/example',
    archived: false,
    ...overrides,
  };
}

describe('SessionTreeProvider.getTreeItem のid（issue #236）', () => {
  it('プロバイダ名とセッションidを組にしたidを返す', () => {
    const item = makeProvider().getTreeItem(session({ id: 's1', provider: 'codex' }));

    expect(item.id).toBe('codex:s1');
  });

  it('名称未設定でラベルが同じセッションが並んでもidは重複しない', () => {
    const provider = makeProvider();

    const first = provider.getTreeItem(session({ id: 's1', threadName: undefined }));
    const second = provider.getTreeItem(session({ id: 's2', threadName: undefined }));

    expect(first.label).toBe(second.label);
    expect(first.id).not.toBe(second.id);
  });

  it('スレッド名が同じセッションが並んでもidは重複しない', () => {
    const provider = makeProvider();

    const first = provider.getTreeItem(session({ id: 's1', threadName: '同じ名前' }));
    const second = provider.getTreeItem(session({ id: 's2', threadName: '同じ名前' }));

    expect(first.id).not.toBe(second.id);
  });

  it('プロバイダが違えばセッションidが同じでもidは衝突しない', () => {
    const provider = makeProvider();

    const codex = provider.getTreeItem(session({ id: 'same', provider: 'codex' }));
    const claude = provider.getTreeItem(session({ id: 'same', provider: 'claude' }));

    expect(codex.id).toBe('codex:same');
    expect(claude.id).toBe('claude:same');
  });

  it('行のクリックには従来どおりセッションを引数として渡す', () => {
    const s = session({ id: 's1' });

    const item = makeProvider().getTreeItem(s);

    expect(item.command?.command).toBe('codex.openSession');
    expect(item.command?.arguments).toEqual([s]);
  });
});
