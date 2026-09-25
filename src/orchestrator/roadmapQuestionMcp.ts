import { randomBytes } from 'node:crypto';

import { judgeAutoReplyAskUserQuestion } from '../chat/autoReplyReflex';
import type { AskUserQuestionItem } from '../claude/askUserQuestion';
import type { ReflexJudgeDeps } from '../reflex/reflexJudge';
import {
  failure,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpConnection,
  type McpToolDefinition,
  success,
  toolTextResult,
} from './messaging';
import { type HttpMcpServerHandle, startHttpMcpServer, type McpHttpTarget } from './mcpHttpServer';
import { ROADMAP_QUESTION_ESCALATIONS, type RoadmapQuestionEscalation } from './roadmapRunState';
import { sanitizeInlineText } from './untrustedText';

/**
 * ロードマップ実行（Issue #1465 分割案6a）のIssueセッションが質問を送るためのMCPサーバ。
 *
 * ワークフロー実行用の`MessagingMcpServer`（`messaging.ts`）とは別に、`ask_orchestrator`の
 * 1ツールだけを公開する。HTTP層は`startHttpMcpServer`を使い、接続元のIssueセッションは
 * URLのトークンからだけ決める（ツールの引数からは決めない）。サーバはウィンドウごとに1つで、
 * 最初の登録のときに立てる。
 *
 * 質問の振り分けと回答の届け方は`RoadmapIssueRunner`が持つ。ここは引数の検証と
 * JSON-RPCの受け答えだけを行う。
 */

export const MAX_QUESTION_LENGTH = 1000;
export const MAX_REASON_LENGTH = 1000;
export const MAX_EVIDENCE_LENGTH = 2000;
export const MAX_OPTIONS = 4;
export const MAX_OPTION_LENGTH = 120;

const ESCALATION_DESCRIPTIONS: Record<RoadmapQuestionEscalation, string> = {
  scopeChange: 'Issueの担当範囲を広げる・変える',
  requirementChange: '要件や受入基準を変える',
  publicInterface: '公開インターフェース（API・設定・コマンド）を変える',
  destructiveOperation: 'データやファイルを消す等の取り消せない操作',
  securityAuth: 'セキュリティ・認証・認可に関わる',
  largeDependency: '大きな依存を追加する',
  outsideRepoWrite: 'リポジトリの外へ書き込む',
  secrets: '秘密情報を扱う',
  release: 'リリース・配布に関わる',
  specConflict: 'Issueの仕様と実装・既存コードが矛盾する',
};

export const ROADMAP_ASK_ORCHESTRATOR_TOOL: McpToolDefinition = {
  name: 'ask_orchestrator',
  description: [
    'Issueの実装中に判断が必要になったとき、ロードマップのOrchestratorへ質問する。',
    'AskUserQuestionの代わりにこれを使う。選択肢があればOrchestratorが自動で選ぶことがあり、',
    'escalationに当たる質問は人の判断へ回る。',
    'blockingがtrueなら、呼んだ後はターンを終えて回答を待つ（回答は次の指示の冒頭に届く）。',
    'falseなら作業を続けてよく、回答は後の指示に添えて届く。',
  ].join(''),
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: `質問（${String(MAX_QUESTION_LENGTH)}文字以内）` },
      reason: {
        type: 'string',
        description: `判断が必要になった理由（${String(MAX_REASON_LENGTH)}文字以内）`,
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_OPTIONS,
        description: `選択肢（0〜${String(MAX_OPTIONS)}個、各${String(MAX_OPTION_LENGTH)}文字以内、重複不可）。無ければ人が自由記述で答える`,
      },
      recommended: { type: 'string', description: '推奨する選択肢（optionsのどれかと同じ文字列）' },
      blocking: { type: 'boolean', description: '回答が届くまで作業を進められないならtrue' },
      evidence: {
        type: 'string',
        description: `判断の材料（ファイル・行番号・出力の抜粋。${String(MAX_EVIDENCE_LENGTH)}文字以内）`,
      },
      escalation: {
        type: 'array',
        items: { type: 'string', enum: [...ROADMAP_QUESTION_ESCALATIONS] },
        description:
          '当てはまるものを全て選ぶ。1つでもあれば人の判断へ回る: ' +
          ROADMAP_QUESTION_ESCALATIONS.map((e) => `${e}=${ESCALATION_DESCRIPTIONS[e]}`).join('、'),
      },
    },
    required: ['question', 'reason', 'blocking'],
    additionalProperties: false,
  },
};

/** 検証済みの`ask_orchestrator`の引数。 */
export interface RoadmapAskArgs {
  question: string;
  reason: string;
  options: readonly string[];
  recommended: string | undefined;
  blocking: boolean;
  evidence: string | undefined;
  escalation: readonly RoadmapQuestionEscalation[];
}

// 改行とタブは残し、それ以外の制御文字を落とす。表示はwebviewの`textContent`、
// プロンプトへは`formatUntrusted`で囲んで入れる
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;

