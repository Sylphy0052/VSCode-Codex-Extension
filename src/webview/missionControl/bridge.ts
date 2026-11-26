import type {
  McApprovalDetail,
  McAttachment,
  McControlAction,
  McHandoffDetail,
  McHandoffListing,
  McHandoffQuery,
  McHistoryItem,
  McHostMessage,
  McIssueListing,
  McIssueStartRequest,
  McLaunchChoices,
  McLaunchRepo,
  McLaunchRequest,
  McLifecycleOp,
  McLifecycleOutcome,
  McProvider,
  McFilterSpec,
  McPrefKey,
  McQueuedMessage,
  McRunOp,
  McRunTaskOp,
  McSessionSettings,
  McSideQuestion,
  McSlashCommand,
  McSnapshot,
  McTarget,
  McTurn,
} from './protocol';

/** webviewの`acquireVsCodeApi()`が返すもの（使う分だけ）。 */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface ControlResult {
  ok: boolean;
  error?: string | undefined;
  approvals?: McApprovalDetail[] | undefined;
  turns?: McTurn[] | undefined;
  /** `turns`の先頭が会話の何件目か（0始まり）と会話全体の件数（Issue #2157）。古い版は返さない。 */
  turnStart?: number | undefined;
  turnTotal?: number | undefined;
  handoff?: McHandoffDetail | undefined;
  sideQuestion?: McSideQuestion | undefined;
  files?: string[] | undefined;
  commands?: McSlashCommand[] | undefined;
  queued?: McQueuedMessage[] | undefined;
  settings?: McSessionSettings | undefined;
  /** `rewindPreview`の応答（Issue #2160）。 */
  rewindFiles?: string[] | undefined;
}

/** `launchOptions`・`pickFolder`・`launch`の応答（Issue #2137）。 */
export interface ReplyResult {
  ok: boolean;
  error?: string | undefined;
  repos?: McLaunchRepo[] | undefined;
  repo?: McLaunchRepo | undefined;
  cwd?: string | undefined;
  choices?: McLaunchChoices | undefined;
  outcomes?: McLifecycleOutcome[] | undefined;
  history?: McHistoryItem[] | undefined;
  handoffs?: McHandoffListing | undefined;
  issues?: McIssueListing | undefined;
  message?: string | undefined;
  attachments?: McAttachment[] | undefined;
  paths?: string[] | undefined;
}

/** ライブtailで届いた直近のやり取り。 */
export interface LiveTurns {
  target: McTarget;
  ok: boolean;
  error?: string | undefined;
  turns?: McTurn[] | undefined;
  turnStart?: number | undefined;
  turnTotal?: number | undefined;
}

