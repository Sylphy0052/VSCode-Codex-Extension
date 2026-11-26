import * as vscode from 'vscode';
import type {
  StartRoadmapOrchestratorToolArgs,
  StartRoadmapOrchestratorToolResult,
} from '../orchestrator/messaging';
import type { TaskRunEngine } from '../orchestrator/taskRunState';
import { sanitizeInlineText } from '../orchestrator/untrustedText';

/**
 * チャットのモデルが`start_roadmap_orchestrator`で呼ぶロードマップrunの起動（Issue #2070）。
 * 起動そのものは`agent.taskRun.startRoadmapFromChat`（`taskRunSetup.ts`）が行う。ここは
 * 呼び出し元チャットのフォルダとengineを渡し、起動の事実と`reason`を会話へ残す。
 */

const REASON_MAX_LENGTH = 200;

export interface StartRoadmapOrchestratorHost {
  engine: TaskRunEngine;
  /** 呼び出し元チャットのフォルダ。決まらなければ`undefined`。 */
  folder(): string | undefined;
  /** 会話と作業ログへ残す。 */
  note(text: string): void;
  log(text: string): void;
}

export async function startRoadmapOrchestratorFromTool(
  host: StartRoadmapOrchestratorHost,
  args: StartRoadmapOrchestratorToolArgs,
): Promise<StartRoadmapOrchestratorToolResult> {
  const folder = host.folder();
  if (folder === undefined) {
    return { accepted: false, reason: 'このチャットのフォルダが決まっていないため起動できません' };
  }
  const reason = sanitizeInlineText(args.reason, REASON_MAX_LENGTH);
  let result: StartRoadmapOrchestratorToolResult | undefined;
  try {
    result = await vscode.commands.executeCommand<StartRoadmapOrchestratorToolResult>(
      'agent.taskRun.startRoadmapFromChat',
      {
        folder,
        engine: host.engine,
        ...(args.roadmapIssueNumber === undefined ? {} : { issueNumber: args.roadmapIssueNumber }),
        // 既存runの目的を直すときの理由として、goalと一緒に起動の理由も渡す（Issue #2193）
        ...(args.goal === undefined
          ? {}
          : {
              goal: {
                objective: args.goal.objective,
                completionCriteria: args.goal.completionCriteria,
              },
              reason,
            }),
      },
    );
  } catch (error) {
    const message = sanitizeInlineText(
      error instanceof Error ? error.message : String(error),
      REASON_MAX_LENGTH,
    );
    host.note(`オーケストレータモード: 起動に失敗しました（${message}）`);
    host.log(`start_roadmap_orchestrator: 失敗 ${message}`);
    return { accepted: false, reason: `オーケストレータモードを起動できませんでした: ${message}` };
  }
  if (result === undefined) {
    return { accepted: false, reason: 'オーケストレータモードが利用できません' };
  }
  const outcome = result.accepted
    ? result.reused === true
      ? `既存のrun ${result.runId ?? ''}を読み直させました`
      : `run ${result.runId ?? ''}を起動しました`
    : `起動しませんでした（${result.reason}）`;
  host.note(`オーケストレータモード: ${outcome}。理由: ${reason}${formatGoalNote(args, result)}`);
  host.log(`start_roadmap_orchestrator: ${outcome}`);
  return result;
}

/** 会話へ残す目的の行（Issue #2193）。渡したgoalがrunに入ったときだけ出す。 */
function formatGoalNote(
  args: StartRoadmapOrchestratorToolArgs,
  result: StartRoadmapOrchestratorToolResult,
): string {
  if (args.goal === undefined || result.goalApplied !== true) {
    return '';
  }
  const objective = sanitizeInlineText(args.goal.objective, REASON_MAX_LENGTH);
  const criteria = sanitizeInlineText(args.goal.completionCriteria ?? '', REASON_MAX_LENGTH);
  return `。目的: ${objective} / 完了条件: ${criteria}`;
}
