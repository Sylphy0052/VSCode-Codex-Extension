import { describe, expect, it } from 'vitest';

import {
  buildIntegrationPullRequestBody,
  buildIntegrationPullRequestTitle,
  buildTaskPullRequestBody,
  buildTaskPullRequestTitle,
  checkForgePrerequisites,
  createIntegrationPullRequest,
  createPullRequest,
  detectForgeHost,
  forgeCliCommand,
  normalizeFinalMergeConfig,
  normalizeForgeHostConfig,
  normalizePullRequestLayerConfig,
  pushBranch,
  resolveForgeHost,
  runFinalMerge,
  runTaskPullRequestFlow,
  shouldCreateIntegrationPullRequest,
  shouldCreateTaskPullRequest,
  shouldRunFinalMerge,
  type CliAvailabilityPort,
  type CliCommandResult,
  type CliCommandRunner,
  type ForgeFileSystemPort,
  type ForgeStepOutcome,
} from '../../src/orchestrator/forge';
import type { GitCommandResult, GitCommandRunner } from '../../src/orchestrator/worktree';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const TASK_BRANCH = `wf/${RUN_ID}/T1`;
const INTEGRATION_BRANCH = `wf/${RUN_ID}/integration`;

/** `git` の呼び出しを記録し、プレフィックス一致で応答を差し替えられるフェイク（`worktree.test.ts` と同じ形）。 */
class FakeGit implements GitCommandRunner {
  calls: Array<{ args: string[]; cwd: string }> = [];
  private readonly responses: Array<{ prefix: string[]; result: GitCommandResult }> = [];

  respond(prefix: string[], result: GitCommandResult): void {
    this.responses.push({ prefix, result });
  }

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.calls.push({ args: [...args], cwd });
    const matched = this.responses.find((r) => r.prefix.every((p, i) => args[i] === p));
    return matched?.result ?? { code: 0, stdout: '', stderr: '' };
  }
}

/** `gh` / `glab` の呼び出しを記録し、プレフィックス一致で応答を差し替えられるフェイク。 */
class FakeCli implements CliCommandRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  private readonly responses: Array<{
    command: string;
    prefix: string[];
    result: CliCommandResult;
  }> = [];

  respond(command: string, prefix: string[], result: CliCommandResult): void {
    this.responses.push({ command, prefix, result });
  }

  async run(command: string, args: readonly string[], cwd: string): Promise<CliCommandResult> {
    this.calls.push({ command, args: [...args], cwd });
    const matched = this.responses.find(
      (r) => r.command === command && r.prefix.every((p, i) => args[i] === p),
    );
    return matched?.result ?? { code: 0, stdout: '', stderr: '' };
  }
}

class FakeCliAvailability implements CliAvailabilityPort {
  constructor(private readonly onPath: Set<string>) {}

  async isOnPath(command: string): Promise<boolean> {
    return this.onPath.has(command);
  }
}

class FakeForgeFileSystem implements ForgeFileSystemPort {
  written: Array<{ path: string; content: string }> = [];
  removed: string[] = [];
  private counter = 0;

  async writeTempFile(content: string): Promise<string> {
    this.counter += 1;
    const target = `/tmp/forge-test-${this.counter}/body.md`;
    this.written.push({ path: target, content });
    return target;
  }

  async removeTempFile(target: string): Promise<void> {
    this.removed.push(target);
  }
}

describe('detectForgeHost', () => {
  it('github.comをgithubと判定する（https）', () => {
    expect(detectForgeHost('https://github.com/org/repo.git')).toBe('github');
  });

  it('github.comをgithubと判定する（scp-like）', () => {
    expect(detectForgeHost('git@github.com:org/repo.git')).toBe('github');
  });

  it('ホスト名にgitlabを含めばgitlabと判定する', () => {
    expect(detectForgeHost('https://gitlab.example.com/org/repo.git')).toBe('gitlab');
    expect(detectForgeHost('git@gitlab.example.com:org/repo.git')).toBe('gitlab');
  });

  it('名前から判定できない場合はundefined', () => {
    expect(detectForgeHost('https://git.internal.example.com/org/repo.git')).toBeUndefined();
  });

  it('URLとして解釈できない値もundefined', () => {
    expect(detectForgeHost('not a url')).toBeUndefined();
  });
});

