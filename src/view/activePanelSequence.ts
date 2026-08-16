/**
 * `ChatViewManager`（Codex）と `ClaudeChatViewManager`（Claude Code）をまたいで
 * 「直近にアクティブだったタブ」を比べるための単調増加カウンタ（issue #292）。
 *
 * 各管理クラスは自分の `active`（プロバイダ内で最後にフォーカスが当たったエントリ）を
 * 独立に持つ（`chatView.ts` / `claudeChatView.ts` の `private active` 参照）。しかし
 * どちらのプロバイダのタブがより最近アクティブだったかは、プロバイダをまたいで比べないと
 * 決まらない。プロセス全体で共有するこの採番だけがその手段になる（`Date.now()` だと
 * 同一ミリ秒内の連続フォーカスで順序が付かないことがあるため使わない）。
 */
let sequence = 0;

export function nextActivePanelSequence(): number {
  sequence += 1;
  return sequence;
}

/**
 * エディタの選択範囲（issue #292）の送り先として選べる、直近にアクティブだったタブ。
 * `ChatViewManager.getActiveComposerTarget` / `ClaudeChatViewManager.getActiveComposerTarget`
 * が返す。`activeSequence` はプロバイダをまたいだ比較にのみ使う（大きいほど新しい）。
 */
export interface ActiveComposerTarget {
  readonly activeSequence: number;
  /** 入力欄の末尾へテキストを挿し込み、そのタブを表に出す（送信はしない）。 */
  insert(text: string): void;
}
