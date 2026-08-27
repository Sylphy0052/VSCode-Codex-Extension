import { describe, expect, it } from 'vitest';
import {
  normalizeThread,
  normalizeThreadList,
  parseThreadListPage,
} from '../../src/codex/threadList';

const ARCHIVED_DIR = '/home/u/.codex/archived_sessions';
const SESSIONS_DIR = '/home/u/.codex/sessions/2026/08/11';

/**
 * 実測（codex-cli 0.147.0、`thread/list` `{limit: 100}` を全件ページングし尽くした33件）を模した
 * エントリ。`threadSource` は33件全てで `null` だったため、既定値も `null` にする。
 */
const rawThread = (over: Record<string, unknown> = {}) => ({
  id: '019ff049-df7c-7272-ba69-9b333f9d9102',
  sessionId: '019ff049-df7c-7272-ba69-9b333f9d9102',
  forkedFromId: null,
  parentThreadId: null,
  preview: '# Context from my IDE setup:\n\n',
  ephemeral: false,
  createdAt: 1786442801,
  updatedAt: 1786444859,
  recencyAt: 1786444839,
  status: { type: 'notLoaded' },
  path: `${SESSIONS_DIR}/rollout-2026-08-11T19-06-41-019ff049-df7c-7272-ba69-9b333f9d9102.jsonl`,
  cwd: '/home/kfuruhashi/workspace/github/novel-writer',
  cliVersion: '0.147.0-alpha.6.5',
  source: 'vscode',
  threadSource: null,
  gitInfo: { sha: 'c000', branch: 'feat/reader-lan-url', originUrl: 'git@github.com:x/y.git' },
  name: 'Arc02の改稿を続行',
  turns: [],
  ...over,
});

describe('parseThreadListPage', () => {
  it('data と nextCursor を読む', () => {
    const page = parseThreadListPage({
      data: [{ id: 'a' }, { id: 'b' }],
      nextCursor: '2026-08-11T00:52:11Z',
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('2026-08-11T00:52:11Z');
  });

  it('nextCursorが無ければ続きなしとする', () => {
    const page = parseThreadListPage({ data: [] });
    expect(page.nextCursor).toBeUndefined();
  });

  it('dataが配列でなければ空にする', () => {
    expect(parseThreadListPage({ data: 'not-array' }).items).toEqual([]);
    expect(parseThreadListPage(null).items).toEqual([]);
    expect(parseThreadListPage('string').items).toEqual([]);
  });
});

describe('normalizeThread', () => {
  it('実測どおりの形をSessionSummaryへ正規化する', () => {
    const session = normalizeThread(rawThread(), ARCHIVED_DIR);
    expect(session).toEqual({
      id: '019ff049-df7c-7272-ba69-9b333f9d9102',
      provider: 'codex',
      threadName: 'Arc02の改稿を続行',
      updatedAt: new Date(1786444859 * 1000).toISOString(),
      cwd: '/home/kfuruhashi/workspace/github/novel-writer',
      archived: false,
      rolloutPath:
        '/home/u/.codex/sessions/2026/08/11/rollout-2026-08-11T19-06-41-019ff049-df7c-7272-ba69-9b333f9d9102.jsonl',
      parentThreadId: undefined,
    });
  });

  it('archivedSessionsDir配下のpathはarchived:trueにする', () => {
    const session = normalizeThread(
      rawThread({ path: `${ARCHIVED_DIR}/rollout-2026-08-11T19-06-41-019ff049.jsonl` }),
      ARCHIVED_DIR,
    );
    expect(session?.archived).toBe(true);
  });

  it('threadSourceがuser以外の派生スレッドは除く', () => {
    expect(normalizeThread(rawThread({ threadSource: 'subagent' }), ARCHIVED_DIR)).toBeUndefined();
  });

  it('threadSourceがnullや未設定の場合は一覧へ含める（実測では全件nullで返る。issue #224）', () => {
    expect(normalizeThread(rawThread({ threadSource: null }), ARCHIVED_DIR)).toBeDefined();
    expect(normalizeThread(rawThread({ threadSource: undefined }), ARCHIVED_DIR)).toBeDefined();
  });

  it('threadSourceが明示的にuserの場合も一覧へ含める', () => {
    expect(normalizeThread(rawThread({ threadSource: 'user' }), ARCHIVED_DIR)).toBeDefined();
  });

  it('idが無ければ除く', () => {
    expect(normalizeThread(rawThread({ id: '' }), ARCHIVED_DIR)).toBeUndefined();
    expect(normalizeThread(rawThread({ id: undefined }), ARCHIVED_DIR)).toBeUndefined();
  });

  it('updatedAtが読めなければ除く', () => {
    expect(normalizeThread(rawThread({ updatedAt: undefined }), ARCHIVED_DIR)).toBeUndefined();
    expect(normalizeThread(rawThread({ updatedAt: 'not-a-date' }), ARCHIVED_DIR)).toBeUndefined();
  });

  it('updatedAtがISO8601文字列でも受け付ける', () => {
    const session = normalizeThread(
      rawThread({ updatedAt: '2026-08-11T00:52:11.000Z' }),
      ARCHIVED_DIR,
    );
    expect(session?.updatedAt).toBe('2026-08-11T00:52:11.000Z');
  });

  it('nameが無ければthreadNameはundefined', () => {
    const session = normalizeThread(rawThread({ name: undefined }), ARCHIVED_DIR);
    expect(session?.threadName).toBeUndefined();
  });

  it('cwdが空ならundefinedにする', () => {
    const session = normalizeThread(rawThread({ cwd: '' }), ARCHIVED_DIR);
    expect(session?.cwd).toBeUndefined();
  });

  it('parentThreadIdが入っていれば読む（issue #34。実データでは未確認、スキーマ根拠）', () => {
    const session = normalizeThread(rawThread({ parentThreadId: 'thread_parent_1' }), ARCHIVED_DIR);
    expect(session?.parentThreadId).toBe('thread_parent_1');
  });

  it('parentThreadIdが無ければundefinedのまま', () => {
    const session = normalizeThread(rawThread(), ARCHIVED_DIR);
    expect(session?.parentThreadId).toBeUndefined();
  });

  it('オブジェクトでない入力はundefinedを返す', () => {
    expect(normalizeThread(null, ARCHIVED_DIR)).toBeUndefined();
    expect(normalizeThread('string', ARCHIVED_DIR)).toBeUndefined();
    expect(normalizeThread(42, ARCHIVED_DIR)).toBeUndefined();
  });
});

describe('normalizeThreadList', () => {
  it('正規化できた要素だけを順序を保って返す', () => {
    const sessions = normalizeThreadList(
      [
        rawThread({ id: 'a' }),
        rawThread({ id: 'b', threadSource: 'subagent' }),
        rawThread({ id: 'c' }),
      ],
      ARCHIVED_DIR,
    );
    expect(sessions.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('空配列を渡せば空配列を返す', () => {
    expect(normalizeThreadList([], ARCHIVED_DIR)).toEqual([]);
  });
});
