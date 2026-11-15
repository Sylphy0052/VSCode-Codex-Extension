import * as vscode from 'vscode';
import { readWorkflowsConfig } from '../config';
import type { Logger } from '../log';
import { nodeForgeFileSystem, type CliCommandRunner } from '../orchestrator/forge';
import { createCliIssueListPort } from '../orchestrator/roadmap';
import { importRoadmap } from '../orchestrator/roadmapImport';
import { hashRoadmapPlanSectionContent } from '../orchestrator/roadmapPlanHash';
import { detectRoadmapForgeHost } from '../orchestrator/roadmapRunForge';
import type { ControllerResult, TaskRunController } from '../orchestrator/taskRunController';
import { TASK_RUN_TITLE_MAX_LENGTH, type TaskRunEngine } from '../orchestrator/taskRunState';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type { GitCommandRunner } from '../orchestrator/worktree';

/**
 * ロードマップIssueからオーケストレータモードのrunを始める（Issue #1623）。コマンドパレットの
 * 「オーケストレータモードを開始」とワークフローViewのロードマップ欄から呼ぶ。
 */

const ISSUE_TITLE_MAX_LENGTH = 200;
const PLAN_ERRORS_SHOWN = 3;
const PLAN_ERROR_MAX_LENGTH = 200;
const ENTER_NUMBER = 'enter-number';

export interface RunSettings {
  engine: TaskRunEngine;
  maxParallel: number;
  title: string;
}

export interface RoadmapRunStartDeps {
  controller: TaskRunController;
  git: GitCommandRunner;
  cli: CliCommandRunner;
  log: Logger;
  /** CLI・並列上限・名前を尋ねる。取り消されたら`undefined`。 */
  askSettings(defaultTitle: string): Promise<RunSettings | undefined>;
  /** 中断中のrunを再開してKanbanとOrchestratorへ出す。 */
  resumeRun(runId: string): Promise<ControllerResult>;
  showRun(runId: string): void;
}

interface PickedRoadmap {
  issueNumber: number;
  /** 外部由来。表示前に`sanitizeInlineText`を通す。 */
  title: string | undefined;
}

export async function startRoadmapRunCommand(
  deps: RoadmapRunStartDeps,
  folder: string,
  issueNumber: number | undefined,
): Promise<void> {
  const host = await detectRoadmapForgeHost({ git: deps.git, cli: deps.cli }, folder);
  if (host === undefined) {
    showError('originがGitHub/GitLabのリポジトリではないため、ロードマップIssueを読めません');
    return;
  }
  const roadmap = await pickRoadmapIssue(deps, folder, issueNumber);
  if (roadmap === undefined) {
    return;
  }
  const existing = deps.controller.findRoadmapRun(folder, roadmap.issueNumber);
  if (existing !== undefined) {
    await openExistingRun(deps, existing.runId, existing.suspendedAt !== undefined);
    return;
  }
  const imported = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ロードマップIssue #${String(roadmap.issueNumber)}を読んでいます…`,
    },
    () =>
      importRoadmap(
        { cli: deps.cli, fs: nodeForgeFileSystem },
        { host, cwd: folder, roadmapIssueNumber: roadmap.issueNumber },
      ),
  );
  if (imported.kind === 'failed') {
    showError(imported.message);
    return;
  }
  if (imported.plan.kind === 'invalid') {
    const errors = imported.plan.errors
      .slice(0, PLAN_ERRORS_SHOWN)
      .map((e) => sanitizeInlineText(e, PLAN_ERROR_MAX_LENGTH));
    void vscode.window.showWarningMessage(
      `オーケストレータモード: ロードマップの計画区画を読めないため、子Issueの並び順で始めます（${errors.join(' / ')}）`,
    );
  }
  const roadmapTitle = roadmap.title ?? `ロードマップIssue #${String(roadmap.issueNumber)}`;
  const settings = await deps.askSettings(
    sanitizeInlineText(roadmapTitle, TASK_RUN_TITLE_MAX_LENGTH),
  );
  if (settings === undefined) {
    return;
  }
  const outcome = await deps.controller.startRoadmapRun({
    workspaceRoot: folder,
    ...settings,
    roadmapIssueNumber: roadmap.issueNumber,
    roadmapTitle,
    children: imported.children,
    planNodes: imported.plan.kind === 'valid' ? imported.plan.nodes : undefined,
    planSectionHash:
      imported.plan.kind === 'valid'
        ? hashRoadmapPlanSectionContent(imported.plan.content)
        : undefined,
  });
  if (!outcome.ok) {
    deps.log.warn(`[task run] ${outcome.message}`);
    showError(outcome.message);
    return;
  }
  if (outcome.reused) {
    void vscode.window.showInformationMessage(
      'このロードマップIssueのrunがあるため、それを開きます（選んだCLI・並列上限・名前は使いません）',
    );
  }
  if (outcome.planMessage !== undefined && !outcome.planMessage.ok) {
    deps.log.warn(`[task run] ロードマップの初期計画: ${outcome.planMessage.message}`);
    void vscode.window.showWarningMessage(
      `オーケストレータモード: ロードマップから作った計画を置けませんでした。Orchestratorが計画を提案し直します（${outcome.planMessage.message}）`,
    );
  }
  deps.showRun(outcome.runId);
}

