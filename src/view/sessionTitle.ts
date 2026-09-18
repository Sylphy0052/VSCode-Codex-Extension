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

import { roleLabel } from '../orchestrator/rolePresets';
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
  'role' | 'mergeResolutionTaskId' | 'taskId' | 'issue' | 'teamRole' | 'generation'
>;

/**
 * 同じタスクを分割（`onContextLow: split`。Issue #1273）で開き直したときの世代の印。
 *
 * 書式はチャットの自動引き継ぎ（`view/handoff.ts` の `buildHandoffSessionName`。
 * Issue #1145・#1255）と同じ `(続きN)` に揃える。人から見て「同じ作業の続き」であることが
 * どちらの経路でも同じ見え方になるようにするため。1代目（通常の起動）には付けない。
 */
function generationSuffix(generation: number | undefined): string {
  return generation !== undefined && Number.isSafeInteger(generation) && generation >= 2
    ? ` (続き${generation})`
    : '';
}

/**
 * 分岐の順序には意味がある。**衝突解決 > オーケストレーター > 識別子と役割 > ラベルのみ。**
 *
 * 衝突解決セッションは`role`も併せて渡されることがあり（統合worktree上で開くため）、
 * どのタスクの解決かのほうが人には要る。識別子と役割を最後から2番目に置くのは、
 * 前2つが立っているときはそちらのほうが情報量が多いため（衝突解決は対象idを既に含み、
 * オーケストレーターはタスクではない）。
 *
 * 通常のタスクではCLIラベルの接頭辞（`'Codex: '`/`'Claude Code: '`）を付けない
 * （Issue #1201）。タブの幅は限られており、実行中・承認待ちの印（`sessionActivity.ts`の
 * `decoratePanelTitle`）も先頭に付く。どのCLIかは毎回同じ文字数を食う割に、並んだタブを
 * 見分ける手掛かりにはならない。識別子も役割も無いときだけ、タブ名が空になるのを避ける
 * ためのフォールバックとしてラベルを使う。
 */
export function buildSessionPanelTitle(input: SessionPanelTitleInput, label: string): string {
  const suffix = generationSuffix(input.generation);
  if (input.mergeResolutionTaskId !== undefined) {
    return `衝突解決 ${input.mergeResolutionTaskId}${suffix}`;
  }
  if (input.role === 'orchestrator') {
    return `進行役${suffix}`;
  }
  // Issue番号はタスクidより人にとっての意味が強い（何の作業かを追える）ため優先する。
  // どちらも無いタスク（定義ファイルに`issue`が無く、自動起票もされていない）では
  // 従来どおりタスクidへ落ちる
  const identifier =
    input.issue !== undefined
      ? `#${input.issue}`
      : input.taskId !== undefined && input.taskId !== ''
        ? input.taskId
        : undefined;
  const role = input.teamRole !== undefined ? roleLabel(input.teamRole) : undefined;
  const parts = [identifier, role].filter((part): part is string => part !== undefined);
  return `${parts.length > 0 ? parts.join(' ') : label}${suffix}`;
}
