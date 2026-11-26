import { appendFileSync, mkdirSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import { redactCredentials } from '../secondOpinion/redact';

/**
 * 作業履歴（Mission Control 段階19。Issue #2175）。セッションのイベントと利用枠の値を、
 * 保存領域（`globalStorageUri`）の`work-history/YYYY-MM-DD.jsonl`へ1行ずつ追記する。
 *
 * - 日付はローカル時刻の記録日。保持期間は日単位のファイルを消して守るので、書き手が複数の
 *   ウィンドウでもファイルの書き換え（追記以外）が起きない
 * - 外部由来の文字列（タイトル・要約・ブランチ・skill名・model・窓の名前など）は、保存前に
 *   `redactCredentials`で既知の秘密の形を伏せ、`sanitizeInlineText`で1行にして長さを切る。
 *   読み手（推移グラフ・集計・カレンダー）は、表示の前にもう一度`sanitizeInlineText`か
 *   `formatUntrusted`を通す（ファイルは手で書き換えられうるため）
 * - 読み出しは`readWorkHistory`。壊れた行・形の合わない行は捨てる
 *
 * vscodeに依らない部分。記録の契機は`workHistoryRecorder.ts`が持つ。
 */

export const WORK_HISTORY_DIR_NAME = 'work-history';
/** 記録の形の版。形を変えたら上げ、読み手は知らない版の行を捨てる。 */
export const WORK_HISTORY_VERSION = 1;

export const DEFAULT_WORK_HISTORY_RETENTION_DAYS = 90;
export const MIN_WORK_HISTORY_RETENTION_DAYS = 1;
export const MAX_WORK_HISTORY_RETENTION_DAYS = 3650;

/** 保存する文字列の長さの上限（文字数）。 */
const TITLE_MAX = 200;
const PURPOSE_MAX = 300;
const BRANCH_MAX = 200;
const SKILL_NAME_MAX = 80;
const MODEL_MAX = 80;
const CWD_MAX = 500;
const ID_MAX = 200;
const LABEL_MAX = 40;
const PLAN_MAX = 40;
/** 1つの利用枠の記録に載せる窓の数の上限。 */
const MAX_USAGE_WINDOWS = 20;
/** 1行の上限（バイト数相当の文字数）。超える行は読まない。 */
const MAX_LINE_LENGTH = 64 * 1024;

const DAY_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/**
 * セッションのイベントの種類。
 * - `start`: 一覧に初めて現れた（Reload後に復元した会話も、そのウィンドウでの開始として出る）
 * - `update`: タイトル・目的の要約・ブランチ・Issue番号のどれかが変わった
 * - `skill`: skillを起動した（`skill`に名前）
 * - `turn`: ターンが終わった（実行中から待機へ）。その時点の費用・トークンを載せる
 * - `handoff`: 引き継いだ（`childThreadId`に引き継ぎ先）。作り直しで同じ親の行が複数あれば後の行が正
 * - `end`: 一覧から消えた（`reason`が`closed`）か、ウィンドウを閉じた・Reloadした（`shutdown`）
 */
export type WorkHistorySessionEvent = 'start' | 'update' | 'skill' | 'turn' | 'handoff' | 'end';

const SESSION_EVENTS: readonly WorkHistorySessionEvent[] = [
  'start',
  'update',
  'skill',
  'turn',
  'handoff',
  'end',
];

export type WorkHistoryProvider = 'codex' | 'claude';

/** jsonlの1行（セッションのイベント）。 */
export interface WorkHistorySessionRecord {
  v: 1;
  kind: 'session';
  /** 記録した時刻（ms）。 */
  at: number;
  event: WorkHistorySessionEvent;
  /** 記録したウィンドウ。同じ会話を複数のウィンドウが記録することは無い（自ウィンドウ分だけ書く）。 */
  windowId: string;
  provider: WorkHistoryProvider;
  threadId: string;
  title?: string | undefined;
  /** 目的の1文要約（Issue #2172）。 */
  purpose?: string | undefined;
  branch?: string | undefined;
  /** ブランチ名（`<type>/<IID>/<slug>`）かタイトルの`#123`から取ったIssue番号。 */
  issue?: number | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  /** セッションの推定費用（USD。Claude Codeだけ）。 */
  costUsd?: number | undefined;
  /** セッション累計のトークン数（Codexだけ）。 */
  tokens?: number | undefined;
  /** `skill`のときの名前。 */
  skill?: string | undefined;
  /** `handoff`のときの引き継ぎ先。 */
  childThreadId?: string | undefined;
  /** `end`のときの理由。 */
  reason?: 'closed' | 'shutdown' | undefined;
}

/** 利用枠の窓1つ。 */
export interface WorkHistoryUsageWindow {
  label: string;
  usedPercent?: number | undefined;
  /** リセット時刻（ms）。 */
  resetsAt?: number | undefined;
  /** 窓の長さ（ms。Issue #2174の`McUsageWindow.windowMs`）。長さが決まらない窓では無い。 */
  windowMs?: number | undefined;
  /**
   * 使用率を計測した時刻（ms。Issue #2174の`McUsageWindow.sampledAt`）。推移は`at`ではなく
   * この時刻で並べる（同じ計測値が後の通知で何度も書かれるため）。分からなければ無い。
   */
  sampledAt?: number | undefined;
  limited: boolean;
}

/** jsonlの1行（利用枠の値）。取得のたびに1行。 */
export interface WorkHistoryUsageRecord {
  v: 1;
  kind: 'usage';
  at: number;
  windowId: string;
  provider: WorkHistoryProvider;
  windows: WorkHistoryUsageWindow[];
  /** 取得元が値を受け取った時刻（ms）。 */
  capturedAt?: number | undefined;
  plan?: string | undefined;
}

export type WorkHistoryRecord = WorkHistorySessionRecord | WorkHistoryUsageRecord;

/** 範囲外・数値でない値は既定へ丸める。小数は切り捨てる。 */
export function normalizeRetentionDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_WORK_HISTORY_RETENTION_DAYS;
  }
  const days = Math.floor(raw);
  return days >= MIN_WORK_HISTORY_RETENTION_DAYS && days <= MAX_WORK_HISTORY_RETENTION_DAYS
    ? days
    : DEFAULT_WORK_HISTORY_RETENTION_DAYS;
}

