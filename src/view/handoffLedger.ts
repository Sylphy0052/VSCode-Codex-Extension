import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { sanitizeInlineText } from '../orchestrator/untrustedText';

/**
 * handoff台帳（Issue #2178）。`<globalStorage>/handoff/<sessionId>-<時刻>.md`の本文を一覧し、
 * 日付・セッション・契機で絞り、本文の部分一致で探す。
 *
 * handoffは数千件・数十MBになる（2026-11-26の実測で約5,800件・69MB）。一覧のたびに全件を
 * 読まないよう、先頭の`## 引き継ぎ元`から取った項目を索引ファイルへ残し、増えたファイルだけを
 * 読み足す。本文の部分一致は、絞り込んだ候補を新しい順に1件ずつ読んで確かめ、一致が
 * `LEDGER_HIT_MAX`件に達したら止める（全件をメモリに抱えない）。
 */

/** 索引ファイルの名前（`<globalStorage>/mission-control/`に置く）。 */
export const HANDOFF_LEDGER_INDEX_FILE = 'handoff-ledger-index.json';
const INDEX_VERSION = 1;
/** 索引を作るときに読む先頭の長さ。`### ユーザー発話`まで届く長さにする。 */
const HEAD_READ_BYTES = 64 * 1024;
const READ_CONCURRENCY = 16;
/** 本文で探さないときに返す件数の上限。 */
export const LEDGER_LIST_MAX = 300;
/** 本文の一致を返す件数の上限。ここで読むのを止める。 */
export const LEDGER_HIT_MAX = 100;
const SNIPPET_RADIUS = 60;
const FIELD_MAX = 200;
const PATH_MAX = 1_000;
/** 依頼文（`### ユーザー発話`の最初の1件）に残す長さ。 */
export const LEDGER_REQUEST_MAX = 300;

export type HandoffTriggerKind = 'manual' | 'auto' | 'unknown';

/** 索引の1件。値はすべてhandoffファイル由来（外部由来）なので、1行に均してから持つ。 */
export interface HandoffLedgerEntry {
  /** ファイル名（ディレクトリを含まない）。 */
  name: string;
  provider: 'claude' | 'codex' | undefined;
  sessionId: string;
  cwd: string;
  branch: string;
  model: string;
  /** 引き継ぎ元のtranscript / rolloutの絶対パス。無ければ空。 */
  transcriptPath: string;
  trigger: HandoffTriggerKind;
  triggerLabel: string;
  /** 生成時刻（ms）。分からなければ0。 */
  createdAt: number;
  /** `### ユーザー発話`の最初の1件。無ければ空。 */
  request: string;
}

/** 台帳の絞り込み。日付はwebviewがローカル時刻で範囲（ms）にして渡す。 */
export interface HandoffLedgerFilter {
  /** 本文の部分一致（大文字小文字を区別しない）。空なら本文を読まない。 */
  query: string;
  /** セッションid・作業ディレクトリ・ブランチの部分一致。 */
  session: string;
  trigger: 'all' | 'manual' | 'auto';
  fromMs?: number | undefined;
  toMs?: number | undefined;
}

export interface HandoffLedgerHit {
  entry: HandoffLedgerEntry;
  /** 本文で一致した前後。本文で探していなければ無い。 */
  snippet?: string | undefined;
}

export interface HandoffLedgerResult {
  hits: HandoffLedgerHit[];
  /** 本文以外の条件に合った件数。 */
  total: number;
  /** 上限で打ち切ったか（本文の一致が`LEDGER_HIT_MAX`件に達した・一覧が`LEDGER_LIST_MAX`件を超えた）。 */
  truncated: boolean;
}

/** handoff本文のファイルか。`-prompt.md`（開始プロンプト）と索引・ログ類は除く。 */
export function isHandoffBodyFileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.md$/u.test(name) && !name.endsWith('-prompt.md');
}

/** ファイル名（`<id>-YYYY-MM-DDTHH-MM-SS-mmm.md`）の時刻とセッションid。 */
function parseFileName(name: string): { sessionId: string; createdAt: number } {
  const match = /^(.*)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})\.md$/u.exec(name);
  if (match === null) {
    return { sessionId: name.replace(/\.md$/u, ''), createdAt: 0 };
  }
  const [, id, y, mo, d, h, mi, s, ms] = match;
  return {
    sessionId: id ?? '',
    createdAt: Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Number(ms),
    ),
  };
}

function bulletValue(line: string, label: string): string | undefined {
  const prefix = `- ${label}: `;
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined;
}

