import * as vscode from 'vscode';
import type { WorkflowRunSnapshot } from '../orchestrator/runner';
import type { ManagedChatSession } from './chatManagerBase';

export type AttentionTarget =
  | { kind: 'chat'; provider: 'codex' | 'claude'; threadId: string }
  | { kind: 'workflow'; runId: string; taskId: string };

export interface AttentionItem {
  readonly label: string;
  readonly detail: string;
  readonly target: AttentionTarget;
}

/** 人の操作が必要な既存状態を、所有せずにサイドバーへ投影する。 */
export function buildAttentionItems(
  chats: readonly (ManagedChatSession & { provider: 'codex' | 'claude' })[],
  snapshots: readonly WorkflowRunSnapshot[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const chat of chats) {
    if (chat.activity === 'approvalPending') {
      items.push({
        label: chat.title,
        detail: `${chat.provider === 'codex' ? 'Codex' : 'Claude Code'}・承認待ち`,
        target: { kind: 'chat', provider: chat.provider, threadId: chat.threadId },
      });
    }
  }
  for (const snapshot of snapshots) {
    for (const task of snapshot.tasks) {
      if (task.state === 'waitingApproval') {
        items.push({
          label: task.id,
          detail: `${snapshot.name}・承認待ち`,
          target: { kind: 'workflow', runId: snapshot.runId, taskId: task.id },
        });
      }
    }
  }
  return items.sort((a, b) => attentionSortKey(a).localeCompare(attentionSortKey(b), 'en'));
}

/** 状態に発生時刻が無いため、一覧の順序は発生源とその安定識別子だけで決める。 */
function attentionSortKey(item: AttentionItem): string {
  if (item.target.kind === 'chat') {
    return `chat:${item.target.provider}:${item.target.threadId}`;
  }
  return `workflow:${item.target.runId}:${item.target.taskId}`;
}

export class AttentionIndexProvider implements vscode.TreeDataProvider<AttentionItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<AttentionItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly read: () => readonly AttentionItem[]) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: AttentionItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    treeItem.description = item.detail;
    treeItem.tooltip = `${item.label}\n${item.detail}`;
    treeItem.iconPath = new vscode.ThemeIcon('bell-dot');
    treeItem.contextValue = 'agentAttention';
    treeItem.command = { command: 'agent.attention.open', title: '開く', arguments: [item.target] };
    return treeItem;
  }

  getChildren(): AttentionItem[] {
    return [...this.read()];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
