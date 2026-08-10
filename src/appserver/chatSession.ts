import type { CodexConfig } from '../codex/types';
import type { Logger } from '../log';
import { buildApprovalResponse, describeApproval, type ApprovalDecision } from './approvals';
import {
  addApproval,
  applyEvent,
  initialChatState,
  normalizeItem,
  removeApproval,
  type ChatState,
  type PendingApproval,
} from './chatState';
import type { AppServerConnection, ServerRequest } from './connection';

interface WaitingApproval {
  resolve: (response: unknown) => void;
  approval: PendingApproval;
  params: Record<string, unknown>;
}

/**
 * Codex画面1つ分の状態と操作。
 *
 * turn単位でモデル・effort・承認方針を渡せるため、設定パネルの変更が次の発言から効く
 * （TUI方式では次のセッションまで待つ必要があった）。
 */
export class ChatSession {
  private state: ChatState = initialChatState;
  private readonly waiting = new Map<number | string, WaitingApproval>();

  constructor(
    private readonly connection: AppServerConnection,
    private readonly log: Logger,
    private readonly onChange: (state: ChatState) => void,
  ) {}

  get threadId(): string | undefined {
    return this.state.threadId;
  }

  getState(): ChatState {
    return this.state;
  }

  private update(next: ChatState): void {
    this.state = next;
    this.onChange(next);
  }

  /** 新しいスレッドを開始する。 */
  async start(cwd: string, config: CodexConfig): Promise<string> {
    await this.connection.ensureStarted();
    const params: Record<string, unknown> = { cwd };
    if (config.sandbox !== '') {
      params['sandbox'] = config.sandbox;
    }
    if (config.approvalMode !== '') {
      params['approvalPolicy'] = config.approvalMode;
    }
    if (config.model !== '') {
      params['model'] = config.model;
    }

    const response = await this.connection.request('thread/start', params);
    const threadId = readThreadId(response.result);
    if (threadId === undefined) {
      throw new Error('スレッドを開始できませんでした');
    }
    this.update({ ...this.state, threadId });
    return threadId;
  }

  /** 既存のスレッドを読み込む。 */
  async resume(threadId: string, cwd: string | undefined): Promise<void> {
    await this.connection.ensureStarted();
    const params: Record<string, unknown> = { threadId };
    if (cwd !== undefined) {
      params['cwd'] = cwd;
    }
    const response = await this.connection.request('thread/resume', params);
    this.update({
      ...this.state,
      threadId,
      name: readThreadName(response.result) ?? this.state.name,
      items: readInitialItems(response.result),
    });
  }

  /**
   * 発言を送る。モデル・effort・承認方針はここで毎回渡す。
   * サンドボックスはスレッド開始時の指定を使う（turn単位の指定は形が異なるため扱わない）。
   */
  async send(text: string, config: CodexConfig): Promise<void> {
    const threadId = this.state.threadId;
    if (threadId === undefined) {
      throw new Error('スレッドが開始されていません');
    }

    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text }],
    };
    if (config.model !== '') {
      params['model'] = config.model;
    }
    if (config.reasoningEffort !== '') {
      params['effort'] = config.reasoningEffort;
    }
    if (config.approvalMode !== '') {
      params['approvalPolicy'] = config.approvalMode;
    }

    this.update({ ...this.state, busy: true, turnFailed: false });
    await this.connection.request('turn/start', params);
  }

  /**
   * スレッド名を変更する。Codex側に永続化されるため、履歴一覧やTUIタブにも反映される。
   */
  async setName(name: string): Promise<void> {
    const threadId = this.state.threadId;
    if (threadId === undefined) {
      return;
    }
    await this.connection.request('thread/name/set', { threadId, name });
    this.update({ ...this.state, name });
  }

  async interrupt(): Promise<void> {
    const threadId = this.state.threadId;
    const turnId = this.state.turnId;
    // app-serverは中断するターンの指定を要求する。進行中のターンが無ければ何もしない
    if (threadId === undefined || turnId === undefined) {
      return;
    }
    await this.connection.request('turn/interrupt', { threadId, turnId });
    this.update({ ...this.state, busy: false, turnId: undefined });
  }

  applyNotification(method: string, params: Record<string, unknown>): void {
    const next = applyEvent(this.state, method, params);
    if (next !== this.state) {
      this.update(next);
    }
  }

  /**
   * 承認要求を受け取り、ユーザーの決定まで応答を保留する。
   * 応答を返さない限りCodexは待ち続けるため、画面を閉じる際は必ず解決すること。
   */
  requestApproval(request: ServerRequest): Promise<unknown> {
    const approval = describeApproval(request.id, request.method, request.params);
    if (approval === undefined) {
      return Promise.resolve({ decision: 'decline' });
    }

    return new Promise<unknown>((resolve) => {
      this.waiting.set(request.id, { resolve, approval, params: request.params });
      this.update(addApproval(this.state, approval));
    });
  }

  /** ユーザーが承認カードのボタンを押したとき。 */
  decide(requestId: number | string, decision: ApprovalDecision): void {
    const waiting = this.waiting.get(requestId);
    if (waiting === undefined) {
      return;
    }
    this.waiting.delete(requestId);
    waiting.resolve(buildApprovalResponse(waiting.approval.kind, decision, waiting.params));
    this.log.info(`承認: ${waiting.approval.kind} → ${decision}`);
    this.update(removeApproval(this.state, requestId));
  }

  /** 画面を閉じるときなど。保留中の要求を全て拒否して解放する。 */
  dispose(): void {
    for (const [requestId] of this.waiting) {
      this.decide(requestId, 'cancel');
    }
  }
}

function readThreadId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const thread = (result as Record<string, unknown>)['thread'];
  if (typeof thread !== 'object' || thread === null) {
    return undefined;
  }
  const id = (thread as Record<string, unknown>)['id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function readThreadName(result: unknown): string | undefined {
  const root =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const thread =
    typeof root['thread'] === 'object' && root['thread'] !== null
      ? (root['thread'] as Record<string, unknown>)
      : {};
  const name = thread['name'];
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** resume応答に含まれる既存のやり取り。 */
function readInitialItems(result: unknown): ChatState['items'] {
  const root =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const thread =
    typeof root['thread'] === 'object' && root['thread'] !== null
      ? (root['thread'] as Record<string, unknown>)
      : {};
  const turns = thread['turns'];
  if (!Array.isArray(turns)) {
    return [];
  }

  const items: ChatState['items'] = [];
  for (const turn of turns) {
    const t = typeof turn === 'object' && turn !== null ? (turn as Record<string, unknown>) : {};
    const turnItems = t['items'];
    if (!Array.isArray(turnItems)) {
      continue;
    }
    for (const raw of turnItems) {
      const normalized = normalizeItem(raw);
      if (normalized !== undefined) {
        items.push(normalized);
      }
    }
  }
  return items;
}
