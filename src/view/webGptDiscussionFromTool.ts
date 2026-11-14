import * as vscode from 'vscode';

import type {
  WebGptDiscussionToolArgs,
  WebGptDiscussionToolResult,
} from '../orchestrator/messaging';

import {
  prepareWebGptDiscussion,
  reportDiscussionError,
  validateWebGptDiscussionInitial,
  type PrepareWebGptDiscussionOptions,
} from './webGptDiscussionCommand';

/**
 * エージェントのツール呼び出し（`start_webgpt_discussion`）からWebGPTとの議論を始める
 * （Issue #2051）。Codex・Claude Codeのビューで共通の部分。
 *
 * 流れ: 初期値を検証 → 既存の入力欄で利用者が確認 → 受け付けてツールへ返す →
 * 起動元のターンが終わり送信待ちが無くなったら、ビューの開始処理（`discussWithWebGptIn`）を
 * 入力済みの値で実行する。
 *
 * 受け付けてから開始するまでの扱い:
 * - 会話を閉じたら破棄する。
 * - 利用者が停止した・別の発言を送った場合は破棄しない。送信待ちが空になってから始める
 *   （確認済みの依頼を黙って捨てない）。やめたいときは受付の通知の「取り消す」で取り消す。
 */

/**
 * 入力欄の確認を待つ上限。Codexのツール呼び出しの時間切れ（`tool_timeout_sec`）より短くし、
 * 時間切れの後に受け付けてしまう（エージェントは失敗と思っているのに議論が始まる）ことを防ぐ。
 */
export const WEB_GPT_TOOL_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Codexへ渡す、会話ごとのメッセージング用MCPのツール時間切れ（秒）。既定（60秒）のままだと
 * 利用者が入力欄を確認する前に時間切れになる。確認待ちの上限より長くする。
 */
export const SESSION_MESSAGING_TOOL_TIMEOUT_SEC = 15 * 60;

const TURN_END_REMINDER =
  'WebGPTとの議論を受け付けました。このターンをここで終えてください。ターンの終了後に拡張機能が議論の手順を送ります。';

export type PreparedWebGptDiscussion = NonNullable<
  Awaited<ReturnType<typeof prepareWebGptDiscussion>>
>;

/** ビューが提供する会話の操作。 */
export interface WebGptToolRequestHost<TPanel> {
  /** 入力欄の見出しに出す会話名。 */
  title(entry: TPanel): string;
  /** 会話がまだ開いているか（閉じたら予約を破棄する）。 */
  isOpen(entry: TPanel): boolean;
  /** 応答中でも送信待ちありでもないか。 */
  isIdle(entry: TPanel): boolean;
  /** この会話では受け付けられない理由（入力ロック中・三点メニューから準備中など）。 */
  unavailableReason(entry: TPanel): string | undefined;
  /** 状態が変わるたびに呼ばれるlistenerを登録し、解除する関数を返す。 */
  onStateChanged(entry: TPanel, listener: () => void): () => void;
  /** 入力済みの値で議論を開始する（三点メニューと同じ開始処理）。 */
  start(entry: TPanel, request: PreparedWebGptDiscussion): Promise<void>;
}

export class WebGptToolRequests<TPanel> {
  /**
   * 確認中または予約中の会話と、それを打ち切る関数。1会話につき1件だけ受け付ける。
   * 確認中は入力欄を閉じ、予約中は予約を破棄する。
   */
  private readonly inFlight = new Map<TPanel, () => void>();

  constructor(
    private readonly host: WebGptToolRequestHost<TPanel>,
    private readonly prepare: (
      useCurrentContext: boolean,
      options: PrepareWebGptDiscussionOptions,
    ) => Promise<PreparedWebGptDiscussion | undefined> = prepareWebGptDiscussion,
    private readonly confirmTimeoutMs = WEB_GPT_TOOL_CONFIRM_TIMEOUT_MS,
  ) {}

  /** この会話で予約中・確認中の依頼があるか。 */
  has(entry: TPanel): boolean {
    return this.inFlight.has(entry);
  }

