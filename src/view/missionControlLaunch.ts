import { randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  resolveGitCommonDir,
  resolveHeadCommit,
  type GitCommandRunner,
  type WorktreeCreationQueue,
  type WorktreeFileSystemPort,
} from '../orchestrator/worktree';
import type { McLaunchRepo, McLaunchRequest, McProvider } from '../webview/missionControl/protocol';
import type { McRepoResolver } from './missionControlModel';

/**
 * Mission Controlからの新規セッションの起動（Issue #2137の1・2）。vscodeに依らない部分。
 *
 * webviewは信頼境界の外側として扱い、届いた値は形・長さ・実在を確かめてから使う。
 * 会話の起動そのものは既存の`openNew`（`chatView.ts` / `claudeChatView.ts`）に任せる。
 */

/** 最初の指示の上限（文字数）。チャットの入力欄から送れる量と同程度に抑える。 */
export const MAX_LAUNCH_PROMPT_CHARS = 100_000;
/** 起動先の候補の上限。 */
export const MAX_LAUNCH_REPOS = 50;
/** 最近使ったrepoとして覚える件数。 */
export const MAX_RECENT_LAUNCH_REPOS = 10;

/**
 * webviewから届いた起動の要求を確かめる。`cwd`は絶対パスで、NULや改行を含まないものに限る
 * （実在の確認は`launchMissionControlSession`が非同期に行う）。不正なら理由の文を返す。
 */
export function parseLaunchRequest(message: Record<string, unknown>): McLaunchRequest | string {
  const { cwd, provider, prompt, worktree } = message;
  if (typeof cwd !== 'string' || cwd === '' || /[\0\r\n]/u.test(cwd)) {
    return '作業ディレクトリが不正です';
  }
  if (!path.isAbsolute(cwd)) {
    return '作業ディレクトリは絶対パスで指定してください';
  }
  if (provider !== 'codex' && provider !== 'claude') {
    return 'CodexかClaudeを選んでください';
  }
  if (typeof prompt !== 'string') {
    return '最初の指示が不正です';
  }
  if (prompt.length > MAX_LAUNCH_PROMPT_CHARS) {
    return '最初の指示が長すぎます';
  }
  if (typeof worktree !== 'boolean') {
    return 'worktreeの指定が不正です';
  }
  return { cwd: path.resolve(cwd), provider, prompt, worktree };
}

export interface McLaunchDeps {
  git: GitCommandRunner;
  worktreeFs: WorktreeFileSystemPort;
  worktrees: WorktreeCreationQueue;
  /** ディレクトリとして実在するか。 */
  isDirectory(target: string): Promise<boolean>;
  /** `<git-common-dir>/info/exclude`へ1行足す（`.claude/worktrees/`がignoreされていないとき）。 */
  appendExclude(excludeFile: string, line: string): Promise<void>;
  /** 会話を開き、`prompt`が空でなければ最初の指示として送る。開いた会話のidを返す。 */
  open(provider: McProvider, cwd: string, prompt: string): Promise<string | undefined>;
}

export type McLaunchResult =
  { ok: true; cwd: string; threadId: string } | { ok: false; error: string };

export async function launchMissionControlSession(
  request: McLaunchRequest,
  deps: McLaunchDeps,
): Promise<McLaunchResult> {
  if (!(await deps.isDirectory(request.cwd))) {
    return { ok: false, error: '作業ディレクトリが見つかりません' };
  }
  let cwd = request.cwd;
  if (request.worktree) {
    const created = await createSessionWorktree(request.cwd, deps);
    if (!created.ok) {
      return created;
    }
    cwd = created.cwd;
  }
  const threadId = await deps.open(request.provider, cwd, request.prompt);
  if (threadId === undefined) {
    return { ok: false, error: '会話を開けませんでした' };
  }
  return { ok: true, cwd, threadId };
}

/**
 * `cwd`のrepoの本体（worktreeの中で選ばれても本体）の`.claude/worktrees/`配下にworktreeを
 * 作る。作成は`WorktreeCreationQueue`（オーケストレータと同じ入口）を通す。
 */
async function createSessionWorktree(
  cwd: string,
  deps: McLaunchDeps,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const repoRoot = await mainRepoRoot(cwd, deps);
  if (repoRoot === undefined) {
    return { ok: false, error: 'gitのrepoでないため、worktreeを作れません' };
  }
  const headCommit = await resolveHeadCommit(repoRoot, deps.git);
  if (headCommit === undefined) {
    return { ok: false, error: 'HEADのコミットを解決できないため、worktreeを作れません' };
  }
  const created = await deps.worktrees.create(
    {
      repoRoot,
      runId: randomUUID(),
      taskId: `mc-${randomBytes(4).toString('hex')}`,
      headCommit,
      retry: undefined,
      location: 'claude',
    },
    deps.git,
    deps.worktreeFs,
  );
  if (!created.ok) {
    return { ok: false, error: `worktreeを作れませんでした: ${created.message}` };
  }
  await ensureWorktreesIgnored(repoRoot, created.cwd, deps);
  return { ok: true, cwd: created.cwd };
}

