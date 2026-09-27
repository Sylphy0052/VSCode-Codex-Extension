import type { MementoLike } from '../util/memento';
import { isPlainObject, MementoRunStore } from './mementoRunStore';
import { MAX_ORCHESTRATOR_EVENTS_PER_RUN } from './orchestratorSession';
import type { RoadmapOrchestratorEvent } from './roadmapOrchestrator';
import type { RoadmapRun } from './roadmapRunState';
import { MAX_STORED_ROADMAP_RUNS } from './roadmapRunStore';
import { sanitizeInlineText } from './untrustedText';

/**
 * ロードマップ実行（Issue #1465）のイベントログ（Issue #1576）。
 *
 * Controllerが受け付けた出来事を、runごとに連番付きで追記する。Orchestratorの引き継ぎでは
 * 前の世代が最後に受け取った番号だけを渡し、新しい世代はそれより後の記録を`get_run_events`で
 * 取り直す（ログ全体は渡さない）。
 *
 * 保存先はrunの状態（`roadmapRunStore.ts`）と同じ`workspaceState`で、同じく平文のため
 * 応答本文や会話は入れない。1件は1行へ均した要約だけを持つ。
 */

export const ROADMAP_RUN_EVENTS_KEY = 'codex.roadmapRunEvents';

/**
 * 1runあたりに残す件数。Orchestratorへの通知の上限（Issue #1520）と同じ値にする。
 * 通知は上限で打ち切るが、ログは古いものから落とし、番号は振り直さない。
 */
export const MAX_ROADMAP_RUN_EVENTS = MAX_ORCHESTRATOR_EVENTS_PER_RUN;

export const ROADMAP_RUN_EVENT_MESSAGE_MAX_LENGTH = 300;

/** `get_run_events`が1回に返す件数。 */
export const ROADMAP_RUN_EVENTS_PAGE_SIZE = 50;

export type RoadmapRunEventKind =
  | RoadmapOrchestratorEvent['kind']
  /** Kanbanの出来事欄に出す通知（情報）。 */
  | 'notice'
  /** Kanbanの出来事欄に出す通知（警告）。専有権を取れなかった・取られた等。 */
  | 'warning'
  /** Orchestratorからの命令とその受理・拒否。 */
  | 'orchestratorCommand'
  | 'leaseAcquired';

export interface RoadmapRunEventInput {
  kind: RoadmapRunEventKind;
  message: string;
}

export interface RoadmapRunEventRecord extends RoadmapRunEventInput {
  /** runの中の連番。1から振り、古いものを落としても振り直さない。 */
  seq: number;
  /** ISO 8601。 */
  at: string;
}

export interface RoadmapRunEventLog {
  runId: string;
  /** runの開始時刻。runの状態と同じ順で並べて、同じrunを残すために持つ。 */
  startedAt: string;
  /** 次に振る番号。 */
  nextSeq: number;
  /** 上限を超えて落とした件数。 */
  dropped: number;
  /** 番号の昇順。 */
  events: RoadmapRunEventRecord[];
}

/** 出来事を追記する。落とすのは古い側で、番号は振り直さない。 */
export function appendRoadmapRunEvents(
  log: RoadmapRunEventLog | undefined,
  run: Pick<RoadmapRun, 'runId' | 'startedAt'>,
  inputs: readonly RoadmapRunEventInput[],
  now: Date,
): { log: RoadmapRunEventLog; records: RoadmapRunEventRecord[] } {
  const base: RoadmapRunEventLog = log ?? {
    runId: run.runId,
    startedAt: run.startedAt,
    nextSeq: 1,
    dropped: 0,
    events: [],
  };
  const at = now.toISOString();
  const records = inputs.map((input, i) => ({
    seq: base.nextSeq + i,
    at,
    kind: input.kind,
    message: sanitizeInlineText(input.message, ROADMAP_RUN_EVENT_MESSAGE_MAX_LENGTH),
  }));
  const all = [...base.events, ...records];
  const overflow = Math.max(0, all.length - MAX_ROADMAP_RUN_EVENTS);
  return {
    log: {
      ...base,
      nextSeq: base.nextSeq + records.length,
      dropped: base.dropped + overflow,
      events: all.slice(overflow),
    },
    records,
  };
}

