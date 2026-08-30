import * as vscode from 'vscode';
import { isApprovalDecision } from '../appserver/approvals';
import type { ForgeOrchestrator } from '../forge/orchestrator';
import type {
  ForgeHubProvider,
  ForgeHubService,
  ForgeHubSnapshot,
  ForgeIssueDraft,
} from '../forge/hub';
import type { Logger } from '../log';
import type { RoadmapIssueSummary } from '../orchestrator/roadmap';
import { chatCsp } from './chatCsp';

/** 会話から開始するForge操作の入口。Issue作成は常にこの画面の確認操作を経由する。 */
export class ForgeHubViewManager implements vscode.Disposable {
  static readonly viewType = 'agent.forgeHub';
  private panel: vscode.WebviewPanel | undefined;
  private snapshot: ForgeHubSnapshot | undefined;
  private issues: readonly RoadmapIssueSummary[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;

  constructor(
    private readonly service: ForgeHubService,
    private readonly cwd: () => string | undefined,
    private readonly orchestrator: ForgeOrchestrator,
    private readonly log: Logger,
  ) {
    orchestrator.onChanged((snapshot) => this.post({ type: 'orchestrator', snapshot }));
    orchestrator.onWorkStateChanged((sessionId, state) => {
      void this.service
        .recordSessionState(sessionId, { busy: state.busy, failed: state.turnFailed })
        .then(() => this.postSnapshot());
    });
  }

  async show(provider: ForgeHubProvider): Promise<void> {
    const cwd = this.cwd();
    if (cwd === undefined) {
      void vscode.window.showWarningMessage(
        'Forge Hubを開くにはワークスペースフォルダが必要です。',
      );
      return;
    }
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        ForgeHubViewManager.viewType,
        'Forge Hub',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          enableFindWidget: true,
        },
      );
      this.panel.onDidDispose(() => {
        this.stopRefresh();
        this.panel = undefined;
        this.snapshot = undefined;
        this.issues = [];
      });
      this.panel.webview.html = render(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(
        (message: unknown) => void this.receiveSafely(message),
      );
    } else {
      this.panel.reveal();
    }
    this.snapshot = await this.service.inspect(provider, cwd);
    this.issues = await this.service.listIssues(this.snapshot);
    this.postSnapshot();
    this.postOrchestratorSnapshot();
    this.startRefresh();
    this.log.info(`[forge-hub] ${provider}から開きました: ${cwd}`);
  }

  dispose(): void {
    this.stopRefresh();
    this.panel?.dispose();
  }

  private startRefresh(): void {
    this.stopRefresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 30_000);
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async refresh(): Promise<void> {
    if (this.snapshot === undefined || this.refreshing) return;
    this.refreshing = true;
    try {
      this.snapshot = await this.service.inspect(this.snapshot.provider, this.snapshot.cwd);
      await this.service.refreshRemoteStates();
      this.postSnapshot();
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * `receive`が投げても、要求に対する結果を必ず1回返す（Issue #978）。
   *
   * 画面は結果が返るまで押したボタンを無効にしている。ここで例外を握り潰すと、
   * ボタンがWebviewを閉じるまで無効のまま戻らない。
   */
  private async receiveSafely(message: unknown): Promise<void> {
    try {
      await this.receive(message);
    } catch (error) {
      if (!isRecord(message)) return;
      const requestType = typeof message['type'] === 'string' ? message['type'] : undefined;
      const resultType =
        requestType === undefined ? undefined : RESULT_TYPE_BY_REQUEST[requestType];
      if (resultType === undefined) return;
      this.post({
        type: resultType,
        ok: false,
        message:
          '処理中に想定外のエラーが発生しました: ' +
          (error instanceof Error ? error.message : String(error)),
        requestId: readRequestId(message),
      });
    }
  }

  private async receive(message: unknown): Promise<void> {
    if (!isRecord(message) || this.panel === undefined) return;
    if (message.type === 'ready') {
      this.postSnapshot();
      this.postOrchestratorSnapshot();
      return;
    }
    if (message.type === 'sendOrchestrator' && typeof message['text'] === 'string') {
      const text = message['text'].trim();
      if (text !== '' && this.snapshot !== undefined) {
        await this.orchestrator.send(this.snapshot.provider, this.snapshot.cwd, text);
      }
      return;
    }
    if (message.type === 'interruptOrchestrator') {
      await this.orchestrator.interrupt();
      return;
    }
    if (
      message.type === 'openConversation' &&
      (message['provider'] === 'codex' || message['provider'] === 'claude') &&
      typeof message['sessionId'] === 'string'
    ) {
      if (!this.orchestrator.revealWorkSession(message['provider'], message['sessionId'])) {
        void vscode.window.showWarningMessage('関連会話はこのVSCodeウィンドウで開けませんでした。');
      }
      return;
    }
    // Forge Hubの4値では答えられない承認要求のための逃げ道（Issue #989）。
    if (message.type === 'openOrchestratorConversation') {
      if (!this.orchestrator.revealOrchestrator()) {
        void vscode.window.showWarningMessage(
          'オーケストレータの会話はこのVSCodeウィンドウで開けませんでした。',
        );
      }
      return;
    }
    if (message.type === 'runWorkAction' && typeof message['branch'] === 'string') {
      const item = this.service
        .listWorkItems()
        .find((candidate) => candidate.branch === message['branch']);
      if (item !== undefined) {
        if (item.status === 'cleanup') {
          const confirmed = await vscode.window.showWarningMessage(
            `#${item.issue.number}のcleanupを開始します。Issue closeやbranch/worktree削除が含まれる場合は、オーケストレータが対象を確認してから実行します。`,
            { modal: true },
            'cleanupを依頼する',
          );
          if (confirmed !== 'cleanupを依頼する') return;
        }
        await this.orchestrator.send(
          this.snapshot?.provider ?? item.provider,
          this.snapshot?.cwd ?? item.cwd,
          buildWorkActionPrompt(item.host, item.status, item.issue.number, item.pullRequestNumber),
        );
      }
      return;
    }
    if (message.type === 'completeCleanup' && typeof message['branch'] === 'string') {
      const requestId = readRequestId(message);
      const item = this.service
        .listWorkItems()
        .find((candidate) => candidate.branch === message['branch']);
      if (item === undefined) {
        this.post({
          type: 'cleanupResult',
          ok: false,
          gone: true,
          message: '対象のForge作業は既に追跡対象から外れています。',
          requestId,
        });
        return;
      }
      // 外す対象を利用者が識別できるよう、Issue番号だけでなくbranchとworktreeも見せる。
      const confirmed = await vscode.window.showWarningMessage(
        `#${item.issue.number}のIssue close・branch/worktree削除などのcleanup完了を確認しましたか。Hubからこのカードを外します。実際の後片付けは行いません。`,
        {
          modal: true,
          detail: `branch: ${item.branch}\nworktree: ${item.cwd}`,
        },
        '完了を記録する',
      );
      if (confirmed !== '完了を記録する') {
        this.post({
          type: 'cleanupResult',
          ok: false,
          cancelled: true,
          message: `#${String(item.issue.number)}のcleanup記録を取り消しました。`,
          requestId,
        });
        return;
      }
      const result = await this.service.completeCleanup(item.branch);
      this.post(
        result.ok
          ? { type: 'cleanupResult', ok: true, requestId }
          : {
              type: 'cleanupResult',
              ok: false,
              gone: result.reason === 'gone',
              message: result.message,
              requestId,
            },
      );
      this.postSnapshot();
      return;
    }
    if (
      message.type === 'decideOrchestratorApproval' &&
      (typeof message['requestId'] === 'string' || typeof message['requestId'] === 'number') &&
      isApprovalDecision(message['decision'])
    ) {
      this.orchestrator.decideApproval(message['requestId'], message['decision']);
      return;
    }
    if (message.type === 'refresh' && this.snapshot !== undefined) {
      await this.refresh();
      return;
    }
    if (
      message.type === 'selectHost' &&
      this.snapshot !== undefined &&
      (message['host'] === 'github' || message['host'] === 'gitlab')
    ) {
      this.snapshot = await this.service.inspect(
        this.snapshot.provider,
        this.snapshot.cwd,
        message['host'],
      );
      this.postSnapshot();
      return;
    }
    if (message.type === 'listIssues' && this.snapshot !== undefined) {
      this.issues = await this.service.listIssues(this.snapshot);
      this.post({ type: 'issues', issues: this.issues });
      this.postSnapshot();
      return;
    }
    if (message.type === 'postIssuePlan' && this.snapshot !== undefined) {
      const issue = readIssue(message);
      const plan = typeof message['plan'] === 'string' ? message['plan'] : undefined;
      if (issue === undefined || plan === undefined || plan.trim() === '') {
        this.post({
          type: 'planResult',
          ok: false,
          message: 'Issueまたは実装計画の入力が不正です。',
        });
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `#${issue.number}へ実装計画をコメントとして追加します。Issue本文は変更しません。`,
        { modal: true },
        '反映する',
      );
      if (confirmed !== '反映する') return;
      const result = await this.service.postIssuePlan(this.snapshot, issue, plan);
      this.post(
        result.ok
          ? { type: 'planResult', ok: true, url: result.url }
          : { type: 'planResult', ok: false, message: result.message },
      );
      this.postSnapshot();
      return;
    }
    if (message.type === 'createDraftPullRequest' && typeof message['branch'] === 'string') {
      const confirmation = await vscode.window.showWarningMessage(
        '対象branchをpushし、Draft PR/MRを作成します。マージは行いません。',
        { modal: true },
        '作成する',
      );
      const requestId = readRequestId(message);
      if (confirmation !== '作成する') {
        this.post({
          type: 'pullRequestResult',
          ok: false,
          cancelled: true,
          message: 'Draft PR/MRの作成を取り消しました。',
          requestId,
        });
        return;
      }
      const result = await this.service.createDraftPullRequest(message['branch']);
      this.post(
        result.ok
          ? { type: 'pullRequestResult', ok: true, url: result.url, requestId }
          : { type: 'pullRequestResult', ok: false, message: result.message, requestId },
      );
      this.postSnapshot();
      return;
    }
    if (message.type === 'refreshCi' && typeof message['branch'] === 'string') {
      const requestId = readRequestId(message);
      const result = await this.service.refreshCi(message['branch']);
      this.post(
        result.ok
          ? { type: 'ciResult', ok: true, requestId }
          : {
              type: 'ciResult',
              ok: false,
              gone: result.reason === 'gone',
              message: result.message,
              requestId,
            },
      );
      this.postSnapshot();
      return;
    }
    if (message.type === 'refreshReview' && typeof message['branch'] === 'string') {
      const result = await this.service.refreshReview(message['branch']);
      this.post(
        result.ok
          ? { type: 'reviewResult', ok: true }
          : { type: 'reviewResult', ok: false, message: result.message },
      );
      this.postSnapshot();
      return;
    }
    if (
      message.type === 'replyReviewThread' &&
      typeof message['branch'] === 'string' &&
      typeof message['threadId'] === 'string' &&
      typeof message['body'] === 'string'
    ) {
      const confirmed = await vscode.window.showWarningMessage(
        'レビューのスレッドへ返信を投稿します。',
        { modal: true },
        '投稿する',
      );
      if (confirmed !== '投稿する') return;
      const result = await this.service.replyToReviewThread(
        message['branch'],
        message['threadId'],
        message['body'],
      );
      this.post(
        result.ok
          ? { type: 'reviewActionResult', ok: true }
          : { type: 'reviewActionResult', ok: false, message: result.message },
      );
      if (result.ok) await this.service.refreshReview(message['branch']);
      this.postSnapshot();
      return;
    }
    if (
      message.type === 'resolveReviewThread' &&
      typeof message['branch'] === 'string' &&
      typeof message['threadId'] === 'string'
    ) {
      const confirmed = await vscode.window.showWarningMessage(
        'レビューのスレッドを解決済みにします。',
        { modal: true },
        '解決する',
      );
      if (confirmed !== '解決する') return;
      const result = await this.service.resolveReviewThread(message['branch'], message['threadId']);
      this.post(
        result.ok
          ? { type: 'reviewActionResult', ok: true }
          : { type: 'reviewActionResult', ok: false, message: result.message },
      );
      if (result.ok) await this.service.refreshReview(message['branch']);
      this.postSnapshot();
      return;
    }
    if (message.type === 'startIssue') {
      const requestId = readRequestId(message);
      const snapshot = this.snapshot;
      const issue = readIssue(message);
      if (snapshot === undefined || issue === undefined) {
        this.post({
          type: 'startResult',
          ok: false,
          message: '着手の要求を受け取れませんでした。画面を更新してからもう一度試してください。',
          requestId,
        });
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `#${issue.number}の隔離worktreeを作成し、Forgeオーケストレータへ着手を依頼します。`,
        { modal: true },
        '着手する',
      );
      if (confirmed !== '着手する') {
        this.post({
          type: 'startResult',
          ok: false,
          cancelled: true,
          message: `#${String(issue.number)}への着手を取り消しました。`,
          requestId,
        });
        return;
      }
      const result = await this.service.createIssueWorktree(snapshot, issue);
      if (!result.ok) {
        this.post({ type: 'startResult', ok: false, message: result.message, requestId });
        return;
      }
      // ここから先で投げても、worktreeは既にできている。消すと利用者の作業ごと消えるため
      // 残したまま、どこまで進んだかが分かる文言で返す（Issue #978）。
      try {
        const sessionId = await this.orchestrator.startWork(
          snapshot.provider,
          result.cwd,
          `issue-${String(issue.number)}`,
          `${buildIssueStartPrompt(snapshot.host, issue.number)}\n作業ディレクトリは\`${result.cwd}\`です。\n\n${
            snapshot.host === 'gitlab'
              ? `$gitlab-develop #${issue.number}`
              : `GitHub Issue #${issue.number}に着手してください。`
          }`,
        );
        await this.service.recordStartedWork(snapshot, issue, result, sessionId);
      } catch (error) {
        this.post({
          type: 'startResult',
          ok: false,
          message:
            `worktreeは${result.cwd}に作成しましたが、着手の依頼に失敗しました: ` +
            (error instanceof Error ? error.message : String(error)),
          requestId,
        });
        this.postSnapshot();
        return;
      }
      this.post({
        type: 'startResult',
        ok: true,
        cwd: result.cwd,
        branch: result.branch,
        requestId,
      });
      this.postSnapshot();
      return;
    }
    if (message.type !== 'createIssue' || this.snapshot === undefined) return;
    const draft = readDraft(message);
    if (draft === undefined) {
      this.post({ type: 'issueResult', ok: false, message: 'Issueの入力が不正です。' });
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `「${draft.title}」を${this.snapshot.host ?? 'Forge'}へIssueとして作成します。`,
      { modal: true },
      '作成する',
    );
    if (confirmed !== '作成する') return;
    const result = await this.service.createIssue(this.snapshot, draft);
    this.post(
      result.ok
        ? { type: 'issueResult', ok: true, url: result.url }
        : { type: 'issueResult', ok: false, message: result.message },
    );
    if (result.ok) {
      this.issues = await this.service.listIssues(this.snapshot);
      this.post({ type: 'issues', issues: this.issues });
      this.postSnapshot();
    }
  }

  private postSnapshot(): void {
    if (this.snapshot !== undefined) {
      this.post({
        type: 'snapshot',
        snapshot: this.snapshot,
        workItems: this.service.listWorkItems(),
        unstartedIssues: this.issues.filter(
          (issue) =>
            !this.service.listWorkItems().some((item) => item.issue.number === issue.number) &&
            !this.service
              .listPlannedIssues(this.issues)
              .some((planned) => planned.issue.number === issue.number),
        ),
        planningIssues: this.service.listPlannedIssues(this.issues),
      });
    }
  }
  private postOrchestratorSnapshot(): void {
    const snapshot = this.orchestrator.getSnapshot();
    if (snapshot !== undefined) this.post({ type: 'orchestrator', snapshot });
  }
  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }
}

/**
 * 画面が採番した相関id（Issue #978）。
 *
 * 結果メッセージはbranchもIssue番号も持たないため、これが無いと「どの操作の結果か」を
 * 画面側で判別できない。確認の無い`refreshCi`は複数のカードで続けて押せるうえ、
 * 応答の順序も保証されない。
 */
function readRequestId(message: Record<string, unknown>): string | undefined {
  const value = message['requestId'];
  return typeof value === 'string' ? value : undefined;
}

/** 要求の種類と、その要求に対して画面が待っている結果の型の対応（Issue #978）。 */
const RESULT_TYPE_BY_REQUEST: Record<string, string> = {
  startIssue: 'startResult',
  createIssue: 'issueResult',
  createDraftPullRequest: 'pullRequestResult',
  refreshCi: 'ciResult',
  completeCleanup: 'cleanupResult',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readDraft(value: Record<string, unknown>): ForgeIssueDraft | undefined {
  const fields = ['title', 'currentState', 'overview', 'implementation', 'verification'] as const;
  if (!fields.every((field) => typeof value[field] === 'string')) return undefined;
  const draft: ForgeIssueDraft = {
    title: value['title'] as string,
    currentState: value['currentState'] as string,
    overview: value['overview'] as string,
    implementation: value['implementation'] as string,
    verification: value['verification'] as string,
    ...(typeof value['labels'] === 'string' ? { labels: value['labels'] } : {}),
    ...(typeof value['assignees'] === 'string' ? { assignees: value['assignees'] } : {}),
    ...(typeof value['milestone'] === 'string' ? { milestone: value['milestone'] } : {}),
  };
  return draft.title.trim() === '' || draft.currentState.trim() === '' ? undefined : draft;
}

function readIssue(value: Record<string, unknown>): RoadmapIssueSummary | undefined {
  return typeof value['number'] === 'number' &&
    Number.isSafeInteger(value['number']) &&
    value['number'] > 0 &&
    typeof value['title'] === 'string'
    ? { number: value['number'], title: value['title'] }
    : undefined;
}

function buildIssueStartPrompt(host: 'github' | 'gitlab' | undefined, number: number): string {
  const command = host === 'gitlab' ? `glab issue view ${number}` : `gh issue view ${number}`;
  return [
    `Forge HubからIssue #${number}に着手します。`,
    `最初に \`${command}\` で本文と現在の状態を確認してください。`,
    '作業はこの隔離worktreeだけで行い、実装前に計画をIssueへ残してください。',
    'commit/pushやMR作成、マージ、破壊的操作は、必要な確認を取ってから進めてください。',
  ].join('\n');
}

function buildWorkActionPrompt(
  host: 'github' | 'gitlab',
  status: 'inProgress' | 'review' | 'ciPending' | 'ci' | 'cleanup' | 'blocked',
  issueNumber: number,
  pullRequestNumber: number | undefined,
): string {
  const reference =
    pullRequestNumber === undefined ? `Issue #${issueNumber}` : `PR/MR #${pullRequestNumber}`;
  if (host === 'gitlab') {
    if (status === 'inProgress') return `$gitlab-develop #${issueNumber}`;
    if (status === 'cleanup') return `$gitlab-cleanup ${reference}`;
    if (status === 'blocked')
      return `${reference}のブロック理由を調査し、必要な対応をしてください。`;
    return `$gitlab-review ${reference}`;
  }
  if (status === 'inProgress') return `GitHub Issue #${issueNumber}の実装を続けてください。`;
  if (status === 'cleanup')
    return `${reference}はマージ済みです。対象を確認してcleanupしてください。`;
  if (status === 'blocked') return `${reference}のブロック理由を調査し、必要な対応をしてください。`;
  return `${reference}をレビューし、必要な対応を進めてください。`;
}

function render(webview: vscode.Webview): string {
  const nonce = String(Date.now());
  return renderLiveDashboard(webview, nonce);
}

export function renderLiveDashboard(webview: vscode.Webview, nonce: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><style>
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}main{max-width:1500px;margin:auto;padding:24px}.top,.head,.actions,.filters{display:flex;align-items:center;gap:10px}.top,.head{justify-content:space-between}.top{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:16px}.eyebrow{margin:0;color:var(--vscode-textLink-foreground);font-size:11px;font-weight:700;letter-spacing:.12em}h1{margin:4px 0;font-size:30px}h2,h3{margin:0}.sub,.muted{color:var(--vscode-descriptionForeground)}button,select,textarea{font:inherit}button{border:0;border-radius:6px;padding:7px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.metric,.panel,.column{border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editorWidget-background)}.metric{padding:12px}.metric small,.badge,.time{display:block;color:var(--vscode-descriptionForeground);font-size:11px}.metric strong{display:block;margin-top:5px;overflow-wrap:anywhere}.panel{padding:14px;margin-top:12px}.urgent{border-color:var(--vscode-testing-iconFailed)}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.summary article{padding:12px;border-left:4px solid var(--vscode-textLink-foreground);background:var(--vscode-editor-background);border-radius:6px}.summary strong{font-size:24px}.board{display:grid;grid-template-columns:repeat(5,minmax(250px,1fr));gap:10px;overflow-x:auto;padding:4px 0}.column{min-height:170px;padding:10px}.column.urgent{border-color:var(--vscode-testing-iconFailed)}.card{display:grid;gap:8px;margin-top:9px;padding:11px;border-radius:7px;background:var(--vscode-editor-background);border-left:4px solid var(--vscode-charts-blue)}.card.alert{border-left-color:var(--vscode-testing-iconFailed)}.card.stale{outline:1px dashed var(--vscode-charts-yellow)}.badges{display:flex;flex-wrap:wrap;gap:5px}.badge{padding:3px 6px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.step{display:grid;grid-template-columns:repeat(5,1fr);gap:2px}.step span{height:4px;background:var(--vscode-panel-border)}.step span.done{background:var(--vscode-charts-green)}.step span.current{background:var(--vscode-progressBar-background)}.chat{max-height:230px;overflow:auto;background:var(--vscode-editor-background);border-radius:7px;padding:7px}.message{white-space:pre-wrap;margin:6px 0;padding:7px;border-left:3px solid var(--vscode-textLink-foreground);font:12px/1.5 var(--vscode-editor-font-family)}textarea{box-sizing:border-box;width:100%;min-height:62px;margin-top:8px;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:6px}.issues{display:grid;gap:6px;margin-top:10px}.issue{display:flex;justify-content:space-between;gap:8px;padding:8px;background:var(--vscode-editor-background);border-radius:6px}@media(max-width:700px){main{padding:14px}.metrics,.summary{grid-template-columns:1fr 1fr}.board{grid-template-columns:repeat(5,80vw)}}.hostChoice{display:none;margin-top:12px}.approvals{display:none;position:sticky;top:0;z-index:1;margin:12px 0;background:var(--vscode-editor-background)}.approvals.visible{display:block}.approval{margin:8px 0;padding:11px;border:1px solid var(--vscode-charts-orange);border-radius:8px}.approvalDetail{white-space:pre-wrap;margin:6px 0;font:12px/1.5 var(--vscode-editor-font-family)}.notice{display:none;position:sticky;top:0;z-index:1;margin:12px 0;padding:9px 11px;border-radius:8px;border:1px solid var(--vscode-panel-border)}.notice.visible{display:block}.notice.error{border-color:var(--vscode-charts-red)}.notice a{margin-left:8px}button[disabled]{opacity:.5;cursor:not-allowed}.hostChoice.visible{display:block}.hostChoice button{margin-right:8px}
</style></head><body><main><header class="top"><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle" class="sub">接続状態を確認しています。</p></div><button id="refresh">今すぐ同期</button></header><section id="hostChoice" class="hostChoice" aria-live="polite"></section><section id="metrics" class="metrics"></section><section id="approvals" class="approvals" aria-live="polite"></section><section id="notice" class="notice" aria-live="polite"></section><section class="summary"><article><small>要対応</small><strong id="urgentCount">0</strong></article><article><small>実行中</small><strong id="activeCount">0</strong></article><article><small>停滞</small><strong id="staleCount">0</strong></article></section><section class="panel"><div class="head"><h2>タスクボード</h2><div class="filters"><select id="filter"><option value="all">すべて</option><option value="urgent">要対応のみ</option><option value="stale">停滞のみ</option></select><span id="synced" class="muted"></span></div></div><div id="board" class="board" aria-live="polite"></div></section><section class="panel"><div class="head"><h2>オーケストレータ</h2><span id="state" class="muted">待機中</span></div><div id="chat" class="chat"></div><textarea id="input" placeholder="接続状態を確認しています。"></textarea><div class="actions"><button id="send" disabled>送信</button><button id="issuesButton" class="secondary">Issueを読み込む</button><span id="composerState" class="muted" aria-live="polite">接続状態を確認しています。整うまで送信できません。届かないときは「今すぐ同期」を押してください。</span></div><div id="issues" class="issues"></div></section></main><script nonce="${nonce}">const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id);let items=[],filter='all',snapshotReady=false,shownHost=null;const deciding=new Set(),DECIDABLE=['command','fileChange','permissions'];const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e};const button=(label,fn,cls)=>{const e=text('button',label,cls);e.type='button';e.onclick=fn;return e};const ago=v=>{const n=Date.now()-new Date(v).getTime(),m=Math.floor(n/60000);return m<1?'たった今':m<60?m+'分前':Math.floor(m/60)+'時間前'};const urgent=i=>i.status==='blocked'||i.sessionFailed||(i.reviewComments||[]).some(c=>!c.resolved);const stale=i=>Date.now()-new Date(i.updatedAt||i.startedAt).getTime()>1800000;const stage=i=>i.status==='cleanup'?5:i.pullRequestNumber===undefined?1:i.status==='ciPending'?3:i.status==='ci'?4:2;const show=all=>{items=all;const visible=items.filter(i=>filter==='all'||filter==='urgent'&&urgent(i)||filter==='stale'&&stale(i));$('urgentCount').textContent=items.filter(urgent).length;$('activeCount').textContent=items.filter(i=>i.sessionBusy).length;$('staleCount').textContent=items.filter(stale).length;const board=$('board');board.replaceChildren();const cols=[['urgent','要対応'],['inProgress','実装'],['review','PR/MR・レビュー'],['ci','CI・確認'],['cleanup','cleanup']];for(const [key,label] of cols){const col=text('section','', 'column '+(key==='urgent'?'urgent':''));col.append(text('h3',label));const entries=visible.filter(i=>key==='urgent'?urgent(i):key==='ci'?i.status==='ci'||i.status==='ciPending':i.status===key&&!urgent(i));if(!entries.length)col.append(text('p','該当なし','muted'));for(const i of entries){const card=text('article','', 'card '+(urgent(i)?'alert ':'')+(stale(i)?'stale':''));card.append(text('strong','#'+i.issue.number+' '+i.issue.title));const steps=text('div','step');for(let n=1;n<=5;n++)steps.append(text('span','',n<stage(i)?'done':n===stage(i)?'current':''));card.append(steps);const badges=text('div','badges');for(const v of [i.sessionBusy?'実行中':undefined,i.status==='blocked'?'要対応':undefined,i.ciMessage?'CI失敗':undefined,i.reviewCommentCount!==undefined?'レビュー '+i.reviewCommentCount+'件':undefined,stale(i)?'停滞':undefined])if(v)badges.append(text('span',v,'badge'));card.append(badges,text('span','次: '+(i.nextAction||'状態を確認する'),'muted'),text('span','最終更新 '+ago(i.updatedAt||i.startedAt),'time'));const actions=text('div','actions');actions.append(button('対応する',()=>vscode.postMessage({type:'runWorkAction',branch:i.branch})));if(i.sessionId)actions.append(button('会話',()=>vscode.postMessage({type:'openConversation',provider:i.provider,sessionId:i.sessionId}),'secondary'));if(i.pullRequestNumber===undefined)actions.append(trackedButton('Draft PR/MR','secondary','createDraftPullRequest:'+i.branch,'pullRequestResult','Draft PR/MRの作成',{type:'createDraftPullRequest',branch:i.branch}));else actions.append(trackedButton('CI更新','secondary','refreshCi:'+i.branch,'ciResult','CIの更新',{type:'refreshCi',branch:i.branch}));if(i.status==='cleanup')actions.append(trackedButton('cleanup完了を記録','','completeCleanup:'+i.branch,'cleanupResult','cleanupの記録',{type:'completeCleanup',branch:i.branch}));if(i.pullRequestUrl){const a=text('a','PR/MRを開く');a.href=i.pullRequestUrl;a.target='_blank';actions.append(a)}card.append(actions);col.append(card)}board.append(col)}};const showApprovals=list=>{const box=$('approvals');box.replaceChildren();box.classList.toggle('visible',list.length>0);const alive=new Set(list.map(a=>String(a.requestId)));for(const id of [...deciding])if(!alive.has(id))deciding.delete(id);for(const a of list){const card=text('article','', 'approval');card.append(text('strong',a.title));if(a.detail)card.append(text('pre',a.detail,'approvalDetail'));const actions=text('div','', 'actions');if(DECIDABLE.includes(a.kind)){const note=text('span','「この会話では常に許可」はこのオーケストレータ会話にだけ効きます。','muted');const buttons=[['許可','accept',''],['この会話では常に許可','acceptForSession','secondary'],['拒否','decline','secondary']].map(([label,decision,cls])=>button(label,()=>{for(const b of buttons)b.disabled=true;escape.hidden=false;note.textContent='応答しています。反映されないときは会話を開いて答えてください。';deciding.add(String(a.requestId));vscode.postMessage({type:'decideOrchestratorApproval',requestId:a.requestId,decision})},cls));const escape=button('会話を開く',()=>vscode.postMessage({type:'openOrchestratorConversation'}),'secondary');escape.hidden=!deciding.has(String(a.requestId));if(deciding.has(String(a.requestId))){for(const b of buttons)b.disabled=true;note.textContent='応答しています。反映されないときは会話を開いて答えてください。'}actions.append(...buttons,escape,note)}else{actions.append(text('span','この要求はForge Hubからは答えられません。会話を開いて答えてください。','muted'),button('会話を開く',()=>vscode.postMessage({type:'openOrchestratorConversation'}),'secondary'))}card.append(actions);box.append(card)}};const pending=new Map(),busyActions=new Set(),RESULT_LABELS={startResult:'着手',issueResult:'Issueの作成',planResult:'計画の作成',pullRequestResult:'Draft PR/MRの作成',ciResult:'CIの更新',cleanupResult:'cleanup',reviewResult:'レビューの取得',reviewActionResult:'レビュー対応'};let requestSeq=0,issues=[];const nextRequestId=()=>'forge-'+(++requestSeq);const safeUrl=v=>typeof v==='string'&&(v.startsWith('https://')||v.startsWith('http://'))?v:undefined;const notify=(message,ok,url)=>{const box=$('notice');box.replaceChildren(text('span',message));box.classList.toggle('error',ok===false);box.classList.add('visible');const href=safeUrl(url);if(href){const a=text('a','開く');a.href=href;a.target='_blank';box.append(a)}};const trackedButton=(label,cls,actionKey,expected,action,payload)=>{const b=button(label,()=>{if(busyActions.has(actionKey))return;busyActions.add(actionKey);b.disabled=true;const requestId=nextRequestId();pending.set(requestId,{expected,actionKey,action});notify(action+'を要求しました。',true);vscode.postMessage({...payload,requestId})},cls);b.disabled=busyActions.has(actionKey);return b};const showIssues=list=>{issues=list;$('issues').replaceChildren(...issues.map(i=>{const row=text('div','', 'issue');row.append(text('span','#'+i.number+' '+i.title),trackedButton('着手','','startIssue:'+i.number,'startResult','#'+i.number+'の着手',{type:'startIssue',number:i.number,title:i.title}));return row}))};const handleResult=d=>{const requestId=typeof d.requestId==='string'?d.requestId:undefined;const entry=requestId===undefined?undefined:pending.get(requestId);if(entry!==undefined&&entry.expected===d.type){pending.delete(requestId);busyActions.delete(entry.actionKey)}const action=entry!==undefined&&entry.expected===d.type?entry.action:Object.prototype.hasOwnProperty.call(RESULT_LABELS,d.type)?RESULT_LABELS[d.type]:'操作';if(d.cancelled||d.gone)notify(d.message||action+'を取り消しました。',true);else if(d.ok)notify(action+'が完了しました。',true,d.url);else notify(action+'に失敗しました: '+(typeof d.message==='string'&&d.message?d.message:'原因を特定できませんでした。'),false);show(items);showIssues(issues)};window.addEventListener('message',e=>{const d=e.data;if(Object.prototype.hasOwnProperty.call(RESULT_LABELS,d.type)){handleResult(d);return}if(d.type==='snapshot'){$('subtitle').textContent=(d.snapshot.host||'Forge未判定')+' / '+d.snapshot.cwd;const metrics=[];for(const [l,v] of [['Host',d.snapshot.host||'未判定'],['CLI',d.snapshot.prerequisites?.cliOnPath?'利用可能':'未検出'],['認証',d.snapshot.prerequisites?.authenticated?'確認済み':'未認証'],['同期','30秒ごと']]){const m=text('article','', 'metric');m.append(text('small',l),text('strong',v));metrics.push(m)}$('metrics').replaceChildren(...metrics);const host=d.snapshot.host||'';if(host!==shownHost){shownHost=host;const choice=$('hostChoice');choice.replaceChildren();choice.classList.toggle('visible',!host);if(!host){const notice=text('p','originからForgeを判定できません。操作するホストを選択してください。');const buttons=['github','gitlab'].map(h=>button(h==='github'?'GitHub':'GitLab',()=>{for(const b of buttons)b.disabled=true;notice.textContent='選んだHostで判定しています。';vscode.postMessage({type:'selectHost',host:h})},'secondary'));choice.append(notice,...buttons)}}else if(!host){const buttons=$('hostChoice').querySelectorAll('button');if(buttons.length&&buttons[0].disabled){for(const b of buttons)b.disabled=false;$('hostChoice').querySelector('p').textContent='選んだHostでは判定できませんでした。もう一度選んでください。'}}$('synced').textContent='同期 '+new Date().toLocaleTimeString();show(d.workItems||[]);if(!snapshotReady){snapshotReady=true;$('send').disabled=false;$('input').placeholder='次に進める作業を依頼';$('composerState').textContent=''}}if(d.type==='orchestrator'){const approvals=d.snapshot.approvals||[];$('state').textContent=approvals.length?'承認待ち・'+approvals.length+'件':d.snapshot.busy?'実行中':d.snapshot.turnFailed?'実行失敗':'待機中';showApprovals(approvals);if(d.snapshot.busy)$('composerState').textContent='';$('chat').replaceChildren(...d.snapshot.messages.map(m=>text('pre',m.text,'message')))}if(d.type==='issues'){showIssues(d.issues||[])}});$('refresh').onclick=()=>vscode.postMessage({type:'refresh'});$('filter').onchange=e=>{filter=e.target.value;show(items)};$('send').onclick=()=>{const note=$('composerState');if(!snapshotReady){note.textContent='接続状態を確認しています。表示が整うまで待ってください。';return}const v=$('input').value.trim();if(!v){note.textContent='送る内容を入力してください。';return}vscode.postMessage({type:'sendOrchestrator',text:v});$('input').value='';note.textContent='送信を要求しました。';};$('issuesButton').onclick=()=>vscode.postMessage({type:'listIssues'});vscode.postMessage({type:'ready'});</script></body></html>`;
}
