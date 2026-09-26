import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { TaskState } from './runState';
import type { GitCommandRunner } from './worktree';

/**
 * 走行中のタスクが触っているファイルの実測と、その交差の判定（Issue #1469、ロードマップH2）。
 *
 * 触るファイルを事前に宣言させる方式は実運用で3回続けて外れた（Issueの背景参照）ため、
 * 交差は実測した集合だけで判定する。`WorkflowTask`の`evidence`等の記述は使わない。
 *
 * このファイルは測定（gitの呼び出し）と純粋な判定だけを持つ。状態遷移・セッションの一時停止・
 * 再開は`runnerOverlap.ts`が担う。
 */

/** `agent.workflows.overlapCheckIntervalSec`の既定値（秒） */
export const DEFAULT_OVERLAP_CHECK_INTERVAL_SEC = 30;

/** 交差で待たせている理由。Viewへそのまま出す。 */
export interface OverlapWait {
  /** 交差した相手（先に走り始めた方）のタスクid */
  readonly withTaskId: string;
  /** 交差したファイル（リポジトリ相対、`/`区切り、昇順） */
  readonly files: readonly string[];
}

/** 判定の入力。1タスク分の実測値。 */
export interface OverlapEntry {
  readonly taskId: string;
  /** 走り始めた順。小さいほど先発 */
  readonly startSeq: number;
  readonly state: TaskState;
  readonly files: ReadonlySet<string>;
}

/**
 * 統合ブランチへまだ入っていない変更を抱えている状態。この状態の先発タスクと交差したら、
 * 後発は待つ。`done`はマージ済み（統合ブランチへ入った）なので含めない。
 */
const HOLDING_STATES: ReadonlySet<TaskState> = new Set([
  'running',
  'waitingApproval',
  'waitingReply',
  'waitingOverlap',
  'merging',
]);

/** 相手がこの状態の間は待機を続ける。外れたら（`done`・`failed`等）待機を解く。 */
export function isOverlapHoldingState(state: TaskState | undefined): boolean {
  return state !== undefined && HOLDING_STATES.has(state);
}

/**
 * 交差の判定から外すパスか。`ignore`の要素は、リポジトリ相対のパスと完全一致するか、
 * `/`で終わる要素ならその配下すべてに一致する（`docs/design.md`のように多くのタスクが
 * 追記するだけのファイルで待機が増えすぎないようにするため。Issueの確認点）。
 */
export function isOverlapIgnored(file: string, ignore: readonly string[]): boolean {
  return ignore.some((entry) =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry,
  );
}

/**
 * 待たせるべき後発タスクと、その理由を返す。
 *
 * - 待たせる対象は`running`のタスクだけ（承認待ち・返信待ちは既に止まっているので触らない）
 * - 相手は、自分より先に走り始め、まだ統合ブランチへ入っていない変更を抱えているタスク
 *   （`isOverlapHoldingState`）。複数あれば最も先に走り始めた相手を理由にする
 * - 開始順で向きが決まるため、互いに待ち合う循環は起きない
 */
export function findOverlapWaits(
  entries: readonly OverlapEntry[],
  ignore: readonly string[],
): ReadonlyMap<string, OverlapWait> {
  const ordered = [...entries].sort((a, b) => a.startSeq - b.startSeq);
  const result = new Map<string, OverlapWait>();
  for (const [index, follower] of ordered.entries()) {
    if (follower.state !== 'running') {
      continue;
    }
    for (const leader of ordered.slice(0, index)) {
      if (!isOverlapHoldingState(leader.state)) {
        continue;
      }
      const files = [...follower.files]
        .filter((file) => leader.files.has(file) && !isOverlapIgnored(file, ignore))
        .sort();
      if (files.length > 0) {
        result.set(follower.taskId, { withTaskId: leader.taskId, files });
        break;
      }
    }
  }
  return result;
}

/** 呼び出し元の環境変数で別のリポジトリを指さないようにする（`runnerRevert.ts`と同じ） */
export const ENV_WITHOUT_REPO_OVERRIDES = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
} as const;

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

/** worktreeの変更の実測値（Issue #1508）。 */
export interface WorktreeChanges {
  /** 変更ファイル（リポジトリ相対）。commit済み・未commit・未追跡のすべてを含む */
  readonly files: ReadonlySet<string>;
  /**
   * 追加行数。未追跡のファイルは全行を追加として数える。バイナリと、
   * `UNTRACKED_LINE_COUNT_MAX_BYTES`を超える未追跡のファイルは数えない
   */
  readonly addedLines: number;
  /** 削除行数。バイナリは数えない */
  readonly deletedLines: number;
}

