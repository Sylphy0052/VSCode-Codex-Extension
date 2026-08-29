/**
 * セカンドオピニオン（Issue #894）の追加資料（作業ツリーの変更）のスナップショットの取得。
 *
 * `read-only` サンドボックスは**セカンドオピニオン自身**の書き込みを防ぐだけで、
 * 親セッションが実行中に作業ツリーを書き換えることは止められない。何もしないと
 * 「ファイルAを読んだ後にAが書き換わり、その後にファイルBを読む」という、どの時点にも
 * 存在しなかった状態をレビューすることになる。そのため、押下時に `git rev-parse HEAD` と
 * `git diff` を一度だけ実行し、その結果を固定してプロンプトへ載せる（受入基準5）。
 *
 * 未追跡ファイル（Issue #926 F）も同じ地点の材料として取る。読み取りだけで完結し、
 * indexも作業ツリーも書き換えない。安全に読むための決まりは `untracked.ts` にある。
 */

import {
  isGitWorkingTree,
  resolveHeadCommit,
  type GitCommandRunner,
} from '../orchestrator/worktree';
import { applyDiffBudget } from './diffBudget';
import type { WorkspaceSnapshot } from './prompt';
import {
  collectUntrackedFiles,
  createNodeUntrackedFileReader,
  parseUntrackedList,
  type UntrackedFileReader,
} from './untracked';

/**
 * プロンプトへ載せる材料の上限（UTF-8 byte）。
 *
 * 超えた分は落とし、落としたことをプロンプトへ明記する（`prompt.ts` の `truncated` と
 * 省略の一覧）。黙って切ると、モデルは「全部を見た」前提で判断してしまう。
 *
 * 単位はbyteである（Issue #926 H）。以前は文字数で測っていたが、日本語のコメントや
 * 識別子を含む差分では実際に送る量と3倍近くずれる。差分の切り詰め方（ファイル単位の
 * 配分・hunk境界）は `diffBudget.ts` にある。
 */
export const MAX_DIFF_BYTES = 200_000;

/**
 * 未追跡ファイルが使える上限（Issue #926 F）。
 *
 * 差分と共通の予算から**先に**この枠を取る。差分が大きいときに新規ファイルが丸ごと
 * 落ちると、「主要な実装が全部新規ファイル」という新機能開発の典型でAdvisorが
 * 既存ファイルの数行しか見なくなる——Fで直したかったことがそのまま残る。
 */
export const MAX_UNTRACKED_TOTAL_BYTES = 100_000;

/**
 * bundle（`reviewBundle.ts`）へ書き出すための、切り詰める前の材料（Issue #926 E）。
 *
 * プロンプトへ載せる {@link WorkspaceSnapshot} とは別に持つ。プロンプト側は上限で切るが、
 * ファイルとして置く分は切らない——Advisorが `changes.diff` を読めば全量に届く。
 */
export interface ReviewMaterial {
  /** 上限で切る前の差分。 */
  fullDiff: string;
  /**
   * 変更対象のパス一覧。
   *
   * `git diff` の出力を自前で解釈するのではなく `--name-only -z` で取る。パスの引用規則
   * （`core.quotepath`）やリネームの表記を自前で復元すると、そこで間違えたぶんだけ
   * ベース側が欠ける。
   */
  changedPaths: string[];
}

export type CaptureSnapshotResult =
  | { ok: true; snapshot: WorkspaceSnapshot; material: ReviewMaterial }
  | { ok: false; reason: string };

export interface CaptureSnapshotOptions {
  /** 材料全体の上限（UTF-8 byte）。既定は {@link MAX_DIFF_BYTES}。 */
  maxDiffBytes?: number;
  /** 未追跡ファイルが使える上限。既定は {@link MAX_UNTRACKED_TOTAL_BYTES}。 */
  maxUntrackedBytes?: number;
  /** 未追跡ファイルの読み取り。既定はNode実装。テストではフェイクを渡す。 */
  untrackedReader?: UntrackedFileReader;
}

