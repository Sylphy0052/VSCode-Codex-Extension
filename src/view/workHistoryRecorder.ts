import type { McUsage, McUsageSource } from '../webview/missionControl/protocol';
import type { SharedSession } from './sessionHub';
import {
  retentionCutoff,
  type WorkHistoryProvider,
  type WorkHistoryRecord,
  type WorkHistorySessionRecord,
  type WorkHistoryStore,
  type WorkHistoryUsageRecord,
} from './workHistory';

/**
 * 作業履歴の記録係（Issue #2175）。自ウィンドウのセッション一覧を見るたびに前回との差分から
 * イベントを作り、利用枠は値が届くたびに1行足す。vscodeに依らない部分。
 *
 * 他ウィンドウのセッションは記録しない（そのウィンドウ自身が記録する）。同じ会話を2回数えない。
 */

/** 同じ値の利用枠が続けて届いたとき、この間隔より短ければ書かない（同じ通知の重複を畳む）。 */
export const USAGE_DUPLICATE_WINDOW_MS = 60_000;
/**
 * 一覧の変化の通知が無くても差分を取りに行く間隔。目的の要約・skillの追加・費用の更新は
 * 状態の変化の通知に乗らないことがあるため。
 */
export const WORK_HISTORY_OBSERVE_INTERVAL_MS = 60_000;
/** 閉じた会話のskillの境目を覚えておく件数の上限（古い方から捨てる）。 */
const MAX_SKILL_WATERMARKS = 1000;
/** 古い記録の削除を試す間隔。 */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const ISSUE_FROM_BRANCH = /^[a-z]+\/(\d{1,7})\//i;
const ISSUE_FROM_TITLE = /#(\d{1,7})(?!\d)/;

/** ブランチ名（`<type>/<IID>/<slug>`）か、無ければタイトルの`#123`からIssue番号を取る。 */
export function extractIssueNumber(
  branch: string | undefined,
  title: string | undefined,
): number | undefined {
  const fromBranch = branch === undefined ? null : ISSUE_FROM_BRANCH.exec(branch);
  const fromTitle =
    fromBranch === null && title !== undefined ? ISSUE_FROM_TITLE.exec(title) : null;
  const digits = fromBranch?.[1] ?? fromTitle?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const n = Number(digits);
  return n > 0 ? n : undefined;
}

interface SessionMemo {
  provider: WorkHistoryProvider;
  threadId: string;
  title: string;
  purpose: string | undefined;
  branch: string | undefined;
  issue: number | undefined;
  cwd: string | undefined;
  model: string | undefined;
  costUsd: number | undefined;
  tokens: number | undefined;
  running: boolean;
  /** 記録済みのskillの最新の起動時刻（ms）。 */
  lastSkillAt: number;
}

function memoKey(provider: string, threadId: string): string {
  return `${provider}:${threadId}`;
}

function toMemo(session: SharedSession): SessionMemo {
  const skills = session.skills ?? [];
  return {
    provider: session.provider,
    threadId: session.threadId,
    title: session.title,
    purpose: session.purpose,
    branch: session.branch,
    issue: extractIssueNumber(session.branch, session.title),
    cwd: session.cwd,
    model: session.model,
    costUsd: session.costUsd,
    tokens: session.tokens,
    running: session.activity !== 'idle',
    lastSkillAt: skills.reduce((max, skill) => Math.max(max, skill.at), Number.NEGATIVE_INFINITY),
  };
}

export interface WorkHistoryRecorderDeps {
  store: Pick<WorkHistoryStore, 'append' | 'appendSync' | 'prune'>;
  windowId: string;
  /** 設定`agent.missionControl.historyRetentionDays`（読むたびに最新の値）。 */
  retentionDays(): number;
  now?: () => number;
}

export class WorkHistoryRecorder {
  private readonly sessions = new Map<string, SessionMemo>();
  private readonly lastUsage = new Map<WorkHistoryProvider, { at: number; json: string }>();
  /** 閉じた会話の、記録済みのskillの境目（開き直したときに同じskillを二度書かないため）。 */
  private readonly skillWatermarks = new Map<string, number>();
  private lastPruneAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  /** 記録係を始めた時刻（ms）。これより前に起動したskillは、復元した会話の過去の分として書かない。 */
  private readonly startedAt: number;

