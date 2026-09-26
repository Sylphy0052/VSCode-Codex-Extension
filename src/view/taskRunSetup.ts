import * as fsPromises from 'node:fs/promises';

import * as vscode from 'vscode';
import { CLAUDE_EFFORTS } from '../claude/types';
import { FALLBACK_EFFORTS } from '../codex/modelCatalog';
import {
  readAutoReplyReflexConfig,
  readClaudeConfig,
  readConfig,
  readReflexEnabled,
} from '../config';
import type { Logger } from '../log';
import type { CliCommandRunner } from '../orchestrator/forge';
import { judgeRoadmapQuestion, RoadmapQuestionMcpServer } from '../orchestrator/roadmapQuestionMcp';
import { resolveRoadmapBaseCommit, type RoadmapRunForgePorts } from '../orchestrator/roadmapRunForge';
import type { ExtensionSafetyBaseline } from '../orchestrator/taskConfig';
import { TaskRunController } from '../orchestrator/taskRunController';
import { TaskRunMergeKeys } from '../orchestrator/taskRunMergeKey';
import { TaskRunOrchestrator } from '../orchestrator/taskRunOrchestrator';
import { assessTaskRun } from '../orchestrator/taskRunScheduler';
import {
  listTasks,
  MAX_TASK_RUN_PARALLEL,
  type TaskRun,
  type TaskRunEngine,
} from '../orchestrator/taskRunState';
import type { TaskRunStore } from '../orchestrator/taskRunStore';
import type { TaskSessionConfig, TaskSessionHost } from '../orchestrator/taskSession';
import { createStageObservationPorts } from '../orchestrator/taskStageObservation';
import { TaskStageRunner } from '../orchestrator/taskStageRunner';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import {
  nodeWorktreeFileSystem,
  type GitCommandRunner,
  type WorktreeCreationQueue,
} from '../orchestrator/worktree';
import { proposeHandoffModelSettings } from './handoffModelChoice';
import type { SettingsProvider } from './settingsProvider';
import { TaskRunKanbanViewManager } from './taskRunKanbanView';

/** 1つの工程セッションで送る指示の上限（引き継ぎを含む）。 */
const TASK_STAGE_MAX_ITERATIONS = 10;
const CONFIRM_TITLE_MAX_LENGTH = 200;
const CONFIRM_TEXT_MAX_LENGTH = 1000;
const NOTIFY_TITLE_MAX_LENGTH = 80;
const OPEN_KANBAN = 'Kanbanを開く';

export interface TaskRunSetupDeps {
  /**
   * `extension.ts`が先に作って渡す。リロード後の汎用復元が工程セッションとOrchestratorの
   * タブを見分けるために、チャット画面の組み立てより前から要る。
   */
  store: TaskRunStore;
  hosts: Record<TaskRunEngine, TaskSessionHost>;
  worktreeQueue: WorktreeCreationQueue;
  git: GitCommandRunner;
  cli: CliCommandRunner;
  sessionConfig(engine: TaskRunEngine): { config: TaskSessionConfig; sandbox: string };
  /** 工程セッションとOrchestratorセッションの権限の上限。 */
  readBaseline(): ExtensionSafetyBaseline;
  /** エンジンごとのモデル一覧（工程の推奨値を求めるのに使う）。 */
  settings: Pick<SettingsProvider, 'snapshot' | 'claudeSnapshot'>;
  log: Logger;
}

/**
 * オーケストレータモード（Issue #1505）の組み立てとコマンド登録。`extension.ts`はここを
 * 呼ぶだけにする。返したDisposableは呼び出し側が`context.subscriptions`へ積む。
 */