/** 外部由来の文字列を保存できる形にする。空になったら`undefined`。 */
export function cleanText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cleaned = sanitizeInlineText(redactCredentials(value).text, maxLength).trim();
  return cleaned === '' ? undefined : cleaned;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 記録の文字列・数値を保存できる形にそろえる。書く前と読んだ後の両方で通す。 */
export function normalizeRecord(input: unknown): WorkHistoryRecord | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  if (raw.v !== WORK_HISTORY_VERSION) {
    return undefined;
  }
  const at = finiteOrUndefined(raw.at);
  const windowId = typeof raw.windowId === 'string' ? cleanText(raw.windowId, ID_MAX) : undefined;
  const provider = raw.provider === 'codex' || raw.provider === 'claude' ? raw.provider : undefined;
  if (at === undefined || windowId === undefined || provider === undefined) {
    return undefined;
  }
  if (raw.kind === 'session') {
    return normalizeSessionRecord(raw, at, windowId, provider);
  }
  if (raw.kind === 'usage') {
    return normalizeUsageRecord(raw, at, windowId, provider);
  }
  return undefined;
}

function str(raw: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = raw[key];
  return typeof value === 'string' ? cleanText(value, maxLength) : undefined;
}

function normalizeSessionRecord(
  raw: Record<string, unknown>,
  at: number,
  windowId: string,
  provider: WorkHistoryProvider,
): WorkHistorySessionRecord | undefined {
  const event = SESSION_EVENTS.find((e) => e === raw.event);
  const threadId = str(raw, 'threadId', ID_MAX);
  if (event === undefined || threadId === undefined) {
    return undefined;
  }
  const record: WorkHistorySessionRecord = {
    v: 1,
    kind: 'session',
    at,
    event,
    windowId,
    provider,
    threadId,
  };
  const title = str(raw, 'title', TITLE_MAX);
  if (title !== undefined) record.title = title;
  const purpose = str(raw, 'purpose', PURPOSE_MAX);
  if (purpose !== undefined) record.purpose = purpose;
  const branch = str(raw, 'branch', BRANCH_MAX);
  if (branch !== undefined) record.branch = branch;
  const issue = finiteOrUndefined(raw.issue);
  if (issue !== undefined && Number.isInteger(issue) && issue > 0) record.issue = issue;
  const cwd = str(raw, 'cwd', CWD_MAX);
  if (cwd !== undefined) record.cwd = cwd;
  const model = str(raw, 'model', MODEL_MAX);
  if (model !== undefined) record.model = model;
  const costUsd = finiteOrUndefined(raw.costUsd);
  if (costUsd !== undefined && costUsd >= 0) record.costUsd = costUsd;
  const tokens = finiteOrUndefined(raw.tokens);
  if (tokens !== undefined && tokens >= 0) record.tokens = tokens;
  const skill = str(raw, 'skill', SKILL_NAME_MAX);
  if (skill !== undefined) record.skill = skill;
  const childThreadId = str(raw, 'childThreadId', ID_MAX);
  if (childThreadId !== undefined) record.childThreadId = childThreadId;
  if (raw.reason === 'closed' || raw.reason === 'shutdown') record.reason = raw.reason;
  return record;
}

