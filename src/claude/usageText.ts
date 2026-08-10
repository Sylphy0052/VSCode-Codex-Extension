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
  } else if (usage.limitLabel !== undefined) {
    bits.push(usage.limited === true ? `${usage.limitLabel} 到達` : usage.limitLabel);
  }

  const resets = formatResetsIn(usage.resetsAt, nowMs);
  if (resets !== '') {
    bits.push(resets);
  }

  return bits.length === 0 ? '' : `Claude ${bits.join(' ・ ')}`;
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
