import type { ChatState } from '../appserver/chatState';
import type { PendingPrompt, PromptSubmission } from '../appserver/prompts';
import type { AskUserQuestionItem, AskUserQuestionSelections } from '../claude/askUserQuestion';

/**
 * 人の回答を待っている項目を、種類にかかわらず1つの形にそろえたもの（Issue #2135、
 * Mission Controlの段階1）。
 *
 * 承認要求・AskUserQuestion・Codexの`requestUserInput`/elicitation・task runの質問・
 * 引き継ぎ確認は、それぞれ別の状態に置かれ、別の画面からしか答えられなかった。
 * session-hubの共有ファイル（`SharedSession.pending`・`SharedSessionFile.pending`）へ
 * この形で載せ、どのウィンドウからでも一覧でき、所有ウィンドウへ回答を届けられるようにする。
 *
 * 共有ファイルは会話本文を常駐させない方針（`sessionHub.ts`）のため、`payload`は一覧に要る
 * 要約だけにする。選択肢やフォームの全文は、既存の`approvalDetail`と同じく要求時に取る。
 */
export type PendingItemKind =
  | 'toolApproval'
  | 'askUserQuestion'
  | 'codexPrompt'
  | 'workflowApproval'
  | 'taskRunQuestion'
  | 'handoff';

/** 回答の形。`decision`は承認・拒否、`choices`は選択肢、`text`は自由入力（フォームを含む）。 */
export type PendingAnswerMode = 'decision' | 'choices' | 'text';

export interface PendingItemSession {
  windowId: string;
  /**
   * 会話のid。task runの質問は会話に属さないため、runIdを入れる（宛先の解決にだけ使う）。
   */
  threadId: string;
  provider: 'codex' | 'claude';
}

/** 一覧に要る要約だけを持つ。全文は要求時に取る。 */
export interface PendingItemPayload {
  /** 1行の要約（質問文の書き出し、コマンドなど）。 */
  summary: string;
  /** 会話の項目なら、元の要求id（`PendingApproval.requestId` / `PendingPrompt.requestId`）。 */
  requestId?: string | undefined;
  /** task runの質問のときの宛先。 */
  runId?: string | undefined;
  taskId?: string | undefined;
  questionId?: string | undefined;
  /** task runの質問の選択肢（短い文字列だけ）。 */
  options?: string[] | undefined;
}

export interface PendingItem {
  /** 回答の冪等性の鍵。同じ項目には常に同じidが付く。 */
  id: string;
  kind: PendingItemKind;
  session: PendingItemSession;
  cwd: string | undefined;
  title: string;
  /** 所有ウィンドウが最初に見た時刻（ms）。状態に発生時刻が無いものは見た時刻で代える。 */
  createdAt: number;
  payload: PendingItemPayload;
  answer: PendingAnswerMode;
}

const PENDING_KINDS: readonly PendingItemKind[] = [
  'toolApproval',
  'askUserQuestion',
  'codexPrompt',
  'workflowApproval',
  'taskRunQuestion',
  'handoff',
];
const ANSWER_MODES: readonly PendingAnswerMode[] = ['decision', 'choices', 'text'];

/** 共有ファイルへ載せる上限。他ウィンドウの書いた値を読むときも同じ上限で切る。 */
export const MAX_PENDING_ITEMS = 50;
const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 500;
const MAX_ID_CHARS = 400;
const MAX_OPTIONS = 20;
const MAX_OPTION_CHARS = 200;

/** 二重回答への応答。所有側で回答済み・失効済みのときに返す（受入基準の文言）。 */
export const ALREADY_ANSWERED_MESSAGE = 'この項目は既に回答済みです';

/** 改行・連続空白を畳み、上限で切る。共有ファイルは他プロセスが読むため1行に寄せる。 */
function oneLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/** 会話の項目のid。`provider`と会話idまで含め、ウィンドウをまたいでも衝突させない。 */
export function chatPendingId(
  provider: 'codex' | 'claude',
  threadId: string,
  kind: PendingItemKind,
  requestId: number | string,
): string {
  return `${provider}:${threadId}:${kind}:${String(requestId)}`;
}