function normalizeUsageRecord(
  raw: Record<string, unknown>,
  at: number,
  windowId: string,
  provider: WorkHistoryProvider,
): WorkHistoryUsageRecord | undefined {
  if (!Array.isArray(raw.windows)) {
    return undefined;
  }
  const windows: WorkHistoryUsageWindow[] = [];
  for (const item of raw.windows.slice(0, MAX_USAGE_WINDOWS)) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const w = item as Record<string, unknown>;
    const label = str(w, 'label', LABEL_MAX);
    if (label === undefined) {
      continue;
    }
    const window: WorkHistoryUsageWindow = { label, limited: w.limited === true };
    const usedPercent = finiteOrUndefined(w.usedPercent);
    if (usedPercent !== undefined) window.usedPercent = usedPercent;
    const resetsAt = finiteOrUndefined(w.resetsAt);
    if (resetsAt !== undefined) window.resetsAt = resetsAt;
    const windowMs = finiteOrUndefined(w.windowMs);
    if (windowMs !== undefined && windowMs > 0) window.windowMs = windowMs;
    const sampledAt = finiteOrUndefined(w.sampledAt);
    if (sampledAt !== undefined) window.sampledAt = sampledAt;
    windows.push(window);
  }
  if (windows.length === 0) {
    return undefined;
  }
  const record: WorkHistoryUsageRecord = { v: 1, kind: 'usage', at, windowId, provider, windows };
  const capturedAt = finiteOrUndefined(raw.capturedAt);
  if (capturedAt !== undefined) record.capturedAt = capturedAt;
  const plan = str(raw, 'plan', PLAN_MAX);
  if (plan !== undefined) record.plan = plan;
  return record;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 記録時刻（ms）からその日のファイル名を作る（ローカル時刻の日付）。 */
