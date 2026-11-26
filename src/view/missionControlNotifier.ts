import type { McPendingItem, McSnapshot } from '../webview/missionControl/protocol';

/**
 * Mission Controlの通知のまとめ（Issue #2138の2）。
 *
 * MCが前面に無いとき（タブが非アクティブか、ウィンドウにフォーカスが無いとき）だけ、新しく
 * 増えた待ち項目を通知する。数秒の間に増えた分は「N件待ち」の1件にまとめる。
 *
 * このウィンドウの会話の承認・質問は、会話の管理クラスが既に1件ずつ通知している
 * （`notifyNewApprovals`）。二重に知らせないよう、ここでは数えない。数えるのは他ウィンドウの
 * 項目と、会話の通知を持たない種類（task runの質問・引き継ぎ確認・ワークフローの承認）。
 */

/** 最初の1件からこの時間のうちに増えた分を1件の通知にまとめる。 */
export const NOTIFY_BATCH_MS = 3_000;

/** 会話の管理クラスが自分で通知する種類。 */
const SELF_NOTIFIED_KINDS: ReadonlySet<McPendingItem['kind']> = new Set([
  'toolApproval',
  'askUserQuestion',
  'codexPrompt',
]);

export interface McNotification {
  count: number;
  /** 1件のときの項目のタイトル。 */
  title: string | undefined;
}

export interface McNotifierPorts {
  /** 通知を出してよいか（`agent.notifications.approvalPending`）。 */
  enabled(): boolean;
  show(notification: McNotification): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** 通知の文。 */
export function notificationMessage(notification: McNotification): string {
  if (notification.count === 1 && notification.title !== undefined) {
    return `Mission Control: 「${notification.title}」が待っています`;
  }
  return `Mission Control: ${String(notification.count)}件待ち`;
}

export class McNotifier {
  /** 既に見た項目のid。今の一覧に無くなったものは外す。 */
  private seen = new Set<string>();
  private primed = false;
  private batch: McPendingItem[] = [];
  private timer: unknown;

  constructor(private readonly ports: McNotifierPorts) {}

  /**
   * スナップショットを作るたびに呼ぶ。`foreground`はMCが前面にあるか。
   * 最初の1回は今ある項目を既読にするだけで通知しない（開いた時点の分を鳴らさない）。
   */
  observe(snapshot: McSnapshot, foreground: boolean): void {
    const ids = new Set(snapshot.pending.map((item) => item.id));
    const fresh = snapshot.pending.filter(
      (item) =>
        !this.seen.has(item.id) && !(item.isCurrentWindow && SELF_NOTIFIED_KINDS.has(item.kind)),
    );
    this.seen = ids;
    if (!this.primed) {
      this.primed = true;
      return;
    }
    // 前面にある間は画面で見えているので通知しない。溜めていた分も、見えた時点で捨てる
    if (foreground) {
      this.reset();
      return;
    }
    // 答え終わって消えた項目は、まとめの件数から外す
    this.batch = this.batch.filter((item) => ids.has(item.id));
    if (fresh.length === 0) {
      return;
    }
    this.batch.push(...fresh);
    if (this.timer === undefined) {
      this.timer = this.ports.setTimer(() => this.flush(), NOTIFY_BATCH_MS);
    }
  }

  dispose(): void {
    this.reset();
  }

  private flush(): void {
    this.timer = undefined;
    const batch = this.batch;
    this.batch = [];
    if (batch.length === 0 || !this.ports.enabled()) {
      return;
    }
    this.ports.show({
      count: batch.length,
      title: batch.length === 1 ? batch[0]?.title : undefined,
    });
  }

  private reset(): void {
    if (this.timer !== undefined) {
      this.ports.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.batch = [];
  }
}