/**
 * handoff本文の先頭から索引の1件を作る。`## 引き継ぎ元`の箇条（`handoff.ts`の
 * `buildPointerHeader`が書く形）と、`### ユーザー発話`の最初の1件を読む。読めない項目は空にする。
 */
export function parseHandoffText(name: string, text: string): HandoffLedgerEntry {
  const fromName = parseFileName(name);
  const fields = new Map<string, string>();
  let request = '';
  let section: 'source' | 'utterances' | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('#')) {
      section =
        line === '## 引き継ぎ元'
          ? 'source'
          : line.startsWith('### ユーザー発話')
            ? 'utterances'
            : undefined;
      continue;
    }
    if (section === 'source') {
      for (const label of [
        'CLI',
        'セッションID',
        '作業ディレクトリ',
        'gitブランチ',
        'モデル',
        '引き継いだ契機',
        '生成時刻',
        'transcript（jsonl）',
        'rollout（jsonl）',
      ]) {
        const value = bulletValue(line, label);
        if (value !== undefined && !fields.has(label)) {
          fields.set(label, value);
        }
      }
    } else if (section === 'utterances' && request === '' && line.startsWith('- ')) {
      request = sanitizeInlineText(line.slice(2).trim(), LEDGER_REQUEST_MAX);
    }
  }
  const cli = fields.get('CLI');
  const triggerLabel = fields.get('引き継いだ契機') ?? '';
  const created = Date.parse(fields.get('生成時刻') ?? '');
  const transcript = fields.get('transcript（jsonl）') ?? fields.get('rollout（jsonl）') ?? '';
  return {
    name,
    provider: cli === 'Claude Code' ? 'claude' : cli === 'Codex' ? 'codex' : undefined,
    sessionId: sanitizeInlineText(fields.get('セッションID') ?? fromName.sessionId, FIELD_MAX),
    cwd: sanitizeInlineText(fields.get('作業ディレクトリ') ?? '', PATH_MAX),
    branch: sanitizeInlineText(fields.get('gitブランチ') ?? '', FIELD_MAX),
    model: sanitizeInlineText(fields.get('モデル') ?? '', FIELD_MAX),
    transcriptPath:
      isAbsolute(transcript) && transcript.length <= PATH_MAX && transcript.endsWith('.jsonl')
        ? sanitizeInlineText(transcript, PATH_MAX)
        : '',
    trigger: triggerLabel === '' ? 'unknown' : triggerLabel === '手動操作' ? 'manual' : 'auto',
    triggerLabel: sanitizeInlineText(triggerLabel, FIELD_MAX),
    createdAt: Number.isFinite(created) ? created : fromName.createdAt,
    request,
  };
}

/** 本文の一致の前後を1行にして返す。一致しなければ`undefined`。 */
export function findSnippet(text: string, query: string): string | undefined {
  const lowered = text.toLowerCase();
  const at = lowered.indexOf(query);
  if (at < 0) {
    return undefined;
  }
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS);
  const body = sanitizeInlineText(text.slice(start, end), SNIPPET_RADIUS * 2 + query.length);
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** 本文以外の条件で絞る。 */
export function matchesLedgerFilter(
  entry: HandoffLedgerEntry,
  filter: HandoffLedgerFilter,
): boolean {
  if (filter.trigger !== 'all' && entry.trigger !== filter.trigger) {
    return false;
  }
  const session = filter.session.trim().toLowerCase();
  if (
    session !== '' &&
    ![entry.sessionId, entry.cwd, entry.branch].some((v) => v.toLowerCase().includes(session))
  ) {
    return false;
  }
  if ((filter.fromMs !== undefined || filter.toMs !== undefined) && entry.createdAt <= 0) {
    return false;
  }
  if (filter.fromMs !== undefined && entry.createdAt < filter.fromMs) {
    return false;
  }
  return filter.toMs === undefined || entry.createdAt < filter.toMs;
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await fs.open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await run(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function isEntry(value: unknown): value is HandoffLedgerEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    isHandoffBodyFileName(v.name) &&
    (v.provider === 'claude' || v.provider === 'codex' || v.provider === undefined) &&
    typeof v.sessionId === 'string' &&
    typeof v.cwd === 'string' &&
    typeof v.branch === 'string' &&
    typeof v.model === 'string' &&
    typeof v.transcriptPath === 'string' &&
    (v.trigger === 'manual' || v.trigger === 'auto' || v.trigger === 'unknown') &&
    typeof v.triggerLabel === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.request === 'string'
  );
}

