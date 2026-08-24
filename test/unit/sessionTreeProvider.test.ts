import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import type { Logger } from '../../src/log';
import type { ProviderRegistry } from '../../src/provider/registry';
import type { MementoLike } from '../../src/util/memento';
import { PinnedSessionStore } from '../../src/util/pinnedSessions';
import { __mock } from '../mocks/vscode';
import {
  groupSummaryText,
  SessionTreeProvider,
  type SessionGroupNode,
  type TreeElement,
} from '../../src/view/sessionTreeProvider';
import type { SessionActivityState } from '../../src/view/sessionActivity';
import { formatRelativeTime } from '../../src/view/relativeTime';
import { SESSION_URI_SCHEME, sessionUri } from '../../src/view/sessionDecorations';

/**
 * `vscode.Memento` 互換のフェイク（`test/unit/pinnedSessions.test.ts`と同じ流儀）。
 * `PinnedSessionStore`の既定（引数無し）はno-opで永続化しないため、pin/unpinの実際の
 * 状態遷移を見るテストではこちらを明示的に渡す。
 */
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

function fakeProviders(
  sessions: SessionSummary[],
  calls: ListSessionsCall[] = [],
): ProviderRegistry {
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
  return new SessionTreeProvider(
    fakeProviders(sessions, calls),
    getActivity,
    fakeLogger(),
    pinnedStore,
  );
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
  return (
    typeof element === 'object' &&
    element !== null &&
    (element as { kind?: unknown }).kind === 'group'
  );
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

/**
 * アイコンの色（issue #733）。
 *
 * 形だけでは一覧を流し見したときの差が小さい。色は形の補助で、形の出し分けは変えない。
 */
describe('SessionTreeProvider.getTreeItem のアイコンの色（issue #733）', () => {
  const colorOf = (item: { iconPath?: unknown }): string | undefined =>
    (item.iconPath as { color?: { id: string } }).color?.id;

  it('承認待ちは注意色', () => {
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'approvalPending');

    expect(colorOf(provider.getTreeItem(s))).toBe('charts.yellow');
  });

  it('実行中は進行中の色', () => {
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'running');

    expect(colorOf(provider.getTreeItem(s))).toBe('charts.blue');
  });

  it('開いている（idle）は開いていることを表す色', () => {
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'idle');

    expect(colorOf(provider.getTreeItem(s))).toBe('charts.green');
  });

  it('アーカイブ済みは控えめな色', () => {
    const s = session({ id: 's1', archived: true });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => undefined);

    const item = provider.getTreeItem(s);

    expect((item.iconPath as { id: string }).id).toBe('archive');
    expect(colorOf(item)).toBe('descriptionForeground');
  });

  it('未オープンには色を付けない（一覧の大半なので、付けると合図でなくなる）', () => {
    const codex = session({ id: 's1', provider: 'codex', archived: false });
    const claude = session({ id: 's2', provider: 'claude', archived: false });
    const provider = makeProvider([codex, claude], new PinnedSessionStore(), [], () => undefined);

    expect(colorOf(provider.getTreeItem(codex))).toBeUndefined();
    expect(colorOf(provider.getTreeItem(claude))).toBeUndefined();
  });

  it('状態ごとに色が違う（同じ色を配って区別が消えていないこと）', () => {
    const s = session({ id: 's1' });
    const states: readonly SessionActivityState[] = ['approvalPending', 'running', 'idle'];
    const colors = states.map((state) =>
      colorOf(makeProvider([s], new PinnedSessionStore(), [], () => state).getTreeItem(s)),
    );

    expect(new Set(colors).size).toBe(states.length);
  });
});

describe('SessionTreeProvider.getTreeItem の補足行（issue #736）', () => {
  const descriptionOf = (provider: SessionTreeProvider, s: SessionSummary): string =>
    String(provider.getTreeItem(s).description);

  it('このワークスペース表示では相対時刻だけ', () => {
    // CLI名は幅を食うわりにアイコンとツールチップで分かる。切れて相対時刻が
    // 押し出されるのを避けるため載せない
    const s = session({ id: 's1', provider: 'codex' });
    const provider = makeProvider([s]);

    expect(descriptionOf(provider, s)).toBe(formatRelativeTime(s.updatedAt, Date.now()));
  });

  it('CLI名を載せない（Codex・Claude Codeのどちらでも）', () => {
    const codex = session({ id: 's1', provider: 'codex' });
    const claude = session({ id: 's2', provider: 'claude' });
    const provider = makeProvider([codex, claude]);
    // 陽性対照: フェイクのProviderRegistryは実際にこのラベルを返す
    expect(fakeProviders([]).get('claude')?.label).toBe('Claude Code');

    expect(descriptionOf(provider, codex)).not.toContain('Codex');
    expect(descriptionOf(provider, claude)).not.toContain('Claude Code');
  });

  it('CLI名はツールチップに残る', () => {
    const s = session({ id: 's1', provider: 'claude' });
    const provider = makeProvider([s]);

    const tooltip = provider.getTreeItem(s).tooltip;
    const text = typeof tooltip === 'string' ? tooltip : (tooltip?.value ?? '');
    expect(text).toContain('- CLI: Claude Code');
  });

  it('すべて表示のときはフォルダ名を中黒でつなぐ', async () => {
    const s = session({ id: 's1', cwd: '/tmp/example' });
    const provider = makeProvider([s]);
    await provider.setScope('all');

    expect(descriptionOf(provider, s)).toBe(
      `${formatRelativeTime(s.updatedAt, Date.now())} · example`,
    );
  });

  it('承認待ち・実行中は先頭に残る（色だけに頼らないため）', () => {
    const s = session({ id: 's1' });
    const pending = makeProvider([s], new PinnedSessionStore(), [], () => 'approvalPending');
    const running = makeProvider([s], new PinnedSessionStore(), [], () => 'running');

    expect(descriptionOf(pending, s).startsWith('承認待ち · ')).toBe(true);
    expect(descriptionOf(running, s).startsWith('実行中 · ')).toBe(true);
  });
});

