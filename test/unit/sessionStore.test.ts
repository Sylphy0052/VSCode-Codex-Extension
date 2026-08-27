import { beforeEach, describe, expect, it } from 'vitest';
import { codexPaths } from '../../src/codex/cliLocator';
import type { SessionSummary } from '../../src/codex/types';
import {
  InMemoryMetaCache,
  type FileSystemPort,
  type ThreadListPort,
} from '../../src/session/ports';
import { SessionStore, isWithinAny } from '../../src/session/sessionStore';

const HOME = '/home/u/.codex';
const paths = codexPaths(HOME);

const ID_A = '019fd79f-1e16-7b60-b9d2-0324b275ed81';
const ID_B = '019fd7a6-d25e-7bd2-b181-751e467277f3';
const ID_C = '019fd7c1-9554-7f62-816e-50e8acf1ed38';
const ID_D = '019fd7d2-aaaa-7bbb-8ccc-0123456789ab';

const rollout = (dir: string, id: string) => `${dir}/rollout-2026-08-07T00-00-00-${id}.jsonl`;

const metaLine = (id: string, cwd: string) =>
  JSON.stringify({
    type: 'session_meta',
    payload: {
      session_id: id,
      cwd,
      timestamp: '2026-08-06T15:00:00Z',
      originator: 'codex_vscode',
      source: 'vscode',
      thread_source: 'user',
    },
  });

const userLine = (message: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } });

const indexLine = (id: string, name: string, updated: string) =>
  JSON.stringify({ id, thread_name: name, updated_at: updated });

class FakeFs implements FileSystemPort {
  firstLineReads = 0;

  constructor(private readonly files: Record<string, string>) {}

  async readTextFile(filePath: string): Promise<string | undefined> {
    return this.files[filePath];
  }

  async readFirstLine(filePath: string): Promise<string | undefined> {
    this.firstLineReads++;
    return this.files[filePath]?.split('\n')[0];
  }

  async readTail(filePath: string, maxBytes: number): Promise<string | undefined> {
    const content = this.files[filePath];
    return content === undefined ? undefined : content.slice(-maxBytes);
  }

  async mtimeMs(filePath: string): Promise<number | undefined> {
    return this.files[filePath] === undefined ? undefined : 0;
  }

  async readBase64File(filePath: string): Promise<string | undefined> {
    const content = this.files[filePath];
    return content === undefined ? undefined : Buffer.from(content).toString('base64');
  }

  async readHead(filePath: string, maxLines: number): Promise<string[]> {
    return (this.files[filePath]?.split('\n') ?? []).slice(0, maxLines);
  }

  async listRollouts(dir: string): Promise<string[]> {
    return Object.keys(this.files).filter(
      (p) => p.startsWith(`${dir}/`) && p.slice(p.lastIndexOf('/') + 1).startsWith('rollout-'),
    );
  }

