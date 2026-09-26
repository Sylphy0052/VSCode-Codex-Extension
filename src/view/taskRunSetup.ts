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
import {
  judgeRoadmapQuestion,
  RoadmapQuestionMcpServer,
  type RoadmapQuestionVerdict,
} from '../orchestrator/roadmapQuestionMcp';
import { resolveRoadmapBaseCommit, type RoadmapRunForgePorts } from '../orchestrator/roadmapRunForge';
import type { ExtensionSafetyBaseline } from '../orchestrator/taskConfig';
import { TaskRunController, type ControllerResult } from '../orchestrator/taskRunController';
import type { GateJudgeQuestion } from '../orchestrator/taskRunGates';
import { TaskRunMergeKeys } from '../orchestrator/taskRunMergeKey';
import { TaskRunOrchestrator } from '../orchestrator/taskRunOrchestrator';
import { assessTaskRun } from '../orchestrator/taskRunScheduler';
import {
  isTaskRunActive,
  listTasks,
  MAX_TASK_RUN_PARALLEL,
  TASK_RUN_TITLE_MAX_LENGTH,
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
import { taskRunLabel } from './taskRunKanbanModel';
import { currentWorkspaceFolders, TaskRunKanbanViewManager } from './taskRunKanbanView';

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

  const judgeByReflex = async (
    engine: TaskRunEngine,
    question: GateJudgeQuestion,
  ): Promise<RoadmapQuestionVerdict> =>
    readReflexEnabled()
      ? judgeRoadmapQuestion(
          { provider: engine, executable: executableFor(engine), logWarn: warn },
          question,
          readAutoReplyReflexConfig().answerThreshold,
        )
      : { kind: 'human', summary: undefined };

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
    // Reflexモードが無効なら判定せず、すべての質問と関門をユーザーへ回す
    judgeQuestion: (engine, question) => judgeByReflex(engine, question),
    judgeGate: (engine, question) => judgeByReflex(engine, question),
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
    confirmGateResolution: confirmOrchestratorGateResolution,
    onDidChange: () => holder.view?.refresh(),
    log: (message) => log.warn(message),
  });
  holder.orchestrator = orchestrator;

  const finishRun = async (runId: string): Promise<ControllerResult> => {
    const result = await controller.finishRun(runId);
    if (result.ok) {
      await orchestrator.close(runId);
    }
    return result;
  };

  const suspendRun = async (runId: string): Promise<ControllerResult> => {
    const result = await controller.suspendRun(runId);
    if (result.ok) {
      await orchestrator.close(runId);
    }
    return result;
  };

  // Orchestratorは新しい世代で開く（リロード後の開き直しと同じ経路。新しい世代はget_run_stateで状態を取り直す）
  const resumeRun = async (runId: string): Promise<ControllerResult> => {
    const result = await controller.resumeRun(runId);
    if (result.ok) {
      showRun(view, orchestrator, runId);
    }
    return result;
  };

  const view = new TaskRunKanbanViewManager({
    controller,
    orchestrator,
    revealStage: (runId, taskId) => runner.revealStageSession(runId, taskId),
    finishRun,
    suspendRun,
    resumeRun,
    log,
  });
  holder.view = view;

  // 動いているrunはOrchestratorのタブも合わせる。中断中・終了したrunはKanbanだけに出す（Issue #1561）
  const switchToRun = (runId: string): void => {
    const run = controller.find(runId);
    if (run !== undefined && isTaskRunActive(run)) {
      showRun(view, orchestrator, runId);
    } else {
      view.show(runId);
    }
  };

  // 通知が出ただけでは見ているrunを変えない。「Kanbanを開く」を押したときだけ切り替える
  const transitions = controller.onTransition((prev, next) => {
    orchestrator.handleRunTransition(prev, next);
    view.refresh();
    notifyTransition(prev, next, () => switchToRun(next.runId));
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
      startRunCommand(
        controller,
        view,
        orchestrator,
        { finish: finishRun, suspend: suspendRun },
        log,
        parseEngine(engineHint),
      ),
    ),
    vscode.commands.registerCommand('agent.taskRun.kanban', () => view.show()),
    vscode.commands.registerCommand('agent.taskRun.switch', () =>
      switchRunCommand(controller, view, switchToRun),
    ),
  ];
}

/**
 * runの一覧（Kanbanと同じ並び）から選んだrunをKanbanとOrchestratorへ出す。中断中のrunを選んだら、
 * 続けて再開するかを尋ねる（Issue #1561）。
 */
