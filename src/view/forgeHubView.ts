import * as vscode from 'vscode';
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

  constructor(
    private readonly service: ForgeHubService,
    private readonly cwd: () => string | undefined,
    private readonly openConversation: (
      provider: ForgeHubProvider,
      cwd: string,
      prompt: string,
    ) => Promise<string | undefined>,
    private readonly revealConversation: (provider: ForgeHubProvider, sessionId: string) => void,
    private readonly log: Logger,
  ) {}

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
      });
      this.panel.webview.html = render(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(message));
    } else {
      this.panel.reveal();
    }
    this.snapshot = await this.service.inspect(provider, cwd);
    this.postSnapshot();
    this.log.info(`[forge-hub] ${provider}から開きました: ${cwd}`);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async receive(message: unknown): Promise<void> {
    if (!isRecord(message) || this.panel === undefined) return;
    if (message.type === 'ready') {
      this.postSnapshot();
      return;
    }
    if (message.type === 'refresh' && this.snapshot !== undefined) {
      this.snapshot = await this.service.inspect(this.snapshot.provider, this.snapshot.cwd);
      this.postSnapshot();
      return;
    }
    if (message.type === 'listIssues' && this.snapshot !== undefined) {
      this.post({ type: 'issues', issues: await this.service.listIssues(this.snapshot) });
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
    if (
      message.type === 'openConversation' &&
      (message['provider'] === 'codex' || message['provider'] === 'claude') &&
      typeof message['sessionId'] === 'string'
    ) {
      this.revealConversation(message['provider'], message['sessionId']);
      return;
    }
    if (message.type === 'startIssue' && this.snapshot !== undefined) {
      const issue = readIssue(message);
      if (issue === undefined) return;
      const confirmation = await vscode.window.showWarningMessage(
        `#${issue.number}の隔離worktreeを作り、${this.snapshot.provider === 'codex' ? 'Codex' : 'Claude Code'}会話を開始します。`,
        { modal: true },
        '着手する',
      );
      if (confirmation !== '着手する') return;
      const result = await this.service.createIssueWorktree(this.snapshot, issue);
      if (!result.ok) {
        this.post({ type: 'startResult', ok: false, message: result.message });
        return;
      }
      const sessionId = await this.openConversation(
        this.snapshot.provider,
        result.cwd,
        buildIssueStartPrompt(this.snapshot.host, issue.number),
      );
      if (sessionId !== undefined) {
        await this.service.recordStartedWork(this.snapshot, issue, result, sessionId);
      }
      this.post(
        sessionId === undefined
          ? {
              type: 'startResult',
              ok: false,
              message: '会話を開始できませんでした。worktreeは残してあります。',
            }
          : { type: 'startResult', ok: true, cwd: result.cwd, branch: result.branch },
      );
      this.postSnapshot();
      return;
    }
    if (message.type !== 'createIssue' || this.snapshot === undefined) return;
    const draft = readDraft(message);
    if (draft === undefined) {
      this.post({ type: 'issueResult', ok: false, message: 'Issueの入力が不正です。' });
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `「${draft.title}」を${this.snapshot.host ?? 'Forge'}へIssueとして作成します。`,
      { modal: true },
      '作成する',
    );
    if (confirmation !== '作成する') return;
    const result = await this.service.createIssue(this.snapshot, draft);
    this.post(
      result.ok
        ? { type: 'issueResult', ok: true, url: result.url }
        : { type: 'issueResult', ok: false, message: result.message },
    );
  }

  private postSnapshot(): void {
    if (this.snapshot !== undefined) {
      this.post({
        type: 'snapshot',
        snapshot: this.snapshot,
        workItems: this.service.listWorkItems(),
      });
    }
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
  };
  return draft.title.trim() === '' ? undefined : draft;
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

function render(webview: vscode.Webview): string {
  const nonce = String(Date.now());
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${chatCsp(webview.cspSource, nonce, { includeImgData: false })}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body><main><header><div><p class="eyebrow">DEVELOPMENT CONTROL CENTER</p><h1>Forge Hub</h1><p id="subtitle">GitHub/GitLabの状態を確認しています。</p></div><button id="refresh" type="button">更新</button></header><section class="status" id="status" aria-live="polite"></section><section class="boardWrap"><h2>Forgeカンバン</h2><div id="board" class="board" aria-label="Forge作業の状態"></div></section><section class="grid"><section class="panel"><h2>Issueを作成</h2><p>作成前に内容を確認します。本文は3部構成で送信されます。</p><label>タイトル<input id="title" required></label><label>着手前の現状<textarea id="currentState"></textarea></label><label>非エンジニア向け概要<textarea id="overview"></textarea></label><label>エンジニア向け仕様・実装計画<textarea id="implementation"></textarea></label><label>確認者向け確認点<textarea id="verification"></textarea></label><button id="createIssue" class="primary" type="button">内容を確認してIssueを作成</button><p id="result" role="status"></p></section><section class="panel next"><h2>既存Issueから着手</h2><p>選択したIssueごとに隔離worktreeを作り、起動元と同じ会話を開きます。</p><button id="listIssues" type="button">Issueを読み込む</button><div id="issues" class="issues" aria-live="polite"></div><p id="startResult" role="status"></p></section></section></main><script nonce="${nonce}">${script}</script></body></html>`;
}

const styles = `body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}main{max-width:1280px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:16px;align-items:start}.eyebrow{color:var(--vscode-textLink-foreground);font-size:11px;font-weight:700;letter-spacing:.11em;margin:0}h1{font-size:30px;margin:5px 0}h2{margin-top:0}.status{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin:24px 0}.metric,.warning{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;background:var(--vscode-editorWidget-background)}.metric small,.meta,.branch,.path,.empty,.timestamp,.ciMessage{display:block;color:var(--vscode-descriptionForeground)}.metric strong{display:block;font-size:16px;margin-top:4px;overflow-wrap:anywhere}.warning{grid-column:1/-1;border-left:4px solid var(--vscode-charts-yellow)}.boardWrap{margin:26px 0}.board{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:12px;overflow-x:auto}.column{min-height:160px;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 72%,transparent)}.column h3{margin:0 0 10px;font-size:14px}.workCard{display:grid;gap:7px;margin:9px 0;padding:11px;border-radius:8px;border-left:4px solid var(--vscode-charts-blue);background:var(--vscode-editor-background)}.workCard strong,.path,.ciMessage{overflow-wrap:anywhere}.meta,.branch,.path,.empty,.timestamp,.ciMessage{font-size:12px}.branch{font-family:var(--vscode-editor-font-family)}.actions{display:flex;flex-wrap:wrap;gap:6px}.actions a{color:var(--vscode-textLink-foreground);padding:7px 2px}.grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(240px,.8fr);gap:18px}.panel{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:20px;background:color-mix(in srgb,var(--vscode-editorWidget-background) 78%,transparent)}label{display:grid;gap:6px;font-size:13px;font-weight:600;margin:14px 0}input,textarea{box-sizing:border-box;width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:6px;padding:8px;font:inherit}textarea{min-height:84px;resize:vertical}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:6px;padding:8px 12px;cursor:pointer;font:inherit}button:hover{background:var(--vscode-button-hoverBackground)}button.primary{margin-top:6px;font-weight:700}.issues{display:grid;gap:7px;margin-top:12px}.issue{text-align:left}.next{align-self:start;color:var(--vscode-descriptionForeground)}.next h2{color:var(--vscode-foreground)}#result{min-height:1.4em;overflow-wrap:anywhere}@media(max-width:760px){main{padding:16px}.grid,.status,.board{grid-template-columns:1fr}header{display:block}header button{margin-top:12px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