function readText(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (value === undefined && !required) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, message: `${field}は文字列で指定する` };
  }
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  if (required && cleaned === '') {
    return { ok: false, message: `${field}が空` };
  }
  if ([...cleaned].length > maxLength) {
    return { ok: false, message: `${field}は${String(maxLength)}文字以内にする` };
  }
  return { ok: true, value: cleaned === '' ? undefined : cleaned };
}

/** `tools/call`の引数を検証する。長さ・件数の超過は切り詰めずに拒否し、書き直させる。 */
export function parseRoadmapAskArgs(
  raw: unknown,
): { ok: true; args: RoadmapAskArgs } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '引数はオブジェクトで指定する' };
  }
  const a = raw as Record<string, unknown>;
  const question = readText(a.question, 'question', MAX_QUESTION_LENGTH, true);
  if (!question.ok) return question;
  const reason = readText(a.reason, 'reason', MAX_REASON_LENGTH, true);
  if (!reason.ok) return reason;
  const evidence = readText(a.evidence, 'evidence', MAX_EVIDENCE_LENGTH, false);
  if (!evidence.ok) return evidence;
  if (typeof a.blocking !== 'boolean') {
    return { ok: false, message: 'blockingはtrueかfalseで指定する' };
  }

  const rawOptions = a.options ?? [];
  if (!Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS) {
    return { ok: false, message: `optionsは${String(MAX_OPTIONS)}個以内の文字列の配列にする` };
  }
  const options: string[] = [];
  for (const option of rawOptions) {
    if (typeof option !== 'string') {
      return { ok: false, message: 'optionsの要素は文字列にする' };
    }
    const label = sanitizeInlineText(option, Number.MAX_SAFE_INTEGER).trim();
    if (label === '' || [...label].length > MAX_OPTION_LENGTH) {
      return {
        ok: false,
        message: `optionsの要素は空でない${String(MAX_OPTION_LENGTH)}文字以内にする`,
      };
    }
    if (options.includes(label)) {
      return { ok: false, message: `optionsが重複している: ${label}` };
    }
    options.push(label);
  }

  let recommended: string | undefined;
  if (a.recommended !== undefined) {
    const label =
      typeof a.recommended === 'string'
        ? sanitizeInlineText(a.recommended, Number.MAX_SAFE_INTEGER).trim()
        : undefined;
    if (label === undefined || !options.includes(label)) {
      return { ok: false, message: 'recommendedはoptionsのどれかと同じ文字列にする' };
    }
    recommended = label;
  }

  const rawEscalation = a.escalation ?? [];
  if (!Array.isArray(rawEscalation)) {
    return { ok: false, message: 'escalationは配列で指定する' };
  }
  const escalation: RoadmapQuestionEscalation[] = [];
  for (const e of rawEscalation) {
    if (!(ROADMAP_QUESTION_ESCALATIONS as readonly unknown[]).includes(e)) {
      return {
        ok: false,
        message: `escalationは次から選ぶ: ${ROADMAP_QUESTION_ESCALATIONS.join(', ')}`,
      };
    }
    const value = e as RoadmapQuestionEscalation;
    if (!escalation.includes(value)) {
      escalation.push(value);
    }
  }

  return {
    ok: true,
    args: {
      question: question.value ?? '',
      reason: reason.value ?? '',
      options,
      recommended,
      blocking: a.blocking,
      evidence: evidence.value,
      escalation,
    },
  };
}

/** Reflexを通さずに人の判断へ回す質問か（escalationが付いている、または選択肢が無い）。 */
export function needsUserDecision(args: Pick<RoadmapAskArgs, 'options' | 'escalation'>): boolean {
  return args.escalation.length > 0 || args.options.length === 0;
}

/** Kanbanからユーザーが送る回答の上限。 */
export const MAX_USER_ANSWER_LENGTH = 2000;

/** Kanbanから届いたユーザーの回答を検証する。空・長すぎ・文字列以外は`undefined`。 */
export function parseUserAnswer(raw: unknown): string | undefined {
  const parsed = readText(raw, 'answer', MAX_USER_ANSWER_LENGTH, true);
  return parsed.ok ? parsed.value : undefined;
}

export type RoadmapQuestionVerdict =
  | { kind: 'answer'; answer: string; summary: string }
  | { kind: 'human'; summary: string | undefined };

/**
 * 選択肢のある質問をReflexで判定する。最上位の選択肢が閾値以上ならその選択肢で答え、
 * それ以外（確信度不足・「どれでもない」・判定の失敗）は人の判断へ回す。
 */