/** `start_roadmap_orchestrator`が呼び出し元チャットから渡す値（Issue #2070）。 */
export interface RoadmapRunFromChatInput {
  /** 呼び出し元チャットのワークスペースフォルダ。 */
  folder: string;
  /** 呼び出し元チャットのengine。 */
  engine: TaskRunEngine;
  /** 省略時はroadmapラベルのopenなIssueが1本のときだけそれを使う。 */
  issueNumber: number | undefined;
  /** 並列上限。`agent.taskRun.maxParallelPerFolder`を呼び出し側が丸めて渡す。 */
  maxParallel: number;
}

export interface RoadmapRunFromChatResult {
  accepted: boolean;
  reason: string;
  runId?: string | undefined;
  reused?: boolean | undefined;
}

const CANDIDATES_SHOWN = 5;

/**
 * チャットのモデルからロードマップのrunを起動する（Issue #2070）。QuickPickやInputBoxは出さない。
 * 同じIssueのrunが既にあれば新しく作らず、中断中なら再開してからロードマップを読み直させる。
 * 人の関門は従来どおり計画承認（runは`awaitingApproval`で始まる）。
 */
export async function startRoadmapRunFromChat(
  deps: RoadmapRunStartDeps,
  input: RoadmapRunFromChatInput,
): Promise<RoadmapRunFromChatResult> {
  const { folder } = input;
  const host = await detectRoadmapForgeHost({ git: deps.git, cli: deps.cli }, folder);
  if (host === undefined) {
    return {
      accepted: false,
      reason: 'originがGitHub/GitLabのリポジトリではないため、ロードマップIssueを読めません',
    };
  }
  const picked = await resolveRoadmapIssueForChat(deps, folder, input.issueNumber);
  if (!('issueNumber' in picked)) {
    return { accepted: false, reason: picked.reason };
  }
  const existing = deps.controller.findRoadmapRun(folder, picked.issueNumber);
  if (existing !== undefined) {
    return reloadExistingRun(deps, existing.runId, existing.suspendedAt !== undefined);
  }
  const imported = await importRoadmap(
    { cli: deps.cli, fs: nodeForgeFileSystem },
    { host, cwd: folder, roadmapIssueNumber: picked.issueNumber },
  );
  if (imported.kind === 'failed') {
    return { accepted: false, reason: sanitizeInlineText(imported.message, PLAN_ERROR_MAX_LENGTH) };
  }
  const roadmapTitle = picked.title ?? `ロードマップIssue #${String(picked.issueNumber)}`;
  const outcome = await deps.controller.startRoadmapRun({
    workspaceRoot: folder,
    engine: input.engine,
    maxParallel: input.maxParallel,
    title: sanitizeInlineText(roadmapTitle, TASK_RUN_TITLE_MAX_LENGTH),
    roadmapIssueNumber: picked.issueNumber,
    roadmapTitle,
    children: imported.children,
    planNodes: imported.plan.kind === 'valid' ? imported.plan.nodes : undefined,
    planSectionHash:
      imported.plan.kind === 'valid'
        ? hashRoadmapPlanSectionContent(imported.plan.content)
        : undefined,
  });
  if (!outcome.ok) {
    deps.log.warn(`[task run] ${outcome.message}`);
    return { accepted: false, reason: sanitizeInlineText(outcome.message, PLAN_ERROR_MAX_LENGTH) };
  }
  deps.showRun(outcome.runId);
  return {
    accepted: true,
    runId: outcome.runId,
    reused: outcome.reused,
    reason:
      `ロードマップIssue #${String(picked.issueNumber)}のrunを始めました。計画は承認待ちで、` +
      '利用者がKanbanで承認すると工程が進みます。このターンは終えてください',
  };
}

