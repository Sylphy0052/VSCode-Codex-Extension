import type { SessionMeta } from './types';

/**
 * ロールアウトファイルの1行目 `session_meta` をパースする。
 *
 * この行はセッション開始時に書かれたきり変化しないため、結果は永続キャッシュしてよい
 * （設計書 §4.3）。全文を読む必要はない。
 */
export function parseSessionMeta(firstLine: string): SessionMeta | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(firstLine);
  } catch {
    return undefined;
  }

  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const root = raw as Record<string, unknown>;
  if (root['type'] !== 'session_meta') {
    return undefined;
  }

  const payload = root['payload'];
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const p = payload as Record<string, unknown>;
  const sessionId = p['session_id'];
  const cwd = p['cwd'];
  const timestamp = p['timestamp'];
  if (typeof sessionId !== 'string' || typeof cwd !== 'string' || typeof timestamp !== 'string') {
    return undefined;
  }

  const originator = p['originator'];
  const threadSource = p['thread_source'];
  return {
    sessionId,
    cwd,
    timestamp,
    originator: typeof originator === 'string' ? originator : undefined,
    source: p['source'],
    threadSource: typeof threadSource === 'string' ? threadSource : undefined,
  };
}

const ROLLOUT_RE =
  /^rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/**
 * ロールアウトのファイル名から session_id を取り出す。
 * ファイル名にidが含まれるため、ファイルの存在自体がセッションの発生を示す（設計書 §4.2）。
 */
export function sessionIdFromRolloutName(fileName: string): string | undefined {
  const m = ROLLOUT_RE.exec(fileName);
  return m?.[1];
}

/**
 * 先頭数十行から最初のユーザー発言を取り出す。
 *
 * Codexが要約名を確定させるまで `session_index.jsonl` には現れないため、
 * それまでの表示名をここから作る（Claude Code側と同じ考え方）。
 */
export function firstUserMessage(headLines: string[]): string | undefined {
  let afterTurnContext = false;
  let fallback: string | undefined;

  for (const line of headLines) {
    const root = readObject(line);
    if (root === undefined) {
      continue;
    }

    if (root['type'] === 'turn_context') {
      afterTurnContext = true;
      continue;
    }

    const payload = asObject(root['payload']);
    if (payload === undefined) {
      continue;
    }

    // TUI経由のセッションはこの形で残る
    if (root['type'] === 'event_msg' && payload['type'] === 'user_message') {
      const message = payload['message'];
      if (typeof message === 'string' && message.trim() !== '') {
        return message;
      }
      continue;
    }

    // チャット画面経由のセッションには user_message が無く、これだけが残る。
    // turn_context より前のものは AGENTS.md などの前置きなので採らない。
    if (
      afterTurnContext &&
      fallback === undefined &&
      root['type'] === 'response_item' &&
      payload['type'] === 'message' &&
      payload['role'] === 'user'
    ) {
      fallback = firstInputText(payload['content']);
    }
  }

  return fallback;
}

function firstInputText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const part of content) {
    const p = asObject(part);
    const text = p?.['text'];
    if (p?.['type'] === 'input_text' && typeof text === 'string' && text.trim() !== '') {
      return text;
    }
  }
  return undefined;
}

function readObject(line: string): Record<string, unknown> | undefined {
  if (line.trim() === '') {
    return undefined;
  }
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * ユーザーが直接始めた対話セッションか（設計書 §4.1）。
 *
 * `thread_source` が明示的に `'user'` 以外の値（`'subagent'` など）を持つ派生スレッドだけを除く。
 * codex-cli 0.148.0 の `session_meta` にはこのキー自体が無く、未設定を除外扱いにすると
 * 一覧が丸ごと空になる（issue #943）。`thread/list` 経路（`threadList.normalizeThread`）も
 * 同じ規則で判定しており、両経路の扱いを揃えている。
 */
export function isUserThread(meta: SessionMeta): boolean {
  return (
    meta.threadSource === undefined || meta.threadSource === '' || meta.threadSource === 'user'
  );
}
