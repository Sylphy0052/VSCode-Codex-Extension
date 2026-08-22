import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildApprovalResponse,
  defaultDenyResponse,
  describeApproval,
  isApprovalDecision,
} from '../appserver/approvals';
import { isOpenableSearchUrl, type ChatItem, type ChatState } from '../appserver/chatState';
import { ChatSession } from '../appserver/chatSession';
import {
  AppServerConnection,
  type AppServerConnectionPort,
  type NotificationHandler,
  type ServerRequest,
  type ServerRequestHandler,
} from '../appserver/connection';
import { describeUnsafeCombination } from '../codex/argvBuilder';
import { summarize } from '../codex/conversation';
import { readForkedThreadId } from '../codex/jsonRpc';
import { readSkillsList } from '../codex/skillsList';
import { readRateLimits, type UsageSnapshot } from '../codex/usage';
import {
  currentWorkspaceFolder,
  readChatComposerButtonsConfig,
  readChatRenderMarkdownConfig,
  readChatSendOnConfig,
  readConfig,
  workspaceFolderPaths,
} from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { LoopPlan, LoopStatus, LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import { APPROVAL_MODES, SANDBOX_MODES, type CodexConfig } from '../codex/types';
import type { PromptSubmission } from '../appserver/prompts';
import { MESSAGING_MCP_SERVER_NAME } from '../orchestrator/messaging';
import type {
  ApprovalHandler,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../orchestrator/taskSession';
import { decoratePanelTitle, deriveSessionActivityState } from './sessionActivity';
import { buildItemsDelta } from './stateDelta';
import { BaseChatViewManager, type BaseChatPanel } from './chatManagerBase';
import { APPROVAL_LEVEL_CYCLE, isApprovalLevel } from '../provider/approvalLevel';
import { AttachmentBox } from '../provider/attachments';
import { CommandCatalog } from '../provider/commandCatalog';
import { FileMentionCatalog } from '../provider/fileMentions';
import {
  buildInitInstructionText,
  CODEX_PSEUDO_COMMANDS,
  routePseudoCommand,
  trimmedArgsOrUndefined,
  withPseudoCommands,
  type PseudoCommandCall,
} from '../provider/pseudoCommands';
import type { SlashCommand } from '../provider/slashCommands';
import {
  buildReviewTarget,
  type ReviewDelivery,
  type ReviewTarget,
  type ReviewTargetKind,
} from '../codex/reviewTarget';
import { buildSideQuestionForkParams } from '../codex/sideQuestion';
import { PendingStartRegistry } from './pendingStarts';
import { readPersistedThreadId } from './panelState';
import { isEditableKey, type SettingsProvider } from './settingsProvider';
import {
  addAttachment,
  confirmCompact,
  handleOpenDiffEditor,
  handleOpenDiffFile,
  handleRevertDiff,
  insertCodeIntoEditor,
  noteDropRejected,
  openCodeInNewFile,
  postFileMentions,
  postImageData,
  renderShell,
  reportTurnResult,
  runExportTranscript,
  STATE_POST_INTERVAL_MS,
  type ChatActivity,
} from './chatShared';

const VIEW_TYPE = 'codex.chat';

/**
 * Codexチャットパネルの生成オプション（design.md §14.48、issue #287）。
 * `enableFindWidget: true` でCtrl+Fの検索窓を有効にする。オブジェクトの組み立てを
 * 関数として切り出すことで、`createWebviewPanel`（vscode本体のAPI）を実際に呼ばずとも
 * 内容をテストできるようにしている。
 */
export function buildChatPanelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true };
}

/**
 * 脇道の質問（issue #24）用に新しく開くタブの見出し。
 *
 * 「分岐」（`forkFrom`）と紛れないよう別の語を使う。ephemeralスレッドはディスクに
 * 残らないため、このタブの内容は閉じる・ウィンドウを再読み込みすると失われる
 * （`docs/design.md` §14.26）。
 */
const SIDE_QUESTION_TAB_TITLE = '脇道';

/**
 * MCPツールの可視性確認（design.md §16.21）で `mcpServer/startupStatus/updated` 通知を
 * 待つ上限。ローカルの拡張機能自身が立てたサーバへの接続なので通常は一瞬で決着するが、
 * 通知そのものが届かない場合に確認を無期限で止めないための保険。
 */
const MCP_STARTUP_CHECK_TIMEOUT_MS = 8_000;

interface ChatPanel extends BaseChatPanel {
  // `panel` / `loop` / `disposed` / `title` / `taskManaged` / `postTimer` /
  // `approvalResolvedListeners` / `notifiedApprovalRequestIds` は`BaseChatPanel`
  // （chatManagerBase.ts）が定義済み（issue #420、#410のフォローアップ）。ここでは
  // 基底の`ChatSessionLike`より狭い`ChatSession`へ絞るため`session`だけ再宣言する
  session: ChatSession;
  /** 作業記録に載せるディレクトリ。resume時はセッション自身のcwd。 */
  cwd: string | undefined;
  /** 送信前の添付画像。送るまでここに溜める。 */
  attachments: AttachmentBox;
  /**
   * タスク単位の設定。指定されていれば、この画面からの送信は常にこちらを使い、
   * `readConfig().codex`（拡張機能のグローバル設定）を見ない（design.md §16.10の5）。
   */
  taskConfig: CodexConfig | undefined;
  /** ターン完了検知（`busy` の立ち下がり）に使う直前の値。 */
  wasBusy: boolean;
  /** ループ停止検知（`running` の立ち下がり）に使う直前の値。 */
  wasLoopRunning: boolean;
  /** `setApprovalHandler` で差し込まれた自動判定。未設定なら従来通り必ず承認カードを出す。 */
  approvalHandler: ApprovalHandler | undefined;
  /**
   * `setPromptTransform` で差し込まれた本文変換。実際の送信直前に適用する
   * （design.md §16.4のテンプレート展開）。未設定ならそのまま送る。
   */
  promptTransform: ((text: string) => string) | undefined;
  /** `TaskSession.onStateChanged` のリスナー。 */
  stateListeners: Array<(state: ChatState) => void>;
  /** `TaskSession.onFinished` のリスナー。 */
  finishedListeners: Array<(reason: LoopStopReason, state: ChatState) => void>;
  /**
   * `mcpServer/startupStatus/updated`通知（design.md §16.21）を待つリスナー。
   * `checkMessagingToolVisible`がツールの可視性を確かめるために使う。この通知は
   * `thread/start`の後にしか届かないため、会話には無関係な内部状態としてここへ集める
   * （`ChatSession.applyNotification`へは転送しない。`routeNotification`参照）。
   */
  mcpStartupListeners: Array<(name: string, status: string) => void>;
  /** 状態送信の間引き（issue #246）。最後に実際へ送った時刻。 */
  lastPostAt?: number | undefined;
  /**
   * 前回webviewへ送った会話項目（issue #262）。次の送信で差し分を選ぶために持つ。
   *
   * `undefined` は「webviewが何を持っているか判らない」状態で、次の送信は全量になる。
   * webviewを作り直したとき（`ready`）と、webviewが取りこぼしに気付いたとき
   * （`stateFull`）に戻す。
   */
  sentItems?: readonly ChatItem[] | undefined;
}

/**
/**
 * 保護を外した設定のまま会話を開いてよいか確かめる（issue #222、design.md §7）。
 *
 * 承認とサンドボックスの両方が効かない組み合わせは、モデルの提案がそのまま実行される。
 * 設定を変えた本人でも、別の日に開いた会話でそれが効いていることは忘れる。会話を開く
 * たびに、何が起きるかを示して同意を取る。
 *
 * キャンセルされたら開かない（既定はキャンセル側）。
 */
export async function confirmUnsafeCombination(config: CodexConfig): Promise<boolean> {
  const reason = describeUnsafeCombination(config);
  if (reason === undefined) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(reason, { modal: true }, 'このまま開く');
  return choice === 'このまま開く';
}

