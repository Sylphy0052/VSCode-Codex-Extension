import {
  checkForgePrerequisites,
  createPullRequest,
  createIssue,
  detectForgeHost,
  fetchCiConclusion,
  fetchPullRequestStatus,
  fetchReviewThreads,
  parsePullRequestNumberFromUrl,
  postIssueComment,
  pushBranch,
  replyToReviewThread,
  resolveReviewThread,
  type CliAvailabilityPort,
  type CliCommandRunner,
  type ForgeFileSystemPort,
  type ForgeHost,
} from '../orchestrator/forge';
import { createCliIssueListPort, type RoadmapIssueSummary } from '../orchestrator/roadmap';
import {
  resolveHeadCommit,
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../orchestrator/worktree';
import { randomUUID } from 'node:crypto';
import type { MementoLike } from '../util/memento';

export const FORGE_WORK_ITEMS_KEY = 'agent.forge.workItems.v1';
export const FORGE_PLANNED_ISSUES_KEY = 'agent.forge.plannedIssues.v1';

/** Forge Hubが扱う、Codex / Claude Code共通の会話起点。 */
export type ForgeHubProvider = 'codex' | 'claude';

/** 3部構成Issueの入力。本文の組み立てをWebviewから分離する。 */
export interface ForgeIssueDraft {
  title: string;
  currentState: string;
  overview: string;
  implementation: string;
  verification: string;
  labels?: string;
  assignees?: string;
  milestone?: string;
}

/** GitHub/GitLabどちらにも送れる、標準Issue本文を組み立てる。 */
export function buildForgeIssueBody(draft: ForgeIssueDraft): string {
  return [
    '## 着手前の現状',
    '',
    draft.currentState.trim() || '（未記入）',
    '',
    '## 非エンジニア向け概要',
    '',
    draft.overview.trim() || '（未記入）',
    '',
    '## エンジニア向け仕様・実装計画',
    '',
    draft.implementation.trim() || '（未記入）',
    '',
    '## 確認者向け確認点',
    '',
    draft.verification.trim() || '（未記入）',
  ].join('\n');
}

export interface ForgeHubSnapshot {
  provider: ForgeHubProvider;
  cwd: string;
  remoteUrl: string | undefined;
  host: ForgeHost | undefined;
  hostMessage: string | undefined;
  prerequisites:
    | {
        hasOriginRemote: boolean;
        cliOnPath: boolean;
        authenticated: boolean;
        ready: boolean;
        warnings: readonly string[];
      }
    | undefined;
}

export interface ForgeHubDeps {
  git: GitCommandRunner;
  cli: CliCommandRunner;
  cliAvailability: CliAvailabilityPort;
  fs: ForgeFileSystemPort;
  worktreeFs: WorktreeFileSystemPort;
  memento: MementoLike;
}

/** Forge Hubが追跡する開発カード。MR/CI連携を追加しても同じIDを使う。 */
export interface ForgeWorkItem {
  issue: RoadmapIssueSummary;
  host: ForgeHost;
  provider: ForgeHubProvider;
  cwd: string;
  branch: string;
  sessionId: string;
  status: 'inProgress' | 'review' | 'ciPending' | 'ci' | 'cleanup' | 'blocked';
  startedAt: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  ciMessage?: string;
  reviewCommentCount?: number;
  reviewMessage?: string;
  reviewComments?: ReadonlyArray<{
    id: string;
    author: string;
    body: string;
    threadId?: string;
    resolved?: boolean;
  }>;
  mergeable?: boolean;
  approvalsLeft?: number;
  pullRequestState?: 'open' | 'merged' | 'closed' | 'unknown';
  pullRequestMessage?: string;
  /** 作業会話から得た実行状態。リモートのCI/レビューとは混ぜない。 */
  sessionBusy?: boolean;
  sessionFailed?: boolean;
  /** 画面が次に提示する操作。 */
  nextAction?: string;
  updatedAt: string;
}

export interface ForgePlannedIssue {
  number: number;
  plannedAt: string;
}

/**
 * リモート状態の取り込み結果（Issue #1029）。
 *
 * 失敗を`reason`で分けるのは、取得そのものに失敗した`error`と、書き戻す先のカードが
 * 既に無い`gone`とで、画面に出すべき文言が違うため。`gone`はcleanup完了で追跡対象から
 * 外した直後に起きる正常な結末なので、赤いエラーとして見せない。
 */
export type ForgeRefreshResult =
  { ok: true } | { ok: false; reason: 'gone' | 'error'; message: string };

/** `gh` / `glab`への操作をWebviewから切り離す。最初は診断とIssue作成を担当する。 */
export class ForgeHubService {
  private readonly worktrees = new WorktreeCreationQueue();
  private readonly workItems = new Map<string, ForgeWorkItem>();
  private readonly plannedIssues = new Map<number, ForgePlannedIssue>();

  constructor(private readonly deps: ForgeHubDeps) {
    for (const item of deps.memento.get<ForgeWorkItem[]>(FORGE_WORK_ITEMS_KEY, [])) {
      // 以前の版が保存したカードは、マージ済みでもstatusが上書きされたまま残っていることがある
      // （Issue #1029）。書き戻しのときだけ正規化していると、リモート取得が失敗し続ける間は
      // ずっとcleanup列へ移らない。読み込んだ時点で揃えておく。
      if (isForgeWorkItem(item))
        this.workItems.set(item.branch, enforceTerminalPrInvariant(item, item));
    }
    for (const planned of deps.memento.get<ForgePlannedIssue[]>(FORGE_PLANNED_ISSUES_KEY, [])) {
      if (
        Number.isSafeInteger(planned.number) &&
        planned.number > 0 &&
        typeof planned.plannedAt === 'string'
      ) {
        this.plannedIssues.set(planned.number, planned);
      }
    }
  }

  async inspect(
    provider: ForgeHubProvider,
    cwd: string,
    hostOverride?: ForgeHost,
  ): Promise<ForgeHubSnapshot> {
    const remote = await this.deps.git.run(['remote', 'get-url', 'origin'], cwd);
    const remoteUrl =
      remote.code === 0 && remote.stdout.trim() !== '' ? remote.stdout.trim() : undefined;
    const host = hostOverride ?? (remoteUrl === undefined ? undefined : detectForgeHost(remoteUrl));
    if (host === undefined) {
      return {
        provider,
        cwd,
        remoteUrl,
        host,
        hostMessage:
          remoteUrl === undefined
            ? 'origin remoteが見つからないため、GitHub/GitLabを自動判定できません。'
            : 'origin URLからGitHub/GitLabを自動判定できません。',
        prerequisites: undefined,
      };
    }
    const prerequisites = await checkForgePrerequisites(this.deps, cwd, host);
    return { provider, cwd, remoteUrl, host, hostMessage: undefined, prerequisites };
  }

  async createIssue(
    snapshot: ForgeHubSnapshot,
    draft: ForgeIssueDraft,
  ): Promise<{ ok: true; url: string | undefined } | { ok: false; message: string }> {
    if (snapshot.host === undefined) {
      return { ok: false, message: 'GitHub/GitLabを自動判定できないため、Issueを作成できません。' };
    }
    if (snapshot.prerequisites?.ready !== true) {
      return {
        ok: false,
        message: 'CLIの導入・認証・origin remoteを確認してからIssueを作成してください。',
      };
    }
    if (draft.currentState.trim() === '') {
      return { ok: false, message: '「着手前の現状」は必須です。' };
    }
    const result = await createIssue(this.deps, {
      host: snapshot.host,
      cwd: snapshot.cwd,
      title: draft.title,
      body: buildForgeIssueBody(draft),
      ...(draft.labels === undefined ? {} : { labels: draft.labels }),
      ...(draft.assignees === undefined ? {} : { assignees: draft.assignees }),
      ...(draft.milestone === undefined ? {} : { milestone: draft.milestone }),
    });
    return result.ok ? result : { ok: false, message: result.message };
  }

  /** 既存Issueへ実装計画を追記する。本文を置換せず、時系列で監査できるコメントとして残す。 */
  async postIssuePlan(
    snapshot: ForgeHubSnapshot,
    issue: RoadmapIssueSummary,
    plan: string,
  ): Promise<{ ok: true; url: string | undefined } | { ok: false; message: string }> {
    if (snapshot.host === undefined || snapshot.prerequisites?.ready !== true) {
      return {
        ok: false,
        message: 'CLIの導入・認証・origin remoteを確認してから計画を反映してください。',
      };
    }
    if (plan.trim() === '') return { ok: false, message: '実装計画を入力してください。' };
    const result = await postIssueComment(
      { cli: this.deps.cli, fs: this.deps.fs },
      {
        host: snapshot.host,
        cwd: snapshot.cwd,
        number: issue.number,
        body: ['## 実装計画', '', plan.trim()].join('\n'),
      },
    );
    if (!result.ok) return { ok: false, message: result.message };
    this.plannedIssues.set(issue.number, {
      number: issue.number,
      plannedAt: new Date().toISOString(),
    });
    await this.deps.memento.update(FORGE_PLANNED_ISSUES_KEY, [...this.plannedIssues.values()]);
    return result;
  }

  async listIssues(snapshot: ForgeHubSnapshot): Promise<readonly RoadmapIssueSummary[]> {
    if (snapshot.prerequisites?.ready !== true) return [];
    return (
      (await createCliIssueListPort(this.deps.git, this.deps.cli).listIssues(snapshot.cwd)) ?? []
    );
  }

  /** 選択Issue専用の隔離worktreeを作る。会話の起動はVSCode依存なのでView側が担う。 */
  async createIssueWorktree(
    snapshot: ForgeHubSnapshot,
    issue: RoadmapIssueSummary,
  ): Promise<{ ok: true; cwd: string; branch: string } | { ok: false; message: string }> {
    if (snapshot.prerequisites?.ready !== true) {
      return {
        ok: false,
        message: 'CLIの導入・認証・origin remoteを確認してから着手してください。',
      };
    }
    const root = await this.deps.git.run(['rev-parse', '--show-toplevel'], snapshot.cwd);
    const repoRoot = root.code === 0 ? root.stdout.trim() : '';
    const headCommit =
      repoRoot === '' ? undefined : await resolveHeadCommit(repoRoot, this.deps.git);
    if (repoRoot === '' || headCommit === undefined) {
      return {
        ok: false,
        message: 'gitリポジトリのルートまたはHEADコミットを解決できませんでした。',
      };
    }
    const created = await this.worktrees.create(
      {
        repoRoot,
        runId: randomUUID(),
        taskId: `issue-${issue.number}`,
        headCommit,
        retry: undefined,
      },
      this.deps.git,
      this.deps.worktreeFs,
    );
    return created.ok ? created : { ok: false, message: created.message };
  }

  async recordStartedWork(
    snapshot: ForgeHubSnapshot,
    issue: RoadmapIssueSummary,
    worktree: { cwd: string; branch: string },
    sessionId: string,
  ): Promise<void> {
    if (snapshot.host === undefined) return;
    const item: ForgeWorkItem = {
      issue,
      host: snapshot.host,
      provider: snapshot.provider,
      cwd: worktree.cwd,
      branch: worktree.branch,
      sessionId,
      status: 'inProgress',
      sessionBusy: true,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextAction: '実装を続ける',
    };
    this.workItems.set(worktree.branch, item);
    this.plannedIssues.delete(issue.number);
    await this.deps.memento.update(FORGE_WORK_ITEMS_KEY, this.listWorkItems());
    await this.deps.memento.update(FORGE_PLANNED_ISSUES_KEY, [...this.plannedIssues.values()]);
  }

  listWorkItems(): readonly ForgeWorkItem[] {
    return [...this.workItems.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listPlannedIssues(
    issues: readonly RoadmapIssueSummary[],
  ): readonly (ForgePlannedIssue & { issue: RoadmapIssueSummary })[] {
    return issues
      .flatMap((issue) => {
        const planned = this.plannedIssues.get(issue.number);
        return planned === undefined ? [] : [{ ...planned, issue }];
      })
      .sort((a, b) => b.plannedAt.localeCompare(a.plannedAt));
  }

  /**
   * cleanup済みであることを利用者が確認したカードだけ、Hubの追跡対象から外す。
   *
   * 判定に`status`ではなく`pullRequestState`を使う（Issue #1029）。`status`はCIやレビューの
   * 取得結果を含む派生値で、確認ダイアログを表示している間にも背景同期で動きうる。カードを
   * 外してよい根拠は「PR/MRがマージ済みであること」そのものなので、そちらを直接検証する。
   */
  async completeCleanup(branch: string): Promise<ForgeRefreshResult> {
    const item = this.workItems.get(branch);
    if (item === undefined) return goneResult;
    if (item.pullRequestState !== 'merged') {
      return {
        ok: false,
        reason: 'error',
        message: 'マージ済み・cleanup待ちのカードだけ完了にできます。',
      };
    }
    this.workItems.delete(branch);
    await this.deps.memento.update(FORGE_WORK_ITEMS_KEY, this.listWorkItems());
    return { ok: true };
  }

  /**
   * CLI取得の完了後に、**その時点の**カードへ結果を反映する（Issue #1029）。
   *
   * CLI実行前に読んだカードをそのまま書き戻すと、待っている間にcleanup完了で消えたカードが
   * 古い内容で復活する。書き戻す直前に読み直し、消えていれば何もしない。
   *
   * `mutate`は同期関数に限る。`enforceTerminalPrInvariant`から`workItems.set`までの間に
   * `await`が入ると、そこで別の更新が割り込んで同じ取り違えが起きる。
   */
  private async applyRemoteUpdate(
    branch: string,
    expectedPullRequestNumber: number | undefined,
    mutate: (current: ForgeWorkItem) => ForgeWorkItem,
  ): Promise<'applied' | 'gone' | 'superseded'> {
    const current = this.workItems.get(branch);
    if (current === undefined) return 'gone';
    // 取得中にPR/MRが差し替わったカードへ、前のPR/MRの結果を書かない。マージ済みの単調性は
    // 「同じPR/MR番号のライフサイクル」を前提にしているため、番号が変われば前提が崩れる。
    if (current.pullRequestNumber !== expectedPullRequestNumber) return 'superseded';
    const normalized = enforceTerminalPrInvariant(current, mutate(current));
    this.workItems.set(branch, { ...normalized, nextAction: deriveNextAction(normalized) });
    await this.deps.memento.update(FORGE_WORK_ITEMS_KEY, this.listWorkItems());
    return 'applied';
  }

  async refreshRemoteStates(): Promise<void> {
    for (const item of this.listWorkItems()) {
      if (item.pullRequestNumber === undefined) await this.discoverPullRequest(item.branch);
      if (this.workItems.get(item.branch)?.pullRequestNumber === undefined) continue;
      // 両メソッドは同じカードを読み直して丸ごと永続化する。並列化すると後着の書き込みが
      // 先着のPR状態またはレビュー状態を消してしまうため、カード内だけは直列にする。
      await this.refreshPullRequestStatus(item.branch);
      await this.refreshReview(item.branch);
      await this.refreshCi(item.branch);
    }
  }

  /** 作業会話の状態はローカルの進捗信号として即座に保存する。 */
  async recordSessionState(
    sessionId: string,
    state: { busy: boolean; failed: boolean },
  ): Promise<void> {
    const item = this.listWorkItems().find((candidate) => candidate.sessionId === sessionId);
    if (item === undefined) return;
    this.workItems.set(item.branch, {
      ...item,
      sessionBusy: state.busy,
      sessionFailed: state.failed,
      nextAction: deriveNextAction({
        ...item,
        sessionBusy: state.busy,
        sessionFailed: state.failed,
      }),
      updatedAt: new Date().toISOString(),
    });
    await this.deps.memento.update(FORGE_WORK_ITEMS_KEY, this.listWorkItems());
  }

  private async discoverPullRequest(branch: string): Promise<void> {
    const item = this.workItems.get(branch);
    if (item === undefined || item.pullRequestNumber !== undefined) return;
    const result =
      item.host === 'github'
        ? await this.deps.cli.run('gh', ['pr', 'view', branch, '--json=number,url'], item.cwd)
        : await this.deps.cli.run(
            'glab',
            ['mr', 'list', '--source-branch', branch, '--output', 'json'],
            item.cwd,
          );
    if (result.code !== 0 || result.stdout.trim() === '') return;
    const found = parseDiscoveredPullRequest(item.host, result.stdout);
    if (found === undefined) return;
    // 取得の待ち時間に会話状態などが更新されていることがある。入口で読んだカードをそのまま
    // 書き戻すとその更新が消えるため、書き戻す直前のカードへ番号だけを乗せる。
    // 入口では番号が無いことを確認済み。別経路が先に番号を入れていたら、こちらは書かない。
    await this.applyRemoteUpdate(branch, undefined, (current) => ({
      ...current,
      pullRequestNumber: found.number,
      ...(found.url === undefined ? {} : { pullRequestUrl: found.url }),
      status: 'review',
      updatedAt: new Date().toISOString(),
    }));
  }

  async createDraftPullRequest(
    branch: string,
  ): Promise<{ ok: true; url: string | undefined } | { ok: false; message: string }> {
    const item = this.workItems.get(branch);
    if (item === undefined) return { ok: false, message: '対象のForge作業が見つかりません。' };
    const dirty = await this.deps.git.run(['status', '--porcelain'], item.cwd);
    if (dirty.code !== 0 || dirty.stdout.trim() !== '')
      return { ok: false, message: '未commit変更があるため、PR/MRを作成できません。' };
    const pushed = await pushBranch(this.deps.git, item.cwd, item.branch);
    if (!pushed.ok) return { ok: false, message: pushed.message };
    const base = await this.deps.git.run(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      item.cwd,
    );
    const target = base.code === 0 ? base.stdout.trim().replace(/^origin\//u, '') : 'main';
    const created = await createPullRequest(
      { cli: this.deps.cli, fs: this.deps.fs },
      {
        host: item.host,
        cwd: item.cwd,
        base: target,
        head: item.branch,
        title: `#${item.issue.number} ${item.issue.title}`,
        body: `Closes #${item.issue.number}`,
        draft: true,
      },
    );
    if (!created.ok) return { ok: false, message: created.message };
    const number =
      created.url === undefined ? undefined : parsePullRequestNumberFromUrl(created.url);
    // push・PR/MR作成の間に会話状態などが更新されていることがある。入口で読んだカードを
    // そのまま書き戻すとその更新が消えるため、書き戻す直前のカードへ結果だけを乗せる。
    // 書き戻せなくてもPR/MRの作成自体は成功しているので、URLは返す。
    await this.applyRemoteUpdate(branch, item.pullRequestNumber, (current) => ({
      ...current,
      status: 'review' as const,
      ...(created.url === undefined ? {} : { pullRequestUrl: created.url }),
      ...(number === undefined ? {} : { pullRequestNumber: number }),
      updatedAt: new Date().toISOString(),
    }));
    return { ok: true, url: created.url };
  }

  async refreshCi(branch: string): Promise<ForgeRefreshResult> {
    const item = this.workItems.get(branch);
    if (item?.pullRequestNumber === undefined) {
      return { ok: false, reason: 'error', message: 'PR/MR番号がないためCIを取得できません。' };
    }
    const ci = await fetchCiConclusion(this.deps.cli, item.host, item.cwd, item.pullRequestNumber);
    const status: ForgeWorkItem['status'] =
      ci.conclusion === 'failed' ? 'blocked' : ci.conclusion === 'passed' ? 'ci' : 'ciPending';
    const applied = await this.applyRemoteUpdate(branch, item.pullRequestNumber, (current) => {
      const base = { ...current };
      delete base.ciMessage;
      return {
        ...base,
        status,
        ...(ci.message === undefined ? {} : { ciMessage: ci.message }),
        updatedAt: new Date().toISOString(),
      };
    });
    return applied === 'applied' ? { ok: true } : discardedResult(applied);
  }

  async refreshReview(branch: string): Promise<ForgeRefreshResult> {
    const item = this.workItems.get(branch);
    if (item?.pullRequestNumber === undefined) {
      return {
        ok: false,
        reason: 'error',
        message: 'PR/MR番号がないため、レビューを取得できません。',
      };
    }
    const review = await fetchReviewThreads(
      this.deps.cli,
      item.host,
      item.cwd,
      item.pullRequestNumber,
    );
    const applied = await this.applyRemoteUpdate(branch, item.pullRequestNumber, (current) => {
      const base = { ...current };
      delete base.reviewCommentCount;
      delete base.reviewMessage;
      delete base.reviewComments;
      return {
        ...base,
        ...(review.ok
          ? {
              reviewCommentCount: review.comments.length,
              reviewComments: review.comments.map((comment) => ({
                id: comment.id,
                author: comment.author,
                body: comment.body,
                ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }),
                ...(comment.resolved === undefined ? {} : { resolved: comment.resolved }),
              })),
            }
          : { reviewMessage: review.message ?? 'レビューを取得できませんでした。' }),
        updatedAt: new Date().toISOString(),
      };
    });
    if (applied !== 'applied') return discardedResult(applied);
    return review.ok
      ? { ok: true }
      : {
          ok: false,
          reason: 'error',
          message: review.message ?? 'レビューを取得できませんでした。',
        };
  }

  async replyToReviewThread(
    branch: string,
    threadId: string,
    body: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const item = this.workItems.get(branch);
    if (item?.pullRequestNumber === undefined) {
      return { ok: false, message: 'PR/MR番号がないため、レビューへ返信できません。' };
    }
    return replyToReviewThread(
      { cli: this.deps.cli, fs: this.deps.fs },
      { host: item.host, cwd: item.cwd, number: item.pullRequestNumber, threadId, body },
    );
  }

  async resolveReviewThread(
    branch: string,
    threadId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const item = this.workItems.get(branch);
    if (item?.pullRequestNumber === undefined) {
      return { ok: false, message: 'PR/MR番号がないため、レビューを解決できません。' };
    }
    return resolveReviewThread(this.deps.cli, {
      host: item.host,
      cwd: item.cwd,
      number: item.pullRequestNumber,
      threadId,
    });
  }

  async refreshPullRequestStatus(branch: string): Promise<ForgeRefreshResult> {
    const item = this.workItems.get(branch);
    if (item?.pullRequestNumber === undefined)
      return { ok: false, reason: 'error', message: 'PR/MR番号がないため、状態を取得できません。' };
    const remote = await fetchPullRequestStatus(
      this.deps.cli,
      item.host,
      item.cwd,
      item.pullRequestNumber,
    );
    const applied = await this.applyRemoteUpdate(branch, item.pullRequestNumber, (current) => ({
      ...current,
      pullRequestState: remote.state,
      ...(remote.mergeable === undefined ? {} : { mergeable: remote.mergeable }),
      ...(remote.approvalsLeft === undefined ? {} : { approvalsLeft: remote.approvalsLeft }),
      ...(remote.message === undefined ? {} : { pullRequestMessage: remote.message }),
      status: remote.state === 'merged' ? 'cleanup' : current.status,
      updatedAt: new Date().toISOString(),
    }));
    if (applied !== 'applied') return discardedResult(applied);
    return remote.state === 'unknown'
      ? {
          ok: false,
          reason: 'error',
          message: remote.message ?? 'PR/MR状態を取得できませんでした。',
        }
      : { ok: true };
  }
}

/** 書き戻す先のカードが既に無いときの結末（Issue #1029）。失敗ではなく中立として扱う。 */
const goneResult = {
  ok: false,
  reason: 'gone',
  message: '対象のForge作業は既に追跡対象から外れています。',
} as const satisfies ForgeRefreshResult;

/**
 * 取得結果を書き戻せなかった理由を、利用者向けの文言に振り分ける（Issue #1029）。
 *
 * カードが消えている場合と、待っている間にPR/MRが差し替わった場合とでは、
 * 画面に出すべき説明が違う。どちらも失敗ではないので`gone`扱いで中立に見せる。
 */
function discardedResult(outcome: 'gone' | 'superseded'): ForgeRefreshResult {
  return outcome === 'gone'
    ? goneResult
    : {
        ok: false,
        reason: 'gone',
        message: 'PR/MRが差し替わったため、取得した結果を破棄しました。',
      };
}

/**
 * 一度マージを観測したカードを、後続の更新でcleanup以外へ戻さない（Issue #1029）。
 *
 * `refreshPullRequestStatus`がマージ済みを検出して`cleanup`にしても、同じ更新ループの
 * `refreshCi`が`status`を無条件で上書きしていたため、マージ済みカードがcleanup列へ
 * 到達できなかった。CI・レビュー・PR/MR状態のどの取得から書き戻す場合も、ここを通す。
 *
 * `merged`だけをterminalにする。未マージの`closed`は再オープンできるため含めない。
 * この単調性は「同じPR/MR番号のライフサイクル」を前提にしており、番号の一致は
 * `applyRemoteUpdate`が別途確認する。
 */
function enforceTerminalPrInvariant(
  previous: ForgeWorkItem,
  candidate: ForgeWorkItem,
): ForgeWorkItem {
  if (previous.pullRequestState !== 'merged' && candidate.pullRequestState !== 'merged') {
    return candidate;
  }
  return { ...candidate, pullRequestState: 'merged', status: 'cleanup' };
}

function parseDiscoveredPullRequest(
  host: ForgeHost,
  stdout: string,
): { number: number; url: string | undefined } | undefined {
  try {
    const data: unknown = JSON.parse(stdout);
    const value = host === 'gitlab' && Array.isArray(data) ? data[0] : data;
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const number = record['number'] ?? record['iid'];
    const url = record['url'] ?? record['web_url'];
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
      ? { number, url: typeof url === 'string' ? url : undefined }
      : undefined;
  } catch {
    return undefined;
  }
}

function deriveNextAction(item: ForgeWorkItem): string {
  if (item.pullRequestState === 'merged') return 'cleanupを確認する';
  if (item.sessionFailed || item.status === 'blocked') return 'ブロック理由を確認する';
  if (item.reviewComments?.some((comment) => !comment.resolved)) return '未解決レビューへ対応する';
  if (item.status === 'ciPending') return 'CI完了を待つ';
  if (item.status === 'ci') return 'レビューとマージ準備を進める';
  if (item.pullRequestNumber !== undefined) return 'レビュー状態を確認する';
  if (item.sessionBusy) return '実装の進捗を確認する';
  return '実装を続ける';
}

function isForgeWorkItem(value: unknown): value is ForgeWorkItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  const issue = item['issue'];
  return (
    typeof issue === 'object' &&
    issue !== null &&
    typeof (issue as Record<string, unknown>)['number'] === 'number' &&
    typeof (issue as Record<string, unknown>)['title'] === 'string' &&
    (item['host'] === 'github' || item['host'] === 'gitlab') &&
    (item['provider'] === 'codex' || item['provider'] === 'claude') &&
    typeof item['cwd'] === 'string' &&
    typeof item['branch'] === 'string' &&
    typeof item['sessionId'] === 'string' &&
    (item['status'] === 'inProgress' ||
      item['status'] === 'review' ||
      item['status'] === 'ciPending' ||
      item['status'] === 'ci' ||
      item['status'] === 'cleanup' ||
      item['status'] === 'blocked') &&
    typeof item['startedAt'] === 'string' &&
    (item['updatedAt'] === undefined || typeof item['updatedAt'] === 'string')
  );
}
