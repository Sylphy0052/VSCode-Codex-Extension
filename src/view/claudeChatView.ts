import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { isApprovalDecision } from '../appserver/approvals';
import {
  isOpenableSearchUrl,
  type ChatItem,
  type ChatState,
  type ChatUsage,
} from '../appserver/chatState';
import { isAskUserQuestionSelections } from '../claude/askUserQuestion';
import { debugLogCandidates } from '../claude/cliLocator';
import { describeForkFromTurnError } from '../claude/forkFromTurn';
import {
  capSideQuestionHistory,
  finishedSideQuestionDisplay,
  pendingSideQuestionDisplay,
  progressSideQuestionDisplay,
} from '../claude/sideQuestion';
import type { SideQuestionHistoryEntry } from '../claude/control';
import type { ClaudeSessionStore } from '../claude/sessionStore';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../claude/streamSession';
import { transcriptItems } from '../claude/transcript';
import { isUnsafeClaudeCombination } from '../claude/argvBuilder';
import {
  currentWorkspaceFolder,
  readChatComposerButtonsConfig,
  readChatRenderMarkdownConfig,
  readChatDensityConfig,
  readChatSendOnConfig,
  readChatTurnSummaryConfig,
  readClaudeConfig,
  readWorkflowsConfig,
  workspaceFolderPaths,
} from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { LoopPlan, LoopStatus, LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import type { FileSystemPort, MemoryFileSystemPort, SymlinkResolution } from '../session/ports';
import { nodeMemoryFileSystem } from '../session/nodeFileSystem';
import { ClaudeUsageProbe } from '../claude/usageProbe';
import { CommandCatalog } from '../provider/commandCatalog';
import {
  CLAUDE_PSEUDO_COMMANDS,
  routePseudoCommand,
  trimmedArgsOrUndefined,
  withPseudoCommands,
  type PseudoCommandCall,
} from '../provider/pseudoCommands';
import type { SlashCommand } from '../provider/slashCommands';
import { AttachmentBox } from '../provider/attachments';
import { MESSAGING_MCP_SERVER_NAME } from '../orchestrator/messaging';
import type {
  ApprovalHandler,
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
  handleOpenDiffEditor,
  handleOpenDiffFile,
  handleRevertDiff,
  insertCodeIntoEditor,
  noteDropRejected,
  openChatFileLink,
  openCodeInNewFile,
  postFileMentions,
  postImageData,
  renderShell,
  reportTurnResult,
  runExportTranscript,
  STATE_POST_INTERVAL_MS,
} from './chatShared';
import type { FileMentionCatalog } from '../provider/fileMentions';
import { decoratePanelTitle, deriveSessionActivityState } from './sessionActivity';
import { buildSessionPanelTitle } from './sessionTitle';
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
import { buildItemsDelta, stripHostOnlyItems } from './stateDelta';
import { BaseChatViewManager, type BaseChatPanel } from './chatManagerBase';
import { buildHandoffPrompt, resolveWithRetry } from './handoff';
import { appendTurnSummaryInstruction } from './turnSummary';
import { CLAUDE_PERMISSION_MODES } from '../claude/types';
import {
  APPROVAL_LEVEL_CYCLE,
  claudePermissionModeForLevel,
  isApprovalLevel,
} from '../provider/approvalLevel';
import type { ClaudeConfig } from '../claude/types';
import type {
  ClaudeEditableKey,
  ClaudeSettingsSnapshot,
  SettingsProvider,
} from './settingsProvider';
import type { ChatActivity } from './chatShared';

interface ClaudePanel extends BaseChatPanel {
  // `panel` / `loop` / `disposed` / `title` / `taskManaged` / `postTimer` /
  // `approvalResolvedListeners` / `notifiedApprovalRequestIds` は`BaseChatPanel`
  // （chatManagerBase.ts）が定義済み（issue #420、#410のフォローアップ）。ここでは
  // 基底の`ChatSessionLike`より狭い`ClaudeStreamSession`へ絞るため`session`だけ再宣言する
  session: ClaudeStreamSession;
  cwd: string;
  /** 送信前の添付画像。送るまでここに溜める。 */
  attachments: AttachmentBox;
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
  /** 直近に`flushState`が送信した時刻（`STATE_POST_INTERVAL_MS`の間引き判定に使う）。 */
  lastPostAt?: number | undefined;
  /** 直近に送った会話項目。`buildItemsDelta`が次回との差分を取るための基準。 */
  sentItems?: readonly ChatItem[] | undefined;
  /**
   * このタブで送った脇道の質問の履歴（issue #334、design.md §14.62）。
   *
   * `side_question` の `history` にそのまま渡す。本流の会話（`entry.session`の
   * transcript）とは別物で、このタブを閉じれば消える（拡張機能側にも永続化しない）。
   */
  sideQuestionHistory: SideQuestionHistoryEntry[];
}

/**
 * 画面下の設定行へ送る形（`ClaudeChatViewManager.buildSettingsPayload()`の戻り値、
 * issue #420レビュー指摘）。
 *
 * 以前は`Record<string, unknown>`を返しており、webview側（`chatScript.ts`）が読む
 * キー名の打ち間違いを型検査で拾えなかった。描画はCodex画面と同じスクリプトを使うが、
 * `ClaudeSettingsSnapshot`とはキー名が異なる（`effort`→`reasoningEffort`、
 * `permissionMode`→`approvalMode`）ため`SettingsSnapshot`とも一致しない、
 * Claude Code専用の形として定義する。
 */
interface ChatSettingsPayload {
  models: ClaudeSettingsSnapshot['models'];
  efforts: ClaudeSettingsSnapshot['efforts'];
  agents: ClaudeSettingsSnapshot['agents'];
  model: string;
  reasoningEffort: string;
  approvalMode: string;
  approvalLevel: string;
  agent: string;
  defaults: {
    /** `ClaudeDefaults`と同じく、settings.jsonに指定が無ければ`undefined`。 */
    model: string | undefined;
    reasoningEffort: string | undefined;
    approvalMode: string | undefined;
    /** Claude CodeにはCodexの`sandbox`に対応する設定が無いため常に`undefined`。 */
    sandbox: undefined;
    /**
     * エージェントの既定値はsettings.jsonから読んでいない（表示のみの用途に対して
     * 追跡コストが見合わないため）。「既定 (CLI側に指定なし)」とだけ出す
     */
    agent: undefined;
  };
  profile: string;
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
export class ClaudeChatViewManager
  extends BaseChatViewManager<ClaudePanel>
  implements TaskSessionHost
{
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
    super();
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
    // `/btw`（脇道の質問、issue #334）はCLIの一覧に無いため、拡張機能側で先頭へ足す
    void entry.panel.webview.postMessage({
      type: 'commands',
      commands: withPseudoCommands(CLAUDE_PSEUDO_COMMANDS, commands),
    });
  }

  /**
   * 画面下の設定行に出す現在値と選択肢を組み立てる（戻り値の形は`ChatSettingsPayload`参照）。
   *
   * 描画はCodex画面と同じスクリプトなので、Codex側のスナップショットと同じ形に整えて返す。
   * モデルの一覧は `initialize` の応答から取ったもの（取れなければエイリアス）。
   * `refreshSettings`・`flushState`の両方から呼ぶ（issue #420: 揃える前は`refreshSettings`
   * だけがこれを組み立てて送っており、`flushState`経由の更新には設定が乗らなかった）。
   */
  private buildSettingsPayload(): ChatSettingsPayload {
    const snapshot = this.settings.claudeSnapshot();
    return {
      models: snapshot.models,
      efforts: snapshot.efforts,
      agents: snapshot.agents,
      model: snapshot.model,
      reasoningEffort: snapshot.effort,
      approvalMode: snapshot.permissionMode,
      approvalLevel: snapshot.approvalLevel,
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
    };
  }

  /**
   * 画面下の設定行へ現在値と選択肢を送る。設定パネルでの変更など、人の操作へ即座に
   * 反映したい場面でだけ呼ぶ（`postState`の間引きを待たせない）。
   *
   * 会話項目は全量を送るが、`items`キーは付けない（`flushState`と違い、この経路は
   * 差し分ではなく全量なので不要）。そのため webview 側（`chatScript.ts`の
   * `window.addEventListener('message', ...)`）は`!data.items`の枝へ入り、
   * `apply(data.state)`だけを呼んで`mergedItems`（差し分の積み先）には触れない。
   * つまりここで送った内容はwebview側の差し分の基準には反映されない。
   *
   * **`entry.sentItems`をここで更新してはならない**（issue #420レビュー指摘、HIGH）。
   * 一度`entry.sentItems = state.items`と書いたところ、webview側は上記の理由で
   * 追随していないのに、ホスト側の基準だけが進んでしまい、次の`flushState`が
   * 送る差分を`mergeItems`（`chatScript.ts`側）が`total`の不一致で`undefined`と
   * 判定 → `stateFull`要求 → 全量再送、という往復を毎回生んだ（`ready`直後に
   * `entry.sentItems = undefined`へリセットした効果も、続けて呼ばれる
   * `refreshSettings`が誤って埋め戻すことで無効化されていた）。`entry.sentItems`は
   * 従来通り`flushState`だけが更新する。
   */
  private refreshSettings(entry: ClaudePanel): void {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    const state = entry.session.getState();
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...state,
        // 描画に使わない項目を落としてから送る（issue #320）。Editツール由来の
        // `editReplace` を持つのはClaude Codeの会話項目だけなので、この経路が本命
        items: stripHostOnlyItems(state.items),
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
        // 差分の見出し行の操作（issue #291）をWebview側でも出し分けるための一覧。
        // 権威ある判定はホスト側（handleOpenDiffFile等）が行うため、ここは
        // ボタン表示のヒントに過ぎない
        workspaceRoots: workspaceFolderPaths(),
        settings: this.buildSettingsPayload(),
      },
    });
  }

  /**
   * 画面へ現在の状態だけを送る（設定は含めない）。ストリーミング中の細かい更新は
   * こちらを使い、設定込みの完全な状態は `refreshSettings` が担う
   * （既存の挙動をそのまま踏襲。webview側は届かないキーを前回の値のまま保つ）。
   *
   * 呼び出し元の`onSessionChange`はNDJSONイベント1件ごとに同期的に発火する
   * （`ClaudeStreamSession.receive`）。以前は間引きが無く、`state.items`全量を
   * イベントの頻度のまま構造化クローンで直列化していた（issue #356）。
   * `chatView.ts`の`postState`/`flushState`と同じ流儀で、最初の1件はすぐ送り、
   * 以降は`STATE_POST_INTERVAL_MS`ごとにまとめる。まとめた分は必ず最後に1回
   * 送る（送り漏らして古い画面が残らないようにする）。
   */
  private postState(entry: ClaudePanel): void {
    // タブが閉じていても間引きの経路自体は回す。進捗画面（issue #721）はチャットのタブとは
    // 別のタブで、タスク管理下のセッションはタブを閉じても動き続ける（design.md §16.10）。
    // webviewへの送信は`flushState`側でタブの有無を見て止める
    if (entry.disposed || entry.postTimer !== undefined) {
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
   * 会話項目は差し分だけを`items`へ載せ、`state.items`は空で送る（issue #356、
   * `chatView.ts`の`flushState`と同じ流儀。`stripHostOnlyItems`相当の除去は
   * `buildItemsDelta`が内部で行う）。webview側は`chatScript.ts`の`mergeItems`
   * （実装は`stateDelta.ts`の`MERGE_ITEMS_SOURCE`）で積み直す。
   *
   * `settings`も`chatView.ts`の`flushState`と同じく毎回載せる（issue #420）。以前は
   * ここで設定を送らず、`onLoopStatus`が間引きを迂回する`refreshSettings`を別途呼ぶ
   * ことで設定の反映を担っていた。`onLoopStatus`をCodexと同じ`postState`（間引き済みの
   * このメソッド）呼び出しへ揃えたため、設定もここに乗せないとループ実行中の設定反映が
   * 抜け落ちる。
   */
  private flushState(entry: ClaudePanel): void {
    if (entry.disposed) {
      return;
    }
    entry.lastPostAt = Date.now();
    const state = entry.session.getState();
    // 進捗画面（issue #721）へはタブの有無によらず配る
    this.fireStateChanged(entry, state);
    if (entry.panel === undefined) {
      // タブが閉じている間は差し分を送らない。`entry.sentItems`もここでは進めない
      // （進めると、タブを開き直したときに送られていない項目が画面から抜ける）
      return;
    }
    const items = buildItemsDelta(entry.sentItems, state.items);
    entry.sentItems = state.items;
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...state,
        items: [],
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
        workspaceRoots: workspaceFolderPaths(),
        settings: this.buildSettingsPayload(),
      },
      items,
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

  /**
   * 新しい会話を開く。idは起動前に決まるため、開いた時点で履歴と紐づく。
   *
   * 呼び出し元がその後すぐ発言を送りたい場合（`handoffToNewSession`）のために、
   * 発行した`sessionId`を返す。開けなかった場合は`undefined`。
   */
  async openNew(cwd?: string, taskConfig?: ClaudeConfig): Promise<string | undefined> {
    const folder = currentWorkspaceFolder();
    const targetCwd = cwd ?? folder?.uri.fsPath;
    if (targetCwd === undefined) {
      void vscode.window.showErrorMessage(
        'Claude Codeを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
      );
      return undefined;
    }
    const effectiveConfig = taskConfig ?? readClaudeConfig().claude;
    if (isUnsafeClaudeCombination(effectiveConfig) && !(await this.confirmUnsafe())) {
      return undefined;
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
    return sessionId;
  }

  /**
   * 現在アクティブなセッションのtranscriptを新セッションへ渡し、引き継ぎを開始する
   * （issue #694）。CLIの応答を待って解析するのではなく、旧セッションのtranscript
   * ファイルパスを固定文言に埋め込んで新セッションへそのまま送る（新セッション側の
   * CLI自身に読ませて要約させる）。
   */
  async handoffToNewSession(): Promise<void> {
    const entry = this.active;
    if (entry === undefined) {
      return;
    }
    const sessionId = [...this.panels.entries()].find(([, v]) => v === entry)?.[0];
    if (sessionId === undefined) {
      return;
    }
    const transcriptPath = await resolveWithRetry(() =>
      this.store.resolveTranscriptPath(sessionId),
    );
    if (transcriptPath === undefined) {
      void vscode.window.showErrorMessage('引き継ぎ元セッションのtranscriptが見つかりませんでした');
      return;
    }
    const newSessionId = await this.openNew(entry.cwd, entry.taskConfig);
    if (newSessionId === undefined) {
      return;
    }
    const newEntry = this.panels.get(newSessionId);
    if (newEntry === undefined) {
      return;
    }
    this.dispatch(newEntry, buildHandoffPrompt(transcriptPath));
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
    // オーケストレーターセッション（design.md §16.23）・衝突解決セッション
    // （Issue #413 PR4）はタスクと同じ経路で開くが、タブ名だけ分けて人が見分けられるように
    // する（組み立ては`sessionTitle.ts`。Issue #533）
    const title = buildSessionPanelTitle(input, LABEL);
    const entry = this.buildEntry(input.cwd, title, true, taskConfig, title);
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
      initialTodoHistory: transcript.todoHistory,
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
   * 会話の途中のターンから分岐する（issue #333、design.md §14.61）。Codex画面の
   * 「ここから分岐」（`chatView.ts`の`forkFrom`）に相当する、Claude Code版の入口。
   *
   * 対象は`chatScript.ts`の`turnForkTarget`（`SHOW_TURN_FORK`）が渡す、押した発言自身の
   * uuid。`entry.session.threadId`が未確定（`system/init`をまだ受け取っていない、または
   * CLIが異常終了した後）の間は分岐先を特定できないため実行しない。ボタンが押せているのに
   * 無言で何も起きないと壊れているように見える（issue #340横断レビュー指摘）ため、
   * その旨を通知する。
   */
  private async forkFromTurn(entry: ClaudePanel, targetUuid: string): Promise<void> {
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      void vscode.window.showErrorMessage(
        'セッションidが確定していないため分岐できません。応答が始まってからやり直してください。',
      );
      return;
    }
    const userMessageUuids = entry.session
      .getState()
      .items.filter((item) => item.kind === 'userMessage')
      .map((item) => item.id);

    await this.openForkFromTurn(threadId, '分岐', entry.cwd, userMessageUuids, targetUuid);
  }

  /**
   * 指定したターンの手前までを引き継いだ新しいセッションを、新しいタブで開く
   * （issue #333、design.md §14.61）。
   *
   * `openFork`（セッション全体の分岐）と同じ経路でまずforkし、開いた新しいセッションへ
   * `rewind_conversation`を逐次送って対象の発言の手前まで戻す（`ClaudeStreamSession.
   * rewindConversationToTurn`参照）。元のセッション（`sessionId`が指す会話）へは
   * 一切送らない。ファイルは巻き戻らない（design.md §14.61）。
   *
   * 戻し切れると応答の`prefillText`（対象の発言本文）を入力欄へ挿す。既存の
   * `insertComposerText`（issue #292、エディタの選択範囲を挿す機構）をそのまま流用する
   * （新しいタブの入力欄は空のため、追記と設定は同じ結果になる）。
   *
   * 逐次rewindが途中で失敗した場合（issue #494のレビュー指摘）は
   * `ForkFromTurnResult.succeededCount`で2通りに分ける。
   * - 0件（1件も戻せていない）: fork側のCLIは何も削除していないため、開いたばかりの
   *   新しいタブを黙って閉じる（`teardown`）。元のタブは無傷なので操作をやり直せる
   * - 1件以上（途中まで戻ってから失敗）: fork側のCLIは既に一部のユーザー発言を削除済みで、
   *   タブの会話状態は中途半端。タブは閉じずに残し、`noteLocalEvent`でタブ自身に
   *   不整合な状態であることを明示し、そのまま入力を続けないよう促す
   */
  async openForkFromTurn(
    sessionId: string,
    title: string,
    cwd: string | undefined,
    userMessageUuids: readonly string[],
    targetUuid: string,
  ): Promise<void> {
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

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'この指示から分岐しています…' },
      () => entry.session.rewindConversationToTurn(userMessageUuids, targetUuid),
    );

    if (!result.ok) {
      const reason = describeForkFromTurnError(result.error);
      if (result.succeededCount === 0) {
        // 1件も戻せていない＝fork側のCLIは何も削除していない。新しいタブを黙って
        // 閉じれば無害（元のタブは無傷）
        this.teardown(entry);
        void vscode.window.showErrorMessage(`この指示から分岐できませんでした: ${reason}`);
        return;
      }
      // 途中まで戻ってから失敗＝fork側のCLIは既に一部のユーザー発言を削除済み。
      // タブは閉じず、不整合な状態であることを画面上に明示する
      const warning =
        'この指示への分岐が途中で失敗しました。会話は一部だけ巻き戻った不整合な状態です。' +
        `このタブへ入力を続けず、閉じてやり直してください（${reason}）`;
      entry.session.noteLocalEvent(`forkFromTurnFailed:${randomUUID()}`, warning);
      void vscode.window.showErrorMessage(warning);
      return;
    }
    if (result.prefillText !== undefined && result.prefillText !== '') {
      void entry.panel?.webview.postMessage({
        type: 'insertComposerText',
        text: result.prefillText,
      });
    }
  }

  /**
   * 擬似コマンドを実行する。CLIへは何も送らない（`chatView.ts`の`runPseudoCommand`と
   * 同じ考え方）。Claude Code画面は`CLAUDE_PSEUDO_COMMANDS`（`/btw`のみ）しか候補に
   * 出さないため、ここへ来る要求は必ず`sideQuestion`になる。
   */
  private async runPseudoCommand(entry: ClaudePanel, call: PseudoCommandCall): Promise<void> {
    if (call.action !== 'sideQuestion') {
      // CLAUDE_PSEUDO_COMMANDSに無い動作がここへ来ることは無いが、将来増えたときに
      // 黙って何も起きない状態を作らないよう、判る形で残す
      this.log.warn(`Claude Code画面が扱わない擬似コマンドです: ${call.name}`);
      return;
    }
    const question = trimmedArgsOrUndefined(call.args);
    if (question === undefined) {
      void vscode.window.showErrorMessage(
        '脇道の質問を入力してください（例: /btw 今のタイムゾーンは？）',
      );
      return;
    }
    await this.startSideQuestion(entry, question);
  }

  /**
   * 脇道の質問を送る（issue #334、design.md §14.62、Codexの `/btw` 相当）。
   *
   * Codex側（`chatView.ts`の`startSideQuestion`）は`thread/fork`で新しいタブを開き、
   * そこへ普通の会話として質問と応答を差し込む。Claude Codeの`side_question`は
   * 新しいセッションを作らない1往復の制御要求のため、同じタブの中に
   * `kind:'sideQuestion'`の1項目として残す（`ClaudeStreamSession.noteSideQuestion`）。
   * これは実際のCLIとのやり取り（transcript）には一切乗らない、拡張機能側だけの表示
   * （design.md §14.62で実測済み）。
   *
   * このタブで過去に送った脇道の質問（`entry.sideQuestionHistory`）を`history`として
   * 添え、`/btw`を連続で送ったときに前のやり取りを踏まえられるようにする
   * （本流の会話そのものは踏まえない。`control.ts`の`buildSideQuestionRequest`参照）。
   * `sideQuestionHistory`は無制限に伸びないよう`capSideQuestionHistory`で直近
   * `MAX_SIDE_QUESTION_HISTORY`件へ収める（`sideQuestion.ts`参照）。
   */
  private async startSideQuestion(entry: ClaudePanel, question: string): Promise<void> {
    const id = `sideQuestion:${randomUUID()}`;
    entry.session.noteSideQuestion(id, pendingSideQuestionDisplay(question));

    const result = await entry.session.askSideQuestion(
      question,
      entry.sideQuestionHistory,
      (progress) => {
        const display = progressSideQuestionDisplay(question, progress);
        if (display !== undefined) {
          entry.session.noteSideQuestion(id, display);
        }
      },
    );

    entry.session.noteSideQuestion(id, finishedSideQuestionDisplay(question, result));
    if (result.ok && result.response !== undefined) {
      const historyEntry: SideQuestionHistoryEntry = {
        question,
        response: result.response,
        fallbackNotice:
          result.refusalFallback === undefined
            ? undefined
            : `${result.refusalFallback.originalModel} が拒否したため ${result.refusalFallback.fallbackModel} が応答`,
      };
      entry.sideQuestionHistory = capSideQuestionHistory([
        ...entry.sideQuestionHistory,
        historyEntry,
      ]);
    }
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
  private async readTranscript(sessionId: string): Promise<{
    items: ChatState['items'];
    todos: ChatState['todos'];
    todoHistory: ChatState['todoHistory'];
  }> {
    const empty = { items: [], todos: [], todoHistory: [] };
    const filePath = await this.store.resolveTranscriptPath(sessionId);
    if (filePath === undefined) {
      return empty;
    }
    const content = await this.fs.readTextFile(filePath);
    return content === undefined ? empty : transcriptItems(content.split('\n'));
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
      initialTodoHistory: transcript.todoHistory,
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
    pinnedName?: string,
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
      // 停滞判定のしきい値（design.md §16.27、Issue #336）。LoopControllerはvscodeに
      // 依存しないため、設定の読み出しはここ（view層）で行う
      readWorkflowsConfig().stallRepeatCount,
    );

    const entry: ClaudePanel = {
      panel: undefined,
      session,
      loop,
      cwd,
      attachments: new AttachmentBox(),
      disposed: false,
      title,
      pinnedName,
      taskManaged,
      taskConfig,
      wasBusy: false,
      wasLoopRunning: false,
      approvalHandler: undefined,
      promptTransform: undefined,
      stateListeners: [],
      finishedListeners: [],
      approvalResolvedListeners: [],
      notifiedApprovalRequestIds: new Set(),
      sideQuestionHistory: [],
    };
    return entry;
  }

  /** `BaseChatViewManager.showPanel`（基底クラス）が新規作成時に呼ぶ、Claude Code用のパネル生成。 */
  protected override createWebviewPanel(
    entry: ClaudePanel,
    preserveFocus: boolean,
  ): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      VIEW_TYPE,
      entry.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      buildClaudeChatPanelOptions(),
    );
  }

  /** `BaseChatViewManager.attachPanel`（基底クラス）が呼ぶ、Claude Code用のwebview HTML組み立て。 */
  protected override renderPanelHtml(entry: ClaudePanel, panel: vscode.WebviewPanel): string {
    // 入力欄アイコン列の表に出すボタン（設定 agent.chat.composerButtons、issue #296）。
    // chatView.ts（Codex）と同じ配線。検証・既定への丸めはreadChatComposerButtonsConfig
    // 側（normalizeComposerButtons）が行うため、ここは警告が有ればログへ出すだけ
    const composerButtonsConfig = readChatComposerButtonsConfig();
    if (composerButtonsConfig.warning !== undefined) {
      this.log.warn(composerButtonsConfig.warning);
    }
    return renderShell(panel.webview, {
      agentLabel: LABEL,
      provider: 'claude',
      approvalModes: CLAUDE_PERMISSION_MODES,
      approvalCycle: APPROVAL_LEVEL_CYCLE,
      showSettings: true,
      showAgentSelector: true,
      composerButtons: composerButtonsConfig.buttons,
      // effort・エージェントだけ扱いが違う。黙って効かないより、効くタイミングを書くほうがまし
      settingsNote:
        'モデルと承認は今の会話にすぐ効きます。Effortは送りますが、CLIが結果を返さないため反映は確かめられません。エージェントは起動引数でのみ決まるため、変更は次のセッションから効きます。「既定」へ戻す操作も次のセッションから効きます。',
      // /review は実在しない（実測で /code-review を確認済み）。一覧に無ければボタンを隠す
      review: { mode: 'command', commandName: 'code-review' },
      // ファイルの巻き戻し（design.md「Claude Codeの巻き戻し」）。Codexは分岐で代替する
      showRewind: true,
      // 会話の途中のターンから分岐（issue #333、design.md §14.61）。Codex画面の
      // 「ここから分岐」と同じボタンを、対象を発言自身のidへ切り替えて出す
      showTurnFork: true,
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
      // 応答本文のMarkdown描画（issue #290、設定 agent.chat.renderMarkdown）
      renderMarkdown: readChatRenderMarkdownConfig(),
      // 送信キー（issue #288、設定 agent.chat.sendOn）。chatView.ts（Codex）と同じ配線
      sendOn: readChatSendOnConfig(),
      // 表示密度（issue #718、設定 agent.chat.density）。chatView.ts（Codex）と同じ配線
      density: readChatDensityConfig(),
    });
  }

  /** `BaseChatViewManager.attachPanel`（基底クラス）が配線する、webviewからのメッセージの実処理。 */
  protected override dispatchMessage(entry: ClaudePanel, message: unknown): void {
    this.handleMessage(entry, message);
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
      send: (text: string) => this.sendOnce(entry, text),
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
      this.notifyTurnComplete(entry);
    }
    const next = deriveTitle(state, entry.pinnedName);
    if (next !== undefined && entry.title !== next) {
      entry.title = next;
    }
    // 名前が変わっていなくても、実行中／承認待ちの状態は変わりうるので毎回適用する
    // （issue #286、design.md §14.55。`chatView.ts`の`onSessionChange`と同じ扱い）
    if (entry.panel !== undefined) {
      entry.panel.title = decoratePanelTitle(entry.title, deriveSessionActivityState(state));
    }
    this.notifyNewApprovals(entry, state);
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

  /**
   * ループの状態変化。停止（running: true→false）を検知して `onFinished` を1度だけ呼ぶ。
   *
   * 反復のたびに呼ばれるため、`refreshSettings`（間引き・差分を通さない全量送信）ではなく
   * `postState`（Codex側の`onLoopStatus`と同じ、`STATE_POST_INTERVAL_MS`の間引きに乗る
   * 経路）を呼ぶ（issue #420）。設定は`flushState`が毎回`settings`を載せるようにしたため、
   * この経路でも反映は途切れない。
   */
  private onLoopStatus(entry: ClaudePanel, status: LoopStatus): void {
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

  /**
   * 承認レベル（3段階）を適用する。
   *
   * Claude Codeでは `permissionMode` 1項目へ展開される。書き込みは
   * `SettingsProvider.updateApprovalLevel` が担い（「全承認」の同意もそこで取る）、
   * 実行中のセッションへの反映は `permissionMode` を変えたときと同じ経路に乗せる。
   */
  private async applyApprovalLevel(entry: ClaudePanel, level: unknown): Promise<void> {
    if (!isApprovalLevel(level)) {
      this.log.warn(`承認レベルの変更要求が不正です: ${String(level)}`);
      return;
    }
    // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
    const applied = await this.settings.updateApprovalLevel('claude', level);
    if (applied) {
      this.applyToSession(entry, 'permissionMode', claudePermissionModeForLevel(level));
    }
    this.refreshSettings(entry);
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
   * ループを介さずに本文を1回だけ送る（`TaskSession.send`。design.md §16.23）。
   *
   * `sendFromLoop` と違い `promptTransform` は通さず、`dispatch` も経由しない（`dispatch`
   * は必ず作業記録へ通知するため）。この口を使うのはオーケストレーターセッションだけで、
   * その会話本文は §16.12 の記録対象外にしてある。送信の失敗はループを止める理由に
   * ならないため、報告するだけで投げ直さない。
   */
  private sendOnce(entry: ClaudePanel, text: string): void {
    try {
      entry.session.sendOrQueue(text, []);
    } catch (e) {
      this.reportError(e);
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
        // `/btw`（脇道の質問、issue #334）はCLIへ送らず拡張機能側の機能として扱う。
        // CLIへ送っても普通の発言として素通しされるだけ（`pseudoCommands.ts`参照）
        const pseudo = routePseudoCommand(CLAUDE_PSEUDO_COMMANDS, text);
        if (pseudo !== undefined) {
          void this.runPseudoCommand(entry, pseudo);
          return;
        }
        // 手動の発言にだけ要約指示を足す（issue #709）。擬似コマンド・入力モードより後に
        // 置いてあるので、CLIへ送らない入力には付かない。ループの自動送信も対象外。
        // 作業記録には元の文面を残す（`logText`。テンプレート展開前を記録する§16.12と同じ扱い）
        const sent = appendTurnSummaryInstruction(text, readChatTurnSummaryConfig());
        this.dispatch(entry, sent, true, text);
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
        // Markdownのfile: URI・相対パスは会話の作業ディレクトリから開く。
        // それ以外のhttp(s) URLだけが従来どおり外部ブラウザへ渡る。
        if (await openChatFileLink(m['url'], entry.cwd)) {
          return;
        }
        if (isOpenableSearchUrl(m['url'])) {
          void vscode.env.openExternal(vscode.Uri.parse(m['url']));
        }
        return;
      }
      if (type === 'insertCode' && typeof m['code'] === 'string') {
        // コードブロックの「エディタへ挿入」。`chatView.ts` と共通の実装（issue #290）
        void insertCodeIntoEditor(m['code']);
        return;
      }
      if (type === 'openCodeFile' && typeof m['code'] === 'string') {
        // コードブロックの「新規ファイルで開く」（issue #290）
        void openCodeInNewFile(m['code'], typeof m['lang'] === 'string' ? m['lang'] : '');
        return;
      }
      if (type === 'openDiffFile') {
        // 差分の見出し行「エディタで開く」。`chatView.ts` と共通の実装（issue #291）
        void handleOpenDiffFile(entry.session.getState().items, m['itemId'], m['diffIndex']);
        return;
      }
      if (type === 'openDiffEditor') {
        // 差分の見出し行「差分を開く」。`chatView.ts` と共通の実装（issue #291）
        void handleOpenDiffEditor(
          this.fs,
          entry.session.getState().items,
          m['itemId'],
          m['diffIndex'],
        );
        return;
      }
      if (type === 'revertDiff') {
        // 差分の見出し行「この変更を戻す」。`chatView.ts` と共通の実装（issue #291）
        void handleRevertDiff(this.fs, entry.session.getState().items, m['itemId'], m['diffIndex']);
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
      if (type === 'teamWorkflow') {
        void vscode.commands.executeCommand('agent.workflows.team', 'claude');
        return;
      }
      if (type === 'workflowView') {
        void vscode.commands.executeCommand('agent.workflows.view');
        return;
      }
      if (type === 'sessionKanban') {
        void vscode.commands.executeCommand('agent.sessionKanban');
        return;
      }
      if (type === 'openProgress') {
        void vscode.commands.executeCommand('agent.openProgress');
        return;
      }
      if (type === 'handoffToNewSession') {
        void this.handoffToNewSession();
        return;
      }
      if (type === 'rewind' && typeof m['messageId'] === 'string') {
        entry.loop.noteUserAction();
        void this.rewindFiles(entry, m['messageId']);
        return;
      }
      if (type === 'fork' && typeof m['turnId'] === 'string') {
        // 会話の途中のターンから分岐（issue #333、design.md §14.61）。新しいタブを
        // 開くだけで、この会話（entry）そのものには何も送らない
        void this.forkFromTurn(entry, m['turnId']);
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
      if (type === 'popLastQueuedForInput') {
        // 常に拡張側の最新stateから取り出す（UI側の古いスナップショット由来のズレを防ぐ）
        const popped = entry.session.popLastQueuedForInput();
        if (popped !== undefined && entry.panel !== undefined) {
          void entry.panel.webview.postMessage({ type: 'restoreQueuedText', text: popped.text });
        }
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
      if (type === 'stateFull') {
        // webview側が会話の取りこぼしに気付いたときの作り直し要求（issue #262、
        // `chatView.ts`の同名分岐と同じ理由）。間引きに巻き込むと戻りが遅れるため、
        // その場で送る
        entry.sentItems = undefined;
        this.flushState(entry);
        return;
      }
      if (type === 'ready') {
        // webviewを作り直した直後は会話項目の積み直し状態（`mergedItems`）が空に戻る。
        // 差し分ではなく全量から送り直す（issue #262、#356）
        entry.sentItems = undefined;
        this.refreshSettings(entry);
        void this.postCommands(entry);
        return;
      }
      if (type === 'approvalLevel') {
        void this.applyApprovalLevel(entry, m['level']);
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
        return;
      }
      // AskUserQuestion（issue #685）の選択送信。汎用の`approve`（4値decision）では
      // 選んだ回答を運べないため専用メッセージにしている（拒否は従来通り`approve`を使う）
      if (type === 'answerAskUserQuestion' && isAskUserQuestionSelections(m['answers'])) {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          entry.session.answerAskUserQuestion(requestId, m['answers']);
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
}

/**
 * タブ名。解決順は「**オーケストレータが指定した名前（`pinnedName`）** > 人が付けた名前
 * （`state.name`） > 最初の指示から作った名前」（issue #199の受入基準、Issue #599）。
 * Claude Codeは要約名をCLI側に持たないため、最後は最初のユーザー発言から作る。
 *
 * `pinnedName`を最優先にするのは、**ワークフローが並列に開いたタスクを見分けるため**。
 * これが無いと、`openTaskSession`が渡したタブ名は初回表示の一瞬しか生き残らない。
 */
export function deriveTitle(state: ChatState, pinnedName?: string): string | undefined {
  if (pinnedName !== undefined && pinnedName.trim() !== '') {
    return pinnedName;
  }
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