/**
 * AGENTS.mdの生成（`/init` 擬似コマンド、issue #26）で、既存ファイルを上書きしてよいか
 * 確かめる。ファイルが無いときは呼ばない。`confirmCompact` と同じく必ず確認を挟む
 * （生成そのものはCLI・モデルに任せるが、上書きの可否は拡張機能側で必ず止める）。
 */
export async function confirmGenerateAgentsFile(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'AGENTS.mdは既にあります。内容を踏まえて更新します（上書き）。',
    { modal: true },
    '更新する',
  );
  return choice === '更新する';
}

/** `TaskSessionInput` をCodexの `thread/start`/`turn/start` が読む形へ写す。 */
function toCodexConfig(input: TaskSessionInput): CodexConfig {
  return {
    model: input.config.model,
    reasoningEffort: input.config.effort,
    approvalMode: input.config.approvalMode,
    sandbox: input.sandbox,
    // `sandboxWritableRoots` / `sandboxNetworkAccess` はworkspace-writeの範囲を
    // ワークスペースの外・ネットワークへ広げる追加の許可（#83）。ワークフローのYAML
    // スキーマ（design.md §16.2）にはこれを指定する項目が無く、`TaskSessionInput` /
    // `TaskSessionConfig`（#52のクランプを通った値だけを運ぶ）も運んでこない。
    // 拡張機能のグローバル設定（`codex.sandboxWritableRoots` 等）をそのまま継承すると、
    // 人が対話セッション用に意識して許可した拡張が、YAMLからは見えない・書けない形で
    // 無人実行のタスクへ暗黙に伝播してしまう（§16.16「YAMLは安全側にしか動かせない」を
    // 拡張機能側の設定にまで広げた抜け道になる）。クランプ対象のフィールドが無い以上、
    // 安全側の既定（拡張しない）に固定する
    sandboxWritableRoots: [],
    sandboxNetworkAccess: false,
    // `approvalsReviewer` も同じ理由で空にする（#222）。承認要求を機械の判定へ回すかどうかは
    // YAMLのスキーマに項目が無く、拡張機能側の設定を継承すると無人実行のタスクへ暗黙に
    // 伝播する。空ならCodex側の既定（人が答える）へ委譲する
    approvalsReviewer: '',
    // `bypassApprovalsAndSandbox` も同じ理由で false に固定する（#222）。承認もサンドボックスも
    // 外す指定はYAMLのスキーマに項目が無く、拡張機能側の設定を継承すると、人が対話セッション用に
    // 意識して外した保護が無人実行のタスクへ暗黙に伝播する
    bypassApprovalsAndSandbox: false,
    profile: '',
    additionalArgs: [],
  };
}

/**
 * レビュー対象のQuickPick選択肢。
 *
 * フィールド名は `targetKind` にする。`vscode.QuickPickItem` は区切り線の表示に使う
 * `kind?: QuickPickItemKind` を既に持っており、`kind` のままだと型が衝突する。
 */
const REVIEW_TARGET_ITEMS: (vscode.QuickPickItem & { targetKind: ReviewTargetKind })[] = [
  {
    targetKind: 'uncommittedChanges',
    label: '未コミットの変更',
    detail: '作業ツリー（staged / unstaged / untracked）',
  },
  {
    targetKind: 'baseBranch',
    label: 'ベースブランチとの差分',
    detail: '現在のブランチと指定したブランチとの差分',
  },
  { targetKind: 'commit', label: '指定コミット', detail: '特定コミットで入った変更' },
  { targetKind: 'custom', label: '自由記述', detail: '指示文をそのままレビューに渡す' },
];

/** レビューの出し先。 */
const REVIEW_DELIVERY_ITEMS: (vscode.QuickPickItem & { delivery: ReviewDelivery })[] = [
  { delivery: 'inline', label: 'この会話の中', detail: '今のスレッドに続けて出す' },
  { delivery: 'detached', label: '別のタブ', detail: '新しいCodex画面を開いて出す' },
];

/** `uncommittedChanges` 以外の対象で、`showInputBox` に渡す文言。 */
const REVIEW_TARGET_INPUT: Record<
  Exclude<ReviewTargetKind, 'uncommittedChanges'>,
  { prompt: string; value?: string }
> = {
  baseBranch: { prompt: 'ベースブランチ名', value: 'main' },
  commit: { prompt: 'コミットのSHA' },
  custom: { prompt: '指示文' },
};

/**
 * Codex画面。app-server と繋いで会話をその場で描画し、承認と分岐も画面内で完結させる。
 *
 * TUIタブ方式と併存する。こちらは設定がターン単位で効き、会話の途中から直接分岐できる。
 * `TaskSessionHost` を実装し、オーケストレータ（`runner.ts`。次の依頼で実装）がプロバイダを
 * 見ずにタスクのセッションを扱えるようにする（design.md §16.10）。
 */
export class ChatViewManager extends BaseChatViewManager<ChatPanel> implements TaskSessionHost {
  private readonly connection: AppServerConnectionPort;
  /**
   * `thread/start` の応答待ち。複数件を同時に持てる（design.md §16.10の3）。
   * 「最後に開始した1件」を決め打ちで返すと、並列開始時に別タスク宛の通知・承認要求を
   * 誤配送する（詳しくは `pendingStarts.ts` のコメント）。
   */
  private readonly pendingStarts = new PendingStartRegistry<ChatPanel>();

  private readonly catalog: CommandCatalog;
  private commands: SlashCommand[] | undefined;

  constructor(
    codexPath: () => string,
    private readonly settings: SettingsProvider,
    private readonly codexHome: string,
    private readonly fs: FileSystemPort,
    /** `@` のファイル候補。走査の間引きはカタログ側が担う。 */
    private readonly mentions: FileMentionCatalog,
    private readonly log: Logger,
    /** 発言のたびに呼ばれる。二重記録の抑止は受け手（ActivityLogger）が担う。 */
    private readonly onActivity: (activity: ChatActivity) => void = () => undefined,
    /**
     * このthreadIdがタスク（オーケストレータ）管理下かどうか。
     *
     * 汎用のパネル復元（`restorePanel`）は、このスレッドを避けて`false`を返す既定のままなら
     * 従来通り全てのスレッドを拾う。`true`を返すスレッドは復元をここでは行わず、
     * オーケストレータ側（`workspaceState`を読む`runner.ts`。次の依頼）が正しいcwdで
     * 開き直す（design.md §16.10の7）。
     */
    private readonly isTaskManagedThread: (threadId: string) => boolean = () => false,
    /**
     * インポートボタン（issue #227）を押したときに呼ぶ。設定パネルを表示して
     * 「他エージェントからの設定インポート」のセクションを展開する実処理は
     * `extension.ts`側（`ControlPanelViewProvider.revealSection`と
     * `codex.controlPanel.focus`コマンド）に委ねる。ここでは呼ぶことだけを約束し、
     * 実際にパネルを持たないユニットテストからは差し替えて「呼ばれたか」だけを見る。
     */
    private readonly revealImportSection: () => void | Promise<void> = () => undefined,
    /** テスト用の差し替え口。既定は実際にapp-serverプロセスへ繋ぐ本物の接続。 */
    connectionFactory: (
      onNotification: NotificationHandler,
      onServerRequest: ServerRequestHandler,
      onDisconnect: () => void,
    ) => AppServerConnectionPort = (onNotification, onServerRequest, onDisconnect) =>
      new AppServerConnection(codexPath, log, onNotification, onServerRequest, onDisconnect),
  ) {
    super();
    this.catalog = new CommandCatalog(this.fs);
    this.connection = connectionFactory(
      (method, params) => this.routeNotification(method, params),
      (request) => this.routeServerRequest(request),
      () => this.handleConnectionLost(),
    );
  }

