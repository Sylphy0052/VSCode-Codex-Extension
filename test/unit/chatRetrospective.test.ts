import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import {
  ChatConversationTracker,
  toTrackedChatState,
  type ChatConversationObservation,
  type SegmentEndReason,
} from '../../src/chat/chatConversationTracker';
import {
  createChatSegmentRecorder,
  type ChatSegmentOutcome,
} from '../../src/chat/chatRetrospective';
import {
  buildChatLessons,
  chatRunSummary,
  checkChatSegmentEligibility,
  computeChatMetricValues,
  computeChatRunMetrics,
  normalizeChatRetrospectiveSettings,
  type ChatSegment,
  type ChatTurnRecord,
} from '../../src/orchestrator/retrospectiveMetrics/chat';
import type { RunMetrics, RunMetricsKeys } from '../../src/orchestrator/runMetrics';
import { hashChatPrompts } from '../../src/orchestrator/runMetricsStore';
import type { LessonInput, RunKind as NotesRunKind } from '../../src/orchestrator/runNotes';
import {
  evaluateImprovement,
  metricValue,
  readAllRunMetrics,
  retrospectiveMetricsFor,
  selectTargetMetric,
  type RunRetrospective,
} from '../../src/orchestrator/runRetrospective';
import type { RunKind, RunSummary } from '../../src/orchestrator/runSummary';

const KEYS: RunMetricsKeys = {
  extensionVersion: '2026.1116.1',
  promptHash: 'p',
  limitsHash: 'l',
  pluginHash: undefined,
  pluginCommits: {},
};

function turn(over: Partial<ChatTurnRecord> = {}): ChatTurnRecord {
  return {
    startedAt: 0,
    finishedAt: 60_000,
    failed: false,
    failureKind: undefined,
    edited: false,
    ...over,
  };
}

function segment(over: Partial<ChatSegment> = {}): ChatSegment {
  return {
    runId: 'chat-1',
    engine: 'claude',
    workspaceRoot: '/ws',
    taskManaged: false,
    startedAt: 0,
    turns: [turn({ edited: true }), turn(), turn({ failed: true, failureKind: 'other' })],
    costStartUsd: 1,
    costEndUsd: 1.6,
    ...over,
  };
}

