import * as vscode from 'vscode';
import { readWorkflowsConfig } from '../config';
import type { Logger } from '../log';
import type { CliCommandRunner } from '../orchestrator/forge';
import { createCliIssueListPort } from '../orchestrator/roadmap';
import { extractRoadmapChildren } from '../orchestrator/roadmapImport';
import type { TaskRunController } from '../orchestrator/taskRunController';
import type { TaskRunOrchestrator } from '../orchestrator/taskRunOrchestrator';
import {
  MAX_TASK_RUN_PARALLEL,
  TASK_RUN_TITLE_MAX_LENGTH,
  type TaskRunEngine,
} from '../orchestrator/taskRunState';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type { GitCommandRunner } from '../orchestrator/worktree';
import type {
  McIssueItem,
  McIssueListing,
  McIssueStartRequest,
  McRoadmapOrder,
  McRunOp,
  McRunTaskOp,
} from '../webview/missionControl/protocol';
import { buildMcRuns, type McRunsPort } from './missionControlRuns';
import type { TaskRunKanbanRun } from './taskRunKanbanModel';
import { currentWorkspaceFolders, type TaskRunKanbanViewManager } from './taskRunKanbanView';
import { startRoadmapRunFromChat, type RoadmapRunStartDeps } from './taskRunRoadmapStart';

const ISSUE_TITLE_MAX_LENGTH = 200;
const MESSAGE_MAX_LENGTH = 300;

export interface McRunsPortDeps {
  controller: TaskRunController;
  view: TaskRunKanbanViewManager;
  orchestrator: Pick<TaskRunOrchestrator, 'open'>;
  git: GitCommandRunner;
  cli: CliCommandRunner;
  log: Logger;
  /** runの切替（`agent.taskRun.switch`で選んだときと同じ）。 */
  switchToRun(runId: string): void;
  /** `start_roadmap_orchestrator`と同じ起動に渡す口。 */
  roadmapStartDeps(engine: TaskRunEngine): RoadmapRunStartDeps;
  /** 新しいrunの並列上限（`agent.taskRun.maxParallelPerFolder`）。 */
  defaultMaxParallel(): number;
}

/**
 * Mission ControlのRunsタブ（Issue #2150）からの操作を、Kanban・コマンドと同じ関数へ渡す。
 * 引数の形は`missionControlView.ts`が`missionControlRuns.ts`の関数で確かめてから呼ぶ。
 */
