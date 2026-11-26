import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type {
  McProvider,
  McUsageHistory,
  McUsageHistoryPoint,
  McUsageHistorySeries,
} from '../webview/missionControl/protocol';
import { readWorkHistory, type WorkHistoryRecord } from './workHistory';

/**
 * 作業履歴（Issue #2175）に残した利用枠の値から、窓ごとの推移と日別の使用量を組む（Issue #2176）。
 *
 * 作業履歴の読み出し（`readWorkHistory`）はそのまま使い、ここでは読んだ記録を画面へ送る形に
 * するだけにする。
 */

/** 推移を出す日数（今日を含む）。 */
export const USAGE_HISTORY_DAYS = 14;
/** 窓1つあたりに送る点の上限。超えたら間引く（区切りの最初と最後の点は残す）。 */
export const MAX_USAGE_HISTORY_POINTS = 400;
/** 窓の表示名の長さの上限。`missionControlUsage.ts`と同じ。 */
const LABEL_MAX_LENGTH = 40;
/**
 * リセット時刻がこれ以上ずれたら別の窓（リセット後の新しい区切り）とみなす。取得のたびに
 * リセット時刻が数秒〜数分揺れることがあるため、ぴったりの一致では比べない。
 */
const RESET_TOLERANCE_MS = 30 * 60 * 1000;
/**
 * リセット時刻が分からない窓は、使用率がこれ以上下がったらリセットとみなす。複数のウィンドウが
 * 少しずれた値を残すことがあるため、わずかな下がりでは区切らない。
 */
const RESET_DROP_PERCENT = 5;

interface Sample {
  at: number;
  usedPercent: number;
  resetsAt: number | undefined;
}

interface SeriesDraft {
  provider: McProvider;
  label: string;
  windowMs: number | undefined;
  samples: Sample[];
}

const PROVIDER_ORDER: Record<McProvider, number> = { codex: 0, claude: 1 };

/** 期間の始まり（`days`日前を含む日の0時、地方時）。 */
export function usageHistorySince(now: number, days: number = USAGE_HISTORY_DAYS): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (days - 1));
  return date.getTime();
}

/** 作業履歴を読み、利用枠の推移を組む。 */
export async function loadUsageHistory(
  globalStorageDir: string,
  now: number,
  days: number = USAGE_HISTORY_DAYS,
): Promise<McUsageHistory> {
  const since = usageHistorySince(now, days);
  const records = await readWorkHistory(globalStorageDir, { since, kind: 'usage' });
  return buildUsageHistory(records, now, days);
}

/**
 * 利用枠の記録から推移を組む。
 *
 * - 時刻は窓の計測時刻（`sampledAt`）を使う。複数のウィンドウが同じ値を残すので、同じ時刻・
 *   同じ値は1点にする
 * - 計測時刻の無い窓（Claudeの「セッション」など）は、そのウィンドウで値が変わった記録の時刻
 *   （`at`）を使い、変わっていない記録は捨てる。記録は値が届くたびに書くので、値が変わった記録の
 *   時刻が受け取った時刻に当たる。`capturedAt`は全部の枠のうち最も古い受け取り時刻なので、
 *   この窓の時刻には使えない（古い枠が残っていると、全部の点がその時刻へ寄る）。変わっていない
 *   記録を捨てるのは、ほかの枠が変わったときに古い値が新しい時刻で書き直され、別のウィンドウの
 *   新しい値と交互に並んでリセットに見えるのを防ぐため
 * - リセット時刻を過ぎてから残った値は今の値ではないので捨てる
 * - 日別の使用量は、リセットまでの区切りの中で使用率が最大値を更新した分を、その点の日に足す。
 *   リセットの後は0から数える。期間の最初の点は、それより前の使用量が分からないので数えない
 */
export function buildUsageHistory(
  records: readonly WorkHistoryRecord[],
  now: number,
  days: number = USAGE_HISTORY_DAYS,
): McUsageHistory {
  const dayStarts = dayStartsOf(now, days);
  const since = dayStarts[0] ?? now;
  const drafts = new Map<string, SeriesDraft>();
  /** 計測時刻の無い窓の、ウィンドウごとの直前の値。 */
  const lastUnsampled = new Map<string, number>();
  const ordered = [...records].sort((a, b) => a.at - b.at);
  for (const record of ordered) {
    if (record.kind !== 'usage') {
      continue;
    }
    for (const window of record.windows) {
      const used = window.usedPercent;
      if (used === undefined || !Number.isFinite(used)) {
        continue;
      }
      const label = sanitizeInlineText(window.label, LABEL_MAX_LENGTH);
      const key = `${record.provider}\n${label}`;
      let at: number;
      if (window.sampledAt !== undefined) {
        at = window.sampledAt;
      } else {
        const memoKey = `${record.windowId}\n${key}`;
        const previous = lastUnsampled.get(memoKey);
        lastUnsampled.set(memoKey, used);
        if (previous === used) {
          continue;
        }
        at = record.at;
      }
      if (at < since || at > now) {
        continue;
      }
      if (window.resetsAt !== undefined && at >= window.resetsAt) {
        continue;
      }
      let draft = drafts.get(key);
      if (draft === undefined) {
        draft = { provider: record.provider, label, windowMs: undefined, samples: [] };
        drafts.set(key, draft);
      }
      if (window.windowMs !== undefined) {
        draft.windowMs = window.windowMs;
      }
      draft.samples.push({
        at,
        usedPercent: Math.min(Math.max(used, 0), 100),
        resetsAt: window.resetsAt,
      });
    }
  }
  const series = [...drafts.values()].map((draft) => toSeries(draft, dayStarts));
  series.sort(compareSeries);
  return { since, until: now, days: dayStarts.map(dayKey), series };
}

