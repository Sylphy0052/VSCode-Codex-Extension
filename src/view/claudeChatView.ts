import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { isApprovalDecision, type ApprovalDecision } from '../appserver/approvals';
import { isOpenableSearchUrl, type ChatState, type ChatUsage } from '../appserver/chatState';
import { debugLogCandidates } from '../claude/cliLocator';
import type { ClaudeSessionStore } from '../claude/sessionStore';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../claude/streamSession';
import { transcriptItems } from '../claude/transcript';
import { isUnsafeClaudeCombination } from '../claude/argvBuilder';
import { currentWorkspaceFolder, readClaudeConfig, workspaceFolderPaths } from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { LoopPlan, LoopStatus, LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import type { FileSystemPort, MemoryFileSystemPort, SymlinkResolution } from '../session/ports';
import { nodeMemoryFileSystem } from '../session/nodeFileSystem';
import { ClaudeUsageProbe } from '../claude/usageProbe';
import { CommandCatalog } from '../provider/commandCatalog';
import type { SlashCommand } from '../provider/slashCommands';
import { AttachmentBox } from '../provider/attachments';
import { MESSAGING_MCP_SERVER_NAME } from '../orchestrator/messaging';
import type {
  ApprovalHandler,
  ApprovalOutcome,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../orchestrator/taskSession';
import {
  addAttachment,
  confirmClaudeImport,
  confirmCompact,
  confirmDebugCommand,
  confirmMemoryAppend,
  confirmRewindFiles,
  confirmRunShellCommand,
  confirmStopBackgroundTask,
  confirmUsageCreditsRequest,
  noteDropRejected,
  postFileMentions,
  postImageData,
  renderShell,
  reportTurnResult,
  runExportTranscript,
} from './chatView';
import type { FileMentionCatalog } from '../provider/fileMentions';
import {
  appendMemoryLine,
  buildProjectMemoryCandidates,
  describeMemoryAppendResult,
  MEMORY_LAST_SELECTED_PATH_KEY,
  orderMemoryCandidates,
  resolveUserMemoryFile,
  routeInputMode,
  symlinkResolutionEquals,
  type InputModeCall,
  type MemoryCandidate,
  type MemoryModeMemento,
} from '../provider/inputModes';
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
 * Claude Codeチャットパネルの生成オプション（design.md §14.48、issue #287）。
 * `enableFindWidget: true` でCtrl+Fの検索窓を有効にする。オブジェクトの組み立てを
 * 関数として切り出すことで、`createWebviewPanel`（vscode本体のAPI）を実際に呼ばずとも
 * 内容をテストできるようにしている。
 */
export function buildClaudeChatPanelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true };
}

/** 行頭 `!` のシェルコマンド（issue #5）を入力するターミナルの名前。既存があれば使い回す。 */
const SHELL_COMMAND_TERMINAL_NAME = 'Agent Sessions: シェルコマンド入力';

/**
 * 行頭 `!` のシェルコマンド（issue #5）を統合ターミナルへ入力する。
 *
 * `controlPanelView.ts` の `openLoginTerminal` と同じ流儀で、**入力するだけで自動実行はしない**
 * （`sendText` の第2引数を `false` にする）。ユーザーが自分でEnterを押して初めて実行される。
 */
function openShellCommandTerminal(cwd: string, command: string): void {
  const existing = vscode.window.terminals.find((t) => t.name === SHELL_COMMAND_TERMINAL_NAME);
  const terminal =
    existing ?? vscode.window.createTerminal({ name: SHELL_COMMAND_TERMINAL_NAME, cwd });
  terminal.show();
  terminal.sendText(command, false);
}

/**
 * `TaskSessionInput` をClaude Codeの起動設定へ写す。`sandbox` はClaudeに概念が無いため使わない。
 * `agent` はタスクオーケストレーション（design.md §16）が扱う語彙に無いため常に空文字にする
 * （タスクは既定のエージェントで走る）。
 *
 * `input.mcp` が渡されていれば、タスク間メッセージング（design.md §16.21）専用のMCP
 * サーバを `--mcp-config` で渡す（実測。CLI 2.1.227で`{"mcpServers":{"<name>":{"type":
 * "http","url":...}}}`形式のJSON文字列を受け付け、`mcp_status`で`scope: "dynamic"`
 * として現れることを確認済み）。ここで組み立てる`additionalArgs`は拡張機能が完全に
 * 制御する値であり、`codex.additionalArgs`/`claude.additionalArgs`のような
 * ユーザー設定・YAMLの経路とは無関係（§16.16の信頼境界を壊さない。`TaskSessionConfig`
 * 自体に`additionalArgs`が無いことがそれを裏付ける）。
 */
