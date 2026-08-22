import type { ControlRequestProgress, SideQuestionResult } from './control';

/**
 * 脇道の質問（issue #334、design.md §14.62、Codex TUIの `/btw` 相当）の見せ方。
 *
 * `vscode` を一切importしない純粋なロジック層。`ClaudeStreamSession`（送受信）とも
 * `claudeChatView.ts`（画面）とも分離し、ユニットテストで検証できるようにする。
 * `control.ts` が読んだ生の応答（`SideQuestionResult`）を、会話へ1項目として残す
 * ための表示用の形（`SideQuestionDisplay`）へ変換する。
 */

/** 会話へ残す1項目の中身。`ChatItem` の `text` / `detail` / `status` にそのまま入れる。 */
export interface SideQuestionDisplay {
  status: 'inProgress' | 'completed' | 'failed';
  text: string;
  detail: string;
}

/**
 * 「本流の会話には残らない」旨の固定の注記。
 *
 * 実測（design.md §14.62）で痕跡が残らないことを確認済みだが、確認したのはこの拡張機能の
 * 実装時点（CLI 2.1.235）の挙動でしかない。CLIの更新で挙動が変わっても気付けるよう、
 * 「残らない」と断定する文言ではなく「この画面だけの一時的なやり取り」であることを
 * 常に見せる（受入基準「残る場合はその旨が画面から分かる」に対する保険でもある）。
 */
const EPHEMERAL_NOTE = 'このタブだけの一時的なやり取りです（本流の会話には送られません）';

/** 送信直後、応答が届く前の表示。 */
export function pendingSideQuestionDisplay(question: string): SideQuestionDisplay {
  return { status: 'inProgress', text: question, detail: '送信中…' };
}

/**
 * `control_request_progress` の1件を、画面に出す短い注記へ変換する。
 *
 * 実測（design.md §14.62）で確認できた `status` は `started` と `api_retry` の2種類。
 * `started` は「送った」以上の情報が無いため注記を出さない（`pendingSideQuestionDisplay`
 * の「送信中…」のままでよい）。`api_retry` はモデル呼び出しの再試行中で、何も出さないと
 * 応答が返らないまま固まって見えるため、attempt/retry_delay_msをそのまま文にする。
 * 未知の`status`値は将来CLIが増やす可能性があるため、意味を決め打ちせず空文字を返す
 * （呼び出し側は「表示を更新しない」として扱う）。
 */
export function describeSideQuestionProgress(progress: ControlRequestProgress): string {
  if (progress.status !== 'api_retry') {
    return '';
  }
  const parts: string[] = ['リトライ中'];
  if (progress.attempt !== undefined && progress.maxRetries !== undefined) {
    parts.push(`(${progress.attempt}/${progress.maxRetries})`);
  }
  if (progress.retryDelayMs !== undefined) {
    parts.push(`・${Math.round(progress.retryDelayMs / 1000)}秒後に再試行`);
  }
  if (progress.errorStatus !== undefined) {
    parts.push(`（${progress.errorStatus}）`);
  }
  return parts.join(' ');
}

/** `describeSideQuestionProgress` の結果を、待機中の表示へ反映する。空文字なら更新しない。 */
export function progressSideQuestionDisplay(
  question: string,
  progress: ControlRequestProgress,
): SideQuestionDisplay | undefined {
  const note = describeSideQuestionProgress(progress);
  return note === '' ? undefined : { status: 'inProgress', text: question, detail: note };
}

/**
 * 応答が届いた後の表示。
 *
 * 成功時は質問と応答をひとつの本文にまとめる（Codex側の脇道の質問は新しいタブへ通常の
 * 会話として差し込む＝質問と応答が別々の発言として並ぶが、Claude Code側は新しいタブを
 * 作らず1項目に収めるため、見た目を揃えるにはQ/Aを1つの本文の中で明示する必要がある）。
 * `refusalFallback` が付いていれば（元のモデルが拒否し別モデルへ切り替わった）、
 * その旨を注記へ足す。
 */
export function finishedSideQuestionDisplay(
  question: string,
  result: SideQuestionResult,
): SideQuestionDisplay {
  if (!result.ok || result.response === undefined) {
    return {
      status: 'failed',
      text: question,
      detail: `脇道の質問を送れませんでした: ${result.error ?? '不明なエラー'}`,
    };
  }
  const fallbackNote =
    result.refusalFallback === undefined
      ? undefined
      : `元のモデル（${result.refusalFallback.originalModel}）が拒否したため、` +
        `${result.refusalFallback.fallbackModel} が代わりに応答しました`;
  const detail = [EPHEMERAL_NOTE, fallbackNote].filter((v): v is string => v !== undefined).join(
    ' ・ ',
  );
  return {
    status: 'completed',
    text: `${question}\n\n${result.response}`,
    detail,
  };
}