export interface RoadmapRunEventsPage {
  events: RoadmapRunEventRecord[];
  /** 記録した最後の番号。まだ1件も無ければ`undefined`。 */
  latestSeq: number | undefined;
  /**
   * `after`より後で、上限のため既に落として返せない件数。`after`を省いたときはrun全体で落とした件数。
   */
  missed: number;
  /** この後にまだ記録がある（`after`に最後の番号を渡して続きを取る）。 */
  hasMore: boolean;
  /**
   * `after`が記録した最後の番号より先を指していた。保存データが壊れて作り直された等でログが
   * 失われたときに起きるため、残っている記録を古い順に返す。
   */
  afterUnknown: boolean;
  /** 保存に失敗して記録できなかった件数（このウィンドウで数えた分。Orchestratorへの通知は届いている）。 */
  unrecorded: number;
}

/**
 * `after`より後の記録を古い順に`limit`件まで返す。`after`を省くと最新の`limit`件を返す。
 * `unrecorded`は数えていないため0で返す（呼び出し側で入れる）。
 */
export function selectRoadmapRunEvents(
  log: RoadmapRunEventLog | undefined,
  after: number | undefined,
  limit: number = ROADMAP_RUN_EVENTS_PAGE_SIZE,
): RoadmapRunEventsPage {
  const empty = { afterUnknown: false, unrecorded: 0 };
  if (log === undefined) {
    return {
      ...empty,
      events: [],
      latestSeq: undefined,
      missed: 0,
      hasMore: false,
      afterUnknown: after !== undefined && after > 0,
    };
  }
  const latestSeq = log.nextSeq > 1 ? log.nextSeq - 1 : undefined;
  if (after === undefined) {
    return {
      ...empty,
      events: log.events.slice(-limit),
      latestSeq,
      missed: log.dropped,
      hasMore: false,
    };
  }
  if (after >= log.nextSeq) {
    return {
      ...empty,
      events: log.events.slice(0, limit),
      latestSeq,
      missed: log.dropped,
      hasMore: log.events.length > limit,
      afterUnknown: true,
    };
  }
  const newer = log.events.filter((e) => e.seq > after);
  const oldestKept = log.events[0]?.seq ?? log.nextSeq;
  const missed = Math.max(0, Math.min(oldestKept, log.nextSeq) - after - 1);
  return {
    ...empty,
    events: newer.slice(0, limit),
    latestSeq,
    missed,
    hasMore: newer.length > limit,
  };
}

function isStoredEventRecord(e: unknown): e is RoadmapRunEventRecord {
  return (
    isPlainObject(e) &&
    typeof e.seq === 'number' &&
    Number.isSafeInteger(e.seq) &&
    typeof e.at === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.message === 'string'
  );
}

function isStoredEventLog(r: unknown): r is RoadmapRunEventLog {
  return (
    isPlainObject(r) &&
    typeof r.runId === 'string' &&
    typeof r.startedAt === 'string' &&
    typeof r.nextSeq === 'number' &&
    Number.isSafeInteger(r.nextSeq) &&
    r.nextSeq >= 1 &&
    typeof r.dropped === 'number' &&
    Array.isArray(r.events) &&
    r.events.every(isStoredEventRecord)
  );
}

/** イベントログの永続化。runの状態と同じ開始時刻・同じ件数で並べて捨てる。 */
export class RoadmapRunEventStore extends MementoRunStore<RoadmapRunEventLog> {
  constructor(memento: MementoLike) {
    super(memento, {
      key: ROADMAP_RUN_EVENTS_KEY,
      maxStored: MAX_STORED_ROADMAP_RUNS,
      isValid: isStoredEventLog,
    });
  }

  /** 出来事を追記し、振った番号付きの記録を返す。 */
  async append(
    run: Pick<RoadmapRun, 'runId' | 'startedAt'>,
    inputs: readonly RoadmapRunEventInput[],
    now: Date,
  ): Promise<RoadmapRunEventRecord[]> {
    if (inputs.length === 0) {
      return [];
    }
    let records: RoadmapRunEventRecord[] = [];
    await this.update(run.runId, (current) => {
      const appended = appendRoadmapRunEvents(current, run, inputs, now);
      records = appended.records;
      return appended.log;
    });
    return records;
  }
}
