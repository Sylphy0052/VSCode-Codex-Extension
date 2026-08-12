import type { MementoLike } from '../util/memento';

/** `MementoLike`（実体は `context.globalState`）に保存するときのキー。 */
export const CLAUDE_SESSION_NAMES_KEY = 'claude.sessionNames';

/**
 * 人が付け直したClaude Codeセッション名の保存先（issue #199、design.md §14.35）。
 *
 * `control.ts` の `buildRenameSessionRequest` のJSDocで説明したとおり、CLI側の
 * `rename_session` は実在し実際にtranscriptへ書き込まれるが、読み戻すための索引が無く
 * 一覧表示（`ClaudeSessionStore.list()`。先頭40行だけ読む設計）から確実に見つける手段が
 * 無い。そのため「人が付けた名前」はこちら（拡張機能側）を正として持ち、
 * `ClaudeSessionStore` の一覧生成・`ClaudeChatViewManager` のタブ名解決の両方が、
 * transcript由来の名前より優先してこちらを見る。
 *
 * セッションidはワークスペースをまたいでも一意なため、`workspaceState` ではなく
 * `globalState` を渡す想定（`extension.ts` 参照）。値を渡さない場合は何も永続化しない
 * no-opの `MementoLike` を既定にする（`claudeChatView.ts` の `memoryMemento` と同じ流儀。
 * テスト等でVSCodeの `Memento` を用意しなくても壊れない）。
 */
export class ClaudeSessionNameStore {
  constructor(
    private readonly memento: MementoLike = {
      get: (_key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    },
  ) {}

  /** 人が付けた名前を読む。付けていなければ `undefined`（呼び出し側はtranscript由来へフォールバックする）。 */
  get(sessionId: string): string | undefined {
    const all = this.memento.get<Record<string, string>>(CLAUDE_SESSION_NAMES_KEY, {});
    const name = all[sessionId];
    return name === undefined || name.trim() === '' ? undefined : name;
  }

  /** 人が付けた名前を保存する。ウィンドウのリロード後も `get` で読み戻せる。 */
  async set(sessionId: string, name: string): Promise<void> {
    const all = this.memento.get<Record<string, string>>(CLAUDE_SESSION_NAMES_KEY, {});
    await this.memento.update(CLAUDE_SESSION_NAMES_KEY, { ...all, [sessionId]: name });
  }
}
