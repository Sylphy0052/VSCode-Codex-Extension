import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import { formatSessionTarget } from '../orchestrator/sessionBridge';
import type {
  McHandoffListing,
  McHandoffQuery,
  McHistoryItem,
  McLaunchChoices,
  McLaunchRepo,
  McLaunchRequest,
  McLifecycleOp,
  McProvider,
  McSnapshot,
  McTarget,
  McUsageHistory,
  McWorkUnit,
} from '../webview/missionControl/protocol';
import { MISSION_CONTROL_STYLES } from '../webview/missionControl/styles';
import type { SessionControlResult } from './chatManagerBase';
import { parseLaunchRequest, type McLaunchResult } from './missionControlLaunch';
import { missionControlTitle } from './missionControlModel';
import {
  parseIssueStart,
  parseRunOp,
  parseRunParallel,
  parseRunTaskOp,
  pickFolder as pickRunFolder,
  type McRunsPort,
} from './missionControlRuns';
import { parseRunCommand } from './missionControlCommands';
import { applyDeleteFilter, applySaveFilter, parseSetPref } from './missionControlPrefs';
import type { McSettingsPort } from './missionControlSettings';
import {
  parseHandoffQuery,
  parseLifecycleRequest,
  ReadMarker,
  type McLifecycleRunResult,
} from './missionControlSessions';
import { MAX_TASK_RUN_PARALLEL } from '../orchestrator/taskRunState';
import { pickAttachmentFiles } from './missionControlAttachments';
import { parseAction, parseTarget, type SessionControl } from './sessionControlMessage';

export const MISSION_CONTROL_OPEN_COMMAND = 'agent.missionControl.open';
/** Mission Controlのタブを閉じる（Issue #2152の5。開いていなければ何もしない）。 */
export const MISSION_CONTROL_CLOSE_COMMAND = 'agent.missionControl.close';

/** webviewのbundle（`npm run build`が`src/webview/missionControl/main.tsx`から作る）。 */
const SCRIPT_PATH = ['dist', 'missionControl.js'] as const;

/**
 * スナップショットを送る間隔（旧統括ページと同じ流儀）。
 * 最初の1件はすぐ送り、以降は間隔ごとにまとめ、最後の1回は必ず送る。
 */
const POST_INTERVAL_MS = 250;

/** ライブtailで他ウィンドウのセッションの直近のやり取りを取り直す間隔（Issue #2137の3）。 */
export const LIVE_POLL_MS = 2_000;
/**
 * ライブtailで送る直近のやり取りの件数。
 *
 * webviewは届いた末尾の範囲を、読み足した古いやり取りへ位置で継ぎ足す（Issue #2157）。取り直しの
 * 間にこれより多く増えると範囲が離れて継ぎ足せず、末尾だけに戻るため、ツール呼び出しも数える
 * ようになった分だけ多めにとる。
 */
export const LIVE_TURNS = 20;

/** 状態を変えない取り寄せの操作（Issue #2158）。結果を返した後に一覧を組み直さない。 */
const READ_ONLY_CONTROL_KINDS: ReadonlySet<string> = new Set([
  'fileCandidates',
  'commandCandidates',
  'queuedMessages',
  'sessionSettings',
  // 巻き戻しで戻るファイルを確かめるだけ（Issue #2160）
  'rewindPreview',
]);

/** 新規セッションの起動（Issue #2137の1）。vscodeに依る部分は`extension.ts`が組む。 */
export interface McLaunchPort {
  options(): Promise<McLaunchRepo[]>;
  /** model・effort・承認方針・プリセットの候補と、repoごとの前回の選択（Issue #2149の2）。 */
  choices?(): Promise<McLaunchChoices>;
  /** フォルダ選択のダイアログを出す。選ばれなければ`undefined`。 */
  pickFolder(): Promise<McLaunchRepo | undefined>;
  launch(request: McLaunchRequest): Promise<McLaunchResult>;
}

