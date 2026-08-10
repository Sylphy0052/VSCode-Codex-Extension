import type { ChatItem, ChatState } from '../appserver/chatState';
import { describeTool } from './transcript';

/**
 * `claude --output-format stream-json` のイベントを、Codex画面と共通の
 * `ChatState` へ畳み込む純粋関数。
 *
 * 未知のイベントは状態を変えずに素通しする（CLIの更新で壊れないようにするため）。
 */
export const initialClaudeState: ChatState = {
  threadId: undefined,
  name: undefined,
  busy: false,
  // Claude Codeの中断はcontrol protocolで、ターンの指定を要らない
  turnId: undefined,
  items: [],
  approvals: [],
  usage: undefined,
};

export function applyStreamEvent(state: ChatState, event: Record<string, unknown>): ChatState {
  switch (str(event['type'])) {
    case 'system':
      return applySystem(state, event);
    case 'assistant':
      return applyAssistant(state, event);
    case 'user':
      return applyUser(state, event);
    case 'stream_event':
      return applyPartial(state, event);
    case 'rate_limit_event':
      return applyRateLimit(state, event);
    case 'result':
      return applyResult(state);
    default:
      return state;
  }
}

function applySystem(state: ChatState, event: Record<string, unknown>): ChatState {
  if (str(event['subtype']) !== 'init') {
    return state;
  }
  const sessionId = str(event['session_id']);
  return {
    ...state,
    threadId: sessionId === '' ? state.threadId : sessionId,
    // initはターン開始時に届く。resultで解除する
    busy: true,
  };
}

function applyAssistant(state: ChatState, event: Record<string, unknown>): ChatState {
  const message = rec(event['message']);
  const content = list(message?.['content']);
  let items = state.items;

  for (const [position, part] of content.entries()) {
    const type = str(part['type']);
    if (type === 'text') {
      items = upsert(items, {
        id: blockId(message, position, 'text'),
        kind: 'agentMessage',
        text: str(part['text']),
        detail: '',
        status: undefined,
        turnId: undefined,
      });
      continue;
    }
    if (type === 'thinking') {
      items = upsert(items, {
        id: blockId(message, position, 'thinking'),
        kind: 'reasoning',
        text: str(part['thinking']),
        detail: '',
        status: undefined,
        turnId: undefined,
      });
      continue;
    }
    if (type === 'tool_use') {
      const tool = describeTool(str(part['name']), rec(part['input']) ?? {});
      items = upsert(items, {
        id: str(part['id']),
        kind: tool.kind,
        text: '',
        detail: tool.detail,
        status: 'running',
        turnId: undefined,
      });
    }
  }

  return items === state.items ? state : { ...state, items, busy: true };
}

/**
 * ユーザー側のイベント。ツール結果と、`--replay-user-messages` で返ってくる
 * 自分の発言の2種類が来る。
 */
function applyUser(state: ChatState, event: Record<string, unknown>): ChatState {
  const content = list(rec(event['message'])?.['content']);
  let items = state.items;

  for (const part of content) {
    const type = str(part['type']);
    if (type === 'tool_result') {
      const index = items.findIndex((i) => i.id === str(part['tool_use_id']));
      const existing = items[index];
      if (index === -1 || existing === undefined) {
        continue;
      }
      const next = [...items];
      next[index] = {
        ...existing,
        text: resultText(part['content']),
        status: part['is_error'] === true ? 'エラー' : 'completed',
      };
      items = next;
      continue;
    }
    if (type === 'text') {
      const text = str(part['text']);
      if (text === '') {
        continue;
      }
      items = upsert(items, {
        id: str(event['uuid']) || `user-${items.length}`,
        kind: 'userMessage',
        text,
        detail: '',
        status: undefined,
        turnId: undefined,
      });
    }
  }

  return items === state.items ? state : { ...state, items };
}

/** `--include-partial-messages` のデルタ。同じブロックへ書き足していく。 */
function applyPartial(state: ChatState, event: Record<string, unknown>): ChatState {
  const inner = rec(event['event']);
  if (inner === undefined) {
    return state;
  }
  const id = partialId(event, inner);

  if (str(inner['type']) === 'content_block_start') {
    const block = rec(inner['content_block']);
    if (block === undefined || str(block['type']) !== 'text') {
      return state;
    }
    return {
      ...state,
      busy: true,
      items: upsert(state.items, {
        id,
        kind: 'agentMessage',
        text: str(block['text']),
        detail: '',
        status: undefined,
        turnId: undefined,
      }),
    };
  }

  if (str(inner['type']) !== 'content_block_delta') {
    return state;
  }
  const delta = rec(inner['delta']);
  const text = str(delta?.['text']) || str(delta?.['thinking']);
  if (text === '') {
    return state;
  }

  const index = state.items.findIndex((i) => i.id === id);
  const existing = state.items[index];
  if (index === -1 || existing === undefined) {
    return {
      ...state,
      busy: true,
      items: [
        ...state.items,
        { id, kind: 'agentMessage', text, detail: '', status: undefined, turnId: undefined },
      ],
    };
  }

  const items = [...state.items];
  items[index] = { ...existing, text: existing.text + text };
  return { ...state, busy: true, items };
}

function applyResult(state: ChatState): ChatState {
  return { ...state, busy: false };
}

/**
 * レート制限の状態。
 *
 * Claude CodeはCodexと違って消費率を返さないため、制限の種類とリセット時刻で示す。
 * 実測した中身: `{status, resetsAt, rateLimitType, overageStatus, isUsingOverage}`。
 */
function applyRateLimit(state: ChatState, event: Record<string, unknown>): ChatState {
  const info = rec(event['rate_limit_info']);
  if (info === undefined) {
    return state;
  }

  const status = str(info['status']);
  return {
    ...state,
    usage: {
      usedPercent: state.usage?.usedPercent,
      resetsAt: num(info['resetsAt']) ?? state.usage?.resetsAt,
      limitLabel: limitLabelOf(str(info['rateLimitType'])) ?? state.usage?.limitLabel,
      limited: status === '' ? state.usage?.limited : status !== 'allowed',
    },
  };
}

/** 未知の種別はCLIの表記のまま出す。増えても表示が消えないようにするため。 */
function limitLabelOf(rateLimitType: string): string | undefined {
  if (rateLimitType === '') {
    return undefined;
  }
  const known: Record<string, string> = {
    five_hour: '5時間',
    seven_day: '週次',
    weekly: '週次',
  };
  return known[rateLimitType] ?? rateLimitType;
}

/**
 * 完成メッセージのブロックid。
 *
 * content配列の要素は `index` を持たないため、配列内の位置で区別する。
 * これを怠ると、1メッセージに複数のテキストがあるとき同じ項目に上書きされる。
 */
function blockId(
  message: Record<string, unknown> | undefined,
  position: number,
  kind: string,
): string {
  const base = str(message?.['id']) || 'assistant';
  return `${base}:${kind}:${position}`;
}

function partialId(event: Record<string, unknown>, inner: Record<string, unknown>): string {
  const base = str(event['uuid']) || 'partial';
  return `${base}:${num(inner['index']) ?? 0}`;
}

function upsert(items: readonly ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) {
    return [...items, item];
  }
  const existing = items[index];
  const next = [...items];
  next[index] = {
    ...item,
    // デルタで積んだ本文を、本文が空の完成イベントで消さない
    text: item.text === '' && existing !== undefined ? existing.text : item.text,
  };
  return next;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return list(content)
    .map((part) => (str(part['type']) === 'text' ? str(part['text']) : ''))
    .filter((text) => text !== '')
    .join('\n');
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map((v) => rec(v) ?? {}) : [];
