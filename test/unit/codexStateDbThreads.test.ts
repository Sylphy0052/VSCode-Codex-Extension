import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pickStateDbFile,
  readStateDbThreads,
  toStateDbSession,
} from '../../src/codex/stateDbThreads';
import {
  buildAllPeriodHistory,
  transcriptPathsToCheck,
} from '../../src/view/missionControlSessions';
import { missingFiles, SessionCatalog } from '../../src/view/sessionCatalog';
import { EMPTY_HISTORY_FILTER, filterHistory } from '../../src/webview/missionControl/logic';

const COLUMNS = `id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, first_user_message TEXT NOT NULL DEFAULT '',
  thread_source TEXT, name TEXT`;

interface Row {
  id: string;
  source?: string;
  threadSource?: string | null;
  name?: string | null;
  title?: string;
  firstUserMessage?: string;
  updatedAt?: number;
  cwd?: string;
}

function createDb(file: string, rows: Row[], columns = COLUMNS): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (${columns})`);
  if (rows.length === 0) {
    db.close();
    return;
  }
  const insert = db.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title,
      first_user_message, thread_source, name) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.id,
      `/codex/sessions/rollout-${r.id}.jsonl`,
      r.updatedAt ?? 1_790_000_000,
      r.source ?? 'vscode',
      r.cwd ?? '/work/repo',
      r.title ?? `title ${r.id}`,
      r.firstUserMessage ?? '',
      r.threadSource ?? null,
      r.name ?? null,
    );
  }
  db.close();
}

describe('pickStateDbFile', () => {
  it('state_<N>.sqliteのうちNが最大のものを選ぶ', () => {
    expect(
      pickStateDbFile(['state_4.sqlite', 'state_12.sqlite', 'state_5.sqlite-wal', 'logs_2.sqlite']),
    ).toBe('state_12.sqlite');
    expect(pickStateDbFile(['logs_2.sqlite'])).toBeUndefined();
  });
});

describe('toStateDbSession', () => {
  it('派生スレッドと形の違う行を落とす', () => {
    expect(toStateDbSession({ id: 'a', updated_at: 1, thread_source: 'subagent' })).toBeUndefined();
    expect(toStateDbSession({ id: '', updated_at: 1 })).toBeUndefined();
    expect(toStateDbSession({ id: 'a', updated_at: '1' })).toBeUndefined();
  });

  it('IDE拡張の前置きを除いて依頼文にし、名前が無ければtitleを見出しにする', () => {
    const session = toStateDbSession({
      id: 'a',
      updated_at: 1_790_000_000,
      thread_source: null,
      name: null,
      title: '自動の見出し',
      first_user_message: '# Context from my IDE setup\n\n## My request for Codex:\n本当の依頼',
      rollout_path: '/r.jsonl',
      cwd: '/w',
      archived: 0,
    });
    expect(session).toMatchObject({
      id: 'a',
      provider: 'codex',
      threadName: '自動の見出し',
      firstPrompt: '本当の依頼',
      rolloutPath: '/r.jsonl',
      cwd: '/w',
      archived: false,
      updatedAt: new Date(1_790_000_000_000).toISOString(),
    });
  });
});

describe('readStateDbThreads', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-state-db-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('対話の起動元のスレッドだけを新しい順に読む（200件を超える古い分も含む）', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 250; i++) {
      rows.push({ id: `v${String(i)}`, updatedAt: 1_790_000_000 + i, name: `会話${String(i)}` });
    }
    rows.push({ id: 'exec1', source: 'exec', threadSource: 'user', updatedAt: 1_800_000_000 });
    rows.push({ id: 'sub1', source: 'vscode', threadSource: 'subagent' });
    rows.push({ id: 'cli1', source: 'cli', threadSource: 'user', updatedAt: 1_700_000_000 });
    createDb(join(dir, 'state_5.sqlite'), rows);

    const sessions = await readStateDbThreads(dir);
    const ids = sessions.map((s) => s.id);
    expect(ids).toHaveLength(251);
    expect(ids[0]).toBe('v249');
    expect(ids).toContain('v0');
    expect(ids.at(-1)).toBe('cli1');
    expect(ids).not.toContain('exec1');
    expect(ids).not.toContain('sub1');
  });

  it('目録へ入れると改行を含む見出し・依頼文が1行に均される', async () => {
    createDb(join(dir, 'state_5.sqlite'), [
      { id: 'x', name: '見出し\n## 偽の見出し', firstUserMessage: '依頼\r\n- 偽の項目' },
    ]);
    const catalog = new SessionCatalog(join(dir, 'catalog.json'));
    const [entry] = await catalog.merge(await readStateDbThreads(dir));
    expect(entry?.title).not.toMatch(/[\r\n]/);
    expect(entry?.firstPrompt).not.toMatch(/[\r\n]/);
    expect(entry?.transcriptPath).toBe('/codex/sessions/rollout-x.jsonl');
  });

  it('rolloutもhandoffも無い古いCodexのセッションを、依頼文で全期間の履歴から引ける', async () => {
    const rows: Row[] = [{ id: 'ancient', name: '昔の会話', firstUserMessage: '古いバグの調査' }];
    for (let i = 0; i < 300; i++) {
      rows.push({ id: `new${String(i)}`, updatedAt: 1_800_000_000 + i });
    }
    createDb(join(dir, 'state_5.sqlite'), rows);
    // 今の一覧（thread/list）には新しい200件だけが載っている
    const listed = (await readStateDbThreads(dir))
      .filter((s) => s.id.startsWith('new'))
      .slice(0, 200);
    const catalog = await new SessionCatalog(join(dir, 'catalog.json')).merge([
      ...(await readStateDbThreads(dir)),
      ...listed,
    ]);
    const missing = await missingFiles(transcriptPathsToCheck(listed, catalog, []));
    const built = buildAllPeriodHistory({
      listed,
      catalog,
      handoffs: [],
      missing,
      resolveRepo: (cwd) => ({ key: cwd ?? '', label: cwd ?? '', full: cwd ?? '' }),
    });
    const hits = filterHistory(built.items, { ...EMPTY_HISTORY_FILTER, query: '古いバグ' });
    expect(hits.map((i) => i.threadId)).toEqual(['ancient']);
    expect(hits[0]).toMatchObject({ title: '昔の会話', transcriptMissing: true });
    expect(built.offList.find((s) => s.threadId === 'ancient')?.transcriptMissing).toBe(true);
  });

  it('DBが無い・壊れている・列が足りないときは空を返し、警告だけ残す', async () => {
    const warnings: string[] = [];
    const log = { warn: (m: string) => warnings.push(m) };
    expect(await readStateDbThreads(join(dir, 'missing'), log)).toEqual([]);
    expect(await readStateDbThreads(dir, log)).toEqual([]);

    await writeFile(join(dir, 'state_5.sqlite'), 'これはsqliteではない');
    expect(await readStateDbThreads(dir, log)).toEqual([]);
    expect(warnings.at(-1)).toContain('読めませんでした');

    await rm(join(dir, 'state_5.sqlite'));
    createDb(join(dir, 'state_6.sqlite'), [], 'id TEXT PRIMARY KEY, updated_at INTEGER');
    expect(await readStateDbThreads(dir, log)).toEqual([]);
    expect(warnings.at(-1)).toContain('形が想定と違う');
  });
});
