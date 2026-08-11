import { isValidPluginName } from '../provider/plugins';
import type { CommandResult, CommandRunner } from '../process/commandRunner';

const invalidNameResult: CommandResult = { code: 1, stderr: '不正なplugin名です' };

/**
 * Claude Codeのplugin有効/無効・インストール/アンインストール操作（issue #32、design.md §14.20）。
 *
 * `claude plugin --help` で見つかった専用サブコマンド一式をそのまま使う。すべて非対話で
 * 完結する（`enable` / `disable` / `install` / `uninstall` いずれも確認プロンプトを持たない。
 * `uninstall --prune` だけ確認を要するが、ここでは `--prune` を渡さないため対象外）。
 *
 * **`enable` / `install` / `uninstall` は実行していない**（実測ではなく `--help` 根拠のみ。
 * この環境のplugin設定を変える可能性がある操作を、調査目的で実行しないこととしたため）。
 * `disable --help` の出力とusageの対称性から `enable` の引数構成を推定した
 * （`claude plugin --help` の一覧に `enable [options] <plugin>  Enable a disabled plugin`
 * と載っている）。
 */
export class ClaudePluginActions {
  constructor(
    private readonly runner: CommandRunner,
    private readonly claudePath: () => string,
  ) {}

  /** `claude plugin enable <id> [-s <scope>]`。 */
  enable(id: string, scope: string | undefined): Promise<CommandResult> {
    return this.run('enable', id, scope);
  }

  /** `claude plugin disable <id> [-s <scope>]`。 */
  disable(id: string, scope: string | undefined): Promise<CommandResult> {
    return this.run('disable', id, scope);
  }

  /**
   * `claude plugin uninstall <id> -y [-s <scope>]`。
   *
   * `-y` は `--prune` の確認プロンプトをスキップするフラグ（`--help` の説明）。ここでは
   * `--prune` を渡していないため実質的な効果は無いが、非TTY環境でCLIが確認待ちのまま
   * 止まる経路を先回りして塞ぐ。
   */
  uninstall(id: string, scope: string | undefined): Promise<CommandResult> {
    return this.run('uninstall', id, scope, ['-y']);
  }

  /**
   * `claude plugin install <spec>`。
   *
   * `spec` は `<name>` または `<name>@<marketplace>`（`--help` の説明どおり）。呼び出し側
   * （`SettingsProvider.installClaudePlugin`）が確認ダイアログで「何をどこから入れるか」を
   * 明示してから呼ぶこと。
   */
  install(spec: string, scope: string | undefined): Promise<CommandResult> {
    if (!isValidPluginName(spec)) {
      return Promise.resolve(invalidNameResult);
    }
    const args = ['plugin', 'install', spec];
    if (scope !== undefined && scope !== '') {
      args.push('-s', scope);
    }
    return this.runner.run(this.claudePath(), args);
  }

  private run(
    subcommand: 'enable' | 'disable' | 'uninstall',
    id: string,
    scope: string | undefined,
    extraArgs: string[] = [],
  ): Promise<CommandResult> {
    if (!isValidPluginName(id)) {
      return Promise.resolve(invalidNameResult);
    }
    const args = ['plugin', subcommand, id, ...extraArgs];
    if (scope !== undefined && scope !== '') {
      args.push('-s', scope);
    }
    return this.runner.run(this.claudePath(), args);
  }
}