  /**
   * 接続断（app-serverのクラッシュ等）を、開いている全スレッドの`ChatSession`へ伝える
   * （issue #354）。`AppServerConnection`は全スレッドで共有される単一プロセスのため、
   * ここで各セッションの保留中の承認・問い合わせを解放しないと、承認カードが
   * 永久にハングしたままになる。パネルやセッション状態自体は残す（テスト用の
   * `FakeAppServerConnection`は`onDisconnect`を呼ばないため、本番の接続でのみ働く）。
   *
   * `thread/start`応答待ちの間（`pendingStarts`）に届いた承認要求も`findByThreadId`が
   * ルーティングしうるため、`panels`だけでなく`allPanels()`（`pendingStarts`も含む）を
   * 走査する。1セッションの解放が例外を投げても他セッションを解放し続けられるよう、
   * 個別にtry/catchで囲む（ここは`proc`の`exit`ハンドラから同期的に呼ばれるため、
   * 捕まえ損ねるとNodeの未捕捉例外になる）。
   */
  private handleConnectionLost(): void {
    for (const entry of this.allPanels()) {
      try {
        entry.session.releasePendingApprovals();
        // `turn/start`等を待っている最中に切れた場合、`busy: true`のままでは
        // 応答が二度と来ず画面が固まる。Claude側と同じ`turnFailed`まで戻す（issue #420）
        entry.session.markTurnFailed();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        this.log.error(`接続断の後始末に失敗しました: ${reason}`);
      }
    }
  }

  /** そのスレッドの画面を開いているか。履歴の印に使う。 */
  isOpen(threadId: string): boolean {
    return this.panels.has(threadId);
  }

  /**
   * 統合テスト専用: webview（レンダラー側のJS）から届いたふりをしたメッセージを流し込む
   * （Issue #187）。
   *
   * 実VSCode上の統合テストでは、拡張機能ホスト側のコードから実際のwebview（別プロセスの
   * レンダラーで動くiframe）へJSを注入してボタンのクリックやEnterキーを再現する手段が無い。
   * ユニットテストが使う `simulateMessage`（`test/mocks/vscode.ts`）と同じ考え方で、
   * `attachPanel` が `panel.webview.onDidReceiveMessage` に登録しているのと同じ
   * `handleMessage` を直接呼ぶ入口をここへ用意する。本番のwebviewが送るメッセージは
   * 形が同じであれば区別なく処理されるため、実際に通る経路（承認の解決・発言の送信・
   * 分岐など）はここを通しても変わらない。呼び出し口は `ChatTestApi.simulateCodexWebviewMessage`
   * （`extension.ts`）で、`AGENT_SESSIONS_INTEGRATION_TEST=1` のときだけ公開される。
   */
  async simulateWebviewMessage(threadId: string, message: unknown): Promise<void> {
    const entry = this.panels.get(threadId);
    if (entry === undefined) {
      throw new Error(`webviewへメッセージを送れませんでした（画面が見つからない）: ${threadId}`);
    }
    await this.handleMessage(entry, message);
  }

  /**
   * 新しい会話を開く。
   *
   * `cwd` / `taskConfig` を省略すると、従来通りワークスペース直下・拡張機能の
   * グローバル設定で始まる（design.md §16.10の1。既存の呼び出しは全て既定値で動く）。
   */
  async openNew(cwd?: string, taskConfig?: CodexConfig): Promise<void> {
    const folder = currentWorkspaceFolder();
    const targetCwd = cwd ?? folder?.uri.fsPath;
    if (targetCwd === undefined) {
      void vscode.window.showErrorMessage(
        'Codexを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
      );
      return;
    }

    // 保護を外した設定のまま開こうとしていないか（issue #222）。パネルを作る前に聞く。
    // タスク用のセッション（`openTaskSession`）は無人実行で人が答えられないため、
    // そちらは `toCodexConfig` が危険な値を持ち込まないようにして防いでいる
    const config = taskConfig ?? readConfig().codex;
    if (!(await confirmUnsafeCombination(config))) {
      return;
    }

    const entry = this.buildEntry(targetCwd, 'Codex', false, taskConfig);
    this.showPanel(entry, false);
    const pendingKey = this.pendingStarts.begin(entry);
    try {
      const threadId = await entry.session.start(targetCwd, config);
      this.pendingStarts.end(pendingKey);
      this.panels.set(threadId, entry);
    } catch (e) {
      this.pendingStarts.end(pendingKey);
      this.teardown(entry);
      this.reportError(e);
    }
  }

  /**
   * タスク用のセッションを開く（`TaskSessionHost`）。
   *
   * パネルはここでは作らない。タブを背面で用意するのは `TaskSession.open()` の役目
   * （design.md §16.10の2）。失敗時は例外を投げ直し、呼び出し側（runner.ts）が
   * タスクを`failed`にできるようにする。
   */
  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    const taskConfig = toCodexConfig(input);
    // オーケストレーターセッション（design.md §16.23）はタスクと同じ経路で開くが、
    // タブ名だけ分けて人が見分けられるようにする
    const title = input.role === 'orchestrator' ? 'Codex: オーケストレーター' : 'Codex';
    const entry = this.buildEntry(input.cwd, title, true, taskConfig);
    const pendingKey = this.pendingStarts.begin(entry);
    // タスク間メッセージング（design.md §16.21）。`input.mcp`が渡されていれば、
    // このスレッドだけに見せるMCPサーバとして`thread/start`のconfigへ差し込む
    // （`ChatSession.start`はmcp_servers自体の意味を知らない。同メソッドのJSDoc参照）
    const mcpServersConfig =
      input.mcp !== undefined
        ? { [MESSAGING_MCP_SERVER_NAME]: { url: input.mcp.url, type: 'streamable_http' } }
        : undefined;
    try {
      const threadId = await entry.session.start(input.cwd, taskConfig, mcpServersConfig);
      this.pendingStarts.end(pendingKey);
      this.panels.set(threadId, entry);
      return this.buildTaskSession(entry, threadId, input.mcp !== undefined);
    } catch (e) {
      this.pendingStarts.end(pendingKey);
      this.teardown(entry);
      this.reportError(e);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** 既存のスレッドを開く。 */
  async openThread(threadId: string, title: string, cwd: string | undefined): Promise<void> {
    const existing = this.panels.get(threadId);
    if (existing !== undefined) {
      this.showPanel(existing, false);
      return;
    }

    const entry = this.buildEntry(cwd, `Codex: ${title}`, false, undefined);
    this.showPanel(entry, false);
    this.panels.set(threadId, entry);
    try {
      await entry.session.resume(threadId, cwd);
    } catch (e) {
      this.panels.delete(threadId);
      this.teardown(entry);
      this.reportError(e);
    }
  }

  /**
   * リロード後にVSCodeが復元したパネルを引き取る。
   * webview側が `setState` で保持していた threadId を使い、会話を読み直す。
   */
  async restorePanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const threadId = readPersistedThreadId(state);
    if (threadId === undefined) {
      // どのスレッドか判らないパネルは残しても操作できない
      panel.dispose();
      return;
    }
    if (this.panels.has(threadId)) {
      panel.dispose();
      return;
    }
    if (this.isTaskManagedThread(threadId)) {
      // タスク管理下のスレッド。汎用復元はここで手を引く（design.md §16.10の7）
      panel.dispose();
      return;
    }

    // 復元されたパネルはcwdを保持していないため、このウィンドウのフォルダを充てる
    const entry = this.buildEntry(currentWorkspaceFolder()?.uri.fsPath, 'Codex', false, undefined);
    this.attachPanel(entry, panel);
    this.panels.set(threadId, entry);
    try {
      await entry.session.resume(threadId, undefined);
    } catch (e) {
      this.panels.delete(threadId);
      this.teardown(entry);
      this.reportError(e);
    }
  }

