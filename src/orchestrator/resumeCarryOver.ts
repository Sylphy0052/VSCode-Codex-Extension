import { ENV_WITHOUT_REPO_OVERRIDES, measureWorktreeChanges } from './taskOverlap';
import { sanitizeInlineText } from './untrustedText';
import type { GitCommandRunner, WorktreeFileSystemPort } from './worktree';

/**
 * 自動再開の前に、中断した試行のworktreeに残った作業を実測する（Issue #1514、H5b）。
 *
 * リロードで中断したタスクは、今までは試行の添字を進めて新しいworktreeで最初から
 * やり直していた。前の試行に未コミットの変更や進んだコミットが残っていても誰も読まず、
 * 「報告が無い」を「作業が無い」と読んで捨てていた。ここで前の試行の中身を測り、
 * 残っていれば同じworktreeとブランチで続きから進める。
 */

/** 前の試行から引き継ぐ作業の実測値。 */
export interface CarriedOverWork {
  readonly cwd: string;
  readonly branch: string;
  /** 引き継いだworktreeを使う試行の添字。`retrySuffixOf`と同じ値で照合する */
  readonly retry: number | undefined;
  /** 統合ブランチとの分岐点。変更の実測と、以後の交差判定・検証の基準に使う */
  readonly originCommit: string;
  /** `git status --porcelain -z`の件数（`countPorcelainEntries`） */
  readonly uncommittedCount: number;
  /** 統合ブランチから進んだコミット数 */
  readonly commitCount: number;
  /** 分岐点からの変更ファイル（リポジトリ相対、ソート済み） */
  readonly files: readonly string[];
  readonly addedLines: number;
  readonly deletedLines: number;
}

export type CarryOverInspection =
  | { readonly kind: 'carried'; readonly work: CarriedOverWork }
  | { readonly kind: 'nothingLeft' }
  | { readonly kind: 'failed'; readonly message: string };

export interface CarryOverTarget {
  /** 永続化されたタスクのcwd（前の試行のworktree） */
  readonly cwd: string;
  readonly branch: string;
  readonly retry: number | undefined;
  readonly integrationBranch: string;
}

/**
 * 前の試行のworktreeを実測する。worktreeが無い・gitが失敗した場合は`failed`を返し、
 * 呼び出し元は今までどおり新しいworktreeで最初からやり直す。
 */
export async function inspectInterruptedWorktree(
  git: GitCommandRunner,
  fs: Pick<WorktreeFileSystemPort, 'pathExists'>,
  target: CarryOverTarget,
): Promise<CarryOverInspection> {
  const { cwd } = target;
  if (!(await fs.pathExists(cwd))) {
    return { kind: 'failed', message: `前回の作業場所が見つかりません: ${cwd}` };
  }
  const options = { env: ENV_WITHOUT_REPO_OVERRIDES };
  const status = await git.run(['status', '--porcelain', '-z'], cwd, options);
  if (status.code !== 0) {
    return { kind: 'failed', message: gitFailure('git status', status) };
  }
  const uncommittedCount = countPorcelainEntries(status.stdout);
  const revList = await git.run(
    ['rev-list', '--count', `${target.integrationBranch}..HEAD`],
    cwd,
    options,
  );
  const commitCount = Number.parseInt(revList.stdout.trim(), 10);
  if (revList.code !== 0 || !Number.isInteger(commitCount) || commitCount < 0) {
    return { kind: 'failed', message: gitFailure('git rev-list', revList) };
  }
  if (uncommittedCount === 0 && commitCount === 0) {
    return { kind: 'nothingLeft' };
  }
  // 永続化したブランチ名は中断時点の記録にすぎない。worktree側で別のブランチへ切り替えられて
  // いたら、そのまま引き継ぐと別ブランチの作業をこのタスクの成果として統合してしまう
  // （Issue #1521）。detached HEADでは`HEAD`が返り、記録と一致しないので同じく失敗にする
  const head = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, options);
  if (head.code !== 0) {
    return { kind: 'failed', message: gitFailure('git rev-parse', head) };
  }
  const actualBranch = head.stdout.trim();
  if (actualBranch !== target.branch) {
    return {
      kind: 'failed',
      message: `前回の作業場所のブランチが記録と異なります（記録: ${sanitizeInlineText(target.branch, 200)}、実際: ${sanitizeInlineText(actualBranch, 200)}）`,
    };
  }
  const mergeBase = await git.run(['merge-base', 'HEAD', target.integrationBranch], cwd, options);
  const originCommit = mergeBase.stdout.trim();
  if (mergeBase.code !== 0 || originCommit === '') {
    return { kind: 'failed', message: gitFailure('git merge-base', mergeBase) };
  }
  const changes = await measureWorktreeChanges(git, cwd, originCommit);
  if (changes === undefined) {
    return { kind: 'failed', message: '変更ファイルと変更行数を測れませんでした' };
  }
  return {
    kind: 'carried',
    work: {
      cwd,
      branch: target.branch,
      retry: target.retry,
      originCommit,
      uncommittedCount,
      commitCount,
      files: [...changes.files].sort(),
      addedLines: changes.addedLines,
      deletedLines: changes.deletedLines,
    },
  };
}

