import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import type { Logger } from '../../src/log';
import type { ProviderRegistry } from '../../src/provider/registry';
import type { MementoLike } from '../../src/util/memento';
import { PinnedSessionStore } from '../../src/util/pinnedSessions';
import { __mock } from '../mocks/vscode';
import { SessionTreeProvider, type SessionGroupNode, type TreeElement } from '../../src/view/sessionTreeProvider';
import type { SessionActivityState } from '../../src/view/sessionActivity';

/**
 * `vscode.Memento` 互換のフェイク（`test/unit/pinnedSessions.test.ts`と同じ流儀）。
 * `PinnedSessionStore`の既定（引数無し）はno-opで永続化しないため、pin/unpinの実際の
 * 状態遷移を見るテストではこちらを明示的に渡す。
 */
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

/**
 * `TreeItem.id` はメニュー経由のコマンドに要素を渡すための鍵（issue #236）。
 *
 * VS Codeは`id`が無いとラベルと位置から内部ハンドルを組み立てるが、このツリーの
 * ラベルは`threadName ?? '(名称未設定)'`で重複しやすく、`refreshDebounced`によって
 * 並びも変わる。その結果ハンドルと要素の対応がずれ、`view/item/context`から呼ぶ
 * コマンドの引数が`undefined`になっていた。ここでは`id`が常に一意になることを見る。
 *
 * issue #293でグループ化・絞り込み・ピン留めを追加した後も、セッションのリーフノードは
 * `SessionSummary`そのままである（ラップしない）ことをここで確かめ続ける。
 */

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    show: () => undefined,
  };
}

interface ListSessionsCall {
  scope: string;
  workspaceFolders: string[];
  maxEntries: number;
}

function fakeProviders(sessions: SessionSummary[], calls: ListSessionsCall[] = []): ProviderRegistry {
  const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
  return {
    get: (id: string) => (labels[id] === undefined ? undefined : { label: labels[id] }),
    listSessions: (options: ListSessionsCall) => {
      calls.push(options);
      return Promise.resolve(sessions);
    },
  } as unknown as ProviderRegistry;
}

function makeProvider(
  sessions: SessionSummary[] = [],
  pinnedStore: PinnedSessionStore = new PinnedSessionStore(),
  calls: ListSessionsCall[] = [],
  getActivity: (session: SessionSummary) => SessionActivityState | undefined = () => undefined,
): SessionTreeProvider {
  return new SessionTreeProvider(fakeProviders(sessions, calls), getActivity, fakeLogger(), pinnedStore);
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

function isGroup(element: TreeElement): element is SessionGroupNode {
  return typeof element === 'object' && element !== null && (element as { kind?: unknown }).kind === 'group';
}

beforeEach(() => {
  __mock.reset();
});

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

describe('SessionTreeProvider.getTreeItem の活動状態表示（issue #286、design.md §14.55）', () => {
  it('未オープン（getActivityがundefined）は従来どおりの分岐（未アーカイブのCodex）', () => {
    const s = session({ id: 's1', provider: 'codex', archived: false });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => undefined);

    const item = provider.getTreeItem(s);

    expect((item.iconPath as { id: string }).id).toBe('comment-discussion');
    expect(String(item.description).startsWith('実行中')).toBe(false);
    expect(String(item.description).startsWith('承認待ち')).toBe(false);
  });

  it('実行中はアイコンがsync~spinになり、descriptionの先頭に「実行中」が付く', () => {
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'running');

    const item = provider.getTreeItem(s);

    expect((item.iconPath as { id: string }).id).toBe('sync~spin');
    expect(String(item.description).startsWith('実行中')).toBe(true);
  });

  it('承認待ちはアイコンがbell-dotになり、descriptionの先頭に「承認待ち」が付く（実行中より優先）', () => {
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'approvalPending');

    const item = provider.getTreeItem(s);

    expect((item.iconPath as { id: string }).id).toBe('bell-dot');
    expect(String(item.description).startsWith('承認待ち')).toBe(true);
  });

  it('開いてはいるが待機中（idle）は従来どおりcircle-filledで、状態の接頭辞は付かない', () => {
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'idle');

    const item = provider.getTreeItem(s);

    expect((item.iconPath as { id: string }).id).toBe('circle-filled');
    expect(String(item.description).startsWith('実行中')).toBe(false);
    expect(String(item.description).startsWith('承認待ち')).toBe(false);
  });
});

