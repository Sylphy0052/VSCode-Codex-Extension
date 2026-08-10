export interface ChatItem {
  id: string;
  /** app-server の ThreadItem の種類。未知の種類も捨てずに保持する。 */
  kind: string;
  /** 本文。agentMessage はデルタで伸びる。 */
  text: string;
  /** コマンド行やファイル名など、種類ごとの補足。 */
  detail: string;
  status: string | undefined;
  /** このitemが属するターン。会話内から分岐する際の `lastTurnId` になる。 */
  turnId: string | undefined;
}

export interface PendingApproval {
  /** JSON-RPCの要求id。応答を返すときに使う。 */
  requestId: number | string;
  kind: 'command' | 'fileChange' | 'permissions';
  title: string;
  detail: string;
}

export interface ChatUsage {
  /** Codex。レート制限の消費率 */
  usedPercent: number | undefined;
  /** 制限がリセットされる時刻（epoch秒）。Claude Codeは割合を返さないためこちらで示す */
  resetsAt: number | undefined;
  /** 制限の種類の表示名（`5時間` など） */
  limitLabel: string | undefined;
  /** 制限に到達しているか */
  limited: boolean | undefined;
}

export interface ChatState {
  threadId: string | undefined;
  /** Codexが会話内容から付ける要約名。ユーザーが変更することもできる。 */
  name: string | undefined;
  /** Codexが応答中かどうか。入力欄の活性制御に使う。 */
  busy: boolean;
  /** 進行中のターン。`turn/interrupt` が要求するため保持する。 */
  turnId: string | undefined;
  /**
   * ストリーミング中のメッセージid（Claude Codeのみ）。
   *
   * 断片の通知には message.id が入らないため、`message_start` で得た値を覚えておき、
   * 完成メッセージと同じ項目に積む。Codexは通知ごとにitemIdが来るので使わない。
   */
  streamingMessageId: string | undefined;
  items: ChatItem[];
  approvals: PendingApproval[];
  usage: ChatUsage | undefined;
}

export const initialChatState: ChatState = {
  threadId: undefined,
  name: undefined,
  busy: false,
  turnId: undefined,
  streamingMessageId: undefined,
  items: [],
  approvals: [],
  usage: undefined,
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/** userMessage の content 配列からテキストを取り出す。 */
function readContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const p = rec(part);
      return p?.['type'] === 'text' ? str(p['text']) : '';
    })
    .filter((t) => t !== '')
    .join('\n');
}

/** 生の ThreadItem を表示用に正規化する。未知の種類は種類名だけ残す。 */
export function normalizeItem(raw: unknown): ChatItem | undefined {
  const item = rec(raw);
  const id = item?.['id'];
  const kind = item?.['type'];
  if (item === undefined || typeof id !== 'string' || typeof kind !== 'string') {
    return undefined;
  }

  const base: ChatItem = { id, kind, text: '', detail: '', status: undefined, turnId: undefined };
  const status = item['status'];
  if (typeof status === 'string') {
    base.status = status;
  }

  switch (kind) {
    case 'userMessage':
      return { ...base, text: readContentText(item['content']) };
    case 'agentMessage':
    case 'plan':
      return { ...base, text: str(item['text']) };
    case 'reasoning':
      return { ...base, text: str(item['summary']) || readContentText(item['content']) };
    case 'commandExecution': {
      const exitCode = item['exitCode'];
      return {
        ...base,
        text: str(item['aggregatedOutput']),
        detail: str(item['command']),
        status: typeof exitCode === 'number' ? `exit ${exitCode}` : base.status,
      };
    }
    case 'fileChange':
      return { ...base, detail: describeFileChanges(item['changes']) };
    case 'mcpToolCall':
      return { ...base, detail: `${str(item['server'])} / ${str(item['tool'])}` };
    case 'webSearch':
      return { ...base, detail: str(item['query']) };
    default:
      return base;
  }
}

