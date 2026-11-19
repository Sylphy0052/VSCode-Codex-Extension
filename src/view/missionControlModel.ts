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

/** `createRepoResolver`が覚えるcwdの件数の上限。 */
export const REPO_CACHE_MAX_ENTRIES = 256;

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
 * 結果は`cwd`ごとに覚える。覚える件数には上限（`maxEntries`）を設け、超えたら最も長く
 * 使っていないものから捨てる（撤去済みのworktreeのcwdが溜まり続けないようにする）。
 */
export function createRepoResolver(
  fs: RepoFs = nodeRepoFs,
  maxEntries: number = REPO_CACHE_MAX_ENTRIES,
): McRepoResolver {
  const cache = new Map<string, McRepoInfo>();
  return (cwd) => {
    if (cwd === undefined || cwd === '') {
      return UNKNOWN_REPO;
    }
    const cached = cache.get(cwd);
    if (cached !== undefined) {
      // Mapは挿入順を保つ。入れ直して「最近使った」側へ寄せる
      cache.delete(cwd);
      cache.set(cwd, cached);
      return cached;
    }
    const root = findRepoRoot(fs, cwd) ?? cwd;
    const full = normalizeWorkspacePath(root);
    const info: McRepoInfo = { key: full, label: path.basename(full) || full, full };
    cache.set(cwd, info);
    while (cache.size > Math.max(1, maxEntries)) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
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

/** 最終出力を読むのに使う会話の項目（`ChatItem`のうち使う分だけ）。 */
export interface OutputItem {
  kind: string;
  text: string;
  status?: string | undefined;
}

/** `lastOutputLine`が返す1行の上限（`MAX_SHARED_LAST_OUTPUT_CHARS`と同じ値）。 */
const LAST_OUTPUT_CHARS = 200;

/**
 * 会話の最後の出力から1行を取る（Issue #2137の3）。利用者の発言は出力に数えない。
 * 末尾の空でない行を、制御文字を除いて上限まで切り詰めて返す。
 */
export function lastOutputLine(items: readonly OutputItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item === undefined || item.kind === 'userMessage') {
      continue;
    }
    const text = item.text.trimEnd();
    if (text.trim() === '') {
      continue;
    }
    const lastBreak = text.lastIndexOf('\n');
    const line = text
      .slice(lastBreak + 1)
      // eslint-disable-next-line no-control-regex -- 端末の制御文字を一覧へ出さない
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .trim();
    if (line === '') {
      continue;
    }
    return line.length > LAST_OUTPUT_CHARS ? `${line.slice(0, LAST_OUTPUT_CHARS - 1)}…` : line;
  }
  return undefined;
}

/**
 * 出力が動いたかを比べるための指紋。項目の数と、末尾の項目の種類・状態・本文の長さで作る。
 * 本文そのものは持たない（長い本文を覚え続けないため）。
 */
export function outputFingerprint(items: readonly OutputItem[]): string {
  const last = items[items.length - 1];
  if (last === undefined) {
    return '0';
  }
  return `${String(items.length)}|${last.kind}|${last.status ?? ''}|${String(last.text.length)}`;
}

/**
 * 会話ごとに、出力が最後に変わった時刻を覚える（停滞の判定。Issue #2137の5）。
 * 状態が変わるたびに呼ばれる前提で、指紋が前回と違えばその時刻を記録する。
 */
export class LastOutputTracker {
  private readonly seen = new Map<string, { fingerprint: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(key: string, fingerprint: string): number {
    const entry = this.seen.get(key);
    if (entry !== undefined && entry.fingerprint === fingerprint) {
      return entry.at;
    }
    const at = this.now();
    this.seen.set(key, { fingerprint, at });
    return at;
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
  /** 停滞とみなすまでの時間（ms）。設定`agent.missionControl.stallMinutes`から作る。 */
  stallMs: number;
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
      lastOutput: session.lastOutput,
      lastOutputAt: session.lastOutputAt,
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
    stallMs: input.stallMs,
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
