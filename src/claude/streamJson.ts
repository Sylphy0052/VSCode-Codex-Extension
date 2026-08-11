import {
  appendNotice,
  capOutput,
  NO_TODOS,
  type ChatItem,
  type ChatState,
} from '../appserver/chatState';
import { readClaudeResultImages } from '../provider/imageRefs';
import { describeTool, normalizeTodos, TODO_WRITE_TOOL } from './transcript';

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
  turnFailed: false,
  streamingMessageId: undefined,
  queued: [],
  items: [],
  approvals: [],
  // Claude Codeにはツールからの問い合わせにあたる制御要求が無い（Codexのみ）
  prompts: [],
  usage: undefined,
  context: undefined,
  sessionCost: undefined,
  planMode: false,
  // Codexのレビュー中フラグに相当する概念がClaude Codeには無い
  reviewing: false,
  turnResultText: '',
  turnEditedFiles: [],
  todos: NO_TODOS,
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
      return applyResult(state, event);
    default:
      return state;
  }
}

function applySystem(state: ChatState, event: Record<string, unknown>): ChatState {
  const subtype = str(event['subtype']);
  if (subtype === 'compact_boundary') {
    return applyCompactBoundary(state, event);
  }
  if (subtype === 'status') {
    return applyStatus(state, event);
  }
  if (subtype !== 'init') {
    return state;
  }
  const sessionId = str(event['session_id']);
  return {
    ...state,
    threadId: sessionId === '' ? state.threadId : sessionId,
    // initはターン開始時に届く。resultで解除する
    busy: true,
    turnFailed: false,
    // 前のターンの成果を次のターンへ持ち越さない
    turnResultText: '',
    turnEditedFiles: [],
  };
}

function applyAssistant(state: ChatState, event: Record<string, unknown>): ChatState {
  const message = rec(event['message']);
  const content = list(message?.['content']);
  let items = state.items;
  let editedFiles = state.turnEditedFiles;
  let todos = state.todos;

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
        diffs: [],
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
        diffs: [],
      });
      continue;
    }
    if (type === 'tool_use') {
      const name = str(part['name']);
      // TODO一覧は会話に項目として積まず、専用の一覧（state.todos）だけを書き換える
      if (name === TODO_WRITE_TOOL) {
        todos = normalizeTodos(part['input']);
        continue;
      }
      const input = rec(part['input']) ?? {};
      const tool = describeTool(name, input);
      items = upsert(items, {
        id: str(part['id']),
        kind: tool.kind,
        text: '',
        detail: tool.detail,
        status: 'running',
        turnId: undefined,
        diffs: tool.diffs,
      });
      // Edit/Write/NotebookEdit はファイル編集。作業記録の成果行に使うため集めておく
      if (tool.kind === 'fileChange') {
        const filePath = str(input['file_path']);
        if (filePath !== '' && !editedFiles.includes(filePath)) {
          editedFiles = [...editedFiles, filePath];
        }
      }
    }
  }

  if (items === state.items && editedFiles === state.turnEditedFiles && todos === state.todos) {
    return state;
  }
  return { ...state, items, turnEditedFiles: editedFiles, todos, busy: true };
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
      // ツールの出力は際限なく長くなりうる。Codex側と同じ上限で末尾だけ残す
      const output = capOutput(resultText(part['content']));
      const next = [...items];
      next[index] = {
        ...existing,
        text: output.text,
        truncated: output.truncated,
        // 画像を読むツール（Read）は base64 の image ブロックで返す（実測）
        images: readClaudeResultImages(part['content']),
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
        diffs: [],
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
  const type = str(inner['type']);

  // 断片の通知は message.id を持たない。ここで覚えて完成メッセージと同じ項目に積む
  if (type === 'message_start') {
    const id = str(rec(inner['message'])?.['id']);
    return { ...state, streamingMessageId: id === '' ? undefined : id };
  }

  if (type === 'content_block_start') {
    const block = rec(inner['content_block']);
    const kind = str(block?.['type']);
    if (block === undefined || (kind !== 'text' && kind !== 'thinking')) {
      return state;
    }
    return {
      ...state,
      busy: true,
      items: upsert(state.items, {
        id: partialId(state, inner, kind),
        kind: kind === 'thinking' ? 'reasoning' : 'agentMessage',
        text: str(block['text']) || str(block['thinking']),
        detail: '',
        status: undefined,
        turnId: undefined,
        diffs: [],
      }),
    };
  }

  if (type !== 'content_block_delta') {
    return state;
  }
  const delta = rec(inner['delta']);
  const text = str(delta?.['text']) || str(delta?.['thinking']);
  if (text === '') {
    return state;
  }
  const kind = str(delta?.['type']) === 'thinking_delta' ? 'thinking' : 'text';
  const id = partialId(state, inner, kind);

  const index = state.items.findIndex((i) => i.id === id);
  const existing = state.items[index];
  if (index === -1 || existing === undefined) {
    return {
      ...state,
      busy: true,
      items: [
        ...state.items,
        {
          id,
          kind: kind === 'thinking' ? 'reasoning' : 'agentMessage',
          text,
          detail: '',
          status: undefined,
          turnId: undefined,
          diffs: [],
        },
      ],
    };
  }

  const items = [...state.items];
  items[index] = { ...existing, text: existing.text + text };
  return { ...state, busy: true, items };
}

