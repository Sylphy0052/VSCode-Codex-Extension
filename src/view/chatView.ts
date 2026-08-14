import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildApprovalResponse,
  defaultDenyResponse,
  describeApproval,
  isApprovalDecision,
  type ApprovalDecision,
} from '../appserver/approvals';
import { isOpenableSearchUrl, type ChatItem, type ChatState } from '../appserver/chatState';
import { ChatSession } from '../appserver/chatSession';
import {
  buildTranscriptMarkdown,
  defaultTranscriptFileName,
} from '../appserver/transcriptMarkdown';
import {
  AppServerConnection,
  type AppServerConnectionPort,
  type NotificationHandler,
  type ServerRequest,
  type ServerRequestHandler,
} from '../appserver/connection';
import type { ActivityKind } from '../activity/record';
import { describeUnsafeCombination } from '../codex/argvBuilder';
import { summarize } from '../codex/conversation';
import { readForkedThreadId } from '../codex/jsonRpc';
import { readSkillsList } from '../codex/skillsList';
import { readRateLimits, type UsageSnapshot } from '../codex/usage';
import { currentWorkspaceFolder, readConfig, workspaceFolderPaths } from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { LoopPlan, LoopStatus, LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import type { FileSystemPort, SymlinkResolution } from '../session/ports';
import { APPROVAL_MODES, SANDBOX_MODES, type CodexConfig } from '../codex/types';
import type { PromptSubmission } from '../appserver/prompts';
import { MESSAGING_MCP_SERVER_NAME } from '../orchestrator/messaging';
import type {
  ApprovalHandler,
  ApprovalOutcome,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../orchestrator/taskSession';
import { buildItemsDelta } from './stateDelta';
import { CODEX_APPROVAL_CYCLE } from '../provider/approvalCycle';
import { AttachmentBox, dropRejectionReason } from '../provider/attachments';
import { buildImageReply } from '../provider/imageRefs';
import { CommandCatalog } from '../provider/commandCatalog';
import { FileMentionCatalog, filterFiles } from '../provider/fileMentions';
import {
  buildInitInstructionText,
  CODEX_PSEUDO_COMMANDS,
  routePseudoCommand,
  trimmedArgsOrUndefined,
  withPseudoCommands,
  type PseudoCommandCall,
} from '../provider/pseudoCommands';
import { buildMemoryAppendConfirmation } from '../provider/inputModes';
import type { SlashCommand } from '../provider/slashCommands';
import {
  buildReviewTarget,
  type ReviewDelivery,
  type ReviewTarget,
  type ReviewTargetKind,
} from '../codex/reviewTarget';
import { buildSideQuestionForkParams } from '../codex/sideQuestion';
import { chatCsp } from './chatCsp';
import { chatScript, type ReviewButtonConfig } from './chatScript';
import { chatStyles } from './chatStyles';
import { PendingStartRegistry } from './pendingStarts';
import { readPersistedThreadId } from './panelState';
import { isEditableKey, type SettingsProvider } from './settingsProvider';

const VIEW_TYPE = 'codex.chat';

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

/**
 * 画面へ状態を送る最短間隔（issue #246）。
 *
 * 巨大なコマンド出力の最中に届くデルタ1件ごとに状態全体を送ると、拡張ホストが直列化で
 * 埋まり、`turn/interrupt` の応答すら読めなくなる。人の目には連続に見える程度に短く、
 * かつ送信回数を2桁減らせる長さとして50msを採る（毎秒最大20回）。
 */
export const STATE_POST_INTERVAL_MS = 50;

interface ChatPanel {
  /**
   * 今そのタブが開いているか。`undefined` はタブが閉じられている状態を表す。
   *
   * タスク管理下のセッション（`taskManaged: true`）は、タブを閉じてもこのエントリ自体は
   * `panels` に残り続ける（design.md §16.10「セッションの寿命をパネルから切り離す」）。
   * `reveal()` / `open()` はこの値が `undefined` ならパネルを作り直す。
   */
  panel: vscode.WebviewPanel | undefined;
  session: ChatSession;
  /** この画面で走らせているループ。走っていなければ待機状態のまま。 */
  loop: LoopController;
  /** 作業記録に載せるディレクトリ。resume時はセッション自身のcwd。 */
  cwd: string | undefined;
  /** 送信前の添付画像。送るまでここに溜める。 */
  attachments: AttachmentBox;
  /**
   * 破棄済みか。
   *
   * 保留中の承認を解放すると、その結果の通知が破棄後に届くことがある。破棄済みの
   * セッションへ送るとVSCodeが例外を投げるため、ここで止める。`panel === undefined`
   * とは別の概念（タスク管理下のセッションはタブが閉じても破棄されない）。
   */
  disposed: boolean;
  /** パネルの見出し。タブが閉じている間もタイトルを見失わないよう、パネルとは別に保持する。 */
  title: string;
  /**
   * タスク（オーケストレータ）管理下のセッションか。
   *
   * `true` の場合だけタブを閉じてもセッションを維持する（design.md §16.10の4）。
   * 人が手で開いた画面（`false`）は従来通りタブを閉じたらセッションも終わる。
   */
  taskManaged: boolean;
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
  /** `TaskSession.onApprovalResolved` のリスナー。 */
  approvalResolvedListeners: Array<(outcome: ApprovalOutcome) => void>;
  /**
   * `mcpServer/startupStatus/updated`通知（design.md §16.21）を待つリスナー。
   * `checkMessagingToolVisible`がツールの可視性を確かめるために使う。この通知は
   * `thread/start`の後にしか届かないため、会話には無関係な内部状態としてここへ集める
   * （`ChatSession.applyNotification`へは転送しない。`routeNotification`参照）。
   */
  mcpStartupListeners: Array<(name: string, status: string) => void>;
  /** 状態送信の間引き（issue #246）。予約中のタイマー。 */
  postTimer?: ReturnType<typeof setTimeout> | undefined;
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

/** 拡張機能から実行したセッションを日報バッファへ記録するための通知。 */
export interface ChatActivity {
  sessionId: string;
  cwd: string;
  kind: ActivityKind;
  /** `kind: 'prompt'` は発言そのもの、`kind: 'result'` はターンの最終応答テキスト。 */
  text: string;
  /** `kind: 'result'` のときだけ使う。そのターンで編集したファイルパス。 */
  editedFiles?: readonly string[];
}

/**
 * 貼られた画像を受け取る。Codex画面・Claude Code画面の両方で共有する。
 *
 * 受け付けられなかったときは**理由を画面に出す**。黙って捨てると、貼ったのに
 * サムネイルが出ない理由が分からない。
 */
export function addAttachment(box: AttachmentBox, name: unknown, dataUrl: unknown): void {
  if (typeof dataUrl !== 'string') {
    return;
  }
  const label = typeof name === 'string' && name !== '' ? name : '貼り付けた画像';
  const added = box.add(label, dataUrl);
  if ('reason' in added) {
    void vscode.window.showWarningMessage(`画像を添えられません: ${added.reason}`);
  }
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
 * 画像を取れなかったドロップを知らせる（issue #241）。Codex画面・Claude Code画面で共有する。
 *
 * `addAttachment` と同じ考え方で、受け取れなかったときは黙って捨てずに理由を出す。
 */
export function noteDropRejected(kind: unknown): void {
  const reason = dropRejectionReason(kind);
  if (reason === undefined) {
    return;
  }
  void vscode.window.showWarningMessage(`画像を添えられません: ${reason}`);
}

/**
 * 圧縮してよいか確かめる。Codex画面・Claude Code画面の両方で共有する。
 *
 * 圧縮は会話の内容を要約へ置き換える。元には戻せないため、必ず確認を通す。
 */
export async function confirmCompact(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'これまでの会話を要約に置き換えます。元の内容には戻せません。',
    { modal: true },
    '圧縮する',
  );
  return choice === '圧縮する';
}

/**
 * 他エージェント（Codex／Gemini）の設定インポートを送ってよいか確かめる
 * （issue #200、design.md TP-88。Claude Code画面のみ）。
 *
 * Codex側（issue #36）は取り込み対象を一覧から選ばせてから確認するが、Claude Code側は
 * control protocolに構造化された一覧取得手段が無く（`streamSession.ts` の
 * `importConfig` 参照）、`/import` をそのまま会話へ送ってCLI自身のプレビュー応答に
 * 委ねるほかない。そのため「何を・どこから・どこへ」をこの確認ダイアログで明示してから
 * 送る。ここで送るのはプレビュー要求のみで、実際の書き込みにはCLIが返すダイジェスト付き
 * 確認コマンドをユーザーがもう一度送る必要がある（二段階確認）。
 */
export async function confirmClaudeImport(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'CodexまたはGeminiのローカル設定（MCPサーバー・AGENTS.md・カスタムコマンドなど）を' +
      'このClaude Codeへ取り込む準備をします。\n\n' +
      '送るのは確認（プレビュー）の要求だけで、ここでは何も書き換えません。' +
      'CLIが会話内に取り込み対象と確認コマンドを提示するので、実際に取り込むかどうかは' +
      'その応答を見てから改めて判断してください。',
    { modal: true },
    '確認を送る',
  );
  return choice === '確認を送る';
}

/**
 * 追加クレジット（usage credits）の設定・管理者への要求を送ってよいか確かめる
 * （issue #204、design.md §14.38。Claude Code画面のみ）。
 *
 * 実測（`streamSession.ts` の `requestUsageCredits` 参照）では、この拡張機能の
 * 非対話セッションから送ると常に管理ページのURLを返すだけの固定文になり、組織の
 * 管理者への通知はCLIの対話セッションでしか起きないと見られる。ただしこれは1状態
 * （追加クレジット無効）だけの実測で、有効時や他の理由で挙動が変わらない保証は無い。
 * `/usage-credits`というコマンド自体がCLIの語彙で「管理者への要求」を明言している
 * ため、`confirmClaudeImport`と同じく安全側に倒して必ず確認を挟む。
 */
export async function confirmUsageCreditsRequest(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    '追加クレジットの設定・管理者への要求（/usage-credits）を送ります。\n\n' +
      'この拡張機能からの送信は対話操作ができないため、実際には管理ページを開くための' +
      'リンクが会話に返るだけの見込みです。ただし将来のCLIの更新やアカウントの状態に' +
      'よっては、この操作が組織の管理者に通知される可能性があります。',
    { modal: true },
    '送る',
  );
  return choice === '送る';
}

/**
 * `/debug`（CLI側のデバッグログをモデルに読ませて診断させる要求）を送ってよいか確かめる
 * （issue #205、design.md §14.39。Claude Code画面のみ）。
 *
 * 本体の事前実測（issue #205のコメント、CLI 2.1.227）によれば、`/debug`は`/usage-credits`
 * よりさらに重い操作で、**実モデル（`claude-opus-5`）が動きBashツールで`ls`・`cat`を
 * 実行**してログを読む。課金される（実測: `total_cost_usd: 0.3824885`）うえ、承認が
 * 要る構成では承認カードも出る。ログの中身を見るだけなら「デバッグログを開く」
 * （`openDebugLog`、CLIへは何も送らず無償）のほうが軽いため、その旨も文面に含めて
 * 誤って高コストな方を選ばないようにする。
 */
export async function confirmDebugCommand(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'デバッグログの診断（/debug）を送ります。\n\n' +
      '実測（CLI 2.1.227）では実モデルが起動し、Bashツールでログファイルを読んで要約' +
      'します（実測時のコストはUSD 0.38ほど）。承認が必要な設定では承認カードが出ます。' +
      'ログ自体は既に~/.claude/debug/配下に常時出ているため、内容を直接確認したい' +
      'だけなら「デバッグログを開く」のほうが低コストです。',
    { modal: true },
    '送る',
  );
  return choice === '送る';
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

/**
 * バックグラウンドタスクを止めてよいか確かめる（issue #33、design.md §14.23、
 * Claude Code画面のみ。Codexには停止する確定した経路が無い）。
 *
 * 実行中の処理を打ち切る破壊的な操作のため、`confirmCompact` / `confirmUninstallPlugin` と
 * 同じく必ず確認を挟む。
 */
export async function confirmStopBackgroundTask(command: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `バックグラウンドで実行中のタスクを停止します: ${command}`,
    { modal: true },
    '停止する',
  );
  return choice === '停止する';
}

