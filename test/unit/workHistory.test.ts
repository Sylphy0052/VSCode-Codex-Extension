import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SharedSession } from '../../src/view/sessionHub';
import {
  dayFileName,
  normalizeRetentionDays,
  readWorkHistory,
  WORK_HISTORY_DIR_NAME,
  WorkHistoryStore,
  type WorkHistoryRecord,
  type WorkHistorySessionRecord,
} from '../../src/view/workHistory';
import {
  extractIssueNumber,
  reportWorkHistoryHandoff,
  setWorkHistoryHandoffSink,
  USAGE_DUPLICATE_WINDOW_MS,
  WorkHistoryRecorder,
} from '../../src/view/workHistoryRecorder';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 26, 12, 0, 0).getTime();
/** 秘密の形をした値。走査に引っかからないよう組み立てる。 */
const FAKE_TOKEN = `gh${'p'}_${'a1'.repeat(18)}`;

function session(overrides: Partial<SharedSession> = {}): SharedSession {
  return {
    threadId: 't1',
    title: 'Issue #2175 の実装',
    cwd: '/repo',
    provider: 'claude',
    activity: 'idle',
    ...overrides,
  };
}

function startRecord(at: number, threadId: string): WorkHistoryRecord {
  return {
    v: 1,
    kind: 'session',
    at,
    event: 'start',
    windowId: 'w',
    provider: 'codex',
    threadId,
  };
}

let dir: string;
let now: number;
let errors: string[];
let store: WorkHistoryStore;

function recorder(retentionDays = 90): WorkHistoryRecorder {
  return new WorkHistoryRecorder({
    store,
    windowId: 'w1',
    retentionDays: () => retentionDays,
    now: () => now,
  });
}

async function sessionRecords(): Promise<WorkHistorySessionRecord[]> {
  return (await readWorkHistory(dir, { kind: 'session' })) as WorkHistorySessionRecord[];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'work-history-'));
  now = NOW;
  errors = [];
  store = new WorkHistoryStore(dir, (message) => errors.push(message));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('WorkHistoryRecorder: セッションのイベント', () => {
  it('開始から終了までのイベントを保存し、別の読み手（Reload後）から読める', async () => {
    const r = recorder();
    r.observeSessions([session({ activity: 'running' })]);
    now += 1000;
    const skills = [{ name: 'gitlab-develop', at: now - 10 }];
    r.observeSessions([
      session({
        activity: 'running',
        purpose: '作業履歴を保存する',
        branch: 'feature/2175/t5',
        skills,
      }),
    ]);
    now += 1000;
    r.observeSessions([
      session({
        activity: 'idle',
        purpose: '作業履歴を保存する',
        branch: 'feature/2175/t5',
        costUsd: 1.5,
        skills,
      }),
    ]);
    now += 1000;
    r.recordHandoff('claude', 't1', 't2');
    now += 1000;
    r.observeSessions([]);
    await store.flush();

    const records = await sessionRecords();
    expect(records.map((rec) => rec.event)).toEqual([
      'start',
      'skill',
      'update',
      'turn',
      'handoff',
      'end',
    ]);
    expect(records[1]?.skill).toBe('gitlab-develop');
    expect(records[2]).toMatchObject({ purpose: '作業履歴を保存する', issue: 2175 });
    expect(records[3]?.costUsd).toBe(1.5);
    expect(records[4]?.childThreadId).toBe('t2');
    expect(records[5]).toMatchObject({ reason: 'closed', costUsd: 1.5, windowId: 'w1' });
    expect(errors).toEqual([]);
  });

  it('記録済みのskillは二度書かない', async () => {
    const r = recorder();
    const skills = [{ name: 'a', at: NOW - 5 }];
    r.observeSessions([session({ skills })]);
    r.observeSessions([session({ skills })]);
    await store.flush();
    expect((await sessionRecords()).filter((rec) => rec.event === 'skill')).toHaveLength(1);
  });

  it('stopで開いていたセッションのendを同期で書き、以降は記録しない', async () => {
    const r = recorder();
    r.observeSessions([session()]);
    await store.flush();
    r.stop();
    expect(r.observeSessions([session({ threadId: 't9' })])).toEqual([]);
    expect((await sessionRecords()).map((rec) => [rec.event, rec.reason])).toEqual([
      ['start', undefined],
      ['end', 'shutdown'],
    ]);
  });

  it('書けなくても例外を投げずonErrorへ渡す', async () => {
    // 保存先のディレクトリと同名のファイルを置いて、mkdirを失敗させる
    await writeFile(join(dir, WORK_HISTORY_DIR_NAME), '');
    const r = recorder();
    expect(() => r.observeSessions([session()])).not.toThrow();
    await store.flush();
    expect(() => r.stop()).not.toThrow();
    // 追記（observeSessionsとstop）の2件。初回の追記で走る古い記録の削除も失敗を渡す
    expect(errors.filter((m) => m.includes('作業履歴を追記できませんでした'))).toHaveLength(2);
    expect(errors.filter((m) => m.includes('古い作業履歴を消せませんでした'))).toHaveLength(1);
  });

  it('引き継ぎの口から親子を記録する（親が未記録でも書く）', async () => {
    const r = recorder();
    setWorkHistoryHandoffSink((provider, parent, child) => {
      r.recordHandoff(provider, parent, child);
    });
    try {
      reportWorkHistoryHandoff('codex', 'p1', 'c1');
    } finally {
      setWorkHistoryHandoffSink(undefined);
    }
    reportWorkHistoryHandoff('codex', 'p2', 'c2');
    await store.flush();
    expect(
      (await sessionRecords()).map((rec) => [rec.event, rec.threadId, rec.childThreadId]),
    ).toEqual([['handoff', 'p1', 'c1']]);
  });

  it('保存前に既知の秘密の形を伏せ、改行を落として1行にする', async () => {
    const r = recorder();
    r.observeSessions([session({ title: `token ${FAKE_TOKEN}\n偽の行` })]);
    await store.flush();
    const text = await readFile(join(dir, WORK_HISTORY_DIR_NAME, dayFileName(NOW)), 'utf8');
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text.trim().split('\n')).toHaveLength(1);
    const [record] = await sessionRecords();
    expect(record?.title).not.toContain('\n');
  });
});

