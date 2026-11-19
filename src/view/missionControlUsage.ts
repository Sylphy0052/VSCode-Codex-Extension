import type { ClaudeLimitEntry } from '../claude/usageText';
import { formatWindow, formatWindowLabel, type UsageSnapshot } from '../codex/usage';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type { McUsage, McUsageSource, McUsageWindow } from '../webview/missionControl/protocol';
import type { UsageState } from './usageStatusBar';

/** 窓の表示名・プラン名の長さの上限。外部由来の文字列なので切って1行にする。 */
const LABEL_MAX_LENGTH = 40;

/**
 * ステータスバーが持っている利用枠を、Mission Controlへ送る形にする（Issue #2162）。
 *
 * 取得元は`UsageStatusBar`だけで、ここから新たに取りに行かない（`/api/oauth/usage`は
 * slotトークンで429になる）。取得できていない取得元は返さず、画面が「取得できない」と出す。
 * リセット時刻を過ぎた窓は`stale`にし、使用率を今の値に見せない。
 */
export function buildMcUsage(state: UsageState, now: number): McUsage {
  const usage: McUsage = {};
  const codex = codexSource(state.codex, now);
  if (codex !== undefined) {
    usage.codex = codex;
  }
  const claude = claudeSource(state.claude, state.claudeReceivedAt, now);
  if (claude !== undefined) {
    usage.claude = claude;
  }
  return usage;
}

function codexSource(snapshot: UsageSnapshot | undefined, now: number): McUsageSource | undefined {
  if (snapshot?.usedPercent === undefined) {
    return undefined;
  }
  const windows: McUsageWindow[] =
    snapshot.windows.length === 0
      ? [
          toWindow(
            formatWindow(snapshot.windowMinutes) || '制限',
            snapshot.usedPercent,
            snapshot.resetsAt,
            snapshot.usedPercent >= 100,
            now,
          ),
        ]
      : snapshot.windows.map((w) =>
          toWindow(
            formatWindowLabel(w, snapshot.windows),
            w.usedPercent,
            w.resetsAt,
            w.usedPercent >= 100,
            now,
          ),
        );
  const source: McUsageSource = { windows };
  const capturedAt = parseTime(snapshot.capturedAt);
  if (capturedAt !== undefined) {
    source.capturedAt = capturedAt;
  }
  if (snapshot.planType !== undefined) {
    source.plan = sanitizeInlineText(snapshot.planType, LABEL_MAX_LENGTH);
  }
  return source;
}

function claudeSource(
  entries: readonly ClaudeLimitEntry[],
  receivedAt: number | undefined,
  now: number,
): McUsageSource | undefined {
  const windows = entries
    .filter((e) => e.usedPercent !== undefined || e.resetsAt !== undefined || e.limited === true)
    .map((e) => toWindow(e.label ?? '制限', e.usedPercent, e.resetsAt, e.limited === true, now));
  if (windows.length === 0) {
    return undefined;
  }
  return receivedAt === undefined ? { windows } : { windows, capturedAt: receivedAt };
}

/** `resetsAtSeconds`はepoch秒（Codex・Claudeとも同じ単位）。 */
function toWindow(
  label: string,
  usedPercent: number | undefined,
  resetsAtSeconds: number | undefined,
  limited: boolean,
  now: number,
): McUsageWindow {
  const resetsAt =
    resetsAtSeconds !== undefined && Number.isFinite(resetsAtSeconds)
      ? resetsAtSeconds * 1000
      : undefined;
  const stale = resetsAt !== undefined && resetsAt <= now;
  const window: McUsageWindow = {
    label: sanitizeInlineText(label, LABEL_MAX_LENGTH),
    // リセット時刻を過ぎても、解除の通知が届くまでは解除されたことにしない（ステータスバーの
    // 「解除待ち」と同じ。issue #1224）。画面は`limited`かつ`stale`を「解除待ち」と出す
    limited,
    stale,
  };
  if (usedPercent !== undefined && Number.isFinite(usedPercent)) {
    window.usedPercent = usedPercent;
  }
  if (resetsAt !== undefined) {
    window.resetsAt = resetsAt;
  }
  return window;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}
