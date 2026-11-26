import { formatCost, formatElapsed, formatSkillTime, formatTokens, type McFilter } from './logic';
import type {
  McFilterSpec,
  McRunTask,
  McRunTaskOp,
  McSavedFilter,
  McSession,
  McUsageSource,
  McUsageWindow,
} from './protocol';

/**
 * ヘッダの費用・利用枠と、保存した絞り込み（Issue #2162）の表示の組み立て。
 * DOMの型もPreactも使わない（単体テストから直接呼ぶ）。
 */

/** 開いているセッションの費用とトークン数の合計。 */
export interface McCostTotal {
  costUsd: number;
  /** 費用が分かったセッションの数（Claude Codeだけが費用を持つ）。 */
  costSessions: number;
  tokens: number;
  /** トークン数が分かったセッションの数（Codexだけがトークン数を持つ）。 */
  tokenSessions: number;
}

export function totalCost(sessions: readonly McSession[]): McCostTotal {
  let costUsd = 0;
  let costSessions = 0;
  let tokens = 0;
  let tokenSessions = 0;
  for (const s of sessions) {
    if (s.costUsd !== undefined && Number.isFinite(s.costUsd)) {
      costUsd += s.costUsd;
      costSessions += 1;
    }
    if (s.tokens !== undefined && Number.isFinite(s.tokens)) {
      tokens += s.tokens;
      tokenSessions += 1;
    }
  }
  return { costUsd, costSessions, tokens, tokenSessions };
}

/** ヘッダに出す費用の1行。どちらも分からなければ「取得できない」。 */
export function formatCostTotal(total: McCostTotal): string {
  const parts: string[] = [];
  if (total.costSessions > 0) {
    parts.push(`${formatCost(total.costUsd)}（Claude ${String(total.costSessions)}件）`);
  }
  if (total.tokenSessions > 0) {
    parts.push(`${formatTokens(total.tokens)} tokens（Codex ${String(total.tokenSessions)}件）`);
  }
  return parts.length === 0 ? '取得できない' : parts.join(' · ');
}

/**
 * 窓1つの表示。リセット時刻を過ぎた窓は使用率を出さない（古い値を今の値に見せない）。
 * 上限に達したままリセット時刻を過ぎた窓は、解除の通知を待っているので「解除待ち」と出す。
 */
export function formatUsageWindow(window: McUsageWindow, now: number): string {
  const label = oneLine(window.label, 40);
  if (isWindowStale(window, now)) {
    return window.limited ? `${label} 解除待ち` : `${label} --（リセット済み）`;
  }
  const bits = [label];
  if (window.usedPercent !== undefined) {
    bits.push(`${String(Math.round(window.usedPercent))}%`);
  }
  if (window.limited) {
    bits.push('到達');
  }
  if (window.resetsAt !== undefined) {
    bits.push(`・あと${formatElapsed(window.resetsAt - now)}`);
  }
  return bits.join(' ');
}

/**
 * 窓の経過割合がこれより小さいうちは見込みを出さない（Issue #2174）。窓の始めは使用率の
 * 1%の差が見込みを何倍にも振るため。5時間窓なら15分、週次なら約8時間。
 */
const MIN_ELAPSED_FRACTION = 0.05;

/** 現ペースでの到達見込み（Issue #2174）。 */
export interface McUsageProjection {
  /** このペースのままリセット時刻を迎えたときの使用率（%）。 */
  atResetPercent: number;
  /** 100%に届く見込みの時刻（ms）。リセットまでに届かない見込みなら無い。 */
  reachAt?: number | undefined;
}

/**
 * 使用率 ÷ 窓の経過割合 で、リセット時点の使用率と、100%に届く時刻を見込む（Issue #2174）。
 * 窓の始まりは`resetsAt - windowMs`とする。長さ・リセット時刻・使用率のどれかが分からない窓、
 * リセット済みの窓、上限に達した窓（もう見込む先が無い）、経過が短すぎる窓には出さない。
 */
export function projectUsage(window: McUsageWindow, now: number): McUsageProjection | undefined {
  const { usedPercent, resetsAt, windowMs } = window;
  if (
    usedPercent === undefined ||
    resetsAt === undefined ||
    windowMs === undefined ||
    !(windowMs > 0) ||
    window.limited ||
    isWindowStale(window, now)
  ) {
    return undefined;
  }
  const start = resetsAt - windowMs;
  const elapsed = now - start;
  const fraction = elapsed / windowMs;
  if (!Number.isFinite(fraction) || fraction < MIN_ELAPSED_FRACTION || fraction > 1) {
    return undefined;
  }
  const atResetPercent = usedPercent / fraction;
  const projection: McUsageProjection = { atResetPercent };
  if (usedPercent > 0 && atResetPercent >= 100) {
    // 窓の始まりから同じペースで100%まで進む時刻。リセットより後にはならない（上の条件）
    projection.reachAt = Math.max(now, start + (elapsed * 100) / usedPercent);
  }
  return projection;
}

/** 窓1つの見込みの表示（詳細パネル用）。見込みが出せなければ空文字。 */
export function formatUsageProjection(window: McUsageWindow, now: number): string {
  const projection = projectUsage(window, now);
  if (projection === undefined) {
    return '';
  }
  const percent = `見込み リセット時${String(Math.round(projection.atResetPercent))}%`;
  if (projection.reachAt === undefined) {
    return percent;
  }
  return `${percent}・100%到達 ${formatSkillTime(projection.reachAt, now)}（あと${formatElapsed(projection.reachAt - now)}）`;
}

