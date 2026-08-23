import { basename, isAbsolute, relative } from 'node:path';

/**
 * 日報/週報システムへ渡す作業記録の1レコード。
 *
 * 形式は `~/.claude/scripts/daily/collect.py` の追記バッファ規約に合わせてある
 * （`ts` / `source` / `cwd` / `text` / `session_id` / `kind` を読む）。フィールド名を変えると
 * 日報側が黙って取りこぼすため、collect.py と対で変更すること。未知フィールドは
 * collect.py 側が無視できるため、フィールドの追加自体は安全。
 */
export type ActivitySource = 'codex' | 'claude-code';

/** `prompt` はユーザー発言、`result` はターン完了時のアシスタントの成果。 */
export type ActivityKind = 'prompt' | 'result';

export interface ActivityRecord {
  /** ISO8601（ローカルオフセット付き）。 */
  ts: string;
  source: ActivitySource;
  cwd: string;
  /** 1行要約。会話本文をこれ以上残さない。 */
  text: string;
  /** 収集元の区別。この拡張機能から出たものは常に 'vscode'。 */
  ref: string;
  /** セッションを一意に識別するid（Codex: thread id、Claude: session id）。 */
  session_id: string;
  kind: ActivityKind;
}

export interface BuildActivityRecordInput {
  now: Date;
  /** `Date.prototype.getTimezoneOffset()` と同じ符号（JSTなら -540）。 */
  timeZoneOffsetMinutes: number;
  source: ActivitySource;
  cwd: string;
  sessionId: string;
  kind: ActivityKind;
  /**
   * `kind: 'prompt'` はユーザー発言そのもの。
   * `kind: 'result'` はアシスタントの最終応答テキスト（1行化・編集ファイル付記は本関数が行う）。
   */
  text: string;
  /** `kind: 'result'` のときだけ使う。そのターンで編集したファイルパス。 */
  editedFiles?: readonly string[];
}

/** collect.py の SUMMARY_MAX_LEN と揃える。 */
export const SUMMARY_MAX_LEN = 200;

/** 編集ファイルの列挙上限。超過分は件数だけ `+N` で示す。 */
export const MAX_EDITED_FILES = 5;

const REF = 'vscode';

/**
 * 記録できないものは undefined を返す（呼び出し側は何も書かない）。
 * cwd と sessionId が無いと日報・収集側の重複排除が成立しないため、本文と同じく必須にする。
 */
export function buildActivityRecord(input: BuildActivityRecordInput): ActivityRecord | undefined {
  const cwd = input.cwd.trim();
  const sessionId = input.sessionId.trim();
  if (cwd === '' || sessionId === '') {
    return undefined;
  }

  const text =
    input.kind === 'result'
      ? buildResultText(input.text, input.editedFiles ?? [], cwd)
      : summarize(input.text);
  if (text === '') {
    return undefined;
  }

  return {
    ts: formatLocalIso(input.now, input.timeZoneOffsetMinutes),
    source: input.source,
    cwd,
    text,
    ref: REF,
    session_id: sessionId,
    kind: input.kind,
  };
}

export function serializeActivityRecord(record: ActivityRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** バッファは暦日ごとに1ファイル。深夜0時以降は翌日分として扱う（日報skillと同じ境界）。 */
export function bufferFileName(now: Date, timeZoneOffsetMinutes: number): string {
  const local = shift(now, timeZoneOffsetMinutes);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}.jsonl`;
}

/** 制御文字と改行を畳んで1行にし、長すぎる本文を切り詰める。 */
function summarize(text: string): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= SUMMARY_MAX_LEN) {
    return collapsed;
  }
  return `${collapsed.slice(0, SUMMARY_MAX_LEN)}…`;
}

/**
 * 成果行（`kind: 'result'`）の本文を組み立てる。
 *
 * 応答要約と編集ファイル一覧を合わせて200字に収める。編集ファイル一覧のほうが
 * 情報価値が高いため、超過分は応答要約側から先に削る。
 */
function buildResultText(
  responseText: string,
  editedFiles: readonly string[],
  cwd: string,
): string {
  const suffix = formatEditedFilesSuffix(editedFiles, cwd);
  const collapsed = collapseWhitespace(responseText);
  if (collapsed === '' && suffix === '') {
    return '';
  }

  const budget = Math.max(0, SUMMARY_MAX_LEN - suffix.length);
  const combined = `${truncateExact(collapsed, budget)}${suffix}`;
  // 編集ファイル一覧だけで上限を超える極端なケースの保険（通常は起きない）
  return combined.length <= SUMMARY_MAX_LEN ? combined : combined.slice(0, SUMMARY_MAX_LEN);
}

/** ` [edit: a.ts, b.ts +N]` の形にする。編集が無ければ空文字。 */
function formatEditedFilesSuffix(editedFiles: readonly string[], cwd: string): string {
  if (editedFiles.length === 0) {
    return '';
  }
  const relativePaths = editedFiles.map((path) => toWorkspaceRelative(path, cwd));
  const shown = relativePaths.slice(0, MAX_EDITED_FILES);
  const overflow = relativePaths.length - shown.length;
  const overflowSuffix = overflow > 0 ? ` +${overflow}` : '';
  return ` [edit: ${shown.join(', ')}${overflowSuffix}]`;
}

/** cwdからの相対パスにする。cwd配下でなければbasenameにする。 */
function toWorkspaceRelative(filePath: string, cwd: string): string {
  const trimmed = filePath.trim();
  if (trimmed === '' || !isAbsolute(trimmed)) {
    return trimmed;
  }
  const rel = relative(cwd, trimmed);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return basename(trimmed);
  }
  return rel;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** `summarize` と違い、末尾の省略記号を含めて必ず `max` 文字以内に収める。 */
function truncateExact(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 0) {
    return '';
  }
  if (max === 1) {
    return '…';
  }
  return `${text.slice(0, max - 1)}…`;
}

function formatLocalIso(now: Date, timeZoneOffsetMinutes: number): string {
  const local = shift(now, timeZoneOffsetMinutes);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${date}T${time}${formatOffset(timeZoneOffsetMinutes)}`;
}

/** getTimezoneOffset は「UTC - ローカル」の分数なので、引くとローカル時刻になる。 */
function shift(now: Date, timeZoneOffsetMinutes: number): Date {
  return new Date(now.getTime() - timeZoneOffsetMinutes * 60_000);
}

function formatOffset(timeZoneOffsetMinutes: number): string {
  const total = -timeZoneOffsetMinutes;
  const sign = total < 0 ? '-' : '+';
  const abs = Math.abs(total);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
