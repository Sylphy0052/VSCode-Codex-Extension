import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type { McProvider, McWorkUnit, McWorkUnitUsage } from '../webview/missionControl/protocol';
import type { WorkHistoryRecord, WorkHistorySessionRecord } from './workHistory';

/**
 * 作業単位の集計（Mission Control 段階21。Issue #2177）。作業履歴（`readWorkHistory`の結果）を
 * Issue番号ごと、Issue番号の無いものはhandoffの連鎖ごとにまとめ、期間・セッション数・費用・
 * トークン・利用枠の消費の概算を出す。
 *
 * まとめ方:
 * - セッションはprovider＋threadIdで1つと数える（別のウィンドウで開き直しても同じ）
 * - セッションのIssue番号は、記録のうち最後に付いていたもの。数字として検証してから使う
 * - handoffの親子は同じ単位にまとめる。ただし別々のIssue番号の単位どうしはつながない（番号の
 *   無いセッションを挟んでも。1つの単位のIssue番号は高々1つ）
 * - 同じIssue番号のセッションは、handoffでつながっていなくても同じ単位にする
 *
 * 期間（`range`）を渡すと、範囲内の記録だけを数える。費用・トークンはセッションの累計値なので、
 * 範囲より前の記録の最大値を差し引いて範囲内の増分にする（範囲より前の記録も渡すこと）。
 *
 * 利用枠の消費の概算:
 * - provider・窓ごとに使用率の計測値を時刻順に並べ、隣り合う計測の間の増分を、その間に
 *   ターンを終えた同じproviderのセッションへ、ターンの回数の比で割り当てる
 * - 間にターンが無ければ、その間に記録のあったセッションへ等分する。どちらも無い増分は捨てる
 * - リセット（リセット時刻が先へ進んだ・前の窓のリセット時刻を過ぎた）をまたぐときは、後の
 *   計測値そのものを増分とする
 *
 * vscodeに依らない。後続の作業履歴カレンダー（Issue #2179）も、`range`で期間を指定して使う。
 */

/** Issue番号として受け付ける上限（GitHubの番号の桁を大きく超える値は捨てる）。 */
const MAX_ISSUE_NUMBER = 9_999_999;
const TITLE_MAX = 200;
const BRANCH_MAX = 200;
/** リセット時刻のゆれとして無視する幅（ms）。これを超えて先へ進んだら新しい窓とみなす。 */
const RESET_JITTER_MS = 5 * 60 * 1000;

/** 外部由来の値をIssue番号として検証する。正の安全な整数で上限以下のときだけ返す。 */
export function validIssueNumber(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_ISSUE_NUMBER
    ? value
    : undefined;
}

interface SessionAcc {
  key: string;
  provider: McProvider;
  threadId: string;
  issue: number | undefined;
  title: string | undefined;
  branch: string | undefined;
  /** タイトル・ブランチを最後に取った記録の時刻。 */
  titleAt: number;
  branchAt: number;
  firstAt: number;
  lastAt: number;
  costUsd: number | undefined;
  tokens: number | undefined;
  days: Set<string>;
}