describe('forgeCliCommand', () => {
  it('githubはgh、gitlabはglab', () => {
    expect(forgeCliCommand('github')).toBe('gh');
    expect(forgeCliCommand('gitlab')).toBe('glab');
  });
});

describe('resolveForgeHost', () => {
  it('config=noneは常にnone（remoteの値に関わらず）', () => {
    expect(resolveForgeHost('https://github.com/org/repo.git', 'none')).toEqual({ kind: 'none' });
    expect(resolveForgeHost(undefined, 'none')).toEqual({ kind: 'none' });
  });

  it('config=github/gitlabは判定せずそのまま採用する', () => {
    expect(resolveForgeHost('https://gitlab.example.com/o/r.git', 'github')).toEqual({
      kind: 'host',
      host: 'github',
    });
    expect(resolveForgeHost(undefined, 'gitlab')).toEqual({ kind: 'host', host: 'gitlab' });
  });

  it('config=autoはremoteのURLから判定する', () => {
    expect(resolveForgeHost('https://github.com/org/repo.git', 'auto')).toEqual({
      kind: 'host',
      host: 'github',
    });
  });

  it('config=autoでremoteが無ければundetermined', () => {
    const result = resolveForgeHost(undefined, 'auto');
    expect(result.kind).toBe('undetermined');
  });

  it('config=autoでホストが判定できなければundetermined', () => {
    const result = resolveForgeHost('https://git.internal.example.com/o/r.git', 'auto');
    expect(result.kind).toBe('undetermined');
  });
});

describe('normalize系（不正値は安全な既定へ丸める）', () => {
  it('normalizeForgeHostConfig', () => {
    expect(normalizeForgeHostConfig('github')).toBe('github');
    expect(normalizeForgeHostConfig('gitlab')).toBe('gitlab');
    expect(normalizeForgeHostConfig('none')).toBe('none');
    expect(normalizeForgeHostConfig('auto')).toBe('auto');
    expect(normalizeForgeHostConfig('bogus')).toBe('auto');
    expect(normalizeForgeHostConfig('')).toBe('auto');
  });

  it('normalizePullRequestLayerConfig', () => {
    expect(normalizePullRequestLayerConfig('none')).toBe('none');
    expect(normalizePullRequestLayerConfig('integration')).toBe('integration');
    expect(normalizePullRequestLayerConfig('per-task')).toBe('per-task');
    expect(normalizePullRequestLayerConfig('bogus')).toBe('per-task');
  });

  it('normalizeFinalMergeConfig', () => {
    expect(normalizeFinalMergeConfig('auto')).toBe('auto');
    expect(normalizeFinalMergeConfig('pr-only')).toBe('pr-only');
    expect(normalizeFinalMergeConfig('bogus')).toBe('auto');
  });
});

