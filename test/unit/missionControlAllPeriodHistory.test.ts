import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { previewRequest } from '../../src/codex/threadList';
import type { SessionSummary } from '../../src/codex/types';
import { parseHandoffText, type HandoffLedgerEntry } from '../../src/view/handoffLedger';
import {
  buildAllPeriodHistory,
  parseHandoffQuery,
  toHandoffListing,
  transcriptPathsToCheck,
} from '../../src/view/missionControlSessions';
import { missingFiles, SessionCatalog } from '../../src/view/sessionCatalog';
import { KEY_HELP, mapKey } from '../../src/webview/missionControl/keys';
import { EMPTY_HISTORY_FILTER, filterHistory } from '../../src/webview/missionControl/logic';
import { toHandoffQuery } from '../../src/webview/missionControl/ledgerLogic';

const resolveRepo = (cwd: string | undefined) => ({
  key: cwd ?? '',
  label: cwd === undefined ? '不明' : (cwd.split('/').pop() ?? cwd),
  full: cwd ?? '',
});

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    provider: 'claude',
    threadName: `見出し${id}`,
    updatedAt: '2026-11-20T00:00:00.000Z',
    cwd: '/home/u/repo',
    archived: false,
    ...patch,
  };
}

function handoff(sessionId: string, request: string, at: string): HandoffLedgerEntry {
  return parseHandoffText(
    `${sessionId}-2026-11-01T00-00-00-000.md`,
    [
      '## 引き継ぎ元',
      '- CLI: Claude Code',
      `- セッションID: ${sessionId}`,
      `- transcript（jsonl）: /gone/${sessionId}.jsonl`,
      '- 作業ディレクトリ: /home/u/old',
      '- 引き継いだ契機: 手動操作',
      `- 生成時刻: ${at}`,
      '### ユーザー発話（末尾10件まで）',
      `- ${request}`,
    ].join('\n'),
  );
}

describe('SessionCatalog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'catalog-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('一覧から消えたセッションも残し、見出しと依頼文を引き継ぐ', async () => {
    const path = join(dir, 'catalog.json');
    const first = new SessionCatalog(path);
    await first.merge([summary('a', { firstPrompt: '最初の依頼' })]);
    const second = new SessionCatalog(path);
    const entries = await second.merge([summary('b')]);
    expect(entries.map((e) => e.threadId).sort()).toEqual(['a', 'b']);
    expect(entries.find((e) => e.threadId === 'a')).toMatchObject({
      title: '見出しa',
      firstPrompt: '最初の依頼',
    });
  });

  it('壊れた目録・形の違う行は捨てて作り直す', async () => {
    const path = join(dir, 'catalog.json');
    const warnings: string[] = [];
    const log = { warn: (m: string) => warnings.push(m) };
    await writeFile(path, '{"version":1,"entries":[', 'utf8');
    const entries = await new SessionCatalog(path, log).merge([summary('a')]);
    expect(entries.map((e) => e.threadId)).toEqual(['a']);
    expect(warnings.join('\n')).toContain('作り直します');
    const saved = JSON.parse(await readFile(path, 'utf8')) as { entries: unknown[] };
    expect(saved.entries).toHaveLength(1);

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [{ provider: 'evil', threadId: 'x', updatedAt: 0 }, { threadId: 'y' }, null],
      }),
      'utf8',
    );
    const again = await new SessionCatalog(path, log).merge([summary('b')]);
    expect(again.map((e) => e.threadId)).toEqual(['b']);
  });
});

