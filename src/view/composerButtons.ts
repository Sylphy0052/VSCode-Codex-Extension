/**
 * 入力欄アイコン列（`#composerIconRow`）に置けるボタンのID一覧と表示順（issue #296）。
 *
 * 元の並びにチームモードとワークフローViewを足した並びを正準として持つ。`agent.chat.
 * composerButtons`（設定）で表に直接出すボタンを選べるようにし、それ以外はこの並びの
 * まま「…」メニューへ畳む（`chatView.ts`の`renderShell`参照）。`vscode`には依存しない
 * 純粋なロジックのみを置き、`config.ts`・`chatView.ts`の両方から使う。
 */
export const COMPOSER_BUTTON_IDS = [
  'attach',
  'loopToggle',
  'compact',
  'claudeImport',
  'recap',
  'planToggle',
  'fastToggle',
  'review',
  'exportTranscript',
  'workflowMenu',
  'teamWorkflow',
  'workflowView',
  'sessionKanban',
  'forgeHub',
  'openProgress',
  'handoffToNewSession',
  'secondOpinion',
] as const;

export type ComposerButtonId = (typeof COMPOSER_BUTTON_IDS)[number];

const COMPOSER_BUTTON_ID_SET: ReadonlySet<string> = new Set(COMPOSER_BUTTON_IDS);

/** IDが有効なボタンIDかどうか。 */
export function isComposerButtonId(value: unknown): value is ComposerButtonId {
  return typeof value === 'string' && COMPOSER_BUTTON_ID_SET.has(value);
}

/**
 * 表（`#composerIconRow`）に直接出す既定のボタン（Issue #900）。
 *
 * issue #296の時点では正準の並びの先頭4つ（`attach` / `loopToggle` / `compact` /
 * `claudeImport`）だったが、その後に増えた要約・計画・引き継ぎ・セカンドオピニオンの方が
 * 会話中に押す頻度が高い。逆に`claudeImport`（他エージェントからの設定の取り込み）は
 * 会話中ではなく初回の設定時に一度使うもののため「…」メニューへ畳む。
 *
 * ここは**既定値**であり、`agent.chat.composerButtons`を明示した利用者の並びには影響しない。
 */
export const DEFAULT_COMPOSER_BUTTONS: readonly ComposerButtonId[] = [
  'attach',
  'loopToggle',
  'compact',
  'recap',
  'planToggle',
  'handoffToNewSession',
  'secondOpinion',
];

export interface ComposerButtonsResult {
  /** 表に直接並べるID列（この順序で描画する）。 */
  buttons: readonly ComposerButtonId[];
  /**
   * 検証で既定へ丸めた理由。呼び出し側（`chatView.ts` / `claudeChatView.ts`の
   * `attachPanel`）が`this.log.warn`へ出す（`readSessionPresetsConfig`の`warnings`と
   * 同じ「検証はconfig.ts側、ログは呼び出し側」という役割分担）。
   */
  warning?: string;
}

/**
 * `agent.chat.composerButtons`の生値を検証する。
 *
 * 配列でない・未知のIDを含む・重複を含む、のいずれかであれば丸ごと既定
 * （`DEFAULT_COMPOSER_BUTTONS`）へフォールバックする（`config.ts`の
 * `normalizePseudoWorktreeExclude`と同じ「壊れた設定値は既定へ丸める」方針。利用者の
 * 設定ミス1つで一部のボタンだけ消える・重複するといった中途半端な状態を作らないため）。
 * 空配列は「表には何も出さず全部…へ畳む」という有効な指定として受け入れる。
 */
export function normalizeComposerButtons(value: unknown): ComposerButtonsResult {
  if (!Array.isArray(value)) {
    return { buttons: DEFAULT_COMPOSER_BUTTONS };
  }

  const unknownIds = value.filter((v) => !isComposerButtonId(v));
  if (unknownIds.length > 0) {
    return {
      buttons: DEFAULT_COMPOSER_BUTTONS,
      warning: `agent.chat.composerButtons に未知の値が含まれるため既定へ戻しました: ${JSON.stringify(unknownIds)}`,
    };
  }

  const ids = value as ComposerButtonId[];
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    return {
      buttons: DEFAULT_COMPOSER_BUTTONS,
      warning: `agent.chat.composerButtons に同じIDが重複しているため既定へ戻しました: ${JSON.stringify(ids)}`,
    };
  }

  return { buttons: ids };
}

/**
 * 「…」メニューへ畳むボタンのID列。正準の並び（`COMPOSER_BUTTON_IDS`）から、表に
 * 直接出す分（`primaryButtons`）を除いたもの。設定で表の並びを変えても、そこから
 * 漏れたボタンは必ずここに現れる（受入基準「どこからも到達できなくならない」）。
 */
export function overflowComposerButtons(
  primaryButtons: readonly ComposerButtonId[],
): readonly ComposerButtonId[] {
  const primarySet = new Set(primaryButtons);
  return COMPOSER_BUTTON_IDS.filter((id) => !primarySet.has(id));
}