/**
 * 行頭が `!` の入力（issue #5、design.md §14.29）をターミナルへ入力してよいか確かめる。
 *
 * **自動実行はしない**（`openLoginTerminal` と同じ流儀。統合ターミナルへ文字を入力するだけで、
 * 実行するかどうかは開いたターミナルでユーザーが自分でEnterを押して決める）。それでも
 * 何を入力するかは事前にここで確認させる。
 */
export async function confirmRunShellCommand(command: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `次のコマンドを統合ターミナルへ入力します（自動実行はしません。実行するかはターミナル側でEnterを押して決められます）:\n\n${command}`,
    { modal: true },
    '入力する',
  );
  return choice === '入力する';
}

/**
 * 行頭が `#` の入力（issue #6、design.md §14.29）をメモリへ追記してよいか確かめる。
 *
 * ファイルへの書き込みは元に戻せないため（gitで管理されていない環境もある）、
 * 追記先と内容の両方を確認させてから書く（issue #6の受入基準）。
 *
 * `symlink` は追記先のシンボリックリンク判別結果。本文の組み立ては
 * `buildMemoryAppendConfirmation`（純粋関数）に切り出してある（issue #144。実体パスを
 * 見せずに書き込みが実行されると、実際にどのファイルが書き換わるか分からないため。
 * 実体パスが特定できない場合も警告として出す）。
 */
