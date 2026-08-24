import * as vscode from 'vscode';
import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, PendingApproval } from '../appserver/chatState';
import { readNotificationsConfig } from '../config';
import type { LoopController } from '../loop/loopController';
import type { ApprovalOutcome } from '../orchestrator/taskSession';
import { nextActivePanelSequence, type ActiveComposerTarget } from './activePanelSequence';
import {
  deriveSessionActivityState,
  sanitizeForNotification,
  type SessionActivityState,
} from './sessionActivity';

/**
 * `ChatSession`（chatView.ts）と`ClaudeStreamSession`（claudeChatView.ts）が
 * 共に持つ、この基底クラスが実際に使う最小の口（issue #410）。
 *
 * 両クラスは構造的にこれを満たすため、`ChatPanel.session` / `ClaudePanel.session`は
 * 追加のラップ無しでそのまま代入できる。
 */
export interface ChatSessionLike {
  readonly threadId: string | undefined;
  getState(): ChatState;
  dispose(): void;
  decide(requestId: number | string, decision: ApprovalDecision): void;
}

/**
 * `ChatViewManager`（chatView.ts）と`ClaudeChatViewManager`（claudeChatView.ts）が
 * 共に持つパネルエントリの最小集合（issue #410）。両ファイルの`ChatPanel`/`ClaudePanel`は
 * これを含む形で拡張して定義する。
 *
 * 各フィールドの詳しい説明は、issue #420で`ChatPanel`/`ClaudePanel`側の重複宣言を
 * 消したときにここへ移設したもの（元は両サブクラスがほぼ同文のJSDocを重複して持っていた）。
 */
export interface BaseChatPanel {
  /**
   * 今そのタブが開いているか。`undefined` はタブが閉じられている状態を表す。
   *
   * タスク管理下のセッション（`taskManaged: true`）は、タブを閉じてもこのエントリ自体は
   * `panels` に残り続ける（design.md §16.10「セッションの寿命をパネルから切り離す」）。
   * `reveal()` / `open()` はこの値が `undefined` ならパネルを作り直す。
   */
  panel: vscode.WebviewPanel | undefined;
  session: ChatSessionLike;
  /** この画面で走らせているループ。走っていなければ待機状態のまま。 */
  loop: LoopController;
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
   * オーケストレータが指定したタブ名（Issue #599）。`openTaskSession`が
   * `buildSessionPanelTitle`で組み立てた値をそのまま持ち、**CLI側の要約名より優先する**
   * （`deriveTitle`の第2引数）。人が手で開いた画面では`undefined`。
   *
   * **`ChatState`ではなくここに持つ。**`ChatState`はapp-serverからの通知でまるごと
   * 組み替わる状態で、そこへ置くと「`thread/name/updated`はこの値を触らない」という
   * 禁止を規約で守ることになる。`ChatPanel`にはapp-serverから触れる経路が無いため、
   * 同じことを構造で守れる。
   *
   * **揮発してよい。**リロード後、タスク管理下のスレッドは`restorePanel`が拾わず
   * （`isTaskManagedThread`）、`runner.ts`が`openTaskSession`で開き直すため
   * （design.md §16.10の7）、この値も同じ経路で再び渡る。
   */
  pinnedName: string | undefined;
  /**
   * タスク（オーケストレータ）管理下のセッションか。
   *
   * `true` の場合だけタブを閉じてもセッションを維持する（design.md §16.10の4）。
   * 人が手で開いた画面（`false`）は従来通りタブを閉じたらセッションも終わる。
   */
  taskManaged: boolean;
  /** `TaskSession.onApprovalResolved` のリスナー。 */
  approvalResolvedListeners: Array<(outcome: ApprovalOutcome) => void>;
  /**
   * 通知を出した承認要求の`requestId`（issue #286）。`String(requestId)`で持つ
   * （requestIdは`number | string`のどちらも来るため、Setのキーとして安定させる）。
   *
   * 一度でも通知の要否を判定した`requestId`はここへ積み、二度と判定し直さない
   * （タブの表示・非表示が何度切り替わっても、同じ承認要求で通知を重複させない）。
   * 「見えているか」は通知するかどうかを決めた**その瞬間**の`entry.panel?.visible`
   * だけを見る。後から可視性が変わっても、既に判定済みの要求を再評価しない
   * （`notifyNewApprovals`参照）。
   */
  notifiedApprovalRequestIds: Set<string>;
  /** 状態送信の間引き（issue #246）。予約中のタイマー。 */
  postTimer?: ReturnType<typeof setTimeout> | undefined;
}