describe('SessionTreeProvider.getChildren のグループ化（issue #293、既定 groupBy: date）', () => {
  it('日付でグループ化したノードを返す（セッションは直接ラップしない）', async () => {
    const s = session({ id: 's1', updatedAt: new Date().toISOString() });
    const provider = makeProvider([s]);

    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    const group = children[0];
    expect(group !== undefined && isGroup(group)).toBe(true);
    if (group !== undefined && isGroup(group)) {
      expect(group.label).toBe('今日');
      expect(group.sessions).toEqual([s]);
    }
  });

  it('グループのidは常に group: から始まり、セッションのidと衝突しない', async () => {
    const s = session({ id: 's1', provider: 'codex', updatedAt: new Date().toISOString() });
    const provider = makeProvider([s]);

    const children = await provider.getChildren();
    const group = children[0];
    expect(group !== undefined && isGroup(group) && group.id.startsWith('group:')).toBe(true);

    const sessionItem = provider.getTreeItem(s);
    expect(sessionItem.id).toBe('codex:s1');
    if (group !== undefined && isGroup(group)) {
      expect(group.id).not.toBe(sessionItem.id);
    }
  });

  it('getChildren(group) はそのグループのセッションを返す。セッションは葉なので空配列', async () => {
    const s = session({ id: 's1', updatedAt: new Date().toISOString() });
    const provider = makeProvider([s]);

    const [group] = await provider.getChildren();
    expect(group !== undefined && isGroup(group)).toBe(true);
    if (group === undefined || !isGroup(group)) {
      throw new Error('group node expected');
    }

    expect(await provider.getChildren(group)).toEqual([s]);
    expect(await provider.getChildren(s)).toEqual([]);
  });

  it('groupBy: folder では作業ディレクトリ別にグループ化する', async () => {
    __mock.setConfig('codex', { 'history.groupBy': 'folder' });
    const sessions = [
      session({ id: 's1', cwd: '/repo/a' }),
      session({ id: 's2', cwd: '/repo/b' }),
    ];
    const provider = makeProvider(sessions);

    const children = await provider.getChildren();

    expect(children.every((c) => isGroup(c))).toBe(true);
    expect((children as SessionGroupNode[]).map((g) => g.label)).toEqual(['a', 'b']);
  });

  it('groupBy: none は現状どおりフラットな一覧に戻す', async () => {
    __mock.setConfig('codex', { 'history.groupBy': 'none' });
    const sessions = [
      session({ id: 's1', updatedAt: new Date().toISOString() }),
      session({ id: 's2', updatedAt: new Date(0).toISOString() }),
    ];
    const provider = makeProvider(sessions);

    const children = await provider.getChildren();

    expect(children).toEqual(sessions);
  });

  it('groupBy: none はピン留めしていてもグループ化しない（受入基準）', async () => {
    __mock.setConfig('codex', { 'history.groupBy': 'none' });
    const sessions = [session({ id: 's1' }), session({ id: 's2' })];
    const pinnedStore = new PinnedSessionStore(fakeMemento());
    await pinnedStore.pin('codex:s1');
    const provider = makeProvider(sessions, pinnedStore);

    const children = await provider.getChildren();

    expect(children).toEqual(sessions);
  });

  it('絞り込みは読み込み件数（maxEntries）を変えない', async () => {
    const calls: ListSessionsCall[] = [];
    const sessions = [session({ id: 's1', threadName: 'foo' })];
    const provider = makeProvider(sessions, new PinnedSessionStore(), calls);

    await provider.getChildren();
    await provider.setFilter('foo');
    await provider.getChildren();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.maxEntries).toBe(calls[1]?.maxEntries);
  });
});