export async function confirmMemoryAppend(
  content: string,
  path: string,
  symlink: SymlinkResolution,
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    buildMemoryAppendConfirmation(content, path, symlink),
    { modal: true },
    '追記する',
  );
  return choice === '追記する';
}

/** 確認ダイアログに列挙するファイル数の上限。超えた分は件数だけ示す。 */
const REWIND_FILE_LIST_LIMIT = 10;

/**
 * ファイルの巻き戻し（Claude Code画面のみ）を実行してよいか確かめる。
 *
 * **会話の履歴には触れず、ファイルだけを戻す**。取り違えると作業が失われるため、
 * 対象ファイルを列挙したうえで「会話は変わらない」ことを明記する
 * （design.md「Claude Codeの巻き戻し」・Issue #21の受入基準）。
 */
export async function confirmRewindFiles(files: readonly string[]): Promise<boolean> {
  const shown =
    files.length > REWIND_FILE_LIST_LIMIT
      ? [...files.slice(0, REWIND_FILE_LIST_LIMIT), `他 ${files.length - REWIND_FILE_LIST_LIMIT}件`]
      : files;
  const choice = await vscode.window.showWarningMessage(
    `次のファイルを、この発言を送る前の状態に戻します。会話の履歴は変わりません。元には戻せません。\n\n${shown.join('\n')}`,
    { modal: true },
    'ファイルを戻す',
  );
  return choice === 'ファイルを戻す';
}

