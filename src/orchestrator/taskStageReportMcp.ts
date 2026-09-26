import type { McpToolDefinition } from './messaging';
import { isValidIssueNumber } from './roadmapRunState';
import { TASK_STAGES, type StageOutput, type StageReportRef, type TaskStage } from './taskRunState';
import { REPORT_STAGE_RESULT_TOOL } from './taskStagePrompts';

/**
 * オーケストレータモード（Issue #1505）の工程セッションが結果を報告するMCPツール
 * `report_stage_result`。質問用の`ask_orchestrator`と同じ接続（同じURLとトークン）へ
 * `RoadmapQuestionMcpServer.registerTools`で足す。
 *
 * 報告には`taskId`・`executionId`・工程・実行回を付けさせ、接続を開いたときの値と一致しない
 * ものは受け付けない（ほかのタスクの報告を装わせない）。現在の実行回との照合は受け手が
 * `checkStageReport`で行う（引き継ぎ前の古いセッションから遅れて届いた報告を捨てる）。
 */

const MAX_ID_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_ISSUE_TITLE_LENGTH = 256;
const MAX_ISSUE_BODY_LENGTH = 60_000;
const MAX_URL_LENGTH = 500;
const MAX_FINDINGS = 50;
const MAX_FINDING_LENGTH = 1000;

export const REPORT_STAGE_RESULT_DEFINITION: McpToolDefinition = {
  name: REPORT_STAGE_RESULT_TOOL,
  description:
    'オーケストレータモードの工程の結果をControllerへ報告する。工程が終わったとき（またはこれ以上進められないとき）に1回だけ呼び、呼んだら作業を終える。taskId・executionId・stage・attemptIdは指示文に書かれた値をそのまま付ける。',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      executionId: { type: 'string' },
      stage: { type: 'string', enum: [...TASK_STAGES] },
      attemptId: { type: 'string' },
      outcome: {
        type: 'string',
        enum: ['done', 'failed'],
        description: 'done: 工程を終えた / failed: 進められなかった',
      },
      summary: {
        type: 'string',
        description: `やったことの要約、またはfailedの理由（${String(MAX_SUMMARY_LENGTH)}文字以内）`,
      },
      issueTitle: { type: 'string', description: 'issuePlan: 作ったIssueのタイトル' },
      issueBody: { type: 'string', description: 'issuePlan: 作ったIssueの本文' },
      issueNumber: { type: 'integer', minimum: 1, description: 'issueCreate: 起票したIssueの番号' },
      pullRequestNumber: { type: 'integer', minimum: 1, description: 'implement: 作ったPRの番号' },
      pullRequestUrl: { type: 'string', description: 'implement: 作ったPRのURL' },
      reviewSummary: { type: 'string', description: 'review: レビューの要約' },
      remainingFindings: {
        type: 'array',
        items: { type: 'string' },
        description: 'review: 直さずに残した指摘（1件1要素）',
      },
      reviewPassed: {
        type: 'boolean',
        description: 'review: high・mediumの指摘が残っていなければtrue',
      },
    },
    required: ['taskId', 'executionId', 'stage', 'attemptId', 'outcome', 'summary'],
    additionalProperties: false,
  },
};

/** 受け付けた報告。`outcome`が`done`なら工程の成果（`output`）を持つ。 */
export type StageReport =
  | { ref: StageReportRef; outcome: 'done'; summary: string; output: StageOutput }
  | { ref: StageReportRef; outcome: 'failed'; summary: string };

type ParseResult = { ok: true; report: StageReport } | { ok: false; message: string };

function readId(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  return typeof v === 'string' && v !== '' && v.length <= MAX_ID_LENGTH ? v : undefined;
}

function readText(a: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const v = a[key];
  if (typeof v !== 'string') {
    return undefined;
  }
  const trimmed = v.trim();
  return trimmed !== '' && trimmed.length <= maxLength ? trimmed : undefined;
}

function isTaskStage(v: unknown): v is TaskStage {
  return typeof v === 'string' && (TASK_STAGES as readonly string[]).includes(v);
}