/** 状態が変わったことの通知の中身（issue #721）。 */
export interface ChatStateChange {
  threadId: string;
  state: ChatState;
}

/**
 * 進捗画面を開く対象（issue #721）。`activeSequence`はプロバイダをまたいで
 * 「どちらのタブがより最近アクティブだったか」を比べるためだけに使う
 * （`ActiveComposerTarget`と同じ流儀）。
 */
export interface ProgressTarget {
  threadId: string;
  title: string;
  activeSequence: number;
}

/**
 * `ChatViewManager`（Codex、chatView.ts）と`ClaudeChatViewManager`（Claude Code、
 * claudeChatView.ts）の重複を抽出した基底クラス（issue #410）。
 *
 * パネルのライフサイクル管理（表示・アタッチ・破棄）と、承認待ち・ターン完了の通知判定を
 * ここへ集める。`handleMessage`の分岐、`onSessionChange`の中身、`buildTaskSession`、
 * 各種`open*`メソッドはプロバイダごとに大きく異なるため（design.md §16.10）、
 * 引き続き各サブクラスに残す。
 *
 * 挙動差の扱い（自己レビュー、issue #410の指示）:
 * - Codex（`ChatViewManager`）は`AppServerConnection`を全スレッドで共有するため、
 *   接続断（`handleConnectionLost`）と`pendingStarts`（`thread/start`応答待ち）を持つ。
 *   Claude Code（`ClaudeStreamSession`）はセッションごとに別プロセスで、この概念が無い。
 *   この非対称は実装のズレではなく、プロバイダのアーキテクチャそのものの違いなので
 *   基底クラスへは引き上げず、`allPanels()`のオーバーライドと`onTeardown`/`onDispose`
 *   フックだけをCodex側に残す
 * - `settings`はCodex・Claude Codeどちらも`flushState`が毎回載せて送る（issue #420で
 *   揃えた。以前はClaude Code側だけ`refreshSettings`という別経路でしか設定を送れず、
 *   `onLoopStatus`がその別経路を呼ぶことで間引きを迂回していた問題があった）。
 *   残る違いは`refreshSettings`（Claude Codeのみ）が、設定パネルでの変更など人の操作へ
 *   即座に反映したい場面で`postState`の間引きを迂回して即時送信する点だけ。会話項目は
 *   全量を送るが`items`キーを付けないため、webview側の差し分の積み先
 *   （`chatScript.ts`の`mergedItems`）には影響しない（`entry.sentItems`を書き換えては
 *   ならない理由も同じ。`claudeChatView.ts`の`refreshSettings`のJSDoc参照）
 */
