import { describe, expect, it } from 'vitest';
import { SERVER_REQUEST_METHODS } from '../../src/appserver/approvals';
import {
  buildPromptResponse,
  describePrompt,
  readElicitationFields,
  type PendingPrompt,
} from '../../src/appserver/prompts';

const userInput = (questions: unknown, isBlocking = true): Record<string, unknown> => ({
  threadId: 'th-1',
  turnId: 'tu-1',
  itemId: 'it-1',
  isBlocking,
  questions,
});

const describeUser = (questions: unknown, isBlocking = true): PendingPrompt | undefined =>
  describePrompt(1, SERVER_REQUEST_METHODS.requestUserInput, userInput(questions, isBlocking));

describe('describePrompt / requestUserInput', () => {
  it('質問を入力欄にする', () => {
    const prompt = describeUser([
      { id: 'q1', header: 'デプロイ先', question: 'どの環境へ出しますか', options: null },
    ]);
    expect(prompt).toMatchObject({
      requestId: 1,
      kind: 'userInput',
      blocking: true,
      fields: [
        {
          id: 'q1',
          label: 'デプロイ先',
          description: 'どの環境へ出しますか',
          options: [],
          // 選択肢が無ければ自由入力
          allowOther: true,
          secret: false,
        },
      ],
    });
  });

  it('選択肢を並べる', () => {
    const prompt = describeUser([
      {
        id: 'q1',
        header: '環境',
        question: 'どれ',
        options: [
          { label: 'staging', description: '検証用' },
          { label: 'production', description: '本番' },
        ],
      },
    ]);
    expect(prompt?.fields[0]?.options).toEqual([
      { value: 'staging', label: 'staging', description: '検証用' },
      { value: 'production', label: 'production', description: '本番' },
    ]);
    // isOther が無ければ選択肢だけ
    expect(prompt?.fields[0]?.allowOther).toBe(false);
  });

  it('isOther なら自由入力も許す', () => {
    const prompt = describeUser([
      {
        id: 'q1',
        header: 'h',
        question: 'q',
        options: [{ label: 'a', description: '' }],
        isOther: true,
      },
    ]);
    expect(prompt?.fields[0]?.allowOther).toBe(true);
  });

  it('isSecret を伝える', () => {
    const prompt = describeUser([
      { id: 'q1', header: 'token', question: '入力して', isSecret: true },
    ]);
    expect(prompt?.fields[0]?.secret).toBe(true);
  });

  it('複数の質問を並べる', () => {
    const prompt = describeUser([
      { id: 'q1', header: 'a', question: '1つめ' },
      { id: 'q2', header: 'b', question: '2つめ' },
    ]);
    expect(prompt?.fields.map((f) => f.id)).toEqual(['q1', 'q2']);
  });

  it('isBlocking が false なら止めない扱いにする', () => {
    expect(describeUser([{ id: 'q1', header: 'a', question: 'b' }], false)?.blocking).toBe(false);
  });

  it('idの無い質問は落とす', () => {
    const prompt = describeUser([
      { header: 'a', question: 'b' },
      { id: 'q2', header: 'c', question: 'd' },
    ]);
    expect(prompt?.fields.map((f) => f.id)).toEqual(['q2']);
  });

  it('質問が読めなければ画面に出さない', () => {
    // 呼び出し側が既定の拒否（空の回答）へ回す
    expect(describeUser(undefined)).toBeUndefined();
    expect(describeUser([])).toBeUndefined();
    expect(describeUser([{ header: 'a' }])).toBeUndefined();
  });
});

const elicitation = (params: Record<string, unknown>): PendingPrompt | undefined =>
  describePrompt('e1', SERVER_REQUEST_METHODS.elicitation, {
    serverName: 'weather',
    threadId: 'th-1',
    turnId: null,
    ...params,
  });

describe('describePrompt / elicitation', () => {
  it('どのMCPサーバからの要求か出す', () => {
    const prompt = elicitation({ mode: 'form', message: '場所を教えて', requestedSchema: {} });
    expect(prompt).toMatchObject({
      kind: 'elicitation',
      source: 'weather',
      message: '場所を教えて',
    });
  });

  it('サーバ名が無くても出どころを空にしない', () => {
    expect(elicitation({ serverName: '', mode: 'form', requestedSchema: {} })?.source).toBe(
      '不明なMCPサーバ',
    );
  });

  it('turnIdがnullでも出せる', () => {
    expect(elicitation({ mode: 'form', requestedSchema: {} })).toBeDefined();
  });

  it('urlモードは行き先をそのまま見せる', () => {
    // 押すだけで外部へ飛ぶ導線は作らない
    const prompt = elicitation({
      mode: 'url',
      message: 'ここで認証して',
      url: 'https://example.com/auth?token=abc',
      elicitationId: 'x',
    });
    expect(prompt?.url).toBe('https://example.com/auth?token=abc');
    expect(prompt?.fields).toEqual([]);
  });
});

