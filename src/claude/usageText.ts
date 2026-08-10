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
  if (usage.limitLabel !== undefined) {
    bits.push(usage.limited === true ? `${usage.limitLabel} 到達` : usage.limitLabel);
  }

  const resets = formatResetsIn(usage.resetsAt, nowMs);
  if (resets !== '') {
    bits.push(resets);
  }

  return bits.length === 0 ? '' : `Claude ${bits.join(' ・ ')}`;
}
