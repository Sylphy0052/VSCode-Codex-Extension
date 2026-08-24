/**
 * タスク用セッション（`openTaskSession`）のタブ名の組み立て（Issue #533）。
 *
 * `chatView.ts` / `claudeChatView.ts` の `openTaskSession` は、通常のタスク／
 * オーケストレーターセッション（design.md §16.23）／衝突解決セッション
 * （Issue #413 PR4）の3分岐で同じ組み立てをそれぞれ独自に持っていた。CLIラベル
 * （`'Codex'`/`'Claude Code'`）だけを引数化して1つの純粋関数へ切り出す。`vscode`に
 * 依存しないため、`sessionActivity.ts`と同様にユニットテストでも実VSCode無しで検証
 * できる（置き場所の流儀は同ファイルの先頭コメント参照）。
 *
 * `sessionActivity.ts`へ相乗りさせない: あちらは`ChatState`（実行中の状態）からタブの
 * 先頭の印を導く責務、こちらは`TaskSessionInput`（起動時の入力）からタブ名の本体を
 * 組み立てる責務で、扱う対象も呼ばれるタイミングも別。
 */

import type { TaskSessionInput } from '../orchestrator/taskSession';

/**
 * タブ名の組み立てが読む入力。**`TaskSessionInput`から必要な項目だけを導く**
 * （Issue #599）。
 *
 * 当初は`role`と`mergeResolutionTaskId`を手で書き写した独立のinterfaceだったが、
 * **書き写しは元の型が変わっても追随しない。**書き写した瞬間は正しく、その後は誰も
 * 見ていない状態になる（PR #647のレビュー指摘）。`Pick`にすると、元の型で名前や
 * 省略可能性が変わったときに`tsc`が落ちる。
 */
export type SessionPanelTitleInput = Pick<
  TaskSessionInput,
  'role' | 'mergeResolutionTaskId' | 'taskId'
>;

/**
 * 分岐の順序には意味がある。**衝突解決 > オーケストレーター > taskId > ラベルのみ。**
 *
 * 衝突解決セッションは`role`も併せて渡されることがあり（統合worktree上で開くため）、
 * どのタスクの解決かのほうが人には要る。`taskId`を最後から2番目に置くのは、
 * 前2つが立っているときはそちらのほうが情報量が多いため（衝突解決は対象idを既に含み、
 * オーケストレーターはタスクではない）。
 */
export function buildSessionPanelTitle(input: SessionPanelTitleInput, label: string): string {
  if (input.mergeResolutionTaskId !== undefined) {
    return `${label}: 衝突解決 ${input.mergeResolutionTaskId}`;
  }
  if (input.role === 'orchestrator') {
    return `${label}: オーケストレーター`;
  }
  if (input.taskId !== undefined && input.taskId !== '') {
    return `${label}: ${input.taskId}`;
  }
  return label;
}
