import type { PendingApproval } from '../appserver/chatState';

/**
 * `AskUserQuestion`（Claude Codeの組み込みツール。issue #685）の扱い。
 *
 * 公式ドキュメント（Handle approvals and user input）の通り、このツールは`tool_use`として
 * 現れるが、CLIは`can_use_tool`のcontrol_request/control_response経路（＝この拡張の
 * 既存の承認フローそのもの）で処理する。`tool_result`は使わない。応答は
 * `{behavior:'allow', updatedInput:{questions, answers}}`で、`answers`は「質問文→選んだ
 * ラベル」のマップ（複数選択の質問は配列、単一選択は文字列）。
 *
 * `sideQuestion.ts`と同じくvscode非依存の純粋関数のみを置く。
 */

export interface AskUserQuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/** CLIへ返す `updatedInput.answers` の形。keyは質問文そのもの。 */
export type AskUserQuestionAnswers = Record<string, string | string[]>;

/** webviewから届く選択結果。keyは質問文、値は選ばれたラベルの配列（単一選択でも1要素）。 */
export type AskUserQuestionSelections = Record<string, string[]>;

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

function readOptions(raw: unknown): AskUserQuestionOption[] | undefined {
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
    return undefined;
  }
  const options: AskUserQuestionOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const label = record['label'];
    if (typeof label !== 'string' || label === '') {
      return undefined;
    }
    const description = record['description'];
    options.push({ label, description: typeof description === 'string' ? description : '' });
  }
  return options;
}

/**
 * `can_use_tool`要求の`input.questions`を読む。1〜4問・各2〜4選択肢という仕様外の形は
 * `undefined`を返し、呼び出し側で拒否側（`defaultDenyControlResponse`）へ倒させる
 * （内容を読み取れない要求を許可すると、目に触れないまま実行されるため）。
 */
export function readAskUserQuestions(raw: unknown): AskUserQuestionItem[] | undefined {
  if (!Array.isArray(raw) || raw.length < MIN_QUESTIONS || raw.length > MAX_QUESTIONS) {
    return undefined;
  }
  const items: AskUserQuestionItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const question = record['question'];
    if (typeof question !== 'string' || question === '') {
      return undefined;
    }
    const options = readOptions(record['options']);
    if (options === undefined) {
      return undefined;
    }
    const header = record['header'];
    items.push({
      question,
      header: typeof header === 'string' ? header : '',
      options,
      multiSelect: record['multiSelect'] === true,
    });
  }
  return items;
}

/**
 * 質問一覧の短い要約（「先頭の見出し ・他N問」）。承認カードの`detail`と会話ログの
 * 一覧行（`transcript.ts`の`summarizeAskUserQuestion`）が同じ文言になるよう共有する。
 */
export function summarizeAskUserQuestions(questions: AskUserQuestionItem[]): string | undefined {
  const first = questions[0];
  if (first === undefined) {
    return undefined;
  }
  const firstLabel = first.header !== '' ? first.header : first.question;
  return questions.length === 1 ? firstLabel : `${firstLabel} ・他${questions.length - 1}問`;
}

/** `can_use_tool`要求を承認カード（選択UI）にする。 */
export function describeAskUserQuestion(
  requestId: string,
  input: Record<string, unknown>,
): PendingApproval | undefined {
  const questions = readAskUserQuestions(input['questions']);
  const detail = questions === undefined ? undefined : summarizeAskUserQuestions(questions);
  if (questions === undefined || detail === undefined) {
    return undefined;
  }
  return {
    requestId,
    kind: 'askUserQuestion',
    title: '質問への回答を選んでください',
    detail,
    itemId: undefined,
    questions,
  };
}

/**
 * 選択結果からCLIへ返す`allow`応答を組む。
 *
 * `multiSelect`の展開・非展開（配列のまま渡すか単一の文字列にするか）は元の`questions`
 * （`originalInput.questions`、`waiting.input`にそのまま持ち回っている値）を見て
 * ここで一元的に決める。webview側は常に配列で送ってくるため、呼び出し側に分岐を
 * 持たせない。
 */
export function buildAskUserQuestionResponse(
  originalInput: Record<string, unknown>,
  selections: AskUserQuestionSelections,
): Record<string, unknown> {
  const questions = readAskUserQuestions(originalInput['questions']) ?? [];
  const multiSelectByQuestion = new Map(questions.map((q) => [q.question, q.multiSelect]));
  const answers: AskUserQuestionAnswers = {};
  for (const [question, values] of Object.entries(selections)) {
    answers[question] = multiSelectByQuestion.get(question) === true ? values : (values[0] ?? '');
  }
  return {
    behavior: 'allow',
    updatedInput: { questions: originalInput['questions'], answers },
  };
}

/** 拒否応答。他の承認種別（`buildCanUseToolResponse`）と同じ文言に揃える。 */
export function buildAskUserQuestionDenyResponse(): Record<string, unknown> {
  return { behavior: 'deny', message: 'ユーザーが拒否しました' };
}

/**
 * webviewから届いた`answerAskUserQuestion`メッセージの`answers`が期待する形
 * （質問文→選ばれたラベルの配列、各質問は1つ以上選択済み）かを確認する。
 * `isApprovalDecision`と同じく、拡張機能側で受け取ったものは信用せずホワイトリスト的に
 * 検証する。空配列（未回答）を許すと、webview側の未回答チェックを経由しない経路
 * （不整合なpostMessage）で選ばれていない質問が空文字の回答としてそのままCLIへ
 * `allow`で送られてしまう。
 */
export function isAskUserQuestionSelections(value: unknown): value is AskUserQuestionSelections {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.values(value);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(
    (v) => Array.isArray(v) && v.length > 0 && v.every((label) => typeof label === 'string'),
  );
}