describe('retrospectiveMetrics/chat', () => {
  it('選別: タスク管理下・編集なし・ターン数不足・作業ディレクトリ不明は落とす', () => {
    expect(checkChatSegmentEligibility(segment(), 3)).toEqual({ ok: true });
    expect(checkChatSegmentEligibility(segment({ taskManaged: true }), 3).ok).toBe(false);
    expect(checkChatSegmentEligibility(segment({ workspaceRoot: undefined }), 3).ok).toBe(false);
    expect(checkChatSegmentEligibility(segment({ turns: [turn(), turn(), turn()] }), 3).ok).toBe(
      false,
    );
    expect(checkChatSegmentEligibility(segment(), 4).ok).toBe(false);
  });

  it('指標: 失敗率・編集あたりのターン数・ターンあたりのコストと所要時間', () => {
    const v = computeChatMetricValues(
      segment({
        turns: [
          turn({ startedAt: 0, finishedAt: 30_000, edited: true }),
          turn({ startedAt: 0, finishedAt: 90_000, failed: true }),
          turn({ startedAt: 0, finishedAt: 60_000, edited: true }),
          turn({ startedAt: 0, finishedAt: 60_000 }),
        ],
      }),
    );
    expect(v).toEqual({
      turns: 4,
      failedTurns: 1,
      editTurns: 2,
      failedTurnRate: 0.25,
      turnsPerEdit: 2,
      costPerTurn: expect.closeTo(0.15, 10) as number,
      msPerTurn: 60_000,
    });
  });

  it('指標: コストが分からなければundefined、ターン0件なら計算しない', () => {
    expect(computeChatMetricValues(segment({ costStartUsd: undefined }))?.costPerTurn).toBe(
      undefined,
    );
    expect(computeChatMetricValues(segment({ turns: [] }))).toBe(undefined);
    expect(computeChatRunMetrics(segment({ turns: [] }), 1, KEYS)).toBe(undefined);
    expect(computeChatMetricValues(segment({ turns: [turn()] }))?.turnsPerEdit).toBe(1);
  });

  it('kind: chatの指標と振り返りの入力を作る', () => {
    const m = computeChatRunMetrics(segment(), 120_000, KEYS);
    expect(m?.kind).toBe('chat');
    expect(m?.childIssues).toBe(0);
    expect(m?.finishedAt).toBe(new Date(120_000).toISOString());
    expect(m?.chat?.turns).toBe(3);
    expect(chatRunSummary(segment(), 120_000)).toMatchObject({
      kind: 'chat',
      runId: 'chat-1',
      workspaceRoot: '/ws',
      engines: ['claude'],
    });
    expect(chatRunSummary(segment({ workspaceRoot: undefined }), 1)).toBe(undefined);
  });

  it('教訓: 失敗が無ければ作らず、最も多い区分の1件だけを固定の文で作る', () => {
    expect(buildChatLessons(segment({ turns: [turn(), turn()] }))).toEqual([]);
    const lessons = buildChatLessons(
      segment({
        turns: [
          turn({ failed: true, failureKind: 'usageLimit' }),
          turn({ failed: true, failureKind: 'usageLimit' }),
          turn({ failed: true, failureKind: 'other' }),
          turn(),
        ],
      }),
    );
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.source).toBe('repoArtifact');
    expect(lessons[0]?.evidence).toEqual(['turns=4', 'failedTurns=2', 'failureKind=usageLimit']);
    expect(lessons[0]?.observation).toContain('使用量の上限');
    // 区分が無い失敗はotherとして数える。同数ならother
    const other = buildChatLessons(
      segment({
        turns: [turn({ failed: true }), turn({ failed: true, failureKind: 'usageLimit' })],
      }),
    );
    expect(other[0]?.evidence).toContain('failureKind=other');
  });

  it('設定: 範囲外・整数でない値は既定値にする', () => {
    expect(normalizeChatRetrospectiveSettings({ minTurns: 5, idleMinutes: 0 })).toEqual({
      minTurns: 5,
      idleMinutes: 0,
    });
    expect(normalizeChatRetrospectiveSettings({ minTurns: 0, idleMinutes: -1 })).toEqual({
      minTurns: 3,
      idleMinutes: 30,
    });
    expect(normalizeChatRetrospectiveSettings({ minTurns: '3', idleMinutes: 1.5 })).toEqual({
      minTurns: 3,
      idleMinutes: 30,
    });
  });
});

// ---------------------------------------------------------------- 追跡器

class FakeClock {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private seq = 0;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at <= this.now) {
        this.timers.delete(id);
        t.fn();
      }
    }
  }
  get pending(): number {
    return this.timers.size;
  }
}

interface Emitted {
  segment: ChatSegment;
  finishedAt: number;
  reason: SegmentEndReason;
}

