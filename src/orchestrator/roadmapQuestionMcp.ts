import { randomBytes } from 'node:crypto';

import { judgeAutoReplyAskUserQuestion } from '../chat/autoReplyReflex';
import type { AskUserQuestionItem } from '../claude/askUserQuestion';
import type { ReflexJudgeDeps } from '../reflex/reflexJudge';
import { findIrreversibleCommands } from './escalation';
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
import { ROADMAP_QUESTION_ESCALATIONS, type RoadmapQuestionEscalation } from './roadmapShared';
import { sanitizeInlineText } from './untrustedText';

/**
 * `ask_orchestrator`を仲介するMCPサーバ。元はロードマップ実行（Issue #1465）が導入し、
 * 廃止（Issue #1623）後はオーケストレータモード（Issue #1505）のtaskStage報告・質問の
 * 受け口として`taskStageReportMcp.ts`が使う。
 *
 * ワークフロー実行用の`MessagingMcpServer`（`messaging.ts`）とは別に、トークンごとに見せる
 * ツールの組を分ける。`register`は単体の`ask_orchestrator`ツールだけを見せる登録、
 * `registerTools`は呼び出し側が渡した任意のツール一覧を見せる登録で、taskStageセッション・
 * taskRunオーケストレータのどちらもこちらを使う。HTTP層は`startHttpMcpServer`を使い、
 * 接続元とツールの組はURLのトークンからだけ決める（ツールの引数からは決めない）。
 * サーバはウィンドウごとに1つで、最初の登録のときに立てる。
 *
 * ここはJSON-RPCの受け答えと、登録先への振り分けだけを行う。質問の振り分けと回答の届け方、
 * 操作ツールの処理は呼び出し側（taskStage・taskRunオーケストレータ）が持つ。
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
    'escalationに当たる質問は自動では選ばれず、Orchestratorか人の判断を待つ。',
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
          '当てはまるものを全て選ぶ。1つでもあればOrchestratorか人の判断を待つ: ' +
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

/**
 * 質問の自然文に現れる、取り消せない操作・影響の大きい対象の語。コマンドの形で書かれたものは
 * `findIrreversibleCommands`が拾う。誤検知で人へ回る質問が増えるため、語は取り消せない操作と
 * 外部へ影響が及ぶ対象に限る（Issue #1712）。
 *
 * `userOnly`の語（secretsと破壊的操作）を含む質問は、回答者判定を通さずユーザーが決める。
 * それ以外（本番環境・課金・デプロイ・公開）は回答者判定の材料にする。外部由来のテキストによる
 * プロンプトインジェクションでReflexが誤判定しても、最も取り返しのつかない操作だけは人の目を
 * 通るようにするため（Issue #1771）。
 */
const QUESTION_DANGER_PATTERNS: readonly { description: string; pattern: RegExp; userOnly: boolean }[] = [
  {
    // `findIrreversibleCommands`と同じ説明にして、両方に当たっても1件にまとめる
    description: 'リモートへの強制push',
    pattern: /force[\s_-]*push|強制\s*(push|プッシュ)|push\s+(-\w*f\w*\b|--force|--mirror)|push\s+\S+\s+\+\S/u,
    userOnly: true,
  },
  {
    description: '履歴の書き換え',
    pattern:
      /履歴.{0,4}(書き換|書換|改変|改竄|改ざん)|rewrit\w*\s+(the\s+)?(git\s+)?history|history\s+rewrit|filter-(branch|repo)/u,
    userOnly: true,
  },
  {
    description: 'ブランチ・タグの削除',
    pattern: /(ブランチ|タグ|branch|tag)を?\s*(削除|消す|消し|消去)|delet\w*\s+(the\s+)?(remote\s+)?(branch|tag)/u,
    userOnly: true,
  },
  {
    description: 'データの削除',
    pattern: /drop\s+(table|database)|\btruncate\b|(テーブル|データベース|db|レコード|全件)を?\s*(削除|消去|消す)/u,
    userOnly: true,
  },
  {
    description: '作業ツリー・ファイルの破棄',
    pattern:
      /git\s+reset|checkout\s+(--\s+)?\.(\s|$)|stash\s+(drop|clear)|rm\s+-\w*[rf]|worktree\s+remove|(ファイル|リポジトリ|ディレクトリ|作業ツリー)を?\s*(削除|消去|消す|破棄)|変更を?\s*(破棄|巻き戻)/u,
    userOnly: true,
  },
  {
    description: 'secrets',
    pattern:
      /secret|シークレット|秘密鍵|private[\s_-]*key|api[\s_-]*key|apiキー|アクセストークン|access[\s_-]*token|認証情報|credential|パスワード|password|トークン|\btoken\b|ssh[\s_-]*key|パスフレーズ|passphrase/u,
    userOnly: true,
  },
  { description: '本番環境', pattern: /本番|\bprod(uction)?\b/u, userOnly: false },
  { description: '課金', pattern: /課金|請求|billing|決済|支払|payment/u, userOnly: false },
  { description: 'デプロイ・公開', pattern: /デプロイ|deploy|\bpublish\b|パッケージ.{0,4}公開/u, userOnly: false },
];

/** 質問に含まれる危険語の説明。`userOnly`はユーザーが決めるもの、`caution`は回答者判定の材料にするもの。 */
export interface QuestionDangers {
  userOnly: string[];
  caution: string[];
}

