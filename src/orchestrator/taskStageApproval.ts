import {
  isBranchOrTagDelete,
  normalizeCommand,
  type EscalationRequest,
  type EscalationResult,
} from './escalation';
import { MESSAGING_MCP_SERVER_NAME } from './messaging';
import { ROADMAP_ASK_ORCHESTRATOR_TOOL } from './roadmapQuestionMcp';
import type { TaskStage } from './taskRunState';
import type { ApprovalHandler } from './taskSession';
import { REPORT_STAGE_RESULT_TOOL } from './taskStagePrompts';

/**
 * オーケストレータモード（Issue #1505）の工程セッションの承認ハンドラ。
 *
 * 報告と質問のMCPツールは常に許可する。PRのmergeとリモートブランチの削除は取り消せないので、
 * mergeCleanupの工程でだけ許可し、ほかの工程では人へ回す。それ以外は`autoApprove`に従う。
 */

const AUTO_APPROVED_STAGE_TOOLS: ReadonlySet<string> = new Set([
  REPORT_STAGE_RESULT_TOOL,
  ROADMAP_ASK_ORCHESTRATOR_TOOL.name,
]);

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function stageToolName(rawParams: Record<string, unknown>): string | undefined {
  const name = rawParams['tool_name'];
  const prefix = `mcp__${MESSAGING_MCP_SERVER_NAME}__`;
  return typeof name === 'string' && name.startsWith(prefix)
    ? name.slice(prefix.length)
    : undefined;
}

/** Claudeは`input.command`、Codexは`command`（文字列か配列）にコマンドを載せる。 */
function commandOf(rawParams: Record<string, unknown>): string {
  const input = rec(rawParams['input']);
  const claude = input?.['command'];
  return typeof claude === 'string' ? claude : normalizeCommand(rawParams['command']);
}

/**
 * PRのmergeか、リモートのブランチの削除に当たるコマンド。`git push origin :<branch>`の
 * 空の送り元による削除も含める。
 */
export function isMergeOrRemoteBranchDelete(command: string): boolean {
  return (
    /\bgh\s+pr\s+merge\b/i.test(command) ||
    /\bglab\s+mr\s+merge\b/i.test(command) ||
    /\bgh\s+api\b[^\n]*\/merge\b/i.test(command) ||
    /\bglab\s+api\b[^\n]*\/merge\b/i.test(command) ||
    /\bgit\s+push\b[^\n]*\s\+?:[^\s]+/i.test(command) ||
    isBranchOrTagDelete(command)
  );
}

/** 工程セッションが`AskUserQuestion`を呼んだときにCLIへ返す拒否の理由（Issue #1694）。 */
export const STAGE_ASK_USER_QUESTION_DENY_MESSAGE =
  '工程セッションではAskUserQuestionを使えません。質問・確認・方針の相談は' +
  `${ROADMAP_ASK_ORCHESTRATOR_TOOL.name}でOrchestratorへ送ってください。`;

export function stageApprovalHandler(stage: TaskStage, autoApprove: boolean): ApprovalHandler {
  return async (approval, rawParams) => {
    // 工程セッションには人が張り付いていないため、質問はOrchestratorへ回させる
    if (approval.kind === 'askUserQuestion') {
      return { kind: 'auto', decision: 'decline', message: STAGE_ASK_USER_QUESTION_DENY_MESSAGE };
    }
    const tool = stageToolName(rawParams);
    if (tool !== undefined && AUTO_APPROVED_STAGE_TOOLS.has(tool)) {
      return { kind: 'auto', decision: 'accept' };
    }
    if (stage !== 'mergeCleanup' && isMergeOrRemoteBranchDelete(commandOf(rawParams))) {
      return { kind: 'ask' };
    }
    return autoApprove ? { kind: 'auto', decision: 'accept' } : { kind: 'ask' };
  };
}

/**
 * `agent.workflows.fullAutoApprove`（Issue #1656）が効いたワークフローのタスクの承認判定。
 *
 * 工程セッションのmergeCleanup以外の工程と同じ基準にそろえ、PRのmergeとリモートブランチの
 * 削除だけを人へ回す。危険パターンと境界の判定（`classifyApprovalRequest`）は通さない。
 */
export function classifyFullAutoApproval(request: EscalationRequest): EscalationResult {
  if (request.kind === 'command' && isMergeOrRemoteBranchDelete(request.command)) {
    return {
      decision: 'ask',
      reasons: ['PRのmergeかリモートブランチの削除のため、fullAutoApproveでも人へ回します'],
    };
  }
  return {
    decision: 'auto',
    reasons: ['fullAutoApproveが有効なため、危険判定を通さず許可しました'],
  };
}

/** CodexのMCP elicitationのうち、報告と質問のツールだけを許可する。 */
export function shouldAutoApproveStageElicitation(params: Record<string, unknown>): boolean {
  if (params['serverName'] !== MESSAGING_MCP_SERVER_NAME || typeof params['message'] !== 'string') {
    return false;
  }
  const match = /run tool "([^"]+)"\?$/.exec(params['message']);
  return match !== null && AUTO_APPROVED_STAGE_TOOLS.has(match[1] ?? '');
}