function makeTracker(idleMs = 30 * 60_000): {
  tracker: ChatConversationTracker;
  clock: FakeClock;
  emitted: Emitted[];
} {
  const clock = new FakeClock();
  const emitted: Emitted[] = [];
  let n = 0;
  const tracker = new ChatConversationTracker({
    idleMs: () => idleMs,
    onSegment: (segment, finishedAt, reason) => emitted.push({ segment, finishedAt, reason }),
    now: () => clock.now,
    newRunId: () => `chat-${String(++n)}`,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { tracker, clock, emitted };
}

/** 1つの会話の状態を進める小道具。 */
class Conversation {
  private seq = 0;
  constructor(
    private readonly tracker: ChatConversationTracker,
    private readonly clock: FakeClock,
    readonly key: object = {},
    private readonly base: Partial<ChatConversationObservation> = {},
  ) {
    this.observe({ busy: false });
  }

  observe(state: Partial<ChatState>): void {
    const full: ChatState = { ...initialChatState, turnCompletionSeq: this.seq, ...state };
    this.tracker.observe(this.key, {
      engine: 'claude',
      cwd: '/ws',
      taskManaged: false,
      ...this.base,
      state: toTrackedChatState(full),
    });
  }

  /** 1ターン回す。`ms`かけて終わる。 */
  turn(
    ms: number,
    over: { failed?: boolean; edited?: boolean; cost?: number; text?: string } = {},
  ): void {
    this.observe({ busy: true });
    this.clock.advance(ms);
    this.seq += 1;
    this.observe({
      busy: false,
      turnFailed: over.failed === true,
      turnFailureKind: over.failed === true ? 'other' : undefined,
      turnEditedFiles: over.edited === true ? ['/secret/path/file.ts'] : [],
      sessionCost:
        over.cost === undefined
          ? undefined
          : {
              totalCostUsd: over.cost,
              totalLinesAdded: 0,
              totalLinesRemoved: 0,
              subscriptionType: undefined,
              capturedAt: this.clock.now,
            },
      turnResultText: over.text ?? '',
    });
  }
}

describe('ChatConversationTracker', () => {
  it('無入力の時間が過ぎたら区切り、ターンごとの所要時間と失敗・編集を渡す', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock);
    clock.advance(1_000);
    c.turn(10_000, { edited: true, cost: 0.2 });
    clock.advance(5_000);
    c.turn(20_000, { failed: true, cost: 0.5 });
    clock.advance(29 * 60_000);
    expect(emitted).toHaveLength(0);
    clock.advance(60_000);
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e?.reason).toBe('idle');
    expect(e?.segment.startedAt).toBe(1_000);
    expect(e?.segment.turns.map((t) => t.finishedAt - t.startedAt)).toEqual([10_000, 20_000]);
    expect(e?.segment.turns.map((t) => [t.failed, t.edited])).toEqual([
      [false, true],
      [true, false],
    ]);
    // 最初の区切りでコストがまだ届いていなかったので、起点は0
    expect(e?.segment.costStartUsd).toBe(0);
    expect(e?.segment.costEndUsd).toBe(0.5);
  });

  it('無入力で区切った後にタブを閉じても二重に渡さない', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock);
    c.turn(1_000, { edited: true });
    clock.advance(31 * 60_000);
    tracker.end(c.key);
    expect(emitted.map((e) => e.reason)).toEqual(['idle']);
  });

  it('タブを閉じたら区切り、その後に無入力の時間が過ぎても二重に渡さない', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock);
    c.turn(1_000, { edited: true });
    tracker.end(c.key);
    tracker.end(c.key);
    clock.advance(60 * 60_000);
    expect(emitted.map((e) => e.reason)).toEqual(['teardown']);
    expect(clock.pending).toBe(0);
  });

  it('区切った後に会話が続いたら新しい区切りとして扱う', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock);
    c.turn(1_000, { edited: true, cost: 1 });
    clock.advance(31 * 60_000);
    c.turn(2_000, { cost: 1.4 });
    tracker.end(c.key);
    expect(emitted.map((e) => [e.reason, e.segment.runId, e.segment.turns.length])).toEqual([
      ['idle', 'chat-1', 1],
      ['teardown', 'chat-2', 1],
    ]);
    // 2つ目の区切りのコストは、そのターンの開始時点の累計から数える
    expect(emitted[1]?.segment.costStartUsd).toBe(1);
    expect(emitted[1]?.segment.costEndUsd).toBe(1.4);
  });

  it('次のターンが始まったら無入力の区切りを取り消す', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock);
    c.turn(1_000, { edited: true });
    clock.advance(20 * 60_000);
    c.observe({ busy: true });
    clock.advance(60 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('ターンが無い会話・最初に見た時点までの完了は区切りにしない', () => {
    const { tracker, clock, emitted } = makeTracker();
    const key = {};
    tracker.observe(key, {
      engine: 'codex',
      cwd: '/ws',
      taskManaged: false,
      state: toTrackedChatState({ ...initialChatState, turnCompletionSeq: 7 }),
    });
    tracker.end(key);
    tracker.end({});
    clock.advance(60 * 60_000);
    expect(emitted).toHaveLength(0);
  });

  it('Codexはコストが分からない（区切りのコストはundefined）', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock, {}, { engine: 'codex' });
    c.turn(1_000, { edited: true });
    tracker.end(c.key);
    expect(emitted[0]?.segment.engine).toBe('codex');
    expect(emitted[0]?.segment.costStartUsd).toBe(undefined);
    expect(emitted[0]?.segment.costEndUsd).toBe(undefined);
  });

  it('idleMsが0なら無入力では区切らない。disposeでタイマーを止める', () => {
    const { tracker, clock, emitted } = makeTracker(0);
    const c = new Conversation(tracker, clock);
    c.turn(1_000, { edited: true });
    clock.advance(24 * 60 * 60_000);
    expect(emitted).toHaveLength(0);

    const other = makeTracker();
    const c2 = new Conversation(other.tracker, other.clock);
    c2.turn(1_000, { edited: true });
    other.tracker.dispose();
    expect(other.clock.pending).toBe(0);
  });

  it('disposeで途中の会話を区切って渡し、その後のteardown・無入力では二重に渡さない', () => {
    const { tracker, clock, emitted } = makeTracker();
    const a = new Conversation(tracker, clock, {});
    const b = new Conversation(tracker, clock, {});
    const idle = new Conversation(tracker, clock, {});
    a.turn(1_000, { edited: true, cost: 0.3 });
    a.turn(2_000, { cost: 0.5 });
    b.turn(1_000);
    // ターンの無い会話は区切りにしない
    idle.observe({ busy: false });
    tracker.dispose();
    expect(emitted.map((e) => [e.reason, e.segment.turns.length])).toEqual([
      ['dispose', 2],
      ['dispose', 1],
    ]);
    expect(emitted[0]?.segment.costEndUsd).toBe(0.5);
    expect(clock.pending).toBe(0);
    tracker.end(a.key);
    tracker.end(b.key);
    clock.advance(60 * 60_000);
    tracker.dispose();
    expect(emitted).toHaveLength(2);
  });

  it('teardownで区切った会話はdisposeで二重に渡さない', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock);
    c.turn(1_000, { edited: true });
    tracker.end(c.key);
    tracker.dispose();
    expect(emitted.map((e) => e.reason)).toEqual(['teardown']);
  });

  it('無入力で区切った後にターンが無ければdisposeで渡さない', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock);
    c.turn(1_000, { edited: true });
    clock.advance(31 * 60_000);
    tracker.dispose();
    expect(emitted.map((e) => e.reason)).toEqual(['idle']);
  });

  it('タスク管理下の会話は区切りに印を付ける（選別で落とす）', () => {
    const { tracker, clock, emitted } = makeTracker();
    const c = new Conversation(tracker, clock, {}, { taskManaged: true });
    c.turn(1_000, { edited: true });
    tracker.end(c.key);
    expect(emitted[0]?.segment.taskManaged).toBe(true);
  });
});

