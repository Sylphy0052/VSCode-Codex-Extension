import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { formatSessionTarget } from '../orchestrator/sessionBridge';
import { normalizeWorkspacePath } from '../util/paths';
import type {
  McActivity,
  McPendingItem,
  McRepo,
  McSession,
  McSnapshot,
} from '../webview/missionControl/protocol';
import type { PendingItem } from './pendingItem';
import type { SharedSession } from './sessionHub';

/**
 * Mission Control（Issue #2136）の画面へ送るスナップショットを、全ウィンドウのセッションと
 * 待ち項目から組み立てる。vscodeに依らない部分だけを置き、単体テストから直接呼ぶ。
 */

export interface McSessionInput extends SharedSession {
  windowId: string;
}

export interface McRepoInfo {
  key: string;
  label: string;
  full: string;
}

export type McRepoResolver = (cwd: string | undefined) => McRepoInfo;

const UNKNOWN_REPO: McRepoInfo = { key: '(unknown)', label: '(不明)', full: '(不明)' };

interface RepoFs {
  /** `.git`がディレクトリなら`'dir'`、ファイルなら`'file'`、無ければ`undefined`。 */
  gitEntry(dir: string): 'dir' | 'file' | undefined;
  readText(file: string): string | undefined;
}

const nodeRepoFs: RepoFs = {
  gitEntry(dir) {
    try {
      const stat = statSync(path.join(dir, '.git'));
      return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
    } catch {
      return undefined;
    }
  },
  readText(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/**
 * `cwd`からgitのtoplevelを探し、repoの単位を返す。
 *
 * worktree（`.git`がファイルで`gitdir: <main>/.git/worktrees/<name>`を指す）は、元のrepoへ
 * まとめる。オーケストレータのtask runはrepo内のworktreeで動くため、toplevelのままだと
 * 同じrepoのセッションがworktreeの数だけ別のrepoに分かれる。
 *
 * gitを起動せず`.git`を辿るだけにする（スナップショットは状態が変わるたびに作り直すため）。
 * 結果は`cwd`ごとに覚える。
 */
export function createRepoResolver(fs: RepoFs = nodeRepoFs): McRepoResolver {
  const cache = new Map<string, McRepoInfo>();
  return (cwd) => {
    if (cwd === undefined || cwd === '') {
      return UNKNOWN_REPO;
    }
    const cached = cache.get(cwd);
    if (cached !== undefined) {
      return cached;
    }
    const root = findRepoRoot(fs, cwd) ?? cwd;
    const full = normalizeWorkspacePath(root);
    const info: McRepoInfo = { key: full, label: path.basename(full) || full, full };
    cache.set(cwd, info);
    return info;
  };
}

function findRepoRoot(fs: RepoFs, cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const entry = fs.gitEntry(dir);
    if (entry === 'dir') {
      return dir;
    }
    if (entry === 'file') {
      return mainRepoOfWorktree(fs, dir) ?? dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function mainRepoOfWorktree(fs: RepoFs, dir: string): string | undefined {
  const text = fs.readText(path.join(dir, '.git'));
  const match = /^gitdir:\s*(.+)$/mu.exec(text ?? '');
  if (match?.[1] === undefined) {
    return undefined;
  }
  const gitdir = path.resolve(dir, match[1].trim());
  // `<main>/.git/worktrees/<name>`の形だけを元のrepoへ寄せる。submodule等はそのまま
  const worktrees = path.dirname(gitdir);
  if (path.basename(worktrees) !== 'worktrees') {
    return undefined;
  }
  const mainGitDir = path.dirname(worktrees);
  return path.basename(mainGitDir) === '.git' ? path.dirname(mainGitDir) : undefined;
}

/**
 * セッションが今の状態になった時刻を覚える（経過時間の表示用）。共有ファイルには状態の
 * 変化時刻が無いため、拡張ホストが最初にその状態を見た時刻で代える。
 */
export class ActivitySince {
  private readonly seen = new Map<string, { activity: McActivity; since: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  stamp(key: string, activity: McActivity): number {
    const entry = this.seen.get(key);
    if (entry !== undefined && entry.activity === activity) {
      return entry.since;
    }
    const since = this.now();
    this.seen.set(key, { activity, since });
    return since;
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.seen.keys()]) {
      if (!keys.has(key)) {
        this.seen.delete(key);
      }
    }
  }
}

export interface McSnapshotInput {
  sessions: readonly McSessionInput[];
  /** 会話に属さない待ち項目（task runの質問）。全ウィンドウ分。 */
  windowPending: readonly PendingItem[];
  currentWindowId: string;
  resolveRepo: McRepoResolver;
  activitySince: ActivitySince;
  now: number;
}

export function buildMissionControlSnapshot(input: McSnapshotInput): McSnapshot {
  const repos = new Map<string, McRepo>();
  const touchRepo = (cwd: string | undefined): McRepo => {
    const info = input.resolveRepo(cwd);
    const existing = repos.get(info.key);
    if (existing !== undefined) {
      return existing;
    }
    const repo: McRepo = { ...info, sessionCount: 0, pendingCount: 0 };
    repos.set(info.key, repo);
    return repo;
  };
  const sessions: McSession[] = [];
  const pending: McPendingItem[] = [];
  const seenPending = new Set<string>();
  const addPending = (item: PendingItem): void => {
    // 同じ項目が2つの経路で届いても1行にする（idは項目ごとに一意）
    if (seenPending.has(item.id)) {
      return;
    }
    seenPending.add(item.id);
    const repo = touchRepo(item.cwd);
    repo.pendingCount += 1;
    pending.push(toMcPending(item, repo.key, input.currentWindowId));
  };
  for (const session of input.sessions) {
    const repo = touchRepo(session.cwd);
    repo.sessionCount += 1;
    const key = formatSessionTarget({
      windowId: session.windowId,
      provider: session.provider,
      threadId: session.threadId,
    });
    const items = session.pending ?? [];
    sessions.push({
      key,
      windowId: session.windowId,
      threadId: session.threadId,
      provider: session.provider,
      isCurrentWindow: session.windowId === input.currentWindowId,
      repoKey: repo.key,
      title: session.title,
      activity: session.activity,
      activitySince: input.activitySince.stamp(key, session.activity),
      cwdLabel: session.cwd === undefined ? '(不明)' : path.basename(session.cwd),
      cwdFull: session.cwd === undefined ? '(不明)' : normalizeWorkspacePath(session.cwd),
      loop: session.loop,
      pendingCount: items.length,
    });
    for (const item of items) {
      addPending(item);
    }
  }
  for (const item of input.windowPending) {
    addPending(item);
  }
  input.activitySince.retain(new Set(sessions.map((s) => s.key)));
  pending.sort((a, b) => a.createdAt - b.createdAt);
  const repoList = [...repos.values()].sort(
    (a, b) => b.pendingCount - a.pendingCount || a.label.localeCompare(b.label),
  );
  return {
    now: input.now,
    windowId: input.currentWindowId,
    repos: repoList,
    sessions,
    pending,
  };
}

function toMcPending(item: PendingItem, repoKey: string, currentWindowId: string): McPendingItem {
  return {
    id: item.id,
    kind: item.kind,
    windowId: item.session.windowId,
    threadId: item.session.threadId,
    provider: item.session.provider,
    isCurrentWindow: item.session.windowId === currentWindowId,
    repoKey,
    title: item.title,
    summary: item.payload.summary,
    createdAt: item.createdAt,
    answer: item.answer,
    requestId: item.payload.requestId,
    options: item.payload.options,
  };
}

/** タブ名（Issue #2136の6）。要対応の件数を「MC (N)」の形で付ける。 */
export function missionControlTitle(pendingCount: number): string {
  return `MC (${String(pendingCount)})`;
}