export function createMcRunsPort(deps: McRunsPortDeps): McRunsPort {
  const { controller, view, log } = deps;
  const failure = (result: { ok: boolean; message: string }): string | undefined =>
    result.ok ? undefined : result.message;

  const runOp = async (op: McRunOp, runId: string): Promise<string | undefined> => {
    if (controller.find(runId) === undefined) {
      return 'runが見つかりません';
    }
    switch (op) {
      case 'switch':
        deps.switchToRun(runId);
        return undefined;
      case 'pause':
        return failure(await controller.setHalted(runId, true));
      case 'unpause':
        return failure(await controller.setHalted(runId, false));
      case 'suspend':
        return view.suspendRun(runId);
      case 'resume':
        return view.resumeRun(runId);
      case 'finish':
        return view.finishRun(runId);
      default:
        return '操作が正しくありません';
    }
  };

  const taskOp = async (
    op: McRunTaskOp,
    runId: string,
    taskId: string,
  ): Promise<string | undefined> => {
    if (controller.find(runId) === undefined) {
      return 'runが見つかりません';
    }
    return op === 'stop' ? view.stopTaskStage(runId, taskId) : view.retryTaskStage(runId, taskId);
  };

  const listIssues = async (folder: string): Promise<McIssueListing | string> => {
    const { roadmapIssueLabel } = readWorkflowsConfig();
    const raw = await createCliIssueListPort(deps.git, deps.cli).listIssues(folder);
    if (raw === undefined) {
      return 'Issueの一覧を取得できませんでした（originがGitHub/GitLabか、gh・glabの認証を確認してください）';
    }
    const wanted = roadmapIssueLabel.toLowerCase();
    const issues = raw.map((issue): McIssueItem & { body: string | undefined } => ({
      number: issue.number,
      title: sanitizeInlineText(issue.title, ISSUE_TITLE_MAX_LENGTH),
      roadmap: (issue.labels ?? []).some((label) => label.toLowerCase() === wanted),
      body: issue.body,
    }));
    const roadmaps = issues
      .filter((issue) => issue.roadmap)
      .map((issue): McRoadmapOrder => ({
        number: issue.number,
        title: issue.title,
        children:
          issue.body === undefined
            ? []
            : extractRoadmapChildren(issue.body).children.map((child) => ({
                number: child.issueNumber,
                title: sanitizeInlineText(child.title, ISSUE_TITLE_MAX_LENGTH),
                checked: child.checked,
              })),
      }));
    return {
      folder,
      roadmaps,
      issues: issues.map(({ number, title, roadmap }) => ({ number, title, roadmap })),
    };
  };

  // `start_roadmap_orchestrator`（`agent.taskRun.startRoadmapFromChat`）と同じ関数で起動する
  const startRoadmap = async (
    request: McIssueStartRequest,
    issueNumber: number,
    maxParallel: number,
  ): Promise<{ ok: boolean; message: string }> => {
    const roadmap = `roadmap #${String(issueNumber)}`;
    const result = await startRoadmapRunFromChat(deps.roadmapStartDeps(request.engine), {
      folder: request.folder,
      engine: request.engine,
      issueNumber,
      maxParallel,
    });
    if (!result.accepted) {
      return {
        ok: false,
        message: `${roadmap}: ${sanitizeInlineText(result.reason, MESSAGE_MAX_LENGTH)}`,
      };
    }
    return {
      ok: true,
      message:
        result.reused === true
          ? `${roadmap}の既存のrunを開きました`
          : `${roadmap}でrunを始めました（計画の承認待ち）`,
    };
  };

  // `agent.taskRun.start`の自由な指示から始めるrunと同じ関数（`startRun`→Kanban→Orchestrator）で
  // 起動し、選んだIssue番号を最初の指示文として渡す
  const startFreeRun = async (
    request: McIssueStartRequest,
    maxParallel: number,
  ): Promise<{ ok: boolean; message: string }> => {
    const list = request.issueNumbers.map((n) => `#${String(n)}`).join(', ');
    const outcome = await controller.startRun({
      workspaceRoot: request.folder,
      engine: request.engine,
      maxParallel,
      title: sanitizeInlineText(`Issue ${list}`, TASK_RUN_TITLE_MAX_LENGTH),
      // 同じフォルダで動いているrunがあっても、選んだIssueのrunを別に始める
      parallel: true,
    });
    if (!outcome.ok) {
      log.warn(`[task run] Mission Controlからの起動に失敗: ${outcome.message}`);
      return { ok: false, message: outcome.message };
    }
    view.show(outcome.runId);
    const opened = await deps.orchestrator.open(
      outcome.runId,
      false,
      `Issue ${list}を実装してください（Mission ControlでIssueを選んで始めたrun）。` +
        '各Issueをget_issueで読み、既存のIssueのタスク（existingIssueNumber）にした計画をpropose_planで提案してください。',
    );
    if (!opened) {
      return {
        ok: false,
        message: `Issue ${list}でrunは始めましたが、Orchestratorを開けませんでした。Kanbanから開き直してください`,
      };
    }
    return { ok: true, message: `Issue ${list}でrunを始めました` };
  };

  const startFromIssues = async (
    request: McIssueStartRequest,
  ): Promise<{ ok: boolean; message: string }> => {
    const maxParallel = Math.min(deps.defaultMaxParallel(), MAX_TASK_RUN_PARALLEL);
    const results: { ok: boolean; message: string }[] = [];
    // roadmapは1本ずつ起動する（前の起動が終わってから次へ進む）
    for (const issueNumber of request.roadmapIssueNumbers) {
      results.push(await startRoadmap(request, issueNumber, maxParallel));
    }
    if (request.issueNumbers.length > 0) {
      results.push(await startFreeRun(request, maxParallel));
    }
    return {
      ok: results.every((r) => r.ok),
      message: results.map((r) => r.message).join(' / '),
    };
  };

  return {
    snapshot: (currentFolders) => {
      const { runs } = controller.board(undefined, currentFolders);
      const details = new Map<string, TaskRunKanbanRun>();
      for (const summary of runs) {
        if (summary.finished) {
          continue;
        }
        const run = controller.board(summary.runId, currentFolders).run;
        if (run?.runId === summary.runId) {
          details.set(summary.runId, run);
        }
      }
      return buildMcRuns(runs, details, currentWorkspaceFolders(), MAX_TASK_RUN_PARALLEL);
    },
    onDidChange: (listener) => controller.onTransition(() => listener()),
    runOp,
    taskOp,
    setMaxParallel: async (runId, maxParallel) =>
      failure(await controller.setMaxParallel(runId, maxParallel)),
    start: async () => {
      await vscode.commands.executeCommand('agent.taskRun.start');
      return undefined;
    },
    listIssues,
    startFromIssues,
  };
}
