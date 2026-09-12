/**
 * Forge Hubのカードがリポジトリを跨いで混ざらないこと（Issue #1108）。
 *
 * Hubは複数リポジトリのカードを1つの盤面に並べる。カードの識別子がbranch名だけ・計画の
 * 識別子がIssue番号だけだと、別リポジトリの同名branch・同番号Issueが上書きし合う。「対応する」の
 * 送信先も、Hubを開いている場所ではなくカードの作業場所でなければならない。
 */

import { describe, expect, it } from 'vitest';

import {
  ForgeHubService,
  forgeWorkItemKey,
  type ForgeHubSnapshot,
  type ForgeWorkItem,
} from '../../src/forge/hub';
import { ForgeHubViewManager } from '../../src/view/forgeHubView';
import type { ForgeOrchestrator } from '../../src/forge/orchestrator';
import type { Logger } from '../../src/log';
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
import { __mock } from '../mocks/vscode';

/** cwdごとに別のorigin remoteを返す。リポジトリAとBを1つのHubで扱う状況を作る。 */
class RepoAwareGit implements GitCommandRunner {
  constructor(private readonly remotes: Record<string, string>) {}
  async run(args: readonly string[], cwd?: string): Promise<GitCommandResult> {
    if (args[0] === 'remote') {
      const url = cwd === undefined ? undefined : this.remotes[cwd];
      return url === undefined
        ? { code: 1, stdout: '', stderr: 'no remote' }
        : { code: 0, stdout: `${url}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

class FakeCli implements CliCommandRunner {
  async run(command: string, args: readonly string[]): Promise<CliCommandResult> {
    void command;
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
const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const ISSUE = { number: 12, title: '同じ番号のIssue' };

function createService(): ForgeHubService {
  return new ForgeHubService({
    git: new RepoAwareGit({
      '/repoA': 'git@github.com:owner/repo-a.git',
      '/repoB': 'git@github.com:owner/repo-b.git',
    }),
    cli: new FakeCli(),
    cliAvailability: available,
    fs: files,
    worktreeFs,
    memento,
  });
}

/** リポジトリAとBで、同じbranch名・同じIssue番号のカードを1件ずつ記録する。 */
async function recordTwoRepos(service: ForgeHubService): Promise<{
  snapshotA: ForgeHubSnapshot;
  snapshotB: ForgeHubSnapshot;
}> {
  const snapshotA = await service.inspect('codex', '/repoA');
  const snapshotB = await service.inspect('claude', '/repoB');
  await service.recordStartedWork(
    snapshotA,
    ISSUE,
    { cwd: '/worktrees/a/issue-12', branch: 'fix/12/same-name' },
    'session-a',
  );
  await service.recordStartedWork(
    snapshotB,
    ISSUE,
    { cwd: '/worktrees/b/issue-12', branch: 'fix/12/same-name' },
    'session-b',
  );
  return { snapshotA, snapshotB };
}

describe('ForgeHubService: リポジトリを跨いだカード・計画（Issue #1108）', () => {
  it('別リポジトリの同名branchは別のカードとして保持される', async () => {
    const service = createService();
    await recordTwoRepos(service);

    const items = service.listWorkItems();
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.cwd))).toEqual(
      new Set(['/worktrees/a/issue-12', '/worktrees/b/issue-12']),
    );
    // 識別子もリポジトリごとに別
    expect(new Set(items.map(forgeWorkItemKey)).size).toBe(2);
  });

  it('カードの操作は識別子で引く（片方を外してももう片方は残る）', async () => {
    const service = createService();
    await recordTwoRepos(service);
    const [first] = service.listWorkItems();
    if (first === undefined) throw new Error('カードが記録されていません');

    // マージ済みでなければ外せない、という既存の条件はそのまま
    expect(await service.completeCleanup(forgeWorkItemKey(first))).toMatchObject({ ok: false });
    expect(service.listWorkItems()).toHaveLength(2);
  });

  it('別リポジトリの同番号Issueは、別々の計画として扱う', async () => {
    const service = createService();
    const snapshotA = await service.inspect('codex', '/repoA');
    const snapshotB = await service.inspect('claude', '/repoB');

    expect(await service.postIssuePlan(snapshotA, ISSUE, '実装計画')).toMatchObject({ ok: true });

    expect(service.listPlannedIssues(snapshotA, [ISSUE])).toHaveLength(1);
    expect(service.listPlannedIssues(snapshotB, [ISSUE])).toHaveLength(0);
  });
});

/** `ForgeOrchestrator` のうち、Hub Viewが使う口だけを持つフェイク。 */
function fakeOrchestrator(): {
  orchestrator: ForgeOrchestrator;
  sends: Array<{ provider: string; cwd: string; text: string }>;
} {
  const sends: Array<{ provider: string; cwd: string; text: string }> = [];
  const orchestrator = {
    onChanged: () => undefined,
    onWorkStateChanged: () => undefined,
    getSnapshot: () => undefined,
    send: async (provider: string, cwd: string, text: string) => {
      sends.push({ provider, cwd, text });
      return '';
    },
    startWork: async () => '',
    interrupt: async () => undefined,
    revealWorkSession: () => true,
    revealOrchestrator: () => true,
  } as unknown as ForgeOrchestrator;
  return { orchestrator, sends };
}

describe('ForgeHubViewManager: 「対応する」の送信先（Issue #1108）', () => {
  it('リポジトリBでHubを開いていても、リポジトリAのカードはAの作業場所へ送る', async () => {
    const service = createService();
    const { snapshotA } = await recordTwoRepos(service);
    void snapshotA;
    const itemA = service
      .listWorkItems()
      .find((item: ForgeWorkItem) => item.cwd === '/worktrees/a/issue-12');
    if (itemA === undefined) throw new Error('リポジトリAのカードがありません');

    const { orchestrator, sends } = fakeOrchestrator();
    const view = new ForgeHubViewManager(service, () => '/repoB', orchestrator, fakeLogger);
    // Hubを開いているのはリポジトリB
    await view.show('codex');
    const panel = __mock.lastCreatedPanel();
    if (panel === undefined) throw new Error('Webviewパネルが作られていません');

    panel.webview.simulateMessage({ type: 'runWorkAction', key: forgeWorkItemKey(itemA) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sends).toHaveLength(1);
    expect(sends[0]?.cwd).toBe('/worktrees/a/issue-12');
    expect(sends[0]?.provider).toBe(itemA.provider);
    view.dispose();
  });
});
