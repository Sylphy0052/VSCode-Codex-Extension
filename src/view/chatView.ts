import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { defaultDenyResponse, type ApprovalDecision } from '../appserver/approvals';
import type { ChatItem, ChatState } from '../appserver/chatState';
import { ChatSession } from '../appserver/chatSession';
import { AppServerConnection, type ServerRequest } from '../appserver/connection';
import type { ActivityKind } from '../activity/record';
import { summarize } from '../codex/conversation';
import { readForkedThreadId } from '../codex/jsonRpc';
import { readSkillsList } from '../codex/skillsList';
import { readRateLimits, type UsageSnapshot } from '../codex/usage';
import { currentWorkspaceFolder, readConfig, workspaceFolderPaths } from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import { APPROVAL_MODES, SANDBOX_MODES } from '../codex/types';
import type { PromptSubmission } from '../appserver/prompts';
import { AttachmentBox } from '../provider/attachments';
import { buildImageReply } from '../provider/imageRefs';
import { CommandCatalog } from '../provider/commandCatalog';
import { FileMentionCatalog, filterFiles } from '../provider/fileMentions';
import {
  CODEX_PSEUDO_COMMANDS,
  routePseudoCommand,
  withPseudoCommands,
  type PseudoCommandCall,
} from '../provider/pseudoCommands';
import type { SlashCommand } from '../provider/slashCommands';
import { chatCsp } from './chatCsp';
import { chatScript } from './chatScript';
import { chatStyles } from './chatStyles';
import { readPersistedThreadId } from './panelState';
import { isEditableKey, type SettingsProvider } from './settingsProvider';

interface ChatPanel {
  panel: vscode.WebviewPanel;
  session: ChatSession;
  /** この画面で走らせているループ。走っていなければ待機状態のまま。 */
  loop: LoopController;
  /** 作業記録に載せるディレクトリ。resume時はセッション自身のcwd。 */
  cwd: string | undefined;
  /** 送信前の添付画像。送るまでここに溜める。 */
  attachments: AttachmentBox;
  /**
   * タブを閉じた後か。
   *
   * 保留中の承認を解放すると、その結果の通知が閉じたあとに届く。破棄済みのWebviewへ
   * 送るとVSCodeが例外を投げるため、ここで止める。
   */
  disposed: boolean;
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
 */
export class ChatViewManager implements vscode.Disposable {
  private readonly connection: AppServerConnection;
  /** threadIdが確定するまでは undefined キーで1件だけ保持する。 */
  private readonly panels = new Map<string, ChatPanel>();
  private pending: ChatPanel | undefined;
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
  ) {
    this.catalog = new CommandCatalog(this.fs);
    this.connection = new AppServerConnection(
      codexPath,
      log,
      (method, params) => this.routeNotification(method, params),
      (request) => this.routeServerRequest(request),
    );
  }

  /** そのスレッドの画面を開いているか。履歴の印に使う。 */
  isOpen(threadId: string): boolean {
    return this.panels.has(threadId);
  }

  /** 新しい会話を開く。 */
  async openNew(): Promise<void> {
    const folder = currentWorkspaceFolder();
    if (folder === undefined) {
      void vscode.window.showErrorMessage(
        'Codexを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
      );
      return;
    }

    const entry = this.createPanel('Codex', folder.uri.fsPath);
    this.pending = entry;
    try {
      const threadId = await entry.session.start(folder.uri.fsPath, readConfig().codex);
      this.pending = undefined;
      this.panels.set(threadId, entry);
    } catch (e) {
      this.pending = undefined;
      entry.panel.dispose();
      this.reportError(e);
    }
  }

