/**
 * 通常チャットの会話を区切る（Issue #2123）。
 *
 * ターンの開始（`busy`の立ち上がり）と終了（`turnCompletionSeq`の変化）を見て、ターンごとの
 * 所要時間・失敗・編集の有無を区切りに積む。区切るのは次のどちらか。
 *
 * - タブを閉じたとき（`end`。`teardown`から呼ぶ）
 * - 最後のターン終了から一定時間（`idleMs`）次のターンが始まらないとき
 * - 拡張の終了・Reload（`dispose`。途中の会話を捨てないため。Issue #2128）
 *
 * 区切った区切りは管理表から外してから`onSegment`へ渡すため、両方の契機が重なっても同じ区切りを
 * 二度渡さない。区切った後に会話が続いたら、次のターンから新しい区切りを始める。
 *
 * 会話本文・ファイルパスは読まない（`ChatState`から読むのは件数・真偽値・区分・コストだけ）。
 * `vscode`に依存しない。
 */

import { randomUUID } from 'node:crypto';

import type { ChatState } from '../appserver/chatState';
import type { ChatSegment, ChatTurnRecord } from '../orchestrator/retrospectiveMetrics/chat';
import type { TaskRunEngine } from '../orchestrator/taskRunState';

/** 区切りに使う`ChatState`の項目。本文を含む項目（`items`など）は受け取らない。 */
export type TrackedChatState = Pick<
  ChatState,
  'busy' | 'turnCompletionSeq' | 'turnFailed' | 'turnFailureKind' | 'sessionCost'
> & {
  /** 直前のターンで編集したファイルの数（パスは渡さない）。 */
  turnEditedFileCount: number;
};

/** `ChatState`から区切りに使う項目だけを取り出す。会話本文・ファイルパスは写さない。 */
export function toTrackedChatState(state: ChatState): TrackedChatState {
  return {
    busy: state.busy,
    turnCompletionSeq: state.turnCompletionSeq,
    turnFailed: state.turnFailed,
    turnFailureKind: state.turnFailureKind,
    sessionCost: state.sessionCost,
    turnEditedFileCount: state.turnEditedFiles.length,
  };
}

export interface ChatConversationObservation {
  engine: TaskRunEngine;
  cwd: string | undefined;
  taskManaged: boolean;
  state: TrackedChatState;
}

export type SegmentEndReason = 'teardown' | 'idle' | 'dispose';

export interface ChatConversationTrackerDeps {
  /** 最後のターン終了から区切るまでの時間（ミリ秒）。0以下なら無入力では区切らない。 */
  idleMs(): number;
  /** 区切った区切り。ターンが1件以上のものだけを渡す。選別は受け取る側が行う。 */
  onSegment(segment: ChatSegment, finishedAt: number, reason: SegmentEndReason): void;
  now?(): number;
  newRunId?(): string;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Conversation {
  lastSeq: number;
  turnStartedAt: number | undefined;
  segment: MutableSegment | undefined;
  /** この会話で区切った区切りの数。最初の区切りだけ、コストの起点が分からなければ0とみなす。 */
  closedSegments: number;
  lastKnownCostUsd: number | undefined;
  /** 進行中のターンが始まった時点の累計コスト。区切りの最初のターンならコストの起点になる。 */
  costAtTurnStart: number | undefined;
  timer: unknown;
}

type MutableSegment = Omit<ChatSegment, 'turns'> & { turns: ChatTurnRecord[] };

/** 会話（タブ）ごとの区切りを追う。鍵はタブのエントリ（オブジェクトの同一性で見分ける）。 */
export class ChatConversationTracker {
  private readonly conversations = new Map<object, Conversation>();
  private readonly now: () => number;
  private readonly newRunId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: ChatConversationTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.newRunId = deps.newRunId ?? (() => `chat-${randomUUID()}`);
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 状態が変わるたびに呼ぶ。 */
  observe(key: object, obs: ChatConversationObservation): void {
    const { state } = obs;
    let conv = this.conversations.get(key);
    if (conv === undefined) {
      // 最初に見た時点の完了数を起点にする（復元した会話の過去のターンを数えない）
      conv = {
        lastSeq: state.turnCompletionSeq,
        turnStartedAt: state.busy ? this.now() : undefined,
        segment: undefined,
        closedSegments: 0,
        lastKnownCostUsd: state.sessionCost?.totalCostUsd,
        costAtTurnStart: state.sessionCost?.totalCostUsd,
        timer: undefined,
      };
      this.conversations.set(key, conv);
      return;
    }
    if (state.sessionCost !== undefined) {
      conv.lastKnownCostUsd = state.sessionCost.totalCostUsd;
    }
    if (state.turnCompletionSeq !== conv.lastSeq) {
      conv.lastSeq = state.turnCompletionSeq;
      this.finishTurn(key, conv, obs);
    }
    if (state.busy && conv.turnStartedAt === undefined) {
      // 次のターンが始まった（入力があった）。無入力の区切りを取り消す
      conv.turnStartedAt = this.now();
      conv.costAtTurnStart = conv.lastKnownCostUsd;
      this.cancelTimer(conv);
    }
  }

