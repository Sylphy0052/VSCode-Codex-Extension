import { describe, expect, it } from 'vitest';

import { buildForgeIssueBody, ForgeHubService } from '../../src/forge/hub';
import type {
  CliAvailabilityPort,
  CliCommandResult,
  CliCommandRunner,
  ForgeFileSystemPort,
} from '../../src/orchestrator/forge';
import type {
  GitCommandResult,
  GitCommandRunner,
  WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';

class FakeGit implements GitCommandRunner {
  constructor(private readonly remote: GitCommandResult) {}
  async run(_args: readonly string[]): Promise<GitCommandResult> {
    return this.remote;
  }
}

class FakeCli implements CliCommandRunner {
  calls: Array<{ command: string; args: readonly string[] }> = [];
  async run(command: string, args: readonly string[]): Promise<CliCommandResult> {
    this.calls.push({ command, args });
    if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: 'https://example.test/issues/12\n', stderr: '' };
  }
}

const available: CliAvailabilityPort = {
  async isOnPath(): Promise<boolean> {
    return true;
  },
};
const files: ForgeFileSystemPort = {
  async writeTempFile(): Promise<string> {
    return '/tmp/forge-hub-body.md';
  },
  async removeTempFile(): Promise<void> {},
};
const worktreeFs: WorktreeFileSystemPort = {
  async realpath(target: string): Promise<string | undefined> {
    return target;
  },
  async readTextFile(): Promise<string | undefined> {
    return undefined;
  },
  async isSymbolicLink(): Promise<boolean> {
    return false;
  },
  async pathExists(): Promise<boolean> {
    return false;
  },
};
const memento = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
  update: async (): Promise<void> => {},
};

describe('buildForgeIssueBody', () => {
  it('現状と3部構成を固定順で作る', () => {
    expect(
      buildForgeIssueBody({
        title: 'unused',
        currentState: '現状',
        overview: '概要',
        implementation: '実装',
        verification: '確認',
      }),
    ).toBe(
      [
        '## 着手前の現状',
        '',
        '現状',
        '',
        '## 非エンジニア向け概要',
        '',
        '概要',
        '',
        '## エンジニア向け仕様・実装計画',
        '',
        '実装',
        '',
        '## 確認者向け確認点',
        '',
        '確認',
      ].join('\n'),
    );
  });
});

