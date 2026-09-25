import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  readAutoReplyReflexConfig,
  readClaudeConfig,
  readConfig,
  readReflexEnabled,
  readWorkflowsConfig,
} from '../config';
import type { Logger } from '../log';
import { nodeForgeFileSystem, type CliCommandRunner } from '../orchestrator/forge';
import { RoadmapIssueRunner } from '../orchestrator/roadmapIssueRunner';
import {
  RoadmapMergeQueue,
  type RoadmapMergeConsentRequest,
  type RoadmapMergeSettings,
} from '../orchestrator/roadmapMergeQueue';
import {
  applyRoadmapPlanProposal,
  createHeadlessRoadmapPlanProposer,
  resolveRoadmapPlan,
  type RoadmapPlanProposal,
} from '../orchestrator/roadmapPlanProposal';
import { judgeRoadmapQuestion, RoadmapQuestionMcpServer } from '../orchestrator/roadmapQuestionMcp';
import { RoadmapRunController } from '../orchestrator/roadmapRunController';
import {
  detectRoadmapForgeHost,
  findRoadmapPullRequest,
  isRoadmapPullRequestMerged,
  resolveRoadmapBaseCommit,
  type RoadmapRunForgePorts,
} from '../orchestrator/roadmapRunForge';
import {
  isValidIssueNumber,
  MAX_ROADMAP_PARALLEL,
  type RoadmapRun,
  type RoadmapRunEngine,
  type RoadmapRunMode,
} from '../orchestrator/roadmapRunState';
import { RoadmapRunStore } from '../orchestrator/roadmapRunStore';
import { formatVerifyCommandForDisplay } from '../orchestrator/runnerVerifyCommands';
import type { TaskSessionConfig, TaskSessionHost } from '../orchestrator/taskSession';
import {
  nodeWorktreeFileSystem,
  type GitCommandRunner,
  type WorktreeCreationQueue,
} from '../orchestrator/worktree';
import { RoadmapKanbanViewManager } from './roadmapKanbanView';

/** 1つのIssueのセッションで送る指示の上限（引き継ぎを含む）。実装・レビュー・PR作成まで回す。 */
const ROADMAP_ISSUE_MAX_ITERATIONS = 10;
/** 計画の提案（ヘッドレスCLI）を待つ上限。 */
const PLAN_PROPOSAL_TIMEOUT_MS = 10 * 60_000;
/** 提案をモーダルへ出すときの、ノードあたりの根拠の上限。 */
const PROPOSAL_REASON_MAX_LENGTH = 120;

export interface RoadmapRunSetupDeps {
  context: vscode.ExtensionContext;
  /**
   * `extension.ts`が先に作って渡す。リロード後の汎用復元がIssueセッションのタブを
   * 見分けるために、チャット画面の組み立てより前から要る（Issue #1491）。
   */
  store: RoadmapRunStore;
  hosts: Record<RoadmapRunEngine, TaskSessionHost>;
  worktreeQueue: WorktreeCreationQueue;
  git: GitCommandRunner;
  cli: CliCommandRunner;
  sessionConfig(engine: RoadmapRunEngine): { config: TaskSessionConfig; sandbox: string };
  readContextLowPercent: () => number;
  log: Logger;
}

/**
 * ロードマップ実行（Issue #1465）の組み立てとコマンド登録。`extension.ts`はここを呼ぶだけにする。
 * 返したDisposableは呼び出し側が`context.subscriptions`へ積む。
 */
