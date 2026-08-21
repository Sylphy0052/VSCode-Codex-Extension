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
 */
export interface BaseChatPanel {
  panel: vscode.WebviewPanel | undefined;
  session: ChatSessionLike;
  loop: LoopController;
  disposed: boolean;
  title: string;
  taskManaged: boolean;
  approvalResolvedListeners: Array<(outcome: ApprovalOutcome) => void>;
  notifiedApprovalRequestIds: Set<string>;
  postTimer?: ReturnType<typeof setTimeout> | undefined;
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
 * - Codexの`postState`/`flushState`は毎回`settings`を埋め込んで送るのに対し、
 *   Claude Codeは会話項目の差分だけを送る`postState`/`flushState`と、設定込みで
 *   会話項目を全量送り直す`refreshSettings`とを使い分けている。これは意図的な差異と
 *   判断した（Claude Codeは1プロセス1セッションで設定変更がターンをまたいで永続する
 *   ため、変更があった時だけ全量を送り直す構造の方が理にかなう）。片方へ寄せると
 *   Codexの「毎回settingsを見る」前提とClaude Codeの「変更時だけ送る」前提のどちらかを
 *   壊すため、統合しなかった
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