/**
 * レビュー待ち・再開待ち・Reload（Issue #2138）。vscodeに依る部分は`extension.ts`が組む。
 * 失敗したときは理由の文を返し、成功なら`undefined`を返す。
 */
export interface McHostPort {
  openDiff(target: McTarget, file: string): Promise<string | undefined>;
  reviewAck(target: McTarget): string | undefined;
  resume(target: McTarget): Promise<string | undefined>;
  resumeDismiss(target: McTarget): string | undefined;
  reloadWindow(): Promise<string | undefined>;
  /** スナップショットを作るたびに呼ぶ（通知のまとめ）。`foreground`はMCが前面にあるか。 */
  observe?(snapshot: McSnapshot, foreground: boolean): void;
}

/**
 * セッションを閉じる・archive・deleteと履歴（Issue #2149の1・3）。vscodeに依る部分は
 * `extension.ts`が組む。
 */
export interface McSessionPort {
  /** 確認を出してから、宛先のウィンドウで実行する。確認で取りやめたら`cancelled`。 */
  lifecycle(op: McLifecycleOp, targets: readonly McTarget[]): Promise<McLifecycleRunResult>;
  /** archive済みを含む過去のセッション（新しい順）。 */
  history(): Promise<McHistoryItem[]>;
  /** 直前の`history`で、件数の上限により載せなかった古いセッションの数（Issue #2178）。 */
  historyOmitted?(): number;
  /** 履歴の1件をこのウィンドウで開き直す。失敗したら理由の文を返す。 */
  historyOpen(provider: McProvider, threadId: string): Promise<string | undefined>;
  /** handoff台帳を絞り込む（Issue #2178）。 */
  handoffLedger?(query: McHandoffQuery): Promise<McHandoffListing>;
  /** handoff本文をエディタで開く。失敗したら理由の文を返す。 */
  handoffOpen?(name: string): Promise<string | undefined>;
  /**
   * 作業履歴を作業単位にまとめたもの（Issue #2177）。`days`は直近何日分か（0なら保持期間の
   * 全部）。並べ替えはwebviewが行う。
   */
  workUnits?(days: number): Promise<McWorkUnit[]>;
}

/** 作業単位の集計で受け付ける日数の上限（保持期間の上限と同じ）。 */
const MAX_WORK_UNIT_DAYS = 3650;

/**
 * Mission Control（Issue #2136）のエディタタブ。
 *
 * 全ウィンドウのセッションと回答待ちの項目を1画面に出し、Inboxから答えさせる。宛先の解決
 * （自ウィンドウか、共有ディレクトリ経由で別ウィンドウか）は統括ページと同じ
 * `controlSessionAnywhere`（`extension.ts`）に任せる。
 */
export class MissionControlViewManager implements vscode.Disposable {
  static readonly viewType = 'agent.missionControl';
  private panel: vscode.WebviewPanel | undefined;
  private readonly panelDisposables: vscode.Disposable[] = [];
  private dirty = false;
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPostAt = 0;
  /** 最後に送ったスナップショットのウィンドウid（自ウィンドウか他ウィンドウかの判定に使う）。 */
  private windowId: string | undefined;
  /** ライブtailの対象（詳細で選択中のセッション）。 */
  private watched: McTarget | undefined;
  private liveTimer: ReturnType<typeof setInterval> | undefined;
  private liveInFlight = false;
  private latestSnapshot: McSnapshot | undefined;
  /** 詳細ペインで表示した返事待ちの既読（Issue #2171）。 */
  private readonly readMarker = new ReadMarker();

  constructor(
    private readonly read: () => McSnapshot,
    private readonly control: SessionControl,
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
    private readonly launcher?: McLaunchPort,
    private readonly host?: McHostPort,
    private readonly sessionPort?: McSessionPort,
    /** オーケストレータモードのrun（Issue #2150）。task runの組み立ての後に入るため関数で受ける。 */
    private readonly runsPort?: () => McRunsPort | undefined,
    /** MCの設定の変更と絞り込みの保存（Issue #2162）。 */
    private readonly settingsPort?: McSettingsPort,
    /** 作業履歴から利用枠の推移を組む（Issue #2176）。 */
    private readonly usageHistory?: () => Promise<McUsageHistory>,
  ) {}