  /** 会話を閉じたときに呼ぶ。確認中なら入力欄を閉じ、予約中なら破棄する。 */
  cancel(entry: TPanel): void {
    this.inFlight.get(entry)?.();
  }

  async request(
    entry: TPanel,
    args: WebGptDiscussionToolArgs,
  ): Promise<WebGptDiscussionToolResult> {
    if (this.inFlight.has(entry)) {
      return reject('この会話では既にWebGPTとの議論を確認中か、開始待ちです');
    }
    const unavailable = this.host.unavailableReason(entry);
    if (unavailable !== undefined) {
      return reject(unavailable);
    }
    const invalid = validateWebGptDiscussionInitial(args);
    if (invalid !== undefined) {
      return reject(invalid);
    }
    this.inFlight.set(entry, () => undefined);
    let accepted = false;
    try {
      const prepared = await this.confirm(entry, args);
      if (!prepared.ok) {
        return reject(prepared.reason);
      }
      if (!this.host.isOpen(entry)) {
        return reject('確認の間に会話が閉じられたため、開始しませんでした');
      }
      this.schedule(entry, prepared.value);
      accepted = true;
      return { accepted: true, reason: TURN_END_REMINDER };
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error));
    } finally {
      if (!accepted) {
        this.inFlight.delete(entry);
      }
    }
  }

  /** 既存の入力欄を初期値付きで開き、上限時間まで確認を待つ。 */
  private async confirm(
    entry: TPanel,
    args: WebGptDiscussionToolArgs,
  ): Promise<{ ok: true; value: PreparedWebGptDiscussion } | { ok: false; reason: string }> {
    const source = new vscode.CancellationTokenSource();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      source.cancel();
    }, this.confirmTimeoutMs);
    this.inFlight.set(entry, () => source.cancel());
    try {
      // 入力欄は1行で長い議題の全体が見えないため、先に依頼の全文をモーダルで見せる。
      // Chromeの起動・接続もこの同意の後にする
      // モーダルはAPIから閉じられないため、会話を閉じた・時間切れなら待たずに打ち切る
      const proceed = await raceCancellation(
        askToProceed(this.host.title(entry), args),
        source.token,
      );
      if (proceed && !source.token.isCancellationRequested) {
        const value = await this.prepare(true, {
          initial: args,
          token: source.token,
          requester: this.host.title(entry),
        });
        if (value !== undefined && !source.token.isCancellationRequested) {
          return { ok: true, value };
        }
      }
      let reason = '利用者が確認をキャンセルしたため、開始しませんでした';
      if (timedOut) {
        reason = `利用者の確認が${Math.round(this.confirmTimeoutMs / 60000)}分以内に済まなかったため、開始しませんでした`;
      } else if (source.token.isCancellationRequested) {
        reason = '確認の間に会話が閉じられたため、開始しませんでした';
      }
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
      source.dispose();
    }
  }

  /** 起動元のターンが終わり、送信待ちが無くなったら開始する。 */
  private schedule(entry: TPanel, request: PreparedWebGptDiscussion): void {
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      this.inFlight.delete(entry);
    };
    const tryStart = (): void => {
      if (done) return;
      if (!this.host.isOpen(entry)) {
        finish();
        return;
      }
      if (!this.host.isIdle(entry)) return;
      finish();
      // 受付から開始まで間が空くため、外部へ送る前提（信頼済みワークスペース）を確かめ直す
      if (!vscode.workspace.isTrusted) {
        reportDiscussionError(new Error('WebGPTとの議論には信頼済みワークスペースが必要です'));
        return;
      }
      this.host.start(entry, request).catch(reportDiscussionError);
    };
    this.inFlight.set(entry, finish);
    // 状態の通知の中で自動返信やループが次の送信を始めることがあるため、1ティック待って
    // その結果を見てから判定する
    unsubscribe = this.host.onStateChanged(entry, () => {
      setTimeout(tryStart, 0);
    });
    // ツールの結果を返す前にターンが既に終わっていた（接続が切れた等）場合に備えて1回見る
    setTimeout(tryStart, 0);
    void vscode.window
      .showInformationMessage(
        `WebGPTとの議論を受け付けました（${this.host.title(entry)}）。応答の終了後に開始します。`,
        '取り消す',
      )
      .then((choice) => {
        if (choice === '取り消す' && !done) {
          finish();
          void vscode.window.showInformationMessage('WebGPTとの議論の開始を取り消しました');
        }
      });
  }
}

