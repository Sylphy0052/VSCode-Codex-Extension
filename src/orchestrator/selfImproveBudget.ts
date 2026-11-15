import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * 自律改善（この拡張自身を直すPR）の全体予算（Issue #2084）。
 *
 * - 評価中（merge済みで判定が出ていない）の自己改善は全体で同時に1件まで
 * - 起票は直近7日にK件まで
 * - 週次使用率が閾値以上なら、振り返りと自己改善の起票・着手を止める
 * - 自己改善のrunは振り返りで改善案を出さない
 *
 * 判断は純関数、件数の記録は排他ロック付きのJSONファイルで持つ。別ウィンドウが同時に
 * 動いても、ロックを取った側だけが読み・判断・書きを1回で行うので件数は破れない。
 */

/** 週K件の既定値。1日1件弱に収め、評価待ちが1件までという制約と合わせて連鎖を抑える。 */
export const DEFAULT_MAX_PER_WEEK = 3;
/** 週次使用率の既定の閾値（%）。自動切り替えの95%より手前で止める。 */
export const DEFAULT_WEEKLY_USAGE_THRESHOLD_PCT = 80;

const WEEK_MS = 7 * 24 * 60 * 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export interface SelfImproveBudgetConfig {
  readonly maxPerWeek: number;
  readonly weeklyUsageThresholdPct: number;
}

export interface SelfImproveEntry {
  readonly issueNumber: number;
  /** 起票した時刻（ms）。 */
  readonly filedAt: number;
  /** merge済みになった時刻。未merge中は無い。 */
  readonly mergedAt?: number;
  /** 判定（維持・戻し）が出た時刻。無ければ評価中。 */
  readonly evaluatedAt?: number;
}

export interface SelfImproveLedger {
  readonly entries: readonly SelfImproveEntry[];
}

export type BudgetDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** 設定値を検証して返す。不正な値は既定値へ戻す。 */
export function normalizeConfig(raw: {
  maxPerWeek?: unknown;
  weeklyUsageThresholdPct?: unknown;
}): SelfImproveBudgetConfig {
  const k = raw.maxPerWeek;
  const t = raw.weeklyUsageThresholdPct;
  return {
    maxPerWeek: typeof k === 'number' && Number.isInteger(k) && k >= 0 ? k : DEFAULT_MAX_PER_WEEK,
    weeklyUsageThresholdPct:
      typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= 100
        ? t
        : DEFAULT_WEEKLY_USAGE_THRESHOLD_PCT,
  };
}

/** 評価中（merge済みで判定が無い）の改善。 */
export function evaluatingEntries(ledger: SelfImproveLedger): SelfImproveEntry[] {
  return ledger.entries.filter((e) => e.mergedAt !== undefined && e.evaluatedAt === undefined);
}

/** 週次使用率が閾値以上か。使用率が不明（undefined）なら止めない。 */
export function decideUsage(
  weeklyUsagePct: number | undefined,
  config: SelfImproveBudgetConfig,
): BudgetDecision {
  if (weeklyUsagePct !== undefined && weeklyUsagePct >= config.weeklyUsageThresholdPct) {
    return {
      allowed: false,
      reason: `週次使用率${weeklyUsagePct}%が閾値${config.weeklyUsageThresholdPct}%以上のため、振り返りと自己改善を止める`,
    };
  }
  return { allowed: true };
}

/** 振り返りを行ってよいか。止めるときの reason は記録に残す。 */
export function decideRetrospective(
  weeklyUsagePct: number | undefined,
  config: SelfImproveBudgetConfig,
  isSelfImproveRun: boolean,
): BudgetDecision {
  if (isSelfImproveRun) {
    return { allowed: false, reason: '自己改善のrunは振り返りで改善案を出さない' };
  }
  return decideUsage(weeklyUsagePct, config);
}

/** 自己改善に着手してよいか。評価中が1件でもあれば不可。 */
export function decideStart(
  ledger: SelfImproveLedger,
  weeklyUsagePct: number | undefined,
  config: SelfImproveBudgetConfig,
): BudgetDecision {
  const usage = decideUsage(weeklyUsagePct, config);
  if (!usage.allowed) {
    return usage;
  }
  const evaluating = evaluatingEntries(ledger);
  if (evaluating.length > 0) {
    return {
      allowed: false,
      reason: `評価中の自己改善（#${evaluating.map((e) => e.issueNumber).join(', #')}）があるため着手しない`,
    };
  }
  return { allowed: true };
}