/**
 * `git status --porcelain -z`の出力から変更の件数を数える（Issue #1521）。改行を含む
 * ファイル名でも1件に数えるためNUL区切りで読む。リネーム・コピー（`R`/`C`）は
 * 「新しいパス」「元のパス」の2要素で1件なので、次の要素を読み飛ばす。
 */
export function countPorcelainEntries(stdout: string): number {
  const fields = stdout.split('\0');
  let count = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? '';
    if (entry === '') {
      continue;
    }
    count++;
    const xy = entry.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) {
      i++;
    }
  }
  return count;
}

function gitFailure(label: string, result: { code: number; stderr: string }): string {
  const stderr = sanitizeInlineText(result.stderr.trim(), 200);
  return stderr === ''
    ? `${label}に失敗しました（終了コード ${result.code}）`
    : `${label}に失敗しました: ${stderr}`;
}

/** 一覧に載せる変更ファイルの上限。超えた分は件数だけ書く */
const MAX_LISTED_FILES = 30;
/** ファイル名1件の長さ上限 */
const MAX_FILE_NAME_LENGTH = 200;

/** 変更の規模を1行で書く（警告・通知・プロンプトで共通）。 */
export function describeCarriedOverWork(work: CarriedOverWork): string {
  return (
    `未コミットの変更${work.uncommittedCount}件、進んだコミット${work.commitCount}件、` +
    `変更ファイル${work.files.length}件（+${work.addedLines} -${work.deletedLines}行）`
  );
}

/**
 * 引き継いだタスクの最初のプロンプトの先頭に添える文。ファイル名はエージェントが作った
 * 名前そのものなので、1行化して長さを切る（改行で偽の指示行を生やせないようにする）。
 * 一覧に載せるのは先頭30件（`MAX_LISTED_FILES`）までで、残りは「ほかN件」と件数だけ書く
 * （大量の変更でプロンプトが膨らまないようにする）。
 */
export function formatCarryOverPromptNote(work: CarriedOverWork): string {
  const listed = work.files
    .slice(0, MAX_LISTED_FILES)
    .map((file) => `- ${sanitizeInlineText(file, MAX_FILE_NAME_LENGTH)}`);
  const rest = work.files.length - listed.length;
  return [
    '前回の中断時点の作業がこの作業場所に残っている。最初から作り直さず、' +
      '`git status` と `git diff` で確かめてから続きを進める。',
    `実測: ${describeCarriedOverWork(work)}`,
    ...(listed.length > 0 ? ['変更ファイル:', ...listed] : []),
    ...(rest > 0 ? [`ほか${rest}件`] : []),
  ].join('\n');
}
