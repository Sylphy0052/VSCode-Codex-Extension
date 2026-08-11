import type { CodexConfig } from '../codex/types';
import type { Logger } from '../log';
import {
  buildApprovalResponse,
  defaultDenyResponse,
  describeApproval,
  SERVER_REQUEST_RESOLVED,
  type ApprovalDecision,
} from './approvals';
import {
  addApproval,
  addPrompt,
  appendNotice,
  applyEvent,
  enqueue,
  initialChatState,
  normalizeItem,
  removeApproval,
  removePrompt,
  removeQueued,
  routeSend,
  takeQueued,
  type ChatState,
  type PendingApproval,
} from './chatState';
import { buildCodexInput, type Attachment } from '../provider/attachments';
import type { AppServerConnectionPort, ServerRequest } from './connection';
import { readTurnPolicy, turnPolicyFor, type TurnPolicy } from './planMode';
import {
  buildPromptResponse,
  describePrompt,
  type PendingPrompt,
  type PromptSubmission,
} from './prompts';

interface WaitingApproval {
  resolve: (response: unknown) => void;
  approval: PendingApproval;
  params: Record<string, unknown>;
}

interface WaitingPrompt {
  resolve: (response: unknown) => void;
  prompt: PendingPrompt;
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
  /** 回答待ちの問い合わせ。応答を返すまでapp-serverは待ち続ける。 */
  private readonly waitingPrompts = new Map<number | string, WaitingPrompt>();
  /** スレッド開始時に効いていた権限。Plan modeを抜けるときの戻し先。 */
  private baseline: TurnPolicy | undefined;
  /** 一度でもPlan modeの権限を送ったか。送っていれば明示的に戻す必要がある。 */
  private policyOverridden = false;
  /** 採番用。画面へ出す一言のidに使う。 */
  private noticeCount = 0;

  constructor(
    private readonly connection: AppServerConnectionPort,
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
    // 応答に「いま効いている権限」が入っている。Plan modeを抜けるときの戻し先にする
    this.baseline = readTurnPolicy(response.result);
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
    this.baseline = readTurnPolicy(response.result);
    this.update({
      ...this.state,
      threadId,
      name: readThreadName(response.result) ?? this.state.name,
      items: readInitialItems(response.result),
    });
  }

  /**
   * Plan modeを切り替える。効くのは**次の発言から**。
   *
   * app-serverにPlan modeそのものが無いため、`turn/start` の権限で作る（`planMode.ts`）。
   * 進行中のターンには効かない（`turn/steer` に権限を渡す口が無いため）。
   */
  setPlanMode(on: boolean): void {
    if (this.state.planMode === on) {
      return;
    }
    if (on && this.baseline === undefined) {
      // 抜けるときに戻せない。入れてしまうと読み取り専用から出られなくなる
      throw new Error('このスレッドの権限を読み取れなかったため、計画モードに入れません');
    }
    const next = appendNotice(
      { ...this.state, planMode: on },
      `plan:${this.noticeCount++}`,
      on
        ? '計画モードに入りました。次の発言から、ファイルの変更もコマンドの書き込みも起きません'
        : '計画モードを抜けました。次の発言から元の権限に戻ります',
    );
    this.update(next);
  }

