/**
 * セカンドオピニオン（Issue #949）を、親セッションが暇になるまで待たせる。
 *
 * この機能が割り込みになるのは、`host.openTaskSession` で新しいCLIセッションを開く
 * 2箇所（会話の要約と本体）だけである。依頼先の選択・依頼文の入力・変更のスナップショットは
 * 押した時点で済ませ、ここで待たせるのはセッションを開く直前の一瞬だけにする。
 *
 * `vscode` に依存しない（`Disposable` は構造的に受ける）。親セッションの状態をどう読むかは
 * view層（`chatView.ts` / `claudeChatView.ts`）が `SecondOpinionParentPort` として渡す。
 */

/** `vscode.Disposable` と互換の最小形。テストから素のオブジェクトを渡せるようにする。 */
export interface DisposableLike {
  dispose(): void;
}

/**
 * 親セッションの実行状態を読む口。
 *
 * `onParentStateChanged` のcallbackへ状態そのものを渡さないのは、idleの判定を
 * `isParentIdle()` の1箇所に閉じ込めるためである。callbackが状態を運ぶ形にすると、
 * 判定式が呼び出し側（Codex用・Claude用の2つ）へ写って二重管理になる。
 */
export interface SecondOpinionParentPort {
  /** 親セッションが暇か（進行中のターンが無く、人が積んだ待機列も空か）。 */
  isParentIdle(): boolean;
  /** 親セッションの状態が変わるたびに呼ぶ。戻り値は購読の解除。 */
  onParentStateChanged(listener: () => void): DisposableLike;
}

/** {@link waitForParentIdle} の結末。 */
export type ParentIdleWaitResult = 'idle' | 'cancelled';

/**
 * 親セッションが暇になるまで待つ。暇になったら `'idle'`、途中で止められたら `'cancelled'`。
 *
 * 例外ではなく値で返す。この機能の停止経路（Issue #940）は既に
 * `AbortSignal.aborted` を見て停止表示へ分岐する形で揃っており、ここだけ例外を投げると
 * 呼び出し側に別系統の分岐が増える。
 *
 * **購読してから再判定する。** 先に `isParentIdle()` を見て、偽だったので購読する、という
 * 順序だと、判定と購読の間にidleへ遷移した場合に通知が届かず永久に待つ（lost wakeup）。
 * 購読を張った後にもう一度評価すれば、その隙間で起きた遷移も必ず拾える。
 */
export async function waitForParentIdle(
  port: SecondOpinionParentPort,
  signal: AbortSignal,
): Promise<ParentIdleWaitResult> {
  if (signal.aborted) {
    // 購読を1つも張らずに返す。既に止まっていると分かっているものを購読する意味が無い
    return 'cancelled';
  }
  if (port.isParentIdle()) {
    return 'idle';
  }
  return await new Promise<ParentIdleWaitResult>((resolve) => {
    let settled = false;
    /**
     * 決着を1箇所に集める。最初に決着した経路だけを採用し、そのとき購読を必ず解く
     * （`runSingleTurnTask` の `settle()` と同じ流儀。経路ごとに解除を書くと漏れる）。
     *
     * `subscription` は下で宣言する`const`を閉包で掴む。`settle` が呼ばれるのは
     * `onParentStateChanged` が返った後だけなので、未初期化のまま参照されることは無い
     * （購読の登録中に同期でcallbackを呼ぶ実装は想定しない。呼ぶのはview層で、
     * どちらも状態が変わったときだけ呼ぶ）。
     */
    const settle = (result: ParentIdleWaitResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      subscription.dispose();
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const check = (): void => {
      if (port.isParentIdle()) {
        settle('idle');
      }
    };
    const onAbort = (): void => {
      settle('cancelled');
    };
    const subscription = port.onParentStateChanged(check);
    signal.addEventListener('abort', onAbort, { once: true });
    // 購読を張るまでの間に起きた遷移を拾う（lost wakeup対策）。ここを消すと、
    // 「暇ではない」と読んだ直後に暇になった場合、次の状態変化まで待ち続ける
    check();
    if (!settled && signal.aborted) {
      // `addEventListener` を張るまでの間に止められた場合。`abort` は一度きりのため、
      // 張る前に発火していると二度と届かない
      settle('cancelled');
    }
  });
}
