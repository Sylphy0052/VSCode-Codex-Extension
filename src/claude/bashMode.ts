import { NO_DIFFS, type ChatItem } from '../appserver/chatState';
import type { ShellCommandResult } from '../process/shellCommandRunner';

/**
 * 会話へ足す項目を組み立てる純粋関数（design.md §14.29、Issue #5）。
 *
 * 表示は既存の `commandExecution` 種別を使い回す（`chatScript.ts` が既に
 * ラベル・状態・切り詰め注記の表示を持っているため、Webview側の変更は不要）。
 */

/** bashモードが無効な状態で `!` が打たれたときに会話へ残す通知。 */
export function buildBashModeDisabledNotice(id: string): ChatItem {
  return {
    id,
    kind: 'settingsChanged',
    text: '',
    detail:
      'bashモードが無効なため実行しませんでした（設定claude.bashMode.enabledで有効にできます）。',
    status: undefined,
    turnId: undefined,
    diffs: NO_DIFFS,
  };
}

/**
 * 実行を始めた直後に足す「実行中」の項目。完了時に同じidで上書きする。
 *
 * `text: ''` にしてあるのは意図的。`upsertItem`（`appserver/chatState.ts`）は
 * 「`item.text === ''` なら既存の `text` / `truncated` を維持する」というマージ規則を持つ
 * （CLIが差分（デルタ）で本文を少しずつ積み上げる方式に対応するため）。この項目も、
 * 出力ゼロで完了する `buildCompletedCommandItem` の項目も `text` が空文字列のままなので
 * 現状は辻褄が合っているが、将来ここへ「実行中…」のようなプレースホルダ文言を
 * 入れると、出力ゼロのまま完了したときにその文言が消えなくなる（`upsertItem` が
 * 「空なら既存を維持」と解釈してしまうため）。プレースホルダを足すときはこの結合に注意する。
 */
export function buildRunningCommandItem(id: string, command: string): ChatItem {
  return {
    id,
    kind: 'commandExecution',
    text: '',
    detail: command,
    status: 'running',
    turnId: undefined,
    diffs: NO_DIFFS,
  };
}

/**
 * 実行結果を会話の項目にする。
 *
 * 失敗（非ゼロ終了・タイムアウト・中断・シェル起動失敗）は理由が本文からも分かるよう、
 * 該当するメッセージを本文の先頭に添える（受入基準）。
 *
 * `status` には日本語の文字列をそのまま入れている。`chatScript.ts` の `STATUS_LABEL`
 * （app-serverが返す英語キーを日本語ラベルへ変換する表）は通らず、`STATUS_LABEL[status]
 * || status` のフォールバック（後段の `|| status`）でそのまま表示される。CLIの状態語彙
 * （`running` / `completed` 等）と混ぜず、この機能専用の日本語状態文字列を直接返す
 * という意図的な選択（`running` だけは既存の英語キーと衝突しても意味が同じなので
 * そのまま使っている）。
 */
export function buildCompletedCommandItem(
  id: string,
  command: string,
  result: ShellCommandResult,
  timeoutMs: number,
): ChatItem {
  const parts: string[] = [];
  if (result.spawnError !== undefined) {
    parts.push(`起動できませんでした: ${result.spawnError}`);
  } else if (result.aborted) {
    parts.push('中断しました（画面を閉じた、または拡張機能の終了によって打ち切りました）');
  } else if (result.timedOut) {
    parts.push(`タイムアウトしました（${timeoutMs}ms）`);
  }
  if (result.stdout !== '') {
    parts.push(result.stdout);
  }
  if (result.stderr !== '') {
    parts.push(`[stderr]\n${result.stderr}`);
  }

  const status =
    result.spawnError !== undefined
      ? '起動失敗'
      : result.aborted
        ? '中断'
        : result.timedOut
          ? 'タイムアウト'
          : typeof result.code === 'number'
            ? `exit ${result.code}`
            : '失敗';

  return {
    id,
    kind: 'commandExecution',
    text: parts.join('\n\n'),
    detail: command,
    status,
    turnId: undefined,
    diffs: NO_DIFFS,
    truncated: result.truncated,
  };
}

/**
 * `ShellCommandRunner.run` 自体が例外を投げた場合（想定外の異常。通常の失敗は
 * `ShellCommandResult` が表現するため `buildCompletedCommandItem` を使う）に、
 * 「実行中」の項目を同じidで畳む。fire-and-forgetのまま例外が握り潰され、
 * 「実行中」が残り続けるのを防ぐ（`ClaudeChatViewManager.runBashMode` のtry/catch参照）。
 */
export function buildBashModeErrorItem(id: string, command: string, reason: string): ChatItem {
  return {
    id,
    kind: 'commandExecution',
    text: `失敗しました: ${reason}`,
    detail: command,
    status: '失敗',
    turnId: undefined,
    diffs: NO_DIFFS,
  };
}