export function setupTaskRun(deps: TaskRunSetupDeps): vscode.Disposable[] {
  const { log, store } = deps;
  const ports: RoadmapRunForgePorts = { git: deps.git, cli: deps.cli };
  // Controller・Runner・View・Orchestratorは互いを参照するため、後から入れる箱を介して繋ぐ
  const holder: {
    controller?: TaskRunController;
    view?: TaskRunKanbanViewManager;
    orchestrator?: TaskRunOrchestrator;
  } = {};

  const executableFor = (engine: TaskRunEngine): string =>
    engine === 'claude' ? readClaudeConfig().executablePath : readConfig().executablePath;
  const warn = (message: string): void => log.warn(`[task run] ${message}`);
  const modelCatalog = (engine: TaskRunEngine) =>
    engine === 'claude'
      ? { models: deps.settings.claudeSnapshot().models, fallbackEfforts: CLAUDE_EFFORTS }
      : { models: deps.settings.snapshot().models, fallbackEfforts: FALLBACK_EFFORTS };

  const questionServer = new RoadmapQuestionMcpServer({ logWarn: warn });

  const observation = createStageObservationPorts(ports);

  const runner = new TaskStageRunner({
    hosts: deps.hosts,
    store,
    mergeKeys: new TaskRunMergeKeys(),
    worktreeQueue: deps.worktreeQueue,
    git: deps.git,
    fs: nodeWorktreeFileSystem,
    observation,
    resolveBaseCommit: (root) => resolveRoadmapBaseCommit(ports, root),
    sessionConfig: (engine) => deps.sessionConfig(engine),
    autoApprove: () => deps.readBaseline().allowAutoApprove,
    maxIterations: TASK_STAGE_MAX_ITERATIONS,
    mcpServer: questionServer,
    // Reflexモードが無効なら判定せず、すべての質問をユーザーへ回す
    judgeQuestion: async (engine, question) =>
      readReflexEnabled()
        ? judgeRoadmapQuestion(
            { provider: engine, executable: executableFor(engine), logWarn: warn },
            question,
            readAutoReplyReflexConfig().answerThreshold,
          )
        : { kind: 'human', summary: undefined },
    onRunChanged: (run) => holder.controller?.handleRunChanged(run),
    onWarning: (runId, taskId, message) => warn(`${runId} ${taskId}: ${message}`),
  });

  const controller = new TaskRunController({
    store,
    runner,
    modelCatalog,
    recommendStageSettings: async (engine, input) => {
      const current =
        engine === 'claude'
          ? { model: readClaudeConfig().claude.model, effort: readClaudeConfig().claude.effort }
          : { model: readConfig().codex.model, effort: readConfig().codex.reasoningEffort };
      const { models, fallbackEfforts } = modelCatalog(engine);
      const choice = await proposeHandoffModelSettings(current, input, {
        provider: engine,
        executable: executableFor(engine),
        models,
        fallbackEfforts,
        logWarn: warn,
      });
      return { model: choice.settings.model, effort: choice.settings.effort, reasons: choice.reasons };
    },
    observation,
    pathExists: async (target) => {
      try {
        await fsPromises.stat(target);
        return true;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return false;
        }
        // 一時的なI/Oエラー（NFSのESTALE等）を「消えた」と誤判定しない
        throw e;
      }
    },
    log: (message) => log.info(message),
  });
  holder.controller = controller;

  const orchestrator = new TaskRunOrchestrator({
    hosts: deps.hosts,
    controller,
    server: questionServer,
    readBaseline: () => deps.readBaseline(),
    confirmAnswer: confirmOrchestratorAnswer,
    onDidChange: () => holder.view?.refresh(),
    log: (message) => log.warn(message),
  });
  holder.orchestrator = orchestrator;

  const view = new TaskRunKanbanViewManager({
    controller,
    orchestrator,
    revealStage: (runId, taskId) => runner.revealStageSession(runId, taskId),
    log,
  });
  holder.view = view;

  const transitions = controller.onTransition((prev, next) => {
    orchestrator.handleRunTransition(prev, next);
    view.refresh();
    notifyTransition(prev, next, () => view.show(next.runId));
  });

  void controller.restore().catch((e: unknown) => {
    warn(`再読み込み後の復元に失敗: ${String(e)}`);
  });

  return [
    transitions,
    { dispose: () => runner.dispose() },
    // Orchestratorはトークンを外してからセッションを閉じるため、サーバより先に片付ける
    { dispose: () => orchestrator.dispose() },
    { dispose: () => questionServer.dispose() },
    view,
    vscode.commands.registerCommand('agent.taskRun.start', (engineHint?: unknown) =>
      startRunCommand(controller, view, orchestrator, log, parseEngine(engineHint)),
    ),
    vscode.commands.registerCommand('agent.taskRun.kanban', () => view.show()),
  ];
}

function parseEngine(value: unknown): TaskRunEngine | undefined {
  return value === 'codex' || value === 'claude' ? value : undefined;
}

/**
 * 人の対応が要る遷移を通知する: 計画の承認待ちになった、ユーザー判断待ちの質問が増えた、
 * runが止まった（`stalled`）。
 */
function notifyTransition(prev: TaskRun | undefined, next: TaskRun, open: () => void): void {
  if (next.finishedAt !== undefined) {
    return;
  }
  if (prev?.planStatus !== 'awaitingApproval' && next.planStatus === 'awaitingApproval') {
    notify('オーケストレータモード: 計画の承認待ちです。Kanbanで確かめて承認してください', open);
  }
  const asked = newQuestionsAwaitingUser(prev, next);
  if (asked.length > 0) {
    notify(`オーケストレータモード: ユーザー判断待ちの質問があります（${asked.join(', ')}）`, open);
  }
  const before = prev === undefined ? undefined : assessTaskRun(prev);
  const after = assessTaskRun(next);
  if (after.kind === 'stalled' && before?.kind !== 'stalled') {
    notify(`オーケストレータモード: 人の対応待ちで止まりました（${after.blockers.join(', ')}）`, open);
  }
}

