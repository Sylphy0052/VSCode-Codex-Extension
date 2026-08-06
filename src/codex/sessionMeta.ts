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

/** ユーザーが直接始めた対話セッションか。index に載るのはこれだけ（設計書 §4.1）。 */
export function isUserThread(meta: SessionMeta): boolean {
  return meta.threadSource === 'user';
}