describe('groupSummaryText（issue #737）', () => {
  it('内訳が無ければ件数だけ', () => {
    expect(groupSummaryText([undefined, undefined, 'idle'])).toBe('3件');
  });

  it('承認待ちの件数を足す', () => {
    expect(groupSummaryText(['approvalPending', undefined])).toBe('2件 · 承認待ち1');
  });

  it('実行中の件数を足す', () => {
    expect(groupSummaryText(['running', 'running', 'idle'])).toBe('3件 · 実行中2');
  });

  it('両方あっても承認待ちだけを出す（狭い幅で切れて急ぐ方が押し出されないように）', () => {
    expect(groupSummaryText(['approvalPending', 'running', 'running'])).toBe('3件 · 承認待ち1');
  });

  it('空のグループは0件', () => {
    expect(groupSummaryText([])).toBe('0件');
  });
});

describe('SessionTreeProvider のグループ見出しの内訳（issue #737）', () => {
  const groupDescriptions = async (
    provider: SessionTreeProvider,
  ): Promise<Array<string | undefined>> => {
    const children = await provider.getChildren();
    return children
      .filter(isGroup)
      .map((g) => provider.getTreeItem(g).description)
      .map((d) => (d === undefined ? undefined : String(d)));
  };

  it('見出しに件数と内訳が出る', async () => {
    const s1 = session({ id: 's1', updatedAt: new Date().toISOString() });
    const s2 = session({ id: 's2', updatedAt: new Date().toISOString() });
    const provider = makeProvider([s1, s2], new PinnedSessionStore(), [], (s) =>
      s.id === 's1' ? 'approvalPending' : undefined,
    );

    expect(await groupDescriptions(provider)).toEqual(['2件 · 承認待ち1']);
  });

  it('ピン留めグループでも同じ形式で出る', async () => {
    const pinnedSession = session({ id: 's1', updatedAt: new Date().toISOString() });
    const store = new PinnedSessionStore(fakeMemento());
    const provider = makeProvider([pinnedSession], store, [], () => 'running');
    await provider.pin(pinnedSession);

    const children = await provider.getChildren();
    const pinnedGroup = children.filter(isGroup).find((g) => g.groupKind === 'pinned');

    expect(pinnedGroup, 'ピン留めグループが無い').toBeDefined();
    expect(String(provider.getTreeItem(pinnedGroup as TreeElement).description)).toBe(
      '1件 · 実行中1',
    );
  });

  it('groupBy: none では見出し自体が出ない（表示が変わらない）', async () => {
    __mock.setConfig('codex', { 'history.groupBy': 'none' });
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'running');

    const children = await provider.getChildren();

    expect(children.some(isGroup)).toBe(false);
  });
});