describe('checkForgePrerequisites', () => {
  it('全て揃っていればready:true', async () => {
    const git = new FakeGit();
    git.respond(['remote', 'get-url', 'origin'], {
      code: 0,
      stdout: 'https://github.com/org/repo.git\n',
      stderr: '',
    });
    const cli = new FakeCli();
    cli.respond('gh', ['auth', 'status'], { code: 0, stdout: '', stderr: '' });
    const availability = new FakeCliAvailability(new Set(['gh']));

    const result = await checkForgePrerequisites({ git, cli, cliAvailability: availability }, '/repo', 'github');

    expect(result).toEqual({
      host: 'github',
      hasOriginRemote: true,
      cliOnPath: true,
      authenticated: true,
      ready: true,
      warnings: [],
    });
  });

  it('originが無ければready:falseで警告を出す（エラーにはしない）', async () => {
    const git = new FakeGit();
    git.respond(['remote', 'get-url', 'origin'], { code: 1, stdout: '', stderr: 'no remote' });
    const cli = new FakeCli();
    cli.respond('gh', ['auth', 'status'], { code: 0, stdout: '', stderr: '' });
    const availability = new FakeCliAvailability(new Set(['gh']));

    const result = await checkForgePrerequisites({ git, cli, cliAvailability: availability }, '/repo', 'github');

    expect(result.hasOriginRemote).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('CLIがPATHに無ければauth statusを呼ばずready:false', async () => {
    const git = new FakeGit();
    git.respond(['remote', 'get-url', 'origin'], {
      code: 0,
      stdout: 'https://github.com/org/repo.git\n',
      stderr: '',
    });
    const cli = new FakeCli();
    const availability = new FakeCliAvailability(new Set());

    const result = await checkForgePrerequisites({ git, cli, cliAvailability: availability }, '/repo', 'github');

    expect(result.cliOnPath).toBe(false);
    expect(result.ready).toBe(false);
    expect(cli.calls).toEqual([]);
  });

  it('認証が通っていなければready:false', async () => {
    const git = new FakeGit();
    git.respond(['remote', 'get-url', 'origin'], {
      code: 0,
      stdout: 'git@gitlab.example.com:org/repo.git\n',
      stderr: '',
    });
    const cli = new FakeCli();
    cli.respond('glab', ['auth', 'status'], { code: 1, stdout: '', stderr: 'not logged in' });
    const availability = new FakeCliAvailability(new Set(['glab']));

    const result = await checkForgePrerequisites({ git, cli, cliAvailability: availability }, '/repo', 'gitlab');

    expect(result.authenticated).toBe(false);
    expect(result.ready).toBe(false);
  });
});

describe('PR/MR層の判定', () => {
  it('shouldCreateTaskPullRequestはper-taskのときだけtrue', () => {
    expect(shouldCreateTaskPullRequest('per-task')).toBe(true);
    expect(shouldCreateTaskPullRequest('integration')).toBe(false);
    expect(shouldCreateTaskPullRequest('none')).toBe(false);
  });

  it('shouldCreateIntegrationPullRequestはintegration/per-taskでtrue', () => {
    expect(shouldCreateIntegrationPullRequest('integration')).toBe(true);
    expect(shouldCreateIntegrationPullRequest('per-task')).toBe(true);
    expect(shouldCreateIntegrationPullRequest('none')).toBe(false);
  });

  it('shouldRunFinalMergeはconfig=autoかつPR/MRが作れたときだけtrue', () => {
    expect(shouldRunFinalMerge('auto', true)).toBe(true);
    expect(shouldRunFinalMerge('auto', false)).toBe(false);
    expect(shouldRunFinalMerge('pr-only', true)).toBe(false);
    expect(shouldRunFinalMerge('pr-only', false)).toBe(false);
  });
});

describe('buildTaskPullRequestTitle / buildTaskPullRequestBody', () => {
  it('タイトルは<taskId>: <promptの1行目>になる', () => {
    expect(buildTaskPullRequestTitle('T1', '認証APIを実装する\n詳細な手順...')).toBe(
      'T1: 認証APIを実装する',
    );
  });

  it('taskIdが不正な字種なら例外', () => {
    expect(() => buildTaskPullRequestTitle('../etc', 'x')).toThrow(/taskId/);
  });

  it('本文にprompt・done・runId・依存タスクid・Closes #<N>を含む', () => {
    const body = buildTaskPullRequestBody({
      prompt: 'これがプロンプト',
      done: 'これが完了条件',
      runId: RUN_ID,
      dependsOn: ['T0'],
      issue: 94,
    });
    expect(body).toContain('Closes #94');
    expect(body).toContain('これがプロンプト');
    expect(body).toContain('これが完了条件');
    expect(body).toContain(RUN_ID);
    expect(body).toContain('T0');
  });

  it('issueが無ければClosesを出さない', () => {
    const body = buildTaskPullRequestBody({
      prompt: 'p',
      done: 'd',
      runId: RUN_ID,
      dependsOn: [],
      issue: undefined,
    });
    expect(body).not.toContain('Closes #');
    expect(body).toContain('なし');
  });

  it('本文の入力型はエージェントの応答（result）を受け取るフィールドを持たない（型に無いため混入しない）', () => {
    const input = {
      prompt: 'p',
      done: 'd',
      runId: RUN_ID,
      dependsOn: [],
      issue: undefined,
      // 型に無い余計なフィールドを混ぜても出力へは一切反映されないことを確認する
      result: '機微な応答テキストSECRET_TOKEN_XYZ',
    };
    const body = buildTaskPullRequestBody(input as never);
    expect(body).not.toContain('SECRET_TOKEN_XYZ');
  });
});

describe('buildIntegrationPullRequestTitle / buildIntegrationPullRequestBody', () => {
  it('タイトルにrunIdを含む', () => {
    expect(buildIntegrationPullRequestTitle({ runId: RUN_ID, taskIds: [] })).toContain(RUN_ID);
  });

  it('本文に完了したタスクidを列挙する', () => {
    const body = buildIntegrationPullRequestBody({ runId: RUN_ID, taskIds: ['T1', 'T2'] });
    expect(body).toContain('T1');
    expect(body).toContain('T2');
  });

  it('タスクが無ければその旨を書く', () => {
    const body = buildIntegrationPullRequestBody({ runId: RUN_ID, taskIds: [] });
    expect(body).toContain('なし');
  });
});

describe('pushBranch', () => {
  it('wf/<runId>/... 形式のブランチをorigin/<branch>へpushする', async () => {
    const git = new FakeGit();
    const result = await pushBranch(git, '/repo/task', TASK_BRANCH);
    expect(result).toEqual({ ok: true });
    expect(git.calls[0]?.args).toEqual(['push', 'origin', `${TASK_BRANCH}:${TASK_BRANCH}`]);
  });

  it('wf/<runId>/... の形でないブランチ名は拒否する（gitを呼ばない）', async () => {
    const git = new FakeGit();
    const result = await pushBranch(git, '/repo/task', '-evil-branch');
    expect(result.ok).toBe(false);
    expect(git.calls).toEqual([]);
  });

  it('git pushが失敗すればメッセージ付きで返す', async () => {
    const git = new FakeGit();
    git.respond(['push'], { code: 1, stdout: '', stderr: 'remote rejected' });
    const result = await pushBranch(git, '/repo/task', TASK_BRANCH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('remote rejected');
    }
  });
});

describe('createPullRequest', () => {
  it('GitHubは gh pr create --body-file=<一時ファイル> を呼び、URLをそのまま返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'create'], {
      code: 0,
      stdout: 'https://github.com/org/repo/pull/1\n',
      stderr: '',
    });
    const fs = new FakeForgeFileSystem();

    const result = await createPullRequest(
      { cli, fs },
      {
        host: 'github',
        cwd: '/repo/task',
        base: INTEGRATION_BRANCH,
        head: TASK_BRANCH,
        title: 'T1: 認証APIを実装する',
        body: '本文',
      },
    );

    expect(result).toEqual({ ok: true, url: 'https://github.com/org/repo/pull/1' });
    const call = cli.calls[0];
    expect(call?.command).toBe('gh');
    expect(call?.args).toEqual([
      'pr',
      'create',
      `--base=${INTEGRATION_BRANCH}`,
      `--head=${TASK_BRANCH}`,
      '--title=T1: 認証APIを実装する',
      `--body-file=${fs.written[0]?.path}`,
    ]);
    expect(fs.written[0]?.content).toBe('本文');
    // 一時ファイルは結果に関わらず片付ける
    expect(fs.removed).toEqual([fs.written[0]?.path]);
  });

  it('GitLabは glab api projects/:id/merge_requests を --field=description=@<ファイル> で呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('glab', ['api'], {
      code: 0,
      stdout: JSON.stringify({ web_url: 'https://gitlab.example.com/org/repo/-/merge_requests/1' }),
      stderr: '',
    });
    const fs = new FakeForgeFileSystem();

    const result = await createPullRequest(
      { cli, fs },
      {
        host: 'gitlab',
        cwd: '/repo/task',
        base: INTEGRATION_BRANCH,
        head: TASK_BRANCH,
        title: 'T1: 認証APIを実装する',
        body: '本文',
      },
    );

    expect(result).toEqual({
      ok: true,
      url: 'https://gitlab.example.com/org/repo/-/merge_requests/1',
    });
    const call = cli.calls[0];
    expect(call?.command).toBe('glab');
    expect(call?.args).toEqual([
      'api',
      'projects/:id/merge_requests',
      `--field=source_branch=${TASK_BRANCH}`,
      `--field=target_branch=${INTEGRATION_BRANCH}`,
      '--field=title=T1: 認証APIを実装する',
      `--field=description=@${fs.written[0]?.path}`,
    ]);
  });

  it('body/promptの中身は引数へ直接置かず、一時ファイルへ書く', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'create'], { code: 0, stdout: 'https://example/pr/1\n', stderr: '' });
    const fs = new FakeForgeFileSystem();
    const dangerousBody = '改行を含む本文\n--dangerous-flag-looking-line\n-rf /';

    await createPullRequest(
      { cli, fs },
      {
        host: 'github',
        cwd: '/repo',
        base: INTEGRATION_BRANCH,
        head: TASK_BRANCH,
        title: 't',
        body: dangerousBody,
      },
    );

    const call = cli.calls[0];
    expect(call?.args.some((a) => a.includes('--dangerous-flag-looking-line'))).toBe(false);
    expect(fs.written[0]?.content).toBe(dangerousBody);
  });

  it('base/head/titleが空・改行を含む場合はCLIを呼ばずinvalidInputを返す', async () => {
    const cli = new FakeCli();
    const fs = new FakeForgeFileSystem();

    const result = await createPullRequest(
      { cli, fs },
      { host: 'github', cwd: '/repo', base: '', head: TASK_BRANCH, title: 't', body: 'b' },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'invalidInput',
      message: expect.any(String),
    });
    expect(cli.calls).toEqual([]);
  });

  it('CLIが失敗コードを返せばcliErrorとして返し、一時ファイルは片付ける', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'create'], { code: 1, stdout: '', stderr: 'No commits between' });
    const fs = new FakeForgeFileSystem();

    const result = await createPullRequest(
      { cli, fs },
      {
        host: 'github',
        cwd: '/repo',
        base: INTEGRATION_BRANCH,
        head: TASK_BRANCH,
        title: 't',
        body: 'b',
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cliError');
      expect(result.message).toContain('No commits between');
    }
    expect(fs.removed).toEqual([fs.written[0]?.path]);
  });
});

