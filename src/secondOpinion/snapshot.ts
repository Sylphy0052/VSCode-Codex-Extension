/**
 * セカンドオピニオン（Issue #894）のレビュー対象スナップショットの取得。
 *
 * `read-only` サンドボックスは**セカンドオピニオン自身**の書き込みを防ぐだけで、
 * 親セッションが実行中に作業ツリーを書き換えることは止められない。何もしないと
 * 「ファイルAを読んだ後にAが書き換わり、その後にファイルBを読む」という、どの時点にも
 * 存在しなかった状態をレビューすることになる。そのため、押下時に `git rev-parse HEAD` と
 * `git diff HEAD` を一度だけ実行し、その結果を固定してプロンプトへ載せる（受入基準5）。
 */

import {
  isGitWorkingTree,
  resolveHeadCommit,
  type GitCommandRunner,
} from '../orchestrator/worktree';
import type { WorkspaceSnapshot } from './prompt';

/**
 * プロンプトへ載せる差分の上限（文字数）。
 *
 * 超えた分は末尾を落とし、落としたことをプロンプトへ明記する（`prompt.ts` の
 * `truncated`）。黙って切ると、モデルは「差分の全部を見た」前提で判断してしまう。
 */
export const MAX_DIFF_CHARS = 200_000;

export type CaptureSnapshotResult =
  { ok: true; snapshot: WorkspaceSnapshot } | { ok: false; reason: string };

/**
 * 起動時点の成果物スナップショットを取る。
 *
 * gitリポジトリでない場合・HEADが取れない場合・差分が空の場合は、理由を添えて
 * `ok: false` を返す（呼び出し側が会話へ理由を残す。黙って空のレビューを走らせない）。
 */
export async function captureWorkspaceSnapshot(
  cwd: string,
  git: GitCommandRunner,
  maxDiffChars: number = MAX_DIFF_CHARS,
): Promise<CaptureSnapshotResult> {
  if (!(await isGitWorkingTree(cwd, git))) {
    return { ok: false, reason: 'gitの作業ツリーではないため、変更のスナップショットを取れません' };
  }
  const baseCommit = await resolveHeadCommit(cwd, git);
  if (baseCommit === undefined) {
    return { ok: false, reason: 'HEADコミットを解決できませんでした（コミットがまだありません）' };
  }
  // 追跡外のファイルは含まれない。`git add -N` 相当まで面倒を見ると作業ツリーを
  // 書き換えることになるため、読み取りだけで完結する範囲に留める
  //
  // `HEAD` ではなく解決済みのハッシュを渡す。`git diff HEAD` は `HEAD` を解決し直すため、
  // `rev-parse` との間にコミットが入ると `baseCommit` と差分が別の地点を指す（#926 A）。
  // `--no-ext-diff` / `--no-textconv` は、利用者の `.gitconfig` / `.gitattributes` に
  // 設定された外部diffドライバ・textconvフィルタを走らせないため。レビュー用の写しを
  // 取るだけの経路で任意の外部コマンドを起動する理由が無い
  const result = await git.run(['diff', '--no-ext-diff', '--no-textconv', baseCommit, '--'], cwd);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    return {
      ok: false,
      reason: `git diff に失敗しました（終了コード ${result.code}）${detail === '' ? '' : `: ${detail}`}`,
    };
  }
  const diff = result.stdout;
  if (diff.trim() === '') {
    return {
      ok: false,
      reason:
        '作業ツリーに未コミットの変更がありません（レビュー対象を「依頼文のみ」に変えて実行してください）',
    };
  }
  if (diff.length > maxDiffChars) {
    return {
      ok: true,
      snapshot: { baseCommit, diff: diff.slice(0, maxDiffChars), truncated: true },
    };
  }
  return { ok: true, snapshot: { baseCommit, diff, truncated: false } };
}