function parseOutput(
  stage: TaskStage,
  a: Record<string, unknown>,
): { ok: true; output: StageOutput } | { ok: false; message: string } {
  switch (stage) {
    case 'issuePlan': {
      const title = readText(a, 'issueTitle', MAX_ISSUE_TITLE_LENGTH);
      const body = readText(a, 'issueBody', MAX_ISSUE_BODY_LENGTH);
      if (title === undefined || body === undefined) {
        return {
          ok: false,
          message: `issuePlanのdoneにはissueTitle（${String(MAX_ISSUE_TITLE_LENGTH)}文字以内）とissueBody（${String(MAX_ISSUE_BODY_LENGTH)}文字以内）が要る`,
        };
      }
      return { ok: true, output: { stage, issueDraft: { title, body } } };
    }
    case 'issueCreate': {
      const n = a.issueNumber;
      if (typeof n !== 'number' || !isValidIssueNumber(n)) {
        return { ok: false, message: 'issueCreateのdoneにはissueNumber（1以上の整数）が要る' };
      }
      return { ok: true, output: { stage, issueNumber: n } };
    }
    case 'implement': {
      const n = a.pullRequestNumber;
      const url = readText(a, 'pullRequestUrl', MAX_URL_LENGTH);
      if (
        typeof n !== 'number' ||
        !isValidIssueNumber(n) ||
        url === undefined ||
        !/^https?:\/\//u.test(url)
      ) {
        return {
          ok: false,
          message:
            'implementのdoneにはpullRequestNumber（1以上の整数）とpullRequestUrl（http(s)のURL）が要る',
        };
      }
      return { ok: true, output: { stage, pullRequest: { number: n, url } } };
    }
    case 'review': {
      const summary = readText(a, 'reviewSummary', MAX_SUMMARY_LENGTH);
      const passed = a.reviewPassed;
      const raw = a.remainingFindings ?? [];
      if (summary === undefined || typeof passed !== 'boolean' || !Array.isArray(raw)) {
        return {
          ok: false,
          message:
            'reviewのdoneにはreviewSummary、reviewPassed（真偽値）、remainingFindings（文字列の配列）が要る',
        };
      }
      const findings = raw.filter((f): f is string => typeof f === 'string' && f.trim() !== '');
      if (findings.length !== raw.length || findings.length > MAX_FINDINGS) {
        return {
          ok: false,
          message: `remainingFindingsは空でない文字列の配列（${String(MAX_FINDINGS)}件以内）で指定する`,
        };
      }
      return {
        ok: true,
        output: {
          stage,
          review: {
            summary,
            remainingFindings: findings.map((f) => f.trim().slice(0, MAX_FINDING_LENGTH)),
            passed,
          },
        },
      };
    }
    case 'mergeCleanup':
      return { ok: true, output: { stage } };
  }
}

/**
 * `report_stage_result`の引数を検証する。`bound`は接続を開いたときの報告先で、一致しない
 * 報告は受け付けない。
 */
export function parseStageReport(raw: unknown, bound: StageReportRef): ParseResult {
  const a: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const taskId = readId(a, 'taskId');
  const executionId = readId(a, 'executionId');
  const attemptId = readId(a, 'attemptId');
  const stage = a.stage;
  if (
    taskId === undefined ||
    executionId === undefined ||
    attemptId === undefined ||
    !isTaskStage(stage)
  ) {
    return {
      ok: false,
      message: 'taskId・executionId・stage・attemptIdは指示文に書かれた値をそのまま付ける',
    };
  }
  const ref: StageReportRef = { taskId, executionId, stage, attemptId };
  if (
    ref.taskId !== bound.taskId ||
    ref.executionId !== bound.executionId ||
    ref.stage !== bound.stage ||
    ref.attemptId !== bound.attemptId
  ) {
    return { ok: false, message: 'このセッションの担当と異なる工程の報告は受け付けない' };
  }
  const summary = readText(a, 'summary', MAX_SUMMARY_LENGTH);
  if (summary === undefined) {
    return { ok: false, message: `summaryは1〜${String(MAX_SUMMARY_LENGTH)}文字で指定する` };
  }
  const outcome = a.outcome;
  if (outcome === 'failed') {
    return { ok: true, report: { ref, outcome, summary } };
  }
  if (outcome !== 'done') {
    return { ok: false, message: 'outcomeはdoneかfailedで指定する' };
  }
  const parsed = parseOutput(stage, a);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, report: { ref, outcome, summary, output: parsed.output } };
}