/** 自己改善を起票してよいか。直近7日の起票数がK件以上なら不可。 */
export function decideFile(
  ledger: SelfImproveLedger,
  weeklyUsagePct: number | undefined,
  config: SelfImproveBudgetConfig,
  nowMs: number,
): BudgetDecision {
  const usage = decideUsage(weeklyUsagePct, config);
  if (!usage.allowed) {
    return usage;
  }
  const recent = ledger.entries.filter((e) => nowMs - e.filedAt < WEEK_MS).length;
  if (recent >= config.maxPerWeek) {
    return {
      allowed: false,
      reason: `直近7日の自己改善の起票が${recent}件で、上限${config.maxPerWeek}件に達している`,
    };
  }
  return { allowed: true };
}

function parseLedger(text: string): SelfImproveLedger {
  try {
    const raw: unknown = JSON.parse(text);
    const list = (raw as { entries?: unknown }).entries;
    if (!Array.isArray(list)) {
      return { entries: [] };
    }
    const entries: SelfImproveEntry[] = [];
    for (const item of list) {
      const e = item as Partial<Record<keyof SelfImproveEntry, unknown>>;
      if (typeof e.issueNumber !== 'number' || typeof e.filedAt !== 'number') {
        continue;
      }
      entries.push({
        issueNumber: e.issueNumber,
        filedAt: e.filedAt,
        ...(typeof e.mergedAt === 'number' ? { mergedAt: e.mergedAt } : {}),
        ...(typeof e.evaluatedAt === 'number' ? { evaluatedAt: e.evaluatedAt } : {}),
      });
    }
    return { entries };
  } catch {
    return { entries: [] };
  }
}

/**
 * ledgerファイルの読み書き。変更は {@link SelfImproveBudgetStore.update} 経由だけで、
 * `<file>.lock` を排他作成して直列化する（別ウィンドウ・別プロセスにも効く）。
 */
export class SelfImproveBudgetStore {
  constructor(private readonly file: string) {}

  async read(): Promise<SelfImproveLedger> {
    try {
      return parseLedger(await fs.readFile(this.file, 'utf8'));
    } catch {
      return { entries: [] };
    }
  }

  /** ロックを取り、現在のledgerから `fn` で次のledgerと結果を決めて書く。 */
  async update<T>(
    fn: (ledger: SelfImproveLedger) => { ledger: SelfImproveLedger; result: T },
  ): Promise<T> {
    const lock = `${this.file}.lock`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await acquire(lock);
    try {
      const { ledger, result } = fn(await this.read());
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(ledger), 'utf8');
      await fs.rename(tmp, this.file);
      return result;
    } finally {
      await fs.rm(lock, { force: true });
    }
  }

  /** 起票してよければ数えて記録する。判断と記録を1回のロックで行う。 */
  tryFile(
    issueNumber: number,
    weeklyUsagePct: number | undefined,
    config: SelfImproveBudgetConfig,
    nowMs: number,
  ): Promise<BudgetDecision> {
    return this.update<BudgetDecision>((ledger) => {
      const decision = decideFile(ledger, weeklyUsagePct, config, nowMs);
      return decision.allowed
        ? {
            ledger: { entries: [...ledger.entries, { issueNumber, filedAt: nowMs }] },
            result: decision,
          }
        : { ledger, result: decision };
    });
  }

  markMerged(issueNumber: number, nowMs: number): Promise<void> {
    return this.mark(issueNumber, { mergedAt: nowMs });
  }

  markEvaluated(issueNumber: number, nowMs: number): Promise<void> {
    return this.mark(issueNumber, { evaluatedAt: nowMs });
  }

  private mark(issueNumber: number, patch: Partial<SelfImproveEntry>): Promise<void> {
    return this.update((ledger) => ({
      ledger: {
        entries: ledger.entries.map((e) =>
          e.issueNumber === issueNumber ? { ...e, ...patch } : e,
        ),
      },
      result: undefined,
    }));
  }
}

async function acquire(lock: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    try {
      const st = await fs.stat(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`自己改善の予算ledgerのロックを取れない: ${lock}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
