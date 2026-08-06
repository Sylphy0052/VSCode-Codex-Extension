export interface ConversationTurn {
  /** `thread/fork` の `lastTurnId` に渡す値。 */
  turnId: string;
  timestamp: string | undefined;
  userMessage: string;
  agentMessages: string[];
  /** 実行したツールの名前（重複あり）。何をしたターンかの手掛かりとして出す。 */
  toolNames: string[];
}

interface RawEvent {
  type: string;
  timestamp: string | undefined;
  payload: Record<string, unknown> | undefined;
}

function readEvent(line: string): RawEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const root = raw as Record<string, unknown>;
  const type = root['type'];
  if (typeof type !== 'string') {
    return undefined;
  }
  const payload = root['payload'];
  const timestamp = root['timestamp'];
  return {
    type,
    timestamp: typeof timestamp === 'string' ? timestamp : undefined,
    payload:
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : undefined,
  };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * ロールアウトを会話の単位に組み立てる。
 *
 * 実データでの並びは `task_started` → `turn_context`（ここに `turn_id`）→ `user_message`
 * → 応答 → `task_complete`。turn_context を区切りにすれば turn_id と発言が1対1で対応する
 * （実データで78対78を確認済み）。
 */
export function parseConversation(content: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;

  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const event = readEvent(line);
    if (event?.payload === undefined) {
      continue;
    }
    const payload = event.payload;

    if (event.type === 'turn_context') {
      const turnId = payload['turn_id'];
      if (typeof turnId !== 'string' || turnId === '') {
        continue;
      }
      if (current !== undefined) {
        turns.push(current);
      }
      current = {
        turnId,
        timestamp: event.timestamp,
        userMessage: '',
        agentMessages: [],
        toolNames: [],
      };
      continue;
    }

    if (current === undefined) {
      continue;
    }

    if (event.type === 'event_msg') {
      const kind = payload['type'];
      if (kind === 'user_message' && current.userMessage === '') {
        current.userMessage = text(payload['message']);
      } else if (kind === 'agent_message') {
        const message = text(payload['message']);
        if (message !== '') {
          current.agentMessages.push(message);
        }
      }
      continue;
    }

    if (event.type === 'response_item' && payload['type'] === 'custom_tool_call') {
      const name = text(payload['name']);
      if (name !== '') {
        current.toolNames.push(name);
      }
    }
  }

  if (current !== undefined) {
    turns.push(current);
  }

  // 分岐点として意味を持つのはユーザーの指示があるターンだけ
  return turns.filter((t) => t.userMessage !== '');
}

/** 一覧に出す短い見出し。改行と余分な空白を潰す。 */
export function summarize(message: string, maxLength = 120): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}
