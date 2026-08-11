/**
 * リロード後にVSCodeが渡してくる、webviewが `setState` で持っていた値の読み取り。
 *
 * Codex画面・Claude Code画面とも同じスクリプト（`chatScript`）を使うため、
 * 保持している形も `{ threadId }` で共通。
 */
export function readPersistedThreadId(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) {
    return undefined;
  }
  const threadId = (state as Record<string, unknown>)['threadId'];
  return typeof threadId === 'string' && threadId !== '' ? threadId : undefined;
}
