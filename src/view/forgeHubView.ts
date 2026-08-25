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

  constructor(
    private readonly service: ForgeHubService,
    private readonly cwd: () => string | undefined,
    private readonly orchestrator: ForgeOrchestrator,
    private readonly log: Logger,
  ) {
    orchestrator.onChanged((snapshot) => this.post({ type: 'orchestrator', snapshot }));
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
    this.log.info(`[forge-hub] ${provider}から開きました: ${cwd}`);
  }

  dispose(): void {
    this.panel?.dispose();
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
      this.snapshot = await this.service.inspect(this.snapshot.provider, this.snapshot.cwd);
      await this.service.refreshRemoteStates();
      this.postSnapshot();
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
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body><main><header><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle">GitHub/GitLabの状態を確認しています。</p></div><button id="refresh" type="button">更新</button></header><section class="status" id="status" aria-live="polite"></section><section class="hostChoice" id="hostChoice" aria-live="polite"></section><section class="panel orchestrator"><h2>Forgeオーケストレータ</h2><p id="orchestratorStatus">会話を開始すると、ここで進捗と確認要求を確認できます。</p><div id="orchestratorMessages" class="orchestratorMessages" aria-live="polite"></div><div id="orchestratorApprovals" class="orchestratorApprovals"></div><div class="composer"><textarea id="orchestratorInput" placeholder="例:#123を着手して、$gitlab-reviewでこのMRを確認して"></textarea><button id="sendOrchestrator" class="primary" type="button">送信</button></div></section><section class="boardWrap"><h2>Forgeカンバン</h2><div id="board" class="board" aria-label="Forge作業の状態"></div></section><section class="grid"><section class="panel"><h2>Issueを作成</h2><p>内容を確認後、GitHub/GitLabへIssueとして直接作成します。</p><label>タイトル<input id="title" required></label><label>labels（カンマ区切り）<input id="labels"></label><label>assignee（GitHub:username、GitLab:user ID。カンマ区切り）<input id="assignees"></label><label>milestone<input id="milestone"></label><label>着手前の現状（必須）<textarea id="currentState" required></textarea></label><label>非エンジニア向け概要<textarea id="overview"></textarea></label><label>エンジニア向け仕様・実装計画<textarea id="implementation"></textarea></label><label>確認者向け確認点<textarea id="verification"></textarea></label><button id="createIssue" class="primary" type="button">Issueを作成</button><p id="result" role="status"></p></section><section class="panel next"><h2>既存Issueから着手</h2><p>選択すると、隔離worktreeをcwdにした専用会話を開始します。</p><label>実装計画（選択したIssueへコメントとして残す）<textarea id="issuePlan"></textarea></label><button id="listIssues" type="button">Issueを読み込む</button><div id="issues" class="issues" aria-live="polite"></div><p id="startResult" role="status"></p></section></section></main><script nonce="${nonce}">${hostSelectionScript}${script}${reviewRefreshScript}${orchestratorScript}</script></body></html>`;
}

const orchestratorScript = `(()=>{const vscode=acquireVsCodeApi();const text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el};const render=snapshot=>{document.getElementById('orchestratorStatus').textContent=snapshot.busy?'実行中':snapshot.turnFailed?'直前の実行は失敗しました':'待機中';const messages=document.getElementById('orchestratorMessages');messages.replaceChildren();for(const message of snapshot.messages){messages.append(text('pre',message.text,'orchestratorMessage '+message.kind))}const approvals=document.getElementById('orchestratorApprovals');approvals.replaceChildren();for(const approval of snapshot.approvals){const card=text('div','', 'approval');card.append(text('strong',approval.title),text('p',approval.detail));for(const [label,decision] of [['許可','accept'],['今回だけ許可','acceptForSession'],['拒否','decline']]){const button=text('button',label);button.type='button';button.addEventListener('click',()=>vscode.postMessage({type:'decideOrchestratorApproval',requestId:approval.requestId,decision}));card.append(button)}approvals.append(card)}};window.addEventListener('message',event=>{if(event.data.type==='orchestrator')render(event.data.snapshot)});document.getElementById('sendOrchestrator').addEventListener('click',()=>{const input=document.getElementById('orchestratorInput');const value=input.value.trim();if(value==='')return;vscode.postMessage({type:'sendOrchestrator',text:value});input.value=''})})();`;

