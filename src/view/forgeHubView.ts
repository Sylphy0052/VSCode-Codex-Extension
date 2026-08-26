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
      this.panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(message));
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
      const item = this.service
        .listWorkItems()
        .find((candidate) => candidate.branch === message['branch']);
      if (item === undefined) return;
      const confirmed = await vscode.window.showWarningMessage(
        `#${item.issue.number}のIssue close・branch/worktree削除などのcleanup完了を確認しましたか。Hubからこのカードを外します。`,
        { modal: true },
        '完了を記録する',
      );
      if (confirmed !== '完了を記録する') return;
      const result = await this.service.completeCleanup(item.branch);
      this.post(
        result.ok
          ? { type: 'cleanupResult', ok: true }
          : { type: 'cleanupResult', ok: false, message: result.message },
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
      if (confirmation !== '作成する') return;
      const result = await this.service.createDraftPullRequest(message['branch']);
      this.post(
        result.ok
          ? { type: 'pullRequestResult', ok: true, url: result.url }
          : { type: 'pullRequestResult', ok: false, message: result.message },
      );
      this.postSnapshot();
      return;
    }
    if (message.type === 'refreshCi' && typeof message['branch'] === 'string') {
      const result = await this.service.refreshCi(message['branch']);
      this.post(
        result.ok
          ? { type: 'ciResult', ok: true }
          : { type: 'ciResult', ok: false, message: result.message },
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
    if (message.type === 'startIssue' && this.snapshot !== undefined) {
      const issue = readIssue(message);
      if (issue === undefined) return;
      const confirmed = await vscode.window.showWarningMessage(
        `#${issue.number}の隔離worktreeを作成し、Forgeオーケストレータへ着手を依頼します。`,
        { modal: true },
        '着手する',
      );
      if (confirmed !== '着手する') return;
      const result = await this.service.createIssueWorktree(this.snapshot, issue);
      if (!result.ok) {
        this.post({ type: 'startResult', ok: false, message: result.message });
        return;
      }
      const sessionId = await this.orchestrator.startWork(
        this.snapshot.provider,
        result.cwd,
        `issue-${String(issue.number)}`,
        `${buildIssueStartPrompt(this.snapshot.host, issue.number)}\n作業ディレクトリは\`${result.cwd}\`です。\n\n${
          this.snapshot.host === 'gitlab'
            ? `$gitlab-develop #${issue.number}`
            : `GitHub Issue #${issue.number}に着手してください。`
        }`,
      );
      await this.service.recordStartedWork(this.snapshot, issue, result, sessionId);
      this.post({ type: 'startResult', ok: true, cwd: result.cwd, branch: result.branch });
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
  return renderFocusedDashboard(webview, nonce);
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
  *{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}main{max-width:1180px;margin:auto;padding:24px}.top{display:flex;justify-content:space-between;align-items:start;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--vscode-panel-border)}.eyebrow{margin:0 0 7px;color:var(--vscode-textLink-foreground);font-size:11px;font-weight:800;letter-spacing:.12em}h1{margin:0;font-size:30px}h2{margin:0;font-size:17px}.sub{margin:9px 0 0;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0}.metric,.panel{border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editorWidget-background)}.metric{padding:13px 15px}.metric small,.task small{display:block;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.metric strong{display:block;margin-top:7px;font-size:14px;overflow-wrap:anywhere}.panel{padding:18px;margin-top:14px}.panelHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.badge{padding:5px 9px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:12px;font-weight:700}.badge.running{color:var(--vscode-testing-iconQueued)}.badge.failed{color:var(--vscode-testing-iconFailed)}.chat{height:380px;overflow:auto;padding:8px;border:1px solid var(--vscode-input-border);border-radius:8px;background:var(--vscode-editor-background)}.message{margin:7px 0;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid var(--vscode-textLink-foreground);border-radius:4px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 82%,transparent);font:12px/1.55 var(--vscode-editor-font-family)}.message.userMessage{border-color:var(--vscode-charts-green)}.empty{margin:14px;color:var(--vscode-descriptionForeground)}.approval{margin-top:8px;padding:11px;border:1px solid var(--vscode-charts-yellow);border-radius:7px}.approval p{margin:7px 0;color:var(--vscode-descriptionForeground);font-size:12px}.compose{display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:12px}textarea{min-height:72px;width:100%;resize:vertical;padding:10px;border:1px solid var(--vscode-input-border);border-radius:7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}button{border:0;border-radius:6px;padding:8px 11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.flow{display:flex;align-items:stretch;gap:8px;overflow-x:auto;padding:3px}.node{flex:1 0 132px;position:relative;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-editor-background);text-align:center}.node:not(:last-child)::after{content:'→';position:absolute;right:-15px;top:24px;z-index:1;color:var(--vscode-textLink-foreground);font-size:18px}.node strong{display:block;font-size:24px}.node small{display:block;margin-top:4px;color:var(--vscode-descriptionForeground)}.tasks{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:9px;margin-top:15px}.task{padding:12px;border-left:3px solid var(--vscode-textLink-foreground);border-radius:7px;background:var(--vscode-editor-background)}.task strong{display:block;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}.choice{margin-top:10px;padding:10px;border:1px solid var(--vscode-charts-yellow);border-radius:7px}.hidden{display:none}@media(max-width:760px){main{padding:16px}.top{display:block}.top button{margin-top:12px}.metrics{grid-template-columns:1fr 1fr}.compose{grid-template-columns:1fr auto}.compose textarea{grid-column:1/-1}}@media(max-width:440px){.metrics{grid-template-columns:1fr}.compose{grid-template-columns:1fr}.compose button{width:100%}}
  </style></head><body><main><header class="top"><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle" class="sub">接続状態を確認しています。</p></div><button id="refresh">最新状態に更新</button></header><section id="metrics" class="metrics"></section><section class="panel"><div class="panelHead"><h2>オーケストレータとの対話</h2><span id="state" class="badge">待機中</span></div><div id="chat" class="chat" aria-live="polite"></div><div id="approvals"></div><div class="compose"><textarea id="input" placeholder="例: #574に着手して。現在の進捗を確認して次の作業を進めて"></textarea><button id="send">送信</button><button id="interrupt" class="secondary">中断</button></div></section><section class="panel"><div class="panelHead"><h2>タスク進捗</h2><span id="count" class="badge">0件</span></div><div id="flow" class="flow" aria-label="タスク進捗グラフ"></div><div id="tasks" class="tasks"></div><div id="choice" class="choice hidden"></div></section></main><script nonce="${nonce}">const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id),labels={inProgress:'実装',review:'レビュー',ciPending:'CI待ち',ci:'準備完了',cleanup:'cleanup',blocked:'ブロック'};const t=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e},b=(label,on,cls)=>{const e=t('button',label,cls);e.addEventListener('click',on);return e},host=h=>h==='github'?'GitHub':h==='gitlab'?'GitLab':'未判定';const showSnapshot=s=>{ $('subtitle').textContent=host(s.host)+' / '+(s.provider==='codex'?'Codex':'Claude Code')+' / '+s.cwd;const metrics=$('metrics');metrics.replaceChildren();for(const [l,v] of [['Host',host(s.host)],['origin',s.remoteUrl||'未検出'],['CLI',s.prerequisites?.cliOnPath?'利用可能':'見つからない'],['認証',s.prerequisites?.authenticated?'確認済み':'未認証']]){const m=t('article','', 'metric');m.append(t('small',l),t('strong',v));metrics.append(m)}const choice=$('choice');choice.replaceChildren();choice.classList.toggle('hidden',!!s.host);if(!s.host){choice.append(t('strong','操作先を選択'));for(const [h,l] of [['github','GitHub'],['gitlab','GitLab']])choice.append(b(l,()=>vscode.postMessage({type:'selectHost',host:h})))}};const showChat=s=>{const state=$('state');state.textContent=s.busy?'実行中':s.turnFailed?'実行失敗':'待機中';state.className='badge '+(s.busy?'running':s.turnFailed?'failed':'');$('interrupt').disabled=!s.busy;const chat=$('chat');chat.replaceChildren();if(!s.messages.length)chat.append(t('p','オーケストレータへ依頼すると、実行状況と応答がここに表示されます。','empty'));for(const m of s.messages)chat.append(t('pre',m.text,'message '+m.kind));chat.scrollTop=chat.scrollHeight;const approvals=$('approvals');approvals.replaceChildren();for(const a of s.approvals){const c=t('article','', 'approval');c.append(t('strong',a.title),t('p',a.detail));for(const [l,d] of [['許可','accept'],['今回だけ許可','acceptForSession'],['拒否','decline']])c.append(b(l,()=>vscode.postMessage({type:'decideOrchestratorApproval',requestId:a.requestId,decision:d})));approvals.append(c)}};const showTasks=items=>{ $('count').textContent=items.length+'件';const flow=$('flow');flow.replaceChildren();for(const key of ['inProgress','review','ciPending','ci','cleanup','blocked']){const n=t('div','', 'node');n.append(t('strong',String(items.filter(i=>i.status===key).length)),t('small',labels[key]));flow.append(n)}const tasks=$('tasks');tasks.replaceChildren();if(!items.length)tasks.append(t('p','追跡中の作業はありません。依頼は上のオーケストレータへ送信してください。','empty'));for(const i of items){const c=t('article','', 'task');c.append(t('strong','#'+i.issue.number+' '+i.issue.title),t('small',(labels[i.status]||i.status)+' ・ '+(i.branch||'ブランチ未設定')));const a=t('div','', 'actions');a.append(b('対応する',()=>vscode.postMessage({type:'runWorkAction',branch:i.branch})));if(i.sessionId)a.append(b('会話を開く',()=>vscode.postMessage({type:'openConversation',provider:i.provider,sessionId:i.sessionId}),'secondary'));if(i.pullRequestNumber!==undefined)a.append(b('CI更新',()=>vscode.postMessage({type:'refreshCi',branch:i.branch}),'secondary'));c.append(a);tasks.append(c)}};window.addEventListener('message',e=>{const d=e.data;if(d.type==='snapshot'){showSnapshot(d.snapshot);showTasks(d.workItems||[])}if(d.type==='orchestrator')showChat(d.snapshot)});$('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));const send=()=>{const i=$('input'),v=i.value.trim();if(v){vscode.postMessage({type:'sendOrchestrator',text:v});i.value=''}};$('send').addEventListener('click',send);$('input').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();send()}});$('interrupt').addEventListener('click',()=>vscode.postMessage({type:'interruptOrchestrator'}));vscode.postMessage({type:'ready'});</script></body></html>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
  *{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}main{max-width:1480px;margin:auto;padding:26px}.top{display:flex;justify-content:space-between;gap:16px;align-items:start;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:20px}.eyebrow{margin:0 0 8px;color:var(--vscode-textLink-foreground);font-size:11px;font-weight:800;letter-spacing:.13em}h1{margin:0;font-size:32px}h2{margin:0;font-size:16px}.subtitle{margin:9px 0 0;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere}.connection{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.metric,.panel{border:1px solid var(--vscode-panel-border);border-radius:12px;background:var(--vscode-editorWidget-background)}.metric{padding:14px 16px}.metric small,.card small{display:block;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.metric strong{display:block;margin-top:7px;font-size:14px;overflow-wrap:anywhere}.dashboard{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(360px,.75fr);gap:16px}.panel{padding:18px}.header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}.state{border-radius:999px;padding:5px 9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:12px;font-weight:700}.state.running{color:var(--vscode-testing-iconQueued)}.state.failed{color:var(--vscode-testing-iconFailed)}.chat{height:380px;overflow:auto;padding:8px;border:1px solid var(--vscode-input-border);border-radius:8px;background:var(--vscode-editor-background)}.empty{margin:14px;color:var(--vscode-descriptionForeground)}.message{margin:7px 0;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid var(--vscode-textLink-foreground);border-radius:5px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 82%,transparent);font:12px/1.55 var(--vscode-editor-font-family)}.message.userMessage{border-color:var(--vscode-charts-green)}.approval{margin-top:9px;padding:11px;border:1px solid var(--vscode-charts-yellow);border-radius:8px}.approval p{margin:7px 0;color:var(--vscode-descriptionForeground);font-size:12px}.compose{display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:12px}textarea{min-height:76px;width:100%;resize:vertical;padding:10px;border:1px solid var(--vscode-input-border);border-radius:7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}button{border:0;border-radius:6px;padding:8px 11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.graph{display:grid;grid-template-columns:repeat(6,minmax(100px,1fr));gap:0;align-items:center;overflow:auto;padding:12px 0}.node{position:relative;min-width:100px;padding:12px 10px;text-align:center;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-editor-background)}.node:not(:last-child)::after{content:'›';position:absolute;right:-15px;top:9px;z-index:1;color:var(--vscode-textLink-foreground);font-size:24px}.node strong{display:block;font-size:22px}.node small{color:var(--vscode-descriptionForeground)}.worklist{display:grid;gap:8px;margin-top:14px;max-height:260px;overflow:auto}.card{display:grid;grid-template-columns:1fr auto;gap:8px;padding:12px;border-left:3px solid var(--vscode-textLink-foreground);border-radius:7px;background:var(--vscode-editor-background)}.card strong{overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.hostChoice{margin-top:14px;padding:11px;border:1px solid var(--vscode-charts-yellow);border-radius:8px}.hidden{display:none}@media(max-width:900px){main{padding:16px}.connection,.dashboard{grid-template-columns:1fr 1fr}.dashboard{gap:12px}.compose{grid-template-columns:1fr auto}.compose textarea{grid-column:1/-1}}@media(max-width:650px){.top{display:block}.top button{margin-top:12px}.connection,.dashboard{grid-template-columns:1fr}.graph{grid-template-columns:repeat(6,120px)}}
  </style></head><body><main><header class="top"><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle" class="subtitle">接続状態を確認しています。</p></div><button id="refresh">最新状態に更新</button></header><section id="connection" class="connection"></section><div class="dashboard"><section class="panel"><div class="header"><h2>オーケストレータとの対話</h2><span id="state" class="state">待機中</span></div><div id="chat" class="chat" aria-live="polite"></div><div id="approvals"></div><div class="compose"><textarea id="input" placeholder="例: #574に着手して。現在の進捗を確認して次の作業を進めて"></textarea><button id="send">送信</button><button id="interrupt" class="secondary">中断</button></div></section><section class="panel"><div class="header"><h2>タスク進捗グラフ</h2><span id="count" class="state">0件</span></div><div id="graph" class="graph" aria-label="タスク進捗"></div><div id="worklist" class="worklist"></div><div id="hostChoice" class="hostChoice hidden"></div></section></div></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);const t=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e};const b=(label,on,cls)=>{const e=t('button',label,cls);e.type='button';e.addEventListener('click',on);return e};const host=h=>h==='github'?'GitHub':h==='gitlab'?'GitLab':'未判定';const labels={inProgress:'実装',review:'レビュー',ciPending:'CI待ち',ci:'準備完了',cleanup:'cleanup',blocked:'ブロック'};let tasks=[];const showConnection=s=>{ $('subtitle').textContent=host(s.host)+' / '+(s.provider==='codex'?'Codex':'Claude Code')+' / '+s.cwd;const box=$('connection');box.replaceChildren();for(const [l,v] of [['Host',host(s.host)],['origin',s.remoteUrl||'未検出'],['CLI',s.prerequisites?.cliOnPath?'利用可能':'見つからない'],['認証',s.prerequisites?.authenticated?'確認済み':'未認証']]){const m=t('article','', 'metric');m.append(t('small',l),t('strong',v));box.append(m)}const choice=$('hostChoice');choice.replaceChildren();choice.classList.toggle('hidden',!!s.host);if(!s.host){choice.append(t('strong','操作先を選択'));for(const [h,l] of [['github','GitHub'],['gitlab','GitLab']])choice.append(b(l,()=>vscode.postMessage({type:'selectHost',host:h})))}};const showChat=s=>{const state=$('state');state.textContent=s.busy?'実行中':s.turnFailed?'実行失敗':'待機中';state.className='state '+(s.busy?'running':s.turnFailed?'failed':'');$('interrupt').disabled=!s.busy;const chat=$('chat');chat.replaceChildren();if(!s.messages.length)chat.append(t('p','オーケストレータへ依頼すると、実行状況と応答がここに表示されます。','empty'));for(const m of s.messages)chat.append(t('pre',m.text,'message '+m.kind));chat.scrollTop=chat.scrollHeight;const approvals=$('approvals');approvals.replaceChildren();for(const a of s.approvals){const c=t('article','', 'approval');c.append(t('strong',a.title),t('p',a.detail));for(const [l,d] of [['許可','accept'],['今回だけ許可','acceptForSession'],['拒否','decline']])c.append(b(l,()=>vscode.postMessage({type:'decideOrchestratorApproval',requestId:a.requestId,decision:d})));approvals.append(c)}};const showTasks=items=>{tasks=items;$('count').textContent=items.length+'件';const graph=$('graph');graph.replaceChildren();for(const key of ['inProgress','review','ciPending','ci','cleanup','blocked']){const n=t('div','', 'node');n.append(t('strong',String(items.filter(x=>x.status===key).length)),t('small',labels[key]));graph.append(n)}const list=$('worklist');list.replaceChildren();if(!items.length)list.append(t('p','追跡中の作業はありません。依頼は左のオーケストレータへ送信してください。','empty'));for(const item of items){const c=t('article','', 'card');const body=t('div','');body.append(t('strong','#'+item.issue.number+' '+item.issue.title),t('small',(labels[item.status]||item.status)+' ・ '+(item.branch||'ブランチ未設定')));const act=t('div','', 'actions');act.append(b('対応する',()=>vscode.postMessage({type:'runWorkAction',branch:item.branch})));if(item.sessionId)act.append(b('会話を開く',()=>vscode.postMessage({type:'openConversation',provider:item.provider,sessionId:item.sessionId}),'secondary'));if(item.pullRequestNumber!==undefined)act.append(b('CI更新',()=>vscode.postMessage({type:'refreshCi',branch:item.branch}),'secondary'));body.append(act);c.append(body);list.append(c)}};window.addEventListener('message',e=>{const d=e.data;if(d.type==='snapshot'){showConnection(d.snapshot);showTasks(d.workItems||[])}if(d.type==='orchestrator')showChat(d.snapshot)});$('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));const send=()=>{const input=$('input'),value=input.value.trim();if(!value)return;vscode.postMessage({type:'sendOrchestrator',text:value});input.value=''};$('send').addEventListener('click',send);$('input').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();send()}});$('interrupt').addEventListener('click',()=>vscode.postMessage({type:'interruptOrchestrator'}));vscode.postMessage({type:'ready'});</script></body></html>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}main{max-width:1440px;margin:auto;padding:28px}.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:22px}.eyebrow{color:var(--vscode-textLink-foreground);font-size:11px;font-weight:800;letter-spacing:.14em;margin:0 0 8px}h1{font-size:32px;letter-spacing:-.02em;margin:0}h2{font-size:16px;margin:0}.subtitle{color:var(--vscode-descriptionForeground);margin:10px 0 0;overflow-wrap:anywhere}.refresh{white-space:nowrap}.connection{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:22px 0}.metric{min-width:0;padding:15px 16px;border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editorWidget-background)}.metricLabel{display:block;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.metricValue{display:block;margin-top:7px;font-size:14px;font-weight:650;overflow-wrap:anywhere}.layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,.65fr);gap:16px}.panel{border:1px solid var(--vscode-panel-border);border-radius:12px;background:var(--vscode-editorWidget-background);padding:20px}.panelHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.state{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:5px 9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:12px;font-weight:700}.state::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}.state.running{color:var(--vscode-testing-iconQueued)}.state.failed{color:var(--vscode-testing-iconFailed)}.conversation{min-height:280px;max-height:540px;overflow:auto;border:1px solid var(--vscode-input-border);border-radius:8px;background:var(--vscode-editor-background);padding:8px}.empty{color:var(--vscode-descriptionForeground);margin:16px}.message{margin:7px 0;padding:11px 12px;white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid var(--vscode-textLink-foreground);border-radius:4px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 80%,transparent);font-family:var(--vscode-editor-font-family);font-size:12px;line-height:1.5}.message.userMessage{border-left-color:var(--vscode-charts-green)}.composer{display:flex;gap:10px;margin-top:12px}.composer textarea{min-height:76px;flex:1}.primary{font-weight:700}.approvals{display:grid;gap:8px;margin-top:12px}.approval{padding:12px;border:1px solid var(--vscode-charts-yellow);border-radius:8px}.approval p{color:var(--vscode-descriptionForeground);font-size:12px;margin:7px 0}.approvalActions{display:flex;flex-wrap:wrap;gap:6px}.summaryList{display:grid;gap:10px}.summaryItem{padding:12px;border-radius:8px;background:var(--vscode-editor-background)}.summaryItem small,.workMeta{display:block;color:var(--vscode-descriptionForeground);font-size:12px}.summaryItem strong{display:block;margin-top:4px;overflow-wrap:anywhere}.hostChoice{display:none;margin-top:12px;padding:12px;border:1px solid var(--vscode-charts-yellow);border-radius:8px}.hostChoice.visible{display:block}.boardSection{margin-top:16px}.board{display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:12px;overflow:auto;padding-bottom:4px}.column{min-width:220px;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 68%,transparent)}.column h3{font-size:13px;margin:0 0 10px}.workCard{display:grid;gap:9px;margin-top:8px;padding:12px;border-radius:8px;background:var(--vscode-editor-background);border-left:3px solid var(--vscode-textLink-foreground)}.workCard strong{overflow-wrap:anywhere}.workActions{display:flex;flex-wrap:wrap;gap:6px}button{border:0;border-radius:6px;padding:8px 11px;font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}textarea{width:100%;resize:vertical;border:1px solid var(--vscode-input-border);border-radius:7px;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}@media(max-width:900px){main{padding:18px}.connection,.layout{grid-template-columns:1fr 1fr}.layout{gap:12px}}@media(max-width:620px){.topbar,.composer{display:grid}.connection,.layout{grid-template-columns:1fr}.board{grid-template-columns:repeat(4,82vw)}}
  </style></head><body><main><header class="topbar"><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle" class="subtitle">接続情報を確認しています。</p></div><button id="refresh" class="refresh" type="button">最新状態に更新</button></header><section id="connection" class="connection" aria-label="接続状態"></section><div class="layout"><section class="panel"><div class="panelHeader"><h2>オーケストレータ</h2><span id="orchestratorState" class="state">待機中</span></div><div id="conversation" class="conversation" aria-live="polite"></div><div id="approvals" class="approvals"></div><div class="composer"><textarea id="input" placeholder="例: #574に着手して。現在の進捗を確認して次の作業を進めて"></textarea><button id="send" class="primary" type="button">送信</button></div></section><aside class="panel"><div class="panelHeader"><h2>ワークスペース</h2></div><div id="workspaceSummary" class="summaryList"></div><div id="hostChoice" class="hostChoice"></div></aside></div><section class="panel boardSection"><div class="panelHeader"><h2>進行中の作業</h2><span id="workCount" class="state">0件</span></div><div id="board" class="board" aria-label="Forge作業の状態"></div></section></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);const text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el};const button=(label,handler)=>{const el=text('button',label);el.type='button';el.addEventListener('click',handler);return el};const hostName=host=>host==='github'?'GitHub':host==='gitlab'?'GitLab':'未判定';const statusLabels={inProgress:'実装中',review:'レビュー待ち',ciPending:'CI待ち',ci:'確認・マージ準備',cleanup:'cleanup待ち',blocked:'ブロック'};let workItems=[];const renderSnapshot=snapshot=>{ $('subtitle').textContent=hostName(snapshot.host)+' / '+(snapshot.provider==='codex'?'Codex':'Claude Code')+' / '+snapshot.cwd;const connection=$('connection');connection.replaceChildren();for(const [label,value] of [['Host',hostName(snapshot.host)],['origin',snapshot.remoteUrl||'未検出'],['CLI',snapshot.prerequisites?.cliOnPath?'利用可能':'見つからない'],['認証',snapshot.prerequisites?.authenticated?'確認済み':'未認証']]){const card=text('article','', 'metric');card.append(text('span',label,'metricLabel'),text('strong',value,'metricValue'));connection.append(card)}const summary=$('workspaceSummary');summary.replaceChildren();for(const [label,value] of [['プロバイダ',snapshot.provider==='codex'?'Codex':'Claude Code'],['作業ディレクトリ',snapshot.cwd],['リモート',snapshot.remoteUrl||'未検出']]){const item=text('div','', 'summaryItem');item.append(text('small',label),text('strong',value));summary.append(item)}const choice=$('hostChoice');choice.replaceChildren();choice.classList.toggle('visible',!snapshot.host);if(!snapshot.host){choice.append(text('p','操作先を選択してください。'));for(const [host,label] of [['github','GitHub'],['gitlab','GitLab']])choice.append(button(label,()=>vscode.postMessage({type:'selectHost',host})))} };const renderOrchestrator=snapshot=>{const state=$('orchestratorState');state.textContent=snapshot.busy?'実行中':snapshot.turnFailed?'実行失敗':'待機中';state.className='state '+(snapshot.busy?'running':snapshot.turnFailed?'failed':'');const conversation=$('conversation');conversation.replaceChildren();if(!snapshot.messages.length)conversation.append(text('p','オーケストレータへ依頼すると、ここに進捗と応答を表示します。','empty'));for(const message of snapshot.messages)conversation.append(text('pre',message.text,'message '+message.kind));conversation.scrollTop=conversation.scrollHeight;const approvals=$('approvals');approvals.replaceChildren();for(const approval of snapshot.approvals){const card=text('article','', 'approval');card.append(text('strong',approval.title),text('p',approval.detail));const actions=text('div','', 'approvalActions');for(const [label,decision] of [['許可','accept'],['今回だけ許可','acceptForSession'],['拒否','decline']])actions.append(button(label,()=>vscode.postMessage({type:'decideOrchestratorApproval',requestId:approval.requestId,decision})));card.append(actions);approvals.append(card)}};const renderBoard=items=>{workItems=items;$('workCount').textContent=items.length+'件';const board=$('board');board.replaceChildren();for(const status of ['inProgress','review','ciPending','ci','cleanup','blocked']){const column=text('section','', 'column');column.append(text('h3',statusLabels[status]||status));const entries=items.filter(item=>item.status===status);if(!entries.length)column.append(text('p','該当なし','empty'));for(const item of entries){const card=text('article','', 'workCard');card.append(text('strong','#'+item.issue.number+' '+item.issue.title),text('span',(item.host?hostName(item.host)+' ・ ':'')+(item.branch||''),'workMeta'),text('span',item.ciMessage||item.pullRequestMessage||'更新待ち','workMeta'));const actions=text('div','', 'workActions');actions.append(button('対応する',()=>vscode.postMessage({type:'runWorkAction',branch:item.branch})));if(item.sessionId)actions.append(button('会話を開く',()=>vscode.postMessage({type:'openConversation',provider:item.provider,sessionId:item.sessionId})));if(item.pullRequestNumber!==undefined)actions.append(button('CI更新',()=>vscode.postMessage({type:'refreshCi',branch:item.branch})));card.append(actions);column.append(card)}board.append(column)}};window.addEventListener('message',event=>{const data=event.data;if(data.type==='snapshot'){renderSnapshot(data.snapshot);renderBoard(data.workItems||[])}if(data.type==='orchestrator')renderOrchestrator(data.snapshot);if(data.type==='reviewResult'||data.type==='ciResult'||data.type==='reviewActionResult'||data.type==='cleanupResult')renderBoard(workItems)});$('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));$('send').addEventListener('click',()=>{const input=$('input');const value=input.value.trim();if(!value)return;vscode.postMessage({type:'sendOrchestrator',text:value});input.value='' });vscode.postMessage({type:'ready'});</script></body></html>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body><main><header><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle">GitHub/GitLabの状態を確認しています。</p></div><button id="refresh" type="button">更新</button></header><section class="status" id="status" aria-live="polite"></section><section class="hostChoice" id="hostChoice" aria-live="polite"></section><section class="panel orchestrator"><h2>Forgeオーケストレータ</h2><p id="orchestratorStatus">会話を開始すると、ここで進捗と確認要求を確認できます。</p><div id="orchestratorMessages" class="orchestratorMessages" aria-live="polite"></div><div id="orchestratorApprovals" class="orchestratorApprovals"></div><div class="composer"><textarea id="orchestratorInput" placeholder="例:#123を着手して、$gitlab-reviewでこのMRを確認して"></textarea><button id="sendOrchestrator" class="primary" type="button">送信</button></div></section><section class="boardWrap"><h2>Forgeカンバン</h2><div id="board" class="board" aria-label="Forge作業の状態"></div></section><section class="grid"><section class="panel"><h2>Issueを作成</h2><p>内容を確認後、GitHub/GitLabへIssueとして直接作成します。</p><label>タイトル<input id="title" required></label><label>labels（カンマ区切り）<input id="labels"></label><label>assignee（GitHub:username、GitLab:user ID。カンマ区切り）<input id="assignees"></label><label>milestone<input id="milestone"></label><label>着手前の現状（必須）<textarea id="currentState" required></textarea></label><label>非エンジニア向け概要<textarea id="overview"></textarea></label><label>エンジニア向け仕様・実装計画<textarea id="implementation"></textarea></label><label>確認者向け確認点<textarea id="verification"></textarea></label><button id="createIssue" class="primary" type="button">Issueを作成</button><p id="result" role="status"></p></section><section class="panel next"><h2>既存Issueから着手</h2><p>選択すると、隔離worktreeをcwdにした専用会話を開始します。</p><label>実装計画（選択したIssueへコメントとして残す）<textarea id="issuePlan"></textarea></label><button id="listIssues" type="button">Issueを読み込む</button><div id="issues" class="issues" aria-live="polite"></div><p id="startResult" role="status"></p></section></section></main><script nonce="${nonce}">${hostSelectionScript}${script}${reviewRefreshScript}${orchestratorScript}</script></body></html>`;
}

export function renderLiveDashboard(webview: vscode.Webview, nonce: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><style>
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}main{max-width:1500px;margin:auto;padding:24px}.top,.head,.actions,.filters{display:flex;align-items:center;gap:10px}.top,.head{justify-content:space-between}.top{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:16px}.eyebrow{margin:0;color:var(--vscode-textLink-foreground);font-size:11px;font-weight:700;letter-spacing:.12em}h1{margin:4px 0;font-size:30px}h2,h3{margin:0}.sub,.muted{color:var(--vscode-descriptionForeground)}button,select,textarea{font:inherit}button{border:0;border-radius:6px;padding:7px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.metric,.panel,.column{border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editorWidget-background)}.metric{padding:12px}.metric small,.badge,.time{display:block;color:var(--vscode-descriptionForeground);font-size:11px}.metric strong{display:block;margin-top:5px;overflow-wrap:anywhere}.panel{padding:14px;margin-top:12px}.urgent{border-color:var(--vscode-testing-iconFailed)}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.summary article{padding:12px;border-left:4px solid var(--vscode-textLink-foreground);background:var(--vscode-editor-background);border-radius:6px}.summary strong{font-size:24px}.board{display:grid;grid-template-columns:repeat(5,minmax(250px,1fr));gap:10px;overflow-x:auto;padding:4px 0}.column{min-height:170px;padding:10px}.column.urgent{border-color:var(--vscode-testing-iconFailed)}.card{display:grid;gap:8px;margin-top:9px;padding:11px;border-radius:7px;background:var(--vscode-editor-background);border-left:4px solid var(--vscode-charts-blue)}.card.alert{border-left-color:var(--vscode-testing-iconFailed)}.card.stale{outline:1px dashed var(--vscode-charts-yellow)}.badges{display:flex;flex-wrap:wrap;gap:5px}.badge{padding:3px 6px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.step{display:grid;grid-template-columns:repeat(5,1fr);gap:2px}.step span{height:4px;background:var(--vscode-panel-border)}.step span.done{background:var(--vscode-charts-green)}.step span.current{background:var(--vscode-progressBar-background)}.chat{max-height:230px;overflow:auto;background:var(--vscode-editor-background);border-radius:7px;padding:7px}.message{white-space:pre-wrap;margin:6px 0;padding:7px;border-left:3px solid var(--vscode-textLink-foreground);font:12px/1.5 var(--vscode-editor-font-family)}textarea{box-sizing:border-box;width:100%;min-height:62px;margin-top:8px;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:6px}.issues{display:grid;gap:6px;margin-top:10px}.issue{display:flex;justify-content:space-between;gap:8px;padding:8px;background:var(--vscode-editor-background);border-radius:6px}@media(max-width:700px){main{padding:14px}.metrics,.summary{grid-template-columns:1fr 1fr}.board{grid-template-columns:repeat(5,80vw)}}
</style></head><body><main><header class="top"><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle" class="sub">接続状態を確認しています。</p></div><button id="refresh">今すぐ同期</button></header><section id="metrics" class="metrics"></section><section class="summary"><article><small>要対応</small><strong id="urgentCount">0</strong></article><article><small>実行中</small><strong id="activeCount">0</strong></article><article><small>停滞</small><strong id="staleCount">0</strong></article></section><section class="panel"><div class="head"><h2>タスクボード</h2><div class="filters"><select id="filter"><option value="all">すべて</option><option value="urgent">要対応のみ</option><option value="stale">停滞のみ</option></select><span id="synced" class="muted"></span></div></div><div id="board" class="board" aria-live="polite"></div></section><section class="panel"><div class="head"><h2>オーケストレータ</h2><span id="state" class="muted">待機中</span></div><div id="chat" class="chat"></div><textarea id="input" placeholder="次に進める作業を依頼"></textarea><div class="actions"><button id="send">送信</button><button id="issuesButton" class="secondary">Issueを読み込む</button></div><div id="issues" class="issues"></div></section></main><script nonce="${nonce}">const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id);let items=[],filter='all';const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e};const button=(label,fn,cls)=>{const e=text('button',label,cls);e.type='button';e.onclick=fn;return e};const ago=v=>{const n=Date.now()-new Date(v).getTime(),m=Math.floor(n/60000);return m<1?'たった今':m<60?m+'分前':Math.floor(m/60)+'時間前'};const urgent=i=>i.status==='blocked'||i.sessionFailed||(i.reviewComments||[]).some(c=>!c.resolved);const stale=i=>Date.now()-new Date(i.updatedAt||i.startedAt).getTime()>1800000;const stage=i=>i.status==='cleanup'?5:i.pullRequestNumber===undefined?1:i.status==='ciPending'?3:i.status==='ci'?4:2;const show=all=>{items=all;const visible=items.filter(i=>filter==='all'||filter==='urgent'&&urgent(i)||filter==='stale'&&stale(i));$('urgentCount').textContent=items.filter(urgent).length;$('activeCount').textContent=items.filter(i=>i.sessionBusy).length;$('staleCount').textContent=items.filter(stale).length;const board=$('board');board.replaceChildren();const cols=[['urgent','要対応'],['inProgress','実装'],['review','PR/MR・レビュー'],['ci','CI・確認'],['cleanup','cleanup']];for(const [key,label] of cols){const col=text('section','', 'column '+(key==='urgent'?'urgent':''));col.append(text('h3',label));const entries=visible.filter(i=>key==='urgent'?urgent(i):key==='ci'?i.status==='ci'||i.status==='ciPending':i.status===key&&!urgent(i));if(!entries.length)col.append(text('p','該当なし','muted'));for(const i of entries){const card=text('article','', 'card '+(urgent(i)?'alert ':'')+(stale(i)?'stale':''));card.append(text('strong','#'+i.issue.number+' '+i.issue.title));const steps=text('div','step');for(let n=1;n<=5;n++)steps.append(text('span','',n<stage(i)?'done':n===stage(i)?'current':''));card.append(steps);const badges=text('div','badges');for(const v of [i.sessionBusy?'実行中':undefined,i.status==='blocked'?'要対応':undefined,i.ciMessage?'CI失敗':undefined,i.reviewCommentCount!==undefined?'レビュー '+i.reviewCommentCount+'件':undefined,stale(i)?'停滞':undefined])if(v)badges.append(text('span',v,'badge'));card.append(badges,text('span','次: '+(i.nextAction||'状態を確認する'),'muted'),text('span','最終更新 '+ago(i.updatedAt||i.startedAt),'time'));const actions=text('div','actions');actions.append(button('対応する',()=>vscode.postMessage({type:'runWorkAction',branch:i.branch})));if(i.sessionId)actions.append(button('会話',()=>vscode.postMessage({type:'openConversation',provider:i.provider,sessionId:i.sessionId}),'secondary'));if(i.pullRequestNumber===undefined)actions.append(button('Draft PR/MR',()=>vscode.postMessage({type:'createDraftPullRequest',branch:i.branch}),'secondary'));else actions.append(button('CI更新',()=>vscode.postMessage({type:'refreshCi',branch:i.branch}),'secondary'));if(i.pullRequestUrl){const a=text('a','PR/MRを開く');a.href=i.pullRequestUrl;a.target='_blank';actions.append(a)}card.append(actions);col.append(card)}board.append(col)}};window.addEventListener('message',e=>{const d=e.data;if(d.type==='snapshot'){$('subtitle').textContent=(d.snapshot.host||'Forge未判定')+' / '+d.snapshot.cwd;for(const [l,v] of [['Host',d.snapshot.host||'未判定'],['CLI',d.snapshot.prerequisites?.cliOnPath?'利用可能':'未検出'],['認証',d.snapshot.prerequisites?.authenticated?'確認済み':'未認証'],['同期','30秒ごと']]){const m=text('article','', 'metric');m.append(text('small',l),text('strong',v));$('metrics').replaceChildren(...Array.from(document.getElementById('metrics').children),m)}$('synced').textContent='同期 '+new Date().toLocaleTimeString();show(d.workItems||[])}if(d.type==='orchestrator'){ $('state').textContent=d.snapshot.busy?'実行中':d.snapshot.turnFailed?'実行失敗':'待機中';$('chat').replaceChildren(...d.snapshot.messages.map(m=>text('pre',m.text,'message')))}if(d.type==='issues'){$('issues').replaceChildren(...d.issues.map(i=>{const row=text('div','', 'issue');row.append(text('span','#'+i.number+' '+i.title),button('着手',()=>vscode.postMessage({type:'startIssue',number:i.number,title:i.title})));return row}))}});$('refresh').onclick=()=>vscode.postMessage({type:'refresh'});$('filter').onchange=e=>{filter=e.target.value;show(items)};$('send').onclick=()=>{const v=$('input').value.trim();if(v){vscode.postMessage({type:'sendOrchestrator',text:v});$('input').value=''}};$('issuesButton').onclick=()=>vscode.postMessage({type:'listIssues'});vscode.postMessage({type:'ready'});</script></body></html>`;
}

function renderFocusedDashboard(webview: vscode.Webview, nonce: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><style>
*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}main{max-width:960px;margin:auto;padding:24px}.top{display:flex;justify-content:space-between;align-items:start;gap:16px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:18px}.eyebrow{margin:0;color:var(--vscode-textLink-foreground);font-size:11px;font-weight:800;letter-spacing:.13em}h1{margin:5px 0;font-size:30px}.subtitle,.muted,.meta{color:var(--vscode-descriptionForeground)}.subtitle{margin:0;overflow-wrap:anywhere}.headerActions,.actions,.tabs{display:flex;gap:8px;flex-wrap:wrap}button{border:0;border-radius:6px;padding:8px 11px;font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover,button.active{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.focus,.panel{margin-top:16px;padding:18px;border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editorWidget-background)}.focus{border-left:4px solid var(--vscode-textLink-foreground)}.focusHeader{display:flex;align-items:center;justify-content:space-between;gap:10px}.label{color:var(--vscode-descriptionForeground);font-size:12px;font-weight:700}.focus h2{margin:8px 0 6px;font-size:20px;overflow-wrap:anywhere}.meta{font-size:12px;margin:5px 0}.actions{margin-top:13px}.count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;padding:1px 6px;border-radius:99px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:12px}.tabs{margin:13px 0}.tabs button{color:var(--vscode-foreground);background:transparent;border:1px solid var(--vscode-panel-border)}.tabs button.active{border-color:var(--vscode-textLink-foreground);color:var(--vscode-textLink-foreground)}.list{display:grid;gap:8px}.card{padding:13px;border-radius:8px;background:var(--vscode-editor-background);border-left:3px solid var(--vscode-charts-blue)}.card.urgent{border-left-color:var(--vscode-testing-iconFailed)}.card strong{display:block;overflow-wrap:anywhere}.empty{margin:8px 0;color:var(--vscode-descriptionForeground)}details{margin-top:16px}summary{cursor:pointer;color:var(--vscode-descriptionForeground)}.hostChoice{display:none;margin-top:12px}.hostChoice.visible{display:block}.notice{min-height:1.4em;margin-top:12px;color:var(--vscode-descriptionForeground)}@media(max-width:600px){main{padding:16px}.top{display:block}.headerActions{margin-top:12px}.focusHeader{align-items:start;flex-direction:column}}
</style></head><body><main><header class="top"><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle" class="subtitle">接続状態を確認しています。</p></div><div class="headerActions"><button id="refresh" type="button">同期</button><button id="listIssues" class="secondary" type="button">Issueを再読込</button></div></header><section id="hostChoice" class="hostChoice"></section><section id="focus" class="focus" aria-live="polite"></section><section class="panel"><div class="focusHeader"><div><span class="label">進行状況</span><h2>作業一覧</h2></div><span id="summary" class="muted"></span></div><nav id="tabs" class="tabs" aria-label="作業状態で絞り込む"></nav><div id="list" class="list"></div><p id="notice" class="notice" role="status"></p></section><details><summary>この画面について</summary><p class="muted">Forge Hubは次に進める作業を選ぶ画面です。実装・調査・レビュー対応は「会話を開く」から既存の会話で行います。</p></details></main><script nonce="${nonce}">const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id);const text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el};const button=(label,fn,cls)=>{const el=text('button',label,cls);el.type='button';el.onclick=fn;return el};const labels={urgent:'要対応',inProgress:'実装',review:'PR/MR・レビュー',ci:'CI・確認',cleanup:'cleanup',unstarted:'未着手'};let data={items:[],unstarted:[],planning:[]},filter='all';const urgent=item=>item.status==='blocked'||item.sessionFailed||(item.reviewComments||[]).some(comment=>!comment.resolved);const status=item=>urgent(item)?'urgent':item.status==='ciPending'||item.status==='ci'?'ci':item.status;const actionLabel=item=>item.status==='cleanup'?'cleanupを進める':item.status==='review'||item.status==='ci'||item.status==='ciPending'?'レビューを進める':item.status==='blocked'?'ブロックを調査する':'実装を続ける';const appendActions=(card,item,unstarted)=>{const actions=text('div','actions');if(unstarted){actions.append(button('このIssueに着手',()=>vscode.postMessage({type:'startIssue',number:item.number,title:item.title})));card.append(actions);return}actions.append(button('会話を開く',()=>vscode.postMessage({type:'openConversation',provider:item.provider,sessionId:item.sessionId})),button(actionLabel(item),()=>vscode.postMessage({type:'runWorkAction',branch:item.branch}),'secondary'));if(item.pullRequestNumber!==undefined)actions.append(button('CIを更新',()=>vscode.postMessage({type:'refreshCi',branch:item.branch}),'secondary'));if(item.pullRequestUrl){const link=text('a','PR/MRを開く');link.href=item.pullRequestUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}card.append(actions)};const card=(item,unstarted=false)=>{const el=text('article','', 'card '+(!unstarted&&urgent(item)?'urgent':''));const title=unstarted?'#'+item.number+' '+item.title:'#'+item.issue.number+' '+item.issue.title;el.append(text('strong',title),text('p',unstarted?'未着手':(item.nextAction||labels[status(item)]||'状態を確認する'),'meta'));if(!unstarted){if(item.pullRequestNumber!==undefined)el.append(text('p','PR/MR #'+item.pullRequestNumber+(item.reviewCommentCount===undefined?'':'・未解決レビュー '+item.reviewCommentCount+'件'),'meta'));el.append(text('p','最終更新 '+new Date(item.updatedAt||item.startedAt).toLocaleString(),'meta'))}appendActions(el,item,unstarted);return el};const renderFocus=()=>{const focus=$('focus');focus.replaceChildren();const item=data.items.find(urgent)||data.items.find(x=>x.sessionBusy)||data.items[0]||(data.planning[0]&&{number:data.planning[0].issue.number,title:data.planning[0].issue.title,planned:true})||data.unstarted[0];if(!item){focus.append(text('span','次に進めること','label'),text('h2','進行中の作業はありません'),text('p','Issueを再読込して、着手する作業を選んでください。','meta'));return}const unstarted=!item.issue;focus.append(text('span','次に進めること','label'),text('h2',unstarted?'#'+item.number+' '+item.title:'#'+item.issue.number+' '+item.issue.title),text('p',unstarted?'未着手のIssueです。会話を開始すると隔離worktreeで作業します。':(item.nextAction||actionLabel(item)),'meta'));appendActions(focus,item,unstarted)};const renderList=()=>{const entries=[...data.items,...data.planning.map(item=>({number:item.issue.number,title:item.issue.title,planned:true}),),...data.unstarted.map(item=>({...item,status:'unstarted'}),)];const counts={urgent:data.items.filter(urgent).length,inProgress:data.items.filter(item=>!urgent(item)&&item.status==='inProgress').length,review:data.items.filter(item=>!urgent(item)&&(item.status==='review')).length,ci:data.items.filter(item=>!urgent(item)&&(item.status==='ci'||item.status==='ciPending')).length,cleanup:data.items.filter(item=>!urgent(item)&&item.status==='cleanup').length,unstarted:data.unstarted.length+data.planning.length};$('summary').textContent=data.items.length+'件を追跡中';const tabs=$('tabs');tabs.replaceChildren();for(const key of ['all','urgent','inProgress','review','ci','cleanup','unstarted']){const count=key==='all'?entries.length:counts[key];const label=key==='all'?'すべて':labels[key];tabs.append(button(label+' '+count,()=>{filter=key;renderList()},key===filter?'active':''))}const list=$('list');list.replaceChildren();const visible=entries.filter(item=>filter==='all'||filter==='unstarted'?filter==='all'||!item.issue:filter==='urgent'?urgent(item):status(item)===filter);if(!visible.length){list.append(text('p','該当する作業はありません。','empty'));return}for(const item of visible)list.append(card(item,!item.issue))};const showSnapshot=message=>{data={items:message.workItems||[],unstarted:message.unstartedIssues||[],planning:message.planningIssues||[]};const snapshot=message.snapshot;$('subtitle').textContent=(snapshot.host==='github'?'GitHub':snapshot.host==='gitlab'?'GitLab':'Forge未判定')+' / '+snapshot.cwd;const choice=$('hostChoice');choice.replaceChildren();choice.classList.toggle('visible',!snapshot.host);if(!snapshot.host){choice.append(text('p','操作先を選択してください。','meta'));for(const host of ['github','gitlab'])choice.append(button(host==='github'?'GitHub':'GitLab',()=>vscode.postMessage({type:'selectHost',host}))) }renderFocus();renderList()};window.addEventListener('message',event=>{const message=event.data;if(message.type==='snapshot')showSnapshot(message);if(message.type==='startResult'||message.type==='ciResult'||message.type==='cleanupResult'||message.type==='reviewResult')$('notice').textContent=message.ok?'更新しました。':message.message});$('refresh').onclick=()=>vscode.postMessage({type:'refresh'});$('listIssues').onclick=()=>vscode.postMessage({type:'listIssues'});vscode.postMessage({type:'ready'});</script></body></html>`;
}

const orchestratorScript = `(()=>{const vscode=acquireVsCodeApi();const text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el};const render=snapshot=>{document.getElementById('orchestratorStatus').textContent=snapshot.busy?'実行中':snapshot.turnFailed?'直前の実行は失敗しました':'待機中';const messages=document.getElementById('orchestratorMessages');messages.replaceChildren();for(const message of snapshot.messages){messages.append(text('pre',message.text,'orchestratorMessage '+message.kind))}const approvals=document.getElementById('orchestratorApprovals');approvals.replaceChildren();for(const approval of snapshot.approvals){const card=text('div','', 'approval');card.append(text('strong',approval.title),text('p',approval.detail));for(const [label,decision] of [['許可','accept'],['今回だけ許可','acceptForSession'],['拒否','decline']]){const button=text('button',label);button.type='button';button.addEventListener('click',()=>vscode.postMessage({type:'decideOrchestratorApproval',requestId:approval.requestId,decision}));card.append(button)}approvals.append(card)}};window.addEventListener('message',event=>{if(event.data.type==='orchestrator')render(event.data.snapshot)});document.getElementById('sendOrchestrator').addEventListener('click',()=>{const input=document.getElementById('orchestratorInput');const value=input.value.trim();if(value==='')return;vscode.postMessage({type:'sendOrchestrator',text:value});input.value=''})})();`;

const hostSelectionScript = `(()=>{const vscode=acquireVsCodeApi();window.addEventListener('message',event=>{const data=event.data;if(data.type!=='snapshot')return;const el=document.getElementById('hostChoice');el.replaceChildren();el.classList.toggle('visible',!data.snapshot.host);if(data.snapshot.host)return;const note=document.createElement('p');note.textContent='originからForgeを判定できません。操作するホストを選択してください。';el.append(note);for(const [host,label] of [['github','GitHubを選ぶ'],['gitlab','GitLabを選ぶ']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',()=>vscode.postMessage({type:'selectHost',host}));el.append(button)}})})();`;

const reviewRefreshScript = `(()=>{const vscode=acquireVsCodeApi();const labels={inProgress:'実装を続ける',review:'レビューを進める',ciPending:'CI完了を待つ',ci:'レビュー・マージ準備を進める',cleanup:'cleanupを進める',blocked:'ブロックを調査する'};window.addEventListener('message',event=>{const data=event.data;if(data.type==='reviewResult')document.getElementById('startResult').textContent=data.ok?'レビューを更新しました。':data.message;if(data.type==='reviewActionResult')document.getElementById('startResult').textContent=data.ok?'レビュー操作を完了しました。':data.message;if(data.type==='cleanupResult')document.getElementById('startResult').textContent=data.ok?'cleanup完了を記録しました。':data.message;if(data.type!=='snapshot')return;for(const item of data.workItems||[]){if(!item.branch)continue;for(const card of document.querySelectorAll('.workCard')){if(card.querySelector('.branch')?.textContent!==item.branch)continue;const actions=card.querySelector('.actions');actions.replaceChildren();const conversation=document.createElement('button');conversation.type='button';conversation.textContent='会話を開く';conversation.addEventListener('click',()=>vscode.postMessage({type:'openConversation',provider:item.provider,sessionId:item.sessionId}));actions.append(conversation);const button=document.createElement('button');button.type='button';button.textContent=labels[item.status]||'対応する';button.addEventListener('click',()=>vscode.postMessage({type:'runWorkAction',branch:item.branch}));actions.append(button);if(item.status==='cleanup'){const complete=document.createElement('button');complete.type='button';complete.textContent='cleanup完了を記録';complete.addEventListener('click',()=>vscode.postMessage({type:'completeCleanup',branch:item.branch}));actions.append(complete)}if(item.pullRequestUrl){const link=document.createElement('a');link.textContent='PR/MRを開く';link.href=item.pullRequestUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}if(item.reviewCommentCount!==undefined){const summary=document.createElement('span');summary.className='ciMessage';summary.textContent='レビューコメント: '+item.reviewCommentCount+'件';card.insertBefore(summary,actions)}if(item.reviewMessage){const message=document.createElement('span');message.className='ciMessage';message.textContent='レビュー: '+item.reviewMessage;card.insertBefore(message,actions)}for(const comment of item.reviewComments||[]){const note=document.createElement('div');note.className='ciMessage';note.textContent='@'+comment.author+': '+comment.body+(comment.resolved?'（解決済み）':'');if(comment.threadId&&!comment.resolved){const reply=document.createElement('button');reply.type='button';reply.textContent='返信';reply.addEventListener('click',()=>{const body=window.prompt('返信内容を入力してください');if(body&&body.trim()!=='')vscode.postMessage({type:'replyReviewThread',branch:item.branch,threadId:comment.threadId,body})});const resolve=document.createElement('button');resolve.type='button';resolve.textContent='解決';resolve.addEventListener('click',()=>vscode.postMessage({type:'resolveReviewThread',branch:item.branch,threadId:comment.threadId}));note.append(' ',reply,resolve)}card.insertBefore(note,actions)}}}})})();`;

const styles = `body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}main{max-width:1280px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:16px;align-items:start}.eyebrow{color:var(--vscode-textLink-foreground);font-size:11px;font-weight:700;letter-spacing:.11em;margin:0}h1{font-size:30px;margin:5px 0}h2{margin-top:0}.status{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin:24px 0}.metric,.warning,.hostChoice{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;background:var(--vscode-editorWidget-background)}.metric small,.meta,.branch,.path,.empty,.timestamp,.ciMessage{display:block;color:var(--vscode-descriptionForeground)}.metric strong{display:block;font-size:16px;margin-top:4px;overflow-wrap:anywhere}.warning{grid-column:1/-1;border-left:4px solid var(--vscode-charts-yellow)}.hostChoice{display:none;margin:16px 0}.hostChoice.visible{display:block}.hostChoice p{margin:0 0 10px}.boardWrap{margin:26px 0}.board{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:12px;overflow-x:auto}.column{min-height:160px;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 72%,transparent)}.column h3{margin:0 0 10px;font-size:14px}.workCard{display:grid;gap:7px;margin:9px 0;padding:11px;border-radius:8px;border-left:4px solid var(--vscode-charts-blue);background:var(--vscode-editor-background)}.workCard strong,.path,.ciMessage{overflow-wrap:anywhere}.meta,.branch,.path,.empty,.timestamp,.ciMessage{font-size:12px}.branch{font-family:var(--vscode-editor-font-family)}.actions{display:flex;flex-wrap:wrap;gap:6px}.actions a{color:var(--vscode-textLink-foreground);padding:7px 2px}.grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(240px,.8fr);gap:18px}.panel{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:20px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 78%,transparent)}label{display:grid;gap:6px;font-size:13px;font-weight:600;margin:14px 0}input,textarea{box-sizing:border-box;width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:6px;padding:8px;font:inherit}textarea{min-height:84px;resize:vertical}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:6px;padding:8px 12px;cursor:pointer;font:inherit}button:hover{background:var(--vscode-button-hoverBackground)}button.primary{margin-top:6px;font-weight:700}.issues{display:grid;gap:7px;margin-top:12px}.issueRow{display:flex;gap:6px}.issue{text-align:left;flex:1}.next{align-self:start;color:var(--vscode-descriptionForeground)}.next h2{color:var(--vscode-foreground)}#result{min-height:1.4em;overflow-wrap:anywhere}@media(max-width:760px){main{padding:16px}.grid,.status,.board{grid-template-columns:1fr}header{display:block}header button{margin-top:12px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

const script = `const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);function text(tag,value,cls){const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el}function button(label,callback){const el=text('button',label);el.type='button';el.addEventListener('click',callback);return el}function render(snapshot){$('subtitle').textContent=(snapshot.host?snapshot.host==='github'?'GitHub':'GitLab':'Forge未判定')+' / '+(snapshot.provider==='codex'?'Codex':'Claude Code')+' / '+snapshot.cwd;const status=$('status');status.replaceChildren();const pairs=[['Host',snapshot.host||'未判定'],['origin',snapshot.remoteUrl||'未検出'],['CLI',snapshot.prerequisites?(snapshot.prerequisites.cliOnPath?'利用可能':'見つからない'):'確認不可'],['認証',snapshot.prerequisites?(snapshot.prerequisites.authenticated?'確認済み':'未認証'):'確認不可']];for(const [label,value] of pairs){const card=text('div','metric');card.append(text('small',label),text('strong',value));status.append(card)}for(const warning of (snapshot.hostMessage?[snapshot.hostMessage]:(snapshot.prerequisites?.warnings||[]))){status.append(text('div',warning,'warning'))}}function renderBoard(items,unstartedIssues,planningIssues){const board=$('board');board.replaceChildren();const columns=[['unstarted','未着手','○'],['planning','計画・確認待ち','◌'],['inProgress','実装中','▶'],['review','レビュー待ち','⌕'],['ciPending','CI待ち','…'],['ci','CI成功','✓'],['cleanup','マージ済み・cleanup待ち','✓'],['blocked','ブロック','!']];for(const [status,label,icon] of columns){const column=text('section','', 'column');column.append(text('h3',icon+' '+label));const cards=status==='unstarted'?unstartedIssues:status==='planning'?planningIssues:items.filter(item=>item.status===status);if(cards.length===0)column.append(text('p','項目なし','empty'));for(const item of cards){const card=text('article','', 'workCard');card.setAttribute('aria-label','#'+item.issue.number+' '+item.issue.title+' '+label);card.append(text('strong','#'+item.issue.number+' '+item.issue.title),text('span',item.host?(item.host==='github'?'GitHub':'GitLab')+' ・ '+(item.provider==='codex'?'Codex':'Claude Code'):'未着手','meta'),...(item.branch?[text('span',item.branch,'branch'),text('span',item.cwd,'path'),text('span','最終更新: '+new Date(item.updatedAt||item.startedAt).toLocaleString(),'timestamp')]:[]));if(item.ciMessage)card.append(text('span','CI: '+item.ciMessage,'ciMessage'));if(item.pullRequestState)card.append(text('span','PR/MR: '+item.pullRequestState+(item.mergeable===undefined?'':item.mergeable?' / マージ可能':' / マージ不可')+(item.approvalsLeft===undefined?'':' / 承認残り: '+item.approvalsLeft),'ciMessage'));if(item.pullRequestMessage)card.append(text('span','PR/MR: '+item.pullRequestMessage,'ciMessage'));const actions=text('div','actions');if(status==='unstarted'||status==='planning')actions.append(button('着手する',()=>vscode.postMessage({type:'startIssue',number:item.issue.number,title:item.issue.title})));if(status==='inProgress')actions.append(button('Draft PR/MRを作成',()=>vscode.postMessage({type:'createDraftPullRequest',branch:item.branch})));if(item.pullRequestNumber!==undefined)actions.append(button('CI状態を更新',()=>vscode.postMessage({type:'refreshCi',branch:item.branch})));if(item.pullRequestUrl){const link=text('a','PR/MRを開く');link.href=item.pullRequestUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}card.append(actions);column.append(card)}board.append(column)}}function draft(){return {title:$('title').value,currentState:$('currentState').value,overview:$('overview').value,implementation:$('implementation').value,verification:$('verification').value,labels:$('labels').value,assignees:$('assignees').value,milestone:$('milestone').value}}function renderIssues(issues){const list=$('issues');list.replaceChildren();if(issues.length===0){list.append(text('p','開いているIssueはありません。'));return}for(const issue of issues){const row=text('div','', 'issueRow');const issueButton=button('#'+issue.number+' '+issue.title,()=>vscode.postMessage({type:'startIssue',number:issue.number,title:issue.title}));issueButton.className='issue';const planButton=button('計画を反映',()=>vscode.postMessage({type:'postIssuePlan',number:issue.number,title:issue.title,plan:$('issuePlan').value}));row.append(issueButton,planButton);list.append(row)}}window.addEventListener('message',event=>{const data=event.data;if(data.type==='snapshot'){render(data.snapshot);renderBoard(data.workItems||[],data.unstartedIssues||[],data.planningIssues||[])}if(data.type==='issues')renderIssues(data.issues);if(data.type==='pullRequestResult'||data.type==='ciResult')$('startResult').textContent=data.ok?(data.type==='ciResult'?'CI状態を更新しました。':'Draft PR/MRを作成しました。'):data.message;if(data.type==='startResult')$('startResult').textContent=data.ok?'会話を開始しました: '+data.branch+' / '+data.cwd:data.message;if(data.type==='planResult')$('startResult').textContent=data.ok?'実装計画をIssueへ反映しました。':data.message;if(data.type==='issueResult'){$('result').replaceChildren();if(data.ok){$('result').append(text('span','Issueを作成しました。 '));if(data.url){const link=text('a',data.url);link.href=data.url;link.target='_blank';link.rel='noreferrer';$('result').append(link)}}else $('result').textContent=data.message}});$('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));$('listIssues').addEventListener('click',()=>vscode.postMessage({type:'listIssues'}));$('createIssue').addEventListener('click',()=>vscode.postMessage({type:'createIssue',...draft()}));vscode.postMessage({type:'ready'});`;
