import * as vscode from 'vscode';
import type { TerminalSessionManager } from '../terminal/terminalSessionManager';
import {
  assignPositions,
  collectTerminalTabPositions,
  normalizePersistedTabs,
  type PersistedTab,
  type TabGroupLike,
} from './tabState';

const KEY = 'codex.openTabs.v1';

/**
 * 開いているセッションのタブ構成を workspaceState に保持する。
 *
 * 対象は紐付けが確定したタブのみ。session idが判らないタブを記録すると、
 * 次回起動で誤ったセッションを開く恐れがある（設計書 §9.1）。
 */
export class TabStateStore {
  constructor(private readonly memento: vscode.Memento) {}

  load(): PersistedTab[] {
    return normalizePersistedTabs(this.memento.get(KEY));
  }

  async save(tabs: readonly PersistedTab[]): Promise<void> {
    await this.memento.update(KEY, tabs);
  }

  async clear(): Promise<void> {
    await this.memento.update(KEY, []);
  }

  /** 現在のタブ構成を読み取って保存する。 */
  async capture(manager: TerminalSessionManager): Promise<void> {
    const tracked = manager.trackedSessions();
    if (tracked.length === 0) {
      await this.save([]);
      return;
    }

    const positions = collectTerminalTabPositions(readTabGroups());
    const assigned = assignPositions(
      tracked.map((t) => t.terminal.name),
      positions,
    );

    const tabs: PersistedTab[] = tracked.map((t, i) => ({
      sessionId: t.sessionId as string,
      viewColumn: assigned[i]?.viewColumn ?? 1,
      order: assigned[i]?.order ?? 0,
      cwd: t.cwd,
      threadName: t.threadName,
    }));

    await this.save(tabs);
  }
}

function readTabGroups(): TabGroupLike[] {
  return vscode.window.tabGroups.all.map((group) => ({
    viewColumn: group.viewColumn,
    tabs: group.tabs.map((tab) => ({
      label: tab.label,
      isTerminal: tab.input instanceof vscode.TabInputTerminal,
    })),
  }));
}
