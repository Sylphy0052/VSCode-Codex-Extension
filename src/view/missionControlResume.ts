import type { McActivity, McProvider } from '../webview/missionControl/protocol';

/**
 * Reloadで切れたセッション（Issue #2138の3）。
 *
 * 会話の状態には「Reloadで途中で切れた」印が無い（復元直後はどの会話も待機中に見える）。
 * そこで、実行中のターンを持つ会話をウィンドウごとの保存領域（`workspaceState`）へ書いておき、
 * 次の起動で前回の分を読み出して「再開待ち」とする。
 *
 * 外すのは「待機中へ戻った」「一覧から消えた」のを少し待ってからにする。Reloadで拡張ホストが
 * 止まる途中にも会話は閉じられ・待機中に見えるため、すぐ外すと書き残したい分まで消える。
 * 止まる途中ならタイマーは発火しないので、実行中だった分が残る。
 */

/** 保存領域のキー。 */
export const RUNNING_TURNS_KEY = 'agent.missionControl.runningTurns';
/** 実行中でなくなってから外すまでの待ち時間。 */
export const RUNNING_TURN_REMOVAL_DELAY_MS = 3_000;
/** 覚えておく件数の上限（壊れた値・異常に多い会話で保存領域を膨らませない）。 */
const MAX_ENTRIES = 50;

export interface RunningTurnEntry {
  provider: McProvider;
  threadId: string;
  title: string;
  cwd?: string | undefined;
  /** 実行中だと最初に見た時刻（ms）。 */
  since: number;
}

export interface RunningTurnStore {
  get(): unknown;
  update(value: RunningTurnEntry[]): Thenable<void> | Promise<void>;
}

export interface RunningTurnSession {
  provider: McProvider;
  threadId: string;
  title: string;
  cwd?: string | undefined;
  activity: McActivity;
}

interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function entryKey(entry: { provider: McProvider; threadId: string }): string {
  return `${entry.provider}:${entry.threadId}`;
}

/** 保存領域の値を確かめて読む。形の合わない要素は捨てる。 */
export function parseRunningTurns(raw: unknown): RunningTurnEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: RunningTurnEntry[] = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const v = item as Record<string, unknown>;
    if (
      (v.provider !== 'codex' && v.provider !== 'claude') ||
      typeof v.threadId !== 'string' ||
      v.threadId === '' ||
      typeof v.title !== 'string' ||
      typeof v.since !== 'number'
    ) {
      continue;
    }
    entries.push({
      provider: v.provider,
      threadId: v.threadId,
      title: v.title,
      cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
      since: v.since,
    });
  }
  return entries;
}

/** 実行中のターンを持つ会話を保存領域へ書き続ける。 */
export class RunningTurnJournal {
  private readonly running = new Map<string, RunningTurnEntry>();
  /** 前回の起動から持ち越した、まだ再開していない分（`takePrevious`）。 */
  private readonly carried = new Map<string, RunningTurnEntry>();
  private readonly removals = new Map<string, unknown>();
  private lastWritten = '[]';

  constructor(
    private readonly store: RunningTurnStore,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = defaultTimers,
  ) {}

  /**
   * 前回の起動で書いた分を読み出す。起動直後に1回だけ呼ぶ。
   *
   * 読み出した分は「再開待ち」として、再開か外す（`forget`）か、その会話が実行中へ戻るまで
   * 保存領域に残す。読み出した時点で消すと、再開しないまま続けてReloadしたときに消えてしまう。
   * 今回の実行中の分は`observe`が書き足す。
   */
  takePrevious(): RunningTurnEntry[] {
    const previous = parseRunningTurns(this.store.get());
    this.carried.clear();
    for (const entry of previous) {
      this.carried.set(entryKey(entry), entry);
    }
    this.lastWritten = this.serialize();
    return previous;
  }

  /** 再開待ちを再開した・外したときに呼ぶ。保存領域からも消す。 */
  forget(entry: { provider: McProvider; threadId: string }): void {
    if (this.carried.delete(entryKey(entry))) {
      this.write();
    }
  }

  /** このウィンドウの会話の状態が変わるたびに呼ぶ。 */
  observe(sessions: readonly RunningTurnSession[]): void {
    const seen = new Set<string>();
    let changed = false;
    for (const session of sessions) {
      const key = entryKey(session);
      seen.add(key);
      if (session.activity === 'idle') {
        this.scheduleRemoval(key);
        continue;
      }
      this.cancelRemoval(key);
      // 実行中へ戻った会話は再開待ちではない
      if (this.carried.delete(key)) {
        changed = true;
      }
      const existing = this.running.get(key);
      if (
        existing === undefined ||
        existing.title !== session.title ||
        existing.cwd !== session.cwd
      ) {
        changed = true;
      }
      this.running.set(key, {
        provider: session.provider,
        threadId: session.threadId,
        title: session.title,
        cwd: session.cwd,
        // 書き込みは中身が変わったときだけなので、時刻は最初に見たときのまま持つ
        since: existing?.since ?? this.now(),
      });
    }
    for (const key of this.running.keys()) {
      if (!seen.has(key)) {
        this.scheduleRemoval(key);
      }
    }
    if (changed) {
      this.write();
    }
  }

  dispose(): void {
    for (const handle of this.removals.values()) {
      this.timers.clear(handle);
    }
    this.removals.clear();
  }

  private scheduleRemoval(key: string): void {
    if (!this.running.has(key) || this.removals.has(key)) {
      return;
    }
    this.removals.set(
      key,
      this.timers.set(() => {
        this.removals.delete(key);
        if (this.running.delete(key)) {
          this.write();
        }
      }, RUNNING_TURN_REMOVAL_DELAY_MS),
    );
  }

  private cancelRemoval(key: string): void {
    const handle = this.removals.get(key);
    if (handle !== undefined) {
      this.timers.clear(handle);
      this.removals.delete(key);
    }
  }

  /** 書き込む値。まだ再開していない前回の分と、今回の実行中の分。 */
  private entries(): RunningTurnEntry[] {
    const carried = [...this.carried.entries()]
      .filter(([key]) => !this.running.has(key))
      .map(([, entry]) => entry);
    return [...carried, ...this.running.values()].slice(0, MAX_ENTRIES);
  }

  private serialize(): string {
    return JSON.stringify(this.entries().map((v) => [v.provider, v.threadId, v.title, v.cwd]));
  }

  private write(): void {
    const serialized = this.serialize();
    if (serialized === this.lastWritten) {
      return;
    }
    this.lastWritten = serialized;
    void this.store.update(this.entries());
  }
}
