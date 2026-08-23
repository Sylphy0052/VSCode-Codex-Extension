import type {
  ControlRequestProgress,
  OriginatedError,
  SideQuestionHistoryEntry,
  SideQuestionResult,
} from './control';

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
 *
 * `result.synthetic === true`（モデルが実際には文章で回答しなかった。design.md §14.62）の
 * ときは、封筒レベルは成功（`ok:true`）でもエラー相当として扱う（`rewind_conversation`の
 * `rewound`と同じく、封筒の外側だけでなく本体のフィールドまで見て判定する必要がある）。
 */
export function finishedSideQuestionDisplay(
  question: string,
  result: SideQuestionResult,
): SideQuestionDisplay {
  if (!result.ok || result.response === undefined) {
    return {
      status: 'failed',
      text: question,
      detail: describeSideQuestionError(result.error),
    };
  }
  if (result.synthetic === true) {
    return {
      status: 'failed',
      text: question,
      detail: describeSyntheticSideQuestionResponse(result.response),
    };
  }
  const fallbackNote =
    result.refusalFallback === undefined
      ? undefined
      : `元のモデル（${result.refusalFallback.originalModel}）が拒否したため、` +
        `${result.refusalFallback.fallbackModel} が代わりに応答しました`;
  const detail = [EPHEMERAL_NOTE, fallbackNote]
    .filter((v): v is string => v !== undefined)
    .join(' ・ ');
  return {
    status: 'completed',
    text: `${question}\n\n${result.response}`,
    detail,
  };
}

/** CLI由来のエラーを丸めたときに画面へ出す固定文言。 */
const GENERIC_SIDE_QUESTION_ERROR_MESSAGE =
  '脇道の質問を送れませんでした（CLI側でエラーが発生しました）';

/**
 * 制御応答の封筒レベルの失敗（`response.ok === false`）を、利用者向けの文言へ変換する。
 *
 * 実測（design.md §14.62、`/tmp`の実測記録）で分かったのは、この経路（構造エラー。
 * `history`が配列でない等）は`subtype:"error"`の封筒で返り、`error`には**CLI内部のJS
 * 例外メッセージがそのまま**入る（例: `Bt.map is not a function...`）ということ。
 * `describeForkFromTurnError`（issue #494）のような既知のエラー文字列カタログは作れない
 * ——rewind_conversationの`turn running`等と違い、この文言は安定したエラーコードではなく
 * 実行時ごとに変わりうる内部実装依存の例外テキストだからである。そのため個別マッピングは
 * せず、`origin:'cli'`（＝`response.ok === false`起因）のときだけ常に汎用文言へ丸める
 * （そのまま画面へ出すと内部実装が露出する）。
 *
 * `origin:'app'`（`streamSession.ts`のガードや、成功封筒なのに応答本文が読めず
 * `payload.error`も無いときの拡張機能側の固定文言）は既に利用者向けの文言のため、
 * 丸めずそのまま返す（issue #340横断レビュー指摘。以前は引数を無視して常に汎用文言を
 * 返しており、拡張機能自身が作ったエラーまでCLI由来として誤表示していた）。逆に
 * `payload.error`が入っている場合はCLIが封筒に乗せてきた値なので`origin:'cli'`となり、
 * ここで汎用文言へ丸められる（issue #340確認レビュー再指摘: 成功封筒だからという理由で
 * `'app'`にしていたのは誤りだった）。丸めた元の文言は
 * 画面には出さないが、開発者向けの内部ログには残す（`streamSession.ts`が`receive`で
 * `result.error?.origin === 'cli'`を見て`this.log.warn`へ残す。セキュリティ監査の指摘:
 * 汎用文言へ丸めた元のエラーがどこにも残らず、CLI側の予期しない構造エラーが多発した
 * ときに原因調査ができない）。
 */
export function describeSideQuestionError(error: OriginatedError | undefined): string {
  if (error === undefined || error.origin === 'cli') {
    return GENERIC_SIDE_QUESTION_ERROR_MESSAGE;
  }
  return error.message;
}

/**
 * `synthetic:true`（モデルが実際には文章で回答しなかった）の応答本文を、利用者向けの
 * 説明へ変換する。
 *
 * `response`にはCLIが生成した英語固定のプレースホルダ文言が入る（実測、バイナリの
 * `mZE()`関数解析。design.md §14.62参照）。`describeForkFromTurnError`と同じ考え方で、
 * 既知の2パターン（モデルがツール呼び出しを試みた場合／APIエラー時）は日本語の説明を
 * 前に添えて残し、未知のパターンは汎用文言へ丸める。**この2パターンはソース読みのみで
 * 実発火は未確認**（design.md §14.62「未確認」参照）だが、プレースホルダ文言そのものは
 * 捨てずに残すため、パターンを外しても利用者が読める情報は失われない。
 */
export function describeSyntheticSideQuestionResponse(response: string): string {
  if (/^\(The model tried to call /.test(response)) {
    return (
      'モデルがツール呼び出しを試みたため、直接の回答は得られませんでした。' +
      `質問を言い換えるか、主会話で聞いてください（CLIの応答: ${response}）`
    );
  }
  if (/^\(API error:/.test(response)) {
    return `APIエラーのため応答を生成できませんでした（CLIの応答: ${response}）`;
  }
  return `モデルは実際には回答しませんでした（CLIの応答: ${response}）`;
}

/**
 * このタブで送った脇道の質問の履歴（`history`としてCLIへ渡す）に持たせる上限件数
 * （issue #334のレビュー指摘）。
 *
 * `/btw`を送るたびに`sideQuestionHistory`へ追記していく実装のままだと、質問・応答の
 * 全文が1タブ内で無制限に積み上がり、以後の全ての`side_question`リクエストの
 * ペイロードへ単調増加した状態で乗り続ける。
 */
export const MAX_SIDE_QUESTION_HISTORY = 20;

/**
 * `sideQuestionHistory`を上限件数へ収める。
 *
 * 「超えた分を1件の要約エントリへまとめる」方式（`roadmap.ts`の
 * `MAX_ROADMAP_PARSE_WARNINGS`等、他のワークフローで採用している形）は採らない。
 * `history`はCLIへそのまま渡りモデルが実際の質問・応答として読むため、そこへ「N件省略」
 * のような拡張機能側のメタ情報を実際のQ/Aの形で混ぜ込むと、モデルが実在しないやり取りを
 * 実際の会話として解釈しかねない。そのため方式は**古いものから単純に捨てる（FIFO）**に
 * 統一し、直近`MAX_SIDE_QUESTION_HISTORY`件だけを残す（design.md §14.62参照）。
 */
export function capSideQuestionHistory(
  history: readonly SideQuestionHistoryEntry[],
): SideQuestionHistoryEntry[] {
  return history.length <= MAX_SIDE_QUESTION_HISTORY
    ? [...history]
    : history.slice(history.length - MAX_SIDE_QUESTION_HISTORY);
}
