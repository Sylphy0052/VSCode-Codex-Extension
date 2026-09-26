import { isBranchOrTagDelete, normalizeCommand } from './escalation';
import { MESSAGING_MCP_SERVER_NAME } from './messaging';
import { isReadOnlyCommandApproval } from './readOnlyCommand';
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

/**
 * 工程セッションの承認ハンドラ。merge・リモートブランチ削除は`mergeCleanup`工程以外で人へ回し、
 * 読み取り専用のコマンド（`isReadOnlyCommandApproval`）は`allowAutoApprove`が無効でも許可する（Issue #1535）。
 */
export function stageApprovalHandler(stage: TaskStage, autoApprove: boolean): ApprovalHandler {
  return async (_approval, rawParams) => {
    const tool = stageToolName(rawParams);
    if (tool !== undefined && AUTO_APPROVED_STAGE_TOOLS.has(tool)) {
      return { kind: 'auto', decision: 'accept' };
    }
    if (stage !== 'mergeCleanup' && isMergeOrRemoteBranchDelete(commandOf(rawParams))) {
      return { kind: 'ask' };
    }
    if (autoApprove || isReadOnlyCommandApproval(rawParams)) {
      return { kind: 'auto', decision: 'accept' };
    }
    return { kind: 'ask' };
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
