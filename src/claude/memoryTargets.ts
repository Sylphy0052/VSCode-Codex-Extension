import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NO_DIFFS, type ChatItem } from '../appserver/chatState';

/**
 * メモリモード（`#`。design.md §14.29、Issue #6）の追記先解決とファイル入出力。
 *
 * 書き込み先は `listMemoryTargets` が列挙した候補に限る。ユーザーが打ったノート本文から
 * パスを組み立てることは一切しない（パストラバーサルの入口を作らないため）。
 */

/** メモリ追記の候補1件。 */
export interface MemoryTarget {
  /** QuickPickへ出すラベル。実在有無（既存/新規作成）を含める。 */
  label: string;
  /** QuickPickのdescription欄に出す絶対パス。 */
  description: string;
  /** 追記先の絶対パス。 */
  filePath: string;
  exists: boolean;
}

/** ファイル入出力の抽象。テストではfakeに差し替える（`src/process/commandRunner.ts` と同じ流儀）。 */
export interface MemoryFilePort {
  exists(filePath: string): Promise<boolean>;
  /**
   * ファイルが無ければ（ENOENT）`undefined` を返す。**それ以外の例外（EACCES / EBUSY /
   * EISDIR等）は投げる**。ここで握り潰すと、呼び出し側（`runMemoryAppend`）が
   * 「ファイルが存在しない」と誤解して `buildMemoryAppendContent(undefined, note)` を
   * 作り、`writeTextFile`（上書き）が実在するファイルの中身をノート1行だけに
   * 置き換えてしまう（レビュー指摘: 既存メモリファイルの内容破壊）。
   */
  readTextFile(filePath: string): Promise<string | undefined>;
  /** 親ディレクトリを含めて作り、内容で上書きする（新規作成・追記どちらもこれで足りる）。 */
  writeTextFile(filePath: string, content: string): Promise<void>;
  /**
   * `filePath` がシンボリックリンクなら実体の絶対パスを返す。シンボリックリンクでない、
   * または判定・解決のいずれかに失敗した場合は `undefined`（機能自体は壊さない防御的実装。
   * dotfiles管理などで `CLAUDE.md` をシンボリックリンクにする使い方は正当なため、
   * 中止はせず実パスを見せた上でユーザーに判断させる方針。レビュー指摘: シンボリックリンク
   * 追従による書き込み先すり替え）。
   */
  resolveSymlinkTarget(filePath: string): Promise<string | undefined>;
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export const nodeMemoryFilePort: MemoryFilePort = {
  async exists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  async readTextFile(filePath: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(filePath, 'utf8');
    } catch (e) {
      if (isEnoent(e)) {
        return undefined;
      }
      throw e;
    }
  },
  async writeTextFile(filePath: string, content: string): Promise<void> {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content, 'utf8');
  },
  async resolveSymlinkTarget(filePath: string): Promise<string | undefined> {
    try {
      const stat = await fsPromises.lstat(filePath);
      if (!stat.isSymbolicLink()) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    try {
      return await fsPromises.realpath(filePath);
    } catch {
      return undefined;
    }
  },
};

/**
 * `vscode.Memento` と構造的に一致する最小限の口（`orchestrator/runStore.ts` の
 * `WorkflowRunMemento` と同じ形）。`context.workspaceState` をそのまま渡せる。
 */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** 前回選んだ追記先を覚えておく `workspaceState` のキー。 */
export const LAST_MEMORY_TARGET_KEY = 'claude.memoryMode.lastTargetPath';

/** ユーザーメモリ（`CLAUDE.md`）のパス。`claude.configDir` が空なら `~/.claude`。 */
export function resolveUserMemoryPath(configDir: string): string {
  const base = configDir !== '' ? configDir : path.join(os.homedir(), '.claude');
  return path.join(base, 'CLAUDE.md');
}

/**
 * 追記先候補を列挙する（Issue #6）。各workspaceFolder直下の `CLAUDE.md`（複数なら全部）と、
 * ユーザーメモリ（`configDir` 優先）を並べる。実在するかどうかをラベルへ出す。
 */
