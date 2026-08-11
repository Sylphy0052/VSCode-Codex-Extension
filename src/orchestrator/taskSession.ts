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

/**
 * 承認要求の判定を差し込むハンドラ。`classifyApprovalRequest`（escalation.ts）の呼び出しはrunner.tsの責務。
 *
 * design.mdのTaskSession定義は `handler: (approval: PendingApproval) => ...` だが、
 * ここでは第2引数に**生の要求パラメータ**（`ServerRequest.params` / Claudeの
 * control_request payload）を追加している。`PendingApproval` は表示用に `title` /
 * `detail` を文字列結合した形（`describeApproval` / `describeCanUseTool`）で、
 * `command` / `cwd` / 変更対象パス / `networkApprovalContext` などの構造化フィールドを
 * 個別に持たない。design.md §16.7が「判定関数には表示用に整形済みのPendingApprovalでは
 * なく生の要求パラメータを渡す」と明記しているため、`PendingApproval`だけでは
 * `classifyApprovalRequest` の入力を組み立てられない（文字列を逆にパースするのは
 * describeApprovalが避けている「文字列結合」を呼び出し側で再現するだけで本末転倒）。
 */
export type ApprovalHandler = (
  approval: PendingApproval,
  rawParams: Record<string, unknown>,
) => Promise<ApprovalHandlerResult>;

/** `setApprovalHandler` が `ask` を返した要求が、その後どう解決したか。 */
export interface ApprovalOutcome {
  requestId: number | string;
  decision: ApprovalDecision;
}

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
  /**
   * タスク間メッセージング（design.md §16.21）専用のMCPサーバへの接続先。runner.tsが
   * runごとに立てたサーバ（`messaging.ts`の`startHttpMcpTransport`）から、タスクごとに
   * 発行したURLを渡す。`undefined`なら（メッセージングが無効、またはこのタスクには
   * 発行されていない）通信なしで走らせる（design.md「見えていなければ...通信なしで
   * 走らせる」と同じ扱い）。
   *
   * **この値を実際にCodex/Claudeの起動設定（`mcp_servers`相当）へ反映する配線は
   * まだ無い。** `TaskSessionHost`の具象実装（`ChatViewManager` / `ClaudeChatViewManager`。
   * `src/view/chatView.ts` / `claudeChatView.ts`）を変更する必要があるが、Issue #105は
   * `src/view/`を対象外にしている（Issue #104と衝突するため）。値はここまで届くが、
   * 現時点ではどちらの実装も読まない（最終報告に記載）。
   */
  mcp?: { url: string };
}

export interface TaskSessionHost {
  /** タスク用のセッションを開く。cwdとタスク単位の設定を渡せる。 */
  openTaskSession(input: TaskSessionInput): Promise<TaskSession>;
}

export interface TaskSession {
  readonly sessionId: string;
  /** 終了条件つきの繰り返しを始める（LoopControllerをそのまま使う）。 */
  runLoop(plan: LoopPlan): void;
  /**
   * 実際に送信する直前に本文を変換する。テンプレート展開（design.md §16.4）専用の差し込み口。
   *
   * design.mdのTaskSession定義には無い。`runLoop`へ渡す`LoopPlan`の本文は
   * `{{T1.result}}`のようなテンプレート未展開のまま持たせ（作業記録へはこちらを残す。
   * design.md §16.12「展開前の文面を記録する」）、実際にCLIへ送る内容だけをここで
   * 展開する。分離しないと「送る本文（展開済み）」と「記録する本文（展開前）」を
   * 作り分けられない。未設定なら本文をそのまま送る（既存の呼び出しは全て既定値で動く）。
   */
  setPromptTransform(transform: (text: string) => string): void;
  /** 停止理由が決まったら1度だけ呼ばれる。 */
  onFinished(listener: (reason: LoopStopReason, state: ChatState) => void): void;
  /** 状態が変わるたびに呼ばれる。Viewの進捗表示と応答の1行要約に使う。 */
  onStateChanged(listener: (state: ChatState) => void): void;
  /** 承認要求の判定を差し込む。 */
  setApprovalHandler(handler: ApprovalHandler): void;
  /**
   * `setApprovalHandler` が `ask` を返した要求（＝従来通り承認カードへ委ねた要求）が
   * 実際に解決された（人が承認カードのボタンを押した）ときに呼ばれる。
   *
   * design.mdのTaskSession定義には無い。人の決定はチャット画面側（承認カードの
   * `approve` メッセージ）で完結しており、runner.ts側からは見えない。`waitingApproval`
   * から`running`へ戻す・拒否を`markApprovalRejected`へ回す（design.md §16.5「承認拒否は
   * 専用の経路で扱う」）ために、この決定をrunner.tsへ伝える口が要る。
   */
  onApprovalResolved(listener: (outcome: ApprovalOutcome) => void): void;
  /**
   * 進行中のターンだけ止める。タスクのループは続く。
   *
   * 画面の「中断」ボタンは `loop.noteUserAction()` を呼んでループごと止めるため、
   * その経路は使えない。`session.interrupt()` だけを呼ぶ別の口として持つ。
   */
  interrupt(): Promise<void>;
  /**
   * ワークフローViewの「タスク停止」操作（design.md §16.8）専用。ループそのものを止める。
   *
   * `LoopStopReason: 'taskStopped'` で `onFinished` が呼ばれ、`runner.ts` はこれを
   * `manual`/`interrupted`（人がそのタスクの画面へ直接介入した状態。タスク自身は変えない）
   * とは別に扱い、そのタスクだけを `failed`（手動停止）に確定させる（design.md §16.5）。
   */
  stopLoop(): void;
  /**
   * `waitingApproval` の要求を、チャット画面のタブを開かずに直接解決する
   * （design.md §16.8「承認」操作用）。従来の承認カード（webview内の`approve`メッセージ）と
   * 同じ決定経路（`ChatSession.decide` / `ClaudeStreamSession.decide`）を通すため、
   * `onApprovalResolved` のリスナーにも同じ通知が届く。
   */
  decideApproval(requestId: number | string, decision: ApprovalDecision): void;
  /** タブを前面に出す。閉じられていれば作り直し、それまでの会話を復元する。 */
  reveal(): void;
  /** タブを背面で用意する。開始時に呼ぶ。 */
  open(options: { preserveFocus: boolean }): void;
  dispose(): void;
}
