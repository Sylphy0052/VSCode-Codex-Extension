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