const hostSelectionScript = `(()=>{const vscode=acquireVsCodeApi();globalThis.acquireVsCodeApi=()=>vscode;window.addEventListener('message',event=>{const data=event.data;if(data.type!=='snapshot')return;const el=document.getElementById('hostChoice');el.replaceChildren();el.classList.toggle('visible',!data.snapshot.host);if(data.snapshot.host)return;const note=document.createElement('p');note.textContent='originからForgeを判定できません。操作するホストを選択してください。';el.append(note);for(const [host,label] of [['github','GitHubを選ぶ'],['gitlab','GitLabを選ぶ']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',()=>vscode.postMessage({type:'selectHost',host}));el.append(button)}})})();`;

const reviewRefreshScript = `(()=>{const vscode=acquireVsCodeApi();const labels={inProgress:'実装を続ける',review:'レビューを進める',ciPending:'CI完了を待つ',ci:'レビュー・マージ準備を進める',cleanup:'cleanupを進める',blocked:'ブロックを調査する'};window.addEventListener('message',event=>{const data=event.data;if(data.type==='reviewResult')document.getElementById('startResult').textContent=data.ok?'レビューを更新しました。':data.message;if(data.type==='reviewActionResult')document.getElementById('startResult').textContent=data.ok?'レビュー操作を完了しました。':data.message;if(data.type==='cleanupResult')document.getElementById('startResult').textContent=data.ok?'cleanup完了を記録しました。':data.message;if(data.type!=='snapshot')return;for(const item of data.workItems||[]){if(!item.branch)continue;for(const card of document.querySelectorAll('.workCard')){if(card.querySelector('.branch')?.textContent!==item.branch)continue;const actions=card.querySelector('.actions');actions.replaceChildren();const conversation=document.createElement('button');conversation.type='button';conversation.textContent='会話を開く';conversation.addEventListener('click',()=>vscode.postMessage({type:'openConversation',provider:item.provider,sessionId:item.sessionId}));actions.append(conversation);const button=document.createElement('button');button.type='button';button.textContent=labels[item.status]||'対応する';button.addEventListener('click',()=>vscode.postMessage({type:'runWorkAction',branch:item.branch}));actions.append(button);if(item.status==='cleanup'){const complete=document.createElement('button');complete.type='button';complete.textContent='cleanup完了を記録';complete.addEventListener('click',()=>vscode.postMessage({type:'completeCleanup',branch:item.branch}));actions.append(complete)}if(item.pullRequestUrl){const link=document.createElement('a');link.textContent='PR/MRを開く';link.href=item.pullRequestUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}if(item.reviewCommentCount!==undefined){const summary=document.createElement('span');summary.className='ciMessage';summary.textContent='レビューコメント: '+item.reviewCommentCount+'件';card.insertBefore(summary,actions)}if(item.reviewMessage){const message=document.createElement('span');message.className='ciMessage';message.textContent='レビュー: '+item.reviewMessage;card.insertBefore(message,actions)}for(const comment of item.reviewComments||[]){const note=document.createElement('div');note.className='ciMessage';note.textContent='@'+comment.author+': '+comment.body+(comment.resolved?'（解決済み）':'');if(comment.threadId&&!comment.resolved){const reply=document.createElement('button');reply.type='button';reply.textContent='返信';reply.addEventListener('click',()=>{const body=window.prompt('返信内容を入力してください');if(body&&body.trim()!=='')vscode.postMessage({type:'replyReviewThread',branch:item.branch,threadId:comment.threadId,body})});const resolve=document.createElement('button');resolve.type='button';resolve.textContent='解決';resolve.addEventListener('click',()=>vscode.postMessage({type:'resolveReviewThread',branch:item.branch,threadId:comment.threadId}));note.append(' ',reply,resolve)}card.insertBefore(note,actions)}}}})})();`;

