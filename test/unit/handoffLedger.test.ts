import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findSnippet,
  HandoffLedger,
  isHandoffBodyFileName,
  LEDGER_HIT_MAX,
  matchesLedgerFilter,
  parseHandoffText,
} from '../../src/view/handoffLedger';

function handoffText(opts: {
  sessionId: string;
  cli?: string;
  trigger?: string;
  createdAt?: string;
  utterance?: string;
  body?: string;
}): string {
  return [
    '# セッション引き継ぎ',
    '',
    '## 引き継ぎ元',
    '',
    `- CLI: ${opts.cli ?? 'Claude Code'}`,
    `- セッションID: ${opts.sessionId}`,
    `- transcript（jsonl）: /home/u/.claude/projects/x/${opts.sessionId}.jsonl`,
    '- 作業ディレクトリ: /home/u/repo',
    '- gitブランチ: main',
    '- モデル: opus',
    `- 引き継いだ契機: ${opts.trigger ?? '手動操作'}`,
    `- 生成時刻: ${opts.createdAt ?? '2026-11-26T11:34:41.374Z'}`,
    '',
    '## 次にやること（引き継ぎ元のアシスタントの申し送り）',
    '',
    opts.body ?? '本文',
    '',
    '### ユーザー発話（末尾10件まで）',
    '',
    `- ${opts.utterance ?? '最初の依頼'}`,
    '- 二つ目の依頼',
    '',
    '## 抽出コマンド',
  ].join('\n');
}

describe('isHandoffBodyFileName', () => {
  it('本文だけを通し、開始プロンプト・ログ・危ない名前を外す', () => {
    expect(isHandoffBodyFileName('abc-2026-11-26T01-02-03-456.md')).toBe(true);
    expect(isHandoffBodyFileName('abc-2026-11-26T01-02-03-456-prompt.md')).toBe(false);
    expect(isHandoffBodyFileName('handoff-log.jsonl')).toBe(false);
    expect(isHandoffBodyFileName('../x.md')).toBe(false);
    expect(isHandoffBodyFileName('a/b.md')).toBe(false);
  });
});

describe('parseHandoffText', () => {
  it('引き継ぎ元の箇条と最初のユーザー発話を読む', () => {
    const entry = parseHandoffText(
      's1-2026-11-26T11-34-41-374.md',
      handoffText({ sessionId: 's1', utterance: '台帳を作って' }),
    );
    expect(entry).toMatchObject({
      provider: 'claude',
      sessionId: 's1',
      cwd: '/home/u/repo',
      branch: 'main',
      model: 'opus',
      transcriptPath: '/home/u/.claude/projects/x/s1.jsonl',
      trigger: 'manual',
      triggerLabel: '手動操作',
      createdAt: Date.parse('2026-11-26T11:34:41.374Z'),
      request: '台帳を作って',
    });
  });

  it('手動操作以外の契機は自動、Codexも見分ける', () => {
    const entry = parseHandoffText(
      'c1-2026-11-26T11-34-41-374.md',
      handoffText({ sessionId: 'c1', cli: 'Codex', trigger: 'コンテキスト残量が閾値を下回った' }),
    );
    expect(entry.provider).toBe('codex');
    expect(entry.trigger).toBe('auto');
  });

  it('箇条が無ければファイル名からセッションidと時刻を取る', () => {
    const entry = parseHandoffText('s2-2026-11-26T01-02-03-456.md', 'でたらめ');
    expect(entry.sessionId).toBe('s2');
    expect(entry.createdAt).toBe(Date.UTC(2026, 10, 26, 1, 2, 3, 456));
    expect(entry.trigger).toBe('unknown');
    expect(entry.provider).toBeUndefined();
  });

  it('依頼文の制御文字を1行に均す', () => {
    const entry = parseHandoffText(
      's3-2026-11-26T01-02-03-456.md',
      handoffText({ sessionId: 's3', utterance: 'a\u0007b' }),
    );
    expect(entry.request).not.toContain('\u0007');
  });
});

describe('findSnippet / matchesLedgerFilter', () => {
  it('大文字小文字を区別せず一致の前後を返す', () => {
    expect(findSnippet('xx Hello World yy', 'world')).toContain('World');
    expect(findSnippet('abc', 'zzz')).toBeUndefined();
  });

  it('契機・セッション・日付で絞る', () => {
    const entry = parseHandoffText(
      's1-2026-11-26T11-34-41-374.md',
      handoffText({ sessionId: 's1' }),
    );
    const base = { query: '', session: '', trigger: 'all' as const };
    expect(matchesLedgerFilter(entry, base)).toBe(true);
    expect(matchesLedgerFilter(entry, { ...base, trigger: 'auto' })).toBe(false);
    expect(matchesLedgerFilter(entry, { ...base, session: 'REPO' })).toBe(true);
    expect(matchesLedgerFilter(entry, { ...base, session: 'zzz' })).toBe(false);
    expect(matchesLedgerFilter(entry, { ...base, fromMs: entry.createdAt + 1 })).toBe(false);
    expect(matchesLedgerFilter(entry, { ...base, toMs: entry.createdAt })).toBe(false);
  });
});

