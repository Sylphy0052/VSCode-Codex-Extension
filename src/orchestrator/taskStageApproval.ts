import {
  hasShellMetacharacters,
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
 * mergeCleanupの工程でだけ許可し、ほかの工程では回答者判定（`judgeMerge`）にかけて、
 * オーケストレーターが決めてよければ許可し、それ以外は人へ回す（Issue #1771）。それ以外は
 * `autoApprove`に従う。
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

/**
 * PRのmergeか元ブランチのリモート削除を、承認なしに実行させてよいかの回答者判定（Issue #1771）。
 * オーケストレーターが決めてよければ`true`。判定の対象外・無効・失敗・時間切れなら`false`を返す。
 * 判定の対象かどうか（`isJudgeableMergeCommand`）は、タスクを知っている実装側が確かめる。
 */
export type MergeCommandJudge = (command: string) => Promise<boolean>;

/** 回答者判定にかけてよいmerge・削除の対象。タスクの元ブランチとPR番号。 */
export interface MergeCommandTarget {
  branch: string | undefined;
  pullRequestNumber: number | undefined;
}

const GH_PR_MERGE_FLAGS = new Set(['--merge', '-m', '--rebase', '-r', '--delete-branch', '-d', '--auto']);
const GLAB_MR_MERGE_FLAGS = new Set([
  '--rebase',
  '-r',
  '--remove-source-branch',
  '-d',
  '--yes',
  '-y',
  '--when-pipeline-succeeds',
  '--auto-merge',
]);
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD']);

/** mergeの対象の指定（無指定・タスクのPR番号・タスクの元ブランチ）がタスクのものか。 */
function isOwnMergeTarget(
  args: readonly string[],
  flags: ReadonlySet<string>,
  target: MergeCommandTarget,
): boolean {
  const positional = args.filter((a) => !flags.has(a));
  if (positional.some((a) => a.startsWith('-')) || positional.length > 1) {
    return false;
  }
  const [selector] = positional;
  return (
    selector === undefined ||
    selector === target.branch ||
    (target.pullRequestNumber !== undefined && selector === String(target.pullRequestNumber))
  );
}

/** タスクの元ブランチだけをリモートから消す`git push`か。 */
function isOwnRemoteBranchDelete(args: readonly string[], branch: string): boolean {
  const own = (ref: string) => ref === branch || ref === `refs/heads/${branch}`;
  const [first, second] = args;
  if (args.length === 2 && first === 'origin' && second?.startsWith(':') === true) {
    return own(second.slice(1));
  }
  const deleteFlag = args.findIndex((a) => a === '--delete' || a === '-d');
  if (args.length !== 3 || deleteFlag === -1) {
    return false;
  }
  const [remote, ref] = args.filter((_, i) => i !== deleteFlag);
  return remote === 'origin' && ref !== undefined && own(ref);
}

/**
 * PRのmergeと元ブランチのリモート削除のうち、回答者判定にかけてよいもの（Issue #1771）。
 * 判定はLLMなので、コマンドの形を許可リストで決め打ちし、外れるものは人へ回す。
 * - シェルのメタ文字（連結・置換・リダイレクト・改行）を含まない1コマンド
 * - `gh pr merge` / `glab mr merge`は、許可したフラグ（`--admin`・`--squash`・`-R`は含まない）と、
 *   無指定かタスクのPR番号・元ブランチの指定だけ
 * - `git push origin --delete <b>` / `git push origin :<b>`は、`<b>`がタスクの元ブランチのとき
 *   だけ（タグと保護ブランチは対象外）
 */
export function isJudgeableMergeCommand(command: string, target: MergeCommandTarget): boolean {
  if (hasShellMetacharacters(command)) {
    return false;
  }
  const tokens = command.trim().split(/\s+/);
  const [c0, c1, c2] = tokens;
  if (c0 === 'gh' && c1 === 'pr' && c2 === 'merge') {
    return isOwnMergeTarget(tokens.slice(3), GH_PR_MERGE_FLAGS, target);
  }
  if (c0 === 'glab' && c1 === 'mr' && c2 === 'merge') {
    return isOwnMergeTarget(tokens.slice(3), GLAB_MR_MERGE_FLAGS, target);
  }
  const branch = target.branch;
  if (c0 === 'git' && c1 === 'push' && branch !== undefined && !PROTECTED_BRANCHES.has(branch)) {
    return isOwnRemoteBranchDelete(tokens.slice(2), branch);
  }
  return false;
}

export function stageApprovalHandler(
  stage: TaskStage,
  autoApprove: boolean,
  judgeMerge?: MergeCommandJudge,
): ApprovalHandler {
  return async (approval, rawParams) => {
    // 工程セッションには人が張り付いていないため、質問はOrchestratorへ回させる
    if (approval.kind === 'askUserQuestion') {
      return { kind: 'auto', decision: 'decline', message: STAGE_ASK_USER_QUESTION_DENY_MESSAGE };
    }
    const tool = stageToolName(rawParams);
    if (tool !== undefined && AUTO_APPROVED_STAGE_TOOLS.has(tool)) {
      return { kind: 'auto', decision: 'accept' };
    }
    const command = commandOf(rawParams);
    if (stage !== 'mergeCleanup' && isMergeOrRemoteBranchDelete(command)) {
      // ツールの承認は同期で待つため、オーケストレーターの判断待ちを経由せず許可か人かの二択にする。
      // `autoApprove`が無効なら、ほかのコマンドと同じく人が承認する
      if (!autoApprove || judgeMerge === undefined) {
        return { kind: 'ask' };
      }
      // 判定の例外で承認要求が宙に浮かないよう、失敗は人へ回す
      const allowed = await judgeMerge(command).catch(() => false);
      return allowed ? { kind: 'auto', decision: 'accept' } : { kind: 'ask' };
    }
    return autoApprove ? { kind: 'auto', decision: 'accept' } : { kind: 'ask' };
  };
}

/**
 * `agent.workflows.fullAutoApprove`（Issue #1656）が効いたワークフローのタスクの承認判定。
 *
 * 工程セッションのmergeCleanup以外の工程と同じ基準にそろえ、PRのmergeとリモートブランチの
 * 削除だけを人へ回す。危険パターンと境界の判定（`classifyApprovalRequest`）は通さない。
 * 人へ回すもののうち`isJudgeableMergeCommand`に当たるものは、呼び出し側が回答者判定にかける
 * （Issue #1771）。
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