/** task runの質問のid。 */
export function taskRunPendingId(runId: string, taskId: string, questionId: string): string {
  return `taskRun:${runId}:${taskId}:${questionId}`;
}

/**
 * 項目を最初に見た時刻を覚える。状態側に時刻が無いため、所有ウィンドウが見つけた時刻を
 * `createdAt`にする。一覧から消えた項目は忘れる（覚え続けない）。
 */
export class PendingFirstSeen {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `ids`に無いものを忘れ、`id`の時刻を返す。呼び出し側は一覧1回分ごとに`retain`を呼ぶ。 */
  stamp(id: string): number {
    const at = this.seen.get(id);
    if (at !== undefined) {
      return at;
    }
    const now = this.now();
    this.seen.set(id, now);
    return now;
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of [...this.seen.keys()]) {
      if (!ids.has(id)) {
        this.seen.delete(id);
      }
    }
  }
}

export interface ChatPendingContext {
  windowId: string;
  threadId: string;
  provider: 'codex' | 'claude';
  cwd: string | undefined;
  /** 引き継ぎ確認が保留になっているか（`ChatState`には現れない）。 */
  handoffPending: boolean;
}

/** 会話1件の待ち状態を`PendingItem`へそろえる。 */
export function buildChatPendingItems(
  state: Pick<ChatState, 'approvals' | 'prompts'>,
  context: ChatPendingContext,
  firstSeen: PendingFirstSeen,
): PendingItem[] {
  const session: PendingItemSession = {
    windowId: context.windowId,
    threadId: context.threadId,
    provider: context.provider,
  };
  const items: PendingItem[] = [];
  for (const approval of state.approvals) {
    const kind: PendingItemKind =
      approval.kind === 'askUserQuestion' ? 'askUserQuestion' : 'toolApproval';
    const id = chatPendingId(context.provider, context.threadId, kind, approval.requestId);
    const firstQuestion = approval.questions?.[0]?.question;
    items.push({
      id,
      kind,
      session,
      cwd: context.cwd,
      title: oneLine(approval.title, MAX_TITLE_CHARS),
      createdAt: firstSeen.stamp(id),
      payload: {
        summary: oneLine(firstQuestion ?? approval.detail, MAX_SUMMARY_CHARS),
        requestId: String(approval.requestId),
      },
      answer: kind === 'askUserQuestion' ? 'choices' : 'decision',
    });
  }
  for (const prompt of state.prompts) {
    const id = chatPendingId(context.provider, context.threadId, 'codexPrompt', prompt.requestId);
    items.push({
      id,
      kind: 'codexPrompt',
      session,
      cwd: context.cwd,
      title: oneLine(prompt.title, MAX_TITLE_CHARS),
      createdAt: firstSeen.stamp(id),
      payload: {
        summary: oneLine(describePromptSummary(prompt), MAX_SUMMARY_CHARS),
        requestId: String(prompt.requestId),
      },
      answer: prompt.fields.every((f) => f.options.length > 0 && !f.allowOther)
        ? 'choices'
        : 'text',
    });
  }
  if (context.handoffPending) {
    const id = chatPendingId(context.provider, context.threadId, 'handoff', 'pending');
    items.push({
      id,
      kind: 'handoff',
      session,
      cwd: context.cwd,
      title: '引き継ぎ先の確認',
      createdAt: firstSeen.stamp(id),
      payload: { summary: '' },
      answer: 'decision',
    });
  }
  return items;
}

function describePromptSummary(prompt: PendingPrompt): string {
  if (prompt.message !== '') {
    return prompt.message;
  }
  const first = prompt.fields[0];
  return first === undefined ? '' : first.description || first.label;
}