/**
 * ターン完了時の成果を作業記録へ通知する。Codex画面・Claude Code画面の両方で共有する。
 * 応答テキストと編集ファイルの両方が空なら何もしない。
 */
export function reportTurnResult(
  onActivity: (activity: ChatActivity) => void,
  sessionId: string | undefined,
  cwd: string | undefined,
  state: ChatState,
): void {
  if (sessionId === undefined || cwd === undefined) {
    return;
  }
  if (state.turnResultText === '' && state.turnEditedFiles.length === 0) {
    return;
  }
  onActivity({
    sessionId,
    cwd,
    kind: 'result',
    text: state.turnResultText,
    editedFiles: state.turnEditedFiles,
  });
}

/**
 * 会話全体の取り出し（issue #25・design.md §14.23）で選ばせる操作。
 * `runReview` の対象選択と同じQuickPickの流儀に揃える。
 */
const TRANSCRIPT_EXPORT_ITEMS: (vscode.QuickPickItem & { mode: 'copy' | 'save' | 'raw' })[] = [
  { mode: 'copy', label: 'クリップボードへコピー', detail: '会話全体をMarkdownでコピーします' },
  { mode: 'save', label: 'ファイルへ保存', detail: 'Markdownファイルとして保存します' },
  {
    mode: 'raw',
    label: '生テキストで開く',
    detail: '装飾を落として新しいタブに開きます。コピー・検索・保存もそのままできます',
  },
];

/**
 * 会話全体をMarkdownとして取り出す。Codex画面・Claude Code画面の両方で共有する。
 *
 * Markdownの組み立ては純粋関数（`buildTranscriptMarkdown`）に任せ、ここでは
 * 「何をするか」をQuickPickで選ばせてから実行するだけにする。**外部へ送る機能は作らない**
 * （クリップボード・ローカルファイル・エディタタブの3つに留める。issue #25の仕様）。
 *
 * 生テキストで開く操作は、ワークフロー生成が検証エラー時にやっている
 * `vscode.workspace.openTextDocument({content, language})` と同じ手（`extension.ts`
 * の `handlePlanFailure` 参照）で、通常のエディタとして開けばコピー・検索・保存が
 * VSCode標準の操作でできる。
 */