describe('ForgeHubService', () => {
  it('originからGitHubを推定し、ghの前提を確認する', async () => {
    const service = new ForgeHubService({
      git: new FakeGit({ code: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' }),
      cli: new FakeCli(),
      cliAvailability: available,
      fs: files,
      worktreeFs,
      memento,
    });

    const snapshot = await service.inspect('codex', '/repo');

    expect(snapshot.host).toBe('github');
    expect(snapshot.prerequisites?.ready).toBe(true);
  });

  it('GitLabではglabでIssueを作る', async () => {
    const cli = new FakeCli();
    const service = new ForgeHubService({
      git: new FakeGit({
        code: 0,
        stdout: 'https://gitlab.example.com/owner/repo.git\n',
        stderr: '',
      }),
      cli,
      cliAvailability: available,
      fs: files,
      worktreeFs,
      memento,
    });
    const snapshot = await service.inspect('claude', '/repo');
    const result = await service.createIssue(snapshot, {
      title: 'Issue',
      currentState: '現状',
      overview: '概要',
      implementation: '実装',
      verification: '確認',
    });

    expect(result).toEqual({ ok: true, url: undefined });
    expect(cli.calls.some((call) => call.command === 'glab' && call.args[0] === 'api')).toBe(true);
  });

  it('開始済みIssueをカンバン向けのカードとして保持する', async () => {
    const git = new FakeGit({ code: 0, stdout: '', stderr: '' });
    git.run = async (args: readonly string[]) => {
      if (args[0] === 'remote') {
        return { code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
      }
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'origin/main\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const service = new ForgeHubService({
      git,
      cli: new FakeCli(),
      cliAvailability: available,
      fs: files,
      worktreeFs,
      memento,
    });
    const snapshot = await service.inspect('codex', '/repo');
    await service.recordStartedWork(
      snapshot,
      { number: 12, title: '開始するIssue' },
      { cwd: '/repo/.agents/worktrees/run/issue-12', branch: 'feature/12/ci-check' },
      'thread-1',
    );

    expect(service.listWorkItems()).toMatchObject([
      { issue: { number: 12 }, host: 'github', provider: 'codex', status: 'inProgress' },
    ]);
  });

  it('GitHubのCI成功をCI列の状態へ永続化する', async () => {
    const cli = new FakeCli();
    let ciOutput = '{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]}';
    cli.run = async (command, args) => {
      cli.calls.push({ command, args });
      if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return {
          code: 0,
          stdout: ciOutput,
          stderr: '',
        };
      }
      return { code: 0, stdout: 'https://github.com/owner/repo/pull/12\n', stderr: '' };
    };
    const git = new FakeGit({ code: 0, stdout: '', stderr: '' });
    git.run = async (args: readonly string[]) => {
      if (args[0] === 'remote') {
        return { code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
      }
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'origin/main\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const service = new ForgeHubService({
      git,
      cli,
      cliAvailability: available,
      fs: files,
      worktreeFs,
      memento,
    });
    const snapshot = await service.inspect('claude', '/repo');
    await service.recordStartedWork(
      snapshot,
      { number: 12, title: 'CIを確認するIssue' },
      { cwd: '/repo/.agents/worktrees/run/issue-12', branch: 'feature/12/ci-check' },
      'thread-1',
    );
    const item = service.listWorkItems()[0];
    if (item === undefined) throw new Error('作業カードが記録されませんでした');
    await service.createDraftPullRequest(item.branch);
    await service.refreshCi(item.branch);
    expect(service.listWorkItems()).toMatchObject([
      { status: 'blocked', ciMessage: expect.any(String) },
    ]);
    ciOutput = '{"statusCheckRollup":[{"status":"IN_PROGRESS","conclusion":null}]}';
    await service.refreshCi(item.branch);
    expect(service.listWorkItems()).toMatchObject([{ status: 'ciPending' }]);
    ciOutput = '{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}';
    await service.refreshCi(item.branch);

    expect(service.listWorkItems()).toMatchObject([
      { provider: 'claude', status: 'ci', pullRequestNumber: 12, updatedAt: expect.any(String) },
    ]);
    expect(service.listWorkItems()[0]?.ciMessage).toBeUndefined();
    expect(cli.calls.some((call) => call.command === 'gh' && call.args[0] === 'pr')).toBe(true);
  });
});

/**
 * cleanupライフサイクル（Issue #1029）。
 *
 * `gh pr view`は3用途で呼ばれるため、`--json=`の中身で応答を切り替える。
 * `statusCheckRollup`がCI、`state,...`がPR/MR状態、`number,url`がPR/MRの発見。
 */
describe('ForgeHubService cleanupライフサイクル', () => {
  interface Remote {
    ci: string;
    pullRequest: string;
    /** CI取得を任意の時点まで止める。割り込みの再現に使う。 */
    beforeCi?: () => Promise<void>;
  }

  const startedService = async (
    remote: Remote,
  ): Promise<{ service: ForgeHubService; branch: string }> => {
    const cli = new FakeCli();
    cli.run = async (command, args) => {
      cli.calls.push({ command, args });
      if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const json = args.find((arg) => arg.startsWith('--json=')) ?? '';
        if (json.includes('statusCheckRollup')) {
          if (remote.beforeCi !== undefined) await remote.beforeCi();
          return { code: 0, stdout: remote.ci, stderr: '' };
        }
        if (json.includes('state')) return { code: 0, stdout: remote.pullRequest, stderr: '' };
      }
      if (command === 'gh' && args[0] === 'api') return { code: 0, stdout: '[]', stderr: '' };
      return { code: 0, stdout: 'https://github.com/owner/repo/pull/12\n', stderr: '' };
    };
    const git = new FakeGit({ code: 0, stdout: '', stderr: '' });
    git.run = async (args: readonly string[]) => {
      if (args[0] === 'remote') {
        return { code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
      }
      if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'origin/main\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const service = new ForgeHubService({
      git,
      cli,
      cliAvailability: available,
      fs: files,
      worktreeFs,
      memento,
    });
    const snapshot = await service.inspect('codex', '/repo');
    await service.recordStartedWork(
      snapshot,
      { number: 12, title: 'cleanupまで通すIssue' },
      { cwd: '/repo/.agents/worktrees/run/issue-12', branch: 'fix/12/cleanup' },
      'thread-1',
    );
    const branch = service.listWorkItems()[0]?.branch;
    if (branch === undefined) throw new Error('作業カードが記録されませんでした');
    await service.createDraftPullRequest(branch);
    return { service, branch };
  };

  const merged = '{"state":"MERGED","isDraft":false,"mergeable":"MERGEABLE"}';
  const open = '{"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE"}';
  const ciFailed = '{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]}';
  const ciPassed = '{"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}';
  const ciPending = '{"statusCheckRollup":[{"status":"IN_PROGRESS","conclusion":null}]}';

  it.each([
    ['CI失敗', ciFailed],
    ['CI成功', ciPassed],
    ['CI実行中', ciPending],
  ])('マージ済みカードは%sでもcleanupに残る', async (_label, ci) => {
    const remote: Remote = { ci, pullRequest: merged };
    const { service } = await startedService(remote);

    await service.refreshRemoteStates();

    expect(service.listWorkItems()).toMatchObject([
      { status: 'cleanup', pullRequestState: 'merged', nextAction: 'cleanupを確認する' },
    ]);
  });

  it('手動のCI更新でもcleanupから戻らない', async () => {
    const remote: Remote = { ci: ciPassed, pullRequest: merged };
    const { service, branch } = await startedService(remote);
    await service.refreshRemoteStates();

    const result = await service.refreshCi(branch);

    expect(result).toEqual({ ok: true });
    expect(service.listWorkItems()).toMatchObject([{ status: 'cleanup' }]);
  });

  it('マージを観測した後にopenが返ってもmergedのまま扱う', async () => {
    const remote: Remote = { ci: ciPending, pullRequest: merged };
    const { service, branch } = await startedService(remote);
    await service.refreshPullRequestStatus(branch);
    remote.pullRequest = open;

    await service.refreshPullRequestStatus(branch);

    expect(service.listWorkItems()).toMatchObject([
      { status: 'cleanup', pullRequestState: 'merged' },
    ]);
  });

  it('CI取得中にcleanup完了したカードを復活させない', async () => {
    let completed: Awaited<ReturnType<ForgeHubService['completeCleanup']>> | undefined;
    const remote: Remote = { ci: ciPassed, pullRequest: merged };
    const { service, branch } = await startedService(remote);
    await service.refreshPullRequestStatus(branch);
    // CI取得の待ち時間中にcleanup完了が入る順序を、CLI応答の直前で再現する。
    remote.beforeCi = async () => {
      completed = await service.completeCleanup(branch);
    };

    const result = await service.refreshCi(branch);

    expect(completed).toEqual({ ok: true });
    expect(result).toMatchObject({ ok: false, reason: 'gone' });
    expect(service.listWorkItems()).toEqual([]);
  });

  it('completeCleanupはマージ済みだけ受け付ける', async () => {
    const remote: Remote = { ci: ciPassed, pullRequest: open };
    const { service, branch } = await startedService(remote);
    await service.refreshRemoteStates();

    const rejected = await service.completeCleanup(branch);

    expect(rejected).toMatchObject({ ok: false, reason: 'error' });
    expect(service.listWorkItems()).toHaveLength(1);

    remote.pullRequest = merged;
    await service.refreshRemoteStates();
    const accepted = await service.completeCleanup(branch);

    expect(accepted).toEqual({ ok: true });
    expect(service.listWorkItems()).toEqual([]);
  });

  it('既に外したカードへの再要求はgoneとして返す', async () => {
    const remote: Remote = { ci: ciPassed, pullRequest: merged };
    const { service, branch } = await startedService(remote);
    await service.refreshRemoteStates();
    await service.completeCleanup(branch);

    expect(await service.completeCleanup(branch)).toMatchObject({ ok: false, reason: 'gone' });
    expect(await service.refreshCi(branch)).toMatchObject({ ok: false, reason: 'error' });
  });

  it('以前の版が保存したmerged×ciのカードを次の同期でcleanupへ戻す', async () => {
    const stored = {
      issue: { number: 12, title: '矛盾した状態で保存されたIssue' },
      host: 'github',
      provider: 'codex',
      cwd: '/repo/.agents/worktrees/run/issue-12',
      branch: 'fix/12/cleanup',
      sessionId: 'thread-1',
      status: 'ci',
      pullRequestNumber: 12,
      pullRequestState: 'merged',
      startedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const cli = new FakeCli();
    cli.run = async (command, args) => {
      cli.calls.push({ command, args });
      if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const json = args.find((arg) => arg.startsWith('--json=')) ?? '';
        if (json.includes('statusCheckRollup')) return { code: 0, stdout: ciPassed, stderr: '' };
        if (json.includes('state')) return { code: 0, stdout: merged, stderr: '' };
      }
      return { code: 0, stdout: '[]', stderr: '' };
    };
    const service = new ForgeHubService({
      git: new FakeGit({ code: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' }),
      cli,
      cliAvailability: available,
      fs: files,
      worktreeFs,
      memento: {
        get: <T>(key: string, defaultValue: T): T =>
          key === 'agent.forge.workItems.v1' ? ([stored] as unknown as T) : defaultValue,
        update: async (): Promise<void> => {},
      },
    });

    expect(service.listWorkItems()).toMatchObject([{ status: 'ci' }]);
    await service.refreshRemoteStates();

    expect(service.listWorkItems()).toMatchObject([
      { status: 'cleanup', pullRequestState: 'merged' },
    ]);
  });
});