describe('SessionTreeProvider の絞り込み（issue #293）', () => {
  it('セッション名・作業ディレクトリに一致するものだけ残す（表示側のみのフィルタ）', async () => {
    __mock.setConfig('codex', { 'history.groupBy': 'none' });
    const sessions = [
      session({ id: 'match-name', threadName: '認証まわりの相談' }),
      session({ id: 'match-cwd', threadName: undefined, cwd: '/home/user/my-project' }),
      session({ id: 'no-match', threadName: '関係ない話', cwd: '/tmp/other' }),
    ];
    const provider = makeProvider(sessions);

    await provider.setFilter('認証');
    const byName = await provider.getChildren();
    expect((byName as SessionSummary[]).map((s) => s.id)).toEqual(['match-name']);

    await provider.setFilter('my-project');
    const byCwd = await provider.getChildren();
    expect((byCwd as SessionSummary[]).map((s) => s.id)).toEqual(['match-cwd']);
  });

  it('filterActive / filterQuery が状態を反映する', async () => {
    const provider = makeProvider([]);
    expect(provider.filterActive).toBe(false);

    await provider.setFilter('query');
    expect(provider.filterActive).toBe(true);
    expect(provider.filterQuery).toBe('query');

    await provider.clearFilter();
    expect(provider.filterActive).toBe(false);
    expect(provider.filterQuery).toBe('');
  });

  it('空白だけの絞り込みは絞り込み無し扱い', async () => {
    const provider = makeProvider([]);
    await provider.setFilter('   ');
    expect(provider.filterActive).toBe(false);
  });
});

describe('SessionTreeProvider のピン留め（issue #293）', () => {
  it('ピン留めしたセッションは先頭のグループへ出る', async () => {
    const s1 = session({ id: 's1', updatedAt: new Date().toISOString() });
    const s2 = session({ id: 's2', updatedAt: new Date().toISOString() });
    const provider = makeProvider([s1, s2], new PinnedSessionStore(fakeMemento()));

    await provider.pin(s2);
    const children = await provider.getChildren();

    const first = children[0];
    expect(first !== undefined && isGroup(first) && first.label === 'ピン留め').toBe(true);
    if (first !== undefined && isGroup(first)) {
      expect(first.sessions.map((s) => s.id)).toEqual(['s2']);
    }
  });

  it('unpinすると通常のグループへ戻る', async () => {
    const s = session({ id: 's1', updatedAt: new Date().toISOString() });
    const provider = makeProvider([s], new PinnedSessionStore(fakeMemento()));

    await provider.pin(s);
    await provider.unpin(s);
    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    const group = children[0];
    expect(group !== undefined && isGroup(group) && group.label !== 'ピン留め').toBe(true);
  });

  it('isPinnedで現在の状態を確認できる', async () => {
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(fakeMemento()));

    expect(provider.isPinned(s)).toBe(false);
    await provider.pin(s);
    expect(provider.isPinned(s)).toBe(true);
  });

  it('実体が消えたピン（一覧に存在しないセッション）は無視され一覧を壊さない', async () => {
    const sessions = [session({ id: 's1' })];
    const pinnedStore = new PinnedSessionStore(fakeMemento());
    await pinnedStore.pin('codex:ghost-session-that-was-deleted');
    const provider = makeProvider(sessions, pinnedStore);

    const children = await provider.getChildren();

    // 「ピン留め」グループが幽霊エントリだけで出てきたりしない
    expect(children.some((c) => isGroup(c) && c.label === 'ピン留め')).toBe(false);
    expect(children.some((c) => isGroup(c) && c.sessions.some((s) => s.id === 's1'))).toBe(true);
  });

  it('未ピンのcontextValueは従来どおり（.pinnedは付かない）', () => {
    const s = session({ id: 's1', provider: 'codex', archived: false });
    const provider = makeProvider([s]);

    expect(provider.getTreeItem(s).contextValue).toBe('codexSession.codex');
  });

  it('pin後はcontextValueに.pinnedが付き、アーカイブ状態と共存する', async () => {
    const archived = session({ id: 's1', provider: 'codex', archived: true });
    const pinnedStore = new PinnedSessionStore(fakeMemento());
    const provider = makeProvider([archived], pinnedStore);

    await provider.pin(archived);

    expect(provider.getTreeItem(archived).contextValue).toBe('codexSession.codex.archived.pinned');
  });
});
