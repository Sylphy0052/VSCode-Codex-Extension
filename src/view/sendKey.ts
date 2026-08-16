/**
 * 送信キーの設定（`agent.chat.sendOn`、issue #288）。
 *
 * `ctrlEnter`（既定）: Ctrl+Enter / Cmd+Enterで送信、Enterは改行のまま（従来の挙動）。
 * `enter`: Enterで送信、Shift+Enterで改行。Ctrl+Enter / Cmd+Enterでも送信できる
 * （`ctrlEnter`に慣れた手が使えなくならないように、送信自体は両モードで維持する）。
 */
export type SendOnMode = 'ctrlEnter' | 'enter';

export const DEFAULT_SEND_ON: SendOnMode = 'ctrlEnter';

/** 設定の生値を安全な`SendOnMode`へ丸める。未知の値は既定へ落とす。 */
export function normalizeSendOn(value: unknown): SendOnMode {
  return value === 'enter' ? 'enter' : DEFAULT_SEND_ON;
}

/**
 * webview側のkeydownハンドラへ渡す最小限のキーイベント形。DOMの`KeyboardEvent`をそのまま
 * 渡せる形にしてあるが、`vscode`はもちろんDOMにも依存しない（テスト容易性のため）。
 */
export interface SendKeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /**
   * IME変換中かどうか。`KeyboardEvent.isComposing`、または`compositionstart`〜
   * `compositionend`の間を追跡した値のいずれか一方でもtrueなら渡すこと
   * （`chatScript.ts`側の呼び出し参照。片方だけに頼るとブラウザ差で取りこぼす）。
   */
  readonly isComposing: boolean;
}

export type SendKeyAction = 'send' | 'ignore';

/**
 * 入力欄のEnterキー押下で送信すべきかを決める純粋関数（issue #288）。
 *
 * **候補メニュー（`/` `@`）が開いているときの確定はこの関数を呼ばない。**
 * `chatScript.ts`の`menuOpen()`ブロックが先に判定し、真であれば（Ctrl/Cmd+Enterを除く）
 * `acceptItem`へ回す。既存のその分岐は変更しておらず、ここで扱うのはメニューが閉じている
 * ときのEnterだけ。
 *
 * IME変換中（`isComposing`）は常に`ignore`。変換確定のEnterと送信のEnterを区別できず、
 * 変換確定を送信に奪われると日本語入力が使い物にならないため（issue本文）。
 */
export function decideSendKeyAction(event: SendKeyEventLike, sendOn: SendOnMode): SendKeyAction {
  if (event.key !== 'Enter') {
    return 'ignore';
  }
  if (event.isComposing) {
    return 'ignore';
  }
  if (event.ctrlKey || event.metaKey) {
    // Ctrl/Cmd+Enterはモードに関わらず送信する（`ctrlEnter`に慣れた手を潰さない）。
    return 'send';
  }
  if (sendOn === 'enter' && !event.shiftKey) {
    return 'send';
  }
  return 'ignore';
}

/**
 * webviewへ埋め込む`decideSendKeyAction`の実装（issue #288）。
 *
 * webview側のスクリプト（`chatScript.ts`）はテンプレートリテラルの中身でTypeScriptとして
 * 実行できないため、`stateDelta.ts`の`MERGE_ITEMS_SOURCE`・`markdown.ts`の
 * `MARKDOWN_PARSE_SOURCE`と同じ流儀で、同じロジックをJSソース文字列として二重に持ち、
 * `chatScript.ts`へ差し込む。実装を1か所に書いて両側へコピーしないと片方だけ直したときに
 * 黙ってずれるが、テンプレートリテラルの中はTypeScriptとして実行できないため二重管理を
 * 避けられない。`test/unit/sendKey.test.ts`は`SEND_KEY_SOURCE`を`new Function`で評価し、
 * TS実装と同じ結果になることを確かめ、乖離を検知する。
 */
export const SEND_KEY_SOURCE = `function decideSendKeyAction(event, sendOn) {
    if (event.key !== 'Enter') return 'ignore';
    if (event.isComposing) return 'ignore';
    if (event.ctrlKey || event.metaKey) return 'send';
    if (sendOn === 'enter' && !event.shiftKey) return 'send';
    return 'ignore';
  }`;