/** 取得元1つの要約（ヘッダ用）。最も逼迫した窓だけを出す。 */
export function formatUsageSummary(source: McUsageSource | undefined, now: number): string {
  if (source === undefined || source.windows.length === 0) {
    return '取得できない';
  }
  const live = source.windows.filter((w) => !isWindowStale(w, now));
  const pool = live.length > 0 ? live : source.windows;
  const worst = pool.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  return formatUsageWindow(worst, now);
}

/**
 * リセット時刻を過ぎた窓か。拡張ホストが付けた`stale`はスナップショットを作った時点の判定で、
 * 利用枠の取得もMCの再描画も無いまま時刻を過ぎることがある（利用枠はセッションが動いたときにしか
 * 取り直さない）。画面の時計でも確かめ、古い使用率を今の値に見せない。
 */
export function isWindowStale(window: McUsageWindow, now: number): boolean {
  return window.stale || (window.resetsAt !== undefined && window.resetsAt <= now);
}

function rank(window: McUsageWindow): number {
  if (window.limited) {
    return Number.POSITIVE_INFINITY;
  }
  return window.usedPercent ?? Number.NEGATIVE_INFINITY;
}

/** 取得元の値がいつのものか（「3分前の値」）。分からなければ空。 */
export function formatCapturedAt(source: McUsageSource | undefined, now: number): string {
  if (source?.capturedAt === undefined) {
    return '';
  }
  return `${formatElapsed(now - source.capturedAt)}前の値`;
}

/** 取得元のどれかが上限に達していて、まだ効いているか。 */
export function isUsageLimited(source: McUsageSource | undefined): boolean {
  return source?.windows.some((w) => w.limited) === true;
}

/**
 * 外部由来の文字列を1行にして長さを切る。拡張ホストでも切ってあるが、古い版の拡張ホストや
 * 別ウィンドウが書いた値でも表示を崩さないよう、描く前にもう一度通す。
 */
export function oneLine(text: string, maxChars: number): string {
  // 制御文字・改行・行区切りは空白へ
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ');
  const squeezed = flat.replace(/\s+/gu, ' ').trim();
  const chars = [...squeezed];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : squeezed;
}

/** 保存する形へ（`undefined`のキーは落とす）。 */
export function toFilterSpec(filter: McFilter): McFilterSpec {
  const spec: McFilterSpec = {
    provider: filter.provider,
    currentWindowOnly: filter.currentWindowOnly,
    query: filter.query,
  };
  if (filter.repoKey !== undefined) {
    spec.repoKey = filter.repoKey;
  }
  if (filter.activity !== undefined) {
    spec.activity = filter.activity;
  }
  return spec;
}

export function fromFilterSpec(spec: McFilterSpec): McFilter {
  return {
    repoKey: spec.repoKey,
    provider: spec.provider,
    currentWindowOnly: spec.currentWindowOnly,
    query: spec.query,
    activity: spec.activity,
  };
}

export function sameFilter(a: McFilter, b: McFilterSpec): boolean {
  return (
    a.repoKey === b.repoKey &&
    a.provider === b.provider &&
    a.currentWindowOnly === b.currentWindowOnly &&
    a.query === b.query &&
    a.activity === b.activity
  );
}

/** 今の絞り込みと中身が同じ保存済みの絞り込み。無ければ`undefined`。 */
export function activeSavedFilter(
  saved: readonly McSavedFilter[],
  filter: McFilter,
): McSavedFilter | undefined {
  return saved.find((s) => sameFilter(filter, s.filter));
}

/**
 * `[` / `]`で次に切り替える保存済みの絞り込み。今の絞り込みが保存済みのどれとも違えば、
 * `]`は先頭、`[`は末尾へ。保存が無ければ`undefined`。
 */
export function cycleSavedFilter(
  saved: readonly McSavedFilter[],
  filter: McFilter,
  delta: 1 | -1,
): McSavedFilter | undefined {
  if (saved.length === 0) {
    return undefined;
  }
  const current = saved.findIndex((s) => sameFilter(filter, s.filter));
  if (current < 0) {
    return delta === 1 ? saved[0] : saved[saved.length - 1];
  }
  return saved[(current + delta + saved.length) % saved.length];
}

/**
 * 選んでいるタスク（runのタスク単位の操作の対象）。選んだidが今のrunに無ければ`undefined`で、
 * 先頭のタスクを選んだ扱いにはしない（別のタスクをやり直す・止めることを防ぐ）。
 */
export function findSelectedTask(
  tasks: readonly McRunTask[],
  selectedTask: string | undefined,
): McRunTask | undefined {
  return selectedTask === undefined ? undefined : tasks.find((t) => t.taskId === selectedTask);
}

/**
 * タスク単位の操作を送れない理由。送れるなら`undefined`。`taskId`はタスクの固定idで、
 * 今のrunに無いidは選んでいない扱いにする。
 */
export function taskOpBlockReason(
  tasks: readonly McRunTask[],
  taskId: string | undefined,
  op: McRunTaskOp,
): string | undefined {
  const task = findSelectedTask(tasks, taskId);
  if (task === undefined) {
    return 'タスクを選んでください（Shift+J / Shift+K）';
  }
  if (op === 'retry' && task.canRetry !== true) {
    return `${task.taskId}は今やり直せません`;
  }
  if (op === 'stop' && task.canStop !== true) {
    return `${task.taskId}は今止められる工程がありません`;
  }
  return undefined;
}
