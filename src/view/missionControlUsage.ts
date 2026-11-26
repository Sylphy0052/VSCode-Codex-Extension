import type { ProbedSlots } from '../claude/usageProbe';
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
  const claude = claudeSource(state, now);
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
            minutesToMs(snapshot.windowMinutes),
          ),
        ]
      : snapshot.windows.map((w) =>
          toWindow(
            formatWindowLabel(w, snapshot.windows),
            w.usedPercent,
            w.resetsAt,
            w.usedPercent >= 100,
            now,
            minutesToMs(w.windowMinutes),
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

function claudeSource(state: UsageState, now: number): McUsageSource | undefined {
  const { entries, slotsUsed } = withProbedSlots(state.claude, state.claudeSlots, now);
  const windows = entries
    .filter((e) => e.usedPercent !== undefined || e.resetsAt !== undefined || e.limited === true)
    .map((e) =>
      toWindow(
        e.label ?? '制限',
        e.usedPercent,
        e.resetsAt,
        e.limited === true,
        now,
        claudeWindowMs(e.label),
      ),
    );
  if (windows.length === 0) {
    return undefined;
  }
  const receivedAt = oldest(
    state.claudeReceivedAt,
    slotsUsed ? state.claudeSlots?.readAt : undefined,
  );
  return receivedAt === undefined ? { windows } : { windows, capturedAt: receivedAt };
}

/**
 * `/usage`から読んだ5時間枠と週次（Issue #2174）を、同じ表示名の枠へ重ねる。
 *
 * ステータスバーの枠は、`rate_limit_event`由来の「5時間」「週次」がリセット時刻と到達だけを、
 * `/usage`由来の「セッション」が使用率だけを持ち、見込みに要る組（使用率とリセット時刻）が
 * 揃わない。`parseUsageSlots`は`Current session`を5時間枠、`Current week (all models)`を
 * 週次として使用率とリセット時刻を組で読むので、それを使う。到達はステータスバーの枠の値を残す。
 * 読んだ値のリセット時刻を過ぎていれば、今の窓の値ではないのでステータスバーの枠をそのまま使う。
 * 「セッション」の枠は従来どおり出す（長さは決めない）。
 */
function withProbedSlots(
  entries: readonly ClaudeLimitEntry[],
  probed: ProbedSlots | undefined,
  now: number,
): { entries: ClaudeLimitEntry[]; slotsUsed: boolean } {
  if (probed === undefined) {
    return { entries: [...entries], slotsUsed: false };
  }
  const slotEntries: ClaudeLimitEntry[] = [];
  for (const [label, slot] of [
    ['5時間', probed.slots.fiveHour],
    ['週次', probed.slots.weekly],
  ] as const) {
    if (slot !== undefined) {
      slotEntries.push({
        label,
        usedPercent: slot.pct,
        // `UsageSlot.resetsAt`はms。ステータスバーの枠（epoch秒）に揃える
        resetsAt: slot.resetsAt === undefined ? undefined : slot.resetsAt / 1000,
        limited: undefined,
      });
    }
  }
  let slotsUsed = false;
  const merged = entries.map((entry) => {
    const index = slotEntries.findIndex((s) => s.label === entry.label);
    if (index < 0) {
      return entry;
    }
    const [slot] = slotEntries.splice(index, 1);
    if (slot?.resetsAt === undefined || slot.resetsAt * 1000 <= now) {
      return entry;
    }
    slotsUsed = true;
    return { ...slot, limited: entry.limited };
  });
  if (slotEntries.length > 0) {
    slotsUsed = true;
  }
  return { entries: [...merged, ...slotEntries], slotsUsed };
}

function oldest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : Math.min(a, b);
}

/**
 * Claudeの枠の長さ（Issue #2174）。`ClaudeLimitEntry`は長さを持たないので、表示名から決まる
 * ものだけを返す。表示名は`rate_limit_event`の種別を訳したもの（`streamJson.ts`の
 * `limitLabelOf`）と、`withProbedSlots`が付けるもの。`/usage`の「セッション」の枠は
 * `parseUsageReport`の表記のままで、長さを決めず見込みを出さない。
 */
const CLAUDE_WINDOW_MINUTES: Readonly<Record<string, number>> = {
  '5時間': 5 * 60,
  週次: 7 * 24 * 60,
};

function claudeWindowMs(label: string | undefined): number | undefined {
  if (label === undefined || !Object.hasOwn(CLAUDE_WINDOW_MINUTES, label)) {
    return undefined;
  }
  return minutesToMs(CLAUDE_WINDOW_MINUTES[label]);
}

function minutesToMs(minutes: number | undefined): number | undefined {
  return minutes !== undefined && Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : undefined;
}

/** `resetsAtSeconds`はepoch秒（Codex・Claudeとも同じ単位）。 */
function toWindow(
  label: string,
  usedPercent: number | undefined,
  resetsAtSeconds: number | undefined,
  limited: boolean,
  now: number,
  windowMs: number | undefined,
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
  if (windowMs !== undefined) {
    window.windowMs = windowMs;
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
