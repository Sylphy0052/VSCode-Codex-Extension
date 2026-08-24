export interface UsageSnapshot {
  /** この値がAPI応答から得られた時刻（イベントのtimestamp）。 */
  capturedAt: string | undefined;
  usedPercent: number | undefined;
  /** 制限ウィンドウの長さ（分）。10080なら週次。 */
  windowMinutes: number | undefined;
  /** 制限がリセットされる時刻（epoch秒）。 */
  resetsAt: number | undefined;
  planType: string | undefined;
  creditsBalance: string | undefined;
  hasCredits: boolean | undefined;
  totalTokens: number | undefined;
  contextWindow: number | undefined;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/**
 * `account/rateLimits/read` の応答を読む。
 *
 * ロールアウトの追記を待たずに現在値を問い合わせられる。ファイル由来のスナップショット
 * （`parseTokenCountLine`）と同じ形に整えて、表示側は区別せず扱えるようにする。
 */
export function readRateLimits(result: unknown, capturedAt: string): UsageSnapshot | undefined {
  const rateLimits = obj(obj(result)?.['rateLimits']);
  const primary = obj(rateLimits?.['primary']);
  const usedPercent = primary?.['usedPercent'];
  if (primary === undefined || typeof usedPercent !== 'number') {
    return undefined;
  }

  const credits = obj(rateLimits?.['credits']);
  return {
    capturedAt,
    usedPercent,
    windowMinutes: num(primary['windowDurationMins']),
    resetsAt: num(primary['resetsAt']),
    planType: str(rateLimits?.['planType']),
    creditsBalance: str(credits?.['balance']),
    hasCredits: typeof credits?.['hasCredits'] === 'boolean' ? credits['hasCredits'] : undefined,
    totalTokens: undefined,
    contextWindow: undefined,
  };
}

/**
 * ロールアウトの `token_count` イベント1行から使用量を取り出す。
 *
 * レート制限はアカウント単位で記録されるため、どのセッションの行でも現在値として使える。
 * ただしCodexがAPIを呼んだ時点の値であり、能動的に取得する手段はない（`capturedAt` を併記する理由）。
 */
export function parseTokenCountLine(line: string): UsageSnapshot | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }

  const root = obj(raw);
  if (root === undefined || root['type'] !== 'event_msg') {
    return undefined;
  }

  const payload = obj(root['payload']);
  if (payload === undefined || payload['type'] !== 'token_count') {
    return undefined;
  }

  const limits = obj(payload['rate_limits']);
  const primary = obj(limits?.['primary']);
  const credits = obj(limits?.['credits']);
  const info = obj(payload['info']);
  const total = obj(info?.['total_token_usage']);

  return {
    capturedAt: str(root['timestamp']),
    usedPercent: num(primary?.['used_percent']),
    windowMinutes: num(primary?.['window_minutes']),
    resetsAt: num(primary?.['resets_at']),
    planType: str(limits?.['plan_type']),
    creditsBalance: str(credits?.['balance']),
    hasCredits: typeof credits?.['has_credits'] === 'boolean' ? credits['has_credits'] : undefined,
    totalTokens: num(total?.['total_tokens']),
    contextWindow: num(info?.['model_context_window']),
  };
}

/**
 * ファイル末尾の断片から最後の `token_count` を拾う。
 * 先頭が欠けた行を含みうるため、パースできない行は黙って読み飛ばす。
 */
export function findLastTokenCount(chunk: string): UsageSnapshot | undefined {
  const lines = chunk.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || !line.includes('"token_count"')) {
      continue;
    }
    const parsed = parseTokenCountLine(line);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

const MINUTES_PER_DAY = 60 * 24;

/** 制限ウィンドウの人間向け表記。 */
export function formatWindow(windowMinutes: number | undefined): string {
  if (windowMinutes === undefined || windowMinutes <= 0) {
    return '';
  }
  if (windowMinutes % (7 * MINUTES_PER_DAY) === 0) {
    const weeks = windowMinutes / (7 * MINUTES_PER_DAY);
    return weeks === 1 ? '週次' : `${weeks}週`;
  }
  if (windowMinutes % MINUTES_PER_DAY === 0) {
    return `${windowMinutes / MINUTES_PER_DAY}日`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}時間`;
  }
  return `${windowMinutes}分`;
}

/** リセットまでの残り時間。 */
export function formatResetsIn(resetsAtEpochSeconds: number | undefined, nowMs: number): string {
  if (resetsAtEpochSeconds === undefined) {
    return '';
  }
  const diffMs = resetsAtEpochSeconds * 1000 - nowMs;
  if (diffMs <= 0) {
    return 'まもなく';
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}分後`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}時間後`;
  }
  return `${Math.floor(hours / 24)}日後`;
}

export type UsageSeverity = 'normal' | 'warning' | 'critical';

/** 使用率に応じた強調度。ステータスバーの背景色に対応させる。 */
export function severityOf(usedPercent: number | undefined): UsageSeverity {
  if (usedPercent === undefined) {
    return 'normal';
  }
  if (usedPercent >= 90) {
    return 'critical';
  }
  if (usedPercent >= 75) {
    return 'warning';
  }
  return 'normal';
}

/** ゲージの目盛り数。ステータスバーの幅を取りすぎない範囲で増減が読める粒度。 */
export const USAGE_GAUGE_CELLS = 5;

/**
 * 使用率をブロック文字のゲージにする。
 *
 * 数字だけだと残りの少なさに気付きにくいので、形でも分かるようにする。
 * 目盛り数を固定し、埋まっている側と空いている側で同じ幅の文字（`▮` / `▯`）を使うため、
 * 使用率が変わってもゲージの幅は変わらない。
 *
 * 端は丸め切らない。0%でないのに全部空、100%でないのに全部埋まる、という誤読を避けるため、
 * 0%と100%以外は必ず1目盛り以上を埋め、1目盛り以上を空けて残す。
 */
export function formatUsageGauge(
  usedPercent: number | undefined,
  cells: number = USAGE_GAUGE_CELLS,
): string {
  if (usedPercent === undefined || !Number.isFinite(usedPercent) || cells <= 0) {
    return '';
  }
  const ratio = Math.min(1, Math.max(0, usedPercent / 100));
  let filled = Math.round(ratio * cells);
  if (ratio > 0 && filled === 0) {
    filled = 1;
  }
  if (ratio < 1 && filled === cells) {
    filled = cells - 1;
  }
  return '▮'.repeat(filled) + '▯'.repeat(cells - filled);
}