describe('readElicitationFields', () => {
  it('文字列・数値・真偽値を読み分ける', () => {
    const fields = readElicitationFields({
      type: 'object',
      properties: {
        city: { type: 'string', title: '都市', description: '英語で' },
        days: { type: 'number', default: 3 },
        metric: { type: 'boolean', default: true },
      },
      required: ['city'],
    });
    expect(fields).toEqual([
      {
        id: 'city',
        label: '都市',
        description: '英語で',
        options: [],
        multiple: false,
        allowOther: false,
        secret: false,
        input: 'text',
        required: true,
        defaultValue: '',
      },
      expect.objectContaining({ id: 'days', input: 'number', defaultValue: '3', required: false }),
      expect.objectContaining({ id: 'metric', input: 'boolean', defaultValue: 'true' }),
    ]);
  });

  it('enumを選択肢にする', () => {
    const [field] = readElicitationFields({
      type: 'object',
      properties: { unit: { type: 'string', enum: ['c', 'f'], enumNames: ['摂氏', '華氏'] } },
    });
    expect(field?.options).toEqual([
      { value: 'c', label: '摂氏', description: '' },
      { value: 'f', label: '華氏', description: '' },
    ]);
    expect(field?.multiple).toBe(false);
  });

  it('配列のenumは複数選択にする', () => {
    const [field] = readElicitationFields({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
    });
    expect(field?.multiple).toBe(true);
    expect(field?.options.map((o) => o.value)).toEqual(['a', 'b']);
  });

  it('password形式は伏せ字にする', () => {
    const [field] = readElicitationFields({
      type: 'object',
      properties: { key: { type: 'string', format: 'password' } },
    });
    expect(field?.secret).toBe(true);
  });

  it('未知の型はテキストとして扱う（画面を壊さない）', () => {
    const [field] = readElicitationFields({
      type: 'object',
      properties: { weird: { type: 'quaternion' } },
    });
    expect(field?.input).toBe('text');
  });

  it('読めないスキーマでは入力欄を作らない', () => {
    // 作った入力欄で嘘の値を送らない。拒否だけができる状態になる
    expect(readElicitationFields(undefined)).toEqual([]);
    expect(readElicitationFields({ type: 'object' })).toEqual([]);
    expect(readElicitationFields({ properties: 'なにか' })).toEqual([]);
  });
});

describe('buildPromptResponse / requestUserInput', () => {
  const prompt = describeUser([
    { id: 'q1', header: 'a', question: '1つめ' },
    { id: 'q2', header: 'b', question: '2つめ' },
  ]) as PendingPrompt;

  it('質問idごとに答えを返す', () => {
    expect(
      buildPromptResponse(prompt, { action: 'submit', values: { q1: ['はい'], q2: ['いいえ'] } }),
    ).toEqual({ answers: { q1: { answers: ['はい'] }, q2: { answers: ['いいえ'] } } });
  });

  it('答えていない質問もidを揃えて返す', () => {
    // idを落とすと相手が読めない
    expect(buildPromptResponse(prompt, { action: 'submit', values: { q1: ['はい'] } })).toEqual({
      answers: { q1: { answers: ['はい'] }, q2: { answers: [] } },
    });
  });

  it('空文字は答えとして送らない', () => {
    expect(
      buildPromptResponse(prompt, { action: 'submit', values: { q1: [''], q2: ['', 'b'] } }),
    ).toEqual({ answers: { q1: { answers: [] }, q2: { answers: ['b'] } } });
  });

  it('拒否は全部空で返す', () => {
    expect(buildPromptResponse(prompt, { action: 'decline', values: { q1: ['はい'] } })).toEqual({
      answers: { q1: { answers: [] }, q2: { answers: [] } },
    });
  });
});

describe('buildPromptResponse / elicitation', () => {
  const prompt = elicitation({
    mode: 'form',
    message: '教えて',
    requestedSchema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        days: { type: 'number' },
        metric: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
    },
  }) as PendingPrompt;

  it('スキーマの型に合わせて値を戻す', () => {
    expect(
      buildPromptResponse(prompt, {
        action: 'submit',
        values: { city: ['Tokyo'], days: ['3'], metric: ['true'], tags: ['a', 'b'] },
      }),
    ).toEqual({
      action: 'accept',
      content: { city: 'Tokyo', days: 3, metric: true, tags: ['a', 'b'] },
    });
  });

  it('未入力は送らない', () => {
    // 空文字を入れるとサーバ側で「答えた」ことになる
    expect(
      buildPromptResponse(prompt, { action: 'submit', values: { city: [''], days: [] } }),
    ).toEqual({ action: 'accept', content: {} });
  });

  it('数値として読めない値は送らない', () => {
    expect(buildPromptResponse(prompt, { action: 'submit', values: { days: ['さん'] } })).toEqual({
      action: 'accept',
      content: {},
    });
  });

  it('拒否と取り消しは中身を持たせない', () => {
    expect(buildPromptResponse(prompt, { action: 'decline', values: { city: ['Tokyo'] } })).toEqual(
      {
        action: 'decline',
      },
    );
    expect(buildPromptResponse(prompt, { action: 'cancel', values: {} })).toEqual({
      action: 'cancel',
    });
  });
});