describe('HandoffLedger', () => {
  let dir: string;
  let handoffDir: string;
  let indexPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    handoffDir = join(dir, 'handoff');
    indexPath = join(dir, 'mc', 'index.json');
    await rm(handoffDir, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.mkdir(handoffDir, { recursive: true }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (name: string, text: string): Promise<void> => {
    await writeFile(join(handoffDir, name), text, 'utf8');
  };

  it('本文で探し、条件だけなら新しい順に一覧する', async () => {
    await put(
      'a-2026-11-25T00-00-00-000.md',
      handoffText({ sessionId: 'a', createdAt: '2026-11-25T00:00:00.000Z', body: '索引の話' }),
    );
    await put(
      'b-2026-11-26T00-00-00-000.md',
      handoffText({ sessionId: 'b', createdAt: '2026-11-26T00:00:00.000Z', body: '別の話' }),
    );
    await put('b-2026-11-26T00-00-00-000-prompt.md', '索引');
    const ledger = new HandoffLedger(handoffDir, indexPath);

    const all = await ledger.search({ query: '', session: '', trigger: 'all' });
    expect(all.hits.map((h) => h.entry.sessionId)).toEqual(['b', 'a']);
    expect(all.total).toBe(2);

    const found = await ledger.search({ query: '索引', session: '', trigger: 'all' });
    expect(found.hits.map((h) => h.entry.sessionId)).toEqual(['a']);
    expect(found.hits[0]?.snippet).toContain('索引');
  });

  it('索引を書き残し、消えたファイルは外す', async () => {
    await put('a-2026-11-25T00-00-00-000.md', handoffText({ sessionId: 'a' }));
    const first = new HandoffLedger(handoffDir, indexPath);
    await first.refresh();
    const saved = JSON.parse(await readFile(indexPath, 'utf8')) as { entries: unknown[] };
    expect(saved.entries).toHaveLength(1);

    await unlink(join(handoffDir, 'a-2026-11-25T00-00-00-000.md'));
    const second = new HandoffLedger(handoffDir, indexPath);
    await second.refresh();
    expect(second.list()).toEqual([]);
  });

  it('台帳に無い名前のパスは組まない', async () => {
    await put('a-2026-11-25T00-00-00-000.md', handoffText({ sessionId: 'a' }));
    const ledger = new HandoffLedger(handoffDir, indexPath);
    await ledger.refresh();
    expect(ledger.pathOf('a-2026-11-25T00-00-00-000.md')).toBe(
      join(handoffDir, 'a-2026-11-25T00-00-00-000.md'),
    );
    expect(ledger.pathOf('../secret.md')).toBeUndefined();
    expect(ledger.pathOf('zzz.md')).toBeUndefined();
  });

  it('本文の一致が上限に達したら読むのをやめる', async () => {
    for (let i = 0; i < LEDGER_HIT_MAX + 5; i += 1) {
      const id = `s${String(i).padStart(4, '0')}`;
      await put(`${id}-2026-11-25T00-00-00-000.md`, handoffText({ sessionId: id, body: '共通' }));
    }
    const ledger = new HandoffLedger(handoffDir, indexPath);
    const result = await ledger.search({ query: '共通', session: '', trigger: 'all' });
    expect(result.hits).toHaveLength(LEDGER_HIT_MAX);
    expect(result.truncated).toBe(true);
  });

  it('壊れた索引からは作り直し、警告だけ残す', async () => {
    await put('a-2026-11-25T00-00-00-000.md', handoffText({ sessionId: 'a', body: '本文' }));
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, '{"version":1,"entries":[{"name":', 'utf8');
    const warnings: string[] = [];
    const ledger = new HandoffLedger(handoffDir, indexPath, { warn: (m) => warnings.push(m) });
    const result = await ledger.search({ query: '本文', session: '', trigger: 'all' });
    expect(result.hits.map((h) => h.entry.sessionId)).toEqual(['a']);
    expect(warnings.join('\n')).toContain('作り直します');
    const saved = JSON.parse(await readFile(indexPath, 'utf8')) as { entries: unknown[] };
    expect(saved.entries).toHaveLength(1);
  });

  it('索引に細工した名前が載っていてもパスを組まない', async () => {
    await put('a-2026-11-25T00-00-00-000.md', handoffText({ sessionId: 'a' }));
    await new HandoffLedger(handoffDir, indexPath).refresh();
    const saved = JSON.parse(await readFile(indexPath, 'utf8')) as {
      version: number;
      entries: { name: string }[];
    };
    const [entry] = saved.entries;
    saved.entries.push({ ...entry, name: '../../outside.md' }, { ...entry, name: '/etc/x.md' });
    await writeFile(indexPath, JSON.stringify(saved), 'utf8');
    const ledger = new HandoffLedger(handoffDir, indexPath);
    await ledger.refresh();
    expect(ledger.pathOf('../../outside.md')).toBeUndefined();
    expect(ledger.pathOf('/etc/x.md')).toBeUndefined();
    expect(ledger.list().map((e) => e.name)).toEqual(['a-2026-11-25T00-00-00-000.md']);
  });

  it('handoffのディレクトリが無ければ空', async () => {
    const ledger = new HandoffLedger(join(dir, 'none'), indexPath);
    const result = await ledger.search({ query: 'x', session: '', trigger: 'all' });
    expect(result.hits).toEqual([]);
  });
});