export async function runExportTranscript(
  items: readonly ChatItem[],
  agentLabel: string,
): Promise<void> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage('会話がまだ無いため取り出せません');
    return;
  }

  const choice = await vscode.window.showQuickPick(TRANSCRIPT_EXPORT_ITEMS, {
    title: '会話を取り出す',
    placeHolder: '何をしますか',
  });
  if (choice === undefined) {
    return;
  }

  const markdown = buildTranscriptMarkdown(items, agentLabel);

  if (choice.mode === 'copy') {
    await vscode.env.clipboard.writeText(markdown);
    void vscode.window.showInformationMessage('会話をMarkdownでコピーしました');
    return;
  }

  if (choice.mode === 'save') {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultTranscriptFileName(new Date())),
      filters: { Markdown: ['md'] },
    });
    if (uri === undefined) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf8'));
    void vscode.window.showInformationMessage(`会話を保存しました: ${uri.fsPath}`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
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
 * 会話に出てきた画像をWebviewへ返す。Codex画面・Claude Code画面の両方で共有する。
 *
 * 画像はデータURLにして送る。`localResourceRoots` を広げて `asWebviewUri` で参照させると、
 * その範囲のファイルをWebviewから自由に読めるようになるため、そちらへは寄せない。
 * 読めるのは**会話に出てきたパスだけ**（判定は `buildImageReply`）。
 */
export async function postImageData(
  panel: vscode.WebviewPanel,
  fs: FileSystemPort,
  items: readonly ChatItem[],
  requested: unknown,
): Promise<void> {
  const reply = await buildImageReply(items, requested, (filePath, maxBytes) =>
    fs.readBase64File(filePath, maxBytes),
  );
  if (reply !== undefined) {
    void panel.webview.postMessage({ type: 'imageData', ...reply });
  }
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

/** `@` の候補として返す最大件数。画面に収まる範囲に留める。 */
const MENTION_LIMIT = 50;

/**
 * `@` のファイル候補をWebviewへ返す。
 *
 * **絞り込みはホスト側で行う。** 同じ規則をWebviewにも書くと、片方だけ直したときに
 * 「候補に出たのに違うものが入る」状態になる。走査を間引くのはカタログの責務。
 */
export async function postFileMentions(
  panel: vscode.WebviewPanel,
  mentions: FileMentionCatalog,
  cwd: string | undefined,
  query: unknown,
): Promise<void> {
  if (typeof query !== 'string') {
    return;
  }
  // 復元されたCodex画面はcwdを持たない。そのときはこのウィンドウのフォルダを充てる
  const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
  if (folder === undefined) {
    return;
  }
  const files = filterFiles(await mentions.list(folder), query, MENTION_LIMIT);
  void panel.webview.postMessage({ type: 'files', query, files });
}

/**
 * Codex画面。app-server と繋いで会話をその場で描画し、承認と分岐も画面内で完結させる。
 *
 * TUIタブ方式と併存する。こちらは設定がターン単位で効き、会話の途中から直接分岐できる。
 * `TaskSessionHost` を実装し、オーケストレータ（`runner.ts`。次の依頼で実装）がプロバイダを
 * 見ずにタスクのセッションを扱えるようにする（design.md §16.10）。
 */
export class ChatViewManager implements vscode.Disposable, TaskSessionHost {
  private readonly connection: AppServerConnectionPort;
  private readonly panels = new Map<string, ChatPanel>();
  /**
   * `thread/start` の応答待ち。複数件を同時に持てる（design.md §16.10の3）。
   * 「最後に開始した1件」を決め打ちで返すと、並列開始時に別タスク宛の通知・承認要求を
   * 誤配送する（詳しくは `pendingStarts.ts` のコメント）。
   */
  private readonly pendingStarts = new PendingStartRegistry<ChatPanel>();
  /** 名前変更コマンドの対象。最後にアクティブだったCodex画面。 */
  private active: ChatPanel | undefined;

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
    ) => AppServerConnectionPort = (onNotification, onServerRequest) =>
      new AppServerConnection(codexPath, log, onNotification, onServerRequest),
  ) {
    this.catalog = new CommandCatalog(this.fs);
    this.connection = connectionFactory(
      (method, params) => this.routeNotification(method, params),
      (request) => this.routeServerRequest(request),
    );
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
    const entry = this.buildEntry(input.cwd, 'Codex', true, taskConfig);
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
    };
    return entry;
  }

  /**
   * パネルを表に出す。既にタブがあれば `reveal`、閉じていれば作り直す
   * （design.md §16.10の4「reveal()でパネルを作り直し、ChatStateから会話を描き直す」）。
   * 会話の再描画は、webview起動時の `ready` 通知への応答（`postState`）に任せる。
   */
  private showPanel(entry: ChatPanel, preserveFocus: boolean): void {
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
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.attachPanel(entry, panel);
  }

  /** 実際のパネルへ表示を結び付け、イベントを配線する。 */
  private attachPanel(entry: ChatPanel, panel: vscode.WebviewPanel): void {
    entry.panel = panel;
    panel.title = entry.title;
    panel.webview.options = { enableScripts: true };
    panel.webview.html = renderShell(panel.webview, {
      agentLabel: 'Codex',
      approvalModes: APPROVAL_MODES,
      approvalCycle: CODEX_APPROVAL_CYCLE,
      sandboxModes: SANDBOX_MODES,
      showSettings: true,
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
    });

    panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.handleMessage(entry, message),
    );
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
    // showPanelのreveal分岐（既存タブ）はpreserveFocusを見てactiveを更新するのに、
    // 新規作成のこの分岐だけ無条件にactiveを奪っていた（レビュー指摘: critical 2）。
    // タスクは必ずpreserveFocus: trueで背面に開く（design.md §16.10の2）ため、
    // 無条件のままだと背面のタスクが「名前変更」等の対象を奪ってしまう。
    // 実際にフォーカスが当たっているか（panel.active）を見て決める
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
  private buildTaskSession(entry: ChatPanel, threadId: string, mcpRequested = false): TaskSession {
    return {
      sessionId: threadId,
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
   * 承認要求を決定する。webviewの承認カード（`approve`メッセージ）とワークフローViewの
   * 「承認」操作（`TaskSession.decideApproval`）の両方から呼ばれる共通経路にしておくことで、
   * どちらの入口から決定しても `onApprovalResolved` のリスナーへ同じ通知が届く。
   */
  private resolveApproval(
    entry: ChatPanel,
    requestId: number | string,
    decision: ApprovalDecision,
  ): void {
    entry.session.decide(requestId, decision);
    for (const listener of entry.approvalResolvedListeners) {
      listener({ requestId, decision });
    }
  }

  /**
   * エントリを完全に破棄する。ループを止め、セッションを解放し（保留中の承認は拒否される）、
   * パネルが開いていれば閉じ、全ての管理表から取り除く。
   *
   * 二重に呼んでも安全（`disposed` で早期return）。タブを閉じたことによる破棄と、
   * 明示的な `dispose()` 呼び出しの両方から通る。
   */
  private teardown(entry: ChatPanel): void {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    if (entry.postTimer !== undefined) {
      clearTimeout(entry.postTimer);
      entry.postTimer = undefined;
    }
    entry.loop.stop('manual');
    entry.session.dispose();
    entry.panel?.dispose();
    entry.panel = undefined;
    if (this.active === entry) {
      this.active = undefined;
    }
    this.pendingStarts.remove(entry);
    for (const [id, value] of this.panels) {
      if (value === entry) {
        this.panels.delete(id);
      }
    }
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
    }
    const title = deriveTitle(state);
    if (title !== undefined && entry.title !== title) {
      entry.title = title;
      if (entry.panel !== undefined) {
        entry.panel.title = title;
      }
    }
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
        // 応答中でも押せる。QuickPickの組み立ては`extension.ts`側に一本化してある
        await vscode.commands.executeCommand('agent.workflows.menu');
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

  private allPanels(): ChatPanel[] {
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

  dispose(): void {
    for (const entry of this.allPanels()) {
      this.teardown(entry);
    }
    this.panels.clear();
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

export interface ChatShellOptions {
  /** 画面に出すCLIの名前。発言の見出しと入力欄の案内に使う。 */
  agentLabel: string;
  /** 承認方法の選択肢。プロバイダごとに異なる。 */
  approvalModes: readonly string[];
  /**
   * Shift+Tabで回す承認方法の並び（issue #13）。渡さなければキー操作を効かせない。
   */
  approvalCycle?: readonly string[];
  /**
   * サンドボックスの選択肢。渡さなければセレクタ自体を出さない。
   *
   * Claude Codeにサンドボックスの概念は無く、権限は `--permission-mode` に集約される。
   */
  sandboxModes?: readonly string[];
  /** モデル・effort・承認のプルダウンを出すか（Codex画面のみ）。 */
  showSettings: boolean;
  /**
   * エージェントのプルダウンを出すか（Claude Code画面のみ）。
   *
   * Codexにエージェントの概念は無い。選択肢はモデル・effortと同じく空のまま描画し、
   * `state.settings.agents` を受け取ってから `applySettings` が埋める（`fillSelect`）。
   */
  showAgentSelector?: boolean;
  /** レビューボタンの動作。Codexは常に出し、Claude Codeはコマンド一覧にあるときだけ出す。 */
  review: ReviewButtonConfig;
  /**
   * 設定行の下に出す但し書き。
   *
   * 変更がいつから効くかはプロバイダで違う。書かないと「変えたのに効かない」に見える。
   */
  settingsNote?: string;
  /**
   * 発言ごとに「ここまで戻す」ボタンを出すか（Claude Code画面のみ）。
   *
   * Codexには会話の途中から**分岐**する導線（「ここから分岐」）が既にあり、巻き戻しは
   * 実装しない（design.md「Claude Codeの巻き戻し」。thread/rollbackはdeprecatedかつ
   * ファイルを戻さない）。Claude Codeは`rewind_files`でファイルだけを戻せる。
   */
  showRewind?: boolean;
  /**
   * 入力欄の下に `!`/`#` 始まりの案内を出すか（Claude Code画面のみ、issue #5/#6、
   * design.md §14.29）。CodexのTUIにこの挙動は無い。
   */
  showInputModeHints?: boolean;
  /**
   * 「他エージェントから設定をインポート」ボタンを出すか。
   *
   * 押したときの動きはプロバイダごとに違う。Claude Code（issue #200、design.md §14.34、
   * TP-88）は`/import` のプレビューを会話へ送る。Codex（issue #227、design.md §14.42）は
   * 同じ機能を既にコントロールパネルの一覧UI（issue #36）で持っているため、二重実装は
   * せず、設定パネルを表示して「他エージェントからの設定インポート」のセクションを
   * 展開するだけに留める。動きが違う以上ボタンの`aria-label`・`title`も揃えられないため、
   * `true`（Claude Codeの既定文言のまま出す）か、文言を差し替えるオブジェクトかを選べる
   * ようにしている。
   */
  showImport?: boolean | { ariaLabel: string; title: string };
  /**
   * 「会話の1行要約」ボタンを出すか（Claude Code画面: issue #203、design.md §14.36。
   * Codex画面: issue #228、design.md §14.41）。
   *
   * ボタンを出すかどうかの意味は両画面で共通だが、**押したときに送る中身はプロバイダごとに
   * 違う**。Claude CodeはTUI由来のローカルコマンド`/recap`を発言として送る
   * （`ClaudeStreamSession.recap()`）。Codexにこの概念は無いため、要約を依頼する指示文
   * （`RECAP_INSTRUCTION`）を通常のターンとして送る（`ChatSession.recap()`）。どちらも
   * 応答は会話に残るが、Claude Code側は`<synthetic>`表示、Codex側は通常のモデル応答という
   * 見え方の違いがある（design.md §14.41の対比表参照）。
   */
  showRecap?: boolean;
  /**
   * 自動圧縮の窓サイズの確認・変更欄を出すか（Claude Code画面のみ、issue #201、
   * design.md §14.37）。
   *
   * `/autocompact` はTUI由来のローカルコマンドで、Codexに対応する設定は無い
   * （issue本文の前提どおり）。二重導線を避けるためCodex画面には出さない。
   */
  showAutocompact?: boolean;
  /**
   * CLI側のデバッグログを扱う導線（「デバッグログを開く」「/debugで診断」）を
   * 設定行へ出すか（Claude Code画面のみ、issue #205、design.md §14.39）。
   *
   * どちらもTUI由来の概念（CLIのデバッグログ・`/debug`コマンド）で、Codexに対応する
   * ものは無いため、二重導線を避けてClaude Code画面にだけ出す。常用の操作ではない
   * ため、送信ボタンが並ぶ入力欄ではなく設定行（`#settings`、普段は開かない場所）に
   * 置く（issue本文の「常用の操作と混ざらない置き場」）。
   */
  showDebug?: boolean;
}

/**
 * チャット画面のHTMLを組み立てる。CodexとClaude Codeで共有する。
 * 描画するのは `ChatState` だけなので、プロバイダごとの差はここでは扱わない。
 */
/** 設定から来る文字列をHTMLへ埋め込む前に無害化する。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * `#composer` で送信以外のボタンに使うアイコン（issue #226）。
 *
 * codiconのwebfontは使わない。webviewのCSPは `default-src 'none'` で `font-src` を
 * 開けておらず（`chatCsp.ts`）、未指定のdirectiveは `default-src` に落ちて塞がれるため、
 * フォント読み込みには新しい許可とアセット同梱が要る。外部CDNも使えない。インライン
 * `<svg>` はCSPが制御する「読み込み」に当たらずそのまま描画できるため、これで代える。
 * `currentColor` を使い、通常時／トグルON時のボタン文字色（`chatStyles.ts`の
 * `button`・`button.toggled`）にそのまま追従させる。押した後の挙動はどれも変えない。
 */
const COMPOSER_ICONS = {
  attach:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.1" fill="currentColor" stroke="none"/><path d="M2 12l4-4 3 3 2-2 4 4"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor"/></svg>',
  loop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12.7 4.6A5.5 5.5 0 1 0 13.6 9.2"/><path d="M9.6 2.1l3.3.4-.4 3.3"/></svg>',
  compact:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5l4 4M2.5 2.5v3.3M2.5 2.5h3.3"/><path d="M13.5 13.5l-4-4M13.5 13.5v-3.3M13.5 13.5h-3.3"/></svg>',
  import:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v7M5 6.3l3 2.7 3-2.7"/><path d="M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>',
  recap:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3 4h10M3 8h10M3 12h6"/></svg>',
  plan: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2.5" width="10" height="11.5" rx="1"/><path d="M6 1.5h4v1.6H6z" fill="currentColor" stroke="none"/><path d="M5.5 7.2l1.3 1.3L9.6 5.7M5.5 10.8h5"/></svg>',
  fast: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M8.6 1.3 3 9h4l-.9 5.7L13 7H9z" fill="currentColor"/></svg>',
  review:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6.8" cy="6.8" r="4.3"/><path d="M10.1 10.1 14 14"/></svg>',
  export:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9V2M5.3 4.7 8 2l2.7 2.7"/><path d="M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>',
  workflow:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.2" r="1.9"/><circle cx="3.6" cy="12.8" r="1.9"/><circle cx="12.4" cy="12.8" r="1.9"/><path d="M7.2 4.9 4.4 11.1M8.8 4.9l2.8 6.2"/></svg>',
} as const satisfies Record<string, string>;

/** Claude Code画面の既定のインポートボタン文言（`showImport: true` のときに使う）。 */
const DEFAULT_IMPORT_BUTTON_COPY = {
  ariaLabel: 'インポート',
  title: 'Codex／Geminiの設定をClaude Codeへ取り込む準備をします',
} as const;

export function renderShell(webview: vscode.Webview, options: ChatShellOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce);
  const showImportButton = options.showImport === true || typeof options.showImport === 'object';
  const importCopy =
    typeof options.showImport === 'object' ? options.showImport : DEFAULT_IMPORT_BUTTON_COPY;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${chatStyles()}
</style>
</head>
<body>
  <div id="log"></div>
  <div id="approvals"></div>
  <div id="prompts"></div>
  <div id="queue" hidden>
    <div class="head">
      <span id="queueLabel"></span>
      <button id="flushQueue" type="button" class="secondary">今すぐ送る</button>
    </div>
    <ol id="queueList"></ol>
  </div>
  <div id="status"></div>
  <div id="todos" hidden>
    <div class="head">TODO一覧</div>
    <ul id="todosList"></ul>
  </div>
  <div id="backgroundTerminals" hidden>
    <div class="head">バックグラウンドで実行中</div>
    <ul id="backgroundTerminalsList"></ul>
  </div>
  <div id="loopBar" hidden>
    <span id="loopProgress"></span>
    <button id="loopStop" type="button" class="secondary" hidden>ループ停止</button>
  </div>
  <div id="attachments" hidden></div>
  <div id="argumentHint" hidden></div>
  <div id="inputModeHint" hidden></div>
  <div id="composer">
    <div id="commands" hidden></div>
    <div id="composerInputRow">
      <textarea id="input" placeholder="${options.agentLabel}への指示を入力（Ctrl+Enterで送信、画像はCtrl+Vで貼り付け）"></textarea>
      <button id="send" type="button">送信</button>
      <button id="stop" type="button" class="secondary" aria-label="中断" title="Escでも中断できます" hidden>${COMPOSER_ICONS.stop}</button>
    </div>
    <div id="composerIconRow">
      <input id="filePicker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      <button id="attach" type="button" class="secondary" aria-label="画像" title="画像を選んで添えます。貼り付け（Ctrl+V）とドラッグ&amp;ドロップもできます">${COMPOSER_ICONS.attach}</button>
      <button id="loopToggle" type="button" class="secondary" aria-label="ループ" title="同じ指示を条件成立まで繰り返します">${COMPOSER_ICONS.loop}</button>
      <button id="compact" type="button" class="secondary" aria-label="圧縮" title="これまでの会話を要約に置き換えてコンテキストを空けます">${COMPOSER_ICONS.compact}</button>
      <button id="claudeImport" type="button" class="secondary" aria-label="${escapeHtml(importCopy.ariaLabel)}" title="${escapeHtml(importCopy.title)}"${showImportButton ? '' : ' hidden'}>${COMPOSER_ICONS.import}</button>
      <button id="recap" type="button" class="secondary" aria-label="要約" title="会話の1行要約をいま作ります（要約は会話に残ります）"${options.showRecap === true ? '' : ' hidden'}>${COMPOSER_ICONS.recap}</button>
      <button id="planToggle" type="button" class="secondary" aria-pressed="false" aria-label="計画" title="読み取りだけに絞って計画を立てさせます。ファイルは変更されません">${COMPOSER_ICONS.plan}</button>
      <button id="fastToggle" type="button" class="secondary" aria-pressed="false" aria-label="高速" title="応答を速くします（Fast mode）" hidden>${COMPOSER_ICONS.fast}</button>
      <button id="review" type="button" class="secondary" aria-label="レビュー" title="コードレビューを実行します"${options.review.mode === 'command' ? ' hidden' : ''}>${COMPOSER_ICONS.review}</button>
      <button id="exportTranscript" type="button" class="secondary" aria-label="エクスポート" title="会話全体をMarkdownとして取り出します（コピー・ファイル保存・生テキスト表示）">${COMPOSER_ICONS.export}</button>
      <button id="workflowMenu" type="button" class="secondary" aria-label="ワークフロー" title="ワークフロー（複数タスクの並列実行）の実行・View・生成・停止を選びます">${COMPOSER_ICONS.workflow}</button>
    </div>
  </div>
  <div id="loop" hidden>
    <label>初回指示（空なら継続指示から始めます）
      <textarea id="loopInitial" placeholder="例: 第1話を執筆してください"></textarea>
    </label>
    <label>継続指示（2回目以降に繰り返します）
      <textarea id="loopContinue" placeholder="例: 次へ"></textarea>
    </label>
    <div class="line">
      <label>最大回数
        <input id="loopMax" type="number" min="1" max="200" value="20">
      </label>
      <label class="grow">終了条件（空なら回数だけで終わります）
        <input id="loopCondition" type="text" placeholder="例: 20話の執筆が完了している">
      </label>
      <button id="loopStart" type="button">ループ開始</button>
    </div>
  </div>
  <div id="settings"${options.showSettings ? '' : ' hidden'}>
    <label>モデル <select id="model"></select></label>
    <label>Effort <select id="reasoningEffort"></select></label>
    <label>承認 <select id="approvalMode">
      <option value="">既定</option>
      ${options.approvalModes.map((m) => `<option value="${m}">${m}</option>`).join('')}
    </select></label>
    ${
      options.sandboxModes === undefined
        ? ''
        : `<label>Sandbox <select id="sandbox">
      <option value="">既定</option>
      ${options.sandboxModes.map((m) => `<option value="${m}">${m}</option>`).join('')}
    </select></label>`
    }
    ${
      options.showAgentSelector === true
        ? '<label>エージェント <select id="agent"></select></label>'
        : ''
    }
    ${
      options.showAutocompact === true
        ? `<label>自動圧縮 <input id="autocompactInput" type="text" placeholder="autoまたは100k~1M" title="空欄のまま「自動圧縮」を押すと現在値を確認します。'auto'または100k~1Mトークンの数値（例: 500k, 200000, 200）を入れると変更します"></label>
    <button id="autocompactApply" type="button" class="secondary" title="自動圧縮の窓サイズを確認・変更します（応答は会話に残ります）">自動圧縮</button>`
        : ''
    }
    ${
      options.showDebug === true
        ? `<button id="openDebugLog" type="button" class="secondary" title="このセッションのCLIデバッグログ（~/.claude/debug/配下）をエディタで開きます。CLIへは何も送らず、課金もありません">デバッグログを開く</button>
    <button id="sendDebugCommand" type="button" class="secondary" title="/debugを送り、実モデルにログを読ませて診断させます。実測ではモデルが動き課金されます（送信前に確認します）">/debugで診断</button>`
        : ''
    }
    ${options.settingsNote === undefined ? '' : `<p class="note">${escapeHtml(options.settingsNote)}</p>`}
  </div>

<script nonce="${nonce}">
${chatScript(options.agentLabel, options.review, options.showRewind === true, options.approvalCycle ?? [], options.showInputModeHints === true)}
</script>
</body>
</html>`;
}