export interface Bridge {
  request(target: McTarget, action: McControlAction): Promise<ControlResult>;
  /** 起動先の候補を取り寄せる。 */
  launchOptions(): Promise<ReplyResult>;
  /** フォルダ選択のダイアログを出させる。 */
  pickFolder(): Promise<ReplyResult>;
  launch(request: McLaunchRequest): Promise<ReplyResult>;
  /** 閉じる・archive・delete（Issue #2149の1）。確認は拡張ホストが出す。 */
  lifecycle(op: McLifecycleOp, targets: readonly McTarget[]): Promise<ReplyResult>;
  /** 履歴（archive済みを含む）を取り寄せる。 */
  history(): Promise<ReplyResult>;
  /** 履歴の1件を開き直す。 */
  historyOpen(provider: McProvider, threadId: string): Promise<ReplyResult>;
  /** handoff台帳を絞り込んで取り寄せる（Issue #2178）。 */
  handoffLedger(query: McHandoffQuery): Promise<ReplyResult>;
  /** handoff本文をエディタで開かせる。 */
  handoffOpen(name: string): Promise<ReplyResult>;
  /** レビュー待ちの1ファイルをdiffエディタで開かせる（Issue #2138の1）。 */
  openDiff(target: McTarget, path: string): Promise<ReplyResult>;
  /** レビュー待ちを「確認済み」にする。 */
  reviewAck(target: McTarget): Promise<ReplyResult>;
  /** 再開待ちの会話を開き直す（Issue #2138の3）。 */
  resume(target: McTarget): Promise<ReplyResult>;
  /** 再開待ちを一覧から外す。 */
  resumeDismiss(target: McTarget): Promise<ReplyResult>;
  /** ウィンドウのReloadを頼む。確認は拡張ホストが出す。 */
  reloadWindow(): Promise<ReplyResult>;
  /** セッションid（`send_message`の宛先）をクリップボードへコピーさせる。 */
  copyRef(target: McTarget): Promise<ReplyResult>;
  /** 添付するファイルを選ばせる（Issue #2158）。`cwd`はダイアログの初期位置。 */
  pickAttachments(cwd: string | undefined): Promise<ReplyResult>;
  /** runへの操作（Issue #2150）。 */
  runOp(op: McRunOp, runId: string): Promise<ReplyResult>;
  runParallel(runId: string, maxParallel: number): Promise<ReplyResult>;
  runStart(): Promise<ReplyResult>;
  issueList(folder: string): Promise<ReplyResult>;
  issueStart(request: McIssueStartRequest): Promise<ReplyResult>;
  /**
   * 許可リストの拡張コマンドを実行させる（Issue #2161）。送るのはidだけ。`target`は
   * 選択中のセッションのproviderを渡すコマンドにだけ付ける。
   */
  runCommand(command: string, target?: McTarget): Promise<ReplyResult>;
  /** runのタスク1件への操作（Issue #2162）。 */
  runTaskOp(op: McRunTaskOp, runId: string, taskId: string): Promise<ReplyResult>;
  /** MCの設定を1つ変える（Issue #2162）。 */
  setPref(key: McPrefKey, value: boolean | number): Promise<ReplyResult>;
  /** 絞り込みに名前を付けて保存する（Issue #2162）。 */
  saveFilter(name: string, filter: McFilterSpec): Promise<ReplyResult>;
  deleteFilter(name: string): Promise<ReplyResult>;
  /** ライブtailの対象を伝える。`undefined`で止める。 */
  watch(target: McTarget | undefined): void;
  onLiveTurns(listener: (live: LiveTurns) => void): () => void;
  onSnapshot(listener: (snapshot: McSnapshot) => void): () => void;
  /** 画面がメッセージを受けられるようになったことを知らせる。拡張ホストは最初の一覧を返す。 */
  ready(): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** `window`のうち使う分だけ。DOMの型に依らず単体テストから渡せるようにする。 */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** 応答が来ない操作を打ち切るまでの時間。拡張ホスト側は別ウィンドウ宛てを5秒で打ち切る。 */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * 拡張ホストが別ウィンドウ宛てを長く待つ操作（画像付きの送信・候補の取り寄せ。Issue #2158）の打ち切り。
 * 拡張ホスト側の上限（45秒）より長くとり、ホストの失敗の理由を先に受け取る。
 */
const LONG_REQUEST_TIMEOUT_MS = 60_000;
const LONG_ACTIONS: ReadonlySet<McControlAction['action']> = new Set([
  'sendWithAttachments',
  'fileCandidates',
  'commandCandidates',
  // 全承認の同意ダイアログを人が閉じるまで返らない（Issue #2159）
  'changeSetting',
  // 名前の保存・分岐・タブの作り直し・CLIへの巻き戻しの問い合わせ（Issue #2160）
  'rename',
  'fork',
  'clear',
  'rewindPreview',
  'rewind',
]);

function timeoutFor(action: McControlAction): number {
  return LONG_ACTIONS.has(action.action) ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

/**
 * `launchOptions`・`pickFolder`・`launch`の打ち切り。フォルダ選択のダイアログは人が閉じるまで
 * 返らず、worktreeの作成も時間がかかるため、操作より長く待つ。
 */
const REPLY_TIMEOUT_MS = 10 * 60_000;

/**
 * 拡張ホストとのやり取り。操作には通し番号（`seq`）を振り、`controlResult`の応答と結び付ける。
 * 拡張ホストから届くメッセージは`type`で振り分け、知らない形は捨てる。
 */
export function createBridge(api: VsCodeApi, target: MessageTarget): Bridge {
  let seq = 0;
  const waiting = new Map<number, (result: ControlResult) => void>();
  const replies = new Map<number, (result: ReplyResult) => void>();
  const listeners = new Set<(snapshot: McSnapshot) => void>();
  const liveListeners = new Set<(live: LiveTurns) => void>();
  const call = (message: Record<string, unknown>): Promise<ReplyResult> => {
    seq += 1;
    const id = seq;
    return new Promise<ReplyResult>((resolve) => {
      const timer = setTimeout(() => {
        if (replies.delete(id)) {
          resolve({ ok: false, error: '拡張機能から応答がありませんでした' });
        }
      }, REPLY_TIMEOUT_MS);
      replies.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      api.postMessage({ ...message, seq: id });
    });
  };
  target.addEventListener('message', (event) => {
    const message = event.data as McHostMessage | undefined;
    if (typeof message !== 'object' || message === null) {
      return;
    }
    if (message.type === 'snapshot') {
      for (const listener of listeners) {
        listener(message.snapshot);
      }
      return;
    }
    if (message.type === 'reply') {
      const resolve = replies.get(message.seq);
      if (resolve !== undefined) {
        replies.delete(message.seq);
        resolve({
          ok: message.ok,
          error: message.error,
          repos: message.repos,
          repo: message.repo,
          cwd: message.cwd,
          choices: message.choices,
          outcomes: message.outcomes,
          history: message.history,
          handoffs: message.handoffs,
          issues: message.issues,
          message: message.message,
          attachments: message.attachments,
          paths: message.paths,
        });
      }
      return;
    }
    if (message.type === 'liveTurns') {
      for (const listener of liveListeners) {
        listener({
          target: message.target,
          ok: message.ok,
          error: message.error,
          turns: message.turns,
          turnStart: message.turnStart,
          turnTotal: message.turnTotal,
        });
      }
      return;
    }
    if (message.type === 'controlResult') {
      const resolve = waiting.get(message.seq);
      if (resolve !== undefined) {
        waiting.delete(message.seq);
        resolve({
          ok: message.ok,
          error: message.error,
          approvals: message.approvals,
          turns: message.turns,
          turnStart: message.turnStart,
          turnTotal: message.turnTotal,
          handoff: message.handoff,
          sideQuestion: message.sideQuestion,
          files: message.files,
          commands: message.commands,
          queued: message.queued,
          settings: message.settings,
          rewindFiles: message.rewindFiles,
        });
      }
    }
  });
  return {
    request(to, action) {
      seq += 1;
      const id = seq;
      return new Promise<ControlResult>((resolve) => {
        const timer = setTimeout(() => {
          if (waiting.delete(id)) {
            resolve({ ok: false, error: '拡張機能から応答がありませんでした' });
          }
        }, timeoutFor(action));
        waiting.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        // 宛先は3つの値だけを載せる（Inboxの項目をそのまま渡されても、余計な値を送らない）
        api.postMessage({
          type: 'control',
          seq: id,
          windowId: to.windowId,
          provider: to.provider,
          threadId: to.threadId,
          ...action,
        });
      });
    },
    launchOptions: () => call({ type: 'launchOptions' }),
    pickFolder: () => call({ type: 'pickFolder' }),
    launch: (request) =>
      call({
        type: 'launch',
        cwd: request.cwd,
        provider: request.provider,
        prompt: request.prompt,
        worktree: request.worktree,
        model: request.model,
        effort: request.effort,
        approval: request.approval,
        preset: request.preset,
      }),
    lifecycle: (op, targets) => call({ type: 'lifecycle', op, targets: targets.map(targetOnly) }),
    history: () => call({ type: 'history' }),
    historyOpen: (provider, threadId) => call({ type: 'historyOpen', provider, threadId }),
    handoffLedger: (query) => call({ type: 'handoffLedger', query }),
    handoffOpen: (name) => call({ type: 'handoffOpen', name }),
    openDiff: (to, file) => call({ type: 'openDiff', ...targetOnly(to), path: file }),
    reviewAck: (to) => call({ type: 'reviewAck', ...targetOnly(to) }),
    resume: (to) => call({ type: 'resume', ...targetOnly(to) }),
    resumeDismiss: (to) => call({ type: 'resumeDismiss', ...targetOnly(to) }),
    reloadWindow: () => call({ type: 'reloadWindow' }),
    copyRef: (to) => call({ type: 'copyRef', ...targetOnly(to) }),
    pickAttachments: (cwd) => call({ type: 'pickAttachments', cwd }),
    runOp: (op, runId) => call({ type: 'runOp', op, runId }),
    runParallel: (runId, maxParallel) => call({ type: 'runParallel', runId, maxParallel }),
    runStart: () => call({ type: 'runStart' }),
    issueList: (folder) => call({ type: 'issueList', folder }),
    issueStart: (request) =>
      call({
        type: 'issueStart',
        folder: request.folder,
        engine: request.engine,
        roadmapIssueNumbers: request.roadmapIssueNumbers,
        issueNumbers: request.issueNumbers,
      }),
    runCommand: (command, to) =>
      call(
        to === undefined
          ? { type: 'runCommand', command }
          : { type: 'runCommand', command, ...targetOnly(to) },
      ),
    runTaskOp: (op, runId, taskId) => call({ type: 'runTaskOp', op, runId, taskId }),
    setPref: (key, value) => call({ type: 'setPref', key, value }),
    saveFilter: (name, filter) => call({ type: 'saveFilter', name, filter }),
    deleteFilter: (name) => call({ type: 'deleteFilter', name }),
    watch(target) {
      api.postMessage({
        type: 'watch',
        target:
          target === undefined
            ? undefined
            : { windowId: target.windowId, provider: target.provider, threadId: target.threadId },
      });
    },
    onLiveTurns(listener) {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    onSnapshot(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: () => api.postMessage({ type: 'ready' }),
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
  };
}

/** 宛先の3つの値だけを取り出す（行の項目をそのまま渡されても、余計な値を送らない）。 */
function targetOnly(target: McTarget): McTarget {
  return { windowId: target.windowId, provider: target.provider, threadId: target.threadId };
}