/**
 * ターンの終わり。`is_error` か `success` 以外のsubtypeは失敗として扱う。
 * ループ実行を止める判断に使うため、完了と区別して持つ。
 *
 * `result` フィールドにはそのターンのアシスタントの最終応答テキストが入る
 * （作業記録の成果行に使う。`turnEditedFiles` は tool_use から積んだものをそのまま使う）。
 */
function applyResult(state: ChatState, event: Record<string, unknown>): ChatState {
  const subtype = str(event['subtype']);
  const failed = event['is_error'] === true || (subtype !== '' && subtype !== 'success');
  return { ...state, busy: false, turnFailed: failed, turnResultText: str(event['result']) };
}

/**
 * 圧縮の境目。手動・自動どちらでも届く。
 *
 * 圧縮した位置を会話に残すのはこの通知の役目にする。成功したことは
 * `status` 通知でも判るが、両方で項目を作ると同じ圧縮が二重に並ぶ。
 * 実測した中身: `{trigger, pre_tokens, post_tokens, cumulative_dropped_tokens, ...}`。
 */
function applyCompactBoundary(state: ChatState, event: Record<string, unknown>): ChatState {
  const meta = rec(event['compact_metadata']) ?? {};
  const trigger = str(meta['trigger']);
  const before = num(meta['pre_tokens']);
  const after = num(meta['post_tokens']);

  const bits: string[] = [];
  if (trigger !== '') {
    bits.push(trigger === 'auto' ? '自動' : trigger === 'manual' ? '手動' : trigger);
  }
  if (before !== undefined && after !== undefined) {
    bits.push(before + ' → ' + after + ' トークン');
  }

  return {
    ...state,
    items: upsert(state.items, {
      id: compactionId(event),
      kind: 'contextCompaction',
      text: '',
      detail: bits.join(' ・ '),
      // 見出しが「会話を圧縮しました」なので、状態を重ねて出すと冗長になる
      status: undefined,
      turnId: undefined,
      diffs: [],
    }),
  };
}

/**
 * 圧縮の進行と結果。実測した中身は `{status, compact_result, compact_error}` で、
 * `compact_result` は `success` か `failed`。
 *
 * 成功は `compact_boundary` が受け持つので、ここでは失敗だけを項目にする。
 * 失敗を黙って捨てると「押したのに何も起きない」状態になる。
 */
function applyStatus(state: ChatState, event: Record<string, unknown>): ChatState {
  // 承認方法の変更。こちらから変えた場合も、TUIなど他の経路で変わった場合も届く
  const permissionMode = str(event['permissionMode']);
  if (permissionMode !== '') {
    // Plan modeの状態はこの通知を正とする。要求の成功だけを信じない
    return appendNotice(
      { ...state, planMode: permissionMode === 'plan' },
      'settings:' + (str(event['uuid']) || permissionMode),
      '承認方法を ' + permissionMode + ' に変えました',
    );
  }

  if (str(event['compact_result']) !== 'failed') {
    return state;
  }
  return {
    ...state,
    items: upsert(state.items, {
      id: compactionId(event),
      kind: 'contextCompaction',
      text: str(event['compact_error']) || '理由は判りません',
      detail: '',
      status: 'エラー',
      turnId: undefined,
      diffs: [],
    }),
  };
}

/** 圧縮の項目id。同じ通知が二度届いても項目が増えないよう uuid を使う。 */
function compactionId(event: Record<string, unknown>): string {
  return 'compaction:' + (str(event['uuid']) || str(event['session_id']));
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

/**
 * 断片の項目id。
 *
 * 完成メッセージ（`assistant`）と同じ形にして、同じ項目へ上書きされるようにする。
 * イベントごとに変わる uuid を使うと断片の数だけ項目が増えてしまう。
 */
function partialId(state: ChatState, inner: Record<string, unknown>, kind: string): string {
  const base = state.streamingMessageId ?? 'assistant';
  return `${base}:${kind}:${num(inner['index']) ?? 0}`;
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
