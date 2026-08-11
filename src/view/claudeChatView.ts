import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { isApprovalDecision, type ApprovalDecision } from '../appserver/approvals';
import { isOpenableSearchUrl, type ChatState, type ChatUsage } from '../appserver/chatState';
import type { ClaudeSessionStore } from '../claude/sessionStore';
import { ClaudeStreamSession } from '../claude/streamSession';
import { transcriptItems } from '../claude/transcript';
import { isUnsafeClaudeCombination } from '../claude/argvBuilder';
import { currentWorkspaceFolder, readClaudeConfig, workspaceFolderPaths } from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { LoopPlan, LoopStatus, LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import { ClaudeUsageProbe } from '../claude/usageProbe';
import { CommandCatalog } from '../provider/commandCatalog';
import type { SlashCommand } from '../provider/slashCommands';
import { AttachmentBox } from '../provider/attachments';
import type {
  ApprovalHandler,
  ApprovalOutcome,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../orchestrator/taskSession';
import {
  addAttachment,
  confirmCompact,
  confirmRewindFiles,
  confirmStopBackgroundTask,
  postFileMentions,
  postImageData,
  renderShell,
  reportTurnResult,
} from './chatView';
import type { FileMentionCatalog } from '../provider/fileMentions';
import { readPersistedThreadId } from './panelState';
import { CLAUDE_PERMISSION_MODES } from '../claude/types';
import { CLAUDE_APPROVAL_CYCLE } from '../provider/approvalCycle';
import type { ClaudeConfig } from '../claude/types';
import type { ClaudeEditableKey, SettingsProvider } from './settingsProvider';
import type { ChatActivity } from './chatView';

interface ClaudePanel {
  /** タブが今開いているか。`undefined` は閉じている状態（design.md §16.10の4）。 */
  panel: vscode.WebviewPanel | undefined;
  session: ClaudeStreamSession;
  /** この画面で走らせているループ。走っていなければ待機状態のまま。 */
  loop: LoopController;
  cwd: string;
  /** 送信前の添付画像。送るまでここに溜める。 */
  attachments: AttachmentBox;
  /** 破棄済みか。破棄済みのWebviewへ送るとVSCodeが例外を投げるため見張る。 */
  disposed: boolean;
  /** パネルの見出し。タブが閉じている間もタイトルを見失わないよう別に保持する。 */
  title: string;
  /** タスク（オーケストレータ）管理下のセッションか（design.md §16.10の4）。 */
  taskManaged: boolean;
  /**
   * タスク単位の設定。`ClaudeStreamSession` は起動時の引数で固定されるため、
   * Codexと違い送信のたびに読み直す必要は無いが、Plan modeを抜けるときの
   * 戻し先（`permissionMode`）だけはグローバル設定ではなくこちらを見る。
   */
  taskConfig: ClaudeConfig | undefined;
  /** ターン完了検知に使う直前の値。 */
  wasBusy: boolean;
  /** ループ停止検知に使う直前の値。 */
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
  /** `TaskSession.onApprovalResolved` のリスナー。 */
  approvalResolvedListeners: Array<(outcome: ApprovalOutcome) => void>;
}

const VIEW_TYPE = 'claude.chat';
const LABEL = 'Claude Code';

/**
 * `TaskSessionInput` をClaude Codeの起動設定へ写す。`sandbox` はClaudeに概念が無いため使わない。
 * `agent` はタスクオーケストレーション（design.md §16）が扱う語彙に無いため常に空文字にする
 * （タスクは既定のエージェントで走る）。
 */
function toClaudeConfig(input: TaskSessionInput): ClaudeConfig {
  return {
    model: input.config.model,
    effort: input.config.effort,
    permissionMode: input.config.approvalMode,
    agent: '',
    additionalArgs: [],
  };
}

/**
 * Claude Code画面。`claude` を stream-json で常駐させ、会話と承認を画面内で完結させる。
 *
 * 描画はCodex画面と同じHTML（`renderShell`）を使う。プロバイダごとの差は
 * このクラスとイベント正規化（streamJson.ts）に閉じている。`TaskSessionHost` を実装し、
 * オーケストレータ（`runner.ts`。次の依頼）がプロバイダを見ずにタスクを扱えるようにする
 * （design.md §16.10）。
 */
export class ClaudeChatViewManager implements vscode.Disposable, TaskSessionHost {
  private readonly panels = new Map<string, ClaudePanel>();
  private approvalWarned = false;

  private readonly catalog: CommandCatalog;
  private readonly usageProbe: ClaudeUsageProbe;
  private commands: SlashCommand[] | undefined;

  constructor(
    private readonly claudePath: () => string,
    private readonly fs: FileSystemPort,
    /** `@` のファイル候補。Codex画面と同じカタログを使い回す。 */
    private readonly mentions: FileMentionCatalog,
    private readonly claudeHome: string,
    private readonly store: ClaudeSessionStore,
    private readonly settings: SettingsProvider,
    private readonly log: Logger,
    private readonly onActivity: (activity: ChatActivity) => void = () => undefined,
    /** 制限の状態が更新されたときに知らせる。ステータスバーの表示に使う。 */
    private readonly onUsage: (usage: ChatUsage) => void = () => undefined,
    /**
     * このsessionIdがタスク（オーケストレータ）管理下かどうか。既定は常に`false`
     * （従来通り全セッションを汎用復元の対象にする）。`true`を返すセッションは
     * `restorePanel` の対象から外す（design.md §16.10の7）。
     */
    private readonly isTaskManagedThread: (sessionId: string) => boolean = () => false,
  ) {
    this.catalog = new CommandCatalog(fs);
    this.usageProbe = new ClaudeUsageProbe(claudePath, log);
  }

  /**
   * 消費率を読み直す。
   *
   * `rate_limit_event` は割合を持たないため、`/usage` を別プロセスで叩いて補う。
   * 間隔を空けるのはProbe側の責務。
   */
  private async refreshUsage(): Promise<void> {
    const usage = await this.usageProbe.read();
    if (usage !== undefined) {
      this.onUsage(usage);
    }
  }

  /**
   * 入力欄の候補を送る。
   *
   * CLIが `initialize` の応答で使えるコマンドを全部返すため、そちらを優先する
   * （組込・ユーザー定義・プラグイン由来が揃っており、実在しないものは入らない）。
   * まだ届いていない、または取れなかった場合だけファイルを走査した一覧で代替する。
   */
  private async postCommands(entry: ClaudePanel): Promise<void> {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    const fromCli = entry.session.commands;
    const commands =
      fromCli.length > 0
        ? fromCli
        : (this.commands ??= await this.catalog.forClaude(this.claudeHome, workspaceFolderPaths()));
    void entry.panel.webview.postMessage({ type: 'commands', commands });
  }

  /**
   * 画面下の設定行へ現在値と選択肢を送る。
   *
   * 描画はCodex画面と同じスクリプトなので、Codex側のスナップショットと同じ形に整えて渡す。
   * モデルの一覧は `initialize` の応答から取ったもの（取れなければエイリアス）。
   */
  private refreshSettings(entry: ClaudePanel): void {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    const snapshot = this.settings.claudeSnapshot();
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...entry.session.getState(),
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
        settings: {
          models: snapshot.models,
          efforts: snapshot.efforts,
          agents: snapshot.agents,
          model: snapshot.model,
          reasoningEffort: snapshot.effort,
          approvalMode: snapshot.permissionMode,
          agent: snapshot.agent,
          defaults: {
            model: snapshot.defaults.model,
            reasoningEffort: snapshot.defaults.effort,
            approvalMode: snapshot.defaults.permissionMode,
            sandbox: undefined,
            // エージェントの既定値はsettings.jsonから読んでいない（表示のみの用途に対して
            // 追跡コストが見合わないため）。「既定 (CLI側に指定なし)」とだけ出す
            agent: undefined,
          },
          profile: '',
        },
      },
    });
  }

  /**
   * 画面へ現在の状態だけを送る（設定は含めない）。ストリーミング中の細かい更新は
   * こちらを使い、設定込みの完全な状態は `refreshSettings` が担う
   * （既存の挙動をそのまま踏襲。webview側は届かないキーを前回の値のまま保つ）。
   */
  private postState(entry: ClaudePanel): void {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...entry.session.getState(),
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
      },
    });
  }

  /** 新しい会話を開く。idは起動前に決まるため、開いた時点で履歴と紐づく。 */
  async openNew(cwd?: string, taskConfig?: ClaudeConfig): Promise<void> {
    const folder = currentWorkspaceFolder();
    const targetCwd = cwd ?? folder?.uri.fsPath;
    if (targetCwd === undefined) {
      void vscode.window.showErrorMessage(
        'Claude Codeを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
      );
      return;
    }
    const effectiveConfig = taskConfig ?? readClaudeConfig().claude;
    if (isUnsafeClaudeCombination(effectiveConfig) && !(await this.confirmUnsafe())) {
      return;
    }

    const sessionId = randomSessionId();
    const entry = this.buildEntry(targetCwd, LABEL, false, taskConfig);
    this.showPanel(entry, false);
    this.panels.set(sessionId, entry);
    entry.session.start({
      cwd: targetCwd,
      target: { kind: 'new' },
      sessionId,
      config: effectiveConfig,
    });
  }

  /**
   * タスク用のセッションを開く（`TaskSessionHost`）。
   *
   * タスクは無人で走るため、`openNew` の「安全でない組み合わせの確認ダイアログ」は
   * 経由しない（応答する人がおらず、出しても永久に止まるだけ）。タスク単位の設定を
   * 安全側へ収める判定（クランプ）はrunner.ts側の責務。パネルはここでは作らない
   * （`TaskSession.open()` の役目。design.md §16.10の2）。
   */
  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    const taskConfig = toClaudeConfig(input);
    const sessionId = randomSessionId();
    const entry = this.buildEntry(input.cwd, LABEL, true, taskConfig);
    this.panels.set(sessionId, entry);
    entry.session.start({
      cwd: input.cwd,
      target: { kind: 'new' },
      sessionId,
      config: taskConfig,
    });
    return this.buildTaskSession(entry, sessionId);
  }

  /** 既存のセッションを開く。過去のやり取りはtranscriptから復元する。 */
  async openThread(sessionId: string, title: string, cwd: string | undefined): Promise<void> {
    const existing = this.panels.get(sessionId);
    if (existing !== undefined) {
      this.showPanel(existing, false);
      return;
    }

    const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
    if (folder === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      return;
    }

    const entry = this.buildEntry(folder, `${LABEL}: ${title}`, false, undefined);
    this.showPanel(entry, false);
    this.panels.set(sessionId, entry);
    const transcript = await this.readTranscript(sessionId);
    entry.session.start({
      cwd: folder,
      target: { kind: 'resume', sessionId },
      sessionId: undefined,
      config: readClaudeConfig().claude,
      initialItems: transcript.items,
      initialTodos: transcript.todos,
    });
  }

  /**
   * `--resume` は過去のやり取りを流さないため、transcriptを読んで初期表示にする。
   * TODO一覧も同じtranscriptから最後の内容を拾い、専用表示の初期値に使う。
   */
  private async readTranscript(
    sessionId: string,
  ): Promise<{ items: ChatState['items']; todos: ChatState['todos'] }> {
    const filePath = await this.store.resolveTranscriptPath(sessionId);
    if (filePath === undefined) {
      return { items: [], todos: [] };
    }
    const content = await this.fs.readTextFile(filePath);
    return content === undefined ? { items: [], todos: [] } : transcriptItems(content.split('\n'));
  }

  /**
   * リロード後にVSCodeが復元したパネルを引き取る。
   * webview側が `setState` で保持していたセッションidを使い、会話を読み直す。
   */
  async restorePanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const sessionId = readPersistedThreadId(state);
    if (sessionId === undefined || this.panels.has(sessionId)) {
      // どのセッションか判らないパネル、および二重に復元されたパネルは操作できない
      panel.dispose();
      return;
    }
    if (this.isTaskManagedThread(sessionId)) {
      // タスク管理下のセッション。汎用復元はここで手を引く（design.md §16.10の7）
      panel.dispose();
      return;
    }

    // 復元されたパネルはcwdを保持していない。transcriptの素性から取り戻す
    const cwd = (await this.store.resolveCwd(sessionId)) ?? currentWorkspaceFolder()?.uri.fsPath;
    if (cwd === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      panel.dispose();
      return;
    }

    const entry = this.buildEntry(cwd, LABEL, false, undefined);
    this.attachPanel(entry, panel);
    this.panels.set(sessionId, entry);
    const transcript = await this.readTranscript(sessionId);
    entry.session.start({
      cwd,
      target: { kind: 'resume', sessionId },
      sessionId: undefined,
      config: readClaudeConfig().claude,
      initialItems: transcript.items,
      initialTodos: transcript.todos,
    });
  }

  /** セッションとループだけを組み立てる。パネルはまだ作らない。 */
  private buildEntry(
    cwd: string,
    title: string,
    taskManaged: boolean,
    taskConfig: ClaudeConfig | undefined,
  ): ClaudePanel {
    const session = new ClaudeStreamSession(
      this.claudePath,
      this.log,
      (state) => this.onSessionChange(entry, state),
      () => this.warnApprovalsUnavailable(),
      // 起動直後と、セッション中に増減したときに届く
      () => void this.postCommands(entry),
      // entry.approvalHandlerはsetApprovalHandlerで後から差し込まれることがあるため、
      // 構築時に固定せず呼び出しのたびに読み直す（クロージャで参照するだけ）
      (approval, rawParams) =>
        entry.approvalHandler !== undefined
          ? entry.approvalHandler(approval, rawParams)
          : Promise.resolve({ kind: 'ask' as const }),
    );

    const loop = new LoopController(
      (text) => this.sendFromLoop(entry, text),
      (status) => this.onLoopStatus(entry, status),
    );

    const entry: ClaudePanel = {
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
    };
    return entry;
  }

  /**
   * パネルを表に出す。既にタブがあれば `reveal`、閉じていれば作り直す
   * （design.md §16.10の4）。会話の再描画はwebview起動時の `ready` 通知への応答に任せる。
   */
  private showPanel(entry: ClaudePanel, preserveFocus: boolean): void {
    if (entry.disposed) {
      return;
    }
    if (entry.panel !== undefined) {
      entry.panel.reveal(undefined, preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      entry.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.attachPanel(entry, panel);
  }

  private attachPanel(entry: ClaudePanel, panel: vscode.WebviewPanel): void {
    entry.panel = panel;
    panel.title = entry.title;
    // 復元されたパネルはスクリプトの許可が落ちているため、ここで入れ直す
    panel.webview.options = { enableScripts: true };
    panel.webview.html = renderShell(panel.webview, {
      agentLabel: LABEL,
      approvalModes: CLAUDE_PERMISSION_MODES,
      approvalCycle: CLAUDE_APPROVAL_CYCLE,
      showSettings: true,
      showAgentSelector: true,
      // effort・エージェントだけ扱いが違う。黙って効かないより、効くタイミングを書くほうがまし
      settingsNote:
        'モデルと承認は今の会話にすぐ効きます。Effortは送りますが、CLIが結果を返さないため反映は確かめられません。エージェントは起動引数でのみ決まるため、変更は次のセッションから効きます。「既定」へ戻す操作も次のセッションから効きます。',
      // /review は実在しない（実測で /code-review を確認済み）。一覧に無ければボタンを隠す
      review: { mode: 'command', commandName: 'code-review' },
      // ファイルの巻き戻し（design.md「Claude Codeの巻き戻し」）。Codexは分岐で代替する
      showRewind: true,
    });
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(entry, message));
    panel.onDidDispose(() => {
      entry.panel = undefined;
      if (!entry.taskManaged) {
        // 人が手で開いた画面は、これまで通りタブを閉じたらセッションも終わる
        this.teardown(entry);
      }
    });
  }

  /** `TaskSessionHost` が返す口の実体。 */
  private buildTaskSession(entry: ClaudePanel, sessionId: string): TaskSession {
    return {
      sessionId,
      runLoop: (plan: LoopPlan) => entry.loop.start(plan),
      setPromptTransform: (transform) => {
        entry.promptTransform = transform;
      },
      onFinished: (listener) => entry.finishedListeners.push(listener),
      onStateChanged: (listener) => entry.stateListeners.push(listener),
      setApprovalHandler: (handler) => {
        entry.approvalHandler = handler;
      },
      onApprovalResolved: (listener) => entry.approvalResolvedListeners.push(listener),
      interrupt: () => {
        entry.session.interrupt();
        return Promise.resolve();
      },
      stopLoop: () => entry.loop.stop('taskStopped'),
      decideApproval: (requestId, decision) => this.resolveApproval(entry, requestId, decision),
      reveal: () => this.showPanel(entry, false),
      open: (options) => this.showPanel(entry, options.preserveFocus),
      dispose: () => this.teardown(entry),
    };
  }

  /**
   * 承認要求を決定する。webviewの承認カードとワークフローViewの「承認」操作
   * （`TaskSession.decideApproval`）の共通経路（design.md §16.8）。`chatView.ts`と同じ理由で
   * 分けてある。
   */
  private resolveApproval(
    entry: ClaudePanel,
    requestId: number | string,
    decision: ApprovalDecision,
  ): void {
    entry.session.decide(requestId, decision);
    for (const listener of entry.approvalResolvedListeners) {
      listener({ requestId, decision });
    }
  }

  /**
   * エントリを完全に破棄する。二重に呼んでも安全（`disposed` で早期return）。
   * タブを閉じたことによる破棄と、明示的な `dispose()` 呼び出しの両方から通る。
   */
  private teardown(entry: ClaudePanel): void {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    entry.loop.stop('manual');
    entry.session.dispose();
    entry.panel?.dispose();
    entry.panel = undefined;
    for (const [id, value] of this.panels) {
      if (value === entry) {
        this.panels.delete(id);
      }
    }
  }

  private onSessionChange(entry: ClaudePanel, state: ChatState): void {
    if (entry.disposed) {
      return;
    }
    // ターンが終わった瞬間に、待たせていた指示を1件送る
    const finished = entry.wasBusy && !state.busy;
    entry.wasBusy = state.busy;
    if (finished && state.queued.length > 0) {
      entry.session.sendNextQueued();
    }
    if (finished) {
      reportTurnResult(this.onActivity, entry.session.threadId, entry.cwd, state);
    }
    const next = deriveTitle(state);
    if (next !== undefined && entry.title !== next) {
      entry.title = next;
      if (entry.panel !== undefined) {
        entry.panel.title = next;
      }
    }
    if (state.usage !== undefined) {
      this.onUsage(state.usage);
    }
    if (finished) {
      void this.refreshUsage();
    }
    // ターンの完了を見て次の指示を送るため、描画より先にループへ渡す
    entry.loop.observe(state);
    this.postState(entry);
    for (const listener of entry.stateListeners) {
      listener(state);
    }
  }

  /** ループの状態変化。停止（running: true→false）を検知して `onFinished` を1度だけ呼ぶ。 */
  private onLoopStatus(entry: ClaudePanel, status: LoopStatus): void {
    const stopped = entry.wasLoopRunning && !status.running;
    entry.wasLoopRunning = status.running;
    this.refreshSettings(entry);
    if (stopped && status.stopReason !== undefined) {
      const state = entry.session.getState();
      for (const listener of entry.finishedListeners) {
        listener(status.stopReason, state);
      }
    }
  }

  /** 設定行のキーはCodex画面と共通なので、Claude側のキーへ読み替える。 */
  private async applyConfig(entry: ClaudePanel, key: unknown, value: unknown): Promise<void> {
    if (typeof value !== 'string') {
      return;
    }
    const mapped: ClaudeEditableKey | undefined =
      key === 'model'
        ? 'model'
        : key === 'reasoningEffort'
          ? 'effort'
          : key === 'approvalMode'
            ? 'permissionMode'
            : key === 'agent'
              ? 'agent'
              : undefined;
    if (mapped === undefined) {
      this.log.warn(`変更を許可していないキーです: ${String(key)}`);
      return;
    }
    // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
    const applied = await this.settings.updateClaude(mapped, value);
    if (applied) {
      this.applyToSession(entry, mapped, value);
    }
    this.refreshSettings(entry);
  }

  /**
   * 変更を実行中のセッションへ流す。
   *
   * Codex画面はターンごとに設定を渡せるが、Claude Codeは1プロセス1セッションで
   * 起動引数が固定なので、control protocol で伝える。
   *
   * 「既定」（空文字）へ戻す操作は送らない。CLI側に元へ戻す手段が無く、
   * 何を送っても嘘になるため。次に開くセッションから効く。
   *
   * `agent` だけは値の有無によらず常にここで返す。エージェントは起動引数
   * （`--agent`）でのみ決まり、実行中のセッションへ切り替えを伝える制御要求が無い
   * （`set_agent` 等7種の候補を実測し、いずれも `Unsupported control request subtype`
   * で拒否されることを確認済み）。値を送っても効かないので、常に「次のセッションから」
   * と伝えるだけにする。
   */
  private applyToSession(entry: ClaudePanel, key: ClaudeEditableKey, value: string): void {
    if (key === 'agent') {
      this.log.info(
        value === ''
          ? 'agent を既定へ戻しました。セッション中は切り替えられないため、次のセッションから適用されます'
          : `agent を ${value} に変えました。セッション中は切り替えられないため、次のセッションから適用されます`,
      );
      return;
    }
    if (value === '') {
      this.log.info(
        `${key} を既定へ戻しました。今の会話には効かず、次のセッションから適用されます`,
      );
      return;
    }
    if (key === 'model') {
      entry.session.setModel(value);
      return;
    }
    if (key === 'effort') {
      entry.session.setEffort(value);
      return;
    }
    entry.session.setPermissionMode(value);
  }

  /**
   * 発言を送り、作業記録へ流す。手動でもループからでも通り道は同じにする。
   * 送信のたび毎回記録する。
   *
   * `logText` を渡した場合、作業記録にはそちらを残し、実際の送信は `text` を使う
   * （design.md §16.12。テンプレート展開前の文面を記録するため。`sendFromLoop` から使う）。
   */
  private dispatch(
    entry: ClaudePanel,
    text: string,
    withAttachments = false,
    logText: string = text,
  ): void {
    const attachments = withAttachments ? entry.attachments.take() : [];
    try {
      entry.session.sendOrQueue(text, attachments);
    } catch (e) {
      // 取り出したまま失わない。貼り直しを強いない
      entry.attachments.restore(attachments);
      throw e;
    }
    const sessionId = entry.session.threadId;
    if (sessionId !== undefined) {
      this.onActivity({ sessionId, cwd: entry.cwd, kind: 'prompt', text: logText });
    }
  }

  /**
   * ループからの送信。失敗はループを止める理由になるため、報告したうえで投げ直す。
   *
   * `promptTransform` が設定されていれば、実際にCLIへ送る本文だけそちらを通す。
   * 作業記録には変換前の `text`（テンプレート展開前）を残す（design.md §16.12）。
   */
  private sendFromLoop(entry: ClaudePanel, text: string): void {
    const toSend = entry.promptTransform?.(text) ?? text;
    try {
      this.dispatch(entry, toSend, false, text);
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
      if (type === 'send' && typeof m['text'] === 'string') {
        const text = m['text'];
        // 画像だけ送るのも許す。本文が無くても添付があれば送る意味がある
        if (text.trim() === '' && entry.attachments.list.length === 0) {
          return;
        }
        // 手動の発言はループへの割り込み。指示が交互に飛ぶ状態を作らない
        entry.loop.noteUserAction();
        this.dispatch(entry, text, true);
        this.refreshSettings(entry);
        return;
      }
      if (type === 'requestFiles') {
        // タブが閉じている（タスク管理下でパネルが無い）間は送り先が無い
        if (entry.panel !== undefined) {
          void postFileMentions(entry.panel, this.mentions, entry.cwd, m['query']);
        }
        return;
      }
      if (type === 'requestImage') {
        if (entry.panel !== undefined) {
          void postImageData(entry.panel, this.fs, entry.session.getState().items, m['path']);
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
      if (type === 'attach') {
        addAttachment(entry.attachments, m['name'], m['dataUrl']);
        this.refreshSettings(entry);
        return;
      }
      if (type === 'removeAttachment' && typeof m['id'] === 'string') {
        entry.attachments.remove(m['id']);
        this.refreshSettings(entry);
        return;
      }
      if (type === 'interrupt') {
        entry.loop.noteUserAction();
        entry.session.interrupt();
        return;
      }
      if (type === 'compact') {
        void this.compact(entry);
        return;
      }
      if (type === 'stopBackgroundTask' && typeof m['id'] === 'string') {
        void this.stopBackgroundTask(entry, m['id'], typeof m['command'] === 'string' ? m['command'] : m['id']);
        return;
      }
      if (type === 'rewind' && typeof m['messageId'] === 'string') {
        entry.loop.noteUserAction();
        void this.rewindFiles(entry, m['messageId']);
        return;
      }
      if (type === 'planMode') {
        entry.loop.noteUserAction();
        // 抜けるときは設定の承認方法へ戻す。タスク単位の設定があればそちらを優先する
        // （design.md §16.10の5。無ければ従来通りグローバル設定、空なら既定=manual）
        const fallback = (entry.taskConfig ?? readClaudeConfig().claude).permissionMode;
        entry.session.setPlanMode(m['on'] === true, fallback);
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
        void this.postCommands(entry);
        return;
      }
      if (type === 'config') {
        void this.applyConfig(entry, m['key'], m['value']);
        return;
      }
      if (type === 'approve' && isApprovalDecision(m['decision'])) {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          this.resolveApproval(entry, requestId, m['decision']);
        }
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 会話を圧縮する。内容を不可逆に変えるため、実行前に必ず確認する。
   */
  private async compact(entry: ClaudePanel): Promise<void> {
    if (!(await confirmCompact())) {
      return;
    }
    try {
      // 圧縮は新しいターンを起こす。ループの指示と重ならないよう割り込み扱いにする
      entry.loop.noteUserAction();
      entry.session.compact();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * バックグラウンドタスクを止める（issue #33、design.md §14.23）。
   *
   * 実行中の処理を打ち切る破壊的な操作のため、必ず確認してから送る。止まったことは
   * `background_tasks_changed` 通知（一覧から消える）で画面に反映されるため、ここでは
   * 要求を出すだけでよい。
   */
  private async stopBackgroundTask(entry: ClaudePanel, taskId: string, command: string): Promise<void> {
    if (!(await confirmStopBackgroundTask(command))) {
      return;
    }
    try {
      entry.session.stopBackgroundTask(taskId);
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * ファイルを指定した発言の直前まで戻す。**会話の履歴には触れない**
   * （design.md「Claude Codeの巻き戻し」・Issue #21）。
   *
   * 手順: 1) dry_runで対象ファイルを確かめる（押しても何も起きないボタンにしない）
   * 2) 対象が無ければ、その旨を伝えて確認ダイアログは出さない
   * 3) 対象ファイルを列挙し「会話は変わらない」ことを明記した確認ダイアログ
   * 4) 承認されたら適用し、結果を必ず画面に返す（成功も失敗も黙って終わらせない）
   */
  private async rewindFiles(entry: ClaudePanel, userMessageId: string): Promise<void> {
    let preview: Awaited<ReturnType<ClaudeStreamSession['previewRewindFiles']>>;
    try {
      preview = await entry.session.previewRewindFiles(userMessageId);
    } catch (e) {
      this.reportError(e);
      return;
    }
    if (!preview.ok) {
      void vscode.window.showErrorMessage(
        `この発言まで戻せません: ${preview.error}（CLIのバージョンや実行環境によって使えないことがあります）`,
      );
      return;
    }
    if (preview.filesChanged.length === 0) {
      void vscode.window.showInformationMessage('戻すファイルの変更はありませんでした。');
      return;
    }
    if (!(await confirmRewindFiles(preview.filesChanged))) {
      return;
    }

    let result: Awaited<ReturnType<ClaudeStreamSession['applyRewindFiles']>>;
    try {
      result = await entry.session.applyRewindFiles(userMessageId);
    } catch (e) {
      this.reportError(e);
      return;
    }
    if (!result.ok) {
      void vscode.window.showErrorMessage(`ファイルを戻せませんでした: ${result.error}`);
      return;
    }
    void vscode.window.showInformationMessage(
      `${preview.filesChanged.length}件のファイルを戻しました: ${preview.filesChanged.join(', ')}`,
    );
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
      this.teardown(entry);
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
