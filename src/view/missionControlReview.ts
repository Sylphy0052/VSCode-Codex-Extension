import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitCommandRunner } from '../orchestrator/worktree';
import type { McActivity, McReview, McReviewFile } from '../webview/missionControl/protocol';

/**
 * Mission Controlのレビュー待ち（Issue #2138の1）。
 *
 * ターンが終わった（待機中の）セッションの作業ツリーに、未commitの変更か`origin/main`からの
 * 差分が残っていれば「レビュー待ち」にする。gitの呼び出しはスナップショットの作成と切り離し、
 * 裏で1件ずつ確かめて結果を覚えておく（スナップショットは状態が変わるたびに作り直すため）。
 * gitへ渡すcwdは、スナップショットに載っている既知のセッションのものだけにする。
 */

/** 1セッションで覚える変更ファイルの上限。超えた分は`truncated`で知らせる。 */
export const REVIEW_MAX_FILES = 200;
/** 待機中のまま変わらないセッションを確かめ直す間隔。 */
export const REVIEW_RECHECK_MS = 30_000;

/** gitで読んだ作業ツリーの変更。 */
export interface WorkingChanges {
  /** gitのtoplevel（絶対パス）。diffのファイルはここからの相対パス。 */
  toplevel: string;
  /** 比較元のコミット（SHA）。 */
  base: string;
  baseLabel: string;
  files: McReviewFile[];
  truncated: boolean;
}

/**
 * `cwd`の作業ツリーの変更を読む。`origin/main`があれば`HEAD`との分岐点、無ければ`HEAD`を
 * 比較元にし、作業ツリー（未commit分を含む）との差分と未追跡のファイルを返す。
 * gitのrepoでない・HEADが無いときは`undefined`。
 */
export async function readWorkingChanges(
  git: GitCommandRunner,
  cwd: string,
): Promise<WorkingChanges | undefined> {
  const top = await git.run(['rev-parse', '--show-toplevel'], cwd);
  const toplevel = top.stdout.trim();
  if (top.code !== 0 || toplevel === '') {
    return undefined;
  }
  const base = await resolveBase(git, toplevel);
  if (base === undefined) {
    return undefined;
  }
  const diff = await git.run(['diff', '--numstat', '-z', '--no-renames', base.sha, '--'], toplevel);
  if (diff.code !== 0) {
    return undefined;
  }
  const untracked = await git.run(['ls-files', '--others', '--exclude-standard', '-z'], toplevel);
  const files = [
    ...parseNumstatZ(diff.stdout),
    ...(untracked.code === 0 ? splitZ(untracked.stdout) : []).map((file): McReviewFile => ({
      path: file,
      untracked: true,
    })),
  ];
  return {
    toplevel,
    base: base.sha,
    baseLabel: base.label,
    files: files.slice(0, REVIEW_MAX_FILES),
    truncated: files.length > REVIEW_MAX_FILES,
  };
}

async function resolveBase(
  git: GitCommandRunner,
  toplevel: string,
): Promise<{ sha: string; label: string } | undefined> {
  const remote = await git.run(
    ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'],
    toplevel,
  );
  if (remote.code === 0) {
    const mergeBase = await git.run(['merge-base', 'HEAD', 'origin/main'], toplevel);
    const sha = mergeBase.stdout.trim();
    if (mergeBase.code === 0 && sha !== '') {
      return { sha, label: 'origin/main' };
    }
  }
  const head = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], toplevel);
  const sha = head.stdout.trim();
  return head.code === 0 && sha !== '' ? { sha, label: 'HEAD' } : undefined;
}

function splitZ(text: string): string[] {
  return text.split('\0').filter((part) => part !== '');
}

/** `git diff --numstat -z --no-renames`の出力（`<追加>\t<削除>\t<パス>\0`の並び）を読む。 */
export function parseNumstatZ(text: string): McReviewFile[] {
  const files: McReviewFile[] = [];
  for (const record of splitZ(text)) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/su.exec(record);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      continue;
    }
    files.push({
      path: match[3],
      added: match[1] === '-' ? undefined : Number(match[1]),
      deleted: match[2] === '-' ? undefined : Number(match[2]),
      untracked: false,
    });
  }
  return files;
}

/** 画面へ出す形にまとめる。 */
export function toMcReview(changes: WorkingChanges): McReview {
  return {
    baseLabel: changes.baseLabel,
    files: changes.files,
    added: changes.files.reduce((sum, f) => sum + (f.added ?? 0), 0),
    deleted: changes.files.reduce((sum, f) => sum + (f.deleted ?? 0), 0),
    truncated: changes.truncated,
  };
}

/** 変更の指紋。「確認済み」の後に変更が増えたら、もう一度レビュー待ちに出す。 */
export function reviewFingerprint(changes: WorkingChanges): string {
  return JSON.stringify([changes.base, changes.files, changes.truncated]);
}

export interface ReviewSessionInput {
  key: string;
  cwd: string | undefined;
  activity: McActivity;
}

interface ReviewEntry {
  cwd: string;
  activity: McActivity;
  checkedAt: number;
  changes: WorkingChanges | undefined;
  fingerprint: string | undefined;
  /** 「確認済み」にしたときの指紋。 */
  acknowledged: string | undefined;
}