describe('buildAllPeriodHistory', () => {
  it('一覧・目録・handoffを重ね、会話記録が消えたものに印を付ける', () => {
    const listed = [summary('live', { firstPrompt: 'いまの依頼' })];
    const catalog = [
      {
        provider: 'codex' as const,
        threadId: 'old',
        title: '昔の見出し',
        firstPrompt: '昔の依頼',
        cwd: '/home/u/repo',
        updatedAt: Date.parse('2026-10-01T00:00:00Z'),
        transcriptPath: '/gone/old.jsonl',
      },
    ];
    const handoffs = [
      handoff('ho', '後の発話', '2026-10-05T00:00:00Z'),
      handoff('ho', '最初の発話', '2026-10-02T00:00:00Z'),
    ];
    const missing = new Set(['/gone/old.jsonl', '/gone/ho.jsonl']);
    const { items, offList } = buildAllPeriodHistory({
      listed,
      catalog,
      handoffs,
      missing,
      resolveRepo,
    });
    expect(items.map((i) => i.threadId)).toEqual(['live', 'ho', 'old']);
    expect(items[0]).toMatchObject({ firstPrompt: 'いまの依頼', transcriptMissing: false });
    expect(items[1]).toMatchObject({
      title: '最初の発話',
      handoffCount: 2,
      handoffRequest: '最初の発話',
      transcriptMissing: true,
    });
    expect(items[2]).toMatchObject({ title: '昔の見出し', transcriptMissing: true });
    expect(offList.map((o) => o.threadId).sort()).toEqual(['ho', 'old']);

    // 見出し・依頼文で全期間を引ける
    const byPrompt = filterHistory(items, { ...EMPTY_HISTORY_FILTER, query: '昔の依頼' });
    expect(byPrompt.map((i) => i.threadId)).toEqual(['old']);
    const byHandoff = filterHistory(items, { ...EMPTY_HISTORY_FILTER, query: '最初の発話' });
    expect(byHandoff.map((i) => i.threadId)).toEqual(['ho']);
  });

  it('一覧に無いセッションの会話記録の在処だけを確かめる', async () => {
    const paths = transcriptPathsToCheck(
      [summary('ho')],
      [],
      [handoff('ho', 'x', '2026-10-02T00:00:00Z'), handoff('other', 'y', '2026-10-02T00:00:00Z')],
    );
    expect(paths).toEqual(['/gone/other.jsonl']);
    const missing = await missingFiles(['/definitely/not/here.jsonl', __filename]);
    expect([...missing]).toEqual(['/definitely/not/here.jsonl']);
  });
});

describe('handoff台帳の条件と結果', () => {
  it('webviewの条件を確かめる', () => {
    expect(parseHandoffQuery({ query: 'a', session: '', trigger: 'all' })).toEqual({
      query: 'a',
      session: '',
      trigger: 'all',
      fromMs: undefined,
      toMs: undefined,
    });
    expect(parseHandoffQuery({ query: 'a', session: '', trigger: 'bad' })).toBeUndefined();
    expect(parseHandoffQuery({ query: 1, session: '', trigger: 'all' })).toBeUndefined();
    expect(
      parseHandoffQuery({ query: '', session: '', trigger: 'all', fromMs: 'x' }),
    ).toBeUndefined();
    expect(parseHandoffQuery({ query: 'x'.repeat(201), session: '', trigger: 'all' })).toBe(
      undefined,
    );
  });

  it('日付をローカル時刻の範囲にする', () => {
    const query = toHandoffQuery({
      query: ' a ',
      session: '',
      trigger: 'manual',
      from: '2026-11-01',
      to: '2026-11-01',
    });
    expect(query.query).toBe('a');
    expect(query.fromMs).toBe(new Date(2026, 10, 1).getTime());
    expect(query.toMs).toBe(new Date(2026, 10, 2).getTime());
  });

  it('検索結果を画面の形にする', () => {
    const entry = handoff('ho', '依頼', '2026-10-02T00:00:00Z');
    const listing = toHandoffListing(
      { hits: [{ entry, snippet: '…一致…' }], total: 3, truncated: false },
      resolveRepo,
    );
    expect(listing.total).toBe(3);
    expect(listing.items[0]).toMatchObject({
      name: entry.name,
      sessionId: 'ho',
      repoLabel: 'old',
      trigger: 'manual',
      snippet: '…一致…',
    });
  });
});

describe('previewRequest', () => {
  it('IDEの前置きを除いて依頼文だけを取る', () => {
    expect(previewRequest('# Context from my IDE setup:\n\n## My request for Codex:\n直して')).toBe(
      '直して',
    );
    expect(previewRequest('# Context from my IDE setup:\n\n')).toBeUndefined();
    expect(previewRequest('  ')).toBeUndefined();
    expect(previewRequest('ふつうの依頼')).toBe('ふつうの依頼');
  });
});

describe('handoff台帳のキー', () => {
  it('lで台帳を開き、ヘルプに載る', () => {
    expect(
      mapKey({
        key: 'l',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        inEditable: false,
      }),
    ).toEqual({ kind: 'ledger' });
    expect(KEY_HELP.some(([, label]) => label.includes('handoff台帳'))).toBe(true);
  });
});