export async function judgeRoadmapQuestion(
  deps: ReflexJudgeDeps,
  question: Pick<RoadmapAskArgs, 'question' | 'reason' | 'options' | 'recommended' | 'evidence'>,
  threshold: number,
): Promise<RoadmapQuestionVerdict> {
  const item: AskUserQuestionItem = {
    question: question.question,
    header: '',
    options: question.options.map((label) => ({
      label,
      description: label === question.recommended ? '質問したエージェントの推奨' : '',
    })),
    multiSelect: false,
  };
  const context = [
    `判断が必要になった理由: ${question.reason}`,
    ...(question.evidence === undefined ? [] : [`判断の材料: ${question.evidence}`]),
  ].join('\n');
  const verdict = await judgeAutoReplyAskUserQuestion(deps, [item], context, threshold);
  if (verdict.kind === 'answer') {
    const label = verdict.selections[question.question]?.[0];
    return label !== undefined && question.options.includes(label)
      ? { kind: 'answer', answer: label, summary: verdict.summary }
      : { kind: 'human', summary: verdict.summary };
  }
  return verdict.kind === 'human'
    ? { kind: 'human', summary: verdict.summary }
    : { kind: 'human', summary: 'Reflexで判定できなかった' };
}

/** 質問を受け付けた結果。`text`はツールの応答としてIssueセッションへ返す。 */
export interface RoadmapAskOutcome {
  text: string;
  isError: boolean;
}

/** 1つのIssueセッションからの質問を受け取る口。 */
export type RoadmapAskHandler = (args: RoadmapAskArgs) => Promise<RoadmapAskOutcome>;

const SERVER_INFO_RESULT = {
  protocolVersion: '2024-11-05',
  serverInfo: { name: 'vscode-codex-extension-roadmap', version: '1' },
  capabilities: { tools: {} },
};

export interface RoadmapQuestionMcpDeps {
  /** テストから差し替える口。既定は`startHttpMcpServer`。 */
  startServer?: (
    resolve: (token: string) => McpHttpTarget | undefined,
  ) => Promise<HttpMcpServerHandle>;
  logWarn?: (message: string) => void;
}

interface Registration {
  connectionId: string;
  handler: RoadmapAskHandler;
}

export class RoadmapQuestionMcpServer {
  private readonly registrations = new Map<string, Registration>();
  private server: Promise<HttpMcpServerHandle> | undefined;
  private disposed = false;

  constructor(private readonly deps: RoadmapQuestionMcpDeps = {}) {}

  /**
   * Issueセッション1つ分の接続先を登録し、CLIへ渡すURLを返す。トークンは推測できない
   * 128bitで、`unregister`した後のURLは404になる。
   */
  async register(
    connectionId: string,
    handler: RoadmapAskHandler,
  ): Promise<{ url: string; token: string }> {
    if (this.disposed) {
      throw new Error('ロードマップの質問用MCPサーバは終了済み');
    }
    this.server ??= (this.deps.startServer ?? startHttpMcpServer)((token) => this.resolve(token));
    let handle: HttpMcpServerHandle;
    try {
      handle = await this.server;
    } catch (e) {
      // 次の登録で立て直せるようにする
      this.server = undefined;
      throw e;
    }
    const token = randomBytes(16).toString('hex');
    this.registrations.set(token, { connectionId, handler });
    return { url: handle.urlForToken(token), token };
  }

  unregister(token: string): void {
    this.registrations.delete(token);
  }

  dispose(): void {
    this.disposed = true;
    this.registrations.clear();
    const server = this.server;
    this.server = undefined;
    void server
      ?.then((h) => h.close())
      .catch((e: unknown) => {
        this.deps.logWarn?.(
          `質問用MCPサーバを閉じられなかった: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  private resolve(token: string): McpHttpTarget | undefined {
    const registration = this.registrations.get(token);
    if (registration === undefined) {
      return undefined;
    }
    return {
      connectionId: registration.connectionId,
      handle: (connection) => this.handleConnection(registration, connection),
    };
  }

  private handleConnection(registration: Registration, connection: McpConnection): void {
    connection.onRequest((request) => {
      void this.dispatch(registration, request)
        .catch((e: unknown) => {
          this.deps.logWarn?.(
            `[roadmap question] ${registration.connectionId}の要求の処理で例外: ${e instanceof Error ? e.message : String(e)}`,
          );
          return failure(request.id, -32603, '内部エラー');
        })
        .then((response) => connection.send(response));
    });
  }

  private async dispatch(
    registration: Registration,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'initialize':
        return success(request.id, SERVER_INFO_RESULT);
      case 'tools/list':
        return success(request.id, { tools: [ROADMAP_ASK_ORCHESTRATOR_TOOL] });
      case 'tools/call':
        return this.handleToolCall(registration, request);
      default:
        return failure(request.id, -32601, `未知のメソッドです: ${request.method}`);
    }
  }

  private async handleToolCall(
    registration: Registration,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const params =
      typeof request.params === 'object' && request.params !== null
        ? (request.params as Record<string, unknown>)
        : {};
    if (params.name !== ROADMAP_ASK_ORCHESTRATOR_TOOL.name) {
      return failure(request.id, -32602, `未知のツールです: ${String(params.name)}`);
    }
    const parsed = parseRoadmapAskArgs(params.arguments);
    if (!parsed.ok) {
      return success(request.id, toolTextResult(parsed.message, true));
    }
    const outcome = await registration.handler(parsed.args);
    return success(request.id, toolTextResult(outcome.text, outcome.isError));
  }
}