export function dayFileName(at: number): string {
  const d = new Date(at);
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.jsonl`;
}

/**
 * ファイル名の日付の0時（ローカル時刻、ms）。日付のファイルでなければ`undefined`。
 * `dayFileName`が作る名前に戻らないもの（`2026-00-00`・`0050-01-01`など。`Date`は月日を
 * 繰り上げ、0〜99年を1900年代として読む）も日付のファイルとみなさず、消さない・読まない。
 */
function dayStartOf(fileName: string): number | undefined {
  const m = DAY_FILE_PATTERN.exec(fileName);
  if (m === null) {
    return undefined;
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const start = d.getTime();
  return Number.isNaN(start) || dayFileName(start) !== fileName ? undefined : start;
}

/** 保持の境目（ms）。これより前の記録は消す・読まない。 */
export function retentionCutoff(now: number, retentionDays: number): number {
  return now - normalizeRetentionDays(retentionDays) * 24 * 60 * 60 * 1000;
}

export function workHistoryDir(globalStorageDir: string): string {
  return join(globalStorageDir, WORK_HISTORY_DIR_NAME);
}

/**
 * 作業履歴の書き手。追記は1本の列に並べて順序を保つ。失敗は`onError`へ渡し、呼び出し側の
 * 処理を止めない。
 */
export class WorkHistoryStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly globalStorageDir: string,
    private readonly onError: (message: string) => void,
  ) {}

  get dir(): string {
    return workHistoryDir(this.globalStorageDir);
  }

  /** 記録を追記する。形の合わない記録は書かない。 */
  append(records: readonly WorkHistoryRecord[]): Promise<void> {
    const lines = this.toLines(records);
    if (lines.size === 0) {
      return this.queue;
    }
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        for (const [fileName, text] of lines) {
          await appendFile(join(this.dir, fileName), text, 'utf8');
        }
      } catch (e: unknown) {
        this.onError(
          `作業履歴を追記できませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
    return this.queue;
  }

  /**
   * 終了時の追記。拡張の停止中は非同期の書き込みが終わる保証が無いため同期で書く。
   * 先に積んだ非同期の追記より前に並ぶことがある（読み手は`at`で並べる）。
   */
  appendSync(records: readonly WorkHistoryRecord[]): void {
    const lines = this.toLines(records);
    if (lines.size === 0) {
      return;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const [fileName, text] of lines) {
        appendFileSync(join(this.dir, fileName), text, 'utf8');
      }
    } catch (e: unknown) {
      this.onError(`作業履歴を追記できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 保持期間を過ぎた日のファイルを消す。消した件数を返す。 */
  prune(now: number, retentionDays: number): Promise<number> {
    const result = this.queue.then(() =>
      pruneWorkHistory(this.globalStorageDir, now, retentionDays).catch((e: unknown) => {
        this.onError(
          `古い作業履歴を消せませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 0;
      }),
    );
    this.queue = result.then(() => undefined);
    return result;
  }

  /** 積んだ追記が終わるまで待つ（テスト・終了処理用）。 */
  flush(): Promise<void> {
    return this.queue;
  }

  /** 記録を行へ直す。失敗しても呼び出し側（セッションの状態の通知など）へ例外を投げない。 */
  private toLines(records: readonly WorkHistoryRecord[]): Map<string, string> {
    try {
      return toLinesByDay(records);
    } catch (e: unknown) {
      this.onError(`作業履歴を追記できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      return new Map();
    }
  }
}

function toLinesByDay(records: readonly WorkHistoryRecord[]): Map<string, string> {
  const lines = new Map<string, string>();
  for (const record of records) {
    const normalized = normalizeRecord(record);
    if (normalized === undefined) {
      continue;
    }
    const fileName = dayFileName(normalized.at);
    lines.set(fileName, `${lines.get(fileName) ?? ''}${JSON.stringify(normalized)}\n`);
  }
  return lines;
}

/**
 * 保持期間を過ぎた日のファイルを消す。日の終わり（翌日0時）が境目より前のファイルだけを
 * 消すので、境目をまたぐ日の記録は残る（読み出しで`at`により落とす）。
 */
export async function pruneWorkHistory(
  globalStorageDir: string,
  now: number,
  retentionDays: number,
): Promise<number> {
  const dir = workHistoryDir(globalStorageDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw e;
  }
  const cutoff = retentionCutoff(now, retentionDays);
  let removed = 0;
  let firstError: unknown;
  for (const name of names) {
    const start = dayStartOf(name);
    if (start === undefined) {
      continue;
    }
    const d = new Date(start);
    const nextDayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    if (nextDayStart > cutoff) {
      continue;
    }
    try {
      await unlink(join(dir, name));
      removed++;
    } catch (e: unknown) {
      // 別のウィンドウが同時に消した分は消えたものとして扱う。他の失敗も残りのファイルは続けて消す
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        firstError ??= e;
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
  return removed;
}

export interface ReadWorkHistoryOptions {
  /** これ以降（ms、含む）の記録だけ返す。 */
  since?: number | undefined;
  /** これより前（ms、含まない）の記録だけ返す。 */
  until?: number | undefined;
  kind?: WorkHistoryRecord['kind'] | undefined;
}

/**
 * 作業履歴を読む。時刻の古い順に並べて返す。壊れた行・知らない版の行は捨てる。
 * 文字列は保存時に1行化してあるが、表示の前にもう一度`sanitizeInlineText`か
 * `formatUntrusted`を通すこと。
 */
export async function readWorkHistory(
  globalStorageDir: string,
  options: ReadWorkHistoryOptions = {},
): Promise<WorkHistoryRecord[]> {
  const dir = workHistoryDir(globalStorageDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
  const records: WorkHistoryRecord[] = [];
  for (const name of names.sort()) {
    const start = dayStartOf(name);
    if (start === undefined) {
      continue;
    }
    // ファイルの日付で先に絞る（前後1日はタイムゾーンの変更を見込んで読む）
    if (options.until !== undefined && start > options.until + 24 * 60 * 60 * 1000) {
      continue;
    }
    if (options.since !== undefined && start + 2 * 24 * 60 * 60 * 1000 < options.since) {
      continue;
    }
    let text: string;
    try {
      text = await readFile(join(dir, name), 'utf8');
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw e;
    }
    for (const line of text.split('\n')) {
      if (line === '' || line.length > MAX_LINE_LENGTH) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = normalizeRecord(parsed);
      if (record === undefined) continue;
      if (options.kind !== undefined && record.kind !== options.kind) continue;
      if (options.since !== undefined && record.at < options.since) continue;
      if (options.until !== undefined && record.at >= options.until) continue;
      records.push(record);
    }
  }
  return records.sort((a, b) => a.at - b.at);
}