export interface TaskRunPendingQuestion {
  runId: string;
  engine: 'codex' | 'claude';
  workspaceRoot: string | undefined;
  taskId: string;
  taskTitle: string;
  questionId: string;
  question: string;
  options: readonly string[];
  askedAt: string;
}

/** task runの質問（ユーザーの判断待ち）を`PendingItem`へそろえる。 */
export function buildTaskRunPendingItem(windowId: string, q: TaskRunPendingQuestion): PendingItem {
  const askedAt = Date.parse(q.askedAt);
  return {
    id: taskRunPendingId(q.runId, q.taskId, q.questionId),
    kind: 'taskRunQuestion',
    session: { windowId, threadId: q.runId, provider: q.engine },
    cwd: q.workspaceRoot,
    title: oneLine(`${q.taskId} ${q.taskTitle}`, MAX_TITLE_CHARS),
    createdAt: Number.isFinite(askedAt) ? askedAt : 0,
    payload: {
      summary: oneLine(q.question, MAX_SUMMARY_CHARS),
      runId: q.runId,
      taskId: q.taskId,
      questionId: q.questionId,
      options: q.options.slice(0, MAX_OPTIONS).map((o) => oneLine(o, MAX_OPTION_CHARS)),
    },
    answer: 'text',
  };
}

function readOptionalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function parsePayload(value: unknown): PendingItemPayload | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== 'string') {
    return undefined;
  }
  return {
    summary: oneLine(v.summary, MAX_SUMMARY_CHARS),
    requestId: readOptionalString(v.requestId, MAX_ID_CHARS),
    runId: readOptionalString(v.runId, MAX_ID_CHARS),
    taskId: readOptionalString(v.taskId, MAX_ID_CHARS),
    questionId: readOptionalString(v.questionId, MAX_ID_CHARS),
    options: Array.isArray(v.options)
      ? v.options
          .filter((o): o is string => typeof o === 'string')
          .slice(0, MAX_OPTIONS)
          .map((o) => oneLine(o, MAX_OPTION_CHARS))
      : undefined,
  };
}

/**
 * 他ウィンドウが書いた`pending`を、信用せずに読み解く（`parseSharedSessionFile`と同じ方針）。
 *
 * 形の合わない要素だけを落とす。知らない`kind` / `answer`は版の違うウィンドウが書いたもので、
 * 画面がその種類の描き方を知らないため落とす。
 */
export function parsePendingItems(value: unknown): PendingItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: PendingItem[] = [];
  for (const entry of value) {
    if (items.length >= MAX_PENDING_ITEMS) {
      break;
    }
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const v = entry as Record<string, unknown>;
    const session = v.session as Record<string, unknown> | null | undefined;
    const payload = parsePayload(v.payload);
    if (
      typeof v.id !== 'string' ||
      v.id.length > MAX_ID_CHARS ||
      !PENDING_KINDS.includes(v.kind as PendingItemKind) ||
      !ANSWER_MODES.includes(v.answer as PendingAnswerMode) ||
      typeof session !== 'object' ||
      session === null ||
      typeof session.windowId !== 'string' ||
      typeof session.threadId !== 'string' ||
      (session.provider !== 'codex' && session.provider !== 'claude') ||
      typeof v.title !== 'string' ||
      typeof v.createdAt !== 'number' ||
      (v.cwd !== undefined && typeof v.cwd !== 'string') ||
      payload === undefined
    ) {
      continue;
    }
    items.push({
      id: v.id,
      kind: v.kind as PendingItemKind,
      session: {
        windowId: session.windowId,
        threadId: session.threadId,
        provider: session.provider,
      },
      cwd: v.cwd as string | undefined,
      title: oneLine(v.title, MAX_TITLE_CHARS),
      createdAt: v.createdAt,
      payload,
      answer: v.answer as PendingAnswerMode,
    });
  }
  return items;
}