async function switchRunCommand(
  controller: TaskRunController,
  view: TaskRunKanbanViewManager,
  switchToRun: (runId: string) => void,
): Promise<void> {
  const { runs } = controller.board(undefined, currentWorkspaceFolders());
  if (runs.length === 0) {
    void vscode.window.showInformationMessage(
      'オーケストレータモード: runがありません。「オーケストレータモードを開始」で始めてください',
    );
    return;
  }
  const items: (vscode.QuickPickItem & { runId?: string })[] = [];
  let separated = false;
  for (const r of runs) {
    if (!r.inCurrentFolder && !separated) {
      items.push({ label: '他のフォルダ', kind: vscode.QuickPickItemKind.Separator });
      separated = true;
    }
    items.push({ label: r.label, description: r.status, detail: r.workspaceRoot, runId: r.runId });
  }
  const chosen = await vscode.window.showQuickPick(items, {
    title: '表示するrun',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (chosen?.runId === undefined) {
    return;
  }
  const run = controller.find(chosen.runId);
  if (run === undefined) {
    void vscode.window.showWarningMessage(
      'オーケストレータモード: 選んだrunが見つかりません。もう一度一覧を開いてください',
    );
    return;
  }
  if (run.finishedAt === undefined && run.suspendedAt !== undefined) {
    view.show(run.runId);
    const choice = await vscode.window.showInformationMessage(
      `オーケストレータモード: 「${taskRunLabel(run)}」は中断中です。再開しますか？`,
      '再開する',
    );
    if (choice === '再開する') {
      await view.resumeRun(run.runId);
    }
    return;
  }
  switchToRun(run.runId);
}

function parseEngine(value: unknown): TaskRunEngine | undefined {
  return value === 'codex' || value === 'claude' ? value : undefined;
}

/**
 * 人の対応が要る遷移を通知する: 計画の承認待ちになった、ユーザー判断待ちの質問が増えた、
 * runが止まった（`stalled`）。
 */
function notifyTransition(prev: TaskRun | undefined, next: TaskRun, open: () => void): void {
  if (!isTaskRunActive(next)) {
    return;
  }
  // どのrunの通知かを名前で示す（Issue #1561）
  const prefix = `オーケストレータモード「${taskRunLabel(next)}」`;
  if (prev?.planStatus !== 'awaitingApproval' && next.planStatus === 'awaitingApproval') {
    notify(`${prefix}: 計画の承認待ちです。Kanbanで確かめて承認してください`, open);
  }
  const asked = newQuestionsAwaitingUser(prev, next);
  if (asked.length > 0) {
    notify(`${prefix}: ユーザー判断待ちの質問があります（${asked.join(', ')}）`, open);
  }
  const before = prev === undefined ? undefined : assessTaskRun(prev);
  const after = assessTaskRun(next);
  if (after.kind === 'stalled' && before?.kind !== 'stalled') {
    notify(`${prefix}: 人の対応待ちで止まりました（${after.blockers.join(', ')}）`, open);
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
  closeRun: {
    finish(runId: string): Promise<ControllerResult>;
    suspend(runId: string): Promise<ControllerResult>;
  },
  log: Logger,
  engineHint: TaskRunEngine | undefined,
): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) {
    return;
  }
  // 動いているrunがあると`startRun`はそれを返すため、新しく始めたいなら先に終えるか中断する
  // （Issue #1558、#1560）
  const active = controller.findActive(folder);
  if (active !== undefined) {
    const action = await pick<'open' | 'suspend' | 'finish'>('このフォルダには動いているrunがあります', [
      ['open', '既存のrunを開く'],
      [
        'suspend',
        '既存のrunを中断して新しく始める（動いている工程セッションとOrchestratorを止めます。中断したrunは後で再開できます）',
      ],
      ['finish', '既存のrunを終えて新しく始める（動いている工程セッションとOrchestratorを止めます）'],
    ]);
    if (action === undefined) {
      return;
    }
    if (action === 'open') {
      showRun(view, orchestrator, active.runId);
      return;
    }
    const closed = await closeRun[action](active.runId);
    if (!closed.ok) {
      log.warn(`[task run] ${closed.message}`);
      void vscode.window.showErrorMessage(`オーケストレータモード: ${closed.message}`);
      return;
    }
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
  const title = await vscode.window.showInputBox({
    title: 'runの名前（Kanbanの一覧と通知に出します）',
    prompt: '空のままEnterで開始時刻とCLIを名前にします。後でKanbanから変えられます',
    validateInput: (value) =>
      value.length > TASK_RUN_TITLE_MAX_LENGTH
        ? `${String(TASK_RUN_TITLE_MAX_LENGTH)}文字以内で入力してください`
        : undefined,
  });
  if (title === undefined) {
    return;
  }
  const outcome = await controller.startRun({
    workspaceRoot: folder,
    engine,
    maxParallel: Number(parallel),
    title,
  });
  if (!outcome.ok) {
    log.warn(`[task run] ${outcome.message}`);
    void vscode.window.showErrorMessage(`オーケストレータモード: ${outcome.message}`);
    return;
  }
  if (outcome.reused) {
    void vscode.window.showInformationMessage(
      'このフォルダには動いているrunがあるため、それを開きます（選んだCLI・並列上限・名前は使いません）',
    );
  }
  showRun(view, orchestrator, outcome.runId);
}

function showRun(
  view: TaskRunKanbanViewManager,
  orchestrator: TaskRunOrchestrator,
  runId: string,
): void {
  view.show(runId);
  // Kanbanを左の列に出してから、右の列にOrchestratorを開く（開いていれば前面へ出す）
  void orchestrator.open(runId).then((opened) => {
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

/** Orchestratorが`resolve_gate`で渡そうとしている関門の判断を、人に確かめる。 */
async function confirmOrchestratorGateResolution(input: {
  taskId: string;
  title: string;
  detail: string;
  choiceLabel: string;
}): Promise<boolean> {
  const detail = [
    `${input.taskId} ${sanitizeInlineText(input.title, CONFIRM_TITLE_MAX_LENGTH)}`,
    '',
    `関門: ${sanitizeInlineText(input.detail, CONFIRM_TEXT_MAX_LENGTH)}`,
    '',
    `判断: ${input.choiceLabel}`,
  ].join('\n');
  const choice = await vscode.window.showWarningMessage(
    'Orchestratorがこの判断で関門を決着させようとしています。あなたの判断と一致していれば「決着させる」を押してください',
    { modal: true, detail },
    '決着させる',
  );
  return choice === '決着させる';
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