const script = `const vscode=acquireVsCodeApi();const $=id=>document.getElementById(id);function text(tag,value,cls){const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el}function button(label,callback){const el=text('button',label);el.type='button';el.addEventListener('click',callback);return el}function render(snapshot){$('subtitle').textContent=(snapshot.host?snapshot.host==='github'?'GitHub':'GitLab':'Forge未判定')+' / '+(snapshot.provider==='codex'?'Codex':'Claude Code')+' / '+snapshot.cwd;const status=$('status');status.replaceChildren();const pairs=[['Host',snapshot.host||'未判定'],['origin',snapshot.remoteUrl||'未検出'],['CLI',snapshot.prerequisites?(snapshot.prerequisites.cliOnPath?'利用可能':'見つからない'):'確認不可'],['認証',snapshot.prerequisites?(snapshot.prerequisites.authenticated?'確認済み':'未認証'):'確認不可']];for(const [label,value] of pairs){const card=text('div','metric');card.append(text('small',label),text('strong',value));status.append(card)}for(const warning of (snapshot.hostMessage?[snapshot.hostMessage]:(snapshot.prerequisites?.warnings||[]))){status.append(text('div',warning,'warning'))}}function renderBoard(items){const board=$('board');board.replaceChildren();const columns=[['inProgress','実装中','▶'],['review','Review・CI確認待ち','⌕'],['ci','CI成功','✓'],['blocked','ブロック','!']];for(const [status,label,icon] of columns){const column=text('section','', 'column');column.append(text('h3',icon+' '+label));const cards=items.filter(item=>item.status===status);if(cards.length===0)column.append(text('p','項目なし','empty'));for(const item of cards){const card=text('article','', 'workCard');card.setAttribute('aria-label','#'+item.issue.number+' '+item.issue.title+' '+label);card.append(text('strong','#'+item.issue.number+' '+item.issue.title),text('span',(item.host==='github'?'GitHub':'GitLab')+' ・ '+(item.provider==='codex'?'Codex':'Claude Code'),'meta'),text('span',item.branch,'branch'),text('span',item.cwd,'path'),text('span','最終更新: '+new Date(item.updatedAt||item.startedAt).toLocaleString(),'timestamp'));if(item.ciMessage)card.append(text('span','CI: '+item.ciMessage,'ciMessage'));const actions=text('div','actions');actions.append(button('会話を開く',()=>vscode.postMessage({type:'openConversation',provider:item.provider,sessionId:item.sessionId})));if(status==='inProgress')actions.append(button('Draft PR/MRを作成',()=>vscode.postMessage({type:'createDraftPullRequest',branch:item.branch})));if(item.pullRequestNumber!==undefined)actions.append(button('CI状態を更新',()=>vscode.postMessage({type:'refreshCi',branch:item.branch})));if(item.pullRequestUrl){const link=text('a','PR/MRを開く');link.href=item.pullRequestUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}card.append(actions);column.append(card)}board.append(column)}}function draft(){return {title:$('title').value,currentState:$('currentState').value,overview:$('overview').value,implementation:$('implementation').value,verification:$('verification').value}}function renderIssues(issues){const list=$('issues');list.replaceChildren();if(issues.length===0){list.append(text('p','開いているIssueはありません。'));return}for(const issue of issues){const issueButton=button('#'+issue.number+' '+issue.title,()=>vscode.postMessage({type:'startIssue',number:issue.number,title:issue.title}));issueButton.className='issue';list.append(issueButton)}}window.addEventListener('message',event=>{const data=event.data;if(data.type==='snapshot'){render(data.snapshot);renderBoard(data.workItems||[])}if(data.type==='issues')renderIssues(data.issues);if(data.type==='pullRequestResult'||data.type==='ciResult')$('startResult').textContent=data.ok?(data.type==='ciResult'?'CI状態を更新しました。':'Draft PR/MRを作成しました。'):data.message;if(data.type==='startResult')$('startResult').textContent=data.ok?'会話を開始しました: '+data.branch+' / '+data.cwd:data.message;if(data.type==='issueResult'){$('result').replaceChildren();if(data.ok){$('result').append(text('span','Issueを作成しました。 '));if(data.url){const link=text('a',data.url);link.href=data.url;link.target='_blank';link.rel='noreferrer';$('result').append(link)}}else $('result').textContent=data.message}});$('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));$('listIssues').addEventListener('click',()=>vscode.postMessage({type:'listIssues'}));$('createIssue').addEventListener('click',()=>vscode.postMessage({type:'createIssue',...draft()}));vscode.postMessage({type:'ready'});`;
