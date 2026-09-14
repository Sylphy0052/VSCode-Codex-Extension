export interface UsageSnapshot {
  /** この値がAPI応答から得られた時刻（イベントのtimestamp）。 */
  capturedAt: string | undefined;
  /** 最も逼迫した窓の使用率（`summarizeRateLimitWindows`）。 */
  usedPercent: number | undefined;
  /** 制限ウィンドウの長さ（分）。10080なら週次。 */
  windowMinutes: number | undefined;
  /** 制限がリセットされる時刻（epoch秒）。上限に達した窓があればそのうち最も遅いもの。 */
  resetsAt: number | undefined;
  /** 制限枠ごとの窓。上の3つはここから出した代表値（issue #1212）。 */
  windows: RateLimitWindowInfo[];
  planType: string | undefined;
  creditsBalance: string | undefined;
  hasCredits: boolean | undefined;
  totalTokens: number | undefined;
  contextWindow: number | undefined;
}

/** 制限枠の中の窓の区別。CLIの型（`RateLimitSnapshot`）の `primary` / `secondary` に対応する。 */
export type RateLimitWindowSlot = 'primary' | 'secondary';

/**
 * 制限枠（`limitId`）の1つの窓。
 *
 * Codexの制限は枠ごとに短い窓（primary）と長い窓（secondary）を持ち、片方だけが100%に
 * 達しうる（issue #1212）。primary / secondary の名前で週次・短時間を決め打ちせず、長さは
 * `windowMinutes` で読む。取得応答は複数の枠を `rateLimitsByLimitId` で返すため、枠の識別子も持つ。
 */
export interface RateLimitWindowInfo {
  /** 制限枠の識別子（`codex` など）。通知に無ければ undefined。 */
  limitId: string | undefined;
  slot: RateLimitWindowSlot;
  usedPercent: number;
  /** 窓の長さ（分）。 */
  windowMinutes: number | undefined;
  /** リセット時刻（epoch秒）。 */
  resetsAt: number | undefined;
}

/** 窓の一覧から出した、表示・判定用の代表値。 */
export interface RateLimitSummary {
  /** 最も逼迫した窓の使用率。窓が無ければ undefined。 */
  usedPercent: number | undefined;
  /** 代表にした窓の長さ（分）。 */
  windowMinutes: number | undefined;
  /** 上限に達した窓があればそのうち最も遅いリセット時刻。無ければ最も逼迫した窓のもの。 */
  resetsAt: number | undefined;
  /** 100%以上の窓があるか。窓が無ければ undefined。 */
  limited: boolean | undefined;
}

/**
 * 窓の一覧から代表値を出す。
 *
 * どの枠が会話に効いているかはCLIから判らない（`Model` に枠の情報が無い）ため、
 * 既知の枠のどれかが上限なら上限とみなす。再開の待ち時間は阻害している窓のうち最も遅い
 * リセット時刻を基準にする。早すぎる時刻で発火して1分ごとの再試行に入るより、別枠の上限で
 * 待ちが延びる方向へ倒す。
 */
export function summarizeRateLimitWindows(
  windows: readonly RateLimitWindowInfo[],
): RateLimitSummary {
  const first = windows[0];
  if (first === undefined) {
    return {
      usedPercent: undefined,
      windowMinutes: undefined,
      resetsAt: undefined,
      limited: undefined,
    };
  }
  let tightest = first;
  for (const window of windows) {
    if (window.usedPercent > tightest.usedPercent) {
      tightest = window;
    }
  }
  const exhausted = windows.filter((window) => window.usedPercent >= 100);
  if (exhausted.length === 0) {
    return {
      usedPercent: tightest.usedPercent,
      windowMinutes: tightest.windowMinutes,
      resetsAt: tightest.resetsAt,
      limited: false,
    };
  }
  // `exhausted` は空でないので `tightest` へは落ちない（型を通すための既定値）
  let blocking: RateLimitWindowInfo = exhausted[0] ?? tightest;
  for (const window of exhausted) {
    if (
      window.resetsAt !== undefined &&
      (blocking.resetsAt === undefined || window.resetsAt > blocking.resetsAt)
    ) {
      blocking = window;
    }
  }
  return {
    usedPercent: tightest.usedPercent,
    windowMinutes: blocking.windowMinutes,
    resetsAt: blocking.resetsAt,
    limited: true,
  };
}

/**
 * 疎な更新を既知の窓へ重ねる。
 *
 * `account/rateLimits/updated` は「直近の取得応答へマージせよ」と注記された疎な更新で、
 * 通知に無い窓は前の値を保つ。同じ枠・同じ窓は差し替えるが、差し替え側に長さ・リセット時刻が
 * 無ければ前の値を引き継ぐ（同じ窓のリセット時刻はリセットまで変わらない）。
 */