describe('SessionTreeProvider の行末デコレーション（issue #735）', () => {
  it('セッションの行に仮想URIを振る（実ファイルは指さない）', () => {
    const s = session({ id: 's1', provider: 'codex' });
    const provider = makeProvider([s]);

    const uri = provider.getTreeItem(s).resourceUri;

    expect(uri).toBeDefined();
    expect(uri?.scheme).toBe(SESSION_URI_SCHEME);
    // 実パス（rolloutのjsonl）を指すと、同じファイルを開いている他のUIへ装飾が波及する
    expect(uri?.scheme).not.toBe('file');
  });

  it('グループの見出しにはURIを振らない（バッジを出す対象ではない）', async () => {
    const s = session({ id: 's1', updatedAt: new Date().toISOString() });
    const provider = makeProvider([s]);
    const groups = await provider.getChildren();

    expect(groups.length).toBeGreaterThan(0);
    expect(provider.getTreeItem(groups[0] as TreeElement).resourceUri).toBeUndefined();
  });

  it('URIから状態を引ける', async () => {
    const s = session({ id: 's1', provider: 'codex' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'approvalPending');
    await provider.getChildren();

    expect(provider.decorationStateFor(sessionUri(s))).toBe('approvalPending');
  });

  it('一覧に無いURI・別スキームのURIには何も返さない', async () => {
    // VS Codeはこのプロバイダを全URIに対して呼ぶ。他のビューのURIも届く
    const s = session({ id: 's1', provider: 'codex' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'running');
    await provider.getChildren();

    expect(
      provider.decorationStateFor(sessionUri({ provider: 'codex', id: 'other' })),
    ).toBeUndefined();
    expect(
      provider.decorationStateFor({ scheme: 'file', path: '/tmp/a' } as never),
    ).toBeUndefined();
  });

  it('絞り込みで消えた行の状態は返さない', async () => {
    const shown = session({ id: 's1', threadName: 'あたり' });
    const hidden = session({ id: 's2', threadName: 'はずれ' });
    const provider = makeProvider([shown, hidden], new PinnedSessionStore(), [], () => 'running');
    await provider.getChildren();
    // 陽性対照: 絞り込む前は両方引ける
    expect(provider.decorationStateFor(sessionUri(hidden))).toBe('running');

    await provider.setFilter('あたり');
    await provider.getChildren();

    expect(provider.decorationStateFor(sessionUri(shown))).toBe('running');
    expect(provider.decorationStateFor(sessionUri(hidden))).toBeUndefined();
  });

  it('装飾の引き直しは一覧が入れ替わった後に促す（refreshの時点ではない）', async () => {
    // onDidChangeTreeData は再読込を「依頼した」時点で発火する。そこで装飾を引き直させると
    // まだ古い一覧を読んでしまい、次に一覧が届いても誰も引き直さないまま古いバッジが残る
    const s = session({ id: 's1' });
    const provider = makeProvider([s], new PinnedSessionStore(), [], () => 'running');
    const order: string[] = [];
    provider.onDidChangeTreeData(() => order.push('tree'));
    provider.onDidChangeDecorations(() => order.push('decorations'));

    provider.refresh();
    expect(order).toEqual(['tree']);

    await provider.getChildren();

    expect(order).toEqual(['tree', 'decorations']);
  });

  it('resourceUriを足してもコマンド引数とcontextValueは変わらない（issue #236の再発防止）', () => {
    const s = session({ id: 's1', provider: 'codex', archived: false });
    const provider = makeProvider([s]);

    const item = provider.getTreeItem(s);

    expect(item.id).toBe('codex:s1');
    expect(item.command?.command).toBe('codex.openSession');
    expect(item.command?.arguments).toEqual([s]);
    expect(item.contextValue).toBe('codexSession.codex');
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
    const sessions = [session({ id: 's1', cwd: '/repo/a' }), session({ id: 's2', cwd: '/repo/b' })];
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

describe('絞り込み中のラベルの強調（issue #738）', () => {
  const named = session({ id: 's1', threadName: '認証まわりの相談', cwd: '/tmp/example' });

  it('絞り込みが無いときは素の文字列を返す', () => {
    const provider = makeProvider([named]);
    expect(provider.getTreeItem(named).label).toBe('認証まわりの相談');
  });

  it('スレッド名に一致すると一致箇所つきのラベルを返す', async () => {
    const provider = makeProvider([named]);
    await provider.setFilter('まわり');
    expect(provider.getTreeItem(named).label).toEqual({
      label: '認証まわりの相談',
      highlights: [[2, 5]],
    });
  });

  it('大小文字が違う一致でも元の文字列の位置を強調する', async () => {
    const s = session({ id: 's2', threadName: 'Fix Auth bug' });
    const provider = makeProvider([s]);
    await provider.setFilter('auth');
    expect(provider.getTreeItem(s).label).toEqual({
      label: 'Fix Auth bug',
      highlights: [[4, 8]],
    });
  });

  it('cwdだけに一致した行は強調なしの素の文字列で出す', async () => {
    const provider = makeProvider([named]);
    __mock.setConfig('codex', { 'history.groupBy': 'none' });
    await provider.setFilter('example');
    // 陽性対照: この語では確かに行が残る（強調が無いのは「絞り込まれて消えた」からではない）
    expect(await provider.getChildren()).toEqual([named]);
    expect(provider.getTreeItem(named).label).toBe('認証まわりの相談');
  });

  it('名前の無いセッションは既定のラベルのまま出す', async () => {
    const s = session({ id: 's3', threadName: undefined, cwd: '/tmp/example' });
    const provider = makeProvider([s]);
    await provider.setFilter('example');
    expect(provider.getTreeItem(s).label).toBe('(名称未設定)');
  });

  it('絞り込みを解除すると強調が消える', async () => {
    const provider = makeProvider([named]);
    await provider.setFilter('認証');
    expect(provider.getTreeItem(named).label).not.toBe('認証まわりの相談');
    await provider.clearFilter();
    expect(provider.getTreeItem(named).label).toBe('認証まわりの相談');
  });
});
