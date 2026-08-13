import { isApprovalsReviewer, type CodexConfig } from '../codex/types';
import type { Logger } from '../log';
import { isBlockedByReview, readAutoApprovalReview } from './autoApprovalReview';
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
  deriveReviewing,
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
import {
  buildReviewStartParams,
  readReviewThreadId,
  type ReviewDelivery,
  type ReviewTarget,
} from '../codex/reviewTarget';

/** 自動レビューの判定が出たことを知らせる通知（`approvalsReviewer: auto_review`）。 */
const AUTO_APPROVAL_REVIEW_COMPLETED = 'item/autoApprovalReview/completed';

/**
 * 会話の1行要約を依頼する指示文（issue #228、design.md §14.41）。
 *
 * design.md §14.36に実測が載っているClaude Code内蔵`/recap`の指示文
 * （"The user stepped away and is coming back. Recap in under 40 words, ..."）と
 * 同じ趣旨にする。Codex側にはこの指示文を専用に処理する経路が無く、通常のターンとして
 * 送ってモデルにそのまま従わせる必要があるため、次の一文を明示的に足している。
 *
 * - 「会話が使っている言語で答える」: Claude Code側は英語の指示文でも会話の言語に揃って
 *   返ることを実測済み（design.md §14.36実測3）だが、Codexでの実測はできていない。
 *   揃わない場合に備えて指示文で先に明示しておく（issue本文の受入基準「揃わない場合は
 *   指示文で明示する」に対応）
 */