/**
 * 起動時点の成果物スナップショットを取る。
 *
 * gitリポジトリでない場合・HEADが取れない場合・差分も未追跡ファイルも無い場合は、
 * 理由を添えて `ok: false` を返す（呼び出し側が会話へ理由を残す。黙って空のレビューを
 * 走らせない）。
 */
export async function captureWorkspaceSnapshot(
  cwd: string,
  git: GitCommandRunner,
  options: CaptureSnapshotOptions = {},
): Promise<CaptureSnapshotResult> {
  const maxDiffBytes = options.maxDiffBytes ?? MAX_DIFF_BYTES;
  const maxUntrackedBytes = Math.min(
    options.maxUntrackedBytes ?? MAX_UNTRACKED_TOTAL_BYTES,
    maxDiffBytes,
  );
  if (!(await isGitWorkingTree(cwd, git))) {
    return { ok: false, reason: 'gitの作業ツリーではないため、変更のスナップショットを取れません' };
  }
  const baseCommit = await resolveHeadCommit(cwd, git);
  if (baseCommit === undefined) {
    return { ok: false, reason: 'HEADコミットを解決できませんでした（コミットがまだありません）' };
  }
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
  // 変更対象のパスは差分と同じ地点から取りたいが、コマンドは別に走る。この2回の間に人が
  // ファイルを触ると一覧と差分がずれうる。ずれても害は「`base/` に余分なファイルが載る」
  // か「1件載らない」までで、`base/` の中身自体は `baseCommit` から読むので変わらない
  const named = await git.run(
    ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', baseCommit, '--'],
    cwd,
  );
  const changedPaths = named.code === 0 ? parseUntrackedList(named.stdout) : [];

  // 未追跡ファイルを先に取る（Issue #926 F）。差分の切り詰めより前に枠を確保しておかないと、
  // 巨大な差分があるときに新規ファイルが1つも載らない
  const untracked = await captureUntracked(cwd, git, maxUntrackedBytes, options.untrackedReader);
  const untrackedBytes = untracked.files.reduce((total, file) => total + file.bytes, 0);

  if (diff.trim() === '' && untracked.files.length === 0 && untracked.omissions.length === 0) {
    return {
      ok: false,
      reason:
        '作業ツリーに未コミットの変更がありません（追加資料を「追加資料なし」に変えて実行してください）',
    };
  }

  // 未追跡ファイルで使った分を引いた残りが差分の予算になる。切るのはhunkの境界で、
  // 落としたファイルは理由付きで返る（Issue #926 H）
  const budgeted = applyDiffBudget(diff, Math.max(0, maxDiffBytes - untrackedBytes));
  return {
    ok: true,
    material: { fullDiff: diff, changedPaths },
    snapshot: {
      baseCommit,
      diff: budgeted.diff,
      truncated: budgeted.truncated,
      diffOmissions: budgeted.omissions,
      diffPartials: budgeted.partials,
      untrackedFiles: untracked.files,
      untrackedOmissions: untracked.omissions,
    },
  };
}

/**
 * 未追跡ファイルを取る。
 *
 * `git ls-files` が失敗しても全体は失敗させない。差分だけでもレビューは成立するため、
 * 「未追跡は取れなかった」という状態で先へ進める方が、押した操作が何も返さないより良い。
 */
async function captureUntracked(
  cwd: string,
  git: GitCommandRunner,
  totalBudgetBytes: number,
  reader: UntrackedFileReader | undefined,
): Promise<{
  files: WorkspaceSnapshot['untrackedFiles'];
  omissions: WorkspaceSnapshot['untrackedOmissions'];
}> {
  if (totalBudgetBytes <= 0) {
    return { files: [], omissions: [] };
  }
  // `--exclude-standard` で `.gitignore` は尊重される。ただしこれは秘密情報の境界では
  // ないため、通過したパスの内容は `untracked.ts` の検査を通してからでないと読まない
  const listed = await git.run(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  if (listed.code !== 0) {
    return { files: [], omissions: [] };
  }
  const paths = parseUntrackedList(listed.stdout);
  if (paths.length === 0) {
    return { files: [], omissions: [] };
  }
  return collectUntrackedFiles({
    root: cwd,
    paths,
    totalBudgetBytes,
    reader: reader ?? createNodeUntrackedFileReader(),
  });
}
