import type { ChatUsage } from '../appserver/chatState';
import { formatResetsIn } from '../codex/usage';

/**
 * ステータスバーに出すClaude Codeの制限表示。
 *
 * Codexと違って消費率が取れないため、制限の種類とリセットまでの時間で示す（設計書 §14.8）。
 * 値はチャット画面が動いている間にしか届かないので、一度も届いていなければ空を返す。
 */
export function formatClaudeUsage(usage: ChatUsage | undefined, nowMs: number): string {
  if (usage === undefined) {
    return '';
  }

  const bits: string[] = [];
  if (usage.usedPercent !== undefined) {
    bits.push(`${Math.round(usage.usedPercent)}%`);
  }
  // 到達は割合と同時に出す。割合が判った後に到達の表示が落ちると、待ちが要ることが読めなくなる
  // （issue #1221）
  if (usage.limited === true) {
    bits.push(usage.limitLabel === undefined ? '到達' : `${usage.limitLabel} 到達`);
  } else if (usage.usedPercent === undefined && usage.limitLabel !== undefined) {
    bits.push(usage.limitLabel);
  }

  // リセット時刻を過ぎても、解除の通知が届くまでは解除されたことにしない（issue #1224）。
  // 「まもなく」のままにすると、時刻が過ぎたことと上限が解けたことを読み分けられない
  const resets = isAwaitingRelease(usage, nowMs)
    ? '解除待ち'
    : formatResetsIn(usage.resetsAt, nowMs);
  if (resets !== '') {
    bits.push(resets);
  }

  return bits.length === 0 ? '' : `Claude ${bits.join(' ・ ')}`;
}

/**
 * 到達したままリセット時刻を過ぎているか。
 *
 * Claudeの解除は `rate_limit_event` でしか判らず、チャットが止まっていれば届かない。
 * こちらから解除を推定せず、待っている状態として出す。
 */
export function isAwaitingRelease(
  limit: { limited: boolean | undefined; resetsAt: number | undefined },
  nowMs: number,
): boolean {
  return limit.limited === true && limit.resetsAt !== undefined && limit.resetsAt * 1000 <= nowMs;
}

/**
 * `/usage` の応答から消費率を読む。
 *
 * `rate_limit_event` は割合を持たないが、この出力には入っている。ただし英語の
 * 文章なので、文言が変われば読めなくなる。読めなければ黙って諦め、
 * `rate_limit_event` 由来の表示に任せる。
 *
 * 期待する形: `Current session: 16% used · resets Aug 10, 8:09pm (Asia/Tokyo)`
 */
export function parseUsageReport(text: string): ChatUsage | undefined {
  const session = /Current session:\s*(\d+)%\s*used/i.exec(text);
  if (session?.[1] !== undefined) {
    return usageOf(Number(session[1]), 'セッション');
  }

  const weekly = /Current week[^:]*:\s*(\d+)%\s*used/i.exec(text);
  if (weekly?.[1] !== undefined) {
    return usageOf(Number(weekly[1]), '週次');
  }
  return undefined;
}

/** 枠ひとつぶんの使用率。`resetsAt` はepochミリ秒。 */
export interface UsageSlot {
  pct: number;
  resetsAt: number | undefined;
}

/** `/usage` から読んだ、アカウントの自動切り替えに使う2つの枠。 */
export interface UsageSlots {
  fiveHour: UsageSlot | undefined;
  /** 週次のうち全モデルの枠。モデル別の枠は切り替えの判断に使わない。 */
  weekly: UsageSlot | undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * `/usage` の出力から、5時間枠と週次（全モデル）の使用率とリセット時刻を読む。
 * どちらも読めなければ `undefined`。リセット時刻の括弧内のタイムゾーンは見ず、
 * 実行したマシンの現地時刻として解釈する。
 *
 * 期待する形:
 * `Current session: 16% used · resets Aug 10, 8:09pm (Asia/Tokyo)`
 * `Current week (all models): 23% used · resets Oct 16, 7am (Asia/Tokyo)`
 */
export function parseUsageSlots(text: string, nowMs: number): UsageSlots | undefined {
  const slots: UsageSlots = { fiveHour: undefined, weekly: undefined };
  const lines = /^Current (session|week \(([^)]+)\)):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^(\n]+?)\s*(?:\([^)]*\))?)?\s*$/gim;
  for (const m of text.matchAll(lines)) {
    const slot: UsageSlot = {
      pct: Number(m[3]),
      resetsAt: m[4] === undefined ? undefined : parseResetTime(m[4], nowMs),
    };
    if (m[1]?.toLowerCase() === 'session') {
      slots.fiveHour = slot;
    } else if (m[2]?.trim().toLowerCase() === 'all models') {
      slots.weekly = slot;
    }
  }
  return slots.fiveHour === undefined && slots.weekly === undefined ? undefined : slots;
}

