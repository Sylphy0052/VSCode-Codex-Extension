import * as vscode from 'vscode';
import type { Logger } from '../log';

/**
 * タブ名をCodexの要約名に追従させる。
 *
 * VSCodeにはターミナル名を直接書き換えるAPIがなく、
 * `workbench.action.terminal.renameWithArg` は**アクティブなターミナル**に作用する。
 * そのため非アクティブなタブの改名は保留し、そのタブがアクティブになった時に適用する。
 * こうしないと改名のたびにフォーカスを奪うことになる。
 */
export class TerminalRenamer implements vscode.Disposable {
  private readonly pending = new Map<vscode.Terminal, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: Logger) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal !== undefined) {
          void this.flush(terminal);
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => this.pending.delete(terminal)),
    );
  }

  /** 改名を要求する。適用できるのはアクティブな時だけなので、そうでなければ保留する。 */
  async request(terminal: vscode.Terminal, name: string): Promise<void> {
    if (terminal.name === name) {
      return;
    }
    this.pending.set(terminal, name);
    if (vscode.window.activeTerminal === terminal) {
      await this.flush(terminal);
    }
  }

  private async flush(terminal: vscode.Terminal): Promise<void> {
    const name = this.pending.get(terminal);
    if (name === undefined || terminal.name === name) {
      this.pending.delete(terminal);
      return;
    }
    // 念のため。アクティブでない状態で実行すると別のタブを改名してしまう。
    if (vscode.window.activeTerminal !== terminal) {
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
      this.log.info(`タブ名を更新しました: ${name}`);
    } catch (e) {
      this.log.warn(`タブ名の更新に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.pending.delete(terminal);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.pending.clear();
  }
}