/** 行数を数える未追跡のファイルの大きさの上限。超えたものは生成物とみなして数えない */
export const UNTRACKED_LINE_COUNT_MAX_BYTES = 1024 * 1024;
/** 行数を数える未追跡のファイルの数の上限。周期ごとに読み直すため、読む量を抑える */
export const UNTRACKED_LINE_COUNT_MAX_FILES = 200;
/** gitと同じく、先頭のこのバイト数にNULを含むファイルをバイナリとみなす */
const BINARY_SNIFF_BYTES = 8000;

/**
 * `git diff --numstat -z --no-renames`の出力を読む。1件は「追加、タブ、削除、タブ、パス、NUL」
 * の形で、バイナリは追加・削除が`-`になる。
 */
export function parseNumstat(stdout: string): {
  files: string[];
  addedLines: number;
  deletedLines: number;
} {
  const files: string[] = [];
  let addedLines = 0;
  let deletedLines = 0;
  for (const entry of splitNul(stdout)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (match === null) {
      continue;
    }
    const [, added, deleted, file] = match;
    if (added === undefined || deleted === undefined || file === undefined) {
      continue;
    }
    files.push(file);
    if (added !== '-') {
      addedLines += Number(added);
    }
    if (deleted !== '-') {
      deletedLines += Number(deleted);
    }
  }
  return { files, addedLines, deletedLines };
}

/** テキストの行数。末尾に改行が無い最終行も1行に数える（`git diff --numstat`と同じ） */
export function countTextLines(content: Uint8Array): number {
  if (content.length === 0) {
    return 0;
  }
  let lines = 0;
  for (const byte of content) {
    if (byte === 0x0a) {
      lines += 1;
    }
  }
  return content[content.length - 1] === 0x0a ? lines : lines + 1;
}

/**
 * 未追跡のファイルの行数を数える。通常のファイルだけを読み、シンボリックリンクは辿らない
 * （worktreeの外を読まないため）。読めないもの・バイナリ・大きすぎるものは数えない。
 */
async function countUntrackedLines(cwd: string, files: readonly string[]): Promise<number> {
  let total = 0;
  for (const file of files.slice(0, UNTRACKED_LINE_COUNT_MAX_FILES)) {
    try {
      const fullPath = path.join(cwd, file);
      const stat = await fs.lstat(fullPath);
      if (!stat.isFile() || stat.size > UNTRACKED_LINE_COUNT_MAX_BYTES) {
        continue;
      }
      const content = await fs.readFile(fullPath);
      if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        continue;
      }
      total += countTextLines(content);
    } catch {
      // 測っている間に消えた等。数えずに進む
    }
  }
  return total;
}

/**
 * gitのworktreeで、分岐元からの変更ファイルと変更行数を実測する。commit済み・未commit・
 * 未追跡のすべてを含む。取れなければ`undefined`（交差の判定・規模の判定に使わない）。
 *
 * `--no-optional-locks`を付けるのは、走行中のエージェントが同じworktreeでgitを使っている
 * ところへ`index.lock`を取りに行かないため。行数は`--numstat`で変更ファイルと同時に取り、
 * gitの呼び出しを増やさない（Issue #1508）。
 */
export async function measureWorktreeChanges(
  git: GitCommandRunner,
  cwd: string,
  originCommit: string,
): Promise<WorktreeChanges | undefined> {
  const options = { env: ENV_WITHOUT_REPO_OVERRIDES };
  try {
    const [tracked, untracked] = await Promise.all([
      git.run(
        ['--no-optional-locks', 'diff', '--numstat', '-z', '--no-renames', originCommit, '--'],
        cwd,
        options,
      ),
      git.run(
        ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z'],
        cwd,
        options,
      ),
    ]);
    if (tracked.code !== 0 || untracked.code !== 0) {
      return undefined;
    }
    const numstat = parseNumstat(tracked.stdout);
    const untrackedFiles = splitNul(untracked.stdout);
    const untrackedLines = await countUntrackedLines(cwd, untrackedFiles);
    return {
      files: new Set([...numstat.files, ...untrackedFiles]),
      addedLines: numstat.addedLines + untrackedLines,
      deletedLines: numstat.deletedLines,
    };
  } catch {
    return undefined;
  }
}