const styles = `body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}main{max-width:1280px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:16px;align-items:start}.eyebrow{color:var(--vscode-textLink-foreground);font-size:11px;font-weight:700;letter-spacing:.11em;margin:0}h1{font-size:30px;margin:5px 0}h2{margin-top:0}.status{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin:24px 0}.metric,.warning,.hostChoice{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;background:var(--vscode-editorWidget-background)}.metric small,.meta,.branch,.path,.empty,.timestamp,.ciMessage{display:block;color:var(--vscode-descriptionForeground)}.metric strong{display:block;font-size:16px;margin-top:4px;overflow-wrap:anywhere}.warning{grid-column:1/-1;border-left:4px solid var(--vscode-charts-yellow)}.hostChoice{display:none;margin:16px 0}.hostChoice.visible{display:block}.hostChoice p{margin:0 0 10px}.boardWrap{margin:26px 0}.board{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:12px;overflow-x:auto}.column{min-height:160px;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 72%,transparent)}.column h3{margin:0 0 10px;font-size:14px}.workCard{display:grid;gap:7px;margin:9px 0;padding:11px;border-radius:8px;border-left:4px solid var(--vscode-charts-blue);background:var(--vscode-editor-background)}.workCard strong,.path,.ciMessage{overflow-wrap:anywhere}.meta,.branch,.path,.empty,.timestamp,.ciMessage{font-size:12px}.branch{font-family:var(--vscode-editor-font-family)}.actions{display:flex;flex-wrap:wrap;gap:6px}.actions a{color:var(--vscode-textLink-foreground);padding:7px 2px}.grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(240px,.8fr);gap:18px}.panel{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:20px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 78%,transparent)}label{display:grid;gap:6px;font-size:13px;font-weight:600;margin:14px 0}input,textarea{box-sizing:border-box;width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:6px;padding:8px;font:inherit}textarea{min-height:84px;resize:vertical}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:6px;padding:8px 12px;cursor:pointer;font:inherit}button:hover{background:var(--vscode-button-hoverBackground)}button.primary{margin-top:6px;font-weight:700}.issues{display:grid;gap:7px;margin-top:12px}.issueRow{display:flex;gap:6px}.issue{text-align:left;flex:1}.next{align-self:start;color:var(--vscode-descriptionForeground)}.next h2{color:var(--vscode-foreground)}#result{min-height:1.4em;overflow-wrap:anywhere}@media(max-width:760px){main{padding:16px}.grid,.status,.board{grid-template-columns:1fr}header{display:block}header button{margin-top:12px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

const script = `const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);function text(tag,value,cls){const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el}function button(label,callback){const el=text('button',label);el.type='button';el.addEventListener('click',callback);return el}function render(snapshot){$('subtitle').textContent=(snapshot.host?snapshot.host==='github'?'GitHub':'GitLab':'Forge未判定')+' / '+(snapshot.provider==='codex'?'Codex':'Claude Code')+' / '+snapshot.cwd;const status=$('status');status.replaceChildren();const pairs=[['Host',snapshot.host||'未判定'],['origin',snapshot.remoteUrl||'未検出'],['CLI',snapshot.prerequisites?(snapshot.prerequisites.cliOnPath?'利用可能':'見つからない'):'確認不可'],['認証',snapshot.prerequisites?(snapshot.prerequisites.authenticated?'確認済み':'未認証'):'確認不可']];for(const [label,value] of pairs){const card=text('div','metric');card.append(text('small',label),text('strong',value));status.append(card)}for(const warning of (snapshot.hostMessage?[snapshot.hostMessage]:(snapshot.prerequisites?.warnings||[]))){status.append(text('div',warning,'warning'))}}function renderBoard(items,unstartedIssues,planningIssues){const board=$('board');board.replaceChildren();const columns=[['unstarted','未着手','○'],['planning','計画・確認待ち','◌'],['inProgress','実装中','▶'],['review','レビュー待ち','⌕'],['ciPending','CI待ち','…'],['ci','CI成功','✓'],['cleanup','マージ済み・cleanup待ち','✓'],['blocked','ブロック','!']];for(const [status,label,icon] of columns){const column=text('section','', 'column');column.append(text('h3',icon+' '+label));const cards=status==='unstarted'?unstartedIssues:status==='planning'?planningIssues:items.filter(item=>item.status===status);if(cards.length===0)column.append(text('p','項目なし','empty'));for(const item of cards){const card=text('article','', 'workCard');card.setAttribute('aria-label','#'+item.issue.number+' '+item.issue.title+' '+label);card.append(text('strong','#'+item.issue.number+' '+item.issue.title),text('span',item.host?(item.host==='github'?'GitHub':'GitLab')+' ・ '+(item.provider==='codex'?'Codex':'Claude Code'):'未着手','meta'),...(item.branch?[text('span',item.branch,'branch'),text('span',item.cwd,'path'),text('span','最終更新: '+new Date(item.updatedAt||item.startedAt).toLocaleString(),'timestamp')]:[]));if(item.ciMessage)card.append(text('span','CI: '+item.ciMessage,'ciMessage'));if(item.pullRequestState)card.append(text('span','PR/MR: '+item.pullRequestState+(item.mergeable===undefined?'':item.mergeable?' / マージ可能':' / マージ不可')+(item.approvalsLeft===undefined?'':' / 承認残り: '+item.approvalsLeft),'ciMessage'));if(item.pullRequestMessage)card.append(text('span','PR/MR: '+item.pullRequestMessage,'ciMessage'));const actions=text('div','actions');if(status==='unstarted'||status==='planning')actions.append(button('着手する',()=>vscode.postMessage({type:'startIssue',number:item.issue.number,title:item.issue.title})));if(status==='inProgress')actions.append(button('Draft PR/MRを作成',()=>vscode.postMessage({type:'createDraftPullRequest',branch:item.branch})));if(item.pullRequestNumber!==undefined)actions.append(button('CI状態を更新',()=>vscode.postMessage({type:'refreshCi',branch:item.branch})));if(item.pullRequestUrl){const link=text('a','PR/MRを開く');link.href=item.pullRequestUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}card.append(actions);column.append(card)}board.append(column)}}function draft(){return {title:$('title').value,currentState:$('currentState').value,overview:$('overview').value,implementation:$('implementation').value,verification:$('verification').value,labels:$('labels').value,assignees:$('assignees').value,milestone:$('milestone').value}}function renderIssues(issues){const list=$('issues');list.replaceChildren();if(issues.length===0){list.append(text('p','開いているIssueはありません。'));return}for(const issue of issues){const row=text('div','', 'issueRow');const issueButton=button('#'+issue.number+' '+issue.title,()=>vscode.postMessage({type:'startIssue',number:issue.number,title:issue.title}));issueButton.className='issue';const planButton=button('計画を反映',()=>vscode.postMessage({type:'postIssuePlan',number:issue.number,title:issue.title,plan:$('issuePlan').value}));row.append(issueButton,planButton);list.append(row)}}window.addEventListener('message',event=>{const data=event.data;if(data.type==='snapshot'){render(data.snapshot);renderBoard(data.workItems||[],data.unstartedIssues||[],data.planningIssues||[])}if(data.type==='issues')renderIssues(data.issues);if(data.type==='pullRequestResult'||data.type==='ciResult')$('startResult').textContent=data.ok?(data.type==='ciResult'?'CI状態を更新しました。':'Draft PR/MRを作成しました。'):data.message;if(data.type==='startResult')$('startResult').textContent=data.ok?'会話を開始しました: '+data.branch+' / '+data.cwd:data.message;if(data.type==='planResult')$('startResult').textContent=data.ok?'実装計画をIssueへ反映しました。':data.message;if(data.type==='issueResult'){$('result').replaceChildren();if(data.ok){$('result').append(text('span','Issueを作成しました。 '));if(data.url){const link=text('a',data.url);link.href=data.url;link.target='_blank';link.rel='noreferrer';$('result').append(link)}}else $('result').textContent=data.message}});$('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));$('listIssues').addEventListener('click',()=>vscode.postMessage({type:'listIssues'}));$('createIssue').addEventListener('click',()=>vscode.postMessage({type:'createIssue',...draft()}));vscode.postMessage({type:'ready'});`;