  async listJsonl(dir: string): Promise<string[]> {
    return Object.keys(this.files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.jsonl'));
  }

  async listMarkdown(dir: string): Promise<string[]> {
    return Object.keys(this.files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.md'));
  }
}

const buildFs = () =>
  new FakeFs({
    [paths.sessionIndex]: [
      indexLine(ID_A, 'プロジェクトA', '2026-08-06T15:09:29Z'),
      indexLine(ID_B, 'プロジェクトB', '2026-08-06T15:17:53Z'),
      indexLine(ID_C, 'アーカイブ済み', '2026-08-06T15:46:59Z'),
    ].join('\n'),
    [rollout(`${paths.sessions}/2026/08/07`, ID_A)]: metaLine(ID_A, '/work/alpha'),
    [rollout(`${paths.sessions}/2026/08/07`, ID_B)]: metaLine(ID_B, '/work/beta'),
    [rollout(paths.archivedSessions, ID_C)]: metaLine(ID_C, '/work/alpha'),
    // 要約名が確定しておらず index に載っていないセッション
    [rollout(`${paths.sessions}/2026/08/07`, ID_D)]: [
      metaLine(ID_D, '/work/alpha'),
      userLine('テスト用の指示を書く'),
    ].join('\n'),
  });

const options = (over: Partial<Parameters<SessionStore['list']>[0]> = {}) => ({
  scope: 'workspace' as const,
  workspaceFolders: ['/work/alpha'],
  maxEntries: 200,
  ...over,
});

describe('SessionStore.list', () => {
  let fs: FakeFs;
  let store: SessionStore;
  let cache: InMemoryMetaCache;

  beforeEach(() => {
    fs = buildFs();
    cache = new InMemoryMetaCache();
    store = new SessionStore(fs, paths, cache);
  });

  it('workspaceスコープでは配下のcwdのセッションだけを返す', async () => {
    const { sessions } = await store.list(options());
    expect(sessions.map((s) => s.id).sort()).toEqual([ID_A, ID_C, ID_D].sort());
  });

  it('indexに載っていないセッションもロールアウトがあれば出す', async () => {
    const { sessions } = await store.list(options({ scope: 'all' }));
    expect(sessions.map((s) => s.id)).toContain(ID_D);
  });

  it('要約名が無ければ最初の指示を表示名にする', async () => {
    const { sessions } = await store.list(options({ scope: 'all' }));
    expect(sessions.find((s) => s.id === ID_D)?.threadName).toBe('テスト用の指示を書く');
  });

  it('更新時刻の降順で並ぶ', async () => {
    const { sessions } = await store.list(options({ scope: 'all', workspaceFolders: [] }));
    // ID_D は index に無いためファイルの更新時刻（Fakeでは0）で最後に来る
    expect(sessions.map((s) => s.threadName)).toEqual([
      'アーカイブ済み',
      'プロジェクトB',
      'プロジェクトA',
      'テスト用の指示を書く',
    ]);
  });

  it('allスコープでは全ワークスペースのセッションを返す', async () => {
    const { sessions } = await store.list(options({ scope: 'all' }));
    expect(sessions).toHaveLength(4);
  });

  it('archived_sessions配下のものにarchivedフラグを立てる', async () => {
    const { sessions } = await store.list(options({ scope: 'all' }));
    expect(sessions.find((s) => s.id === ID_C)?.archived).toBe(true);
    expect(sessions.find((s) => s.id === ID_A)?.archived).toBe(false);
  });

  it('maxEntriesで上位N件に絞り、それ以上のsession_metaを読まない', async () => {
    const { sessions } = await store.list(options({ scope: 'all', maxEntries: 1 }));
    expect(sessions.map((s) => s.id)).toEqual([ID_C]);
    expect(fs.firstLineReads).toBe(1);
  });

  it('2回目の呼び出しはキャッシュを使い、1行目を読み直さない', async () => {
    await store.list(options({ scope: 'all' }));
    const after = fs.firstLineReads;
    await store.list(options({ scope: 'all' }));
    expect(fs.firstLineReads).toBe(after);
  });

  it('ロールアウトが消えたセッションはworkspaceスコープから除外しunresolvedに数える', async () => {
    const partial = new FakeFs({
      [paths.sessionIndex]: indexLine(ID_A, '消えた', '2026-08-06T15:09:29Z'),
    });
    const result = await new SessionStore(partial, paths, new InMemoryMetaCache()).list(options());
    expect(result.sessions).toEqual([]);
    expect(result.unresolved).toBe(1);
  });

  it('実体が消えたエントリは出さず、未解決として数える', async () => {
    // 一覧はロールアウトの実在を骨格にするため、ファイルが無ければ開けない＝出さない
    const partial = new FakeFs({
      [paths.sessionIndex]: indexLine(ID_A, '消えた', '2026-08-06T15:09:29Z'),
    });
    const result = await new SessionStore(partial, paths, new InMemoryMetaCache()).list(
      options({ scope: 'all' }),
    );
    expect(result.sessions).toEqual([]);
    expect(result.unresolved).toBe(1);
  });

  it('indexが無ければ空を返す', async () => {
    const empty = new FakeFs({});
    const result = await new SessionStore(empty, paths, new InMemoryMetaCache()).list(options());
    expect(result).toEqual({ sessions: [], skippedIndexLines: 0, unresolved: 0 });
  });

  it('壊れたindex行を数えつつ残りを返す', async () => {
    const broken = new FakeFs({
      [paths.sessionIndex]: `${indexLine(ID_A, 'ok', '2026-08-06T15:09:29Z')}\n{"id":"019f`,
      [rollout(`${paths.sessions}/2026/08/07`, ID_A)]: metaLine(ID_A, '/work/alpha'),
    });
    const result = await new SessionStore(broken, paths, new InMemoryMetaCache()).list(options());
    expect(result.sessions).toHaveLength(1);
    expect(result.skippedIndexLines).toBe(1);
  });
});

/** thread/list の1件を模したSessionSummary（正規化後の形。src/codex/threadList.tsのテスト対象外）。 */
const threadSession = (id: string, cwd: string, updatedAt: string): SessionSummary => ({
  id,
  provider: 'codex',
  threadName: `thread-${id}`,
  updatedAt,
  cwd,
  archived: false,
});

const okPort =
  (sessions: SessionSummary[]): ThreadListPort =>
  async () => ({ ok: true, sessions });

const emptyPort: ThreadListPort = async () => ({ ok: true, sessions: [] });

const failingPort =
  (error: string): ThreadListPort =>
  async () => ({ ok: false, error });

describe('SessionStore.list（thread/list優先・ファイル読みへの退避）', () => {
  it('thread/listが空でなければそれを使い、ファイルは一切読まない', async () => {
    const fs = buildFs();
    const store = new SessionStore(fs, paths, new InMemoryMetaCache());
    store.attachThreadList(okPort([threadSession(ID_A, '/work/alpha', '2026-08-06T15:09:29Z')]));

    const result = await store.list(options({ scope: 'all' }));
    expect(result.sessions.map((s) => s.id)).toEqual([ID_A]);
    expect(result.threadListFallbackReason).toBeUndefined();
    expect(fs.firstLineReads).toBe(0);
  });

  it('thread/listの結果にもworkspaceスコープの絞り込みを適用する', async () => {
    const store = new SessionStore(buildFs(), paths, new InMemoryMetaCache());
    store.attachThreadList(
      okPort([
        threadSession(ID_A, '/work/alpha', '2026-08-06T15:09:29Z'),
        threadSession(ID_B, '/work/other', '2026-08-06T15:10:00Z'),
      ]),
    );

    const result = await store.list(options({ scope: 'workspace' }));
    expect(result.sessions.map((s) => s.id)).toEqual([ID_A]);
  });

  it('thread/listの結果にもmaxEntriesの上限を適用する', async () => {
    const store = new SessionStore(buildFs(), paths, new InMemoryMetaCache());
    store.attachThreadList(
      okPort([
        threadSession(ID_A, '/work/alpha', '2026-08-06T15:09:29Z'),
        threadSession(ID_B, '/work/alpha', '2026-08-06T15:10:00Z'),
      ]),
    );

    const result = await store.list(options({ scope: 'all', maxEntries: 1 }));
    // 更新時刻の降順で先頭1件
    expect(result.sessions.map((s) => s.id)).toEqual([ID_B]);
  });

  it('thread/listが空応答ならファイル読みへ退避し、理由を残す', async () => {
    const fs = buildFs();
    const store = new SessionStore(fs, paths, new InMemoryMetaCache());
    store.attachThreadList(emptyPort);

    const viaFiles = await new SessionStore(buildFs(), paths, new InMemoryMetaCache()).list(
      options({ scope: 'all' }),
    );
    const result = await store.list(options({ scope: 'all' }));

    expect(result.sessions.map((s) => s.id).sort()).toEqual(
      viaFiles.sessions.map((s) => s.id).sort(),
    );
    expect(result.threadListFallbackReason).toBeDefined();
    expect(fs.firstLineReads).toBeGreaterThan(0);
  });

  it('thread/listが失敗したらファイル読みへ退避し、エラー理由を残す', async () => {
    const store = new SessionStore(buildFs(), paths, new InMemoryMetaCache());
    store.attachThreadList(failingPort('app-serverが応答しませんでした'));

    const result = await store.list(options({ scope: 'all' }));
    expect(result.sessions.length).toBeGreaterThan(0);
    expect(result.threadListFallbackReason).toBe('app-serverが応答しませんでした');
  });

  it('attachThreadListを呼ばなければ従来どおりファイル読みのみで動く', async () => {
    const store = new SessionStore(buildFs(), paths, new InMemoryMetaCache());
    const result = await store.list(options({ scope: 'all' }));
    expect(result.threadListFallbackReason).toBeUndefined();
    expect(result.sessions.length).toBeGreaterThan(0);
  });
});

describe('SessionStore.resolveHandoffRolloutPath', () => {
  it('JSONLの先頭IDとthread/listの両方が一致するときだけ返す', async () => {
    const store = new SessionStore(buildFs(), paths, new InMemoryMetaCache());
    store.attachThreadList(okPort([threadSession(ID_A, '/work/alpha', '2026-08-06T15:09:29Z')]));

    await expect(store.resolveHandoffRolloutPath(ID_A)).resolves.toBe(
      rollout(`${paths.sessions}/2026/08/07`, ID_A),
    );
  });

  it('thread/listに無い間は返さない', async () => {
    const store = new SessionStore(buildFs(), paths, new InMemoryMetaCache());
    store.attachThreadList(emptyPort);

    await expect(store.resolveHandoffRolloutPath(ID_A)).resolves.toBeUndefined();
  });

  it('ロールアウト先頭のsession IDが異なれば返さない', async () => {
    const path = rollout(`${paths.sessions}/2026/08/07`, ID_A);
    const fs = new FakeFs({ [path]: metaLine(ID_B, '/work/alpha') });
    const store = new SessionStore(fs, paths, new InMemoryMetaCache());
    store.attachThreadList(okPort([threadSession(ID_A, '/work/alpha', '2026-08-06T15:09:29Z')]));

    await expect(store.resolveHandoffRolloutPath(ID_A)).resolves.toBeUndefined();
  });
});

describe('SessionStore.pruneCache', () => {
  it('実体が消えたエントリだけを落とす', async () => {
    const fs = buildFs();
    const cache = new InMemoryMetaCache();
    const store = new SessionStore(fs, paths, cache);
    await store.list(options({ scope: 'all' }));
    expect(cache.keys()).toHaveLength(4);

    const shrunk = new FakeFs({
      [paths.sessionIndex]: '',
      [rollout(`${paths.sessions}/2026/08/07`, ID_A)]: metaLine(ID_A, '/work/alpha'),
    });
    const removed = await new SessionStore(shrunk, paths, cache).pruneCache();
    expect(removed).toBe(3);
    expect(cache.keys()).toEqual([ID_A]);
  });
});

describe('isWithinAny', () => {
  it('配下と一致を真とする', () => {
    expect(isWithinAny('/work/alpha', ['/work/alpha'])).toBe(true);
    expect(isWithinAny('/work/alpha/src', ['/work/alpha'])).toBe(true);
  });

  it('前方一致だけの別ディレクトリを誤って含めない', () => {
    expect(isWithinAny('/work/alpha-old', ['/work/alpha'])).toBe(false);
    expect(isWithinAny('/work', ['/work/alpha'])).toBe(false);
  });

  it('末尾スラッシュの有無を吸収する', () => {
    expect(isWithinAny('/work/alpha/', ['/work/alpha'])).toBe(true);
    expect(isWithinAny('/work/alpha/src', ['/work/alpha/'])).toBe(true);
  });

  it('フォルダが無ければ常に偽', () => {
    expect(isWithinAny('/work/alpha', [])).toBe(false);
  });
});
