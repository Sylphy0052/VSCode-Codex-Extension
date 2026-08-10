import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, ChatUsage } from '../appserver/chatState';
import type { ClaudeSessionStore } from '../claude/sessionStore';
import { ClaudeStreamSession } from '../claude/streamSession';
import { transcriptItems } from '../claude/transcript';
import { isUnsafeClaudeCombination } from '../claude/argvBuilder';
import { currentWorkspaceFolder, readClaudeConfig } from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import { renderShell } from './chatView';
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES } from '../claude/types';
import type { SettingsProvider } from './settingsProvider';
import type { ChatActivity } from './chatView';

interface ClaudePanel {
  panel: vscode.WebviewPanel;
  session: ClaudeStreamSession;
  /** この画面で走らせているループ。走っていなければ待機状態のまま。 */
  loop: LoopController;
  cwd: string;
  /** タブを閉じた後か。破棄済みのWebviewへ送るとVSCodeが例外を投げるため見張る。 */
  disposed: boolean;
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
    private readonly settings: SettingsProvider,
    private readonly log: Logger,
    private readonly onActivity: (activity: ChatActivity) => void = () => undefined,
    /** 制限の状態が更新されたときに知らせる。ステータスバーの表示に使う。 */
    private readonly onUsage: (usage: ChatUsage) => void = () => undefined,
  ) {}

  /**
   * 画面下の設定行へ現在値と選択肢を送る。
   *
   * 描画はCodex画面と同じスクリプトなので、Codex側のスナップショットと同じ形に整えて渡す。
   * Claude Codeにはモデルカタログが無いため、エイリアスを `ModelInfo` 相当に見せる。
   */
  private refreshSettings(entry: ClaudePanel): void {
    if (entry.disposed) {
      return;
    }
    const snapshot = this.settings.claudeSnapshot();
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...entry.session.getState(),
        loop: entry.loop.getStatus(),
        settings: {
          models: snapshot.models.map((slug) => ({
            slug,
            displayName: slug,
            description: undefined,
            defaultEffort: undefined,
            efforts: [],
          })),
          efforts: [...CLAUDE_EFFORTS],
          model: snapshot.model,
          reasoningEffort: snapshot.effort,
          approvalMode: snapshot.permissionMode,
          defaults: {
            model: snapshot.defaults.model,
            reasoningEffort: snapshot.defaults.effort,
            approvalMode: snapshot.defaults.permissionMode,
            sandbox: undefined,
          },
          profile: '',
        },
      },
    });
  }

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
    let wasBusy = false;
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = renderShell(panel.webview, {
      agentLabel: LABEL,
      approvalModes: CLAUDE_PERMISSION_MODES,
      showSettings: true,
    });

    const session = new ClaudeStreamSession(
      this.claudePath,
      this.log,
      (state) => {
        if (entry.disposed) {
          return;
        }
        // ターンが終わった瞬間に、待たせていた指示を1件送る
        const finished = wasBusy && !state.busy;
        wasBusy = state.busy;
        if (finished && state.queued.length > 0) {
          entry.session.sendNextQueued();
        }
        const next = deriveTitle(state);
        if (next !== undefined && panel.title !== next) {
          panel.title = next;
        }
        if (state.usage !== undefined) {
          this.onUsage(state.usage);
        }
        // ターンの完了を見て次の指示を送るため、描画より先にループへ渡す
        entry.loop.observe(state);
        void panel.webview.postMessage({
          type: 'state',
          state: { ...state, loop: entry.loop.getStatus() },
        });
      },
      () => this.warnApprovalsUnavailable(),
    );

    const loop = new LoopController(
      (text) => this.sendFromLoop(entry, text),
      () => this.refreshSettings(entry),
    );

    const entry: ClaudePanel = { panel, session, loop, cwd, disposed: false };
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(entry, message));
    panel.onDidDispose(() => {
      entry.disposed = true;
      loop.stop('manual');
      session.dispose();
      for (const [id, value] of this.panels) {
        if (value === entry) {
          this.panels.delete(id);
        }
      }
    });
    return entry;
  }

  /** 設定行のキーはCodex画面と共通なので、Claude側のキーへ読み替える。 */
  private async applyConfig(entry: ClaudePanel, key: unknown, value: unknown): Promise<void> {
    if (typeof value !== 'string') {
      return;
    }
    const mapped =
      key === 'model'
        ? 'model'
        : key === 'reasoningEffort'
          ? 'effort'
          : key === 'approvalMode'
            ? 'permissionMode'
            : undefined;
    if (mapped === undefined) {
      this.log.warn(`変更を許可していないキーです: ${String(key)}`);
      return;
    }
    // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
    await this.settings.updateClaude(mapped, value);
    this.refreshSettings(entry);
  }

  /** 発言を送り、作業記録へ流す。手動でもループからでも通り道は同じにする。 */
  private dispatch(entry: ClaudePanel, text: string): void {
    entry.session.sendOrQueue(text);
    const sessionId = entry.session.threadId;
    if (sessionId !== undefined) {
      this.onActivity({ sessionId, cwd: entry.cwd, text });
    }
  }

  /** ループからの送信。失敗はループを止める理由になるため、報告したうえで投げ直す。 */
  private sendFromLoop(entry: ClaudePanel, text: string): void {
    try {
      this.dispatch(entry, text);
    } catch (e) {
      this.reportError(e);
      throw e;
    }
  }

  private reportError(e: unknown): void {
    const reason = e instanceof Error ? e.message : String(e);
    this.log.error(`Claude Code画面: ${reason}`);
    void vscode.window.showErrorMessage(`Claude Code: ${reason}`);
  }

  private handleMessage(entry: ClaudePanel, message: unknown): void {
    const m =
      typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
    const type = m['type'];

    try {
      if (type === 'send' && typeof m['text'] === 'string' && m['text'].trim() !== '') {
        // 手動の発言はループへの割り込み。指示が交互に飛ぶ状態を作らない
        entry.loop.noteUserAction();
        this.dispatch(entry, m['text']);
        return;
      }
      if (type === 'interrupt') {
        entry.loop.noteUserAction();
        entry.session.interrupt();
        return;
      }
      if (type === 'cancelQueued' && typeof m['index'] === 'number') {
        entry.session.cancelQueued(m['index']);
        return;
      }
      if (type === 'flushQueue') {
        // 待たせていた指示を先に通すため、ループは割り込みとして止める
        entry.loop.noteUserAction();
        entry.session.flushQueue();
        return;
      }
      if (type === 'loop/start') {
        const plan = normalizeLoopPlan(m['plan']);
        if (plan === undefined) {
          void vscode.window.showErrorMessage('ループの継続指示と最大回数を入力してください');
          return;
        }
        this.log.info(`ループ開始: 最大${plan.maxIterations}回`);
        entry.loop.start(plan);
        return;
      }
      if (type === 'loop/stop') {
        entry.loop.stop('manual');
        return;
      }
      if (type === 'ready') {
        this.refreshSettings(entry);
        return;
      }
      if (type === 'config') {
        void this.applyConfig(entry, m['key'], m['value']);
        return;
      }
      if (type === 'approve' && typeof m['decision'] === 'string') {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          entry.session.decide(requestId, m['decision'] as ApprovalDecision);
        }
      }
    } catch (e) {
      this.reportError(e);
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
      entry.loop.stop('manual');
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
