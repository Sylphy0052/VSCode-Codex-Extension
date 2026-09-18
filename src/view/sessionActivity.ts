import type { ChatState } from '../appserver/chatState';

/**
 * セッションの活動状態（issue #286、design.md §14.55。4種化はIssue #1244、
 * 引き継ぎ確認待ちの追加はIssue #1280）。
 *
 * タブ名の先頭の印（`chatView.ts` / `claudeChatView.ts`）と履歴ツリーのアイコン・
 * `description`（`sessionTreeProvider.ts`）の両方が、同じ`ChatState`から独立に
 * 同じ判定を導けるよう純粋関数として切り出す。`vscode`に依存しないため
 * ユニットテストでも実VSCode無しで検証できる（CONTRIBUTINGのレイヤ制約に合わせた
 * 置き場ではないが、`src/view`配下の他の純粋ヘルパー（`relativeTime.ts`）と同じ流儀）。
 *
 * 優先順位は「承認待ち」＞「引き継ぎ確認待ち」＞「実行中」＞「バックグラウンド実行中」
 * ＞「待機中」。承認要求が出ている間も`busy`は`true`のまま（`turn/started`〜
 * `turn/completed`の間はターンが終わっていないため）なので、`busy`だけを見ると
 * 「実行中」の印に埋もれて承認待ちだと気付けない。
 *
 * `handoffPending`を承認待ちの次に置くのは、どちらも人が答えるまで先へ進まない状態
 * だから。承認要求を上に置くのは、そちらがターンの途中で止まっている（実行中の作業を
 * 止めている）ためで、引き継ぎ確認は区切りで止まっている。
 *
 * `backgroundRunning`は会話画面の外周の黄枠（issue #905）と同じ状態を指す。判定材料は
 * `backgroundTerminals`のみで、セカンドオピニオンの実行状態（webview側にしか無い）は
 * 含めない（Issue #1244の確認点: 拡張側から引けないため、初期実装はバックグラウンド
 * ターミナルだけを条件にする）。黄枠側（`chatScript.ts`の`applyBackgroundRunning`）も
 * 同じ理由でセカンドオピニオンを条件から外し、ここと判定を一致させている。
 */
export type SessionActivityState =
  'idle' | 'running' | 'approvalPending' | 'handoffPending' | 'backgroundRunning';

/**
 * @param handoffPending 引き継ぎ先のmodel / effortの確認が保留になっているか
 *   （Issue #1280）。`ChatState`には現れない状態なので、呼び出し側が渡す
 */
export function deriveSessionActivityState(
  state: Pick<ChatState, 'busy' | 'approvals' | 'backgroundTerminals'>,
  handoffPending = false,
): SessionActivityState {
  if (state.approvals.length > 0) {
    return 'approvalPending';
  }
  if (handoffPending) {
    return 'handoffPending';
  }
  if (state.busy) {
    return 'running';
  }
  return state.backgroundTerminals.length > 0 ? 'backgroundRunning' : 'idle';
}

/**
 * タブ名（`WebviewPanel.title`）の先頭に付ける状態の印（issue #286）。
 *
 * `vscode.ThemeIcon`は`WebviewPanel.title`には使えない（VS Code API制約。文字列しか
 * 受け付けない）ため、記号で表す。どれも半角1文字＋空白でタブの限られた幅を
 * 大きくは圧迫しない。`*`は「実行中」の印としてよく使われる記号をそのまま採用し、
 * `!`は「要対応」を示す記号として、承認待ちが実行中より優先度が高いことを示す。
 * `?`は「答えを待っている」印で、引き継ぎ確認待ち（Issue #1280）に使う。
 */
const RUNNING_TITLE_MARKER = '* ';
const APPROVAL_PENDING_TITLE_MARKER = '! ';
const HANDOFF_PENDING_TITLE_MARKER = '? ';

export function decoratePanelTitle(baseTitle: string, activity: SessionActivityState): string {
  switch (activity) {
    case 'approvalPending':
      return `${APPROVAL_PENDING_TITLE_MARKER}${baseTitle}`;
    case 'handoffPending':
      return `${HANDOFF_PENDING_TITLE_MARKER}${baseTitle}`;
    case 'running':
      return `${RUNNING_TITLE_MARKER}${baseTitle}`;
    // バックグラウンド実行中は会話画面の外周の黄枠（issue #905）が既に伝えており、
    // タブ名の印を重ねると「実行中」の印と紛らわしくなる。idleと同じく印を付けない
    case 'backgroundRunning':
    case 'idle':
      return baseTitle;
  }
}

/** 既定の切り詰め長。通知1行に収まる程度の長さ（issue #286）。 */
const DEFAULT_NOTIFICATION_MAX_LEN = 60;

/**
 * 通知本文へ差し込む文字列を安全にする（issue #286）。
 *
 * CLIから届く値（スレッド名・承認要求のtitle等）は未信頼であり、改行や極端に長い
 * 値を含みうる。改行・連続空白を1つの半角空白へ畳み、上限を超えた分は省略記号で
 * 切り詰めることで、`vscode.window.showInformationMessage`の通知が改行だらけに
 * なったり、通知欄からはみ出るほど長くなったりしないようにする。
 */
export function sanitizeForNotification(
  value: string,
  maxLen: number = DEFAULT_NOTIFICATION_MAX_LEN,
): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= maxLen) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLen)}…`;
}