  /** webviewの設定。`createWebviewPanel`と、Reload後の復元の両方で使う。 */
  webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
  }

  show(): void {
    if (this.panel !== undefined) {
      this.panel.reveal();
      this.schedulePost();
      return;
    }
    const snapshot = this.read();
    const panel = vscode.window.createWebviewPanel(
      MissionControlViewManager.viewType,
      missionControlTitle(snapshot.pending.length),
      vscode.ViewColumn.Active,
      this.webviewOptions(),
    );
    this.attach(panel);
    this.log.info('Mission Controlを開いた');
  }

  close(): void {
    this.panel?.dispose();
  }

  /** Reload後に、VS Codeが残しておいたタブを引き取る（`registerWebviewPanelSerializer`）。 */
  restore(panel: vscode.WebviewPanel): void {
    if (this.panel !== undefined) {
      // 既に開いている（復元より先にコマンドで開かれた）。2枚目は持たない
      panel.dispose();
      this.panel.reveal();
      return;
    }
    panel.webview.options = this.webviewOptions();
    this.attach(panel);
    this.log.info('Mission Controlを復元した');
  }

  /** 最後に作ったスナップショット（ライフサイクル操作の確認文・実行中の判定に使う）。 */
  lastSnapshot(): McSnapshot | undefined {
    return this.latestSnapshot;
  }

  refresh(): void {
    if (this.panel === undefined) {
      return;
    }
    this.schedulePost();
  }

  dispose(): void {
    this.clearTimer();
    this.stopLive();
    this.panel?.dispose();
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = renderMissionControlHtml(
      panel.webview,
      vscode.Uri.joinPath(this.extensionUri, ...SCRIPT_PATH),
    );
    this.panelDisposables.push(
      panel.onDidDispose(() => {
        this.clearTimer();
        this.stopLive();
        this.watched = undefined;
        this.dirty = false;
        this.panel = undefined;
        for (const d of this.panelDisposables.splice(0)) {
          d.dispose();
        }
      }),
      // 非表示の間の更新は溜めておき、表に戻った時点で送り直す。ライブtailの取り直しも
      // 非表示の間は止め、表に戻ったら再開する
      panel.onDidChangeViewState(() => {
        if (this.panel?.visible === true && this.dirty) {
          this.schedulePost();
        }
        this.restartLive();
        this.markWatchedRead();
      }),
      panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
    );
  }

  private schedulePost(): void {
    if (this.postTimer !== undefined) {
      return;
    }
    const since = Date.now() - this.lastPostAt;
    if (since >= POST_INTERVAL_MS) {
      this.post();
      return;
    }
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.post();
    }, POST_INTERVAL_MS - since);
  }

  private clearTimer(): void {
    if (this.postTimer !== undefined) {
      clearTimeout(this.postTimer);
      this.postTimer = undefined;
    }
  }

  private post(): void {
    const panel = this.panel;
    if (panel === undefined) {
      return;
    }
    this.lastPostAt = Date.now();
    const snapshot = this.withSettings(this.read());
    this.latestSnapshot = snapshot;
    // タブ名の件数は非表示の間も合わせる（タブ自体は見えている）
    panel.title = missionControlTitle(snapshot.pending.length);
    this.windowId = snapshot.windowId;
    this.host?.observe?.(snapshot, panel.active && vscode.window.state.focused);
    this.dirty = !panel.visible;
    if (this.dirty) {
      return;
    }
    void panel.webview.postMessage({ type: 'snapshot', snapshot });
    // 自ウィンドウのセッションは状態の変化（このpostの契機）ごとにやり取りを送り直す
    if (this.watched !== undefined && this.watched.windowId === this.windowId) {
      this.pushLive();
    }
    this.markWatchedRead();
  }

  /**
   * 詳細ペインで表示中のセッションが未読の返事待ちなら既読にする（Issue #2171）。宛先の解決
   * （自ウィンドウか別ウィンドウか）は他の操作と同じ`control`に任せる。MCが見えている間だけ。
   */
  private markWatchedRead(): void {
    if (this.panel?.visible !== true) {
      return;
    }
    const target = this.watched;
    if (target === undefined || !this.readMarker.take(this.latestSnapshot?.sessions, target)) {
      return;
    }
    void this.control(target, { kind: 'markRead' })
      .then((result) => {
        if (result.ok) {
          this.refresh();
        }
      })
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: 既読にできませんでした: ${String(e)}`);
      });
  }

  private receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const m = message as Record<string, unknown>;
    switch (m.type) {
      case 'ready':
        this.post();
        return;
      case 'control':
        this.handleControl(m);
        return;
      case 'watch':
        this.setWatch(m.target);
        return;
      case 'launchOptions':
      case 'pickFolder':
      case 'launch':
        this.handleLaunch(m);
        return;
      case 'openDiff':
      case 'reviewAck':
      case 'resume':
      case 'resumeDismiss':
      case 'reloadWindow':
        this.handleHost(m);
        return;
      case 'copyRef':
        this.handleCopyRef(m);
        return;
      case 'pickAttachments':
        this.handlePickAttachments(m);
        return;
      case 'runCommand':
        this.handleRunCommand(m);
        return;
      case 'lifecycle':
      case 'history':
      case 'historyOpen':
      case 'handoffLedger':
      case 'handoffOpen':
      case 'workUnits':
        this.handleSessions(m);
        return;
      case 'runOp':
      case 'runParallel':
      case 'runStart':
      case 'issueList':
      case 'issueStart':
      case 'runTaskOp':
        this.handleRuns(m);
        return;
      case 'setPref':
      case 'saveFilter':
      case 'deleteFilter':
        this.handleSettings(m);
        return;
      case 'usageHistory':
        this.handleUsageHistory(m);
        return;
      default:
        return;
    }
  }

  /**
   * ライブtailの対象を差し替える（Issue #2137の3）。自ウィンドウのセッションは状態の変化で
   * 送り、他ウィンドウのセッションは選択中の間だけ`recentTurns`を間隔を空けて取り直す。
   */
  private setWatch(raw: unknown): void {
    const target =
      typeof raw === 'object' && raw !== null
        ? parseTarget(raw as Record<string, unknown>)
        : undefined;
    this.watched = target;
    this.restartLive();
    this.markWatchedRead();
  }

  private restartLive(): void {
    this.stopLive();
    const target = this.watched;
    if (target === undefined || this.panel?.visible !== true) {
      return;
    }
    this.pushLive();
    if (target.windowId !== this.windowId) {
      this.liveTimer = setInterval(() => this.pushLive(), LIVE_POLL_MS);
    }
  }

  private stopLive(): void {
    if (this.liveTimer !== undefined) {
      clearInterval(this.liveTimer);
      this.liveTimer = undefined;
    }
  }

  /** 直近のやり取りを1回取り、webviewへ送る。前の取り寄せが返るまでは重ねない。 */
  private pushLive(): void {
    const target = this.watched;
    if (target === undefined || this.liveInFlight || this.panel?.visible !== true) {
      return;
    }
    this.liveInFlight = true;
    void this.control(target, { kind: 'recentTurns', limit: LIVE_TURNS })
      .then((result) => {
        // 取り寄せの間に選択が変わっていたら捨てる（前の会話のやり取りを出さない）
        if (this.watched !== target) {
          return;
        }
        void this.panel?.webview.postMessage({
          type: 'liveTurns',
          target,
          ok: result.ok,
          error: result.error,
          turns: result.turns,
          turnStart: result.turnStart,
          turnTotal: result.turnTotal,
        });
      })
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: やり取りを取り寄せられませんでした: ${String(e)}`);
      })
      .finally(() => {
        this.liveInFlight = false;
      });
  }

  /** 新規セッションの起動にかかわる要求（Issue #2137の1）。応答は`reply`で返す。 */
  private handleLaunch(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const launcher = this.launcher;
    if (launcher === undefined) {
      this.postReply(seq, { ok: false, error: '新規起動はこの画面では使えません' });
      return;
    }
    const run = async (): Promise<Record<string, unknown>> => {
      if (message.type === 'launchOptions') {
        // 候補（model一覧はCLIへ問い合わせる）が取れなくても、起動先の候補は返す
        const choices = await launcher.choices?.().catch((e: unknown) => {
          this.log.warn(`Mission Control: 起動オプションの候補を読めませんでした: ${String(e)}`);
          return undefined;
        });
        return { ok: true, repos: await launcher.options(), choices };
      }
      if (message.type === 'pickFolder') {
        const repo = await launcher.pickFolder();
        return { ok: true, repo };
      }
      const request = parseLaunchRequest(message);
      if (typeof request === 'string') {
        return { ok: false, error: request };
      }
      const result = await launcher.launch(request);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      this.log.info(`Mission Control: ${request.provider}の会話を起動した（${result.cwd}）`);
      this.refresh();
      return { ok: true, cwd: result.cwd };
    };
    void run()
      .then((reply) => this.postReply(seq, reply))
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: 起動にかかわる操作に失敗しました: ${String(e)}`);
        this.postReply(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  /** 閉じる・archive・delete・履歴の要求（Issue #2149）。応答は`reply`で返す。 */
  private handleSessions(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const port = this.sessionPort;
    if (port === undefined) {
      this.postReply(seq, { ok: false, error: 'この操作はこの画面では使えません' });
      return;
    }
    const run = async (): Promise<Record<string, unknown>> => {
      if (message.type === 'history') {
        const history = await port.history();
        return { ok: true, history, historyOmitted: port.historyOmitted?.() };
      }
      if (message.type === 'workUnits') {
        const { days } = message;
        if (
          typeof days !== 'number' ||
          !Number.isInteger(days) ||
          days < 0 ||
          days > MAX_WORK_UNIT_DAYS
        ) {
          return { ok: false, error: '集計する期間が正しくありません' };
        }
        if (port.workUnits === undefined) {
          return { ok: false, error: '作業単位の集計はこの画面では使えません' };
        }
        return { ok: true, workUnits: await port.workUnits(days) };
      }
      if (message.type === 'historyOpen') {
        const { provider, threadId } = message;
        if ((provider !== 'codex' && provider !== 'claude') || typeof threadId !== 'string') {
          return { ok: false, error: '開くセッションが正しくありません' };
        }
        const error = await port.historyOpen(provider, threadId);
        return error === undefined ? { ok: true } : { ok: false, error };
      }
      if (message.type === 'handoffLedger') {
        const query = parseHandoffQuery(message.query);
        if (query === undefined || port.handoffLedger === undefined) {
          return { ok: false, error: 'handoff台帳の条件が正しくありません' };
        }
        return { ok: true, handoffs: await port.handoffLedger(query) };
      }
      if (message.type === 'handoffOpen') {
        const { name } = message;
        if (typeof name !== 'string' || name === '' || port.handoffOpen === undefined) {
          return { ok: false, error: '開くhandoffが正しくありません' };
        }
        const error = await port.handoffOpen(name);
        return error === undefined ? { ok: true } : { ok: false, error };
      }
      const request = parseLifecycleRequest(message);
      if (typeof request === 'string') {
        return { ok: false, error: request };
      }
      const result = await port.lifecycle(request.op, request.targets);
      if (result.cancelled) {
        return { ok: false, error: '取りやめました' };
      }
      return { ok: true, outcomes: result.outcomes };
    };
    void run()
      .then((reply) => {
        this.postReply(seq, reply);
        this.refresh();
      })
      .catch((e: unknown) => {
        this.log.warn(
          `Mission Control: 操作に失敗しました（${String(message.type)}）: ${String(e)}`,
        );
        this.postReply(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  /** 利用枠の推移の要求（Issue #2176）。応答は`reply`の`usageHistory`で返す。 */
  private handleUsageHistory(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const load = this.usageHistory;
    if (load === undefined) {
      this.postReply(seq, { ok: false, error: 'この操作はこの画面では使えません' });
      return;
    }
    void load()
      .then((usageHistory) => this.postReply(seq, { ok: true, usageHistory }))
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: 利用枠の推移を読めませんでした: ${String(e)}`);
        this.postReply(seq, { ok: false, error: '作業履歴を読めませんでした' });
      });
  }

  /**
   * runの操作とroadmap・Issueからの起動（Issue #2150）。応答は`reply`で返す。webviewから届いた
   * 値は形を確かめ、フォルダは開いているワークスペースフォルダとの一致だけを受ける。
   */
  private handleRuns(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const port = this.runsPort?.();
    if (port === undefined) {
      this.postReply(seq, { ok: false, error: 'オーケストレータモードはこの画面では使えません' });
      return;
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const done = (error: string | undefined): Record<string, unknown> =>
      error === undefined ? { ok: true } : { ok: false, error };
    const run = async (): Promise<Record<string, unknown>> => {
      switch (message.type) {
        case 'runOp': {
          const request = parseRunOp(message);
          return typeof request === 'string'
            ? { ok: false, error: request }
            : done(await port.runOp(request.op, request.runId));
        }
        case 'runParallel': {
          const request = parseRunParallel(message, MAX_TASK_RUN_PARALLEL);
          return typeof request === 'string'
            ? { ok: false, error: request }
            : done(await port.setMaxParallel(request.runId, request.maxParallel));
        }
        case 'runStart':
          return done(await port.start());
        case 'runTaskOp': {
          const request = parseRunTaskOp(message);
          if (typeof request === 'string') {
            return { ok: false, error: request };
          }
          if (port.taskOp === undefined) {
            return { ok: false, error: 'タスクの操作はこの画面では使えません' };
          }
          return done(await port.taskOp(request.op, request.runId, request.taskId));
        }
        case 'issueList': {
          const folder = pickRunFolder(message.folder, folders);
          if (folder === undefined) {
            return { ok: false, error: '開いているワークスペースフォルダを選んでください' };
          }
          const listing = await port.listIssues(folder);
          return typeof listing === 'string'
            ? { ok: false, error: listing }
            : { ok: true, issues: listing };
        }
        default: {
          const request = parseIssueStart(message, folders);
          if (typeof request === 'string') {
            return { ok: false, error: request };
          }
          const result = await port.startFromIssues(request);
          return result.ok
            ? { ok: true, message: result.message }
            : { ok: false, error: result.message };
        }
      }
    };
    void run()
      .then((reply) => {
        this.postReply(seq, reply);
        this.refresh();
      })
      .catch((e: unknown) => {
        this.log.warn(
          `Mission Control: runの操作に失敗しました（${String(message.type)}）: ${String(e)}`,
        );
        this.postReply(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  /** 設定の今の値と保存した絞り込みをスナップショットへ載せる（Issue #2162）。 */
  private withSettings(snapshot: McSnapshot): McSnapshot {
    const port = this.settingsPort;
    if (port === undefined) {
      return snapshot;
    }
    return { ...snapshot, prefs: port.prefs(), savedFilters: port.savedFilters() };
  }

  /**
   * 設定の変更と絞り込みの保存・削除（Issue #2162）。設定は`parseSetPref`で許可リストと
   * 値の型・範囲を、絞り込みは`applySaveFilter`等で名前と中身を確かめてから書く。
   */
  private handleSettings(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const port = this.settingsPort;
    if (port === undefined) {
      this.postReply(seq, { ok: false, error: 'この画面では使えません' });
      return;
    }
    const run = async (): Promise<string | undefined> => {
      if (message.type === 'setPref') {
        const change = parseSetPref(message);
        return typeof change === 'string' ? change : port.setPref(change);
      }
      const current = port.savedFilters();
      const next =
        message.type === 'saveFilter'
          ? applySaveFilter(current, message)
          : applyDeleteFilter(current, message);
      if (typeof next === 'string') {
        return next;
      }
      await port.writeSavedFilters(next);
      return undefined;
    };
    void run()
      .then((error) => {
        if (error !== undefined) {
          this.log.warn(
            `Mission Control: 設定の操作を拒みました（${String(message.type)}）: ${error}`,
          );
        }
        this.postReply(seq, error === undefined ? { ok: true } : { ok: false, error });
        this.refresh();
      })
      .catch((e: unknown) => {
        this.log.warn(
          `Mission Control: 設定の操作に失敗しました（${String(message.type)}）: ${String(e)}`,
        );
        this.postReply(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  /** レビュー待ち・再開待ち・Reloadの要求（Issue #2138）。応答は`reply`で返す。 */
  private handleHost(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const host = this.host;
    if (host === undefined) {
      this.postReply(seq, { ok: false, error: 'この操作はこの画面では使えません' });
      return;
    }
    const run = async (): Promise<string | undefined> => {
      if (message.type === 'reloadWindow') {
        return host.reloadWindow();
      }
      const target = parseTarget(message);
      if (target === undefined) {
        return '宛先が正しくありません';
      }
      switch (message.type) {
        case 'openDiff':
          return typeof message.path === 'string'
            ? host.openDiff(target, message.path)
            : 'ファイルが正しくありません';
        case 'reviewAck':
          return host.reviewAck(target);
        case 'resume':
          return host.resume(target);
        default:
          return host.resumeDismiss(target);
      }
    };
    void run()
      .then((error) => {
        this.postReply(seq, error === undefined ? { ok: true } : { ok: false, error });
        this.refresh();
      })
      .catch((e: unknown) => {
        this.log.warn(
          `Mission Control: 操作に失敗しました（${String(message.type)}）: ${String(e)}`,
        );
        this.postReply(seq, { ok: false, error: '操作に失敗しました' });
        // 失敗で戻した項目（再開待ちなど）を画面へ反映する
        this.refresh();
      });
  }

  /**
   * セッションid（`send_message` / `ask_session`の宛先）をクリップボードへ書く。旧統括ページの
   * 「idをコピー」（Issue #1305）をMCへ移した（Issue #2138）。webviewは信頼境界の外側なので、
   * 届いた文字列をそのまま書かず、`parseTarget`で確かめた宛先から組み立て直す。
   */
  private handleCopyRef(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const target = parseTarget(message);
    if (target === undefined) {
      this.postReply(seq, { ok: false, error: '宛先が正しくありません' });
      return;
    }
    void Promise.resolve(vscode.env.clipboard.writeText(formatSessionTarget(target))).then(
      () => this.postReply(seq, { ok: true }),
      (e: unknown) => {
        this.log.warn(`Mission Control: セッションidをコピーできませんでした: ${String(e)}`);
        this.postReply(seq, { ok: false, error: 'コピーできませんでした' });
      },
    );
  }

  /**
   * Composerの添付（Issue #2158）。ダイアログはこのウィンドウに出す。会話が別ウィンドウでも
   * 同じマシンのファイルなので、画像は中身を、ほかはパスをwebviewへ返す。
   */
  private handlePickAttachments(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    // 既定の場所は会話の作業ディレクトリ。webview由来の値なので、ダイアログの初期位置にだけ使う
    const cwd =
      typeof message.cwd === 'string' && message.cwd !== '' && message.cwd.length <= 4096
        ? message.cwd
        : undefined;
    void pickAttachmentFiles(cwd).then(
      (picked) =>
        this.postReply(
          seq,
          picked === undefined
            ? { ok: true, attachments: [], paths: [] }
            : {
                ok: true,
                attachments: picked.attachments,
                paths: picked.paths,
                message: picked.skipped.length === 0 ? undefined : picked.skipped.join('\n'),
              },
        ),
      (e: unknown) => {
        this.log.warn(`Mission Control: 添付を選べませんでした: ${String(e)}`);
        this.postReply(seq, { ok: false, error: '添付を選べませんでした' });
      },
    );
  }

  /**
   * 許可リストの拡張コマンドを実行する（Issue #2161）。webviewからはidだけを受け、
   * `parseRunCommand`で許可リストとの完全一致と形を確かめる。引数はここで決め、宛先は
   * 最後に送ったスナップショットに載っているセッションだけを認める。
   */
  private handleRunCommand(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const sessions = this.latestSnapshot?.sessions ?? [];
    const request = parseRunCommand(message, (target) =>
      sessions.some(
        (s) =>
          s.windowId === target.windowId &&
          s.provider === target.provider &&
          s.threadId === target.threadId,
      ),
    );
    if (typeof request === 'string') {
      this.log.warn(`Mission Control: コマンドの実行を拒みました: ${request}`);
      this.postReply(seq, { ok: false, error: request });
      return;
    }
    void Promise.resolve(vscode.commands.executeCommand(request.id, ...request.args)).then(
      () => this.postReply(seq, { ok: true }),
      (e: unknown) => {
        this.log.warn(`Mission Control: コマンドに失敗しました（${request.id}）: ${String(e)}`);
        this.postReply(seq, { ok: false, error: 'コマンドに失敗しました' });
      },
    );
  }

  private postReply(seq: number, reply: Record<string, unknown>): void {
    void this.panel?.webview.postMessage({ ...reply, type: 'reply', seq });
  }

  /**
   * webviewからの操作。webviewは信頼境界の外側として、統括ページと同じ関数で形を確かめる。
   * 中身（承認の内容・回答）の妥当性は宛先側（`controlSession`）が確かめる。
   */
  private handleControl(message: Record<string, unknown>): void {
    const target = parseTarget(message);
    const action = parseAction(message);
    if (target === undefined || action === undefined || typeof message.seq !== 'number') {
      return;
    }
    const seq = message.seq;
    void this.control(target, action)
      .then((result) => {
        this.postResult(seq, result);
        // 候補・キューの取り寄せは入力のたびに来る。一覧は変わらないので組み直さない
        if (!READ_ONLY_CONTROL_KINDS.has(action.kind)) {
          this.refresh();
        }
      })
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: 操作に失敗しました（${action.kind}）: ${String(e)}`);
        this.postResult(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  private postResult(seq: number, result: SessionControlResult): void {
    // 承認の中身・直近のやり取りは応答にだけ載せ、スナップショットには混ぜない
    void this.panel?.webview.postMessage({
      type: 'controlResult',
      seq,
      ok: result.ok,
      error: result.error,
      approvals: result.approvals,
      turns: result.turns,
      turnStart: result.turnStart,
      turnTotal: result.turnTotal,
      handoff: result.handoff,
      sideQuestion: result.sideQuestion,
      files: result.files,
      commands: result.commands,
      queued: result.queued,
      settings: result.settings,
      rewindFiles: result.rewindFiles,
    });
  }
}

/**
 * webviewのHTML。CSPは`default-src 'none'`で、scriptはnonce付きの1ファイルだけを許す。
 * スタイルは`<style>`へ埋める（`style-src 'unsafe-inline'`は他の画面と同じ）。
 */
export function renderMissionControlHtml(webview: vscode.Webview, scriptUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    // 指示欄に添えた画像のサムネイル（Issue #2158）。webviewが自分で作ったデータURLだけ
    'img-src data:',
  ].join('; ');
  const src = webview.asWebviewUri(scriptUri).toString();
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Mission Control</title><style>${MISSION_CONTROL_STYLES}</style></head><body><div id="root"></div><script nonce="${nonce}" src="${escapeAttribute(src)}"></script></body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/gu, (c) =>
    c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : '&gt;',
  );
}
