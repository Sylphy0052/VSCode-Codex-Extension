/**
 * 日報/週報システムへ渡す作業記録の1レコード。
 *
 * 形式は `~/.claude/scripts/daily/collect.py` の追記バッファ規約に合わせてある
 * （`ts` / `source` / `cwd` / `text` を読む）。フィールド名を変えると日報側が黙って
 * 取りこぼすため、collect.py と対で変更すること。
 */
export type ActivitySource = 'codex' | 'claude-code';

export interface ActivityRecord {
  /** ISO8601（ローカルオフセット付き）。 */
  ts: string;
  source: ActivitySource;
  cwd: string;
  /** セッションの1行要約。会話本文をこれ以上残さない。 */
  text: string;
  /** 収集元の区別。この拡張機能から出たものは常に 'vscode'。 */
  ref: string;
}

export interface BuildActivityRecordInput {
  now: Date;
  /** `Date.prototype.getTimezoneOffset()` と同じ符号（JSTなら -540）。 */
  timeZoneOffsetMinutes: number;
  source: ActivitySource;
  cwd: string;
  text: string;
}

/** collect.py の SUMMARY_MAX_LEN と揃える。 */
export const SUMMARY_MAX_LEN = 200;

const REF = 'vscode';

/**
 * 記録できないものは undefined を返す（呼び出し側は何も書かない）。
 * cwd が無いと日報がプロジェクトを判定できないため、本文と同じく必須にする。
 */
export function buildActivityRecord(input: BuildActivityRecordInput): ActivityRecord | undefined {
  const text = summarize(input.text);
  const cwd = input.cwd.trim();
  if (text === '' || cwd === '') {
    return undefined;
  }

  return {
    ts: formatLocalIso(input.now, input.timeZoneOffsetMinutes),
    source: input.source,
    cwd,
    text,
    ref: REF,
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
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= SUMMARY_MAX_LEN) {
    return collapsed;
  }
  return `${collapsed.slice(0, SUMMARY_MAX_LEN)}…`;
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
