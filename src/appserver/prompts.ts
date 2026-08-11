/**
 * ユーザーへの問い合わせ。
 *
 * app-serverからは2種類の「聞いてくる」要求が来る。
 *
 * - `item/tool/requestUserInput`: ツールがユーザーへ質問する。応答は質問idごとの答え
 * - `mcpServer/elicitation/request`: MCPサーバがフォーム入力を求める。応答は action と中身
 *
 * どちらも「ラベルと説明が付いた入力欄の並び」に落とせるので、`PendingPrompt` へ
 * 正規化して描画を1つにまとめる。応答の形だけ要求ごとに戻す。
 *
 * **応答を返さない限りapp-serverは待ち続ける**。画面を閉じるときは必ず解決すること。
 */

import { SERVER_REQUEST_METHODS } from './approvals';

/** 選択肢1つ。 */
export interface PromptOption {
  value: string;
  label: string;
  description: string;
}

/** 入力欄の種類。未知のスキーマはテキストとして扱う（画面を壊さないため）。 */
export type PromptInput = 'text' | 'number' | 'boolean';

export interface PromptField {
  id: string;
  /** 見出し。 */
  label: string;
  /** 補足。質問文やスキーマの description。 */
  description: string;
  /** 選択肢。空なら自由入力。 */
  options: PromptOption[];
  /** 複数選べるか。 */
  multiple: boolean;
  /** 選択肢に加えて自由入力も許すか。 */
  allowOther: boolean;
  /** 伏せ字にするか。**ログにも出さない**。 */
  secret: boolean;
  input: PromptInput;
  required: boolean;
  /** 既定値。空なら未入力で始める。 */
  defaultValue: string;
}

export interface PendingPrompt {
  requestId: number | string;
  kind: 'userInput' | 'elicitation';
  title: string;
  /**
   * 要求の出どころ。elicitationはMCPサーバ名を入れる。
   * **外部のプログラムからの要求**なので、誰が聞いているかを必ず画面に出す。
   */
  source: string;
  /** 本文。 */
  message: string;
  /** ターンを止める要求か。 */
  blocking: boolean;
  fields: PromptField[];
  /**
   * `url` モードのelicitationで示された行き先。
   *
   * **自動では開かない**。MCPサーバが渡してくる外部URLなので、行き先を全部見せて
   * ユーザーに判断させる。
   */
  url: string | undefined;
}