/** 既存runを再開（中断中のとき）してロードマップを読み直させる。 */
async function reloadExistingRun(
  deps: RoadmapRunStartDeps,
  runId: string,
  suspended: boolean,
): Promise<RoadmapRunFromChatResult> {
  if (suspended) {
    const resumed = await deps.resumeRun(runId);
    if (!resumed.ok) {
      deps.log.warn(`[task run] ${resumed.message}`);
      return {
        accepted: false,
        runId,
        reason: `中断中のrunを再開できませんでした: ${sanitizeInlineText(resumed.message, PLAN_ERROR_MAX_LENGTH)}`,
      };
    }
  }
  const synced = await deps.controller.syncRoadmap(runId);
  deps.showRun(runId);
  const base = suspended ? '中断中のrunを再開し、' : '既存のrunがあるため、';
  if (!synced.ok) {
    deps.log.warn(`[task run] ${synced.message}`);
    return {
      accepted: false,
      runId,
      reused: true,
      reason:
        `${base}新しいrunは作りませんでした。ただしロードマップの読み直しに失敗しました: ` +
        sanitizeInlineText(synced.message, PLAN_ERROR_MAX_LENGTH),
    };
  }
  return {
    accepted: true,
    runId,
    reused: true,
    reason:
      `${base}新しいrunは作らずロードマップを読み直させました。` +
      '足した子Issueは差分としてOrchestratorへ届きます。このターンは終えてください',
  };
}

/** 番号があればそれ、無ければroadmapラベルのopenなIssueが1本のときだけそれを選ぶ。QuickPickは出さない。 */
async function resolveRoadmapIssueForChat(
  deps: RoadmapRunStartDeps,
  folder: string,
  issueNumber: number | undefined,
): Promise<PickedRoadmap | { reason: string }> {
  const { roadmapIssueLabel } = readWorkflowsConfig();
  const issues = await createCliIssueListPort(
    deps.git,
    deps.cli,
    issueNumber === undefined ? { label: roadmapIssueLabel } : undefined,
  ).listIssues(folder);
  if (issueNumber !== undefined) {
    const found = (issues ?? []).find((issue) => issue.number === issueNumber);
    return { issueNumber, title: found?.title };
  }
  if (issues === undefined) {
    return { reason: 'Issueの一覧を取得できませんでした。roadmapIssueNumberを指定してください' };
  }
  const wantedLabel = roadmapIssueLabel.toLowerCase();
  const candidates = issues.filter((issue) =>
    (issue.labels ?? []).some((label) => label.toLowerCase() === wantedLabel),
  );
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) {
    return { issueNumber: only.number, title: only.title };
  }
  if (candidates.length === 0) {
    return {
      reason: `「${roadmapIssueLabel}」ラベルの付いたopenのIssueが見つかりません。roadmapIssueNumberを指定してください`,
    };
  }
  const list = candidates
    .slice(0, CANDIDATES_SHOWN)
    .map((c) => `#${String(c.number)} ${sanitizeInlineText(c.title, ISSUE_TITLE_MAX_LENGTH)}`)
    .join(' / ');
  return {
    reason: `ロードマップIssueの候補が${String(candidates.length)}本あります。roadmapIssueNumberを指定してください（${list}）`,
  };
}