interface Logger {
  warn(message: string): void;
}

export class HandoffLedger {
  private readonly entries = new Map<string, HandoffLedgerEntry>();
  private loaded = false;
  private refreshing: Promise<void> | undefined;
  /** 本文の検索の世代。新しい検索が来たら古い検索は読むのをやめる。 */
  private generation = 0;

  constructor(
    private readonly handoffDir: string,
    private readonly indexPath: string,
    private readonly log?: Logger,
  ) {}

  /** ディレクトリを見て、増えたファイルを読み足し、消えたファイルを索引から外す。 */
  refresh(): Promise<void> {
    if (this.refreshing === undefined) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  /** 索引の全件（新しい順）。 */
  list(): HandoffLedgerEntry[] {
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 台帳に載っているファイルの絶対パス。載っていない名前には`undefined`（パスを組ませない）。 */
  pathOf(name: string): string | undefined {
    return this.entries.has(name) && isHandoffBodyFileName(name)
      ? join(this.handoffDir, name)
      : undefined;
  }

  async search(filter: HandoffLedgerFilter): Promise<HandoffLedgerResult> {
    await this.refresh();
    this.generation += 1;
    const generation = this.generation;
    const candidates = this.list().filter((entry) => matchesLedgerFilter(entry, filter));
    const query = filter.query.trim().toLowerCase();
    if (query === '') {
      return {
        hits: candidates.slice(0, LEDGER_LIST_MAX).map((entry) => ({ entry })),
        total: candidates.length,
        truncated: candidates.length > LEDGER_LIST_MAX,
      };
    }
    const hits: HandoffLedgerHit[] = [];
    // 新しい順を保ったまま、READ_CONCURRENCY件ずつまとめて読む（1件ずつだと全件で1.6秒。実測）
    for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
      if (generation !== this.generation || hits.length >= LEDGER_HIT_MAX) {
        break;
      }
      const batch = candidates.slice(i, i + READ_CONCURRENCY);
      const texts = await Promise.all(
        batch.map((entry) =>
          // 読んでいる間に消えたファイルは飛ばす。次のrefreshで索引から外れる
          fs.readFile(join(this.handoffDir, entry.name), 'utf8').catch(() => undefined),
        ),
      );
      batch.forEach((entry, k) => {
        const text = texts[k];
        const snippet = text === undefined ? undefined : findSnippet(text, query);
        if (snippet !== undefined && hits.length < LEDGER_HIT_MAX) {
          hits.push({ entry, snippet });
        }
      });
    }
    return { hits, total: candidates.length, truncated: hits.length >= LEDGER_HIT_MAX };
  }

  private async doRefresh(): Promise<void> {
    if (!this.loaded) {
      await this.loadIndex();
      this.loaded = true;
    }
    let names: string[];
    try {
      names = (await fs.readdir(this.handoffDir)).filter(isHandoffBodyFileName);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
      names = [];
    }
    const present = new Set(names);
    let changed = false;
    for (const name of [...this.entries.keys()]) {
      if (!present.has(name)) {
        this.entries.delete(name);
        changed = true;
      }
    }
    const added = names.filter((name) => !this.entries.has(name));
    await forEachLimit(added, READ_CONCURRENCY, async (name) => {
      try {
        const text = await readHead(join(this.handoffDir, name), HEAD_READ_BYTES);
        this.entries.set(name, parseHandoffText(name, text));
        changed = true;
      } catch {
        // 読めないファイル（消えた・権限）は索引に入れず、次のrefreshで読み直す
      }
    });
    if (changed) {
      await this.persist();
    }
  }

  private async loadIndex(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) {
        return;
      }
      for (const entry of parsed.entries) {
        if (isEntry(entry)) {
          this.entries.set(entry.name, entry);
        }
      }
    } catch (e: unknown) {
      this.log?.warn(`handoff台帳: 索引を読めないため作り直します: ${String(e)}`);
    }
  }

  private async persist(): Promise<void> {
    const body = JSON.stringify({ version: INDEX_VERSION, entries: this.list() });
    const tmp = `${this.indexPath}.tmp-${String(process.pid)}-${String(Date.now())}`;
    try {
      await fs.mkdir(join(this.indexPath, '..'), { recursive: true });
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, this.indexPath);
    } catch (e: unknown) {
      // 索引は作り直せるので、書けなくても一覧は返す
      this.log?.warn(`handoff台帳: 索引を書けませんでした: ${String(e)}`);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