function sessionKey(provider: string, threadId: string): string {
  return `${provider}:${threadId}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ローカル時刻の`YYYY-MM-DD`。 */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** 素集合（handoff・Issue番号でセッションをまとめる）。 */
class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let root = x;
    for (let next = this.parent.get(root); next !== undefined && next !== root;) {
      root = next;
      next = this.parent.get(root);
    }
    // 経路を縮める
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur) ?? root;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  /** 2つをまとめ、まとめた後のrootを返す。 */
  union(a: string, b: string): string {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent.set(rb, ra);
    }
    return ra;
  }
}

/** 集計する期間（ms）。`since`は含み、`until`は含まない。 */
export interface WorkUnitRange {
  since?: number | undefined;
  until?: number | undefined;
  /**
   * trueなら、`since`より前の最後の使用率の計測を範囲の最初の区間の始点に使う。区間は終点の計測が
   * 入る範囲のものとして数えるので、隣り合う範囲（カレンダーの日ごと。Issue #2179）に分けても、
   * 境目をまたぐ区間の消費を落とさず、二重にも数えない。既定（false）は範囲内の計測どうしだけ。
   */
  usageCarryIn?: boolean | undefined;
}

interface CumulativeBase {
  costUsd: number | undefined;
  tokens: number | undefined;
}

/** 範囲より前の記録から、セッションごとの累計値（費用・トークン）の最大値を取る。 */
function collectBaselines(
  records: readonly WorkHistoryRecord[],
  since: number | undefined,
): Map<string, CumulativeBase> {
  const bases = new Map<string, CumulativeBase>();
  if (since === undefined) return bases;
  for (const record of records) {
    if (record.kind !== 'session' || record.at >= since) continue;
    const key = sessionKey(record.provider, record.threadId);
    const base = bases.get(key) ?? { costUsd: undefined, tokens: undefined };
    base.costUsd = maxDefined(base.costUsd, record.costUsd);
    base.tokens = maxDefined(base.tokens, record.tokens);
    bases.set(key, base);
  }
  return bases;
}

/** 範囲内の累計値の最大値から、範囲より前の最大値を引いた増分。 */
function increment(max: number | undefined, base: number | undefined): number | undefined {
  return max === undefined ? undefined : Math.max(0, max - (base ?? 0));
}

function collectSessions(
  records: readonly WorkHistoryRecord[],
  baselines: ReadonlyMap<string, CumulativeBase>,
): Map<string, SessionAcc> {
  const sessions = new Map<string, SessionAcc>();
  const touch = (provider: McProvider, threadId: string, at: number): SessionAcc => {
    const key = sessionKey(provider, threadId);
    let acc = sessions.get(key);
    if (acc === undefined) {
      acc = {
        key,
        provider,
        threadId,
        issue: undefined,
        title: undefined,
        branch: undefined,
        titleAt: Number.NEGATIVE_INFINITY,
        branchAt: Number.NEGATIVE_INFINITY,
        firstAt: at,
        lastAt: at,
        costUsd: undefined,
        tokens: undefined,
        days: new Set(),
      };
      sessions.set(key, acc);
    }
    return acc;
  };
  for (const record of records) {
    if (record.kind !== 'session') continue;
    const acc = touch(record.provider, record.threadId, record.at);
    acc.firstAt = Math.min(acc.firstAt, record.at);
    acc.lastAt = Math.max(acc.lastAt, record.at);
    acc.days.add(localDay(record.at));
    // 記録は時刻の古い順に来るので、後の値で上書きすれば最後の値が残る
    const issue = validIssueNumber(record.issue);
    if (issue !== undefined) acc.issue = issue;
    if (record.title !== undefined) {
      acc.title = record.title;
      acc.titleAt = record.at;
    }
    if (record.branch !== undefined) {
      acc.branch = record.branch;
      acc.branchAt = record.at;
    }
    acc.costUsd = maxDefined(acc.costUsd, record.costUsd);
    acc.tokens = maxDefined(acc.tokens, record.tokens);
  }
  for (const acc of sessions.values()) {
    const base = baselines.get(acc.key);
    acc.costUsd = increment(acc.costUsd, base?.costUsd);
    acc.tokens = increment(acc.tokens, base?.tokens);
  }
  // handoffの子でも、範囲の中に子自身の記録が無ければ数えない（数えるのは記録のあるセッションだけ）
  return sessions;
}

function groupSessions(
  records: readonly WorkHistoryRecord[],
  sessions: ReadonlyMap<string, SessionAcc>,
): Map<string, SessionAcc[]> {
  const uf = new UnionFind();
  for (const key of sessions.keys()) uf.find(key);
  // 単位のroot → その単位のIssue番号。1つの単位に別々のIssue番号を入れない
  const issueOfRoot = new Map<string, number>();
  const byIssue = new Map<number, string>();
  for (const acc of sessions.values()) {
    if (acc.issue === undefined) continue;
    const first = byIssue.get(acc.issue);
    if (first === undefined) {
      byIssue.set(acc.issue, acc.key);
      issueOfRoot.set(acc.key, acc.issue);
    } else {
      uf.union(first, acc.key);
    }
  }
  // handoffは時刻順につなぐ。番号の無いセッションを挟んでも、別々のIssue番号の単位どうしは
  // つながない（番号の無い子は先につながった親の単位に入る）
  for (const record of records) {
    if (record.kind !== 'session' || record.event !== 'handoff') continue;
    if (record.childThreadId === undefined) continue;
    const parent = sessions.get(sessionKey(record.provider, record.threadId));
    const child = sessions.get(sessionKey(record.provider, record.childThreadId));
    if (parent === undefined || child === undefined) continue;
    const parentIssue = issueOfRoot.get(uf.find(parent.key));
    const childIssue = issueOfRoot.get(uf.find(child.key));
    if (parentIssue !== undefined && childIssue !== undefined && parentIssue !== childIssue) {
      continue;
    }
    const root = uf.union(parent.key, child.key);
    const issue = parentIssue ?? childIssue;
    if (issue !== undefined) issueOfRoot.set(root, issue);
  }
  const groups = new Map<string, SessionAcc[]>();
  for (const acc of sessions.values()) {
    const root = uf.find(acc.key);
    const list = groups.get(root);
    if (list === undefined) {
      groups.set(root, [acc]);
    } else {
      list.push(acc);
    }
  }
  return groups;
}

interface UsageSample {
  t: number;
  used: number;
  resetsAt: number | undefined;
  /** 範囲内の記録の計測か。範囲より前の計測は区間の始点にだけ使う（`usageCarryIn`）。 */
  inRange: boolean;
}

/** 隣り合う計測の間の消費（%ポイント）。リセットをまたぐときは後の計測値そのもの。 */
function usageDelta(prev: UsageSample, cur: UsageSample): number {
  const crossedReset =
    (prev.resetsAt !== undefined &&
      cur.resetsAt !== undefined &&
      cur.resetsAt - prev.resetsAt > RESET_JITTER_MS) ||
    (prev.resetsAt !== undefined && prev.resetsAt <= cur.t);
  return Math.max(0, crossedReset ? cur.used : cur.used - prev.used);
}

function collectUsageSamples(
  records: readonly WorkHistoryRecord[],
  since: number | undefined,
): Map<string, { provider: McProvider; label: string; samples: UsageSample[] }> {
  const series = new Map<string, { provider: McProvider; label: string; samples: UsageSample[] }>();
  for (const record of records) {
    if (record.kind !== 'usage') continue;
    for (const window of record.windows) {
      if (window.usedPercent === undefined) continue;
      const key = `${record.provider}\u0000${window.label}`;
      let entry = series.get(key);
      if (entry === undefined) {
        entry = { provider: record.provider, label: window.label, samples: [] };
        series.set(key, entry);
      }
      entry.samples.push({
        t: window.sampledAt ?? record.capturedAt ?? record.at,
        used: window.usedPercent,
        resetsAt: window.resetsAt,
        inRange: since === undefined || record.at >= since,
      });
    }
  }
  for (const entry of series.values()) {
    entry.samples.sort((a, b) => a.t - b.t);
    // 同じ計測を複数のウィンドウ・通知が書くので、同じ時刻の計測は1つにする
    entry.samples = entry.samples.filter((s, i, all) => i === 0 || all[i - 1]?.t !== s.t);
  }
  return series;
}

/** 単位ごとの利用枠の消費を割り当てる。戻り値は単位のroot → (provider・窓 → %ポイント)。 */
function attributeUsage(
  records: readonly WorkHistoryRecord[],
  usageRecords: readonly WorkHistoryRecord[],
  since: number | undefined,
  unitOf: (provider: McProvider, threadId: string) => string | undefined,
): Map<string, Map<string, McWorkUnitUsage>> {
  const sessionRecords = records.filter((r): r is WorkHistorySessionRecord => r.kind === 'session');
  const result = new Map<string, Map<string, McWorkUnitUsage>>();
  const add = (unit: string, provider: McProvider, label: string, percent: number): void => {
    let byWindow = result.get(unit);
    if (byWindow === undefined) {
      byWindow = new Map();
      result.set(unit, byWindow);
    }
    const key = `${provider}\u0000${label}`;
    const current = byWindow.get(key);
    if (current === undefined) {
      byWindow.set(key, { provider, label, percent });
    } else {
      current.percent += percent;
    }
  };
  for (const { provider, label, samples } of collectUsageSamples(usageRecords, since).values()) {
    // 時刻順のセッション記録を、計測の区間ごとに1回だけ走査する
    const own = sessionRecords.filter((r) => r.provider === provider);
    let cursor = 0;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      // 終点が範囲より前の区間は前の範囲の分（`usageCarryIn`のときだけ来る）
      if (prev === undefined || cur === undefined || !cur.inRange) continue;
      while (cursor < own.length && (own[cursor]?.at ?? Infinity) <= prev.t) cursor++;
      const turns = new Map<string, number>();
      const active = new Set<string>();
      for (let j = cursor; j < own.length; j++) {
        const r = own[j];
        if (r === undefined || r.at > cur.t) break;
        const unit = unitOf(r.provider, r.threadId);
        if (unit === undefined) continue;
        active.add(unit);
        if (r.event === 'turn') turns.set(unit, (turns.get(unit) ?? 0) + 1);
      }
      const delta = usageDelta(prev, cur);
      if (delta <= 0) continue;
      if (turns.size > 0) {
        const total = [...turns.values()].reduce((sum, n) => sum + n, 0);
        for (const [unit, n] of turns) add(unit, provider, label, (delta * n) / total);
      } else if (active.size > 0) {
        for (const unit of active) add(unit, provider, label, delta / active.size);
      }
    }
  }
  return result;
}

/** 単位の中で最後に記録されたタイトル・ブランチ。どのセッションにも無ければ`undefined`。 */
function latestOf(sessions: readonly SessionAcc[], field: 'title' | 'branch'): string | undefined {
  const atKey = field === 'title' ? 'titleAt' : 'branchAt';
  let best: SessionAcc | undefined;
  for (const s of sessions) {
    if (s[field] !== undefined && (best === undefined || s[atKey] > best[atKey])) best = s;
  }
  return best?.[field];
}

/** 単位の中で最も多くのセッションが持つIssue番号。同数なら小さい番号。 */
function primaryIssue(sessions: readonly SessionAcc[]): number | undefined {
  const counts = new Map<number, number>();
  for (const s of sessions) {
    if (s.issue !== undefined) counts.set(s.issue, (counts.get(s.issue) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [issue, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && issue < best)) {
      best = issue;
      bestCount = count;
    }
  }
  return best;
}

function sumDefined(values: ReadonlyArray<number | undefined>): number | undefined {
  let total: number | undefined;
  for (const v of values) {
    if (v !== undefined) total = (total ?? 0) + v;
  }
  return total;
}

/**
 * 作業履歴を作業単位にまとめる。並び順は最後の記録の新しい順（並べ替えは`sortWorkUnits`）。
 * 文字列は表示できる形（1行・長さ制限）へ直してから載せる。`range`を渡すと範囲内の記録だけを
 * 数え、範囲より前の記録は費用・トークンの差し引きにだけ使う。
 */
export function aggregateWorkUnits(
  records: readonly WorkHistoryRecord[],
  range: WorkUnitRange = {},
): McWorkUnit[] {
  const { since, until } = range;
  const all = [...records].sort((a, b) => a.at - b.at);
  const ordered = all.filter(
    (r) => (since === undefined || r.at >= since) && (until === undefined || r.at < until),
  );
  const sessions = collectSessions(ordered, collectBaselines(all, since));
  const groups = groupSessions(ordered, sessions);
  const rootOf = new Map<string, string>();
  for (const [root, members] of groups) {
    for (const m of members) rootOf.set(m.key, root);
  }
  // 境目をまたぐ区間を数えるときは、範囲より前の計測も区間の始点として渡す（範囲より後は渡さない）
  const usageRecords =
    range.usageCarryIn === true && since !== undefined
      ? all.filter((r) => r.kind === 'usage' && (until === undefined || r.at < until))
      : ordered;
  const usage = attributeUsage(ordered, usageRecords, since, (provider, threadId) =>
    rootOf.get(sessionKey(provider, threadId)),
  );
  const units: McWorkUnit[] = [];
  for (const [root, members] of groups) {
    const byTime = [...members].sort((a, b) => a.firstAt - b.firstAt);
    const first = byTime[0];
    if (first === undefined) continue;
    const latestTitle = latestOf(members, 'title');
    const latestBranch = latestOf(members, 'branch');
    const issue = primaryIssue(members);
    const issues = [
      ...new Set(members.flatMap((m) => (m.issue === undefined ? [] : [m.issue]))),
    ].sort((a, b) => a - b);
    const unitUsage = [...(usage.get(root)?.values() ?? [])]
      .map((u) => ({ ...u, label: sanitizeInlineText(u.label, 40) }))
      .sort((a, b) => b.percent - a.percent);
    const days = new Set<string>();
    for (const m of members) for (const d of m.days) days.add(d);
    const title = latestTitle === undefined ? '' : sanitizeInlineText(latestTitle, TITLE_MAX);
    const branch =
      latestBranch === undefined ? undefined : sanitizeInlineText(latestBranch, BRANCH_MAX);
    const unit: McWorkUnit = {
      key:
        issue !== undefined
          ? `issue:${String(issue)}`
          : `chain:${first.provider}:${sanitizeInlineText(first.threadId, 200)}`,
      issue,
      issues,
      title,
      branch,
      providers: [...new Set(members.map((m) => m.provider))].sort(),
      firstAt: Math.min(...members.map((m) => m.firstAt)),
      lastAt: Math.max(...members.map((m) => m.lastAt)),
      days: [...days].sort(),
      sessionCount: members.length,
      costUsd: sumDefined(members.map((m) => m.costUsd)),
      tokens: sumDefined(members.map((m) => m.tokens)),
      usage: unitUsage,
      usageScore: unitUsage.reduce((sum, u) => sum + u.percent, 0),
    };
    units.push(unit);
  }
  return units.sort((a, b) => b.lastAt - a.lastAt);
}
