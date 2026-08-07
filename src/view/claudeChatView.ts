import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState } from '../appserver/chatState';
import type { ClaudeSessionStore } from '../claude/sessionStore';
import { ClaudeStreamSession } from '../claude/streamSession';
import { transcriptItems } from '../claude/transcript';
import { isUnsafeClaudeCombination } from '../claude/argvBuilder';
import { currentWorkspaceFolder, readClaudeConfig } from '../config';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import { renderShell } from './chatView';
import type { ChatActivity } from './chatView';

interface ClaudePanel {
  panel: vscode.WebviewPanel;
  session: ClaudeStreamSession;
  cwd: string;
}

const VIEW_TYPE = 'claude.chat';
const LABEL = 'Claude Code';

/**
 * Claude Code画面。`claude` を stream-json で常駐させ、会話と承認を画面内で完結させる。
 *
 * 描画はCodex画面と同じHTML（`renderShell`）を使う。プロバイダごとの差は
 * このクラスとイベント正規化（streamJson.ts）に閉じている。
 */
export class ClaudeChatViewManager implements vscode.Disposable {
  private readonly panels = new Map<string, ClaudePanel>();
  private approvalWarned = false;

  constructor(
    private readonly claudePath: () => string,
    private readonly fs: FileSystemPort,
    private readonly store: ClaudeSessionStore,
    private readonly log: Logger,
    private readonly onActivity: (activity: ChatActivity) => void = () => undefined,
  ) {}

  /** 新しい会話を開く。idは起動前に決まるため、開いた時点で履歴と紐づく。 */
  async openNew(): Promise<void> {
    const folder = currentWorkspaceFolder();
    if (folder === undefined) {
      void vscode.window.showErrorMessage(
        'Claude Codeを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
      );
      return;
    }
    if (isUnsafeClaudeCombination(readClaudeConfig().claude) && !(await this.confirmUnsafe())) {
      return;
    }

    const sessionId = randomSessionId();
    const entry = this.createPanel(LABEL, folder.uri.fsPath);
    this.panels.set(sessionId, entry);
    entry.session.start({
      cwd: folder.uri.fsPath,
      target: { kind: 'new' },
      sessionId,
      config: readClaudeConfig().claude,
    });
  }

  /** 既存のセッションを開く。過去のやり取りはtranscriptから復元する。 */
  async openThread(sessionId: string, title: string, cwd: string | undefined): Promise<void> {
    const existing = this.panels.get(sessionId);
    if (existing !== undefined) {
      existing.panel.reveal();
      return;
    }

    const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
    if (folder === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      return;
    }

    const entry = this.createPanel(`${LABEL}: ${title}`, folder);
    this.panels.set(sessionId, entry);
    entry.session.start({
      cwd: folder,
      target: { kind: 'resume', sessionId },
      sessionId: undefined,
      config: readClaudeConfig().claude,
      initialItems: await this.readTranscript(sessionId),
    });
  }

  /** `--resume` は過去のやり取りを流さないため、transcriptを読んで初期表示にする。 */
  private async readTranscript(sessionId: string): Promise<ChatState['items']> {
    const filePath = await this.store.resolveTranscriptPath(sessionId);
    if (filePath === undefined) {
      return [];
    }
    const content = await this.fs.readTextFile(filePath);
    return content === undefined ? [] : transcriptItems(content.split('\n'));
  }

  private createPanel(title: string, cwd: string): ClaudePanel {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = renderShell(panel.webview, { agentLabel: LABEL, showSettings: false });

    const session = new ClaudeStreamSession(
      this.claudePath,
      this.log,
      (state) => {
        const next = deriveTitle(state);
        if (next !== undefined && panel.title !== next) {
          panel.title = next;
        }
        void panel.webview.postMessage({ type: 'state', state });
      },
      () => this.warnApprovalsUnavailable(),
    );

    const entry: ClaudePanel = { panel, session, cwd };
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(entry, message));
    panel.onDidDispose(() => {
      session.dispose();
      for (const [id, value] of this.panels) {
        if (value === entry) {
          this.panels.delete(id);
        }
      }
    });
    return entry;
  }

  private handleMessage(entry: ClaudePanel, message: unknown): void {
    const m =
      typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
    const type = m['type'];

    try {
      if (type === 'send' && typeof m['text'] === 'string' && m['text'].trim() !== '') {
        entry.session.send(m['text']);
        const sessionId = entry.session.threadId;
        if (sessionId !== undefined) {
          this.onActivity({ sessionId, cwd: entry.cwd, text: m['text'] });
        }
        return;
      }
      if (type === 'interrupt') {
        entry.session.interrupt();
        return;
      }
      if (type === 'approve' && typeof m['decision'] === 'string') {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          entry.session.decide(requestId, m['decision'] as ApprovalDecision);
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.error(`Claude Code画面: ${reason}`);
      void vscode.window.showErrorMessage(`Claude Code: ${reason}`);
    }
  }

  /**
   * 承認要求を受け取れない構成だと判ったときの案内。
   * 会話自体は続くため、通知は一度だけにする。
   */
  private warnApprovalsUnavailable(): void {
    if (this.approvalWarned) {
      return;
    }
    this.approvalWarned = true;
    void vscode.window.showWarningMessage(
      'この画面ではツール実行の承認を受け取れませんでした。claude.permissionMode の設定に従って動作します。',
    );
  }

  private async confirmUnsafe(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      '承認が無効になっています。Claude Code はツールを確認なしで実行します。',
      { modal: true },
      '実行する',
    );
    return choice === '実行する';
  }

  dispose(): void {
    for (const entry of this.panels.values()) {
      entry.session.dispose();
      entry.panel.dispose();
    }
    this.panels.clear();
  }
}

/** タブ名。Claude Codeは要約名を持たないため、最初の指示から作る。 */
function deriveTitle(state: ChatState): string | undefined {
  const first = state.items.find((i) => i.kind === 'userMessage' && i.text.trim() !== '');
  if (first === undefined) {
    return undefined;
  }
  const text = first.text.replace(/\s+/gu, ' ').trim();
  return `${LABEL}: ${text.length > 32 ? `${text.slice(0, 32)}…` : text}`;
}

function randomSessionId(): string {
  return randomUUID();
}
