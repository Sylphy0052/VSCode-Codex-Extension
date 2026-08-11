import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, PendingApproval } from '../appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../loop/loopController';

/**
 * チャット画面側がオーケストレータへ提供する口（design.md §16.10）。
 *
 * `ChatViewManager`（Codex）と `ClaudeChatViewManager`（Claude Code）の両方がこれを
 * 実装し、`runner.ts`（次の依頼で実装）はプロバイダを見ずにタスクを進行させる。
 */

/**
 * 承認ハンドラの判定結果。
 *
 * design.mdのTaskSession定義は `setApprovalHandler(handler: (approval) =>
 * Promise<ApprovalDecision>): void` だが、そのままでは「承認カードを出して人を待つ」
 * （`ask`）を表現できない。`ApprovalDecision`（'accept' | 'acceptForSession' |
 * 'decline' | 'cancel'）はWebviewの承認カードが返す**確定した決定**の語彙であり、
 * 'ask' に相当する値が無い。`decline`/`cancel` を代用すると「危険なので人に聞きたい」
 * 要求が判定を経ずに即座に拒否されてしまい、design.mdの「askなら従来どおり承認カードを
 * 出して人を待つ」という要件と矛盾する。
 *
 * そのため、ここでは `auto`（即決）と `ask`（従来の承認カードへ委ねる）を明示的な
 * 判別可能ユニオンにした。`ApprovalDecision` はWebviewの実際の決定にだけ使う語彙として
 * 温存し、意味の異なる2つの概念を1つの型に押し込めない。
 */
export type ApprovalHandlerResult = { kind: 'auto'; decision: ApprovalDecision } | { kind: 'ask' };

/** 承認要求の判定を差し込むハンドラ。`classifyApprovalRequest`（escalation.ts）の呼び出しはrunner.tsの責務。 */
export type ApprovalHandler = (approval: PendingApproval) => Promise<ApprovalHandlerResult>;

/** タスク単位で上書きできる設定。プロバイダ間で共通の語彙に正規化してある。 */
export interface TaskSessionConfig {
  /** 空文字は「拡張機能の既定に委ねる」を意味する（既存の `CodexConfig`/`ClaudeConfig` と同じ流儀）。 */
  model: string;
  /** Codexの `reasoningEffort` / Claudeの `effort` に対応する。 */
  effort: string;
  /** Codexの `approvalMode` / Claudeの `permissionMode` に対応する。 */
  approvalMode: string;
}

export interface TaskSessionInput {
  /** タスクの作業ディレクトリ（worktreeまたは明示cwd）。 */
  cwd: string;
  config: TaskSessionConfig;
  /**
   * `thread/start` 時の1回きりの指定（Codexのみ意味を持つ）。
   * Claude側は起動引数に相当するものが無いため無視する。
   */
  sandbox: string;
}

export interface TaskSessionHost {
  /** タスク用のセッションを開く。cwdとタスク単位の設定を渡せる。 */
  openTaskSession(input: TaskSessionInput): Promise<TaskSession>;
}

export interface TaskSession {
  readonly sessionId: string;
  /** 終了条件つきの繰り返しを始める（LoopControllerをそのまま使う）。 */
  runLoop(plan: LoopPlan): void;
  /** 停止理由が決まったら1度だけ呼ばれる。 */
  onFinished(listener: (reason: LoopStopReason, state: ChatState) => void): void;
  /** 状態が変わるたびに呼ばれる。Viewの進捗表示と応答の1行要約に使う。 */
  onStateChanged(listener: (state: ChatState) => void): void;
  /** 承認要求の判定を差し込む。 */
  setApprovalHandler(handler: ApprovalHandler): void;
  /**
   * 進行中のターンだけ止める。タスクのループは続く。
   *
   * 画面の「中断」ボタンは `loop.noteUserAction()` を呼んでループごと止めるため、
   * その経路は使えない。`session.interrupt()` だけを呼ぶ別の口として持つ。
   */
  interrupt(): Promise<void>;
  /** タブを前面に出す。閉じられていれば作り直し、それまでの会話を復元する。 */
  reveal(): void;
  /** タブを背面で用意する。開始時に呼ぶ。 */
  open(options: { preserveFocus: boolean }): void;
  dispose(): void;
}