export function mergeRateLimitWindows(
  known: readonly RateLimitWindowInfo[],
  incoming: readonly RateLimitWindowInfo[],
): RateLimitWindowInfo[] {
  const keyOf = (window: RateLimitWindowInfo): string => `${window.limitId ?? ''}/${window.slot}`;
  const merged = new Map<string, RateLimitWindowInfo>();
  for (const window of known) {
    merged.set(keyOf(window), window);
  }
  for (const window of incoming) {
    const key = keyOf(window);
    const previous = merged.get(key);
    merged.set(key, {
      ...window,
      windowMinutes: window.windowMinutes ?? previous?.windowMinutes,
      resetsAt: window.resetsAt ?? previous?.resetsAt,
    });
  }
  return [...merged.values()];
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/** 窓の各値を読むキー。app-serverはcamelCase、ロールアウトの記録はsnake_case。 */
interface WindowKeys {
  limitId: string;
  usedPercent: string;
  windowMinutes: string;
  resetsAt: string;
}
const API_KEYS: WindowKeys = {
  limitId: 'limitId',
  usedPercent: 'usedPercent',
  windowMinutes: 'windowDurationMins',
  resetsAt: 'resetsAt',
};
const LOG_KEYS: WindowKeys = {
  limitId: 'limit_id',
  usedPercent: 'used_percent',
  windowMinutes: 'window_minutes',
  resetsAt: 'resets_at',
};

function readWindows(
  snapshot: Record<string, unknown> | undefined,
  keys: WindowKeys,
  fallbackLimitId?: string,
): RateLimitWindowInfo[] {
  if (snapshot === undefined) {
    return [];
  }
  // `RateLimitSnapshot.limitId` は null を取りうる。取得応答では枠がマップのキーで
  // 区別されるため、識別子が読めなければキーを使う（識別子無しが2枠並ぶと、窓を重ねる
  // ときに同じ枠と見なして互いを消してしまう）
  const limitId = str(snapshot[keys.limitId]) ?? fallbackLimitId;
  const windows: RateLimitWindowInfo[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const window = obj(snapshot[slot]);
    const usedPercent = num(window?.[keys.usedPercent]);
    if (window === undefined || usedPercent === undefined) {
      continue;
    }
    windows.push({
      limitId,
      slot,
      usedPercent,
      windowMinutes: num(window[keys.windowMinutes]),
      resetsAt: num(window[keys.resetsAt]),
    });
  }
  return windows;
}

/**
 * app-serverの `RateLimitSnapshot`（`account/rateLimits/updated` の `rateLimits`、
 * 取得応答の各枠）から窓を読む。使用率が数値でない窓は採らない。
 */
export function readRateLimitSnapshotWindows(snapshot: unknown): RateLimitWindowInfo[] {
  return readWindows(obj(snapshot), API_KEYS);
}

/**
 * `account/rateLimits/read` の応答を読む。
 *
 * ロールアウトの追記を待たずに現在値を問い合わせられる。ファイル由来のスナップショット
 * （`parseTokenCountLine`）と同じ形に整えて、表示側は区別せず扱えるようにする。
 */
export function readRateLimits(result: unknown, capturedAt: string): UsageSnapshot | undefined {
  const root = obj(result);
  const rateLimits = obj(root?.['rateLimits']);
  const windows = readResponseWindows(rateLimits, obj(root?.['rateLimitsByLimitId']));
  if (windows.length === 0) {
    return undefined;
  }

  const summary = summarizeRateLimitWindows(windows);
  const credits = obj(rateLimits?.['credits']);
  return {
    capturedAt,
    usedPercent: summary.usedPercent,
    windowMinutes: summary.windowMinutes,
    resetsAt: summary.resetsAt,
    windows,
    planType: str(rateLimits?.['planType']),
    creditsBalance: str(credits?.['balance']),
    hasCredits: typeof credits?.['hasCredits'] === 'boolean' ? credits['hasCredits'] : undefined,
    totalTokens: undefined,
    contextWindow: undefined,
  };
}

/**
 * 取得応答の窓を集める。
 *
 * `rateLimitsByLimitId` があれば枠ごとの全窓を採る。`rateLimits` は「後方互換の単一枠の見え方」で
 * 同じ枠を写しているため、枠の識別子が既にあれば重ねない。識別子の無い単一枠は、複数枠の
 * 応答ではどの枠か判らないので採らない。
 */
function readResponseWindows(
  rateLimits: Record<string, unknown> | undefined,
  byLimitId: Record<string, unknown> | undefined,
): RateLimitWindowInfo[] {
  const buckets = Object.entries(byLimitId ?? {}).map(([limitId, bucket]) =>
    readWindows(obj(bucket), API_KEYS, limitId),
  );
  const windows = buckets.flat();
  if (windows.length === 0) {
    return readWindows(rateLimits, API_KEYS);
  }
  const single = readWindows(rateLimits, API_KEYS);
  const known = new Set(windows.map((window) => window.limitId));
  return windows.concat(
    single.filter((window) => window.limitId !== undefined && !known.has(window.limitId)),
  );
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
  const windows = readWindows(limits, LOG_KEYS);
  const summary = summarizeRateLimitWindows(windows);
  const credits = obj(limits?.['credits']);
  const info = obj(payload['info']);
  const total = obj(info?.['total_token_usage']);

  return {
    capturedAt: str(root['timestamp']),
    usedPercent: summary.usedPercent,
    windowMinutes: summary.windowMinutes,
    resetsAt: summary.resetsAt,
    windows,
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

/**
 * 窓の見出し。長さ（`5時間` / `週次`）で呼び、primary / secondary の名前では呼ばない。
 * 枠が2つ以上あるときだけ識別子を添える。
 */
export function formatWindowLabel(
  window: RateLimitWindowInfo,
  all: readonly RateLimitWindowInfo[],
): string {
  const span =
    formatWindow(window.windowMinutes) || (window.slot === 'primary' ? '制限' : '長期の制限');
  const limitIds = new Set(all.map((w) => w.limitId));
  return limitIds.size > 1 && window.limitId !== undefined ? `${window.limitId} ${span}` : span;
}