export function setupRoadmapRun(deps: RoadmapRunSetupDeps): vscode.Disposable[] {
  const { log } = deps;
  const ports: RoadmapRunForgePorts = { git: deps.git, cli: deps.cli };
  const { store } = deps;
  // Controller・Runner・Viewは互いを参照するため、後から入れる箱を介して繋ぐ
  const holder: { controller?: RoadmapRunController; view?: RoadmapKanbanViewManager } = {};

  const executableFor = (engine: RoadmapRunEngine): string =>
    engine === 'claude' ? readClaudeConfig().executablePath : readConfig().executablePath;
  const questionServer = new RoadmapQuestionMcpServer({
    logWarn: (message) => log.warn(`[roadmap run] ${message}`),
  });

  const runner = new RoadmapIssueRunner({
    hosts: deps.hosts,
    store,
    worktreeQueue: deps.worktreeQueue,
    git: deps.git,
    fs: nodeWorktreeFileSystem,
    resolveBaseCommit: (root) => resolveRoadmapBaseCommit(ports, root),
    findPullRequest: (root, branch) => findRoadmapPullRequest(ports, root, branch),
    isPullRequestMerged: (root, n) => isRoadmapPullRequestMerged(ports, root, n),
    sessionConfig: (engine) => deps.sessionConfig(engine),
    maxIterations: ROADMAP_ISSUE_MAX_ITERATIONS,
    readContextLowPercent: deps.readContextLowPercent,
    onRunChanged: (run) => holder.controller?.handleRunChanged(run),
    onWarning: (runId, n, message) => holder.controller?.recordWarning(runId, n, message),
    questionServer,
    // Reflexモードが無効なら判定せず、すべての質問をユーザーへ回す
    judgeQuestion: async (engine, question) =>
      readReflexEnabled()
        ? judgeRoadmapQuestion(
            {
              provider: engine,
              executable: executableFor(engine),
              logWarn: (message) => log.warn(`[roadmap run] ${message}`),
            },
            question,
            readAutoReplyReflexConfig().answerThreshold,
          )
        : { kind: 'human', summary: undefined },
  });

  const importDeps = { cli: deps.cli, fs: nodeForgeFileSystem };

  const mergeQueue = new RoadmapMergeQueue({
    git: deps.git,
    cli: deps.cli,
    fs: nodeWorktreeFileSystem,
    writeTextFile: (target, text) => writeFile(target, text, 'utf8'),
    worktreeQueue: deps.worktreeQueue,
    detectHost: (root) => detectRoadmapForgeHost(ports, root),
    isPullRequestMerged: (root, n) => isRoadmapPullRequestMerged(ports, root, n),
    readSettings: readMergeSettings,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    confirm: confirmMerge,
    ciWaitTimeoutMs: () => readWorkflowsConfig().ciWaitTimeoutSec * 1000,
    getRun: (runId) => store.find(runId),
    updateRun: async (runId, fn) => holder.controller?.updateRun(runId, fn),
    startMergeRepair: (runId, n, request) => runner.startMergeRepair(runId, n, request),
    warn: (runId, n, message) => holder.controller?.recordWarning(runId, n, message),
    log: (message) => log.info(message),
  });

  const controller = new RoadmapRunController({
    store,
    runner,
    detectHost: (root) => detectRoadmapForgeHost(ports, root),
    resolvePlan: (target, engine) =>
      resolveRoadmapPlan(
        {
          ...importDeps,
          propose: createHeadlessRoadmapPlanProposer({
            provider: engine,
            executable: executableFor(engine),
            model: 'auto',
            timeoutMs: PLAN_PROPOSAL_TIMEOUT_MS,
            logWarn: (message) => log.warn(`[roadmap run] ${message}`),
          }),
          reflex: {
            provider: engine,
            executable: executableFor(engine),
            logWarn: (message) => log.warn(`[roadmap run] ${message}`),
          },
        },
        target,
      ),
    applyPlan: (target, proposal) => applyRoadmapPlanProposal(importDeps, target, proposal),
    confirmPlan,
    notifyStalled: (run, blockers) => notifyStalled(run, blockers, () => holder.view?.show(run.runId)),
    onDidChange: () => holder.view?.refresh(),
    mergeQueue,
    log: (message) => log.info(message),
  });
  holder.controller = controller;
  const view = new RoadmapKanbanViewManager(controller, log);
  holder.view = view;

  void controller.restore().catch((e: unknown) => {
    log.warn(`[roadmap run] 再読み込み後の復元に失敗: ${String(e)}`);
  });

  return [
    { dispose: () => mergeQueue.dispose() },
    { dispose: () => runner.dispose() },
    { dispose: () => questionServer.dispose() },
    view,
    vscode.commands.registerCommand('agent.roadmapRun.start', () =>
      startRunCommand(controller, view, log),
    ),
    vscode.commands.registerCommand('agent.roadmapRun.kanban', () => view.show()),
  ];
}

async function confirmPlan(proposal: RoadmapPlanProposal): Promise<boolean> {
  const lines = proposal.nodes.map((node) => {
    const deps = node.dependsOn.length > 0 ? `（依存: ${node.dependsOn.map((d) => `#${String(d)}`).join(', ')}）` : '';
    return `#${String(node.issueNumber)}${deps}: ${node.reason.slice(0, PROPOSAL_REASON_MAX_LENGTH)}`;
  });
  const approve = '承認して書き戻す';
  const choice = await vscode.window.showWarningMessage(
    '計画の提案をReflexが妥当と判定しきれませんでした。この順序と依存で実行しますか？',
    { modal: true, detail: [proposal.review.summary, '', ...lines].join('\n') },
    approve,
  );
  return choice === approve;
}

