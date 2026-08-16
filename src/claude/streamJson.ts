import {
  appendNotice,
  capOutput,
  NO_BACKGROUND_TERMINALS,
  NO_TODOS,
  type BackgroundTerminalItem,
  type ChatItem,
  type ChatState,
} from '../appserver/chatState';
import { readClaudeResultImages } from '../provider/imageRefs';
import { parseAutocompactReport } from './autocompactText';
import { claudeSearchResults, describeTool, normalizeTodos, TODO_WRITE_TOOL } from './transcript';

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
  // Claude Codeには `thread/tokenUsage/updated` に相当する通知が無く、常にundefinedのまま
  // （Codexのみ、issue #294）
  sessionTokens: undefined,
  planMode: false,
  // Codexのレビュー中フラグに相当する概念がClaude Codeには無い
  reviewing: false,
  turnResultText: '',
  turnEditedFiles: [],
  todos: NO_TODOS,
  backgroundTerminals: NO_BACKGROUND_TERMINALS,
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
  if (subtype === 'background_tasks_changed') {
    return applyBackgroundTasksChanged(state, event);
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
  let autocompactWindow = state.autocompactWindow;

  for (const [position, part] of content.entries()) {
    const type = str(part['type']);
    if (type === 'text') {
      const text = str(part['text']);
      items = upsert(items, {
        id: blockId(message, position, 'text'),
        kind: 'agentMessage',
        text,
        detail: '',
        status: undefined,
        turnId: undefined,
        diffs: [],
        searchResults: [],
      });
      // `/autocompact` はモデル呼び出しを経由しない `<synthetic>` 応答として、固定書式の
      // テキストで窓サイズを返す（issue #201、design.md §14.37。`autocompactText.ts` 参照）。
      // 同じ `<synthetic>` でも `/recap` の自然文要約は書式が安定しないため対象外だが、
      // `parseAutocompactReport` は先頭が一致しない限り undefined を返すだけなので、
      // どの `<synthetic>` 応答に対しても安全に試せる
      if (str(message?.['model']) === '<synthetic>') {
        const parsed = parseAutocompactReport(text);
        if (parsed !== undefined) {
          autocompactWindow = parsed;
        }
      }
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
        searchResults: [],
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
        // tool_useの時点では結果が判らない。tool_resultが届いたときにapplyUserが埋める
        searchResults: [],
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

  if (
    items === state.items &&
    editedFiles === state.turnEditedFiles &&
    todos === state.todos &&
    autocompactWindow === state.autocompactWindow
  ) {
    return state;
  }
  return { ...state, items, turnEditedFiles: editedFiles, todos, autocompactWindow, busy: true };
}

/**
 * ユーザー側のイベント。ツール結果と、`--replay-user-messages` で返ってくる
 * 自分の発言の2種類が来る。
 */
function applyUser(state: ChatState, event: Record<string, unknown>): ChatState {
  const content = list(rec(event['message'])?.['content']);
  const toolResultCount = content.filter((part) => str(part['type']) === 'tool_result').length;
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
        // WebSearchの結果（issue #18）。メッセージ本体には無く、イベントに別枠で
        // 添えられる tool_use_result から取り出す（詳細は transcript.ts の関数を参照）
        searchResults:
          existing.kind === 'webSearch'
            ? claudeSearchResults(event['tool_use_result'], toolResultCount)
            : existing.searchResults,
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
        searchResults: [],
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
        searchResults: [],
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
          searchResults: [],
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
      searchResults: [],
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
      searchResults: [],
    }),
  };
}

/** 圧縮の項目id。同じ通知が二度届いても項目が増えないよう uuid を使う。 */
function compactionId(event: Record<string, unknown>): string {
  return 'compaction:' + (str(event['uuid']) || str(event['session_id']));
}

/**
 * バックグラウンドで走っているタスクの一覧（issue #33、design.md §14.23、Codex `/ps` 相当）。
 *
 * 実測（本issueの調査。`claude --print --input-format stream-json` を実際に起動し、
 * Bashツールを `run_in_background:true` で呼び出させて確認した）:
 * `{type:'system', subtype:'background_tasks_changed', tasks:[{task_id, task_type,
 * description}]}`。このイベントは一覧全体を毎回押し付けてくるため、差分ではなく置き換える
 * （`readCommandsChanged` と同じ考え方）。
 *
 * **`background_tasks` control requestで能動的に問い合わせても、実測では走っているタスクが
 * あるときでも空`{}`が返った**（2回実測、いずれも空）。このため一覧はこの通知だけを
 * 正として持つ（ポーリングはしない）。
 */
function applyBackgroundTasksChanged(state: ChatState, event: Record<string, unknown>): ChatState {
  const raw = event['tasks'];
  if (!Array.isArray(raw)) {
    return state;
  }
  const backgroundTerminals: BackgroundTerminalItem[] = [];
  for (const entry of raw) {
    const task = rec(entry);
    const id = str(task?.['task_id']);
    if (task === undefined || id === '') {
      continue;
    }
    backgroundTerminals.push({
      id,
      command: str(task['description']),
      // 実測ではこの通知に載っている間は常に走っている（`status`フィールド自体を持たない）。
      // CLIの語彙に合わせ `running` とする（`chatScript.ts` が既にCodexの `inProgress` と
      // 並べて扱っている値。issue #17）
      status: 'running',
      cwd: undefined,
      processId: undefined,
      taskType: strOrUndefined(task['task_type']),
      // `stop_task` が実際にタスクを止めることを実測で確認した（design.md §14.23）
      stoppable: true,
    });
  }
  return { ...state, backgroundTerminals };
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
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map((v) => rec(v) ?? {}) : [];