/** `Aug 10, 8:09pm` / `Oct 16, 7am` を現地時刻のepochミリ秒にする。読めなければ `undefined`。 */
function parseResetTime(text: string, nowMs: number): number | undefined {
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim());
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined || m[5] === undefined) {
    return undefined;
  }
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) {
    return undefined;
  }
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const at = new Date(new Date(nowMs).getFullYear(), month, Number(m[2]), hour, Number(m[4] ?? 0));
  // 年を表記しないので、1日以上前なら来年の日付とみなす
  if (at.getTime() < nowMs - 86_400_000) {
    at.setFullYear(at.getFullYear() + 1);
  }
  return at.getTime();
}

function usageOf(usedPercent: number, limitLabel: string): ChatUsage {
  return { usedPercent, resetsAt: undefined, limitLabel, limited: undefined };
}

/**
 * 制限枠ひとつぶんの保持値（issue #1221）。
 *
 * Claudeの制限表示は取得元が2つあり、`rate_limit_event` は到達とリセット時刻だけを、
 * `/usage` は消費率だけを返す。届いた値でそのまま置き換えると、後から来たほうが持っていない
 * 情報が消える。枠ごとに保持して重ねることで、取得の順序で表示が欠けないようにする。
 */
export interface ClaudeLimitEntry {
  /** 制限枠の表示名。取得元の表記のまま持つ。判らなければ undefined。 */
  label: string | undefined;
  usedPercent: number | undefined;
  resetsAt: number | undefined;
  limited: boolean | undefined;
}

/**
 * 届いた値を枠ごとに重ねる。
 *
 * 同じ枠（`limitLabel`）の値は上書きし、`undefined` のフィールドは前の値を残す。
 * `/usage` の「セッション」と `rate_limit_event` の「5時間」が同じ枠かはCLIから判らないため、
 * 表記が違えば別の枠として持つ。異なる枠の数値とリセット時刻を混ぜない。
 */
export function mergeClaudeUsage(
  prev: readonly ClaudeLimitEntry[],
  incoming: ChatUsage,
): ClaudeLimitEntry[] {
  const next = prev.map((entry) => ({ ...entry }));
  if (
    incoming.usedPercent === undefined &&
    incoming.resetsAt === undefined &&
    incoming.limited === undefined
  ) {
    // ラベルしか無い通知で空の枠を増やしても表示できるものが無い
    return next;
  }

  const found = next.find((entry) => entry.label === incoming.limitLabel);
  const target = found ?? {
    label: incoming.limitLabel,
    usedPercent: undefined,
    resetsAt: undefined,
    limited: undefined,
  };
  if (found === undefined) {
    next.push(target);
  }
  if (incoming.usedPercent !== undefined) {
    target.usedPercent = incoming.usedPercent;
  }
  if (incoming.resetsAt !== undefined) {
    target.resetsAt = incoming.resetsAt;
  }
  if (incoming.limited !== undefined) {
    target.limited = incoming.limited;
  }
  return next;
}

/**
 * 保持している枠から、見出しに出す代表値を選ぶ。
 *
 * 到達している枠を優先する（待ちが要るのはそちらのため）。複数あれば最も遅いリセット時刻の枠、
 * 到達が無ければ最も逼迫した枠。割合もリセット時刻も判らない枠は最後に回す。
 */
export function summarizeClaudeLimits(entries: readonly ClaudeLimitEntry[]): ChatUsage | undefined {
  const limited = entries.filter((entry) => entry.limited === true);
  const byResetsAt = limited.length > 0;
  const pool = byResetsAt ? limited : entries;
  let best: ClaudeLimitEntry | undefined;
  for (const entry of pool) {
    if (best === undefined || rankOf(entry, byResetsAt) > rankOf(best, byResetsAt)) {
      best = entry;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return {
    usedPercent: best.usedPercent,
    resetsAt: best.resetsAt,
    limitLabel: best.label,
    limited: best.limited,
  };
}

function rankOf(entry: ClaudeLimitEntry, byResetsAt: boolean): number {
  const value = byResetsAt ? entry.resetsAt : entry.usedPercent;
  return value ?? Number.NEGATIVE_INFINITY;
}

/**
 * ツールチップに出す枠ごとの行。
 *
 * 見出しには1枠ぶんしか出せないため、代表に選ばれなかった枠の値はここでしか読めない。
 */
export function formatClaudeLimitLines(
  entries: readonly ClaudeLimitEntry[],
  nowMs: number,
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const bits: string[] = [];
    if (entry.usedPercent !== undefined) {
      bits.push(`${Math.round(entry.usedPercent)}% 使用`);
    }
    if (entry.limited === true) {
      bits.push('到達');
    }
    if (isAwaitingRelease(entry, nowMs)) {
      // 解除はCLIの通知でしか判らないため、時刻を過ぎたことだけを述べる（issue #1224）
      bits.push('リセット時刻を過ぎましたが解除の通知は届いていません');
    } else {
      const resets = formatResetsIn(entry.resetsAt, nowMs);
      if (resets !== '') {
        bits.push(`リセット ${resets}`);
      }
    }
    if (bits.length === 0) {
      continue;
    }
    lines.push(`- ${entry.label ?? '制限'}: ${bits.join(' ・ ')}`);
  }
  return lines;
}
