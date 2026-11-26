/**
 * ワークフローのノードへ渡す指示のうち、ジョブに依らない定型文（Issue #2121）。
 * ジョブごとの指示（`.agents/workflows/*.yaml`のprompt・goal・acceptanceなど）は
 * `runner.ts`の`formatTaskExecutionContract`がここへ組み合わせる。
 *
 * task runの`taskStagePrompts.ts`と同じく、自律改善で教訓を昇格する先になる。そのため保護パス
 * （`.github/self-improve-protected-paths`）には入れない。群分けの鍵になるハッシュは、保護パスの
 * `runMetricsStore.ts`の`hashWorkflowPrompts`がこのファイルの関数だけから計算する。
 */

// 教訓をこのファイルの定型文へ昇格するときは、`lessonPromotion.ts`の`renderPromotedLesson`
// の戻り値（出典がrepo成果物の教訓だけ、固定テンプレート）以外の文を入れない（Issue #2085）。
// 入れる先は`WORKFLOW_PROMOTED_GUIDANCE`の末尾。

/**
 * 昇格した教訓の定型文。空でなければ、実行契約の末尾へ`### 定型の指示`として全ノードへ渡す。
 * 空のうちは実行契約に何も足さない（切り出し前と同じ文字列になる）。
 */
export const WORKFLOW_PROMOTED_GUIDANCE: readonly string[] = [];

/** `task.issue`のあるノードへ、実行契約の中で渡す開発手順。 */
export function formatIssueDevelopmentSteps(issue: number): string[] {
  return [
    '### Issueを正本にした開発手順',
    `- Issue #${String(issue)}の本文（受入条件・実装計画）を、このタスクのSpecの正本として扱う。`,
    '- 実装の完了を宣言する前に、Issueの受入条件と実装計画に照らして成果を確認する。',
    '- このタスクは実装・検証結果を報告して完了する。runnerが設定済みのPR/MR作成、独立レビュー、修正・再レビュー、マージ、cleanupを後続処理として実行する。',
    '- runnerの後続処理の対象外となる工程（sharedタスク、またはPR/MR・レビューが無効な設定）は省略せず、このタスクが既存の開発手順に従って実施結果を報告する。',
    '- Issueの作成・更新とロードマップ改訂は実行タスクでは扱わない。必要な変更はオーケストレーターへ報告し、runnerがcleanup結果をオーケストレーターへ渡す。',
    '',
  ];
}

/** 実行契約へ足す、昇格した教訓の節。教訓が無ければ空の配列。 */
export function formatWorkflowPromotedGuidance(
  guidance: readonly string[] = WORKFLOW_PROMOTED_GUIDANCE,
): string[] {
  return guidance.length === 0 ? [] : ['### 定型の指示', ...guidance.map((g) => `- ${g}`), ''];
}

/**
 * 継続ターンで全文の代わりに送る、実行契約への参照（Issue #1321）。
 *
 * 見出しを `## 実行契約` にしないのは、契約の全文が何個履歴に積まれているかを数える
 * 計測（`countContractOccurrences`。Issue #1320）へ参照まで混ぜないため。参照は数えたい
 * 対象ではなく、混ぜると削減できたかどうかが読めなくなる。
 */
export function formatTaskExecutionContractReference(taskId: string, digest: string): string {
  return [
    '## 実行契約（参照）',
    `Contract: ${taskId} / sha256:${digest}`,
    'このスレッドの最初の指示に全文を載せた実行契約は変わっていない。全体ゴール・受入条件・前提・対象外・成果物・依存タスクから受け取る成果は、その全文のとおりに守って続行する。',
  ].join('\n');
}