/** `chatPanelToolRequestHost`が読む、両ビューの会話に共通の項目。 */
interface ToolRequestPanel {
  title: string;
  disposed: boolean;
  inputLock: boolean;
  session: { getState(): { busy: boolean; queued: readonly unknown[]; restore?: unknown } };
  stateListeners: Array<(state: never) => void>;
}

/**
 * Codex・Claude Codeの会話（`ChatPanel` / `ClaudePanel`）向けの`WebGptToolRequestHost`を組む。
 * `isListed`は会話がまだビューの一覧にあるか、`preparing`は三点メニューから準備中の会話。
 */
export function chatPanelToolRequestHost<TPanel extends ToolRequestPanel>(deps: {
  isListed: (entry: TPanel) => boolean;
  preparing: ReadonlySet<TPanel>;
  inputLockedMessage: string;
  start: (entry: TPanel, request: PreparedWebGptDiscussion) => Promise<void>;
}): WebGptToolRequestHost<TPanel> {
  return {
    title: (entry) => entry.title,
    isOpen: (entry) => !entry.disposed && deps.isListed(entry),
    isIdle: (entry) => {
      const state = entry.session.getState();
      return !state.busy && state.queued.length === 0 && !state.restore;
    },
    unavailableReason: (entry) => {
      if (entry.inputLock) return deps.inputLockedMessage;
      if (deps.preparing.has(entry)) {
        return '利用者が三点メニューからWebGPTとの議論を準備中です';
      }
      return undefined;
    },
    onStateChanged: (entry, listener) => {
      const wrapped = (): void => listener();
      entry.stateListeners.push(wrapped);
      return () => {
        const index = entry.stateListeners.indexOf(wrapped);
        if (index >= 0) entry.stateListeners.splice(index, 1);
      };
    },
    start: deps.start,
  };
}

/**
 * エージェントからの依頼の全文をモーダルで見せ、続けるか尋ねる。入力欄（1行）では長い議題の
 * 後半が見えず、プロンプトインジェクションで紛れ込んだ内容を見落とすため。
 */
async function askToProceed(requester: string, args: WebGptDiscussionToolArgs): Promise<boolean> {
  const topic =
    args.topic === undefined || args.topic.trim() === ''
      ? '（指定なし: 現在の会話から論点を選ぶ）'
      : args.topic;
  const urls =
    args.urls === undefined || args.urls.length === 0 ? '（新規会話）' : args.urls.join('\n');
  const maxSends = args.maxSends === undefined ? '（既定）' : `${args.maxSends}回`;
  const proceed = 'Chromeへ接続して入力欄で確認する';
  const choice = await vscode.window.showWarningMessage(
    `エージェント（${requester}）がWebGPT（ChatGPT）との議論の開始を求めています`,
    {
      modal: true,
      detail:
        '議論ではこの議題と議論中の回答・批評をChatGPTへ送ります。続けると入力欄で内容を確認・修正できます。\n\n' +
        `議題:\n${topic}\n\n会話URL:\n${urls}\n\n送信上限: ${maxSends}`,
    },
    proceed,
  );
  return choice === proceed;
}

/** `promise`と打ち切りを競わせ、打ち切られたら`false`を返す。 */
function raceCancellation(
  promise: Promise<boolean>,
  token: vscode.CancellationToken,
): Promise<boolean> {
  if (token.isCancellationRequested) return Promise.resolve(false);
  return new Promise((resolve) => {
    const listener = token.onCancellationRequested(() => {
      listener.dispose();
      resolve(false);
    });
    promise.then(
      (value) => {
        listener.dispose();
        resolve(value);
      },
      () => {
        listener.dispose();
        resolve(false);
      },
    );
  });
}

function reject(reason: string): WebGptDiscussionToolResult {
  return { accepted: false, reason };
}
