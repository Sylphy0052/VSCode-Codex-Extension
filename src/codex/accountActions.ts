import type { CommandResult, CommandRunner } from '../process/commandRunner';

/**
 * Codexのログイン/ログアウト操作（issue #29、design.mdのTP-53）。
 *
 * `account/login/start` / `account/logout`（app-server経由）ではなく、CLIのトップレベル
 * サブコマンドを直接実行する構成にした。理由は2つ:
 *
 * - `codex login --help` / `codex logout --help` で確認したとおり、どちらも対話端末なしで
 *   完結する（`archive` / `delete` と同じ「破壊操作の実行仕様」がそのまま使える）
 * - ChatGPTアカウントでのログイン（ブラウザを使うOAuth）は、ローカルにコールバックを
 *   受けるサーバーを起動して待つ構成のはずで、`AppServerClient` のように単発リクエストの
 *   直後にプロセスを終了する作りとは相性が悪い。CLIへ委譲すれば、待機やキャンセルの面倒を
 *   拡張機能側で持たずに済む
 *
 * **`account/login/start` は実行していない**（実測ではなくスキーマ根拠のみ。ログイン状態を
 * 変える可能性がある操作を、調査目的で実行しないこととしたため）。
 */
export class CodexAccountActions {
  constructor(
    private readonly runner: CommandRunner,
    private readonly codexPath: () => string,
  ) {}

  /** 資格情報を削除する。`codex logout` は引数無しで完結する（`--help` で確認）。 */
  logout(): Promise<CommandResult> {
    return this.runner.run(this.codexPath(), ['logout']);
  }

  /**
   * APIキーでログインする。
   *
   * `codex login --with-api-key` は標準入力からキーを読む（`--help` の例:
   * `printenv OPENAI_API_KEY | codex login --with-api-key`）。キーは引数ではなく標準入力に
   * 渡すため、プロセス一覧（`ps` 等）に平文で残らない。
   */
  loginWithApiKey(apiKey: string): Promise<CommandResult> {
    return this.runner.run(this.codexPath(), ['login', '--with-api-key'], apiKey);
  }
}