// ---------------------------------------------------------------- 記録と振り返り

describe('createChatSegmentRecorder', () => {
  let dir: string;
  let lessons: {
    workspaceRoot: string;
    input: LessonInput & { runId: string; runKind: NotesRunKind };
  }[];
  let retrospected: RunSummary[];
  let sources: RunKind[];
  let ownRepoRoots: string[];
  let ownRepo: Awaited<ReturnType<RunRetrospective['resolveOwnRepo']>>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-retro-'));
    lessons = [];
    retrospected = [];
    sources = ['task', 'chat'];
    ownRepoRoots = [];
    ownRepo = { ok: true, repo: { nameWithOwner: 'owner/self', visibility: 'public' } };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function recorder(): ReturnType<typeof createChatSegmentRecorder> {
    return createChatSegmentRecorder({
      metricsDir: path.join(dir, 'run-metrics'),
      extensionVersion: '2026.1116.1',
      claudeHome: path.join(dir, 'no-claude-home'),
      sources: () => sources,
      settings: () => ({ minTurns: 3, idleMinutes: 30 }),
      runNotes: {
        recordLesson: async (workspaceRoot, input) => {
          lessons.push({ workspaceRoot, input });
          return Promise.resolve({ ok: true });
        },
      },
      retrospective: {
        onRunFinished: async (run) => {
          retrospected.push(run);
          return Promise.resolve();
        },
        resolveOwnRepo: async (root) => {
          ownRepoRoots.push(root);
          return Promise.resolve(ownRepo);
        },
      },
      log: () => undefined,
    });
  }

  async function savedMetrics(): Promise<RunMetrics[]> {
    return readAllRunMetrics(path.join(dir, 'run-metrics'), 'chat');
  }

  it('選別条件を満たす区切りはkind: chatの指標を1件保存し、教訓を記録して振り返る', async () => {
    const outcome = await recorder()(segment(), 120_000);
    expect(outcome).toEqual({ kind: 'recorded', written: true, lessons: 1 });
    const saved = await savedMetrics();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.kind).toBe('chat');
    // 群分けの鍵はチャット用のプロンプトのハッシュ（collectRunMetricsKeysへkind: chatを渡す）
    expect(saved[0]?.keys.promptHash).toBe(hashChatPrompts());
    expect(await readAllRunMetrics(path.join(dir, 'run-metrics'), 'task')).toHaveLength(0);
    expect(lessons.map((l) => [l.workspaceRoot, l.input.runId, l.input.runKind])).toEqual([
      ['/ws', 'chat-1', 'chat'],
    ]);
    expect(retrospected.map((r) => [r.kind, r.runId])).toEqual([['chat', 'chat-1']]);
    expect(ownRepoRoots).toEqual(['/ws']);
  });

  it('この拡張自身のrepo以外の会話は指標も教訓も書かず、理由付きでskippedを返す', async () => {
    ownRepo = { ok: false, reason: 'この拡張自身のリポジトリでない' };
    const outcome = await recorder()(segment(), 120_000);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'この拡張自身のリポジトリでない' });
    expect(ownRepoRoots).toEqual(['/ws']);
    expect(await savedMetrics()).toHaveLength(0);
    await expect(fs.readdir(path.join(dir, 'run-metrics'))).rejects.toThrow();
    expect(lessons).toHaveLength(0);
    expect(retrospected).toHaveLength(0);
  });

  it('自repoか確かめられない（判定が例外・振り返りが無い）ときは何も書かない', async () => {
    const logs: string[] = [];
    const base = {
      metricsDir: path.join(dir, 'run-metrics'),
      extensionVersion: 'v',
      claudeHome: path.join(dir, 'none'),
      sources: (): RunKind[] => ['chat'],
      settings: () => ({ minTurns: 1, idleMinutes: 30 }),
      runNotes: {
        recordLesson: async (
          workspaceRoot: string,
          input: LessonInput & { runId: string; runKind: NotesRunKind },
        ) => {
          lessons.push({ workspaceRoot, input });
          return Promise.resolve({ ok: true as const });
        },
      },
      log: (m: string) => logs.push(m),
    };
    const throwing = createChatSegmentRecorder({
      ...base,
      retrospective: {
        onRunFinished: async () => Promise.resolve(),
        resolveOwnRepo: async () => Promise.reject(new Error('gh failed')),
      },
    });
    expect(await throwing(segment(), 1)).toEqual({ kind: 'skipped', reason: 'gh failed' });
    expect(logs).toHaveLength(1);
    const none = createChatSegmentRecorder({ ...base, retrospective: undefined });
    expect((await none(segment(), 1)).kind).toBe('skipped');
    expect(await savedMetrics()).toHaveLength(0);
    expect(lessons).toHaveLength(0);
  });

  it('disposeで渡した途中の会話は、選別条件を満たすものだけ1件記録する', async () => {
    const clock = new FakeClock();
    const record = recorder();
    const done: Promise<ChatSegmentOutcome>[] = [];
    let n = 0;
    const t = new ChatConversationTracker({
      idleMs: () => 30 * 60_000,
      onSegment: (seg, finishedAt) => done.push(record(seg, finishedAt)),
      now: () => clock.now,
      newRunId: () => `chat-d${String(++n)}`,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const eligible = new Conversation(t, clock);
    eligible.turn(1_000, { edited: true, failed: true });
    eligible.turn(1_000);
    eligible.turn(1_000);
    // 編集が無い会話は選別で落ちる
    const ineligible = new Conversation(t, clock);
    ineligible.turn(1_000);
    ineligible.turn(1_000);
    ineligible.turn(1_000);
    t.dispose();
    // dispose後に同じ会話のteardown・無入力の区切りが来ても2件目はできない
    t.end(eligible.key);
    t.end(ineligible.key);
    clock.advance(60 * 60_000);
    const outcomes = await Promise.all(done);
    expect(outcomes.map((o) => o.kind)).toEqual(['recorded', 'skipped']);
    const saved = await savedMetrics();
    expect(saved.map((m) => m.runId)).toEqual(['chat-d1']);
    expect(lessons).toHaveLength(1);
    expect(retrospected.map((r) => r.runId)).toEqual(['chat-d1']);
  });

  it('同じ区切りを二度渡しても指標・教訓・振り返りは1回だけ', async () => {
    const record = recorder();
    await record(segment(), 120_000);
    const second = await record(segment(), 120_000);
    expect(second).toEqual({ kind: 'recorded', written: false, lessons: 0 });
    expect(await savedMetrics()).toHaveLength(1);
    expect(lessons).toHaveLength(1);
    expect(retrospected).toHaveLength(1);
  });

  it('選別条件を満たさない区切りは保存しない', async () => {
    const record = recorder();
    const outcomes = [
      await record(segment({ runId: 'a', taskManaged: true }), 1),
      await record(segment({ runId: 'b', turns: [turn(), turn(), turn()] }), 1),
      await record(segment({ runId: 'c', turns: [turn({ edited: true })] }), 1),
    ];
    expect(outcomes.map((o) => o.kind)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(await savedMetrics()).toHaveLength(0);
    expect(lessons).toHaveLength(0);
    expect(retrospected).toHaveLength(0);
  });

  it('sourcesにchatが無いときは保存も振り返りもしない', async () => {
    sources = ['task'];
    expect(await recorder()(segment(), 1)).toEqual({
      kind: 'skipped',
      reason: 'sourcesにchatが無い',
    });
    expect(await savedMetrics()).toHaveLength(0);
    expect(retrospected).toHaveLength(0);
  });

  it('書き込みに失敗しても例外を投げずログへ残す', async () => {
    const logs: string[] = [];
    // 置き場をファイルにして、ディレクトリを作れなくする
    const blocked = path.join(dir, 'blocked');
    await fs.writeFile(blocked, 'x');
    const record = createChatSegmentRecorder({
      metricsDir: path.join(blocked, 'run-metrics'),
      extensionVersion: 'v',
      claudeHome: path.join(dir, 'none'),
      sources: () => ['chat'],
      settings: () => ({ minTurns: 1, idleMinutes: 30 }),
      runNotes: undefined,
      retrospective: {
        onRunFinished: async () => Promise.resolve(),
        resolveOwnRepo: async () => Promise.resolve(ownRepo),
      },
      log: (m) => logs.push(m),
    });
    const outcome = await record(segment(), 1);
    expect(outcome.kind).toBe('skipped');
    expect(logs).toHaveLength(1);
  });

  it('会話本文・編集したファイルのパスは指標にも教訓にも入らない', async () => {
    const secret = 'SECRET-CONVERSATION-BODY-42';
    const clock = new FakeClock();
    const record = recorder();
    const done: Promise<unknown>[] = [];
    const t2 = new ChatConversationTracker({
      idleMs: () => 0,
      onSegment: (seg, finishedAt) => done.push(record(seg, finishedAt)),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const c = new Conversation(t2, clock);
    c.observe({
      busy: true,
      items: [
        {
          ...({} as ChatState['items'][number]),
          id: 'u1',
          kind: 'userMessage',
          text: secret,
          detail: secret,
        },
      ],
    });
    c.turn(1_000, { edited: true, failed: true, text: secret });
    c.turn(1_000, { failed: true, text: secret });
    c.turn(1_000, { text: secret });
    t2.end(c.key);
    await Promise.all(done);
    const saved = await savedMetrics();
    expect(saved).toHaveLength(1);
    expect(lessons).toHaveLength(1);
    const dumped = JSON.stringify({ saved, lessons });
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain('/secret/path');
    expect(dumped).not.toContain('file.ts');
  });
});

// ---------------------------------------------------------------- 評価

function chatMetrics(
  runId: string,
  startMs: number,
  version: string,
  failedTurnRate: number,
): RunMetrics {
  const m = computeChatRunMetrics(segment({ runId, startedAt: startMs }), startMs + 60_000, {
    ...KEYS,
    extensionVersion: version,
  }) as RunMetrics;
  return { ...m, chat: { ...m.chat!, failedTurnRate } };
}

function taskMetrics(runId: string, startMs: number, version: string): RunMetrics {
  return {
    schemaVersion: 1,
    kind: 'task',
    runId,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(startMs + 60_000).toISOString(),
    childIssues: 1,
    sendBacks: 5,
    autoRetries: 0,
    maxReached: 0,
    questions: 0,
    optimizeTrials: 0,
    gatesResolved: { reflex: 0, orchestrator: 0, user: 0 },
    msPerChildIssue: 60_000,
    keys: { ...KEYS, extensionVersion: version },
  };
}

describe('振り返りのchat指標', () => {
  it('chatの指標はchatの値を返し、taskの記録からは取れない', () => {
    const m = chatMetrics('c', 0, '1.0.0', 0.5);
    expect(metricValue(m, 'failedTurnRate')).toBe(0.5);
    expect(metricValue(taskMetrics('t', 0, '1.0.0'), 'failedTurnRate')).toBe(undefined);
    expect(retrospectiveMetricsFor('chat')).toContain('msPerTurn');
    expect(retrospectiveMetricsFor('task')).toContain('sendBacks');
  });

  it('改善案の指標はchatの指標から選ぶ', () => {
    const history = [chatMetrics('h1', 0, '1.0.0', 0.1), chatMetrics('h2', 0, '1.0.0', 0.1)];
    expect(selectTargetMetric(chatMetrics('c', 0, '1.0.0', 0.9), history, 'chat')).toBe(
      'failedTurnRate',
    );
    // 悪くなった指標が無ければchatの最初の指標
    expect(selectTargetMetric(history[0]!, history, 'chat')).toBe('failedTurnRate');
  });

  it('評価はchatのrunだけを母集団にする', () => {
    const merged = 10 * 60 * 60_000;
    const runs = [
      chatMetrics('b1', 0, '1.0.0', 0.1),
      chatMetrics('b2', 1, '1.0.0', 0.1),
      // taskのrunは悪化していても混ぜない
      taskMetrics('t1', merged + 1, '1.1.0'),
      taskMetrics('t2', merged + 2, '1.1.0'),
      chatMetrics('a1', merged + 3, '1.1.0', 0.1),
      chatMetrics('a2', merged + 4, '1.1.0', 0.1),
    ];
    const ev = evaluateImprovement(
      {
        runKind: 'chat',
        mergedAt: merged,
        version: '1.1.0',
        spec: {
          v: 1,
          key: 'k',
          target: 't',
          files: [],
          metric: 'failedTurnRate',
          expected: 'decrease',
          thresholdPct: 20,
          minAbsDelta: 0.05,
          minRuns: 2,
          evidence: [],
        },
      },
      runs,
    );
    expect(ev).toEqual({ kind: 'kept', before: 0.1, after: 0.1 });
  });
});