/** `agent.roadmapRun.merge.*`を読む。不正な値は空（実行しない）として扱う。 */
function readMergeSettings(root: string): RoadmapMergeSettings {
  const c = vscode.workspace.getConfiguration('agent.roadmapRun.merge', vscode.Uri.file(root));
  const bump = c.get<unknown>('versionBumpCommand');
  const verify = c.get<unknown>('verifyCommands');
  return {
    versionBumpCommand: typeof bump === 'string' ? bump.trim() : '',
    verifyCommands: Array.isArray(verify)
      ? verify
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v !== '')
      : [],
  };
}

/**
 * mergeと後片付け、検証・版上げコマンドの実行を許可してもらう。runごとに1回（コマンドが
 * 変わったら聞き直す）。コマンドは実行する文字列そのままを、不可視文字をエスケープして見せる。
 */
async function confirmMerge(request: RoadmapMergeConsentRequest): Promise<boolean> {
  const lines = request.commands.map(formatVerifyCommandForDisplay);
  const allow = 'mergeを許可';
  const choice = await vscode.window.showWarningMessage(
    `ロードマップ #${String(request.roadmapIssueNumber)}のPRを順にmergeしますか？`,
    {
      modal: true,
      detail:
        'merge待ちのIssueごとに、worktreeでorigin/mainを取り込み、検証・版上げのあとpushして' +
        'CIの完了を待ってmergeします。merge後はリモートとローカルのブランチ、worktreeを消します。\n' +
        '許可はこの実行（run）の間だけ有効です。' +
        (lines.length === 0
          ? '検証・版上げのコマンドは設定されていません（agent.roadmapRun.merge.*）。'
          : '次のコマンドをworktreeでシェル経由で実行します。AIのサンドボックスの外で、' +
            '拡張機能の権限で動きます。コマンドが読むファイルはIssueのAIが書き換えている場合があります。\n\n' +
            lines.join('\n')),
    },
    allow,
  );
  return choice === allow;
}

function notifyStalled(run: RoadmapRun, blockers: readonly number[], open: () => void): void {
  const action = 'Kanbanを開く';
  void vscode.window
    .showWarningMessage(
      `ロードマップ #${String(run.roadmapIssueNumber)}の自動実行が人の対応待ちで止まりました: ${blockers.map((n) => `#${String(n)}`).join(', ')}`,
      action,
    )
    .then((choice) => {
      if (choice === action) {
        open();
      }
    });
}

async function startRunCommand(
  controller: RoadmapRunController,
  view: RoadmapKanbanViewManager,
  log: Logger,
): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) {
    return;
  }
  const issueText = await vscode.window.showInputBox({
    title: 'ロードマップを実行',
    prompt: 'ロードマップIssueの番号',
    placeHolder: '例: 1457',
    validateInput: (value) =>
      isValidIssueNumber(Number(value.trim().replace(/^#/, ''))) ? undefined : '正の整数で入力してください',
  });
  if (issueText === undefined) {
    return;
  }
  const engine = await pick<RoadmapRunEngine>('実行に使うCLI', [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
  ]);
  if (engine === undefined) {
    return;
  }
  const mode = await pick<RoadmapRunMode>('実行モード', [
    ['manual', 'ユーザー選択', 'Kanbanで「実行」を押したノードだけを始める'],
    ['auto', '自動実行', '実行できるノードを並列上限まで順に始める'],
  ]);
  if (mode === undefined) {
    return;
  }
  const parallelItems = Array.from({ length: MAX_ROADMAP_PARALLEL }, (_, i) => String(i + 1));
  const parallel = await vscode.window.showQuickPick(parallelItems, { title: '並列上限' });
  if (parallel === undefined) {
    return;
  }
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ロードマップの計画を準備しています…' },
    () =>
      controller.startRun({
        workspaceRoot: folder,
        roadmapIssueNumber: Number(issueText.trim().replace(/^#/, '')),
        engine,
        mode,
        maxParallel: Number(parallel),
      }),
  );
  if (!outcome.ok) {
    log.warn(`[roadmap run] ${outcome.message}`);
    void vscode.window.showErrorMessage(`ロードマップ実行: ${outcome.message}`);
    return;
  }
  if (outcome.reused) {
    void vscode.window.showInformationMessage('同じロードマップの実行中のrunを開きます');
  }
  view.show(outcome.runId);
}

async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('ロードマップ実行: フォルダを開いてから実行してください');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0]?.uri.fsPath;
  }
  const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: '実行するリポジトリ' });
  return folder?.uri.fsPath;
}

async function pick<T extends string>(
  title: string,
  options: readonly (readonly [T, string, string?])[],
): Promise<T | undefined> {
  const items = options.map(([value, label, detail]) => ({ label, detail, value }));
  const chosen = await vscode.window.showQuickPick(items, { title });
  return chosen?.value;
}
