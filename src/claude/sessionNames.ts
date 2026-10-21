import { join } from 'node:path';
import { KeyedStateFile } from '../util/keyedStateFile';
import type { MementoLike } from '../util/memento';

/** 旧globalStateのキー（Issue #2006で廃止。移行のためだけに残す）。 */
export const CLAUDE_SESSION_NAMES_KEY = 'claude.sessionNames';

/** 保存する件数の上限。超えたら最後に書いた時刻の古いものから捨てる。 */
export const CLAUDE_SESSION_NAMES_MAX_ENTRIES = 10_000;

/** 1件の名前の最大文字数。これを超える値は読まず、保存時は切り詰める。 */
const MAX_NAME_LENGTH = 1_000;

const FILE_NAME = 'claude-session-names.json';

/** 名前ファイルの置き場所。`context.globalStorageUri`配下（ウィンドウ間で配信されない、Issue #2006）。 */
export function claudeSessionNamesFilePath(globalStorageDir: string): string {
  return join(globalStorageDir, FILE_NAME);
}

function readName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_NAME_LENGTH ? value : undefined;
}

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
 * 保存先は`globalStorageUri`配下のファイル（Issue #2006）。`globalState`は全体を1つの
 * JSONとして全ウィンドウへ配信するため、セッション数に比例して増える名前は置かない。
 * セッションidはワークスペースをまたいでも一意なため、ワークスペース別にはしない。
 * `filePath`を渡さない場合はメモリ上にだけ持つ（テスト等で`globalStorageUri`を用意しなくても壊れない）。
 * 旧globalStateの値は起動を止めずに移行し、ファイルへ書けたことを確かめてから消す。
 */
export class ClaudeSessionNameStore {
  private readonly file: KeyedStateFile<string>;

  constructor(
    filePath?: string,
    legacy?: MementoLike,
    /** 旧キーの移行に失敗したとき呼ぶ。旧キーは残り、次回起動でやり直す。 */
    onMigrationError: (error: unknown) => void = () => undefined,
  ) {
    this.file = new KeyedStateFile(filePath, readName, CLAUDE_SESSION_NAMES_MAX_ENTRIES);
    if (filePath !== undefined && legacy !== undefined) {
      void this.migrateLegacy(legacy).catch(onMigrationError);
    }
  }

  /** 人が付けた名前を読む。付けていなければ `undefined`（呼び出し側はtranscript由来へフォールバックする）。 */
  get(sessionId: string): string | undefined {
    const name = this.file.get(sessionId);
    return name === undefined || name.trim() === '' ? undefined : name;
  }

  /** 人が付けた名前を保存する。ウィンドウのリロード後も `get` で読み戻せる。 */
  async set(sessionId: string, name: string): Promise<void> {
    await this.file.set(sessionId, name.slice(0, MAX_NAME_LENGTH));
  }

  private async migrateLegacy(legacy: MementoLike): Promise<void> {
    const readLegacy = (): Record<string, unknown> | undefined =>
      legacy.get<Record<string, unknown> | undefined>(CLAUDE_SESSION_NAMES_KEY, undefined);
    if (readLegacy() === undefined) {
      return;
    }
    // lockを取ってから読み直す。他ウィンドウが先に移行を済ませていれば空になる
    await this.file.importMissing(() => {
      const items: [string, string][] = [];
      for (const [id, value] of Object.entries(readLegacy() ?? {})) {
        const name = readName(value);
        if (name !== undefined) {
          items.push([id, name]);
        }
      }
      return items;
    });
    await legacy.update(CLAUDE_SESSION_NAMES_KEY, undefined);
  }
}