/**
 * 回答済みの項目id（Issue #2135の二重回答の防止）。
 *
 * 所有側の状態から項目が消えていれば回答済みと判るが、消えるまでの間に届いた2件目を
 * 確実に止めるため、回答を送った時点でidを覚える。上限を超えたら古いものから忘れる
 * （忘れた頃には状態側から項目が消えている）。
 */
export class AnsweredPendingIds {
  private readonly ids = new Set<string>();

  constructor(private readonly max = 500) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.add(id);
    while (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.ids.delete(oldest);
    }
  }
}

/** 共有ディレクトリを跨ぐ回答の上限。 */
const MAX_ANSWER_KEYS = 20;
const MAX_ANSWER_VALUES = 20;
const MAX_ANSWER_VALUE_CHARS = 2_000;

/**
 * AskUserQuestionの回答を、質問と突き合わせて確かめる。
 *
 * 質問文が無いキー・答えの無い質問を通すと、CLIへ空の答えが`allow`で送られる
 * （`isAskUserQuestionSelections`のJSDoc）。選択肢に無いラベルは「その他」の自由入力として
 * 通す（チャットタブの選択UIと同じ）。
 */
export function validateAskUserQuestionAnswers(
  questions: readonly AskUserQuestionItem[],
  answers: unknown,
): AskUserQuestionSelections | string {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    return '回答の形が正しくありません';
  }
  const raw = answers as Record<string, unknown>;
  const result: Array<[string, string[]]> = [];
  for (const q of questions) {
    const value = Object.prototype.hasOwnProperty.call(raw, q.question)
      ? raw[q.question]
      : undefined;
    if (!Array.isArray(value)) {
      return `未回答の質問があります: ${oneLine(q.question, 60)}`;
    }
    const labels = value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v !== '');
    if (labels.length === 0) {
      return `未回答の質問があります: ${oneLine(q.question, 60)}`;
    }
    if (!q.multiSelect && labels.length > 1) {
      return `1つだけ選ぶ質問です: ${oneLine(q.question, 60)}`;
    }
    if (labels.some((l) => l.length > MAX_ANSWER_VALUE_CHARS)) {
      return '回答が長すぎます';
    }
    result.push([q.question, labels.slice(0, MAX_ANSWER_VALUES)]);
  }
  if (Object.keys(raw).some((key) => !questions.some((q) => q.question === key))) {
    return '質問に無い回答が含まれています';
  }
  return Object.fromEntries(result);
}

/** 共有ディレクトリ・webviewから届いたフォームの回答を、形だけ確かめて取り込む。 */
export function parsePromptSubmission(raw: unknown): PromptSubmission | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  if (v.action !== 'submit' && v.action !== 'decline' && v.action !== 'cancel') {
    return undefined;
  }
  const rawValues =
    typeof v.values === 'object' && v.values !== null ? (v.values as Record<string, unknown>) : {};
  const values: Array<[string, string[]]> = [];
  for (const [id, value] of Object.entries(rawValues).slice(0, MAX_ANSWER_KEYS)) {
    if (Array.isArray(value)) {
      values.push([
        id,
        value
          .filter((x): x is string => typeof x === 'string')
          .slice(0, MAX_ANSWER_VALUES)
          .map((x) => x.slice(0, MAX_ANSWER_VALUE_CHARS)),
      ]);
    }
  }
  // 項目名はMCPサーバが決める。`values[id] = ...`だと`__proto__`で回答が消える
  return { action: v.action, values: Object.fromEntries(values) };
}

/** AskUserQuestionの回答を、共有ディレクトリ・webviewから届いた形のまま取り込む。 */
export function parseAskUserQuestionAnswers(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const entries: Array<[string, string[]]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(
    0,
    MAX_ANSWER_KEYS,
  )) {
    if (Array.isArray(value)) {
      entries.push([
        key,
        value
          .filter((x): x is string => typeof x === 'string')
          .slice(0, MAX_ANSWER_VALUES)
          .map((x) => x.slice(0, MAX_ANSWER_VALUE_CHARS)),
      ]);
    }
  }
  return Object.fromEntries(entries);
}