  /**
   * 発言を送る。モデル・effort・承認方針はここで毎回渡す。
   *
   * サンドボックスは普段はスレッド開始時の指定に任せるが、Plan modeのときだけ
   * ターン単位で読み取り専用へ落とす。一度落とすと明示的に戻すまで効き続けるため、
   * 抜けたあとの最初のターンで開始時の権限を送り直す。
   */
  async send(
    text: string,
    config: CodexConfig,
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    const threadId = this.state.threadId;
    if (threadId === undefined) {
      throw new Error('スレッドが開始されていません');
    }

    const params: Record<string, unknown> = {
      threadId,
      input: buildCodexInput(text, attachments),
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

    const policy = turnPolicyFor(this.state.planMode, this.baseline, this.policyOverridden);
    if (policy !== undefined) {
      // Plan modeの指定は設定パネルの承認方針より優先する（書けないことを保証するため）
      params['approvalPolicy'] = policy.approvalPolicy;
      params['sandboxPolicy'] = policy.sandboxPolicy;
      this.policyOverridden = this.state.planMode;
    }

    this.update({ ...this.state, busy: true, turnFailed: false });
    await this.connection.request('turn/start', params);
  }

  /**
   * 進行中のターンへ割り込んで指示を足す。
   *
   * app-serverは割り込む先のターンidを要求し、それが現在のターンと違えば失敗する。
   * 応答は止まらないので、途中で方針を足すのに使える。
   */
  async steer(text: string, attachments: readonly Attachment[] = []): Promise<void> {
    const threadId = this.state.threadId;
    const turnId = this.state.turnId;
    if (threadId === undefined || turnId === undefined) {
      throw new Error('割り込む先のターンがありません');
    }
    await this.connection.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: buildCodexInput(text, attachments),
    });
  }

  /**
   * 発言を送る。応答中なら割り込んで送る。
   *
   * 割り込めない場合（ターンidが判らない、ターンが終わった直後で id が食い違う）は
   * 指示を捨てずに待ち行列へ積み、ターンが終わってから送る。
   */
  async sendOrQueue(
    text: string,
    config: CodexConfig,
    attachments: Attachment[] = [],
  ): Promise<'sent' | 'queued'> {
    const route = routeSend(this.state);
    if (route === 'start') {
      await this.send(text, config, attachments);
      return 'sent';
    }

    if (route === 'steer') {
      try {
        await this.steer(text, attachments);
        return 'sent';
      } catch (e) {
        // ターンが入れ替わった直後など。指示を失わないよう積み直す
        this.log.warn(`割り込めなかったため待ち行列へ積みます: ${message(e)}`);
      }
    }

    this.update(enqueue(this.state, text, attachments));
    return 'queued';
  }

  /** 待機中の指示を1件取り消す。 */
  cancelQueued(index: number): void {
    this.update(removeQueued(this.state, index));
  }

  /**
   * 待機中の指示をすぐ送る。
   *
   * 応答中でも `turn/steer` で割り込めるため、中断は挟まない。
   */
  async flushQueue(config: CodexConfig): Promise<void> {
    if (this.state.queued.length === 0) {
      return;
    }
    await this.sendNextQueued(config);
  }

  /**
   * 待機中の先頭を送る。ターンが終わったときと、すぐ送るときに呼ぶ。
   * 送信に失敗したら積み直す（取り出したまま失われないようにする）。
   */
  async sendNextQueued(config: CodexConfig): Promise<void> {
    const { message: queued, next } = takeQueued(this.state);
    if (queued === undefined) {
      return;
    }
    const route = routeSend(this.state);
    this.update(next);
    try {
      if (route === 'steer') {
        await this.steer(queued.text, queued.attachments);
        return;
      }
      await this.send(queued.text, config, queued.attachments);
    } catch (e) {
      this.update(enqueue(this.state, queued.text, queued.attachments));
      throw e instanceof Error ? e : new Error(message(e));
    }
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

  /**
   * 会話を要約して圧縮する。
   *
   * 会話の内容を不可逆に変えるため、確認は呼び出し側で済ませてから呼ぶこと。
   * 完了は `contextCompaction` 項目と `thread/tokenUsage/updated` で判る
   * （`thread/compacted` 通知はプロトコル側で非推奨のため見ない）。
   */
  async compact(): Promise<void> {
    const threadId = this.state.threadId;
    if (threadId === undefined) {
      throw new Error('スレッドが開始されていません');
    }
    this.update({ ...this.state, busy: true, turnFailed: false });
    await this.connection.request('thread/compact/start', { threadId });
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
    if (method === SERVER_REQUEST_RESOLVED) {
      const requestId = params['requestId'];
      if (typeof requestId === 'number' || typeof requestId === 'string') {
        this.dropResolvedApproval(requestId);
      }
    }
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
    // ユーザーへの問い合わせは承認カードと別の形。フォームとして出す
    const prompt = describePrompt(request.id, request.method, request.params);
    if (prompt !== undefined) {
      return new Promise<unknown>((resolve) => {
        this.waitingPrompts.set(request.id, { resolve, prompt });
        this.update(addPrompt(this.state, prompt));
      });
    }

    const approval = describeApproval(request.id, request.method, request.params);
    if (approval === undefined) {
      // 承認カードに出せない要求。要求ごとに形の合う拒否を返す
      const denial = defaultDenyResponse(request.method, request.params);
      if (denial === undefined) {
        // 値を捏造せず、エラーとして相手を解放する
        this.log.warn(`応答を組み立てられない要求を拒否しました: ${request.method}`);
        return Promise.reject(new Error(`この拡張機能は ${request.method} に応答できません`));
      }
      this.log.info(`画面に出せない要求を拒否しました: ${request.method}`);
      return Promise.resolve(denial);
    }

    return new Promise<unknown>((resolve) => {
      this.waiting.set(request.id, { resolve, approval, params: request.params });
      this.update(addApproval(this.state, approval));
    });
  }

  /**
   * 承認が別の経路で解決されたとき。応答は返さず、画面の保留だけを取り下げる。
   *
   * 同じスレッドを別のウィンドウやTUIでも開いている場合、そちらの承認でこちらの
   * カードが宙に浮く。`serverRequest/resolved` を受けてここで片付ける。
   */
  private dropResolvedApproval(requestId: number | string): void {
    if (!this.waiting.has(requestId)) {
      return;
    }
    this.waiting.delete(requestId);
    this.log.info(`他の経路で解決された承認を取り下げました: ${String(requestId)}`);
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

  /**
   * ユーザーがフォームに答えたとき。
   *
   * 未入力のまま送っても形は揃える（質問idを落とすと相手が読めない）。中身を
   * 作らないのは `buildPromptResponse` の役目。
   */
  answerPrompt(requestId: number | string, submission: PromptSubmission): void {
    const waiting = this.waitingPrompts.get(requestId);
    if (waiting === undefined) {
      return;
    }
    this.waitingPrompts.delete(requestId);
    waiting.resolve(buildPromptResponse(waiting.prompt, submission));
    // 伏せ字の項目があるため、答えの中身はログに出さない
    this.log.info(`問い合わせに回答: ${waiting.prompt.kind} → ${submission.action}`);
    this.update(removePrompt(this.state, requestId));
  }

  /** 画面を閉じるときなど。保留中の要求を全て拒否して解放する。 */
  dispose(): void {
    for (const [requestId] of this.waiting) {
      this.decide(requestId, 'cancel');
    }
    // 問い合わせも解放する。放置するとapp-serverが待ち続ける
    for (const [requestId] of this.waitingPrompts) {
      this.answerPrompt(requestId, { action: 'cancel', values: {} });
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
