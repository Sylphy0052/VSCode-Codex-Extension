/**
 * 通常チャット（Codex・Claude）で、拡張がユーザーの発言へ付ける共通の指示の定型文（Issue #2121）。
 *
 * 切り出した時点で、拡張が通常チャットへ常に付ける指示は無かった（Codexの`thread/start`に
 * developer instructionsは無く、Claudeにも`--append-system-prompt`を付けない。メリデメ説明と
 * ターン要約の指示は設定で既定が無効）。そのため、昇格した教訓を差し込む欄だけを置く。
 * 差し込む位置は、チャット画面から手動で送る発言の末尾（`prosCons.ts`の
 * `appendManualSendInstructions`）で、メリデメ説明・ターン要約の指示より前。
 *
 * task runの`taskStagePrompts.ts`と同じく、自律改善で教訓を昇格する先になる。そのため保護パス
 * （`.github/self-improve-protected-paths`）には入れない。群分けの鍵になるハッシュは、保護パスの
 * `src/orchestrator/runMetricsStore.ts`の`hashChatPrompts`がこのファイルの関数だけから計算する。
 *
 * `vscode`に依存しない純粋なロジックだけを置く。
 */

// 教訓をこのファイルの定型文へ昇格するときは、`lessonPromotion.ts`の`renderPromotedLesson`
// の戻り値（出典がrepo成果物の教訓だけ、固定テンプレート）以外の文を入れない（Issue #2085）。
// 入れる先は`CHAT_PROMOTED_GUIDANCE`の末尾。

/** 昇格した教訓の定型文。空のうちは発言に何も足さない（切り出し前と同じ文字列になる）。 */
export const CHAT_PROMOTED_GUIDANCE: readonly string[] = [];

/**
 * 手動で送る発言の末尾へ、昇格した教訓の定型文を連結する。教訓が無いとき・本文が空白だけの
 * ときは本文をそのまま返す（ターン要約の指示と同じく、空の発言に指示だけを送らない）。
 */
export function appendChatPromotedGuidance(
  text: string,
  guidance: readonly string[] = CHAT_PROMOTED_GUIDANCE,
): string {
  if (guidance.length === 0 || text.trim() === '') {
    return text;
  }
  return `${text.replace(/\s+$/u, '')}\n\n${guidance.join('\n')}`;
}
