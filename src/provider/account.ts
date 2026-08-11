/**
 * ログイン状態の表示（TP-53、issue #29）で共有する型。
 *
 * CodexとClaude Codeでログイン状態を読む経路はまったく違うが（`src/codex/accountStatus.ts` /
 * `src/claude/authStatus.ts` を参照）、画面へ渡す最終形はここへ揃える。
 * 設定パネル（`src/view/controlPanelScript.ts`）はこの形だけを見ればよい。
 *
 * **秘密情報は持たせない**。トークンやAPIキーの値はここに含めず、表示するのは
 * ログイン済みかどうか・ログイン方式・アカウントの識別子（メールアドレス等）・
 * プランまでに留める。
 */
export interface AccountView {
  loggedIn: boolean;
  /** ログイン方式の人が読める説明（例: 'ChatGPTアカウント' 'APIキー' 'Claude.aiサブスクリプション'）。 */
  method: string | undefined;
  /** メールアドレスなど、アカウントを識別する文字列。 */
  identity: string | undefined;
  /** プランなど補足情報。 */
  plan: string | undefined;
}

/**
 * ログイン状態を取得できたかどうかを型で分ける。
 *
 * 「未ログイン」と「取得に失敗した」を区別しないと、CLIが古い・app-serverが
 * 起動しないといった状況で誤って「未ログイン」と出してしまう
 * （design.md の「黙って何も起きない状態を作らない」に反する）。
 */
export type AccountSnapshot = { ok: true; account: AccountView } | { ok: false; reason: string };

/** ログイン状態を取得する前の初期値。CLIへの問い合わせが「未ログインだった」のと区別する。 */
export const accountNotLoadedYet: AccountSnapshot = { ok: false, reason: 'まだ読み込んでいません' };