  /** タブを閉じたときに呼ぶ。区切りがあれば区切り、会話を管理表から外す。 */
  end(key: object): void {
    const conv = this.conversations.get(key);
    if (conv === undefined) {
      return;
    }
    this.close(conv, 'teardown');
    this.conversations.delete(key);
  }

  /**
   * 全会話の途中の区切りを渡し、タイマーを止める。拡張の終了・Reload時に呼ぶ（Issue #2128）。
   * 選別は受け取る側が行う。管理表を空にしてから渡すため、後から同じ会話の`end`や無入力の
   * タイマーが来ても二重に渡さない。
   */
  dispose(): void {
    const conversations = [...this.conversations.values()];
    this.conversations.clear();
    for (const conv of conversations) {
      this.close(conv, 'dispose');
    }
  }

  private finishTurn(key: object, conv: Conversation, obs: ChatConversationObservation): void {
    const finishedAt = this.now();
    const startedAt = conv.turnStartedAt ?? finishedAt;
    // 開始を見ていないターン（立ち上がりと完了が同じ通知に載った等）は、起点のコストも分からない
    const costAtStart = conv.turnStartedAt === undefined ? undefined : conv.costAtTurnStart;
    conv.turnStartedAt = undefined;
    if (conv.segment === undefined) {
      conv.segment = {
        runId: this.newRunId(),
        engine: obs.engine,
        workspaceRoot: obs.cwd,
        taskManaged: obs.taskManaged,
        startedAt,
        turns: [],
        // 最初の区切りでコストがまだ届いていなければ、セッションの起点（0）から数える。
        // コストはClaudeだけが持つ（Codexは常に分からない）
        costStartUsd:
          costAtStart ??
          (conv.closedSegments === 0 &&
          conv.costAtTurnStart === undefined &&
          obs.engine === 'claude'
            ? 0
            : undefined),
        costEndUsd: undefined,
      };
    }
    const seg = conv.segment;
    seg.taskManaged = seg.taskManaged || obs.taskManaged;
    seg.workspaceRoot = seg.workspaceRoot ?? obs.cwd;
    seg.turns.push({
      startedAt,
      finishedAt,
      failed: obs.state.turnFailed,
      failureKind: obs.state.turnFailed ? obs.state.turnFailureKind : undefined,
      edited: obs.state.turnEditedFileCount > 0,
    });
    this.cancelTimer(conv);
    const idleMs = this.deps.idleMs();
    if (idleMs > 0) {
      conv.timer = this.setTimer(() => {
        conv.timer = undefined;
        // 閉じた後に古いタイマーが走っても、管理表に無い会話は区切らない
        if (this.conversations.get(key) === conv && conv.turnStartedAt === undefined) {
          this.close(conv, 'idle');
        }
      }, idleMs);
    }
  }

  private close(conv: Conversation, reason: SegmentEndReason): void {
    this.cancelTimer(conv);
    const seg = conv.segment;
    conv.segment = undefined;
    if (seg === undefined || seg.turns.length === 0) {
      return;
    }
    conv.closedSegments += 1;
    seg.costEndUsd = conv.lastKnownCostUsd;
    if (seg.costStartUsd === undefined || seg.costEndUsd === undefined) {
      seg.costStartUsd = undefined;
      seg.costEndUsd = undefined;
    }
    this.deps.onSegment(seg, this.now(), reason);
  }

  private cancelTimer(conv: Conversation): void {
    if (conv.timer !== undefined) {
      this.clearTimer(conv.timer);
      conv.timer = undefined;
    }
  }
}