/** 画面から返ってくる回答。 */
export interface PromptSubmission {
  action: 'submit' | 'decline' | 'cancel';
  /** フィールドidごとの値。選択肢は選んだ value、自由入力は入力そのもの。 */
  values: Record<string, string[]>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * 問い合わせを表示用に整える。扱えない要求は undefined を返す。
 */
export function describePrompt(
  requestId: number | string,
  method: string,
  params: Record<string, unknown>,
): PendingPrompt | undefined {
  if (method === SERVER_REQUEST_METHODS.requestUserInput) {
    return describeUserInput(requestId, params);
  }
  if (method === SERVER_REQUEST_METHODS.elicitation) {
    return describeElicitation(requestId, params);
  }
  return undefined;
}

function describeUserInput(
  requestId: number | string,
  params: Record<string, unknown>,
): PendingPrompt | undefined {
  const raw = params['questions'];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const fields: PromptField[] = [];
  for (const entry of raw) {
    const question = rec(entry);
    const id = str(question?.['id']);
    if (question === undefined || id === '') {
      continue;
    }
    const options = readOptions(question['options']);
    fields.push({
      id,
      label: str(question['header']) || id,
      description: str(question['question']),
      options,
      // 複数選択を求める指定がプロトコルに無いため1つだけ選ばせる
      multiple: false,
      // 選択肢が無ければそもそも自由入力。isOther は選択肢に足す形
      allowOther: options.length === 0 || question['isOther'] === true,
      secret: question['isSecret'] === true,
      input: 'text',
      required: false,
      defaultValue: '',
    });
  }
  if (fields.length === 0) {
    return undefined;
  }
  return {
    requestId,
    kind: 'userInput',
    title: '入力を求められています',
    source: '',
    message: '',
    blocking: params['isBlocking'] !== false,
    fields,
    url: undefined,
  };
}

function describeElicitation(
  requestId: number | string,
  params: Record<string, unknown>,
): PendingPrompt {
  const serverName = str(params['serverName']);
  const mode = str(params['mode']);
  const base = {
    requestId,
    kind: 'elicitation' as const,
    title: '入力を求められています',
    source: serverName === '' ? '不明なMCPサーバ' : serverName,
    message: str(params['message']),
    // elicitationはターン外でも届く。止めている前提にしない
    blocking: false,
  };

  if (mode === 'url') {
    // 行き先を見せるだけにする。押すだけで外部へ飛ぶ導線は作らない
    return { ...base, fields: [], url: str(params['url']) || undefined };
  }

  return { ...base, fields: readElicitationFields(params['requestedSchema']), url: undefined };
}

/**
 * `requestedSchema` から入力欄を組む。
 *
 * `openai/form` モードではスキーマの形が保証されないため、読めない部分は落として
 * 自由入力にもしない（**作った入力欄で嘘の値を送らない**）。読めるものが1つも
 * 無ければ空になり、画面は拒否だけができる状態になる。
 */
export function readElicitationFields(requestedSchema: unknown): PromptField[] {
  const schema = rec(requestedSchema);
  const properties = rec(schema?.['properties']);
  if (properties === undefined) {
    return [];
  }
  const required = Array.isArray(schema?.['required'])
    ? schema['required'].filter((v): v is string => typeof v === 'string')
    : [];

  const fields: PromptField[] = [];
  for (const [id, value] of Object.entries(properties)) {
    const property = rec(value);
    if (property === undefined) {
      continue;
    }
    fields.push(readElicitationField(id, property, required.includes(id)));
  }
  return fields;
}

function readElicitationField(
  id: string,
  property: Record<string, unknown>,
  required: boolean,
): PromptField {
  const type = str(property['type']);
  const options = readEnumOptions(property);
  return {
    id,
    label: str(property['title']) || id,
    description: str(property['description']),
    options,
    multiple: type === 'array',
    // スキーマが選択肢を決めている。勝手に自由入力を足すと想定外の値を送ることになる
    allowOther: false,
    secret: str(property['format']) === 'password',
    // 未知の型はテキストとして扱う。画面を壊さないため
    input:
      type === 'boolean' ? 'boolean' : type === 'number' || type === 'integer' ? 'number' : 'text',
    required,
    defaultValue: defaultOf(property['default']),
  };
}

/**
 * enumの選択肢を読む。
 *
 * 表示名は `enumNames`（MCPの慣習）が優先。複数選択は `items` の下に入る。
 */
function readEnumOptions(property: Record<string, unknown>): PromptOption[] {
  const items = rec(property['items']);
  const source = Array.isArray(property['enum']) ? property : (items ?? {});
  const values = Array.isArray(source['enum']) ? source['enum'] : [];
  const names = Array.isArray(source['enumNames']) ? source['enumNames'] : [];

  const options: PromptOption[] = [];
  values.forEach((value, index) => {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return;
    }
    const text = String(value);
    const name = names[index];
    options.push({
      value: text,
      label: typeof name === 'string' && name !== '' ? name : text,
      description: '',
    });
  });
  return options;
}

function defaultOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function readOptions(raw: unknown): PromptOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: PromptOption[] = [];
  for (const entry of raw) {
    const option = rec(entry);
    const label = str(option?.['label']);
    if (label === '') {
      continue;
    }
    options.push({ value: label, label, description: str(option?.['description']) });
  }
  return options;
}

/**
 * 回答を応答の形にする。要求ごとに語彙が違う。
 *
 * 取り消し・拒否は中身を持たせない。**答えていない項目に値を作らない**。
 */
export function buildPromptResponse(prompt: PendingPrompt, submission: PromptSubmission): unknown {
  if (prompt.kind === 'userInput') {
    const answers: Record<string, { answers: string[] }> = {};
    for (const field of prompt.fields) {
      const given = submission.action === 'submit' ? (submission.values[field.id] ?? []) : [];
      answers[field.id] = { answers: given.filter((v) => v !== '') };
    }
    return { answers };
  }

  if (submission.action !== 'submit') {
    return { action: submission.action === 'cancel' ? 'cancel' : 'decline' };
  }
  return { action: 'accept', content: buildElicitationContent(prompt, submission) };
}

/** elicitationの `content`。スキーマの型に合わせて値を戻す。 */
function buildElicitationContent(
  prompt: PendingPrompt,
  submission: PromptSubmission,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of prompt.fields) {
    const given = (submission.values[field.id] ?? []).filter((v) => v !== '');
    if (given.length === 0) {
      // 未入力は送らない。空文字を入れるとサーバ側で「答えた」ことになる
      continue;
    }
    if (field.multiple) {
      content[field.id] = given;
      continue;
    }
    const [value] = given;
    if (value === undefined) {
      continue;
    }
    if (field.input === 'boolean') {
      content[field.id] = value === 'true';
      continue;
    }
    if (field.input === 'number') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        content[field.id] = parsed;
      }
      continue;
    }
    content[field.id] = value;
  }
  return content;
}