  /** 既存のスレッドを開く。 */
  async openThread(threadId: string, title: string, cwd: string | undefined): Promise<void> {
    const existing = this.panels.get(threadId);
    if (existing !== undefined) {
      existing.panel.reveal();
      return;
    }

    const entry = this.createPanel(`Codex: ${title}`, cwd);
    this.panels.set(threadId, entry);
    try {
      await entry.session.resume(threadId, cwd);
    } catch (e) {
      this.panels.delete(threadId);
      entry.panel.dispose();
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

    // 復元されたパネルはcwdを保持していないため、このウィンドウのフォルダを充てる
    const entry = this.adopt(panel, currentWorkspaceFolder()?.uri.fsPath);
    this.panels.set(threadId, entry);
    try {
      await entry.session.resume(threadId, undefined);
    } catch (e) {
      this.panels.delete(threadId);
      panel.dispose();
      this.reportError(e);
    }
  }

  private createPanel(title: string, cwd: string | undefined): ChatPanel {
    const panel = vscode.window.createWebviewPanel('codex.chat', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    return this.adopt(panel, cwd);
  }

  private adopt(panel: vscode.WebviewPanel, cwd: string | undefined): ChatPanel {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = renderShell(panel.webview, {
      agentLabel: 'Codex',
      approvalModes: APPROVAL_MODES,
      sandboxModes: SANDBOX_MODES,
      showSettings: true,
    });

    let wasBusy = false;
    const session = new ChatSession(this.connection, this.log, (state) => {
      if (entry.disposed) {
        return;
      }
      // ターンが終わった瞬間に、待たせていた指示を1件送る
      const finished = wasBusy && !state.busy;
      wasBusy = state.busy;
      if (finished && state.queued.length > 0) {
        void session.sendNextQueued(readConfig().codex);
      }
      if (finished) {
        reportTurnResult(this.onActivity, entry.session.threadId, entry.cwd, state);
      }
      const title = deriveTitle(state);
      if (title !== undefined && panel.title !== title) {
        panel.title = title;
      }
      // ターンの完了を見て次の指示を送るため、描画より先にループへ渡す
      entry.loop.observe(state);
      this.postState(entry);
    });

    const loop = new LoopController(
      (text) => this.sendFromLoop(entry, text),
      () => this.postState(entry),
    );

    const entry: ChatPanel = {
      panel,
      session,
      loop,
      cwd,
      attachments: new AttachmentBox(),
      disposed: false,
    };
    this.active = entry;
    panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.handleMessage(entry, message),
    );
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = entry;
      }
    });
    panel.onDidDispose(() => {
      entry.disposed = true;
      loop.stop('manual');
      session.dispose();
      if (this.pending === entry) {
        this.pending = undefined;
      }
      if (this.active === entry) {
        this.active = undefined;
      }
      for (const [id, value] of this.panels) {
        if (value === entry) {
          this.panels.delete(id);
        }
      }
    });
    return entry;
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
          await entry.session.sendOrQueue(text, readConfig().codex, attachments);
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
        await postFileMentions(entry.panel, this.mentions, entry.cwd, m['query']);
        return;
      }
      if (type === 'requestImage') {
        await postImageData(entry.panel, this.fs, entry.session.getState().items, m['path']);
        return;
      }
      if (type === 'attach') {
        addAttachment(entry.attachments, m['name'], m['dataUrl']);
        this.postState(entry);
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
      if (type === 'planMode') {
        entry.loop.noteUserAction();
        entry.session.setPlanMode(m['on'] === true);
        return;
      }
      if (type === 'cancelQueued' && typeof m['index'] === 'number') {
        entry.session.cancelQueued(m['index']);
        return;
      }
      if (type === 'flushQueue') {
        // 待たせていた指示を先に通すため、ループは割り込みとして止める
        entry.loop.noteUserAction();
        await entry.session.flushQueue(readConfig().codex);
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
      if (type === 'approve' && typeof m['decision'] === 'string') {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          entry.session.decide(requestId, m['decision'] as ApprovalDecision);
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
      if (type === 'ready') {
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
    if (call.args !== '') {
      this.log.warn(`/${call.name} は引数を受け取らないため無視します: ${call.args}`);
    }
    if (call.action === 'compact') {
      if (!(await confirmCompact())) {
        return;
      }
      await entry.session.compact();
    }
  }

  /** 画面へ現在の状態を送る。設定とループの進行はここで一緒に載せる。 */
  private postState(entry: ChatPanel): void {
    if (entry.disposed) {
      return;
    }
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...entry.session.getState(),
        settings: this.settings.snapshot(),
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
      },
    });
  }

  /**
   * ループからの送信。失敗はループを止める理由になるため、報告したうえで投げ直す。
   */
  private async sendFromLoop(entry: ChatPanel, text: string): Promise<void> {
    try {
      await entry.session.send(text, readConfig().codex);
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

  /** 設定が外部で変わったときに、開いている全画面のプルダウンを更新する。 */
  /**
   * 入力欄の候補を送る。
   *
   * 一度読んだら使い回す。ファイル数は多くないが、画面を開くたびに走査する意味も無い。
   */
  private async postCommands(entry: ChatPanel): Promise<void> {
    if (entry.disposed) {
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
    const entries = [...this.panels.values()];
    if (this.pending !== undefined && !entries.includes(this.pending)) {
      entries.push(this.pending);
    }
    return entries;
  }

  private routeNotification(method: string, params: Record<string, unknown>): void {
    // account/rateLimits/updated のようなアカウント単位の通知は threadId を持たない。
    // スレッドで絞れないので開いている画面すべてへ配る。
    if (params['threadId'] === undefined) {
      for (const entry of this.panels.values()) {
        entry.session.applyNotification(method, params);
      }
      this.pending?.session.applyNotification(method, params);
      return;
    }

    const target = this.findByThreadId(params['threadId']);
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
    return target.session.requestApproval(request);
  }

  private findByThreadId(threadId: unknown): ChatPanel | undefined {
    if (typeof threadId === 'string' && this.panels.has(threadId)) {
      return this.panels.get(threadId);
    }
    // thread/start の応答が返る前に届く通知は、開始待ちの画面のもの
    return this.pending;
  }

  private reportError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log.error(`Codex画面: ${message}`);
    void vscode.window.showErrorMessage(`Codex: ${message}`);
  }

  dispose(): void {
    for (const entry of this.panels.values()) {
      entry.loop.stop('manual');
      entry.session.dispose();
      entry.panel.dispose();
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
   * サンドボックスの選択肢。渡さなければセレクタ自体を出さない。
   *
   * Claude Codeにサンドボックスの概念は無く、権限は `--permission-mode` に集約される。
   */
  sandboxModes?: readonly string[];
  /** モデル・effort・承認のプルダウンを出すか（Codex画面のみ）。 */
  showSettings: boolean;
  /**
   * 設定行の下に出す但し書き。
   *
   * 変更がいつから効くかはプロバイダで違う。書かないと「変えたのに効かない」に見える。
   */
  settingsNote?: string;
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

export function renderShell(webview: vscode.Webview, options: ChatShellOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce);

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
  <div id="loopBar" hidden>
    <span id="loopProgress"></span>
    <button id="loopStop" type="button" class="secondary" hidden>ループ停止</button>
  </div>
  <div id="attachments" hidden></div>
  <div id="composer">
    <div id="commands" hidden></div>
    <textarea id="input" placeholder="${options.agentLabel}への指示を入力（Ctrl+Enterで送信、画像はCtrl+Vで貼り付け）"></textarea>
    <input id="filePicker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
    <button id="attach" type="button" class="secondary" title="画像を選んで添えます。貼り付け（Ctrl+V）とドラッグ&amp;ドロップもできます">画像</button>
    <button id="send" type="button">送信</button>
    <button id="stop" type="button" class="secondary" title="Escでも中断できます" hidden>中断</button>
    <button id="loopToggle" type="button" class="secondary" title="同じ指示を条件成立まで繰り返します">ループ</button>
    <button id="compact" type="button" class="secondary" title="これまでの会話を要約に置き換えてコンテキストを空けます">圧縮</button>
    <button id="planToggle" type="button" class="secondary" aria-pressed="false" title="読み取りだけに絞って計画を立てさせます。ファイルは変更されません">計画</button>
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
    ${options.settingsNote === undefined ? '' : `<p class="note">${escapeHtml(options.settingsNote)}</p>`}
  </div>

<script nonce="${nonce}">
${chatScript(options.agentLabel)}
</script>
</body>
</html>`;
}