describe('runTaskPullRequestFlow（design.md §16.18の作る順序を型で固定する）', () => {
  function recordingSteps(overrides?: {
    pushTaskBranch?: ForgeStepOutcome;
    pushIntegrationBranch?: ForgeStepOutcome;
    createPullRequest?: Awaited<ReturnType<typeof createPullRequest>>;
  }): { order: string[]; steps: Parameters<typeof runTaskPullRequestFlow<{ merged: boolean }>>[0] } {
    const order: string[] = [];
    const steps = {
      pushTaskBranch: async (): Promise<ForgeStepOutcome> => {
        order.push('pushTaskBranch');
        return overrides?.pushTaskBranch ?? { ok: true };
      },
      pushIntegrationBranch: async (): Promise<ForgeStepOutcome> => {
        order.push('pushIntegrationBranch');
        return overrides?.pushIntegrationBranch ?? { ok: true };
      },
      createPullRequest: async () => {
        order.push('createPullRequest');
        return overrides?.createPullRequest ?? { ok: true as const, url: 'https://example/pr/1' };
      },
      mergeAndPushIntegration: async (): Promise<{ merged: boolean }> => {
        order.push('mergeAndPushIntegration');
        return { merged: true };
      },
    };
    return { order, steps };
  }

  it('成功時は push task → push integration → create → merge の順に呼ぶ', async () => {
    const { order, steps } = recordingSteps();
    const result = await runTaskPullRequestFlow(steps);

    expect(order).toEqual([
      'pushTaskBranch',
      'pushIntegrationBranch',
      'createPullRequest',
      'mergeAndPushIntegration',
    ]);
    expect(result.pullRequest).toEqual({ created: true, url: 'https://example/pr/1' });
    expect(result.mergeOutcome).toEqual({ merged: true });
  });

  it('タスクブランチのpushが失敗してもmergeAndPushIntegrationは呼ぶ（ワークフローを止めない）', async () => {
    const { order, steps } = recordingSteps({ pushTaskBranch: { ok: false, message: 'push失敗' } });
    const result = await runTaskPullRequestFlow(steps);

    expect(order).toEqual(['pushTaskBranch', 'mergeAndPushIntegration']);
    expect(result.pullRequest).toEqual({
      created: false,
      stage: 'pushTaskBranch',
      message: 'push失敗',
    });
    expect(result.mergeOutcome).toEqual({ merged: true });
  });

  it('統合ブランチのpushが失敗すればcreatePullRequestを呼ばずmergeへ進む', async () => {
    const { order, steps } = recordingSteps({
      pushIntegrationBranch: { ok: false, message: '統合push失敗' },
    });
    const result = await runTaskPullRequestFlow(steps);

    expect(order).toEqual(['pushTaskBranch', 'pushIntegrationBranch', 'mergeAndPushIntegration']);
    expect(result.pullRequest).toEqual({
      created: false,
      stage: 'pushIntegrationBranch',
      message: '統合push失敗',
    });
  });

  it('PR/MR作成が失敗してもmergeAndPushIntegrationは呼ぶ', async () => {
    const { order, steps } = recordingSteps({
      createPullRequest: { ok: false, reason: 'cliError', message: '作成失敗' },
    });
    const result = await runTaskPullRequestFlow(steps);

    expect(order).toEqual([
      'pushTaskBranch',
      'pushIntegrationBranch',
      'createPullRequest',
      'mergeAndPushIntegration',
    ]);
    expect(result.pullRequest).toEqual({
      created: false,
      stage: 'createPullRequest',
      message: '作成失敗',
    });
  });
});