  constructor(private readonly deps: WorkHistoryRecorderDeps) {
    this.startedAt = this.now();
  }

  private rememberSkillWatermark(key: string, at: number): void {
    if (!Number.isFinite(at)) {
      return;
    }
    this.skillWatermarks.delete(key);
    this.skillWatermarks.set(key, at);
    if (this.skillWatermarks.size > MAX_SKILL_WATERMARKS) {
      const oldest = this.skillWatermarks.keys().next().value;
      if (oldest !== undefined) {
        this.skillWatermarks.delete(oldest);
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private base(
    memo: SessionMemo,
    event: WorkHistorySessionRecord['event'],
    at: number,
  ): WorkHistorySessionRecord {
    const record: WorkHistorySessionRecord = {
      v: 1,
      kind: 'session',
      at,
      event,
      windowId: this.deps.windowId,
      provider: memo.provider,
      threadId: memo.threadId,
      title: memo.title,
      purpose: memo.purpose,
      branch: memo.branch,
      issue: memo.issue,
      cwd: memo.cwd,
      model: memo.model,
      costUsd: memo.costUsd,
      tokens: memo.tokens,
    };
    return record;
  }

  /**
   * 自ウィンドウのセッション一覧を渡す。前回との差分からイベントを作って追記する。
   * 返り値は追記した記録（テスト用）。
   */
  observeSessions(current: readonly SharedSession[]): WorkHistoryRecord[] {
    if (this.stopped) {
      return [];
    }
    const at = this.now();
    const records: WorkHistoryRecord[] = [];
    const seen = new Set<string>();
    for (const session of current) {
      const key = memoKey(session.provider, session.threadId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const next = toMemo(session);
      const prev = this.sessions.get(key);
      this.sessions.set(key, next);
      // 記録済みのskillの境目。開き直した会話・Reload後に復元した会話は、会話記録から過去の
      // skillも起動時刻付きで戻ってくるので、閉じたときの境目か、記録係を始めた時刻より前は書かない
      const watermark = prev?.lastSkillAt ?? this.skillWatermarks.get(key) ?? this.startedAt - 1;
      if (prev === undefined) {
        records.push(this.base(next, 'start', at));
      } else if (
        prev.title !== next.title ||
        prev.purpose !== next.purpose ||
        prev.branch !== next.branch ||
        prev.issue !== next.issue
      ) {
        records.push(this.base(next, 'update', at));
      }
      for (const skill of session.skills ?? []) {
        if (skill.at > watermark) {
          records.push({ ...this.base(next, 'skill', skill.at), skill: skill.name });
        }
      }
      if (next.lastSkillAt < watermark) {
        // skillの一覧が上限で切られて古い方が落ちても、記録済みの時刻は戻さない
        next.lastSkillAt = watermark;
      }
      if (prev !== undefined && prev.running && !next.running) {
        records.push(this.base(next, 'turn', at));
      }
    }
    for (const [key, memo] of this.sessions) {
      if (!seen.has(key)) {
        this.sessions.delete(key);
        this.rememberSkillWatermark(key, memo.lastSkillAt);
        records.push({ ...this.base(memo, 'end', at), reason: 'closed' });
      }
    }
    this.write(records, at);
    return records;
  }

  /**
   * 引き継いだ（親→子）。子の`start`は次の`observeSessions`で出る。引き継ぎ先のmodel/effortが
   * ズレて作り直したときは、同じ親でもう1行出る。同じ親の`handoff`が複数あれば後の行が正で、
   * 先の子は作り直しで閉じられる（その子の`end`が出る）。
   */
  recordHandoff(
    provider: WorkHistoryProvider,
    parentThreadId: string,
    childThreadId: string,
  ): WorkHistoryRecord[] {
    if (this.stopped) {
      return [];
    }
    const at = this.now();
    const memo = this.sessions.get(memoKey(provider, parentThreadId)) ?? {
      provider,
      threadId: parentThreadId,
      title: '',
      purpose: undefined,
      branch: undefined,
      issue: undefined,
      cwd: undefined,
      model: undefined,
      costUsd: undefined,
      tokens: undefined,
      running: false,
      lastSkillAt: Number.NEGATIVE_INFINITY,
    };
    const records: WorkHistoryRecord[] = [{ ...this.base(memo, 'handoff', at), childThreadId }];
    this.write(records, at);
    return records;
  }

  /**
   * 利用枠の値が届いたら渡す（`buildMcUsage`の結果）。取得元ごとに1行足す。同じ値が
   * `USAGE_DUPLICATE_WINDOW_MS`より短い間隔で続いたら書かない。
   */
  observeUsage(usage: McUsage): WorkHistoryRecord[] {
    if (this.stopped) {
      return [];
    }
    const at = this.now();
    const records: WorkHistoryRecord[] = [];
    for (const provider of ['codex', 'claude'] as const) {
      const source = usage[provider];
      if (source === undefined) {
        continue;
      }
      const record = this.usageRecord(provider, source, at);
      const json = JSON.stringify({ ...record, at: 0 });
      const last = this.lastUsage.get(provider);
      if (last !== undefined && last.json === json && at - last.at < USAGE_DUPLICATE_WINDOW_MS) {
        continue;
      }
      this.lastUsage.set(provider, { at, json });
      records.push(record);
    }
    this.write(records, at);
    return records;
  }

  private usageRecord(
    provider: WorkHistoryProvider,
    source: McUsageSource,
    at: number,
  ): WorkHistoryUsageRecord {
    return {
      v: 1,
      kind: 'usage',
      at,
      windowId: this.deps.windowId,
      provider,
      // `stale`は表示の時点で決まる値なので残さない
      windows: source.windows.map((w) => ({
        label: w.label,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
        limited: w.limited,
      })),
      capturedAt: source.capturedAt,
      plan: source.plan,
    };
  }

  /**
   * ウィンドウを閉じる・Reloadするときに呼ぶ。開いていたセッションの`end`（`shutdown`）を
   * 同期で書く。以降の記録はしない。直前に積んだ非同期の追記（`turn`・`usage`など）は待たない
   * ので、拡張の停止に間に合わなければ落ちる（`end`に費用・トークンを載せて補う）。
   */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const at = this.now();
    const records: WorkHistoryRecord[] = [...this.sessions.values()].map((memo) => ({
      ...this.base(memo, 'end', at),
      reason: 'shutdown' as const,
    }));
    this.sessions.clear();
    this.deps.store.appendSync(records);
  }

  /** 保持期間を過ぎた記録を消す。`force`でなければ`PRUNE_INTERVAL_MS`に1回まで。 */
  pruneIfDue(force = false): Promise<number> | undefined {
    const at = this.now();
    if (!force && at - this.lastPruneAt < PRUNE_INTERVAL_MS) {
      return undefined;
    }
    this.lastPruneAt = at;
    return this.deps.store.prune(at, this.deps.retentionDays());
  }

  /** 保持の境目（ms）。読み手は`readWorkHistory`の`since`へ渡す。 */
  cutoff(): number {
    return retentionCutoff(this.now(), this.deps.retentionDays());
  }

  private write(records: WorkHistoryRecord[], at: number): void {
    if (records.length > 0) {
      void this.deps.store.append(records);
    }
    // 新しい記録が無くても（60秒ごとの見回りだけでも）削除の期限は見る。動きの無いウィンドウで
    // 古い記録が残り続けないようにする
    if (at - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      void this.pruneIfDue();
    }
  }
}

/** 引き継ぎの親子を記録係へ渡す口。チャットの画面（Codex・Claude）が引き継げた後に呼ぶ。 */
let handoffSink:
  | ((provider: WorkHistoryProvider, parentThreadId: string, childThreadId: string) => void)
  | undefined;

export function setWorkHistoryHandoffSink(sink: typeof handoffSink): void {
  handoffSink = sink;
}

export function reportWorkHistoryHandoff(
  provider: WorkHistoryProvider,
  parentThreadId: string,
  childThreadId: string,
): void {
  try {
    handoffSink?.(provider, parentThreadId, childThreadId);
  } catch {
    // 記録の失敗で引き継ぎを止めない（書き込みの失敗は記録係がwarnへ出している）
  }
}