function describeFileChanges(changes: unknown): string {
  if (!Array.isArray(changes)) {
    return '';
  }
  const paths = changes
    .map((c) => {
      const change = rec(c);
      return str(change?.['path']) || str(change?.['file']);
    })
    .filter((p) => p !== '');
  return paths.join(', ');
}

function upsertItem(items: readonly ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) {
    return [...items, item];
  }
  const existing = items[index];
  const next = [...items];
  next[index] = {
    ...item,
    // デルタで積んだ本文を、本文が空の completed で消さない
    text: item.text === '' && existing !== undefined ? existing.text : item.text,
    // turnIdは後続の通知で判ることがあるため、一度得た値を保持する
    turnId: item.turnId ?? existing?.turnId,
  };
  return next;
}

function appendDelta(items: readonly ChatItem[], itemId: string, delta: string): ChatItem[] {
  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) {
    return [
      ...items,
      {
        id: itemId,
        kind: 'agentMessage',
        text: delta,
        detail: '',
        status: undefined,
        turnId: undefined,
      },
    ];
  }
  const next = [...items];
  const existing = next[index];
  if (existing !== undefined) {
    next[index] = { ...existing, text: existing.text + delta };
  }
  return next;
}

/**
 * app-serverの通知を状態に畳み込む。
 *
 * 扱うのは `item/*` `turn/*` `thread/status/changed` と使用量のみ。
 * 未知の通知は状態を変えずに素通しする（プロトコルの追加で壊れないようにするため）。
 */
export function applyEvent(
  state: ChatState,
  method: string,
  params: Record<string, unknown>,
): ChatState {
  switch (method) {
    case 'turn/started': {
      // turnIdはトップレベルではなく turn オブジェクトの中にある（実機で確認）
      const turnId = str(rec(params['turn'])?.['id']);
      return { ...state, busy: true, turnId: turnId === '' ? undefined : turnId };
    }

    case 'turn/completed':
    case 'turn/failed':
      return { ...state, busy: false, turnId: undefined };

    case 'thread/name/updated': {
      const name = params['threadName'];
      return { ...state, name: typeof name === 'string' && name !== '' ? name : undefined };
    }

    case 'thread/status/changed': {
      const status = rec(params['status']);
      return { ...state, busy: str(status?.['type']) === 'active' };
    }

    case 'item/started':
    case 'item/updated':
    case 'item/completed': {
      const item = normalizeItem(params['item']);
      if (item === undefined) {
        return state;
      }
      const turnId = str(params['turnId']);
      const withTurn = turnId === '' ? item : { ...item, turnId };
      return {
        ...state,
        // turn/started を取り逃しても中断できるよう、item側の値でも補う
        turnId: turnId === '' ? state.turnId : turnId,
        items: upsertItem(state.items, withTurn),
      };
    }

    case 'item/agentMessage/delta': {
      const itemId = str(params['itemId']);
      const delta = str(params['delta']);
      if (itemId === '' || delta === '') {
        return state;
      }
      return { ...state, items: appendDelta(state.items, itemId, delta) };
    }

    case 'account/rateLimits/updated': {
      const primary = rec(rec(params['rateLimits'])?.['primary']);
      const usedPercent = primary?.['usedPercent'];
      return {
        ...state,
        usage: {
          usedPercent: typeof usedPercent === 'number' ? usedPercent : state.usage?.usedPercent,
          resetsAt: state.usage?.resetsAt,
          limitLabel: state.usage?.limitLabel,
          limited: state.usage?.limited,
        },
      };
    }

    default:
      return state;
  }
}

export function addApproval(state: ChatState, approval: PendingApproval): ChatState {
  return { ...state, approvals: [...state.approvals, approval] };
}

export function removeApproval(state: ChatState, requestId: number | string): ChatState {
  return { ...state, approvals: state.approvals.filter((a) => a.requestId !== requestId) };
}