  /** セッションとループだけを組み立てる。パネルはまだ作らない。 */
  private buildEntry(
    cwd: string | undefined,
    title: string,
    taskManaged: boolean,
    taskConfig: CodexConfig | undefined,
  ): ChatPanel {
    // sessionのコールバックはentryを参照するが、実際に呼ばれるのはentry代入後
    // （closureが束縛するのは変数、呼び出し時点の値を読む。既存コードと同じ流儀）。
    const session = new ChatSession(this.connection, this.log, (state) =>
      this.onSessionChange(entry, state),
    );
    const loop = new LoopController(
      (text) => this.sendFromLoop(entry, text),
      (status) => this.onLoopStatus(entry, status),
    );
    const entry: ChatPanel = {
      panel: undefined,
      session,
      loop,
      cwd,
      attachments: new AttachmentBox(),
      disposed: false,
      title,
      taskManaged,
      taskConfig,
      wasBusy: false,
      wasLoopRunning: false,
      approvalHandler: undefined,
      promptTransform: undefined,
      stateListeners: [],
      finishedListeners: [],
      approvalResolvedListeners: [],
      mcpStartupListeners: [],
      notifiedApprovalRequestIds: new Set(),
    };
    return entry;
  }

  /**
   * パネルを表に出す。既にタブがあれば `reveal`、閉じていれば作り直す
   * （design.md §16.10の4「reveal()でパネルを作り直し、ChatStateから会話を描き直す」）。
   * 会話の再描画は、webview起動時の `ready` 通知への応答（`postState`）に任せる。
   */
  /** `BaseChatViewManager.showPanel`（基底クラス）が新規作成時に呼ぶ、Codex用のパネル生成。 */
  protected override createWebviewPanel(entry: ChatPanel, preserveFocus: boolean): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      VIEW_TYPE,
      entry.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      buildChatPanelOptions(),
    );
  }

  /** `BaseChatViewManager.attachPanel`（基底クラス）が呼ぶ、Codex用のwebview HTML組み立て。 */
  protected override renderPanelHtml(entry: ChatPanel, panel: vscode.WebviewPanel): string {
    // 入力欄アイコン列の表に出すボタン（設定 agent.chat.composerButtons、issue #296）。
    // 検証・既定への丸めは readChatComposerButtonsConfig 側（normalizeComposerButtons）
    // が行うため、ここは警告が有ればログへ出すだけ
    const composerButtonsConfig = readChatComposerButtonsConfig();
    if (composerButtonsConfig.warning !== undefined) {
      this.log.warn(composerButtonsConfig.warning);
    }
    return renderShell(panel.webview, {
      agentLabel: 'Codex',
      provider: 'codex',
      approvalModes: APPROVAL_MODES,
      approvalCycle: APPROVAL_LEVEL_CYCLE,
      sandboxModes: SANDBOX_MODES,
      showSettings: true,
      composerButtons: composerButtonsConfig.buttons,
      // review/startはapp-serverの標準機能なので、コマンド一覧を待たずに常に出す
      review: { mode: 'quickPick' },
      // 会話の1行要約（issue #228、design.md §14.41）。拡張機能の独自機能として、
      // 要約を依頼する指示文を通常のターンとして送る（`ChatSession.recap()`）
      showRecap: true,
      // 他エージェントからの設定インポートの入口（issue #227、design.md §14.42）。
      // 機能の実体はコントロールパネルの一覧UI（issue #36）にあるため、押したときは
      // 会話へは何も送らず、パネルを表示してインポートのセクションを開くだけにする
      // （`handleMessage`の`claudeImport`分岐、`revealImportSection`参照）。
      showImport: {
        ariaLabel: 'インポート設定を開く',
        title: '設定パネルの「他エージェントからの設定インポート」を開きます',
      },
      // 応答本文のMarkdown描画（issue #290、設定 agent.chat.renderMarkdown）
      renderMarkdown: readChatRenderMarkdownConfig(),
      // 送信キー（issue #288、設定 agent.chat.sendOn）。Codex画面にのみ配線している
      // （ChatShellOptions.sendOnのJSDoc参照）
      sendOn: readChatSendOnConfig(),
    });
  }

  /** `BaseChatViewManager.attachPanel`（基底クラス）が配線する、webviewからのメッセージの実処理。 */
  protected override dispatchMessage(entry: ChatPanel, message: unknown): void {
    void this.handleMessage(entry, message);
  }

  /**
   * `TaskSessionHost` が返す口の実体。
   *
   * `mcpRequested` は `openTaskSession` の `input.mcp !== undefined` をそのまま渡す。
   * `false` なら `checkMessagingToolVisible` は確認そのものを行わず常に `true` を返す
   * （`TaskSession.checkMessagingToolVisible` のJSDoc参照）。
   */
  private buildTaskSession(entry: ChatPanel, threadId: string, mcpRequested = false): TaskSession {
    return {
      sessionId: threadId,
      runLoop: (plan: LoopPlan) => entry.loop.start(plan),
      send: (text: string) => {
        void this.sendOnce(entry, text);
      },
      setPromptTransform: (transform) => {
        entry.promptTransform = transform;
      },
      onFinished: (listener) => entry.finishedListeners.push(listener),
      onStateChanged: (listener) => entry.stateListeners.push(listener),
      setApprovalHandler: (handler) => {
        entry.approvalHandler = handler;
      },
      onApprovalResolved: (listener) => entry.approvalResolvedListeners.push(listener),
      interrupt: () => entry.session.interrupt(),
      pauseLoop: () => entry.loop.pause(),
      resumeLoop: () => entry.loop.resume(),
      checkMessagingToolVisible: () =>
        mcpRequested ? this.checkMcpStartupStatus(entry) : Promise.resolve(true),
      stopLoop: () => entry.loop.stop('taskStopped'),
      decideApproval: (requestId, decision) => this.resolveApproval(entry, requestId, decision),
      reveal: () => this.showPanel(entry, false),
      open: (options) => this.showPanel(entry, options.preserveFocus),
      dispose: () => this.teardown(entry),
    };
  }

  /**
   * MCPツールの可視性確認（design.md §16.21・`TaskSession.checkMessagingToolVisible`）。
   *
   * `mcpServer/startupStatus/updated`通知（`status: 'ready' | 'failed' | 'starting'`。
   * 実測、CLI 0.147.0）を待つ。`thread/start`の後にしか届かないため、この関数は
   * `openTaskSession`が解決した後に呼ぶ前提（呼び出し側 `buildTaskSession` 参照）。
   * 一定時間内に確定した状態が届かなければ「見えない」側へ倒す
   * （design.md「見えていなければ...通信なしで走らせる」。timeoutを待たせて起動を
   * 遅らせないよう、この確認自体はrunner.ts側で`await`せず投げっぱなしにする想定）。
   */
  private checkMcpStartupStatus(entry: ChatPanel): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (visible: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const index = entry.mcpStartupListeners.indexOf(listener);
        if (index >= 0) {
          entry.mcpStartupListeners.splice(index, 1);
        }
        resolve(visible);
      };
      const listener = (name: string, status: string): void => {
        if (name !== MESSAGING_MCP_SERVER_NAME) {
          return;
        }
        if (status === 'ready') {
          finish(true);
        } else if (status === 'failed') {
          finish(false);
        }
        // 'starting' はまだ確定していないので待ち続ける
      };
      entry.mcpStartupListeners.push(listener);
      const timer = setTimeout(() => finish(false), MCP_STARTUP_CHECK_TIMEOUT_MS);
      // このタイマーだけでNode/拡張機能ホストのプロセス終了を止めない
      timer.unref?.();
    });
  }

  /**
   * `BaseChatViewManager.teardown`（基底クラス）の拡張フック。`pendingStarts`
   * （`thread/start`応答待ち登録。Claude Codeには対応する概念が無い）からも取り除く。
   */
  protected override onTeardown(entry: ChatPanel): void {
    this.pendingStarts.remove(entry);
  }

  private onSessionChange(entry: ChatPanel, state: ChatState): void {
    if (entry.disposed) {
      return;
    }
    // ターンが終わった瞬間に、待たせていた指示を1件送る
    const finished = entry.wasBusy && !state.busy;
    entry.wasBusy = state.busy;
    if (finished && state.queued.length > 0) {
      void entry.session.sendNextQueued(entry.taskConfig ?? readConfig().codex);
    }
    if (finished) {
      reportTurnResult(this.onActivity, entry.session.threadId, entry.cwd, state);
      this.notifyTurnComplete(entry);
    }
    const title = deriveTitle(state);
    if (title !== undefined && entry.title !== title) {
      entry.title = title;
    }
    // 名前が変わっていなくても、実行中／承認待ちの状態は変わりうるので毎回適用する
    // （issue #286、design.md §14.55）
    if (entry.panel !== undefined) {
      entry.panel.title = decoratePanelTitle(entry.title, deriveSessionActivityState(state));
    }
    this.notifyNewApprovals(entry, state);
    // ターンの完了を見て次の指示を送るため、描画より先にループへ渡す
    entry.loop.observe(state);
    this.postState(entry);
    for (const listener of entry.stateListeners) {
      listener(state);
    }
  }

  /** ループの状態変化。停止（running: true→false）を検知して `onFinished` を1度だけ呼ぶ。 */
  private onLoopStatus(entry: ChatPanel, status: LoopStatus): void {
    const stopped = entry.wasLoopRunning && !status.running;
    entry.wasLoopRunning = status.running;
    this.postState(entry);
    if (stopped && status.stopReason !== undefined) {
      const state = entry.session.getState();
      for (const listener of entry.finishedListeners) {
        listener(status.stopReason, state);
      }
    }
  }

  private async handleMessage(entry: ChatPanel, message: unknown): Promise<void> {
    const m =
      typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
    const type = m['type'];

    try {
      if (type === 'send' && typeof m['text'] === 'string') {
        const text = m['text'];
        // 画像だけ送るのも許す。本文が無くても添付があれば送る意味がある
        if (text.trim() === '' && entry.attachments.list.length === 0) {
          return;
        }
        // 手動の発言はループへの割り込み。指示が交互に飛ぶ状態を作らない
        entry.loop.noteUserAction();
        // 擬似コマンドはCLIへ送らない。送っても文章として素通しされるだけ
        const pseudo = routePseudoCommand(CODEX_PSEUDO_COMMANDS, text);
        if (pseudo !== undefined) {
          await this.runPseudoCommand(entry, pseudo);
          return;
        }
        const attachments = entry.attachments.take();
        try {
          await entry.session.sendOrQueue(
            text,
            entry.taskConfig ?? readConfig().codex,
            attachments,
          );
        } catch (e) {
          // 取り出したまま失わない。貼り直しを強いない
          entry.attachments.restore(attachments);
          throw e;
        }
        this.reportActivity(entry, text);
        this.postState(entry);
        return;
      }
      if (type === 'requestFiles') {
        // タブが閉じている（タスク管理下でパネルが無い）間は送り先が無い。
        // `postState` と同じ流儀で、パネルが無ければ何もしない
        if (entry.panel !== undefined) {
          await postFileMentions(entry.panel, this.mentions, entry.cwd, m['query']);
        }
        return;
      }
      if (type === 'requestImage') {
        if (entry.panel !== undefined) {
          await postImageData(entry.panel, this.fs, entry.session.getState().items, m['path']);
        }
        return;
      }
      if (type === 'openUrl' && typeof m['url'] === 'string') {
        // Webviewからは直接開けない。押した＝行き先を見た上での明示の意思表示なので
        // 追加の確認はしない（design.md §9.9の `url` モードと同じ考え方。issue #18）
        if (isOpenableSearchUrl(m['url'])) {
          void vscode.env.openExternal(vscode.Uri.parse(m['url']));
        }
        return;
      }
      if (type === 'insertCode' && typeof m['code'] === 'string') {
        // コードブロックの「エディタへ挿入」。Webviewからは直接エディタへ書けないため
        // ホスト側で行う（issue #290）。発言や中断とは独立した操作
        await insertCodeIntoEditor(m['code']);
        return;
      }
      if (type === 'openCodeFile' && typeof m['code'] === 'string') {
        // コードブロックの「新規ファイルで開く」（issue #290）
        await openCodeInNewFile(m['code'], typeof m['lang'] === 'string' ? m['lang'] : '');
        return;
      }
      if (type === 'openDiffFile') {
        // 差分の見出し行「エディタで開く」（issue #291）
        await handleOpenDiffFile(entry.session.getState().items, m['itemId'], m['diffIndex']);
        return;
      }
      if (type === 'openDiffEditor') {
        // 差分の見出し行「差分を開く」（issue #291）
        await handleOpenDiffEditor(
          this.fs,
          entry.session.getState().items,
          m['itemId'],
          m['diffIndex'],
        );
        return;
      }
      if (type === 'revertDiff') {
        // 差分の見出し行「この変更を戻す」（issue #291）
        await handleRevertDiff(
          this.fs,
          entry.session.getState().items,
          m['itemId'],
          m['diffIndex'],
        );
        return;
      }
      if (type === 'attach') {
        addAttachment(entry.attachments, m['name'], m['dataUrl']);
        this.postState(entry);
        return;
      }
      if (type === 'dropRejected') {
        noteDropRejected(m['kind']);
        return;
      }
      if (type === 'removeAttachment' && typeof m['id'] === 'string') {
        entry.attachments.remove(m['id']);
        this.postState(entry);
        return;
      }
      if (type === 'interrupt') {
        entry.loop.noteUserAction();
        await entry.session.interrupt();
        return;
      }
      if (type === 'compact') {
        if (!(await confirmCompact())) {
          return;
        }
        // 圧縮は新しいターンを起こす。ループの指示と重ならないよう割り込み扱いにする
        entry.loop.noteUserAction();
        await entry.session.compact();
        return;
      }
      if (type === 'recap') {
        // 要約は新しいターンを起こす（会話が空でなければ）。ループの指示と重ならない
        // よう割り込み扱いにする（`compact`と同じ）。会話を壊す・書き込みが起きるといった
        // 不可逆な操作ではないため、`compact`と違って確認ダイアログは挟まない
        // （`planMode`と同じ扱い。issue #228）
        entry.loop.noteUserAction();
        await entry.session.recap(entry.taskConfig ?? readConfig().codex);
        return;
      }
      if (type === 'claudeImport') {
        // 会話への送信は起きない（`ChatShellOptions.showImport`のJSDoc参照）ため、
        // ループへの割り込み扱い（`noteUserAction`）はしない
        await this.revealImportSection();
        return;
      }
      if (type === 'planMode') {
        entry.loop.noteUserAction();
        entry.session.setPlanMode(m['on'] === true);
        return;
      }
      if (type === 'review') {
        entry.loop.noteUserAction();
        await this.runReview(entry);
        return;
      }
      if (type === 'exportTranscript') {
        // 発言や中断とは独立した操作。ループへの割り込み扱いにはしない
        await runExportTranscript(entry.session.getState().items, 'Codex');
        return;
      }
      if (type === 'workflowMenu') {
        // この会話とは関係のない全体の操作（issue #250）。ループへの割り込み扱いにはせず、
        // 応答中でも押せる。QuickPickの組み立ては`extension.ts`側に一本化してある。
        // 生成（分解・ロードマップ）をこの画面と同じエージェントで走らせるため、
        // プロバイダを添えて渡す（issue #266。省略するとその場で選ばされる）
        await vscode.commands.executeCommand('agent.workflows.menu', 'codex');
        return;
      }
      if (type === 'cancelQueued' && typeof m['index'] === 'number') {
        entry.session.cancelQueued(m['index']);
        return;
      }
      if (type === 'flushQueue') {
        // 待たせていた指示を先に通すため、ループは割り込みとして止める
        entry.loop.noteUserAction();
        await entry.session.flushQueue(entry.taskConfig ?? readConfig().codex);
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
      if (type === 'approve' && isApprovalDecision(m['decision'])) {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          this.resolveApproval(entry, requestId, m['decision']);
        }
        return;
      }
      if (type === 'prompt') {
        const requestId = m['requestId'];
        const submission = readSubmission(m['submission']);
        if ((typeof requestId === 'number' || typeof requestId === 'string') && submission) {
          entry.session.answerPrompt(requestId, submission);
        }
        return;
      }
      if (type === 'fork' && typeof m['turnId'] === 'string') {
        await this.forkFrom(entry, m['turnId']);
        return;
      }
      if (type === 'approvalLevel') {
        // 承認レベル（3段階）。Codexでは承認方法・サンドボックス・承認要求の回し先の
        // 3項目へ展開される（`SettingsProvider.updateApprovalLevel`）
        const level = m['level'];
        if (isApprovalLevel(level)) {
          // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
          await this.settings.updateApprovalLevel('codex', level);
        }
        this.refreshSettings();
        return;
      }
      if (type === 'config') {
        const key = m['key'];
        const value = m['value'];
        if (isEditableKey(key) && typeof value === 'string') {
          // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
          await this.settings.update(key, value);
        }
        this.refreshSettings();
        return;
      }
      if (type === 'stateFull') {
        // webview側が会話の取りこぼしに気付いたときの作り直し要求（issue #262）。
        // 間引きに巻き込むと戻りが遅れるため、その場で送る
        entry.sentItems = undefined;
        this.flushState(entry);
        return;
      }
      if (type === 'ready') {
        // webviewを作り直した直後は会話が空。差し分ではなく全量から送り直す（issue #262）
        entry.sentItems = undefined;
        this.refreshSettings();
        await this.postCommands(entry);
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 擬似コマンドを実行する。CLIへは何も送らない。
   *
   * 対応する動作が拡張機能側にあるものだけを候補に出しているため、ここへ来た要求は
   * 必ず何かを起こす。届かない指示が黙って文章に化けることは無い。
   */
  private async runPseudoCommand(entry: ChatPanel, call: PseudoCommandCall): Promise<void> {
    if (call.action === 'compact') {
      if (call.args !== '') {
        this.log.warn(`/${call.name} は引数を受け取らないため無視します: ${call.args}`);
      }
      if (!(await confirmCompact())) {
        return;
      }
      await entry.session.compact();
      return;
    }
    if (call.action === 'generateAgentsFile') {
      await this.runGenerateAgentsFile(entry);
      return;
    }
    if (call.action === 'sideQuestion') {
      const question = trimmedArgsOrUndefined(call.args);
      if (question === undefined) {
        void vscode.window.showErrorMessage(
          '脇道の質問を入力してください（例: /btw 今のタイムゾーンは？）',
        );
        return;
      }
      await this.startSideQuestion(entry, question);
    }
  }

  /**
   * 脇道の質問を送る（issue #24、design.md §14.26、Codex TUIの `/btw` 相当）。
   *
   * 現在のスレッドをephemeralに（`ephemeral: true`で）forkし、新しいタブへ
   * fork応答をそのまま差し込んでから質問を送る。ephemeralスレッドは
   * `thread/resume` で読み直せないため、既存の「分岐」（`forkFrom`）のように
   * `openThread`（内部で`thread/resume`を呼ぶ）は使わず、`ChatSession.loadForkedThread`
   * でfork応答を直接適用する（`chatSession.ts` 参照）。
   *
   * 元のスレッド（`entry`）の状態には一切触れない。本流の会話が脇道の質問で
   * 汚れないのはこのため。
   */
  private async startSideQuestion(entry: ChatPanel, question: string): Promise<void> {
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      return;
    }

    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '脇道の質問を準備しています…' },
      () => this.connection.request('thread/fork', buildSideQuestionForkParams(threadId)),
    );

    const sideEntry = this.buildEntry(entry.cwd, SIDE_QUESTION_TAB_TITLE, false, undefined);
    let sideThreadId: string;
    try {
      sideThreadId = sideEntry.session.loadForkedThread(response.result);
    } catch (e) {
      this.reportError(e);
      return;
    }
    this.showPanel(sideEntry, false);
    this.panels.set(sideThreadId, sideEntry);
    this.log.info(`脇道の質問を開始しました: ${threadId} → ${sideThreadId}`);

    try {
      await sideEntry.session.send(question, entry.taskConfig ?? readConfig().codex);
    } catch (e) {
      this.reportError(e);
      return;
    }
    this.reportActivity(sideEntry, question);
    this.postState(sideEntry);
  }

  /**
   * `/init` 擬似コマンド。AGENTS.mdの生成をモデルへ指示する（issue #26）。
   *
   * Codexの組込 `/init` はapp-serverに存在しないため、拡張機能が固定の指示文を
   * 組み立てて通常の発言として送る。既存ファイルがあれば必ず上書きの確認を挟む。
   * ワークスペースの場所が分からないときは何もせず、理由を出す
   * （黙って何も起きない状態を作らない）。
   */
  private async runGenerateAgentsFile(entry: ChatPanel): Promise<void> {
    const cwd = entry.cwd ?? currentWorkspaceFolder()?.uri.fsPath;
    if (cwd === undefined) {
      void vscode.window.showErrorMessage('AGENTS.mdを生成する先のワークスペースが分かりません');
      return;
    }
    const agentsFilePath = path.join(cwd, 'AGENTS.md');
    const existing = await this.fs.readTextFile(agentsFilePath);
    if (existing !== undefined && !(await confirmGenerateAgentsFile())) {
      return;
    }
    const text = buildInitInstructionText(existing !== undefined);
    await entry.session.sendOrQueue(text, entry.taskConfig ?? readConfig().codex);
    this.reportActivity(entry, text);
  }

  /**
   * 画面へ現在の状態を送る。設定とループの進行はここで一緒に載せる。
   * 短い間隔で続けて呼ばれた分はまとめる（issue #246）。
   *
   * `item/commandExecution/outputDelta` は巨大な出力の最中に毎秒何千件も届く。1件ごとに
   * 状態全体を `postMessage` すると、そのたびに本文を丸ごと直列化することになり
   * （実測: 2万件で9.7秒の上乗せ）、拡張ホストのイベントループが埋まる。その結果
   * `turn/interrupt` の応答を読むところまで手が回らず、120秒の要求タイムアウトに達していた。
   *
   * 最初の1件はすぐ送り、以降は `STATE_POST_INTERVAL_MS` ごとにまとめる。まとめた分は
   * 必ず最後に1回送る（送り漏らして古い画面が残らないようにする）。
   */
  private postState(entry: ChatPanel): void {
    if (entry.disposed || entry.panel === undefined || entry.postTimer !== undefined) {
      return;
    }
    const since = Date.now() - (entry.lastPostAt ?? 0);
    if (since >= STATE_POST_INTERVAL_MS) {
      this.flushState(entry);
      return;
    }
    entry.postTimer = setTimeout(() => {
      entry.postTimer = undefined;
      this.flushState(entry);
    }, STATE_POST_INTERVAL_MS - since);
  }

  /**
   * 会話項目は差し分だけを `items` へ載せ、`state.items` は空で送る（issue #262）。
   *
   * webviewへの送信は構造化クローンを通るため、変わったのが末尾の1項目だけでも全項目が
   * 直列化される。会話が長いほど1回の送信が重くなり、`STATE_POST_INTERVAL_MS`（50ms）の
   * 間引きの枠が埋まってしまう（実測はdesign.md §9.6。項目数に比例して増える）。
   * webview側は受け取った差し分を積み直して描画する（`stateDelta.ts` の `mergeItems`）。
   */
  private flushState(entry: ChatPanel): void {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    entry.lastPostAt = Date.now();
    const state = entry.session.getState();
    const items = buildItemsDelta(entry.sentItems, state.items);
    entry.sentItems = state.items;
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...state,
        items: [],
        settings: this.settings.snapshot(),
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
        // 差分の見出し行の操作（issue #291）をWebview側でも出し分けるための一覧。
        // 権威ある判定はホスト側（handleOpenDiffFile等）が行うため、ここは
        // ボタン表示のヒントに過ぎない
        workspaceRoots: workspaceFolderPaths(),
      },
      items,
    });
  }

  /**
   * ループからの送信。失敗はループを止める理由になるため、報告したうえで投げ直す。
   *
   * `promptTransform` が設定されていれば、実際にCLIへ送る本文だけそちらを通す。
   * 作業記録（`reportActivity`）には変換前の `text`（テンプレート展開前）を残す
   * （design.md §16.12）。未設定なら従来通り同じ文字列を送信・記録する。
   */
  private async sendFromLoop(entry: ChatPanel, text: string): Promise<void> {
    const toSend = entry.promptTransform?.(text) ?? text;
    try {
      await entry.session.send(toSend, entry.taskConfig ?? readConfig().codex);
      this.reportActivity(entry, text);
    } catch (e) {
      this.reportError(e);
      throw e;
    }
  }

  /**
   * ループを介さずに本文を1回だけ送る（`TaskSession.send`。design.md §16.23）。
   *
   * `sendFromLoop` と違い `promptTransform` は通さず、作業記録にも残さない。この口を使う
   * のはオーケストレーターセッションだけで、その会話本文は §16.12 の記録対象外にしてある。
   * 送信の失敗はループを止める理由にならないため、報告するだけで投げ直さない。
   */
  private async sendOnce(entry: ChatPanel, text: string): Promise<void> {
    try {
      await entry.session.send(text, entry.taskConfig ?? readConfig().codex);
    } catch (e) {
      this.reportError(e);
    }
  }

  /** 発言をこのセッションの作業記録として通知する。送信のたび毎回記録する。 */
  private reportActivity(entry: ChatPanel, text: string): void {
    const sessionId = entry.session.threadId;
    if (sessionId === undefined || entry.cwd === undefined) {
      return;
    }
    this.onActivity({ sessionId, cwd: entry.cwd, kind: 'prompt', text });
  }

  /** 会話の途中から分岐し、新しい画面で開く。元のスレッドは変更されない。 */
  private async forkFrom(entry: ChatPanel, turnId: string): Promise<void> {
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      return;
    }

    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'この指示から分岐しています…' },
      () => this.connection.request('thread/fork', { threadId, lastTurnId: turnId }),
    );

    const newThreadId = readForkedThreadId(response.result);
    if (newThreadId === undefined) {
      void vscode.window.showErrorMessage('分岐後のスレッドidを読み取れませんでした');
      return;
    }
    this.log.info(`分岐しました: ${threadId} → ${newThreadId}`);
    await this.openThread(newThreadId, '分岐', undefined);
  }

  /**
   * コードレビューを起動する。
   *
   * 対象（4種）とdelivery（この会話の中 / 別のタブ）をQuickPickで選ばせてから
   * `review/start` を呼ぶ。`detached` を選んだ場合は、返ってきた `reviewThreadId` で
   * 新しいCodex画面を開く（`forkFrom` と同じ導線）。
   */
  private async runReview(entry: ChatPanel): Promise<void> {
    const targetChoice = await vscode.window.showQuickPick(REVIEW_TARGET_ITEMS, {
      title: 'レビューの対象',
      placeHolder: '何をレビューしますか',
    });
    if (targetChoice === undefined) {
      return;
    }

    const target = await this.promptReviewTarget(targetChoice.targetKind);
    if (target === undefined) {
      return;
    }

    const deliveryChoice = await vscode.window.showQuickPick(REVIEW_DELIVERY_ITEMS, {
      title: 'レビューの出し先',
      placeHolder: 'どこに結果を出しますか',
    });
    if (deliveryChoice === undefined) {
      return;
    }

    try {
      const reviewThreadId = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'レビューを開始しています…' },
        () => entry.session.startReview(target, deliveryChoice.delivery),
      );
      this.log.info(`レビューを開始しました: ${reviewThreadId} (${deliveryChoice.delivery})`);
      if (deliveryChoice.delivery === 'detached') {
        await this.openThread(reviewThreadId, 'レビュー', entry.cwd);
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * レビュー対象ごとに要る入力を聞く。
   *
   * `uncommittedChanges` は追加入力が不要。それ以外はQuickPickの選択に応じて
   * `showInputBox` で1項目だけ聞く。空文字のまま進めると何が起きたか画面から
   * 分からなくなるため、`buildReviewTarget` が拒否したらエラーを出して中止する。
   */
  private async promptReviewTarget(kind: ReviewTargetKind): Promise<ReviewTarget | undefined> {
    if (kind === 'uncommittedChanges') {
      return buildReviewTarget(kind, '');
    }

    const spec = REVIEW_TARGET_INPUT[kind];
    const input = await vscode.window.showInputBox({
      prompt: spec.prompt,
      ...(spec.value === undefined ? {} : { value: spec.value }),
      validateInput: (v) => (v.trim() === '' ? '入力してください' : undefined),
    });
    if (input === undefined) {
      // キャンセル
      return undefined;
    }

    const target = buildReviewTarget(kind, input);
    if (target === undefined) {
      void vscode.window.showErrorMessage('レビューの対象を読み取れませんでした');
    }
    return target;
  }

  /**
   * タブ名を変更する。Codex側に永続化されるため、履歴一覧やTUIタブにも反映される。
   * 名前は会話内容からCodexが自動で付けるので、これはその上書き。
   */
  async renameActive(): Promise<void> {
    const entry = this.active;
    if (entry === undefined || entry.session.threadId === undefined) {
      void vscode.window.showInformationMessage('名前を変更するCodex画面を開いてください');
      return;
    }

    const current = entry.session.getState().name ?? '';
    const name = await vscode.window.showInputBox({
      prompt: 'このセッションの名前',
      value: current,
      validateInput: (v) => (v.trim() === '' ? '名前を入力してください' : undefined),
    });
    if (name === undefined || name.trim() === '' || name === current) {
      return;
    }

    try {
      await entry.session.setName(name.trim());
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * いまの会話を捨てて、同じ作業フォルダで新しい会話を始める（TUIの `/clear` 相当）。
   *
   * 対象は「名前を変更」と同じく最後にアクティブだったCodex画面。会話そのものは
   * ロールアウトに残り履歴から開き直せるため、確認は進行中のターンがあるときだけ出す。
   * タブは作り直す（`teardown` がタブごと閉じ、`openNew` が同じ列へ開く）。既存のタブを
   * 使い回すと、webviewへ配線済みのハンドラが古いセッションを掴んだまま残るため。
   */
  async clearActive(): Promise<void> {
    const entry = this.active;
    if (entry === undefined) {
      void vscode.window.showInformationMessage('クリアするCodex画面を開いてください');
      return;
    }
    // タスク（オーケストレータ）管理下のタブは、走らせている側が寿命を持つ
    if (entry.taskManaged) {
      void vscode.window.showWarningMessage('タスクが動かしている画面はクリアできません');
      return;
    }
    if (entry.session.getState().busy) {
      const choice = await vscode.window.showWarningMessage(
        '応答の途中です。クリアすると進行中のターンは中断されます。',
        { modal: true },
        'クリアする',
      );
      if (choice !== 'クリアする') {
        return;
      }
    }

    const cwd = entry.cwd;
    this.teardown(entry);
    await this.openNew(cwd);
  }

  /**
   * 入力欄の候補を送る。
   *
   * 一度読んだら使い回す。ファイル数は多くないが、画面を開くたびに走査する意味も無い。
   */
  private async postCommands(entry: ChatPanel): Promise<void> {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    this.commands ??= await this.loadCommands();
    void entry.panel.webview.postMessage({ type: 'commands', commands: this.commands });
  }

  /**
   * 使用量をapp-serverへ問い合わせる。
   *
   * ロールアウトの追記を待つ必要が無く、いま時点の値が返る。接続していなければ
   * 何も返さず、ファイル由来の値をそのまま使わせる。
   */
  async readUsage(): Promise<UsageSnapshot | undefined> {
    try {
      await this.connection.ensureStarted();
      const response = await this.connection.request('account/rateLimits/read', null);
      return readRateLimits(response.result, new Date().toISOString());
    } catch (e) {
      this.log.warn(`使用量を取得できませんでした: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  /**
   * 候補を作る。
   *
   * 組込コマンドは出さない。app-serverへ送ってもただの文章になるため（実測で確認）、
   * 代わりに拡張機能側の擬似コマンドを先頭へ置く。
   *
   * スキルは app-server に聞く（無効化されたものを除け、プロジェクト側も解決済みで返る）。
   * 接続できない場合でもファイル由来の候補だけは出す。
   */
  private async loadCommands(): Promise<SlashCommand[]> {
    const fromFiles = await this.catalog.forCodex(this.codexHome, workspaceFolderPaths());
    try {
      await this.connection.ensureStarted();
      const response = await this.connection.request('skills/list', {
        cwd: currentWorkspaceFolder()?.uri.fsPath ?? this.codexHome,
      });
      return withPseudoCommands(
        CODEX_PSEUDO_COMMANDS,
        mergeCommands(fromFiles, readSkillsList(response.result)),
      );
    } catch (e) {
      this.log.warn(`スキル一覧を取得できませんでした: ${e instanceof Error ? e.message : e}`);
      return withPseudoCommands(CODEX_PSEUDO_COMMANDS, fromFiles);
    }
  }

  refreshSettings(): void {
    for (const entry of this.allPanels()) {
      this.postState(entry);
    }
  }

  /**
   * `BaseChatViewManager.allPanels`のオーバーライド。`thread/start`応答待ち
   * （`pendingStarts`）もここへ含める（Claude Codeには対応する概念が無い非対称。
   * `chatManagerBase.ts`のクラスJSDoc参照）。
   */
  protected override allPanels(): ChatPanel[] {
    return [...this.panels.values(), ...this.pendingStarts.values()];
  }

  private routeNotification(method: string, params: Record<string, unknown>): void {
    // account/rateLimits/updated のようなアカウント単位の通知は threadId を持たない。
    // スレッドで絞れないので開いている（開始待ちも含む）画面すべてへ配る。
    if (params['threadId'] === undefined) {
      for (const entry of this.allPanels()) {
        entry.session.applyNotification(method, params);
      }
      return;
    }

    const target = this.findByThreadId(params['threadId']);
    if (method === 'mcpServer/startupStatus/updated') {
      // MCPツールの可視性確認（design.md §16.21）専用の内部状態。会話には無関係なため
      // ChatSession.applyNotificationへは転送しない（`mcpStartupListeners`のJSDoc参照）
      const name = typeof params['name'] === 'string' ? params['name'] : '';
      const status = typeof params['status'] === 'string' ? params['status'] : '';
      for (const listener of target?.mcpStartupListeners ?? []) {
        listener(name, status);
      }
      return;
    }
    target?.session.applyNotification(method, params);
  }

  private async routeServerRequest(request: ServerRequest): Promise<unknown> {
    const target = this.findByThreadId(request.params['threadId']);
    if (target === undefined) {
      // 対応する画面が無い要求に「許可」を返してはいけない
      this.log.warn(`宛先不明の要求を拒否しました: ${request.method}`);
      const denial = defaultDenyResponse(request.method, request.params);
      if (denial === undefined) {
        // 応答の値を作れない要求。捏造せずエラーで相手を解放する
        throw new Error(`この拡張機能は ${request.method} に応答できません`);
      }
      return denial;
    }

    // タスク実行中のセッションなら、承認カードを出す前に自動判定へ回す（design.md §16.10の6）。
    // 判定そのもの（classifyApprovalRequest）はrunner.tsの責務で、ここは差し込み口を通すだけ。
    if (target.approvalHandler !== undefined) {
      const approval = describeApproval(request.id, request.method, request.params);
      if (approval !== undefined) {
        // 判定の入力は生の要求パラメータ（request.params）。表示用に整形済みのapprovalは
        // 種別・requestId・itemIdの参照にだけ使う（design.md §16.7）
        const result = await target.approvalHandler(approval, request.params);
        if (result.kind === 'auto') {
          this.log.info(`承認(自動判定): ${approval.kind} → ${result.decision}`);
          return buildApprovalResponse(approval.kind, result.decision, request.params);
        }
        // ask: 従来どおり承認カードを出して人を待つ
      }
    }
    return target.session.requestApproval(request);
  }

  /**
   * threadIdから画面を引く。`panels` に無ければ、開始待ちの中から**そのthreadIdを
   * 実際に記録しているエントリ**を探す（design.md §16.10の3）。
   *
   * 「開始待ちが1件だけだから」という決め打ちはしない。並列開始時に別タスク宛の
   * 通知・承認要求を誤って渡すと、それは「別タスクの操作を勝手に許可する」事故になる。
   * 一致するものが無ければ宛先不明として `undefined`（誤配送より安全な失敗）。
   */
  private findByThreadId(threadId: unknown): ChatPanel | undefined {
    if (typeof threadId !== 'string') {
      return undefined;
    }
    const known = this.panels.get(threadId);
    if (known !== undefined) {
      return known;
    }
    const pending = this.pendingStarts.findByThreadId(threadId, (entry) => entry.session.threadId);
    if (pending !== undefined) {
      return pending;
    }
    // `thread/start` の応答前に届いた通知。開始待ちが1件だけなら宛先は一意に定まる。
    // 2件以上あるときは諦める（取りこぼしより誤配送のほうが重い。§16.10の3）
    return this.pendingStarts.soleEntry();
  }

  private reportError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log.error(`Codex画面: ${message}`);
    void vscode.window.showErrorMessage(`Codex: ${message}`);
  }

  /**
   * `BaseChatViewManager.dispose`の拡張フック。全スレッドで共有する`AppServerConnection`
   * を解放する（Claude Codeはセッションごとに別プロセスのため対応する処理が無い）。
   */
  protected override onDispose(): void {
    this.connection.dispose();
  }
}

export type { ChatState };

/**
 * タブ名を決める。
 *
 * Codexが会話内容から付ける名前を優先するが、それが届くまでは最初の指示から作る。
 * 名前が付かないまま会話が進むと、どのタブが何の話か判らなくなるため。
 */
function deriveTitle(state: ChatState): string | undefined {
  if (state.name !== undefined && state.name !== '') {
    return `Codex: ${state.name}`;
  }
  const first = state.items.find((i) => i.kind === 'userMessage' && i.text.trim() !== '');
  if (first === undefined) {
    return undefined;
  }
  return `Codex: ${summarize(first.text, 32)}`;
}

/** ファイル由来とAPI由来を混ぜる。同じ名前はAPI側の説明を優先する。 */
function mergeCommands(fromFiles: SlashCommand[], fromApi: SlashCommand[]): SlashCommand[] {
  const byName = new Map(fromFiles.map((c) => [c.name, c]));
  for (const command of fromApi) {
    byName.set(command.name, command);
  }
  return [...byName.values()];
}

/**
 * 画面から返ってきた回答を読む。
 *
 * Webviewからの値は信用せず、型が合わないものは落とす。中身を作らずに落とすことで、
 * 壊れた回答をapp-serverへ流さない。
 */
function readSubmission(raw: unknown): PromptSubmission | undefined {
  const submission =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const action = submission['action'];
  if (action !== 'submit' && action !== 'decline' && action !== 'cancel') {
    return undefined;
  }
  const rawValues =
    typeof submission['values'] === 'object' && submission['values'] !== null
      ? (submission['values'] as Record<string, unknown>)
      : {};
  const values: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(rawValues)) {
    if (Array.isArray(value)) {
      values[id] = value.filter((v): v is string => typeof v === 'string');
    }
  }
  return { action, values };
}
