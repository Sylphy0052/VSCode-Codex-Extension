import type { SessionSummary } from '../codex/types';
import type { MementoLike } from './memento';

/** `MementoLike`（実体は `context.globalState`）に保存するときのキー。 */
export const PINNED_SESSIONS_KEY = 'codex.pinnedSessions';

/** ピン留めの管理単位。プロバイダをまたいでも衝突しないよう `TreeItem.id` と同じ組にする。 */
export function pinKeyFor(session: Pick<SessionSummary, 'provider' | 'id'>): string {
  return `${session.provider}:${session.id}`;
}

/**
 * ピン留めしたセッションの永続化（`globalState`、issue #293）。
 *
 * セッションidはワークスペースをまたいでも一意なため、`ClaudeSessionNameStore`
 * （`src/claude/sessionNames.ts`）と同じく `workspaceState` ではなく `globalState` を渡す想定。
 * 値を渡さない場合は何も永続化しないno-opの `MementoLike` を既定にする（同ファイルと同じ流儀）。
 */
export class PinnedSessionStore {
  constructor(
    private readonly memento: MementoLike = {
      get: (_key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    },
  ) {}

  /** ピン留め済みキーの一覧。並び順はピンした順（先頭が最も古い）。 */
  list(): string[] {
    return this.memento.get<string[]>(PINNED_SESSIONS_KEY, []);
  }

  isPinned(key: string): boolean {
    return this.list().includes(key);
  }

  async pin(key: string): Promise<void> {
    const current = this.list();
    if (current.includes(key)) {
      return;
    }
    await this.memento.update(PINNED_SESSIONS_KEY, [...current, key]);
  }

  async unpin(key: string): Promise<void> {
    await this.memento.update(
      PINNED_SESSIONS_KEY,
      this.list().filter((k) => k !== key),
    );
  }
}

/**
 * セッション一覧をピン留め済み/それ以外へ分ける。
 *
 * ピン留めのキーだけを保持し実体は都度この一覧と突き合わせるため、アーカイブ済み・削除済みで
 * 実体が一覧から消えたピンは（`pinnedKeys` に残っていても）自然に`pinned`へ現れなくなる。
 * ストレージ側のキーをここで書き換えたりはしない（読み取り専用の純粋関数のまま保つ）。
 *
 * 各グループ内の並びは入力の順序をそのまま保つ（呼び出し側は更新時刻の新しい順で渡す）。
 */
export function partitionPinned(
  sessions: readonly SessionSummary[],
  pinnedKeys: readonly string[],
): { pinned: SessionSummary[]; rest: SessionSummary[] } {
  const pinnedSet = new Set(pinnedKeys);
  const pinned: SessionSummary[] = [];
  const rest: SessionSummary[] = [];
  for (const session of sessions) {
    if (pinnedSet.has(pinKeyFor(session))) {
      pinned.push(session);
    } else {
      rest.push(session);
    }
  }
  return { pinned, rest };
}
