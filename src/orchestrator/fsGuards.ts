import * as path from 'node:path';

import { TASK_ID_PATTERN } from './workflow';

/**
 * `runId` / `taskId` の識別子検証と、worktree/疑似worktreeの作成先パスに対する
 * シンボリックリンク検知（design.md §16.6「`.agents/worktrees` がシンボリックリンクの場合」）。
 *
 * `escalation.ts` の `isPathWithinRoot` と同じ扱いで、依存を持たない末端モジュールとして
 * 置く（`workflow.ts` から `TASK_ID_PATTERN` を読むだけで、`worktree.ts` /
 * `integration.ts` / `pseudoWorktree.ts` のいずれもimportしない）。
 *
 * これらは元々 `worktree.ts` / `integration.ts` / `pseudoWorktree.ts` の3箇所へ
 * ほぼ同一実装のまま複製されていた（Issue #146）。コメントには「循環importを避けるため
 * 複製する」とあったが、いずれも他モジュールに依存しない純粋関数・正規表現であり、
 * 実際には循環しない（3ファイルのどれもここをimportし返さない）ため、素直に一本化できる。
 *
 * `findSymlinkedAncestor` は design.md §16.6 が「実機確認済みの脅威」として扱う
 * パストラバーサル対策の一次防御そのもの。セキュリティに関わるロジックが3箇所に
 * 分散しているのは危険なため、ここへ集約する。
 */

/**
 * `runId` の字種（UUID）。design.md §16.6「runIdはUUID」。
 *
 * `src/codex/argvBuilder.ts` の `isSessionId` と同じ正規表現だが、あえて複製している。
 * `isSessionId` はCodexセッションid専用の意味を持つ関数で、runIdの検証に流用すると
 * 「たまたま形式が同じだけ」の依存が生まれる。形式（UUID）が一致しているのはここでは
 * 偶然ではなく設計上の要件（design.md）なので、意味の異なるモジュールへ結合させず
 * このファイル内に正規表現として複製する。
 */
export const RUN_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `runId` を検証し、不正なら理由を返す（有効なら undefined）。 */
export function runIdError(runId: string): string | undefined {
  return RUN_ID_PATTERN.test(runId) ? undefined : `不正なrunId（UUID形式ではありません）: ${runId}`;
}

/**
 * `runId` / `taskId` を検証し、不正なら理由を返す（有効なら undefined）。
 * `worktreePath` / `branchName`（例外を投げる）と `createWorktree` / `removeWorktree`
 * （`Result` のエラーとして返す）の両方から呼ぶ共通の判定本体。
 *
 * `taskId` の字種は `workflow.ts` の `TASK_ID_PATTERN` をそのまま使う。`workflow.ts` は
 * このファイルを一切importしていないため循環の心配が無く、複製せず直接参照する
 * （二重管理による将来的な乖離を避ける）。
 */
export function identifierError(runId: string, taskId: string): string | undefined {
  const runIdMessage = runIdError(runId);
  if (runIdMessage !== undefined) {
    return runIdMessage;
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    return `不正なtaskId（許可されない文字を含みます）: ${taskId}`;
  }
  return undefined;
}

/**
 * `taskId` だけを検証する（`runId` を持たない場所から使う）。
 *
 * `parseHandoffFileName`（`teamHandoff.ts`）のように、ファイル名から取り出した `taskId` を
 * 検証したいが `runId` は手元に無い、という呼び出し向け。判定は `identifierError` の
 * `taskId` 側と同じ `TASK_ID_PATTERN` で、字種の定義をこのファイルの外へ広げないために置く。
 */
export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId);
}

/**
 * `worktreePath` / `branchName` はパスとブランチ名を組み立てる純粋関数のため、不正な入力は
 * 例外にする（`pseudoWorktreePath` も同じ流儀）。
 */
export function assertValidIdentifiers(runId: string, taskId: string): void {
  const message = identifierError(runId, taskId);
  if (message !== undefined) {
    throw new Error(message);
  }
}

/**
 * `findSymlinkedAncestor` が必要とする最小限のファイルシステム操作。`worktree.ts` の
 * `WorktreeFileSystemPort` と `pseudoWorktree.ts` の `PseudoWorktreeFileSystemPort` は
 * どちらも他の用途のメソッドを併せ持つ別々のインターフェースだが、`isSymbolicLink` の
 * シグネチャが一致しているため、この最小限の型を経由すればどちらのポートもそのまま渡せる
 * （構造的型付け。呼び出し側のインターフェースを1つに統合する必要はない）。
 */
export interface SymlinkCheckPort {
  /** `target` そのものがシンボリックリンクか（リンクを辿らず`lstat`で見る）。存在しなければ `false`。 */
  isSymbolicLink(target: string): Promise<boolean>;
}

/**
 * `root` から `target` までの各中間ディレクトリにシンボリックリンクが含まれていないかを
 * 確かめる。見つかった最初のパスを返す（無ければ undefined）。一次防御（事前検知）。
 *
 * `.agents/worktrees` がリポジトリにcommitされたシンボリックリンクだと、文字列結合
 * だけで組み立てたパスは実際にはリンク先（リポジトリの外）を指す（design.md §16.6、
 * レビュー指摘: critical 4。実機確認済み: `git worktree add` はリンクを黙って辿り、
 * エラーにならずリンク先へ実体を作る）。`sandbox: workspace-write` はcwd基準で書き込み
 * 可能域を決めるため、リンク先（例えばホーム配下）が丸ごとサンドボックス内として
 * 扱われてしまう。cloneしただけで発火し、YAMLを一切介さない。
 *
 * `target`（worktree/疑似worktree自体のディレクトリ）はこれから作られる前提のため
 * 存在しないが、その祖先（`.agents` / `.agents/worktrees` / `<runId>` ディレクトリ）は
 * 既存でありうる。存在しないセグメントは `isSymbolicLink` が `false` を返すだけで安全に
 * 読み飛ばせる。
 */
export async function findSymlinkedAncestor(
  root: string,
  target: string,
  fs: SymlinkCheckPort,
): Promise<string | undefined> {
  const rel = path.relative(root, target);
  const segments = rel.split(path.sep).filter((segment) => segment !== '' && segment !== '..');
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (await fs.isSymbolicLink(cursor)) {
      return cursor;
    }
  }
  return undefined;
}