/**
 * セッションごとのレビュー待ちを覚える。`observe`はスナップショットを作るたびに呼ばれ、
 * 手元の結果をすぐ返す。確かめ直しが要るセッションは裏の列へ積み、結果が変わったら
 * `onChange`で画面の更新を頼む。
 */
export class ReviewTracker {
  private readonly entries = new Map<string, ReviewEntry>();
  private readonly queue: string[] = [];
  private running = false;
  private disposed = false;

  constructor(
    private readonly git: GitCommandRunner,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  observe(sessions: readonly ReviewSessionInput[]): Map<string, McReview> {
    const reviews = new Map<string, McReview>();
    const keys = new Set<string>();
    for (const session of sessions) {
      keys.add(session.key);
      if (session.cwd === undefined || session.cwd === '') {
        continue;
      }
      const entry = this.entries.get(session.key);
      if (entry === undefined || entry.cwd !== session.cwd) {
        this.entries.set(session.key, {
          cwd: session.cwd,
          activity: session.activity,
          checkedAt: 0,
          changes: undefined,
          fingerprint: undefined,
          acknowledged: undefined,
        });
        if (session.activity === 'idle') {
          this.enqueue(session.key);
        }
        continue;
      }
      const finished = entry.activity !== 'idle' && session.activity === 'idle';
      entry.activity = session.activity;
      if (session.activity !== 'idle') {
        continue;
      }
      if (finished || this.now() - entry.checkedAt >= REVIEW_RECHECK_MS) {
        this.enqueue(session.key);
      }
      const review = this.pendingReview(entry);
      if (review !== undefined) {
        reviews.set(session.key, review);
      }
    }
    for (const key of [...this.entries.keys()]) {
      if (!keys.has(key)) {
        this.entries.delete(key);
      }
    }
    return reviews;
  }

  /** 「確認済み」にする。レビュー待ちでなければ`false`。 */
  acknowledge(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined || this.pendingReview(entry) === undefined) {
      return false;
    }
    entry.acknowledged = entry.fingerprint;
    return true;
  }

  /**
   * diffを開くのに要る値。レビュー待ちの一覧に載っているファイルだけを返し、それ以外の
   * パスは`undefined`にする（画面から任意のパスを読ませない）。
   */
  diffSource(
    key: string,
    file: string,
  ): { toplevel: string; base: string; file: McReviewFile } | undefined {
    const changes = this.entries.get(key)?.changes;
    const found = changes?.files.find((f) => f.path === file);
    if (changes === undefined || found === undefined) {
      return undefined;
    }
    const absolute = path.resolve(changes.toplevel, found.path);
    const relative = path.relative(changes.toplevel, absolute);
    // `..foo`のようなtoplevel内のファイル名は通し、上の階層へ出るものだけを断る
    const escapes = relative === '..' || relative.startsWith(`..${path.sep}`);
    if (relative === '' || escapes || path.isAbsolute(relative)) {
      return undefined;
    }
    // symlinkでtoplevelの外へ出るファイルは開かない（実体のパスで確かめる）
    if (!staysInside(changes.toplevel, absolute)) {
      return undefined;
    }
    return { toplevel: changes.toplevel, base: changes.base, file: found };
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private pendingReview(entry: ReviewEntry): McReview | undefined {
    if (
      entry.activity !== 'idle' ||
      entry.changes === undefined ||
      entry.changes.files.length === 0 ||
      entry.fingerprint === entry.acknowledged
    ) {
      return undefined;
    }
    return toMcReview(entry.changes);
  }

  private enqueue(key: string): void {
    if (this.queue.includes(key)) {
      return;
    }
    this.queue.push(key);
    void this.drain();
  }

  /** 列を1件ずつ処理する（多数のセッションでgitを同時に走らせない）。 */
  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (let key = this.queue.shift(); key !== undefined; key = this.queue.shift()) {
        const entry = this.entries.get(key);
        if (entry === undefined || this.disposed) {
          continue;
        }
        // gitが一時的に失敗したときは、直前の結果を消さず次の確認まで持ち越す
        let changes: WorkingChanges | undefined;
        let failed = false;
        try {
          changes = await readWorkingChanges(this.git, entry.cwd);
        } catch {
          failed = true;
        }
        // 確かめている間に外された・cwdが変わったセッションの結果は捨てる
        if (this.disposed || this.entries.get(key) !== entry) {
          continue;
        }
        entry.checkedAt = this.now();
        // 読めなかった（例外、またはgitの非0終了）ときも、前の結果があれば残す
        if (failed || (changes === undefined && entry.changes !== undefined)) {
          continue;
        }
        const before = entry.fingerprint;
        entry.changes = changes;
        entry.fingerprint = changes === undefined ? undefined : reviewFingerprint(changes);
        if (before !== entry.fingerprint) {
          try {
            this.onChange();
          } catch {
            // 画面側の例外で列を止めない
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** `target`の実体が`root`の実体の配下にあるか。消えたファイルは、残っている親の実体で見る。 */
function staysInside(root: string, target: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    let probe = target;
    for (;;) {
      try {
        const real = fs.realpathSync(probe);
        const relative = path.relative(realRoot, real);
        return (
          relative === '' ||
          !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return false;
        }
        const parent = path.dirname(probe);
        if (parent === probe) {
          return false;
        }
        probe = parent;
      }
    }
  } catch {
    return false;
  }
}