export abstract class BaseChatViewManager<TPanel extends BaseChatPanel>
  implements vscode.Disposable
{
  protected readonly panels = new Map<string, TPanel>();
  /** 名前変更・クリア・エディタ選択範囲挿入の対象。最後にアクティブだった画面。 */
  protected active: TPanel | undefined;
  /**
   * `active` が（再）設定されるたびに進む採番（issue #292）。プロバイダをまたいだ比較に
   * 使う（`getActiveComposerTarget` 参照）。
   */
  protected activeSequence = 0;

  /**
   * 状態が変わったことの通知（issue #721）。進捗画面がこれを購読して描き直す。
   *
   * 発火するのは各サブクラスの`postState`（間引き済みの経路）からで、webviewへ送るのと
   * 同じ頻度になる。生の状態変化ごとに投げると、応答中は毎デルタで発火してしまう。
   */
  protected readonly stateChanged = new vscode.EventEmitter<ChatStateChange>();
  readonly onDidChangeState = this.stateChanged.event;
  private readonly panelsChanged = new vscode.EventEmitter<void>();
  /**
   * 開いているセッションの集合が変わった（issue #734）。
   *
   * `teardown`は`onDidChangeState`を出さない（`entry.disposed`を先に立ててから
   * `session.dispose()`で保留中の承認を解放するため、`onSessionChange`が
   * `entry.disposed`の早期returnで止まる）。承認待ちのままタブを閉じた分を
   * 数え直す契機が他に無いので、集合の変化として別に出す。
   */
  readonly onDidChangePanels = this.panelsChanged.event;

  /**
   * 進捗画面（issue #721）が開く対象。表に出ているチャットが無い・スレッドがまだ
   * 始まっていない（`thread/start`の応答待ち）ときは`undefined`。
   */
  getActiveProgressTarget(): ProgressTarget | undefined {
    const entry = this.active;
    if (entry === undefined || entry.disposed) {
      return undefined;
    }
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      return undefined;
    }
    return { threadId, title: entry.title, activeSequence: this.activeSequence };
  }

  /**
   * 指定したスレッドの現在の状態（issue #721）。進捗画面が開いた直後の初期表示に使う。
   * 既に閉じられているスレッドでは`undefined`。
   */
  getChatState(threadId: string): ChatState | undefined {
    const entry = this.panels.get(threadId);
    return entry === undefined || entry.disposed ? undefined : entry.session.getState();
  }

  /** サブクラスの`postState`から呼ぶ。webviewへ送るのと同じ内容を進捗画面へも配る。 */
  protected fireStateChanged(entry: TPanel, state: ChatState): void {
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      return;
    }
    this.stateChanged.fire({ threadId, state });
  }

  /**
   * 開いている（開始待ちも含む）全パネル。既定は`panels`の値のみ。Codex側は
   * `pendingStarts`（`thread/start`応答待ち）も含めてオーバーライドする。
   */
  protected allPanels(): TPanel[] {
    return [...this.panels.values()];
  }

  /** 実際のwebviewパネルを新規作成する。viewTypeとパネルオプションはプロバイダごとに異なる。 */
  protected abstract createWebviewPanel(entry: TPanel, preserveFocus: boolean): vscode.WebviewPanel;

  /** webviewへ渡すHTML本体を組み立てる。`renderShell`へ渡すオプションはプロバイダごとに異なる。 */
  protected abstract renderPanelHtml(entry: TPanel, panel: vscode.WebviewPanel): string;

  /** webviewから届いたメッセージを実際に処理する（`handleMessage`）。 */
  protected abstract dispatchMessage(entry: TPanel, message: unknown): void;

  /**
   * パネルを表に出す。既にタブがあれば `reveal`、閉じていれば作り直す
   * （design.md §16.10の4「reveal()でパネルを作り直し、ChatStateから会話を描き直す」）。
   * 会話の再描画は、webview起動時の `ready` 通知への応答（`postState`）に任せる。
   */
  protected showPanel(entry: TPanel, preserveFocus: boolean): void {
    if (entry.disposed) {
      return;
    }
    if (entry.panel !== undefined) {
      entry.panel.reveal(undefined, preserveFocus);
      if (!preserveFocus) {
        this.active = entry;
        this.activeSequence = nextActivePanelSequence();
      }
      return;
    }
    const panel = this.createWebviewPanel(entry, preserveFocus);
    this.attachPanel(entry, panel);
  }

  /**
   * 実際のパネルへ表示を結び付け、イベントを配線する。
   *
   * `panel.webview.options`（`enableScripts`等）はここで入れ直すが、`enableFindWidget`
   * （design.md §14.48、issue #287）は`WebviewPanel.options`側の値で読み取り専用のため、
   * ここから再設定する手段が無い。`restorePanel`経由（タブ復元）で渡ってくるパネルは
   * VSCode本体が新規に構築したもので、`enableFindWidget`を含む`WebviewPanelOptions`は
   * 生成時にしか指定できない。
   */
  protected attachPanel(entry: TPanel, panel: vscode.WebviewPanel): void {
    entry.panel = panel;
    panel.title = entry.title;
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.renderPanelHtml(entry, panel);
    panel.webview.onDidReceiveMessage((message: unknown) => this.dispatchMessage(entry, message));
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = entry;
        this.activeSequence = nextActivePanelSequence();
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
      this.activeSequence = nextActivePanelSequence();
    }
  }

  /**
   * そのセッションの活動状態（issue #286、design.md §14.55）。
   *
   * 開いていなければ`undefined`（履歴ツリーの印に使う。タスク管理下のセッションは
   * タブを閉じても`panels`に残り続けるため、タブが閉じていても実行中のタスクは
   * `undefined`にならない）。
   */
  getActivityState(id: string): SessionActivityState | undefined {
    const entry = this.panels.get(id);
    return entry === undefined ? undefined : deriveSessionActivityState(entry.session.getState());
  }

  /**
   * 承認待ちのセッション（issue #734・#755）。バッジの件数とステータスバーから開く先の
   * 両方がこれを母数にする。
   *
   * 母数は`getActivityState`と同じ`panels`にする（`allPanels()`ではない）。
   * `allPanels()`が追加で含むCodex側の`pendingStarts`は`thread/start`の応答待ちで、
   * まだセッションが無く承認要求も出ないため、含めても結果は変わらないが、
   * 履歴ツリーの印（`getActivityState`）と母数がずれる分だけ食い違いの元になる。
   */
  approvalPendingSessions(): Array<{ threadId: string; title: string }> {
    const pending: Array<{ threadId: string; title: string }> = [];
    for (const [threadId, entry] of this.panels) {
      if (deriveSessionActivityState(entry.session.getState()) === 'approvalPending') {
        pending.push({ threadId, title: entry.title });
      }
    }
    return pending;
  }

  /**
   * 開いているセッションを表に出す（issue #755）。ステータスバーから承認待ちの画面へ
   * 戻るのに使う。既に閉じられていれば何もせず`false`を返す。
   *
   * タブを閉じたタスク管理下のセッション（`panel === undefined`）も対象で、
   * `showPanel`がパネルを作り直す（design.md §16.10の4）。
   */
  revealSession(threadId: string): boolean {
    const entry = this.panels.get(threadId);
    if (entry === undefined || entry.disposed) {
      return false;
    }
    this.showPanel(entry, false);
    return true;
  }

  /**
   * エディタの選択範囲（issue #292）を送る先。最後にアクティブだった画面を返す
   * （`this.active`。名前変更・クリアと同じ対象）。開いているタブが無ければ`undefined`。
   *
   * Codex/Claude Codeそれぞれの`activeSequence`を比べて、呼び出し側（`extension.ts`）が
   * どちらへ挿すかを決める。ここではプロバイダ内の判定だけを行い、実際の送り先の決定・
   * パスの組み立て・0件時の新規会話は行わない。
   */
  getActiveComposerTarget(): ActiveComposerTarget | undefined {
    const entry = this.active;
    if (entry === undefined || entry.panel === undefined) {
      return undefined;
    }
    return {
      activeSequence: this.activeSequence,
      insert: (text: string) => {
        if (entry.panel === undefined) {
          return;
        }
        void entry.panel.webview.postMessage({ type: 'insertComposerText', text });
        this.showPanel(entry, false);
      },
    };
  }

  /**
   * 承認要求を決定する。webviewの承認カード（`approve`メッセージ）とワークフローViewの
   * 「承認」操作（`TaskSession.decideApproval`）の両方から呼ばれる共通経路にしておくことで、
   * どちらの入口から決定しても `onApprovalResolved` のリスナーへ同じ通知が届く。
   */
  protected resolveApproval(
    entry: TPanel,
    requestId: number | string,
    decision: ApprovalDecision,
  ): void {
    entry.session.decide(requestId, decision);
    for (const listener of entry.approvalResolvedListeners) {
      listener({ requestId, decision });
    }
  }

  /**
   * 承認待ちの通知（issue #286、design.md §14.55）。
   *
   * `state.approvals`に新しく現れた要求ごとに1回だけ判定する。`entry.notifiedApprovalRequestIds`
   * へ積んだ要求は、設定で無効・タブが見えている等の理由で通知を出さなかった場合も含めて
   * 二度と判定し直さない（同じ要求で通知を重複させないため）。
   */
  protected notifyNewApprovals(entry: TPanel, state: ChatState): void {
    for (const approval of state.approvals) {
      const key = String(approval.requestId);
      if (entry.notifiedApprovalRequestIds.has(key)) {
        continue;
      }
      entry.notifiedApprovalRequestIds.add(key);
      this.notifyApprovalPending(entry, approval);
    }
  }

  /**
   * 承認待ちの通知を実際に出す。
   *
   * 「見えているか」は`WebviewPanel.visible`で判定する（`active`＝フォーカスが
   * 当たっているかとは別物。分割表示やSide-by-Sideで前面に見えていればフォーカスが
   * 無くても通知を出す必要は無い、という判断）。判定は呼び出された瞬間の一度きりで、
   * 後から可視性が変わっても再評価しない（`notifyNewApprovals`のJSDoc参照）。
   */
  protected notifyApprovalPending(entry: TPanel, approval: PendingApproval): void {
    if (!readNotificationsConfig().approvalPending) {
      return;
    }
    if (entry.panel !== undefined && entry.panel.visible) {
      return;
    }
    const sessionLabel = sanitizeForNotification(entry.title);
    const approvalLabel = sanitizeForNotification(approval.title);
    void vscode.window
      .showInformationMessage(`${sessionLabel} が承認待ちです（${approvalLabel}）`, '開く')
      .then((choice) => {
        if (choice === '開く') {
          this.showPanel(entry, false);
        }
      });
  }

  /**
   * ターン完了の通知（issue #286、design.md §14.55、既定オフ）。
   *
   * 承認待ちの通知と違い`requestId`のような一意な識別子が無いが、呼び出し元
   * （各サブクラスの`onSessionChange`）が`busy`の立ち下がり（`true→false`）を検知した
   * 1回だけ呼ぶ作りにより、同じターンで重複して呼ばれることは無い。
   */
  protected notifyTurnComplete(entry: TPanel): void {
    if (!readNotificationsConfig().turnComplete) {
      return;
    }
    if (entry.panel !== undefined && entry.panel.visible) {
      return;
    }
    const sessionLabel = sanitizeForNotification(entry.title);
    void vscode.window
      .showInformationMessage(`${sessionLabel} の応答が終わりました`, '開く')
      .then((choice) => {
        if (choice === '開く') {
          this.showPanel(entry, false);
        }
      });
  }

  /**
   * エントリを完全に破棄する。ループを止め、セッションを解放し（保留中の承認は拒否される）、
   * パネルが開いていれば閉じ、全ての管理表から取り除く。
   *
   * 二重に呼んでも安全（`disposed` で早期return）。タブを閉じたことによる破棄と、
   * 明示的な `dispose()` 呼び出しの両方から通る。
   *
   * `entry.disposed` を先に立ててから `session.dispose()` を呼ぶため、そこで解放される
   * 保留中の承認は `onSessionChange`（`entry.disposed` で早期return）に届かず、
   * `onDidChangeState` も出ない。承認待ちを数えている側（issue #734）が取り残されないよう、
   * 管理表から取り除いた後に `onDidChangePanels` を出す。
   */
  protected teardown(entry: TPanel): void {
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
    this.onTeardown(entry);
    for (const [id, value] of this.panels) {
      if (value === entry) {
        this.panels.delete(id);
      }
    }
    this.panelsChanged.fire();
  }

  /**
   * `teardown`の拡張フック。管理表からの削除の直前に呼ぶ。既定は何もしない。
   * Codex側は`pendingStarts`（`thread/start`応答待ち登録）からの除去に使う。
   */
  protected onTeardown(_entry: TPanel): void {
    // 既定では何もしない
  }

  dispose(): void {
    for (const entry of this.allPanels()) {
      this.teardown(entry);
    }
    this.panels.clear();
    this.stateChanged.dispose();
    this.panelsChanged.dispose();
    this.onDispose();
  }

  /**
   * `dispose()`の拡張フック。既定は何もしない。Codex側は全スレッドで共有する
   * `AppServerConnection`の解放に使う。
   */
  protected onDispose(): void {
    // 既定では何もしない
  }
}