function toSeries(draft: SeriesDraft, dayStarts: readonly number[]): McUsageHistorySeries {
  const samples = dedupe([...draft.samples].sort((a, b) => a.at - b.at));
  const daily = dayStarts.map(() => 0);
  const segments: McUsageHistoryPoint[][] = [];
  let current: McUsageHistoryPoint[] | undefined;
  let resetsAt: number | undefined;
  let max = 0;
  for (const sample of samples) {
    const point = { at: sample.at, usedPercent: sample.usedPercent };
    if (current === undefined) {
      current = [point];
      segments.push(current);
      resetsAt = sample.resetsAt;
      max = sample.usedPercent;
      continue;
    }
    if (isNewPeriod(sample, resetsAt, max)) {
      current = [point];
      segments.push(current);
      resetsAt = sample.resetsAt;
      max = sample.usedPercent;
      addDaily(daily, dayStarts, sample.at, sample.usedPercent);
      continue;
    }
    current.push(point);
    resetsAt ??= sample.resetsAt;
    if (sample.usedPercent > max) {
      addDaily(daily, dayStarts, sample.at, sample.usedPercent - max);
      max = sample.usedPercent;
    }
  }
  const result: McUsageHistorySeries = {
    provider: draft.provider,
    label: draft.label,
    segments: thin(segments, MAX_USAGE_HISTORY_POINTS),
    daily: daily.map((value) => Math.round(value * 10) / 10),
  };
  if (draft.windowMs !== undefined) {
    result.windowMs = draft.windowMs;
  }
  return result;
}

function isNewPeriod(sample: Sample, resetsAt: number | undefined, max: number): boolean {
  if (resetsAt !== undefined && sample.at >= resetsAt) {
    return true;
  }
  if (resetsAt !== undefined && sample.resetsAt !== undefined) {
    return Math.abs(sample.resetsAt - resetsAt) > RESET_TOLERANCE_MS;
  }
  if (resetsAt === undefined && sample.resetsAt === undefined) {
    return sample.usedPercent < max - RESET_DROP_PERCENT;
  }
  return false;
}

function dedupe(samples: readonly Sample[]): Sample[] {
  const result: Sample[] = [];
  for (const sample of samples) {
    const last = result[result.length - 1];
    if (last !== undefined && last.at === sample.at && last.usedPercent === sample.usedPercent) {
      continue;
    }
    result.push(sample);
  }
  return result;
}

function addDaily(daily: number[], dayStarts: readonly number[], at: number, amount: number): void {
  for (let i = dayStarts.length - 1; i >= 0; i -= 1) {
    const start = dayStarts[i];
    if (start !== undefined && at >= start) {
      daily[i] = (daily[i] ?? 0) + amount;
      return;
    }
  }
}

/** 点の数が上限を超えたら、同じ間隔で間引く。区切りごとの最初と最後の点は残す。 */
export function thin(
  segments: readonly McUsageHistoryPoint[][],
  limit: number,
): McUsageHistoryPoint[][] {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (total <= limit) {
    return segments.map((segment) => [...segment]);
  }
  const stride = Math.ceil(total / limit);
  return segments.map((segment) =>
    segment.filter((_, i) => i === 0 || i === segment.length - 1 || i % stride === 0),
  );
}

function dayStartsOf(now: number, days: number): number[] {
  const starts: number[] = [];
  const date = new Date(usageHistorySince(now, days));
  for (let i = 0; i < days; i += 1) {
    starts.push(date.getTime());
    date.setDate(date.getDate() + 1);
  }
  return starts;
}

function dayKey(start: number): string {
  const date = new Date(start);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** Codex → Claude、窓の短い順（長さの分からない窓は後ろ）、表示名の順。 */
function compareSeries(a: McUsageHistorySeries, b: McUsageHistorySeries): number {
  const byProvider = PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider];
  if (byProvider !== 0) {
    return byProvider;
  }
  const aMs = a.windowMs ?? Number.POSITIVE_INFINITY;
  const bMs = b.windowMs ?? Number.POSITIVE_INFINITY;
  if (aMs !== bMs) {
    return aMs < bMs ? -1 : 1;
  }
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}
