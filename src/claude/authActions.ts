import type { CommandResult, CommandRunner } from '../process/commandRunner';

/**
 * Claude Codeのログアウト操作（issue #29、design.mdのTP-53）。
 *
 * `claude auth --help` で確認したサブコマンド構成: `claude auth login` / `claude auth
 * logout` / `claude auth status`。`logout` は追加の入力を要求せず完結する
 * （`claude auth logout --help` にオプションが無いことで確認）。
 *
 * **ログインの実装は無い**。`claude auth login` はブラウザでのOAuthを前提にした対話的な
 * コマンドで、APIキーのような非対話の代替経路が見つからなかった（`--help` にAPIキーを
 * 渡すオプションが無い）。ログインはターミナルへの案内に留める
 * （`src/view/controlPanelView.ts` を参照）。
 *
 * **`claude auth login` / `claude auth logout` は実行していない**（実測ではなくスキーマ・
 * ヘルプ根拠のみ。ログイン状態を変える可能性がある操作を、調査目的で実行しないことと
 * したため）。
 */
export class ClaudeAuthActions {
  constructor(
    private readonly runner: CommandRunner,
    private readonly claudePath: () => string,
  ) {}

  logout(): Promise<CommandResult> {
    return this.runner.run(this.claudePath(), ['auth', 'logout']);
  }
}