export const RECAP_INSTRUCTION =
  'The user stepped away and is coming back. Recap this conversation in under 40 words, ' +
  '1-2 plain sentences, no markdown. Lead with the overall goal and current task. ' +
  'Reply in the same language the conversation has been using so far.';

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
  /**
   * 自動レビューが止めた操作。`reviewId` から、届いた完了通知そのものを引けるようにする。
   *
   * 覆し（`thread/approveGuardianDeniedAction`）は `event` に
   * 「シリアライズ済みの `GuardianAssessmentEvent`」を要求するが、スキーマはその中身を
   * 定義していない（CLI 0.147.0）。届いた通知をそのまま返す以外に組み立てようがないため、
   * 生の `params` を持っておく。
   */
  private readonly deniedReviews = new Map<string, Record<string, unknown>>();

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

  /**
   * 新しいスレッドを開始する。
   *
   * `mcpServersConfig` を渡すと、`thread/start`の`config`フィールド
   * （`ThreadStartParams`。`codex app-server generate-json-schema`のスキーマでは
   * `additionalProperties: true`の自由形式）へ`{ mcp_servers: mcpServersConfig }`として
   * 差し込む（実測。CLI 0.147.0）。**`config.toml`には一切書き込まれない**
   * （`config/read`で確認済み。スレッド限定のオーバーレイ）。呼び出し側が何を渡すか
   * （サーバ名・接続先）を決める。このクラス自身は中身の意味（タスク間メッセージング
   * design.md §16.21）を知らない（`ChatViewManager`側の責務。呼び出し側のJSDoc参照）。
   */
  async start(
    cwd: string,
    config: CodexConfig,
    mcpServersConfig?: Record<string, unknown>,
  ): Promise<string> {
    await this.connection.ensureStarted();
    const params: Record<string, unknown> = { cwd };
    // `thread/start` は `SandboxMode` の3値しか取らず、サンドボックスを張らない指定
    // （`externalSandbox`）を表現できない。bypassのときは承認まわりを一切載せず、
    // ターン側の `sandboxPolicy` で決める（issue #222。`turnPolicyFor` 参照）
    if (!config.bypassApprovalsAndSandbox) {
      if (config.sandbox !== '') {
        params['sandbox'] = config.sandbox;
      }
      if (config.approvalMode !== '') {
        params['approvalPolicy'] = config.approvalMode;
      }
      if (isApprovalsReviewer(config.approvalsReviewer)) {
        params['approvalsReviewer'] = config.approvalsReviewer;
      }
    }
    if (config.model !== '') {
      params['model'] = config.model;
    }
    if (mcpServersConfig !== undefined) {
      params['config'] = { mcp_servers: mcpServersConfig };
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
    this.applyThreadSnapshot(threadId, response.result);
  }

  /**
   * 脇道の質問（issue #24、design.md TP-42、Codex TUIの `/btw` 相当）用に、
   * ephemeralな `thread/fork` の応答をこの画面へ直接差し込む。
   *
   * ephemeralスレッドは `thread/resume` で読み直せない（実測: CLI 0.147.0。
   * ロールアウトファイルが存在しないため `no rollout found for thread id ...` で
   * 拒否される。`Thread.path` が `null` になっているのと符合する。詳細は
   * `codex/sideQuestion.ts` のコメント参照）。fork応答自体が `thread/resume` と
   * 同じ形（`thread` に加えて `approvalPolicy` / `sandbox` 等がルートに乗る）で
   * 完全な `turns` を持っているため、通信を増やさずそのままこの画面の初期状態にする。
   *
   * 呼び出し元（`ChatViewManager`）は、この画面用に新しく作った `ChatSession` へ
   * fork応答をそのまま渡す。元のスレッドの状態には一切触れない。
   */
  loadForkedThread(result: unknown): string {
    const threadId = readThreadId(result);
    if (threadId === undefined) {
      throw new Error('脇道のスレッドidを読み取れませんでした');
    }
    this.applyThreadSnapshot(threadId, result);
    return threadId;
  }

  /** `thread/resume` / ephemeralな `thread/fork` の応答を、この画面の状態へ適用する。 */
  private applyThreadSnapshot(threadId: string, result: unknown): void {
    this.baseline = readTurnPolicy(result);
    const items = readInitialItems(result);
    this.update({
      ...this.state,
      threadId,
      name: readThreadName(result) ?? this.state.name,
      items,
      // レビュー中に復元・detachedで開いた画面でも、割り込みの扱いを取り違えない
      reviewing: deriveReviewing(items),
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
   * 発言を送る。モデル・effort・承認方針・サンドボックスはここで毎回渡す。
   *
   * `turn/start` の指定は「このターン以降」に効くため、会話の途中で権限を変えられる。
   * 設定が空（CLIのconfig.tomlへ委譲）のときだけスレッド開始時の指定に任せる。
   * Plan mode中は設定より優先して読み取り専用へ落とし、抜けたあとの最初のターンで
   * 開始時の権限を送り直す。
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
    // bypassのときは承認方針も自動レビューも載せない。`turnPolicyFor` が
    // `approvalPolicy: never` を返すため、ここで載せると打ち消し合う（issue #222）
    if (!config.bypassApprovalsAndSandbox && config.approvalMode !== '') {
      params['approvalPolicy'] = config.approvalMode;
    }
    // 計画モード中は載せない。読み取り専用の保証（`PLAN_POLICY`）は人の承認を前提にしており、
    // 承認要求の判断を自動レビューへ渡すと保証の根拠が変わってしまう
    if (
      !this.state.planMode &&
      !config.bypassApprovalsAndSandbox &&
      isApprovalsReviewer(config.approvalsReviewer)
    ) {
      params['approvalsReviewer'] = config.approvalsReviewer;
    }

    const policy = turnPolicyFor(
      this.state.planMode,
      this.baseline,
      this.policyOverridden,
      config.sandbox,
      {
        writableRoots: config.sandboxWritableRoots,
        networkAccess: config.sandboxNetworkAccess,
      },
      config.bypassApprovalsAndSandbox,
    );
    if (policy !== undefined) {
      // Plan modeの指定は設定パネルの承認方針より優先する（書けないことを保証するため）
      if (policy.approvalPolicy !== undefined) {
        params['approvalPolicy'] = policy.approvalPolicy;
      }
      if (policy.sandboxPolicy !== undefined) {
        params['sandboxPolicy'] = policy.sandboxPolicy;
      }
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

  /**
   * 会話の1行要約をいま作る（issue #228、design.md §14.41）。
   *
   * Codex CLIには`/recap`に相当する概念が無い（design.md §14.41参照）。そのため
   * `compact()`のような専用の制御要求は無く、要約を依頼する指示文（`RECAP_INSTRUCTION`）を
   * 通常のターンとして`send()`経由で送るしかない。応答は`<synthetic>`ではなく通常の
   * モデル応答として会話に残る。トークン・費用も通常のターンと同じだけ掛かる
   * （Claude Code側との違い。design.md参照）。
   *
   * 会話がまだ無い状態（`items.length === 0`）で呼ぶと、要約する対象が無いままモデルの
   * ターンを1つ消費するだけになってしまう。Claude Code側はCLI内部の`/recap`がこの判定を
   * 持ち「Nothing to recap yet」で応答するが、Codexにはその判定を持つ経路が無いため、
   * ここで同じ判定を拡張機能側で行う。該当すれば`turn/start`は送らず、`hookBlocked`と
   * 同じ`appendNotice`でその旨だけを会話に一言残す。
   */
  async recap(config: CodexConfig): Promise<void> {
    const threadId = this.state.threadId;
    if (threadId === undefined) {
      throw new Error('スレッドが開始されていません');
    }
    if (this.state.items.length === 0) {
      this.update(
        appendNotice(
          this.state,
          `recap:${this.noticeCount++}`,
          'まだ要約できる会話がありません。まず何か送ってから試してください',
        ),
      );
      return;
    }
    await this.send(RECAP_INSTRUCTION, config);
  }

  /**
   * コードレビューを開始する（`review/start`）。
   *
   * `inline` はこのスレッドの新しいターンとして動くため、`send()` と同じく応答前に
   * `busy` を立てる。`detached` は別スレッドで動くため、このセッションの状態には
   * 触れない（呼び出し側が `reviewThreadId` で新しい画面を開いて追う）。
   *
   * レビュー中かどうかの表示は `enteredReviewMode` / `exitedReviewMode` 項目の到着
   * （`chatState.deriveReviewing`）を正とする。ここでは開始の合図だけ扱う。
   */
  async startReview(target: ReviewTarget, delivery: ReviewDelivery): Promise<string> {
    const threadId = this.state.threadId;
    if (threadId === undefined) {
      throw new Error('スレッドが開始されていません');
    }
    const params = buildReviewStartParams(threadId, target, delivery);
    if (delivery === 'inline') {
      this.update({ ...this.state, busy: true, turnFailed: false });
    }
    try {
      const response = await this.connection.request('review/start', params);
      const reviewThreadId = readReviewThreadId(response.result);
      if (reviewThreadId === undefined) {
        throw new Error('reviewThreadIdを読み取れませんでした');
      }
      return reviewThreadId;
    } catch (e) {
      if (delivery === 'inline') {
        this.update({ ...this.state, busy: false });
      }
      throw e;
    }
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
    if (method === AUTO_APPROVAL_REVIEW_COMPLETED) {
      this.rememberDeniedReview(params);
    }
    const next = applyEvent(this.state, method, params);
    if (next !== this.state) {
      this.update(next);
    }
  }

  /**
   * 自動レビューが止めた操作だけを覚えておく（覆しの材料）。
   *
   * 承認された審査まで持つと、後から「承認済みのものを承認し直す」要求を送れてしまう。
   * 止まった状態（`denied` / `timedOut`）に限る。
   */
  private rememberDeniedReview(params: Record<string, unknown>): void {
    const review = readAutoApprovalReview(params);
    if (review === undefined || !isBlockedByReview(review.status)) {
      return;
    }
    this.deniedReviews.set(review.reviewId, params);
  }

  /**
   * 自動レビューが拒否した操作を、人の指示で承認し直す（`thread/approveGuardianDeniedAction`）。
   *
   * 覆しの要求は `event` に「シリアライズ済みの `GuardianAssessmentEvent`」を求めるが、
   * スキーマはその中身を定義していない（CLI 0.147.0）。こちらで組み立てようが無いため、
   * 届いた完了通知をそのまま返す。知らない `reviewId`（＝止められていない操作）は送らない。
   */
  async approveDeniedReview(reviewId: string): Promise<void> {
    const threadId = this.state.threadId;
    const event = this.deniedReviews.get(reviewId);
    if (threadId === undefined || event === undefined) {
      return;
    }
    await this.connection.request('thread/approveGuardianDeniedAction', { threadId, event });
    this.deniedReviews.delete(reviewId);
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