/** ユーザー判断待ちへ新しく変わった質問を持つタスク（表示用の`taskId`とタイトル）。 */
function newQuestionsAwaitingUser(prev: TaskRun | undefined, next: TaskRun): string[] {
  const awaiting = new Set<string>();
  for (const task of prev === undefined ? [] : listTasks(prev)) {
    for (const q of task.questions ?? []) {
      if (q.status === 'awaitingUser') {
        awaiting.add(q.questionId);
      }
    }
  }
  return listTasks(next)
    .filter((task) =>
      (task.questions ?? []).some((q) => q.status === 'awaitingUser' && !awaiting.has(q.questionId)),
    )
    .map((task) => `${task.taskId} ${sanitizeInlineText(task.title, NOTIFY_TITLE_MAX_LENGTH)}`);
}

function notify(message: string, open: () => void): void {
  void vscode.window.showWarningMessage(message, OPEN_KANBAN).then((choice) => {
    if (choice === OPEN_KANBAN) {
      open();
    }
  });
}

async function startRunCommand(
  controller: TaskRunController,
  view: TaskRunKanbanViewManager,
  orchestrator: TaskRunOrchestrator,
  log: Logger,
  engineHint: TaskRunEngine | undefined,
): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) {
    return;
  }
  const engines: [TaskRunEngine, string][] = [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
  ];
  // 呼び出し元のチャットのエンジンを先頭に出す
  const ordered = engineHint === 'claude' ? [...engines].reverse() : engines;
  const engine = await pick<TaskRunEngine>('Orchestratorと工程セッションに使うCLI', ordered);
  if (engine === undefined) {
    return;
  }
  const parallelItems = Array.from({ length: MAX_TASK_RUN_PARALLEL }, (_, i) => String(i + 1));
  const parallel = await vscode.window.showQuickPick(parallelItems, {
    title: '並列上限（同時に動かす工程セッションの数）',
  });
  if (parallel === undefined) {
    return;
  }
  const outcome = await controller.startRun({
    workspaceRoot: folder,
    engine,
    maxParallel: Number(parallel),
  });
  if (!outcome.ok) {
    log.warn(`[task run] ${outcome.message}`);
    void vscode.window.showErrorMessage(`オーケストレータモード: ${outcome.message}`);
    return;
  }
  if (outcome.reused) {
    void vscode.window.showInformationMessage(
      'このフォルダには終わっていないrunがあるため、それを開きます（選んだCLIと並列上限は使いません）',
    );
  }
  view.show(outcome.runId);
  // Kanbanを左の列に出してから、右の列にOrchestratorを開く（開いていれば前面へ出す）
  void orchestrator.open(outcome.runId).then((opened) => {
    if (!opened) {
      void vscode.window.showWarningMessage(
        'オーケストレータモード: Orchestratorを開けませんでした。Kanbanの「Orchestratorを開く」で開き直せます',
      );
    }
  });
}

/** Orchestratorが`answer_question`で渡そうとしている回答を、人に確かめる。 */
async function confirmOrchestratorAnswer(input: {
  taskId: string;
  title: string;
  question: string;
  answer: string;
}): Promise<boolean> {
  const detail = [
    `${input.taskId} ${sanitizeInlineText(input.title, CONFIRM_TITLE_MAX_LENGTH)}`,
    '',
    `質問: ${sanitizeInlineText(input.question, CONFIRM_TEXT_MAX_LENGTH)}`,
    '',
    // 回答は渡す本文そのものを見せる（切り詰めると確かめていない部分が通る）
    `回答: ${input.answer}`,
  ].join('\n');
  const choice = await vscode.window.showWarningMessage(
    'Orchestratorがこの回答を工程セッションへ渡そうとしています。あなたの答えと一致していれば「回答する」を押してください',
    { modal: true, detail },
    '回答する',
  );
  return choice === '回答する';
}

async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('オーケストレータモード: フォルダを開いてから実行してください');
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
  options: readonly (readonly [T, string])[],
): Promise<T | undefined> {
  const items = options.map(([value, label]): vscode.QuickPickItem & { value: T } => ({ label, value }));
  const chosen = await vscode.window.showQuickPick(items, { title });
  return chosen?.value;
}