export async function listMemoryTargets(
  workspaceFolders: readonly { name: string; path: string }[],
  configDir: string,
  port: MemoryFilePort,
): Promise<MemoryTarget[]> {
  const userPath = resolveUserMemoryPath(configDir);
  // 各候補の実在確認はお互いに依存しないため並列化する（逐次awaitだとworkspaceFolderの
  // 数だけ直列に待つ無駄があった）
  const [folderTargets, userExists] = await Promise.all([
    Promise.all(
      workspaceFolders.map(async (folder) => {
        const filePath = path.join(folder.path, 'CLAUDE.md');
        const exists = await port.exists(filePath);
        const target: MemoryTarget = {
          label: `${folder.name}（${exists ? '既存' : '新規作成'}）`,
          description: filePath,
          filePath,
          exists,
        };
        return target;
      }),
    ),
    port.exists(userPath),
  ]);
  return [
    ...folderTargets,
    {
      label: `ユーザーメモリ（${userExists ? '既存' : '新規作成'}）`,
      description: userPath,
      filePath: userPath,
      exists: userExists,
    },
  ];
}

/**
 * 前回選んだ追記先があれば先頭へ並べ替える（純粋関数。連続入力を軽くするため）。
 * 候補に見つからなければ元の順のまま返す。
 */
export function orderMemoryTargets(
  targets: readonly MemoryTarget[],
  lastUsedPath: string | undefined,
): MemoryTarget[] {
  if (lastUsedPath === undefined) {
    return [...targets];
  }
  const index = targets.findIndex((t) => t.filePath === lastUsedPath);
  if (index <= 0) {
    return [...targets];
  }
  const found = targets[index];
  if (found === undefined) {
    return [...targets];
  }
  return [found, ...targets.slice(0, index), ...targets.slice(index + 1)];
}

/**
 * 追記後の全文を組み立てる（純粋関数）。
 *
 * ファイル末尾へ `- <ノート本文>\n` を追記する。既存ファイルの末尾が改行で終わっていなければ
 * 先に改行を1つ足す。ノートが複数行なら、2行目以降は2スペースでインデントして
 * 1つの箇条書きに収める。
 */
export function buildMemoryAppendContent(existing: string | undefined, note: string): string {
  const lines = note.split('\n');
  const bullet = lines.map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`)).join('\n');
  const base = existing ?? '';
  if (base === '') {
    return `${bullet}\n`;
  }
  const withTrailingNewline = base.endsWith('\n') ? base : `${base}\n`;
  return `${withTrailingNewline}${bullet}\n`;
}

/**
 * 追記前の確認ダイアログの本文を組み立てる（純粋関数）。
 *
 * `symlinkTarget` が渡されていれば（`MemoryFilePort.resolveSymlinkTarget` が返した値。
 * シンボリックリンクでなければ `undefined`）、「リンク先」の行を足す。`filePath` が
 * シンボリックリンクだと実際に書き込まれるのはリンク先の実体だが、確認ダイアログに
 * リンク自身のパスしか出ないと、実際に書き換わるファイルがどれか分からないまま
 * 承認してしまう（レビュー指摘: シンボリックリンク追従による書き込み先すり替え）。
 * 中止はせず、実パスを見せた上でユーザーに判断させる。
 */
export function buildMemoryAppendConfirmMessage(
  filePath: string,
  note: string,
  symlinkTarget: string | undefined,
): string {
  const linkLine = symlinkTarget !== undefined ? `\nリンク先: ${symlinkTarget}` : '';
  return `次の内容を追記します。\n\n追記先: ${filePath}${linkLine}\n\n${note}`;
}

/**
 * 追記の結果を会話へ残す項目（新しい種類 `memoryAppend`。design.md §14.29）。
 *
 * `symlinkTarget` が渡されていれば `detail` へリンク先も含める。会話に残る記録からも
 * 実際に書き込まれたファイルの実体パスが分かるようにする（`buildMemoryAppendConfirmMessage`
 * と同じ理由）。
 */
export function buildMemoryAppendItem(
  id: string,
  filePath: string,
  note: string,
  symlinkTarget?: string,
): ChatItem {
  return {
    id,
    kind: 'memoryAppend',
    text: note,
    detail: symlinkTarget !== undefined ? `${filePath}（リンク先: ${symlinkTarget}）` : filePath,
    status: undefined,
    turnId: undefined,
    diffs: NO_DIFFS,
  };
}
