import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';
import type { AskUserQuestionItem } from '../claude/askUserQuestion';
import { CLAUDE_EFFORTS } from '../claude/types';
import { FALLBACK_EFFORTS } from '../codex/modelCatalog';
import {
  readAnswererJudgeConfig,
  readClaudeConfig,
  readConfig,
  readReflexEnabled,
  readTaskRunMaxParallelPerFolder,
  readTaskRunPlanAutoApproveEnabled,
  readTaskRunResourceIntervalMs,
  readTaskRunResourceThresholds,
} from '../config';
import type { Logger } from '../log';
import type { CliCommandRunner } from '../orchestrator/forge';
import { DEFAULT_PLAN_APPROVE_THRESHOLD } from '../orchestrator/planReflexReview';
import {
  describeResourceChange,
  formatResourceLines,
  ResourceMonitor,
} from '../orchestrator/resourceMonitor';
import { ResourceSampler } from '../orchestrator/resourceSampler';
import { RoadmapQuestionMcpServer } from '../orchestrator/roadmapQuestionMcp';
import {
  resolveRoadmapBaseCommit,
  type RoadmapRunForgePorts,
} from '../orchestrator/roadmapRunForge';
import type { RunNotesStore } from '../orchestrator/runNotes';
import type { ExtensionSafetyBaseline } from '../orchestrator/taskConfig';
import {
  TaskRunController,
  type ControllerResult,
  type QuestionAwaitingAnswer,
} from '../orchestrator/taskRunController';
import {
  computeHostIdentity,
  TASK_LEASE_DIR_NAME,
  TaskRunLeaseManager,
} from '../orchestrator/taskRunLease';
import { TaskRunMergeKeys } from '../orchestrator/taskRunMergeKey';
import { TaskRunOrchestrator } from '../orchestrator/taskRunOrchestrator';
import { createTaskRunRoadmapPort } from '../orchestrator/taskRunRoadmapForge';
import { assessTaskRun } from '../orchestrator/taskRunScheduler';
import {
  isTaskRunActive,
  listTasks,
  MAX_TASK_RUN_PARALLEL,
  type TaskRun,
  type TaskRunEngine,
  validateTaskRunTitleInput,
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
import {
  ANSWERER_USER_FALLBACK,
  judgeQuestionAnswerer,
  judgeTurnEndAnswerer,
  type AnswererVerdict,
} from '../reflex/answererJudge';
import { reflexJudgeDeps } from '../reflex/reflexJudge';
import { proposeHandoffModelSettings } from './handoffModelChoice';
import type { SettingsProvider } from './settingsProvider';
import { taskRunLabel } from './taskRunKanbanModel';
import { currentWorkspaceFolders, TaskRunKanbanViewManager } from './taskRunKanbanView';
import { createStageReflexJudges } from './taskRunStageJudges';
import { sessionHubRoot } from './sessionHub';
import {
  startRoadmapRunCommand,
  type RoadmapRunStartDeps,
  type RunSettings,
} from './taskRunRoadmapStart';

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
  /** このウィンドウの識別子（`extension.ts`が起動時に1回作る）。runの専有権（Issue #1628）の持ち主に使う。 */
  windowId: string;
  /** 専有権ファイルの置き場を決める（`sessionHubRoot`の下）。`context.globalStorageUri.fsPath`。 */
  globalStorageDir: string;
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
  /**
   * runをまたいで教訓を蓄積する仕組み（Issue #1599）。**省略可能**で、省略時は
   * `record_lesson`ツール自体を出さない。`extension.ts`が拡張機能全体で共有する
   * 1インスタンスを渡す。
   */
  runNotes?: RunNotesStore;
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
    monitor?: ResourceMonitor;
  } = {};

  const executableFor = (engine: TaskRunEngine): string =>
    engine === 'claude' ? readClaudeConfig().executablePath : readConfig().executablePath;
  const warn = (message: string): void => log.warn(`[task run] ${message}`);
  // 工程・計画のReflex判定には中断の口が無い
  const reflexDeps = (engine: TaskRunEngine) =>
    reflexJudgeDeps(engine, executableFor(engine), warn, undefined);
  const modelCatalog = (engine: TaskRunEngine) =>
    engine === 'claude'
      ? { models: deps.settings.claudeSnapshot().models, fallbackEfforts: CLAUDE_EFFORTS }
      : { models: deps.settings.snapshot().models, fallbackEfforts: FALLBACK_EFFORTS };

  const { judgeByReflex, judgeAnswerer } = createStageReflexJudges({
    reflexDeps,
    canDecide: (runId) => orchestrator.canDecide(runId),
  });
  const judgeTurnEnd = async (runId: string, lastMessage: string): Promise<AnswererVerdict> => {
    const settings = readAnswererJudgeConfig();
    const engine = controller.find(runId)?.engine;
    return settings.enabled && engine !== undefined
      ? judgeTurnEndAnswerer(reflexDeps(engine), lastMessage, settings.threshold)
      : ANSWERER_USER_FALLBACK;
  };
  // OrchestratorのAskUserQuestion（Issue #1763）。1回に複数の問いがあれば1問ずつ判定し、
  // すべてオーケストレーターが決めてよいときだけ`orchestrator`とする
  const judgeAskUserQuestion = async (
    runId: string,
    questions: readonly AskUserQuestionItem[],
  ): Promise<AnswererVerdict> => {
    const settings = readAnswererJudgeConfig();
    const engine = controller.find(runId)?.engine;
    if (!settings.enabled || engine === undefined || questions.length === 0) {
      return ANSWERER_USER_FALLBACK;
    }
    const verdicts = await Promise.all(
      questions.map((q) =>
        judgeQuestionAnswerer(
          reflexDeps(engine),
          {
            source: 'orchestrator',
            question: q.question,
            options: q.options.map((o) =>
              o.description === '' ? o.label : `${o.label}（${o.description}）`,
            ),
          },
          settings.threshold,
        ),
      ),
    );
    return verdicts.find((v) => v.kind !== 'orchestrator') ?? verdicts[0] ?? ANSWERER_USER_FALLBACK;
  };
  // ユーザーの判断待ちの質問にOrchestratorが答えようとしたとき（Issue #1763）。回答案を根拠へ添えて
  // 工程セッションの質問として判定し直す。危険語を含めば判定器がユーザーを返す
  const judgeQuestionAnswerByOrchestrator = async (
    target: QuestionAwaitingAnswer,
    answer: string,
  ): Promise<AnswererVerdict> => {
    const settings = readAnswererJudgeConfig();
    if (!settings.enabled) {
      return ANSWERER_USER_FALLBACK;
    }
    return judgeQuestionAnswerer(
      reflexDeps(target.engine),
      {
        source: 'stageSession',
        question: target.question,
        reason: target.reason,
        options: target.options,
        evidence: [
          target.evidence,
          target.reflexSummary === undefined ? undefined : `これまでの判定: ${target.reflexSummary}`,
          `オーケストレーターの回答案: ${answer}`,
        ]
          .filter((line) => line !== undefined)
          .join('\n'),
      },
      settings.threshold,
    );
  };

  const questionServer = new RoadmapQuestionMcpServer({ logWarn: warn });

  const observation = createStageObservationPorts(ports);

  // runごとのウィンドウ専有権（Issue #1628）。廃止したロードマップ実行の`roadmapRunLease.ts`をrunId単位へ移植
  const lease = new TaskRunLeaseManager({
    dir: path.join(sessionHubRoot(deps.globalStorageDir), TASK_LEASE_DIR_NAME),
    owner: {
      windowId: deps.windowId,
      hostname: os.hostname(),
      hostIdentity: computeHostIdentity(),
      pid: process.pid,
    },
    onLost: (runId, holderLease) => holder.controller?.handleLeaseLost(runId, holderLease),
    log: warn,
  });

  const runner = new TaskStageRunner({
    hosts: deps.hosts,
    store,
    drive: {
      canDrive: async (runId) => lease.holds(runId) || (await lease.acquire(runId)).ok,
      holds: (runId) => lease.holds(runId),
    },
    mergeKeys: new TaskRunMergeKeys(),
    worktreeQueue: deps.worktreeQueue,
    git: deps.git,
    fs: nodeWorktreeFileSystem,
    observation,
    resolveBaseCommit: (root) => resolveRoadmapBaseCommit(ports, root),
    sessionConfig: (engine) => deps.sessionConfig(engine),
    autoApprove: () => deps.readBaseline().allowAutoApprove,
    maxIterations: TASK_STAGE_MAX_ITERATIONS,
    maxParallelPerFolder: readTaskRunMaxParallelPerFolder,
    isStartHeld: () => holder.monitor?.level === 'critical',
    mcpServer: questionServer,
    // Reflexモードが無効なら判定せず、すべての質問と関門をユーザーへ回す
    judgeQuestion: judgeByReflex,
    judgeGate: judgeByReflex,
    judgeAnswerer,
    onRunChanged: (run) => holder.controller?.handleRunChanged(run),
    onTaskMerged: (runId, taskId) => holder.controller?.handleTaskMerged(runId, taskId),
    onWarning: (runId, taskId, message) => warn(`${runId} ${taskId}: ${message}`),
    ...(deps.runNotes === undefined ? {} : { runNotes: deps.runNotes }),
  });

  // 設定が無効なら判定せず、計画提案は常に承認待ちにする（判定器と閾値は`planReflexReview.ts`のもの）。
  // 他のReflex判定と同じく、Reflexモードの親スイッチがOFFなら判定しない（Issue #1713）
  const planAutoApprove = (engine: TaskRunEngine) =>
    readTaskRunPlanAutoApproveEnabled()
      ? {
          reflex: reflexDeps(engine),
          threshold: DEFAULT_PLAN_APPROVE_THRESHOLD,
        }
      : undefined;
  // Orchestratorの`approve_plan`の審査（Issue #1763）。Reflexモードが有効なら`planAutoApprove`の設定に関わらず審査する
  const planReview = (engine: TaskRunEngine) =>
    readReflexEnabled()
      ? { reflex: reflexDeps(engine), threshold: DEFAULT_PLAN_APPROVE_THRESHOLD }
      : undefined;

  const controller = new TaskRunController({
    store,
    runner,
    modelCatalog,
    planAutoApprove,
    planReview,
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
      return {
        model: choice.settings.model,
        effort: choice.settings.effort,
        reasons: choice.reasons,
      };
    },
    observation,
    roadmap: createTaskRunRoadmapPort(ports),
    lease,
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
    confirmAnswer: confirmOrchestratorAnswer,
    confirmGateResolution: confirmOrchestratorGateResolution,
    confirmPlanApproval: confirmOrchestratorPlanApproval,
    // Orchestratorは`resume_run`・`start_run`の処理の中で自分で開く（Issue #1620）
    showKanban: (runId) => holder.view?.show(runId),
    onDidChange: () => holder.view?.refresh(),
    log: (message) => log.warn(message),
    judgeTurnEndAnswerer: judgeTurnEnd,
    judgeAskUserQuestionAnswerer: judgeAskUserQuestion,
    judgeQuestionAnswerByOrchestrator,
    ...(deps.runNotes === undefined ? {} : { runNotes: deps.runNotes }),
    resourceLines: (runId) =>
      formatResourceLines(holder.monitor?.snapshot, runId, holder.monitor?.sampleFailure),
    isStartHeld: () => holder.monitor?.level === 'critical',
  });
  holder.orchestrator = orchestrator;

  // 動いているrunがある間だけCPUとメモリを計り、状態が変わったらOrchestratorへ知らせる（Issue #1629）
  const monitor = new ResourceMonitor({
    sampler: new ResourceSampler(),
    hasActiveRuns: () => store.list().some((r) => isTaskRunActive(r)),
    listStageProcesses: () => runner.listStageProcesses(),
    thresholds: readTaskRunResourceThresholds,
    intervalMs: readTaskRunResourceIntervalMs,
    onLevelChanged: (prev, snapshot) => {
      log.info(`[task run] 資源の状態: ${prev} -> ${snapshot.level}`);
      orchestrator.notifyResourcePressure(describeResourceChange(prev, snapshot));
      if (prev === 'critical') {
        // 保留していた開始（start_stageで受け付けた工程と再開待ちの工程）を空き枠の分だけ始める
        void runner.pumpAll().catch((e: unknown) => warn(`保留した工程の開始に失敗: ${String(e)}`));
      }
    },
    log: (message) => log.warn(message),
  });
  holder.monitor = monitor;

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
  const resumeRun = async (
    runId: string,
    options?: { parallel?: boolean },
  ): Promise<ControllerResult> => {
    const result = await controller.resumeRun(runId, options);
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
    monitor.refresh();
    orchestrator.handleRunTransition(prev, next);
    view.refresh();
    notifyTransition(prev, next, () => switchToRun(next.runId));
  });

  const roadmapStartDeps = (engineHint: TaskRunEngine | undefined): RoadmapRunStartDeps => ({
    controller,
    git: deps.git,
    cli: deps.cli,
    log,
    askSettings: (defaultTitle) => askRunSettings(engineHint, defaultTitle),
    resumeRun: (runId) => resumeRun(runId, { parallel: true }),
    showRun: (runId) => showRun(view, orchestrator, runId),
  });

  void controller
    .restore()
    .then(() => monitor.refresh())
    .catch((e: unknown) => {
      warn(`再読み込み後の復元に失敗: ${String(e)}`);
    });

  return [
    transitions,
    { dispose: () => monitor.dispose() },
    { dispose: () => lease.dispose() },
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
        (folder) =>
          startRoadmapRunCommand(roadmapStartDeps(parseEngine(engineHint)), folder, undefined),
      ),
    ),
    // ワークフローViewのロードマップ欄からはIssue番号を付けて呼ぶ（Issue #1623）
    vscode.commands.registerCommand(
      'agent.taskRun.startFromRoadmap',
      async (issueNumber?: unknown) => {
        const folder = await pickFolder();
        if (folder !== undefined) {
          await startRoadmapRunCommand(
            roadmapStartDeps(undefined),
            folder,
            parseIssueNumber(issueNumber),
          );
        }
      },
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
    items.push({
      label: escapeCodicons(r.label),
      description: r.status,
      detail: r.workspaceRoot,
      runId: r.runId,
    });
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

/**
 * QuickPickの項目名は`$(name)`をcodiconとして描くため、人が付けたrunの名前に含まれる`$(`を
 * ゼロ幅スペースで切って文字のまま出す（Issue #1567）。
 */
function escapeCodicons(text: string): string {
  return text.replaceAll('$(', '$\u200B(');
}

function parseIssueNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
      (task.questions ?? []).some(
        (q) => q.status === 'awaitingUser' && !awaiting.has(q.questionId),
      ),
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
  startFromRoadmap: (folder: string) => Promise<void>,
): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) {
    return;
  }
  const source = await pick('始め方', [
    ['free', '自由な指示から始める（Orchestratorと話して計画を作ります）'],
    ['roadmap', 'ロードマップIssueから始める（子Issueをタスクにします）'],
  ] as const);
  if (source === undefined) {
    return;
  }
  if (source === 'roadmap') {
    await startFromRoadmap(folder);
    return;
  }
  // 動いているrunがあると`startRun`はそれを返すため、新しく始めたいなら並行して始めるか、先に終えるか
  // 中断する（Issue #1558、#1560、#1562）。入れ替えは動いているrunが1本のときだけ選べる
  const active = controller.listActive(folder);
  let startParallel = false;
  if (active.length > 0) {
    const only = active.length === 1 ? active[0] : undefined;
    const action = await pick(
      only === undefined
        ? `このフォルダには動いているrunが${String(active.length)}本あります`
        : 'このフォルダには動いているrunがあります',
      activeRunActions(active.length),
    );
    if (action === undefined) {
      return;
    }
    if (action === 'open') {
      const runId =
        only?.runId ??
        (await pick<string>(
          '開くrun',
          active.map((r): [string, string] => [r.runId, escapeCodicons(taskRunLabel(r))]),
        ));
      if (runId !== undefined) {
        showRun(view, orchestrator, runId);
      }
      return;
    }
    if (action === 'parallel') {
      startParallel = true;
    } else if (only !== undefined) {
      const closed = await closeRun[action](only.runId);
      if (!closed.ok) {
        log.warn(`[task run] ${closed.message}`);
        void vscode.window.showErrorMessage(`オーケストレータモード: ${closed.message}`);
        return;
      }
    }
  }
  const settings = await askRunSettings(engineHint, undefined);
  if (settings === undefined) {
    return;
  }
  const outcome = await controller.startRun({
    workspaceRoot: folder,
    ...settings,
    parallel: startParallel,
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

/** 新しいrunのCLI・並列上限・名前を尋ねる。`defaultTitle`は名前の入力欄へ入れておく。 */
async function askRunSettings(
  engineHint: TaskRunEngine | undefined,
  defaultTitle: string | undefined,
): Promise<RunSettings | undefined> {
  const engines: [TaskRunEngine, string][] = [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
  ];
  // 呼び出し元のチャットのエンジンを先頭に出す
  const ordered = engineHint === 'claude' ? [...engines].reverse() : engines;
  const engine = await pick<TaskRunEngine>('Orchestratorと工程セッションに使うCLI', ordered);
  if (engine === undefined) {
    return undefined;
  }
  const parallelItems = Array.from({ length: MAX_TASK_RUN_PARALLEL }, (_, i) => String(i + 1));
  const parallel = await vscode.window.showQuickPick(parallelItems, {
    title: '並列上限（同時に動かす工程セッションの数）',
  });
  if (parallel === undefined) {
    return undefined;
  }
  const title = await vscode.window.showInputBox({
    title: 'runの名前（Kanbanの一覧と通知に出します）',
    prompt: '空のままEnterで開始時刻とCLIを名前にします。後でKanbanから変えられます',
    ...(defaultTitle === undefined ? {} : { value: defaultTitle }),
    validateInput: validateTaskRunTitleInput,
  });
  if (title === undefined) {
    return undefined;
  }
  return { engine, maxParallel: Number(parallel), title };
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

/** Orchestratorが`approve_plan`で承認しようとしている計画のうち、Reflexが妥当と判定しなかったものを人に確かめる。 */
async function confirmOrchestratorPlanApproval(input: {
  runLabel: string;
  taskCount: number;
  reflexSummary: string | undefined;
}): Promise<boolean> {
  const detail = [
    `${sanitizeInlineText(input.runLabel, CONFIRM_TITLE_MAX_LENGTH)}（タスク${String(input.taskCount)}件）`,
    '',
    input.reflexSummary === undefined
      ? 'Reflex: 無効のため審査していません'
      : `Reflex: ${sanitizeInlineText(input.reflexSummary, CONFIRM_TEXT_MAX_LENGTH)}`,
    '',
    '計画の中身はKanbanで確かめてください',
  ].join('\n');
  const choice = await vscode.window.showWarningMessage(
    'Orchestratorが計画を承認しようとしています。Kanbanの計画を確かめ、承認してよければ「承認する」を押してください',
    { modal: true, detail },
    '承認する',
  );
  return choice === '承認する';
}

type ActiveRunAction = 'parallel' | 'open' | 'suspend' | 'finish';

/**
 * 同じフォルダに動いているrunがあるときに、新しいrunの始め方として出す選択肢。
 * 既存のrunの中断・終了による入れ替えは、動いているrunが1本のときだけ出す。
 */
function activeRunActions(activeCount: number): [ActiveRunAction, string][] {
  const actions: [ActiveRunAction, string][] = [
    [
      'parallel',
      '既存のrunと並行して新しく始める（工程セッションの数はフォルダ全体で設定`agent.taskRun.maxParallelPerFolder`まで）',
    ],
    ['open', activeCount === 1 ? '既存のrunを開く' : '既存のrunを選んで開く'],
  ];
  if (activeCount === 1) {
    actions.push(
      [
        'suspend',
        '既存のrunを中断して新しく始める（動いている工程セッションとOrchestratorを止めます。中断したrunは後で再開できます）',
      ],
      [
        'finish',
        '既存のrunを終えて新しく始める（動いている工程セッションとOrchestratorを止めます）',
      ],
    );
  }
  return actions;
}

async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage(
      'オーケストレータモード: フォルダを開いてから実行してください',
    );
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
  const items = options.map(([value, label]): vscode.QuickPickItem & { value: T } => ({
    label,
    value,
  }));
  const chosen = await vscode.window.showQuickPick(items, { title });
  return chosen?.value;
}