/** 本体のrepoのtoplevel。worktreeの中で呼ばれても、`--git-common-dir`の親（本体）を返す。 */
async function mainRepoRoot(cwd: string, deps: McLaunchDeps): Promise<string | undefined> {
  const common = await resolveGitCommonDir(cwd, deps.git, deps.worktreeFs);
  if (common.ok && path.basename(common.value) === '.git') {
    return path.dirname(common.value);
  }
  const top = await deps.git.run(['rev-parse', '--show-toplevel'], cwd);
  const root = top.stdout.trim();
  return top.code === 0 && root !== '' ? root : undefined;
}

/**
 * 作ったworktreeが本体の`git status`に未追跡として出ないよう、ignoreされていなければ
 * `info/exclude`へ足す（`.gitignore`は利用者のrepoの追跡対象なので触らない）。失敗しても
 * worktreeは使えるため、起動は止めない。
 */
async function ensureWorktreesIgnored(
  repoRoot: string,
  worktreeCwd: string,
  deps: McLaunchDeps,
): Promise<void> {
  const check = await deps.git.run(['check-ignore', '-q', worktreeCwd], repoRoot);
  if (check.code === 0) {
    return;
  }
  const common = await resolveGitCommonDir(repoRoot, deps.git, deps.worktreeFs);
  if (!common.ok) {
    return;
  }
  try {
    await deps.appendExclude(path.join(common.value, 'info', 'exclude'), '/.claude/worktrees/');
  } catch {
    // 除外できなくてもworktreeは動く。本体側に未追跡として見えるだけ
  }
}

export interface LaunchRepoSources {
  /** 開いているセッションのcwd（全ウィンドウ）。 */
  sessionCwds: readonly string[];
  /** Mission Controlから最近起動した・選んだパス（新しい順）。 */
  recent: readonly string[];
  /** 履歴に出るセッションのcwd（新しい順）。 */
  historyCwds: readonly string[];
}

/**
 * 起動先の候補を作る。同じrepoはまとめ、最近使ったもの → 開いているセッション → 履歴の
 * 順に並べる。repoの単位は一覧と同じ`resolveRepo`（worktreeは本体へ寄せる）で揃える。
 */
export async function buildLaunchRepos(
  sources: LaunchRepoSources,
  resolveRepo: McRepoResolver,
  isDirectory: (target: string) => Promise<boolean>,
): Promise<McLaunchRepo[]> {
  const repos: McLaunchRepo[] = [];
  const seen = new Set<string>();
  const ordered: Array<[string, McLaunchRepo['source']]> = [
    ...sources.recent.map((cwd): [string, McLaunchRepo['source']] => [cwd, 'recent']),
    ...sources.sessionCwds.map((cwd): [string, McLaunchRepo['source']] => [cwd, 'session']),
    ...sources.historyCwds.map((cwd): [string, McLaunchRepo['source']] => [cwd, 'history']),
  ];
  for (const [cwd, source] of ordered) {
    if (repos.length >= MAX_LAUNCH_REPOS) {
      break;
    }
    if (cwd === '' || !path.isAbsolute(cwd)) {
      continue;
    }
    const info = resolveRepo(cwd);
    if (seen.has(info.key)) {
      continue;
    }
    seen.add(info.key);
    // 撤去済みのworktree・消したrepoは候補に出さない
    if (!(await isDirectory(info.full))) {
      continue;
    }
    repos.push({ path: info.full, key: info.key, label: info.label, source });
  }
  return repos;
}

/** 最近使ったrepoの一覧へ`cwd`を先頭に足す（重複は除き、上限で切る）。 */
export function pushRecentRepo(recent: readonly string[], cwd: string): string[] {
  return [cwd, ...recent.filter((entry) => entry !== cwd)].slice(0, MAX_RECENT_LAUNCH_REPOS);
}

/** globalStateから読んだ最近使ったrepoの一覧を、形を確かめて取り出す。 */
export function readRecentRepos(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((v): v is string => typeof v === 'string' && path.isAbsolute(v))
    .slice(0, MAX_RECENT_LAUNCH_REPOS);
}
