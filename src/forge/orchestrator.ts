import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState } from '../appserver/chatState';
import { buildEffectiveTaskConfig, type ExtensionSafetyBaseline } from '../orchestrator/taskConfig';
import type { TaskSession, TaskSessionHost } from '../orchestrator/taskSession';
import type { Provider } from '../orchestrator/workflow';

/** Forge Hubに埋め込む、ワークスペースごとに一つだけの会話の表示用状態。 */
export interface ForgeOrchestratorSnapshot {
  provider: Provider;
  busy: boolean;
  turnFailed: boolean;
  messages: ReadonlyArray<{ kind: string; text: string }>;
  approvals: ReadonlyArray<{ requestId: number | string; title: string; detail: string }>;
}

/**
 * Forge Hubの通常入力と操作ボタンを同じTaskSessionへ送る。
 *
 * ここではパネルを開かない。Hubを閉じてもセッションは残り、次にHubを開いたときに
 * 同じ会話を再利用する。実行権限は拡張機能の現在の安全基準を超えない。
 */
export class ForgeOrchestrator {
  private current: { provider: Provider; cwd: string; session: TaskSession } | undefined;
  private snapshot: ForgeOrchestratorSnapshot | undefined;
  private readonly listeners: Array<(snapshot: ForgeOrchestratorSnapshot) => void> = [];

  constructor(
    private readonly hosts: Record<Provider, TaskSessionHost>,
    private readonly readBaseline: () => ExtensionSafetyBaseline,
  ) {}

  onChanged(listener: (snapshot: ForgeOrchestratorSnapshot) => void): void {
    this.listeners.push(listener);
  }

  getSnapshot(): ForgeOrchestratorSnapshot | undefined {
    return this.snapshot;
  }

  async send(provider: Provider, cwd: string, text: string): Promise<string> {
    const session = await this.ensure(provider, cwd);
    session.send(text);
    return session.sessionId;
  }

  decideApproval(requestId: number | string, decision: ApprovalDecision): void {
    this.current?.session.decideApproval(requestId, decision);
  }

  dispose(): void {
    this.current?.session.dispose();
    this.current = undefined;
    this.snapshot = undefined;
  }

  private async ensure(provider: Provider, cwd: string): Promise<TaskSession> {
    if (this.current?.provider === provider && this.current.cwd === cwd)
      return this.current.session;
    this.current?.session.dispose();
    const effective = buildEffectiveTaskConfig(
      {
        provider,
        model: '',
        effort: '',
        approvalMode: '',
        // Forge Hubからの明示操作は通常会話と同じ権限に留める。より緩い値はクランプされる。
        sandbox: this.readBaseline().codexSandbox,
        autoApprove: false,
      },
      this.readBaseline(),
    );
    const session = await this.hosts[provider].openTaskSession({
      role: 'orchestrator',
      cwd,
      config: effective.config,
      sandbox: effective.sandbox,
    });
    this.current = { provider, cwd, session };
    session.onStateChanged((state) => this.update(provider, state));
    return session;
  }

  private update(provider: Provider, state: ChatState): void {
    this.snapshot = {
      provider,
      busy: state.busy,
      turnFailed: state.turnFailed,
      messages: state.items
        .filter((item) => item.text.trim() !== '')
        .slice(-30)
        .map((item) => ({ kind: item.kind, text: item.text })),
      approvals: state.approvals.map((approval) => ({
        requestId: approval.requestId,
        title: approval.title,
        detail: approval.detail,
      })),
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