describe('createIntegrationPullRequest', () => {
  it('統合ブランチをpushしてからPR/MRを作る', async () => {
    const git = new FakeGit();
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'create'], { code: 0, stdout: 'https://example/pr/2\n', stderr: '' });
    const fs = new FakeForgeFileSystem();

    const result = await createIntegrationPullRequest(
      { git, cli, fs },
      {
        host: 'github',
        cwd: '/repo/_integration',
        baseBranch: 'main',
        integrationBranch: INTEGRATION_BRANCH,
        title: 'run 統合',
        body: '本文',
      },
    );

    expect(git.calls[0]?.args).toEqual([
      'push',
      'origin',
      `${INTEGRATION_BRANCH}:${INTEGRATION_BRANCH}`,
    ]);
    expect(result.push).toEqual({ ok: true });
    expect(result.pullRequest).toEqual({ ok: true, url: 'https://example/pr/2' });
    // base='main' はwf/形式ではないが、PR/MR作成のbaseとしてはそのまま使える
    expect(cli.calls[0]?.args).toContain('--base=main');
  });

  it('pushが失敗すればPR/MRを作らない', async () => {
    const git = new FakeGit();
    git.respond(['push'], { code: 1, stdout: '', stderr: 'rejected' });
    const cli = new FakeCli();
    const fs = new FakeForgeFileSystem();

    const result = await createIntegrationPullRequest(
      { git, cli, fs },
      {
        host: 'github',
        cwd: '/repo/_integration',
        baseBranch: 'main',
        integrationBranch: INTEGRATION_BRANCH,
        title: 't',
        body: 'b',
      },
    );

    expect(result.push.ok).toBe(false);
    expect(result.pullRequest).toEqual({
      ok: false,
      reason: 'pushFailed',
      message: expect.any(String),
    });
    expect(cli.calls).toEqual([]);
  });
});

describe('runFinalMerge', () => {
  it('GitHubは gh pr merge --merge を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'merge'], { code: 0, stdout: '', stderr: '' });
    const result = await runFinalMerge(cli, 'github', '/repo/_integration');
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'gh',
      args: ['pr', 'merge', '--merge'],
      cwd: '/repo/_integration',
    });
  });

  it('GitLabは glab mr merge --remove-source-branch を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('glab', ['mr', 'merge'], { code: 0, stdout: '', stderr: '' });
    const result = await runFinalMerge(cli, 'gitlab', '/repo/_integration');
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'glab',
      args: ['mr', 'merge', '--remove-source-branch'],
      cwd: '/repo/_integration',
    });
  });

  it('失敗すればメッセージ付きで返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'merge'], { code: 1, stdout: '', stderr: 'merge conflict' });
    const result = await runFinalMerge(cli, 'github', '/repo/_integration');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('merge conflict');
    }
  });
});
