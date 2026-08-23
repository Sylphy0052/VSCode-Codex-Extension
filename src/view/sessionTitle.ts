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

export interface SessionPanelTitleInput {
  role?: 'task' | 'orchestrator';
  mergeResolutionTaskId?: string;
}

export function buildSessionPanelTitle(input: SessionPanelTitleInput, label: string): string {
  if (input.mergeResolutionTaskId !== undefined) {
    return `${label}: 衝突解決 ${input.mergeResolutionTaskId}`;
  }
  if (input.role === 'orchestrator') {
    return `${label}: オーケストレーター`;
  }
  return label;
}