function toClaudeConfig(input: TaskSessionInput): ClaudeConfig {
  return {
    model: input.config.model,
    effort: input.config.effort,
    permissionMode: input.config.approvalMode,
    agent: '',
    additionalArgs:
      input.mcp !== undefined
        ? [
            '--mcp-config',
            JSON.stringify({
              mcpServers: { [MESSAGING_MCP_SERVER_NAME]: { type: 'http', url: input.mcp.url } },
            }),
          ]
        : [],
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
  /**
   * フォーカスが当たっているタブ（`chatView.ts` の `this.active` と同じ役割。issue #199）。
   * エディタ右上の「セッション名を変更」はこれを対象にする。
   */
  private active: ClaudePanel | undefined;

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
    /**
     * メモリ追記（issue #6/#144）専用の読み取り口。ENOENT以外の例外は投げる・
     * シンボリックリンクの実体パスを解決する、の2つを共有の `FileSystemPort` から
     * 切り出したもの（`src/session/ports.ts` を参照）。既定はNode実装。
     */
    private readonly memoryFs: MemoryFileSystemPort = nodeMemoryFileSystem,
    /**
     * 直前に選んだメモリ追記先を覚えておく口（issue #144）。`vscode.Memento` と構造的に
     * 一致するため `context.workspaceState` をそのまま渡せる（`extension.ts` 参照）。
     * 既定は何も覚えない no-op（テスト等でワークスペースを想定しない呼び出しでも壊れない）。
     */
    private readonly memoryMemento: MemoryModeMemento = {
      get: (_key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    },
    /**
     * `claude` プロセスの起こし方（統合テストの差し替え口。Issue #186）。セッションを
     * 作るたびに読み直すので、`activate()` が終わった後からでも差し替えられる。
     * `undefined` を返す間は `ClaudeStreamSession` の既定（実際に起動する）が使われる。
     */
    private readonly resolveSpawn: () => ClaudeSpawnPort | undefined = () => undefined,
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

  /**
   * 統合テスト専用: webview（レンダラー側のJS）から届いたふりをしたメッセージを流し込む
   * （Issue #188、`ChatViewManager.simulateWebviewMessage`（`chatView.ts`）と同じ考え方）。
   *
   * 実VSCode上の統合テストでは、拡張機能ホスト側のコードから実際のwebview（別プロセスの
   * レンダラーで動くiframe）へJSを注入してボタンのクリックやEnterキーを再現する手段が無い。
   * `attachPanel` が `panel.webview.onDidReceiveMessage` に登録しているのと同じ
   * `handleMessage` を直接呼ぶ入口をここへ用意する。本番のwebviewが送るメッセージは
   * 形が同じであれば区別なく処理されるため、実際に通る経路（承認の決定・発言の送信・
   * 設定変更・巻き戻し・行頭 `!`/`#` の処理など）はここを通しても変わらない。呼び出し口は
   * `ChatTestApi.simulateClaudeWebviewMessage`（`extension.ts`）で、
   * `AGENT_SESSIONS_INTEGRATION_TEST=1` のときだけ公開される。
   *
   * `handleMessage` 自体は同期関数だが、内部で確認ダイアログなどの非同期処理を
   * fire-and-forget（`void this.compact(entry)` 等）で呼んでいる分岐がある。それらの
   * 完了を待つ必要があるテストは、呼び出し側で `waitFor`（`helpers/waitFor.ts`）を使うこと
   * （`chatCodexApprovals.test.ts` 等、既存のwebview経由テストと同じ流儀）。
   */
  async simulateWebviewMessage(sessionId: string, message: unknown): Promise<void> {
    const entry = this.panels.get(sessionId);
    if (entry === undefined) {
      throw new Error(`webviewへメッセージを送れませんでした（画面が見つからない）: ${sessionId}`);
    }
    this.handleMessage(entry, message);
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
    return this.buildTaskSession(entry, sessionId, input.mcp !== undefined);
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
      // 人が付けた名前があれば開いた時点からタブ名に反映する（issue #199）
      initialName: this.store.getName(sessionId),
    });
  }

  /**
   * セッション全体を分岐して開く（issue #218、design.md §14.40）。
   *
   * `-r <id> --fork-session` はCLIが分岐先の新しいセッションidを自分で振る。Codexのように
   * idを起動前にこちらで決めて渡す手段が無い（`argvBuilder.ts`の`targetArgs`参照）ため、
   * `ClaudeStreamSession.start()`へは`sessionId: undefined`を渡す。これにより
   * `state.threadId`はこのタブが生きている間ずっと確定しないままになる
   * （`streamSession.ts`の`start()`が`options.target.kind === 'resume'`のときだけ
   * `target.sessionId`を採用し、それ以外は`options.sessionId`＝`undefined`をそのまま
   * 使うため）。`threadId`が`undefined`のままだと、`dispatch()`の作業記録
   * （`onActivity`呼び出し）は`sessionId !== undefined`のガードで送らず、
   * `chatScript.ts`の`apply()`も`state.threadId`が真値でなければ`vscode.setState`を
   * 呼ばない。つまり復元（`restorePanel`）にも作業記録（design.md §16.12）にも乗らない、
   * という仕様どおりの挙動が、特別な分岐を足さなくても自然に成り立つ。
   *
   * `this.panels`のキーだけは実セッションidと衝突しないよう`fork:`を接頭辞にした合成キー
   * にする（実CLIのセッションidは常にUUID形式でこの接頭辞を含まない）。このキーは
   * ローカルの管理にしか使わず、CLIへは渡らない。
   *
   * 黙って「復元されないタブ」を作らないため（issue #218の受入基準）、開いた直後に
   * その旨を会話へ1行残す。事前の確認ダイアログにはしなかった。分岐そのものは元の
   * セッションを傷つけない可逆な操作で、`openDebugLog`（issue #205、design.md §14.39）
   * と同じく「壊れる・戻せない操作ではない」ため、都度の確認より会話に残る記録のほうが
   * 低摩擦かつ後から見返せると判断した。
   */
  async openFork(sessionId: string, title: string, cwd: string | undefined): Promise<void> {
    const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
    if (folder === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      return;
    }

    const entry = this.buildEntry(folder, `${LABEL}: ${title}`, false, undefined);
    this.showPanel(entry, false);
    this.panels.set(`fork:${randomUUID()}`, entry);
    entry.session.start({
      cwd: folder,
      target: { kind: 'fork', sessionId },
      sessionId: undefined,
      config: readClaudeConfig().claude,
    });
    entry.session.noteLocalEvent(
      `forkNotice:${randomUUID()}`,
      'このタブは元のセッションを分岐したものです。新しいセッションidはCLIが振るため拡張機能からは追跡できず、このタブはウィンドウ再読み込み後の復元と作業記録（日報・週報）の対象外になります。',
    );
  }

  /**
   * skillsを読み直す（issue #202、design.md TP-90）。設定パネルの「読み直す」ボタンから
   * `claude.reloadSkills` コマンド経由で呼ばれる（`newSession`と同じ、設定パネルの
   * webview→VS Codeコマンド→この画面の管理クラス、という橋渡し。設定パネルは
   * 単発プロセスの`ClaudeSkillsProbe`しか持たず、既に開いている会話のプロセスへは
   * 直接触れないため）。
   *
   * 開いている会話それぞれの生きているプロセスへ`reload_skills`を送り、結果を会話に
   * 1行残す。`entry.session.reloadSkills()`はプロセスが無ければ`undefined`を返すため、
   * タブを閉じている（プロセスが無い）会話には何も残さない（`undefined`を「対象外」と
   * 見なす。`checkMcpStatus`と対称の判断）。
   */
  async reloadSkillsForOpenSessions(): Promise<void> {
    for (const entry of this.panels.values()) {
      const result = await entry.session.reloadSkills();
      if (result === undefined) {
        continue;
      }
      entry.session.noteLocalEvent(
        `reloadSkills:${randomUUID()}`,
        result.ok
          ? `設定 ・ skillsを読み直しました（${result.skills.length}件）`
          : `設定 ・ skillsを読み直せませんでした: ${result.reason}`,
      );
    }
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
      // 人が付けた名前があれば開いた時点からタブ名に反映する（issue #199）
      initialName: this.store.getName(sessionId),
    });
  }

  /**
   * 名前を変更する（issue #199、design.md §14.35）。Codex画面の `renameActive`
   * （`chatView.ts`）と同じ「アクティブなタブが対象」というUXに揃える。
   *
   * 表示用の名前は拡張機能側（`ClaudeSessionStore`）を正として持つ設計のため
   * （`control.ts` の `buildRenameSessionRequest` のJSDoc参照）、保存が先、CLIへの
   * 送信は`ClaudeStreamSession.setName`内でのベストエフォートな副送信という順序にする。
   * 保存に失敗した場合は画面へも反映しない（保存できていないのに変わったように見せない）。
   */
  async renameActive(): Promise<void> {
    const entry = this.active;
    const sessionId = entry?.session.threadId;
    if (entry === undefined || sessionId === undefined) {
      void vscode.window.showInformationMessage('名前を変更するClaude Code画面を開いてください');
      return;
    }

    const current = entry.session.getState().name ?? this.store.getName(sessionId) ?? '';
    const name = await vscode.window.showInputBox({
      prompt: 'このセッションの名前',
      value: current,
      validateInput: (v) => (v.trim() === '' ? '名前を入力してください' : undefined),
    });
    if (name === undefined || name.trim() === '' || name === current) {
      return;
    }

    try {
      await this.store.rename(sessionId, name.trim());
      entry.session.setName(name.trim());
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * いまの会話を捨てて、同じ作業フォルダで新しい会話を始める（CLIの `/clear` 相当）。
   * Codex画面の `clearActive`（`chatView.ts`）と同じUX・同じ手順に揃える。
   *
   * 会話はtranscriptに残り履歴から開き直せるため、確認は進行中のターンがあるときだけ出す。
   * タブは作り直す（`teardown` がタブごと閉じ、`openNew` が同じ列へ開く）。既存のタブを
   * 使い回すと、webviewへ配線済みのハンドラが古いセッションを掴んだまま残るため。
   */
  async clearActive(): Promise<void> {
    const entry = this.active;
    if (entry === undefined) {
      void vscode.window.showInformationMessage('クリアするClaude Code画面を開いてください');
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
      // 統合テスト（Issue #186）が差し替えている間だけフェイクのプロセスになる。
      this.resolveSpawn(),
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
      if (!preserveFocus) {
        this.active = entry;
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      entry.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      buildClaudeChatPanelOptions(),
    );
    this.attachPanel(entry, panel);
  }

  /**
   * `panel.webview.options`（`enableScripts`等）はここで入れ直すが、`enableFindWidget`
   * （design.md §14.48、issue #287）は`WebviewPanel.options`側の値で読み取り専用のため、
   * ここから再設定する手段が無い。`restorePanel`経由（タブ復元）で渡ってくるパネルは
   * VSCode本体が新規に構築したもので、`enableFindWidget`を含む`WebviewPanelOptions`は
   * 生成時にしか指定できない。
   */
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
      // 行頭の !/# の案内（issue #5/#6、design.md §14.29）。CodexのTUIに無い挙動
      showInputModeHints: true,
      // 他エージェントからの設定インポート（issue #200）。Codexは別のコントロールパネル
      // UI（issue #36）を持つため、二重導線を避けてClaude Code画面にだけ出す
      showImport: true,
      // 会話の1行要約（issue #203）。`/recap` はTUI由来のローカルコマンドで、Codexに
      // この概念は無いため、二重導線を避けてClaude Code画面にだけ出す
      showRecap: true,
      // 自動圧縮の窓サイズ（issue #201）。`/autocompact` もTUI由来のローカルコマンドで、
      // Codexに対応する設定は無いため、二重導線を避けてClaude Code画面にだけ出す
      showAutocompact: true,
      // CLI側のデバッグログを開く／`/debug`で診断する導線（issue #205）。どちらも
      // Codexに対応する概念が無いため、二重導線を避けてClaude Code画面にだけ出す
      showDebug: true,
    });
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(entry, message));
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = entry;
      }
    });
    panel.onDidDispose(() => {
      entry.panel = undefined;
      if (!entry.taskManaged) {
        // 人が手で開いた画面は、これまで通りタブを閉じたらセッションも終わる
        this.teardown(entry);
        return;
      }
      if (this.active === entry) {
        this.active = undefined;
      }
    });
    // 新規作成時にフォーカスが当たっていれば、ここでも捕まえる（chatView.tsのattachPanelと同じ理由。
    // タスク管理下のパネルは常にpreserveFocus: trueで背面に開くため、無条件にactiveを奪わない）
    if (panel.active) {
      this.active = entry;
    }
  }

  /**
   * `TaskSessionHost` が返す口の実体。
   *
   * `mcpRequested` は `openTaskSession` の `input.mcp !== undefined` をそのまま渡す。
   * `false` なら `checkMessagingToolVisible` は確認そのものを行わず常に `true` を返す
   * （`TaskSession.checkMessagingToolVisible` のJSDoc参照）。
   */
  private buildTaskSession(
    entry: ClaudePanel,
    sessionId: string,
    mcpRequested = false,
  ): TaskSession {
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
      pauseLoop: () => entry.loop.pause(),
      resumeLoop: () => entry.loop.resume(),
      checkMessagingToolVisible: async () => {
        if (!mcpRequested) {
          return true;
        }
        // design.md §16.21「ツールの可視性の確認」。`mcp_status`の一覧に、拡張機能が
        // 渡した名前のサーバが`connected`として現れているかを見る（`streamSession.ts`の
        // `checkMcpStatus`のJSDoc参照）
        const servers = await entry.session.checkMcpStatus();
        const server = servers?.find((s) => s.name === MESSAGING_MCP_SERVER_NAME);
        return server?.state === 'connected';
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
    if (this.active === entry) {
      this.active = undefined;
    }
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
        // 行頭が !/# の入力はCLIへ送らず、拡張機能側の機能として扱う（issue #5/#6、
        // design.md §14.29）。control_requestに相当する経路が無いため、Claudeへ発言として
        // 渡すとモデルのターンを消費して意図とずれる（design.mdの調査結果を参照）
        const inputMode = routeInputMode(text);
        if (inputMode !== undefined) {
          void this.runInputMode(entry, inputMode);
          return;
        }
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
      if (type === 'dropRejected') {
        noteDropRejected(m['kind']);
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
      if (type === 'claudeImport') {
        void this.importConfig(entry);
        return;
      }
      if (type === 'usageCreditsRequest') {
        void this.requestUsageCredits(entry);
        return;
      }
      if (type === 'recap') {
        this.recap(entry);
        return;
      }
      if (type === 'autocompactWindow') {
        this.setAutocompactWindow(entry, typeof m['window'] === 'string' ? m['window'] : '');
        return;
      }
      if (type === 'openDebugLog') {
        void this.openDebugLog(entry);
        return;
      }
      if (type === 'debugCommand') {
        void this.sendDebugCommand(entry);
        return;
      }
      if (type === 'stopBackgroundTask' && typeof m['id'] === 'string') {
        void this.stopBackgroundTask(
          entry,
          m['id'],
          typeof m['command'] === 'string' ? m['command'] : m['id'],
        );
        return;
      }
      if (type === 'exportTranscript') {
        // 発言や中断とは独立した操作。ループへの割り込み扱いにはしない
        void runExportTranscript(entry.session.getState().items, LABEL);
        return;
      }
      if (type === 'workflowMenu') {
        // この会話とは関係のない全体の操作（issue #250）。`chatView.ts`と同じ扱いで、
        // 応答中でも押せる。QuickPickの組み立ては`extension.ts`側に一本化してある。
        // 生成（分解・ロードマップ）をこの画面と同じエージェントで走らせるため、
        // プロバイダを添えて渡す（issue #266。省略するとその場で選ばされる）
        void vscode.commands.executeCommand('agent.workflows.menu', 'claude');
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
      if (type === 'fastMode') {
        entry.loop.noteUserAction();
        entry.session.setFastMode(m['on'] === true);
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
   * 他エージェント（Codex／Gemini）の設定インポートのプレビューを要求する
   * （issue #200、design.md TP-88）。
   *
   * ここで書き込みは起きない（`streamSession.ts` の `importConfig` 参照）。それでも
   * 「何を・どこから・どこへ」を確認してから送るのは、実際に取り込むまでの二段階目
   * （CLIが提示するダイジェスト付き確認コマンド）へ迷わず進めるようにするため。
   */
  private async importConfig(entry: ClaudePanel): Promise<void> {
    if (!(await confirmClaudeImport())) {
      return;
    }
    try {
      // compactと同じく新しいターンを起こす。ループの指示と重ならないよう割り込み扱いにする
      entry.loop.noteUserAction();
      entry.session.importConfig();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 追加クレジット（usage credits）の設定・管理者への要求を送る
   * （issue #204、design.md §14.38）。
   *
   * `importConfig`と同じく外部（組織の管理者）へ影響しうる操作のため、必ず確認してから
   * 送る（`streamSession.ts` の `requestUsageCredits` 参照。実測ではこの拡張機能からの
   * 送信は管理ページへのURLを返すだけの見込みだが、安全側に倒して確認は省かない）。
   */
  private async requestUsageCredits(entry: ClaudePanel): Promise<void> {
    if (!(await confirmUsageCreditsRequest())) {
      return;
    }
    try {
      // compact/importConfigと同じく新しいターンを起こす。ループの指示と重ならないよう
      // 割り込み扱いにする
      entry.loop.noteUserAction();
      entry.session.requestUsageCredits();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 会話の1行要約をその場で作る（issue #203、design.md §14.36）。
   *
   * `compact` / `importConfig` と違い、会話の中身を要約へ置き換えたり書き込みが起きたり
   * することはない（`streamSession.ts` の `recap` のJSDoc参照。実測では新しい発言が
   * 1件増えるだけ）。壊れる／戻せない操作ではないため、確認ダイアログは挟まない
   * （`planToggle` / `fastToggle` と同じ扱い）。
   */
  private recap(entry: ClaudePanel): void {
    try {
      entry.loop.noteUserAction();
      entry.session.recap();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 自動圧縮の窓サイズを確認・変更する（issue #201、design.md §14.37）。
   *
   * 空文字なら現在値の問い合わせ、それ以外なら変更として扱う（`streamSession.ts` の
   * `setAutocompactWindow` 参照）。`recap`と同じく、壊れる・戻せない操作ではないため
   * 確認ダイアログは挟まない。
   */
  private setAutocompactWindow(entry: ClaudePanel, window: string): void {
    try {
      entry.loop.noteUserAction();
      entry.session.setAutocompactWindow(window);
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * CLI側のデバッグログをエディタで開く（issue #205、design.md §14.39）。
   *
   * 本体の実測どおり、ログは`/debug`を送らなくても常時`~/.claude/debug/`配下に
   * 出ているため、**CLIへは何も送らず**ファイルを直接開くだけで済む（課金もツール
   * 実行も伴わない。壊れる・戻せない操作ではないため確認ダイアログも挟まない）。
   *
   * `debugLogCandidates`が返す候補（このセッション専用のログ→`latest`の順）を先頭から
   * 順に開けるか試す。`vscode.workspace.openTextDocument`はファイルが無いと reject
   * するため、候補ごとにtry/catchで次点へ進む。全滅した場合はログがまだ無い旨を案内する
   * （エラー扱いにはしない。CLIの初回起動直後などで実際に起こりうる）。
   *
   * 開けたら「どこを開いたか」を会話に1行残す（issue本文の受入基準「操作すると…会話に
   * 記録が残る」を、実際の中身に合わせて「ログを開いたこと」の記録として満たす。design.md
   * §14.39の設計判断を参照）。
   */
  private async openDebugLog(entry: ClaudePanel): Promise<void> {
    const candidates = debugLogCandidates(this.claudeHome, entry.session.threadId);
    for (const path of candidates) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        await vscode.window.showTextDocument(doc, { preview: false });
        entry.session.noteLocalEvent(
          `openDebugLog:${randomUUID()}`,
          `デバッグログを開きました（CLIへは何も送っていません）: ${path}`,
        );
        return;
      } catch {
        // 次の候補へ（ファイルが無い等）。最後まで開けなければループの外で案内する
      }
    }
    void vscode.window.showInformationMessage(
      'デバッグログがまだ見つかりません。セッションを開始した直後は書き込みが' +
        '間に合っていない可能性があります。少し待ってからもう一度お試しください。',
    );
  }

  /**
   * `/debug`を送り、実モデルにデバッグログを読ませて診断させる（issue #205、
   * design.md §14.39）。
   *
   * `requestUsageCredits`と同じく、実モデルが動き課金・ツール実行（承認カード）を
   * 伴いうる操作のため、必ず確認してから送る（`streamSession.ts`の`sendDebugCommand`
   * 参照）。
   */
  private async sendDebugCommand(entry: ClaudePanel): Promise<void> {
    if (!(await confirmDebugCommand())) {
      return;
    }
    try {
      // compact/importConfig/requestUsageCreditsと同じく新しいターンを起こす。
      // ループの指示と重ならないよう割り込み扱いにする
      entry.loop.noteUserAction();
      entry.session.sendDebugCommand();
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
  private async stopBackgroundTask(
    entry: ClaudePanel,
    taskId: string,
    command: string,
  ): Promise<void> {
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
   * 行頭が !/# の入力を、拡張機能側の機能として実行する（issue #5/#6、design.md §14.29）。
   * `routeInputMode` が「送るべきでない」と判定した時点で呼ばれるため、ここではCLIへは
   * 一切送らない。
   */
  private async runInputMode(entry: ClaudePanel, mode: InputModeCall): Promise<void> {
    if (mode.kind === 'shell') {
      await this.runShellInputMode(entry, mode.command);
      return;
    }
    await this.runMemoryInputMode(entry, mode.content);
  }

  /**
   * シェルコマンドを統合ターミナルへ入力する（issue #5）。
   *
   * **自動実行はしない**。CLIの承認設定（`claude.permissionMode`）はモデルがツールを
   * 呼ぶときの仕組みで、ここで打つコマンドはユーザーが自分で書いた文字列そのものであり、
   * その仕組みを経由しない。拡張機能が代わりに自動実行すると、CLIの承認・サンドボックスの
   * 外側で任意コマンドを実行する経路になってしまうため、`openLoginTerminal`
   * （`controlPanelView.ts`）と同じ流儀で「入力するだけ」に留める。実行するかどうかは
   * 開いたターミナルでユーザーが自分でEnterを押して決める。
   */
  private async runShellInputMode(entry: ClaudePanel, command: string): Promise<void> {
    if (!(await confirmRunShellCommand(command))) {
      return;
    }
    openShellCommandTerminal(entry.cwd, command);
    entry.session.noteLocalEvent(
      `shellCommand:${randomUUID()}`,
      `シェルコマンドを統合ターミナルへ入力しました（自動実行はしていません）: ${command}`,
    );
  }

  /**
   * 内容をメモリ（CLAUDE.md）へ追記する（issue #6、issue #144で安全性を強化）。
   *
   * 追記先を選ばせ（各workspaceFolder + ユーザー、`resolveMemoryCandidates`）、内容・追記先
   * （シンボリックリンクなら実体パスも、実体パスが特定できなければ警告も）を確認してから
   * 書き込む。読み取りに`readStrict`（メモリ追記専用、ENOENT以外は投げる）を使うのは、
   * 既存ファイルの読み込みに失敗したときに「無い」と誤認して追記のつもりで上書きするのを
   * 防ぐため（issue #144の核心）。書き込み直前にシンボリックリンクの判定を取り直し、
   * 確認ダイアログを見せた時点の結果と食い違っていれば書き込みを中止する（TOCTOU対策。
   * 確認からユーザー応答までは不定長で、その間にリンク先が変わりうる）。
   * 書き込み後は「どこに書いたか」を会話に1行残す（受入基準）。
   */
  private async runMemoryInputMode(entry: ClaudePanel, content: string): Promise<void> {
    const candidates = await this.resolveMemoryCandidates(entry.cwd);
    const choice = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: c.label,
        description: c.exists ? '既存' : '新規作成',
        detail: c.path,
        candidate: c,
      })),
      { title: `メモリへ追記: ${content}`, placeHolder: '追記先を選んでください' },
    );
    if (choice === undefined) {
      return;
    }
    // 書き込み先はQuickPickが列挙した候補のパスに限る（パストラバーサルの入口を作らない。issue #144）
    const targetPath = choice.candidate.path;
    const confirmedSymlink = await this.resolveSymlinkTargetSafely(targetPath);

    if (!(await confirmMemoryAppend(content, targetPath, confirmedSymlink))) {
      return;
    }

    // TOCTOU対策: モーダル確認（ユーザー応答待ちで不定長）の間にリンク先が変わりうるため、
    // 書き込み直前に取り直し、確認時に見せた結果と食い違えば中止する（issue #144）。
    const symlinkAtWrite = await this.resolveSymlinkTargetSafely(targetPath);
    if (!symlinkResolutionEquals(confirmedSymlink, symlinkAtWrite)) {
      this.reportError(
        new Error(
          `追記先の状態が確認時から変わったため、書き込みを中止しました: ${targetPath}。もう一度操作しなおしてください。`,
        ),
      );
      return;
    }

    let existing: string | undefined;
    try {
      existing = await this.memoryFs.readStrict(targetPath);
    } catch (e) {
      // ENOENT以外の理由で読めなかった。「無い」と誤認して既存の内容を消さないよう、
      // ここで打ち切って書き込まない（issue #144の受入基準）
      this.reportError(e);
      return;
    }
    const next = appendMemoryLine(existing, content);
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(next, 'utf8'));
    } catch (e) {
      this.reportError(e);
      return;
    }
    // 追記自体は既に成功しているため、記憶の失敗で処理全体は止めない。ただし黙って握り潰さず
    // 報告する（`src/orchestrator/runStore.ts` は同型の`update`を常に`await`しており、
    // fire-and-forgetのまま放置しない流儀に揃える。issue #144レビュー指摘）。
    try {
      await this.memoryMemento.update(MEMORY_LAST_SELECTED_PATH_KEY, targetPath);
    } catch (e) {
      this.reportError(e);
    }
    entry.session.noteLocalEvent(
      `memoryAppend:${randomUUID()}`,
      describeMemoryAppendResult(targetPath, symlinkAtWrite),
    );
  }

  /**
   * `this.memoryFs.resolveSymlinkTarget` を安全に呼ぶ。
   *
   * `MemoryFileSystemPort.resolveSymlinkTarget` はJSDoc上「例外を投げない」契約で、既定実装
   * （`nodeMemoryFileSystem`）もそのとおりだが、`memoryFs` はテストで差し替え可能な口のため、
   * 契約違反があっても追記処理全体を落とさず、実体パスが分からない扱いへ倒す
   * （防御的プログラミング。issue #144レビュー指摘）。
   */
  private async resolveSymlinkTargetSafely(filePath: string): Promise<SymlinkResolution> {
    try {
      return await this.memoryFs.resolveSymlinkTarget(filePath);
    } catch (e) {
      this.reportError(e);
      return { kind: 'unresolved' };
    }
  }

  /**
   * メモリ追記先の候補を列挙する（issue #144）。
   *
   * プロジェクト側は各workspaceFolderごとに1件出す（マルチルートワークスペースで
   * どのフォルダのCLAUDE.mdか分からない問題への対処、受入基準）。加えて、この画面の
   * 実際の作業ディレクトリ（`fallbackCwd`。タスクのworktree等でworkspaceFolderと
   * 一致しないことがある）がworkspaceFolderに含まれていなければ、それも候補へ足す
   * （従来どおりworktree自身のCLAUDE.mdへ追記できるようにするため）。
   * 存在確認は共有の `FileSystemPort.readTextFile`（読めなければ無い扱いでよい。
   * ここではラベル表示にしか使わず、書き込み判断には使わない）で行う。
   */
  private async resolveMemoryCandidates(fallbackCwd: string): Promise<MemoryCandidate[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((f) => ({ name: f.name, cwd: f.uri.fsPath }));
    if (!roots.some((r) => r.cwd === fallbackCwd)) {
      roots.push({ name: basename(fallbackCwd), cwd: fallbackCwd });
    }

    const projectInputs = await Promise.all(
      roots.map(async (r) => {
        const rootExists = (await this.fs.readTextFile(`${r.cwd}/CLAUDE.md`)) !== undefined;
        const dotClaudeExists =
          (await this.fs.readTextFile(`${r.cwd}/.claude/CLAUDE.md`)) !== undefined;
        return {
          name: r.name,
          cwd: r.cwd,
          rootClaudeMdExists: rootExists,
          dotClaudeMdExists: dotClaudeExists,
        };
      }),
    );
    const projectCandidates = buildProjectMemoryCandidates(projectInputs);

    const userPath = resolveUserMemoryFile(this.claudeHome);
    const userCandidate: MemoryCandidate = {
      label: 'ユーザー',
      path: userPath,
      exists: (await this.fs.readTextFile(userPath)) !== undefined,
    };

    const lastSelected = this.memoryMemento.get<string | undefined>(
      MEMORY_LAST_SELECTED_PATH_KEY,
      undefined,
    );
    return orderMemoryCandidates([...projectCandidates, userCandidate], lastSelected);
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

/**
 * タブ名。解決順は「人が付けた名前（`state.name`） > 最初の指示から作った名前」
 * （issue #199の受入基準）。Claude Codeは要約名をCLI側に持たないため、後者は
 * 最初のユーザー発言から作る。
 */
export function deriveTitle(state: ChatState): string | undefined {
  if (state.name !== undefined && state.name.trim() !== '') {
    return `${LABEL}: ${state.name}`;
  }
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