describe('WorkHistoryRecorder: 利用枠', () => {
  const codexWindow = {
    label: '週次',
    usedPercent: 40,
    resetsAt: NOW + DAY,
    limited: false,
    stale: false,
  };
  const usage = {
    codex: { windows: [codexWindow], plan: 'pro' },
    claude: {
      windows: [{ label: '5時間', usedPercent: 10, limited: false, stale: false }],
      capturedAt: NOW - 100,
    },
  };

  it('取得のたびに取得元ごとに追記する（同じ値の短い間隔の重複だけ畳む）', async () => {
    const r = recorder();
    expect(r.observeUsage(usage)).toHaveLength(2);
    now += 1000;
    expect(r.observeUsage(usage)).toHaveLength(0);
    now += 1000;
    expect(
      r.observeUsage({ codex: { ...usage.codex, windows: [{ ...codexWindow, usedPercent: 41 }] } }),
    ).toHaveLength(1);
    now += USAGE_DUPLICATE_WINDOW_MS;
    expect(r.observeUsage(usage)).toHaveLength(2);
    await store.flush();
    const records = await readWorkHistory(dir, { kind: 'usage' });
    expect(records).toHaveLength(5);
    expect(records[0]).toEqual({
      v: 1,
      kind: 'usage',
      at: NOW,
      windowId: 'w1',
      provider: 'codex',
      plan: 'pro',
      windows: [{ label: '週次', usedPercent: 40, resetsAt: NOW + DAY, limited: false }],
    });
  });
});

describe('保持期間', () => {
  it('保持期間を過ぎた日のファイルを消し、残りの日は読める', async () => {
    await store.append([
      startRecord(NOW - 10 * DAY, 'old'),
      startRecord(NOW - 2 * DAY, 'mid'),
      startRecord(NOW, 'new'),
    ]);
    expect(await readdir(join(dir, WORK_HISTORY_DIR_NAME))).toHaveLength(3);
    expect(await recorder(5).pruneIfDue(true)).toBe(1);
    expect((await sessionRecords()).map((rec) => rec.threadId)).toEqual(['mid', 'new']);
    expect(await readdir(join(dir, WORK_HISTORY_DIR_NAME))).toHaveLength(2);
  });

  it('複数のウィンドウが同時に消しても失敗にしない', async () => {
    await store.append([startRecord(NOW - 10 * DAY, 'old'), startRecord(NOW - 9 * DAY, 'old2')]);
    const other = new WorkHistoryStore(dir, (message) => errors.push(message));
    const results = await Promise.all([store.prune(NOW, 5), other.prune(NOW, 5)]);
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(2);
    expect(errors).toEqual([]);
    expect(await readdir(join(dir, WORK_HISTORY_DIR_NAME))).toEqual([]);
  });

  it('間隔の内側では削除を試さない', async () => {
    const r = recorder();
    await r.pruneIfDue(true);
    expect(r.pruneIfDue()).toBeUndefined();
  });

  it('設定の範囲外・数値でない値は既定の90日にする', () => {
    expect(normalizeRetentionDays(undefined)).toBe(90);
    expect(normalizeRetentionDays(0)).toBe(90);
    expect(normalizeRetentionDays(5000)).toBe(90);
    expect(normalizeRetentionDays('7')).toBe(90);
    expect(normalizeRetentionDays(7.9)).toBe(7);
  });
});

describe('readWorkHistory', () => {
  it('保存領域が無ければ空', async () => {
    expect(await readWorkHistory(join(dir, 'missing'))).toEqual([]);
  });

  it('壊れた行・知らない版・形の合わない行を捨て、期間で絞る', async () => {
    const historyDir = join(dir, WORK_HISTORY_DIR_NAME);
    await mkdir(historyDir, { recursive: true });
    const good = startRecord(NOW, 'x');
    await writeFile(
      join(historyDir, dayFileName(NOW)),
      [
        '{broken',
        JSON.stringify({ ...good, v: 2 }),
        JSON.stringify({ ...good, provider: 'other' }),
        JSON.stringify({ ...good, event: 'unknown' }),
        JSON.stringify(good),
        JSON.stringify({ ...good, at: NOW + 1000, threadId: 'later' }),
        '',
      ].join('\n'),
    );
    expect((await sessionRecords()).map((rec) => rec.threadId)).toEqual(['x', 'later']);
    expect(await readWorkHistory(dir, { since: NOW + 1, until: NOW + 2000 })).toHaveLength(1);
    expect(await readWorkHistory(dir, { kind: 'usage' })).toEqual([]);
  });
});

describe('extractIssueNumber', () => {
  it('ブランチ名を先に、無ければタイトルの#番号を使う', () => {
    expect(extractIssueNumber('feature/2175/t5-x', 'Issue #9')).toBe(2175);
    expect(extractIssueNumber('main', 'Issue #9 の作業')).toBe(9);
    expect(extractIssueNumber(undefined, '番号なし')).toBeUndefined();
  });
});