/**
 * 質問文・理由・選択肢・材料に含まれる危険語の説明（それぞれ重複なし）。質問したエージェントが
 * `escalation`を付け忘れた・外された場合でも、secretsと破壊的操作をReflexに決めさせないため。
 */
export function findQuestionDangers(
  args: Pick<RoadmapAskArgs, 'question' | 'reason' | 'options' | 'evidence'>,
): QuestionDangers {
  const text = [args.question, args.reason, ...args.options, args.evidence ?? ''].join('\n');
  const normalized = text.normalize('NFKC').toLowerCase();
  const matched = QUESTION_DANGER_PATTERNS.filter((p) => p.pattern.test(normalized));
  const commands = findIrreversibleCommands(normalized);
  return {
    userOnly: [
      ...new Set([...matched.filter((p) => p.userOnly).map((p) => p.description), ...commands.destructive]),
    ],
    caution: [
      ...new Set([...matched.filter((p) => !p.userOnly).map((p) => p.description), ...commands.caution]),
    ],
  };
}

/** 回答者判定の材料にする危険語の1行。無ければ`undefined`。 */
export function describeCautionDangers(dangers: QuestionDangers): string | undefined {
  return dangers.caution.length === 0
    ? undefined
    : `影響の大きい対象に関わる語を含む: ${dangers.caution.join('、')}`;
}

/**
 * 回答者判定を通さずユーザーが決めるescalation。secretsと破壊的操作に限る。それ以外の
 * escalation（リリース・要件変更など）は回答者判定の材料にする（Issue #1763・#1771）。
 */
const USER_ONLY_ESCALATIONS: ReadonlySet<RoadmapQuestionEscalation> = new Set<RoadmapQuestionEscalation>([
  'destructiveOperation',
  'secrets',
]);

/** 付いたescalationのうち、回答者判定を通さずユーザーが決めるもの。 */
export function findUserOnlyEscalations(
  escalation: readonly RoadmapQuestionEscalation[],
): RoadmapQuestionEscalation[] {
  return escalation.filter((e) => USER_ONLY_ESCALATIONS.has(e));
}

/** escalationを回答者判定の材料にする1行。付いていなければ`undefined`。 */
export function describeEscalations(
  escalation: readonly RoadmapQuestionEscalation[],
): string | undefined {
  return escalation.length === 0
    ? undefined
    : `質問したエージェントが付けたescalation: ${escalation.map((e) => ESCALATION_DESCRIPTIONS[e]).join('、')}`;
}

/**
 * Reflexに選択肢を選ばせない質問か（escalationが付いている、選択肢が無い、または
 * 危険語を含む）。選ばせない質問も、ユーザーが決めるもの以外は回答者判定にかかる。
 */
export function needsUserDecision(
  args: Pick<RoadmapAskArgs, 'question' | 'reason' | 'options' | 'evidence' | 'escalation'>,
): boolean {
  const dangers = findQuestionDangers(args);
  return (
    args.escalation.length > 0 ||
    args.options.length === 0 ||
    dangers.userOnly.length > 0 ||
    dangers.caution.length > 0
  );
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
 *
 * `recommended`はコード側で決めた推奨（関門の問い）に限る。工程セッションのエージェントが
 * 付けた推奨を渡すと、質問した側から判定を誘導できる（Issue #1712）。
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
      description: label === question.recommended ? 'Orchestratorの推奨' : '',
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

/**
 * 1つのトークンに結び付けた接続先。見せるツールの組はトークンを登録するときに決める
 * （Issueセッションは`ask_orchestrator`だけ、Orchestratorセッションは呼び出し側が渡した
 * 操作ツールだけ）。
 */
interface Registration {
  connectionId: string;
  tools: readonly McpToolDefinition[];
  /** ツール名は`tools`のどれかであることを確かめてから呼ぶ。 */
  call: (name: string, rawArgs: unknown) => Promise<RoadmapAskOutcome>;
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
  register(connectionId: string, handler: RoadmapAskHandler): Promise<{ url: string; token: string }> {
    return this.add({
      connectionId,
      tools: [ROADMAP_ASK_ORCHESTRATOR_TOOL],
      call: async (_name, rawArgs) => {
        const parsed = parseRoadmapAskArgs(rawArgs);
        return parsed.ok ? handler(parsed.args) : { text: parsed.message, isError: true };
      },
    });
  }

  /**
   * Orchestratorセッション1つ分（1世代）の接続先を登録する（Issue #1465 分割案8b）。
   * 見せるのは`tools`だけで、`ask_orchestrator`は見せない。
   */
  registerTools(
    connectionId: string,
    tools: readonly McpToolDefinition[],
    call: (name: string, rawArgs: unknown) => Promise<RoadmapAskOutcome>,
  ): Promise<{ url: string; token: string }> {
    return this.add({ connectionId, tools, call });
  }

  private async add(registration: Registration): Promise<{ url: string; token: string }> {
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
    this.registrations.set(token, registration);
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
        return success(request.id, { tools: registration.tools });
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
    const name = params.name;
    if (typeof name !== 'string' || !registration.tools.some((t) => t.name === name)) {
      return failure(request.id, -32602, `未知のツールです: ${String(name)}`);
    }
    const outcome = await registration.call(name, params.arguments);
    return success(request.id, toolTextResult(outcome.text, outcome.isError));
  }
}