async function openExistingRun(
  deps: RoadmapRunStartDeps,
  runId: string,
  suspended: boolean,
): Promise<void> {
  if (!suspended) {
    void vscode.window.showInformationMessage(
      'このロードマップIssueのrunが動いているため、それを開きます',
    );
    deps.showRun(runId);
    return;
  }
  const resumed = await deps.resumeRun(runId);
  if (!resumed.ok) {
    deps.log.warn(`[task run] ${resumed.message}`);
    showError(resumed.message);
    return;
  }
  void vscode.window.showInformationMessage(
    'このロードマップIssueの中断中のrunがあるため、それを再開しました',
  );
}

/**
 * ロードマップIssueを選ぶ。番号を渡されたらそのIssueにする（題は一覧から引く）。一覧を取れなければ
 * 番号の入力に切り替える。
 */
async function pickRoadmapIssue(
  deps: RoadmapRunStartDeps,
  folder: string,
  issueNumber: number | undefined,
): Promise<PickedRoadmap | undefined> {
  const { roadmapIssueLabel } = readWorkflowsConfig();
  // 選ぶときはラベルをCLI側でも絞る。一覧の上限の外にあるロードマップIssueを取りこぼさないため
  // （Issue #1701）。番号を渡されたときは題を引くだけなので、ラベルの無いIssueも引けるよう絞らない
  const issues = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ロードマップIssueを取得しています…' },
    () =>
      createCliIssueListPort(
        deps.git,
        deps.cli,
        issueNumber === undefined ? { label: roadmapIssueLabel } : undefined,
      ).listIssues(folder),
  );
  const wantedLabel = roadmapIssueLabel.toLowerCase();
  const roadmapIssues = (issues ?? []).filter((issue) =>
    (issue.labels ?? []).some((label) => label.toLowerCase() === wantedLabel),
  );
  if (issueNumber !== undefined) {
    const found = (issues ?? []).find((issue) => issue.number === issueNumber);
    return { issueNumber, title: found?.title };
  }
  if (roadmapIssues.length === 0) {
    return askRoadmapIssueNumber(
      issues === undefined
        ? 'Issueの一覧を取得できませんでした'
        : `「${roadmapIssueLabel}」ラベルの付いたopenのIssueが見つかりません`,
    );
  }
  const items: (vscode.QuickPickItem & { issue?: PickedRoadmap; value?: string })[] = [
    ...roadmapIssues.map((issue) => ({
      label: `#${String(issue.number)} ${sanitizeInlineText(issue.title, ISSUE_TITLE_MAX_LENGTH)}`,
      issue: { issueNumber: issue.number, title: issue.title },
    })),
    { label: '番号を入力する', value: ENTER_NUMBER },
  ];
  const chosen = await vscode.window.showQuickPick(items, {
    title: 'オーケストレータモードで実行するロードマップIssue',
    ignoreFocusOut: true,
  });
  if (chosen === undefined) {
    return undefined;
  }
  return chosen.issue ?? askRoadmapIssueNumber(undefined);
}

async function askRoadmapIssueNumber(
  reason: string | undefined,
): Promise<PickedRoadmap | undefined> {
  const input = await vscode.window.showInputBox({
    title: 'ロードマップIssueの番号',
    prompt: reason === undefined ? '#は付けずに番号だけ入力します' : `${reason}。番号を入力します`,
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[1-9][0-9]{0,8}$/.test(value.trim()) ? undefined : '1以上の整数で入力してください',
  });
  return input === undefined ? undefined : { issueNumber: Number(input.trim()), title: undefined };
}

function showError(message: string): void {
  void vscode.window.showErrorMessage(`オーケストレータモード: ${message}`);
}
