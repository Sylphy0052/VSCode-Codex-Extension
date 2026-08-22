import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildIntegrationPullRequestBody,
  buildIntegrationPullRequestTitle,
  buildTaskPullRequestBody,
  buildTaskPullRequestTitle,
  checkForgePrerequisites,
  createIntegrationPullRequest,
  createPullRequest,
  detectForgeHost,
  fetchCiConclusion,
  forgeCliCommand,
  isBranchNotUpToDateError,
  isRetryablePushError,
  markPullRequestReady,
  nodeCliAvailability,
  normalizeFinalMergeConfig,
  normalizeForgeHostConfig,
  normalizePullRequestLayerConfig,
  parseGithubCiConclusion,
  parseGitlabCiConclusion,
  parsePullRequestNumberFromUrl,
  PUSH_BRANCH_MAX_ATTEMPTS,
  pushBranch,
  resolveForgeHost,
  runFinalMerge,
  runFinalMergeWithCiGate,
  runTaskPullRequestFlow,
  shouldCreateIntegrationPullRequest,
  shouldCreateTaskPullRequest,
  shouldRunFinalMerge,
  needsFinalMergeDecision,
  updatePullRequestBranch,
  waitForCiChecks,
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
    expect(normalizeFinalMergeConfig('orchestrator')).toBe('orchestrator');
    expect(normalizeFinalMergeConfig('confirm')).toBe('confirm');
    expect(normalizeFinalMergeConfig('pr-only')).toBe('pr-only');
    // design.md §16.26。不正値は新しい既定（orchestrator）へ丸める
    expect(normalizeFinalMergeConfig('bogus')).toBe('orchestrator');
  });
});

describe('nodeCliAvailability.isOnPath（Windowsの拡張子解決。Issue #404）', () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let originalPathExt: string | undefined;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'forge-isonpath-'));
    originalPath = process.env['PATH'];
    originalPathExt = process.env['PATHEXT'];
  });

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = originalPath;
    }
    if (originalPathExt === undefined) {
      delete process.env['PATHEXT'];
    } else {
      process.env['PATHEXT'] = originalPathExt;
    }
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('PATHEXT設定下では拡張子付き（gh.CMD相当）の実行ファイルも見つかる', async () => {
    const target = path.join(tempDir, 'gh.CMD');
    await fsPromises.writeFile(target, '@echo off\n', { mode: 0o755 });

    process.env['PATH'] = tempDir;
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';

    await expect(nodeCliAvailability.isOnPath('gh')).resolves.toBe(true);
  });

  it('拡張子付きファイルが無ければfalse', async () => {
    process.env['PATH'] = tempDir;
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';

    await expect(nodeCliAvailability.isOnPath('gh')).resolves.toBe(false);
  });

  it('PATHEXT未設定（Linux相当）では拡張子なしの実行ファイルが見つかる', async () => {
    const target = path.join(tempDir, 'gh');
    await fsPromises.writeFile(target, '#!/bin/sh\n', { mode: 0o755 });

    process.env['PATH'] = tempDir;
    delete process.env['PATHEXT'];

    await expect(nodeCliAvailability.isOnPath('gh')).resolves.toBe(true);
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
    expect(shouldRunFinalMerge('orchestrator', true)).toBe(false);
    expect(shouldRunFinalMerge('confirm', true)).toBe(false);
    expect(shouldRunFinalMerge('pr-only', true)).toBe(false);
    expect(shouldRunFinalMerge('pr-only', false)).toBe(false);
  });

  it('needsFinalMergeDecisionはconfig=orchestrator/confirmかつPR/MRが作れたときだけtrue（design.md §16.26）', () => {
    expect(needsFinalMergeDecision('orchestrator', true)).toBe(true);
    expect(needsFinalMergeDecision('orchestrator', false)).toBe(false);
    expect(needsFinalMergeDecision('confirm', true)).toBe(true);
    expect(needsFinalMergeDecision('confirm', false)).toBe(false);
    expect(needsFinalMergeDecision('auto', true)).toBe(false);
    expect(needsFinalMergeDecision('pr-only', true)).toBe(false);
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

/**
 * `pushBranch`のリトライ挙動を確かめるための、呼び出し順に応答を返すフェイク。
 * `FakeGit`（プレフィックス一致で常に同じ応答を返す）では「1回目だけ失敗し2回目で
 * 成功する」ような連続した呼び出しごとの応答差し替えができないため、この専用フェイクを使う。
 */
class SequencedGit implements GitCommandRunner {
  calls: Array<{ args: string[]; cwd: string }> = [];
  constructor(private readonly results: GitCommandResult[]) {}

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.calls.push({ args: [...args], cwd });
    const next = this.results.shift();
    return next ?? { code: 0, stdout: '', stderr: '' };
  }
}

describe('pushBranch（競合系の一時的失敗のリトライ。Issue #253）', () => {
  it('1回目にcannot lock refを返しても2回目で成功すれば成功を返す（バックオフを挟んでリトライする）', async () => {
    const git = new SequencedGit([
      {
        code: 1,
        stdout: '',
        stderr:
          '! [remote rejected] wf/x/integration -> wf/x/integration (cannot lock ref for update)',
      },
      { code: 0, stdout: '', stderr: '' },
    ]);
    const waits: number[] = [];
    const result = await pushBranch(git, '/repo/integration', INTEGRATION_BRANCH, async (attempt) => {
      waits.push(attempt);
    });

    expect(result).toEqual({ ok: true });
    expect(git.calls).toHaveLength(2);
    // リトライ前に1回だけ待っている（実時間では待たない。waitはテストからの注入）
    expect(waits).toEqual([1]);
  });

  it('認証エラーなど競合を示さない失敗はリトライせず即座に失敗を返す', async () => {
    const git = new SequencedGit([
      { code: 1, stdout: '', stderr: 'fatal: Authentication failed for https://example/repo.git' },
    ]);
    const waits: number[] = [];
    const result = await pushBranch(git, '/repo/integration', INTEGRATION_BRANCH, async (attempt) => {
      waits.push(attempt);
    });

    expect(result.ok).toBe(false);
    expect(git.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('競合が上限回数を超えて続けば失敗を返す', async () => {
    const failure: GitCommandResult = { code: 1, stdout: '', stderr: 'cannot lock ref for update' };
    const git = new SequencedGit(
      Array.from({ length: PUSH_BRANCH_MAX_ATTEMPTS }, () => ({ ...failure })),
    );
    const waits: number[] = [];
    const result = await pushBranch(git, '/repo/integration', INTEGRATION_BRANCH, async (attempt) => {
      waits.push(attempt);
    });

    expect(result.ok).toBe(false);
    expect(git.calls).toHaveLength(PUSH_BRANCH_MAX_ATTEMPTS);
    expect(waits).toEqual([1, 2]);
  });
});

describe('isRetryablePushError', () => {
  it.each([
    ['cannot lock ref for update'],
    ['! [rejected] main -> main (fetch first)'],
    ['! [rejected] main -> main (non-fast-forward)'],
    ['CANNOT LOCK REF FOR UPDATE'],
  ])('競合系のstderr「%s」はリトライ対象と判定する', (stderr) => {
    expect(isRetryablePushError(stderr)).toBe(true);
  });

  it.each([
    ['fatal: Authentication failed for https://example/repo.git'],
    ['fatal: repository not found'],
    [''],
  ])('競合以外のstderr「%s」はリトライ対象外と判定する', (stderr) => {
    expect(isRetryablePushError(stderr)).toBe(false);
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

  describe('draft指定（「Draft PR/MRとして作成し、統合マージ後にreadyへ切り替える」フロー）', () => {
    it('GitHubはdraft=trueなら--draftを足す', async () => {
      const cli = new FakeCli();
      cli.respond('gh', ['pr', 'create'], { code: 0, stdout: 'https://example/pr/1\n', stderr: '' });
      const fs = new FakeForgeFileSystem();

      await createPullRequest(
        { cli, fs },
        {
          host: 'github',
          cwd: '/repo',
          base: INTEGRATION_BRANCH,
          head: TASK_BRANCH,
          title: 't',
          body: 'b',
          draft: true,
        },
      );

      expect(cli.calls[0]?.args).toContain('--draft');
    });

    it('GitHubはdraft=false（または省略）なら--draftを足さず既存と同じ引数列になる', async () => {
      const cli = new FakeCli();
      cli.respond('gh', ['pr', 'create'], { code: 0, stdout: 'https://example/pr/1\n', stderr: '' });
      const fsWithDraftFalse = new FakeForgeFileSystem();
      const fsOmitted = new FakeForgeFileSystem();

      await createPullRequest(
        { cli, fs: fsWithDraftFalse },
        {
          host: 'github',
          cwd: '/repo',
          base: INTEGRATION_BRANCH,
          head: TASK_BRANCH,
          title: 't',
          body: 'b',
          draft: false,
        },
      );
      await createPullRequest(
        { cli, fs: fsOmitted },
        {
          host: 'github',
          cwd: '/repo',
          base: INTEGRATION_BRANCH,
          head: TASK_BRANCH,
          title: 't',
          body: 'b',
        },
      );

      expect(cli.calls[0]?.args).toEqual([
        'pr',
        'create',
        `--base=${INTEGRATION_BRANCH}`,
        `--head=${TASK_BRANCH}`,
        '--title=t',
        `--body-file=${fsWithDraftFalse.written[0]?.path}`,
      ]);
      expect(cli.calls[1]?.args).toEqual([
        'pr',
        'create',
        `--base=${INTEGRATION_BRANCH}`,
        `--head=${TASK_BRANCH}`,
        '--title=t',
        `--body-file=${fsOmitted.written[0]?.path}`,
      ]);
    });

    it('GitLabはdraft=trueなら--field=draft=trueを足す', async () => {
      const cli = new FakeCli();
      cli.respond('glab', ['api'], {
        code: 0,
        stdout: JSON.stringify({ web_url: 'https://gitlab.example.com/org/repo/-/merge_requests/1' }),
        stderr: '',
      });
      const fs = new FakeForgeFileSystem();

      await createPullRequest(
        { cli, fs },
        {
          host: 'gitlab',
          cwd: '/repo',
          base: INTEGRATION_BRANCH,
          head: TASK_BRANCH,
          title: 't',
          body: 'b',
          draft: true,
        },
      );

      expect(cli.calls[0]?.args).toContain('--field=draft=true');
    });

    it('GitLabはdraft=false（または省略）なら--field=draft=trueを足さない', async () => {
      const cli = new FakeCli();
      cli.respond('glab', ['api'], {
        code: 0,
        stdout: JSON.stringify({ web_url: 'https://gitlab.example.com/org/repo/-/merge_requests/1' }),
        stderr: '',
      });
      const fs = new FakeForgeFileSystem();

      await createPullRequest(
        { cli, fs },
        {
          host: 'gitlab',
          cwd: '/repo',
          base: INTEGRATION_BRANCH,
          head: TASK_BRANCH,
          title: 't',
          body: 'b',
        },
      );

      expect(cli.calls[0]?.args.some((a) => a.includes('draft'))).toBe(false);
    });
  });
});

describe('runTaskPullRequestFlow（design.md §16.18の作る順序を型で固定する）', () => {
  function recordingSteps(overrides?: {
    pushTaskBranch?: ForgeStepOutcome;
    pushIntegrationBranch?: ForgeStepOutcome;
    createPullRequest?: Awaited<ReturnType<typeof createPullRequest>>;
    markPullRequestReady?: ForgeStepOutcome;
  }): {
    order: string[];
    /** `markPullRequestReady`が呼ばれた際に渡されたurl引数（呼ばれなければ空配列）。 */
    markPullRequestReadyUrls: Array<string | undefined>;
    steps: Parameters<typeof runTaskPullRequestFlow<{ merged: boolean }>>[0];
  } {
    const order: string[] = [];
    const markPullRequestReadyUrls: Array<string | undefined> = [];
    const base = {
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
    // `markPullRequestReady`はoptionalなプロパティ（`?:`）のため、指定されなかった場合は
    // プロパティ自体を持たせない（`exactOptionalPropertyTypes`下で`undefined`を明示代入しない）
    const steps =
      overrides?.markPullRequestReady === undefined
        ? base
        : {
            ...base,
            markPullRequestReady: async (url: string | undefined): Promise<ForgeStepOutcome> => {
              order.push('markPullRequestReady');
              markPullRequestReadyUrls.push(url);
              return overrides.markPullRequestReady as ForgeStepOutcome;
            },
          };
    return { order, markPullRequestReadyUrls, steps };
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

  it('markPullRequestReadyを渡すと、mergeAndPushIntegrationの後に呼ばれる', async () => {
    const { order, steps, markPullRequestReadyUrls } = recordingSteps({
      markPullRequestReady: { ok: true },
    });
    const result = await runTaskPullRequestFlow(steps);

    expect(order).toEqual([
      'pushTaskBranch',
      'pushIntegrationBranch',
      'createPullRequest',
      'mergeAndPushIntegration',
      'markPullRequestReady',
    ]);
    expect(markPullRequestReadyUrls).toEqual(['https://example/pr/1']);
    expect(result.markReady).toEqual({ ok: true });
  });

  it('createPullRequestが失敗したときはmarkPullRequestReadyが呼ばれない', async () => {
    const { order, markPullRequestReadyUrls, steps } = recordingSteps({
      createPullRequest: { ok: false, reason: 'cliError', message: '作成失敗' },
      markPullRequestReady: { ok: true },
    });
    const result = await runTaskPullRequestFlow(steps);

    expect(order).toEqual([
      'pushTaskBranch',
      'pushIntegrationBranch',
      'createPullRequest',
      'mergeAndPushIntegration',
    ]);
    expect(markPullRequestReadyUrls).toEqual([]);
    expect(result.markReady).toBeUndefined();
  });

  it('markPullRequestReadyが失敗してもmergeOutcomeは返る', async () => {
    const { steps } = recordingSteps({
      markPullRequestReady: { ok: false, message: 'ready化失敗' },
    });
    const result = await runTaskPullRequestFlow(steps);

    expect(result.mergeOutcome).toEqual({ merged: true });
    expect(result.markReady).toEqual({ ok: false, message: 'ready化失敗' });
  });

  it('markPullRequestReadyを渡さなければ結果のmarkReadyはundefined', async () => {
    const { steps } = recordingSteps();
    const result = await runTaskPullRequestFlow(steps);

    expect(result.markReady).toBeUndefined();
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

describe('runFinalMerge（Issue #404: 番号を必ず含める）', () => {
  it('GitHubは gh pr merge <number> --merge を呼ぶ（番号を含む）', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'merge'], { code: 0, stdout: '', stderr: '' });
    const result = await runFinalMerge(cli, 'github', '/repo/_integration', 42);
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'gh',
      args: ['pr', 'merge', '42', '--merge'],
      cwd: '/repo/_integration',
    });
  });

  it('GitLabは glab mr merge <number> --remove-source-branch を呼ぶ（番号を含む）', async () => {
    const cli = new FakeCli();
    cli.respond('glab', ['mr', 'merge'], { code: 0, stdout: '', stderr: '' });
    const result = await runFinalMerge(cli, 'gitlab', '/repo/_integration', 42);
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'glab',
      args: ['mr', 'merge', '42', '--remove-source-branch'],
      cwd: '/repo/_integration',
    });
  });

  it('失敗すればメッセージ付きで返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'merge'], { code: 1, stdout: '', stderr: 'merge conflict' });
    const result = await runFinalMerge(cli, 'github', '/repo/_integration', 42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('merge conflict');
    }
  });

  it('番号がundefinedのときはCLIを呼ばずマージを飛ばし、警告メッセージ付きで返す', async () => {
    const cli = new FakeCli();
    const result = await runFinalMerge(cli, 'github', '/repo/_integration', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('番号が不明');
    }
    // カレントブランチ依存でのマージを避けるため、CLIそのものを起動しない
    expect(cli.calls).toEqual([]);
  });

  it('番号が0や負の数など不正な値のときもCLIを呼ばずに失敗を返す', async () => {
    const cli = new FakeCli();
    const result = await runFinalMerge(cli, 'github', '/repo/_integration', 0);
    expect(result.ok).toBe(false);
    expect(cli.calls).toEqual([]);
  });
});

describe('markPullRequestReady（Draftで作ったPR/MRをreadyへ切り替える）', () => {
  it('GitHubは gh pr ready <number> を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'ready'], { code: 0, stdout: '', stderr: '' });
    const result = await markPullRequestReady(cli, 'github', '/repo/task', 12);
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'gh',
      args: ['pr', 'ready', '12'],
      cwd: '/repo/task',
    });
  });

  it('GitLabは glab mr update <number> --ready を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('glab', ['mr', 'update'], { code: 0, stdout: '', stderr: '' });
    const result = await markPullRequestReady(cli, 'gitlab', '/repo/task', 12);
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'glab',
      args: ['mr', 'update', '12', '--ready'],
      cwd: '/repo/task',
    });
  });

  it('非0終了コードならstderr由来のメッセージ付きで{ ok: false }を返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'ready'], { code: 1, stdout: '', stderr: 'pull request not found' });
    const result = await markPullRequestReady(cli, 'github', '/repo/task', 12);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('pull request not found');
    }
  });

  it.each([[0], [-1], [1.5]])(
    '不正なnumber（%s）は例外にせず、{ ok: false }を返す（floating promiseで起動される' +
      'finalizeForgeを打ち切らないため。レビュー指摘）',
    async (invalid) => {
      const cli = new FakeCli();
      const result = await markPullRequestReady(cli, 'github', '/repo/task', invalid);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/正の整数/);
      }
      expect(cli.calls).toEqual([]);
    },
  );
});

describe('parsePullRequestNumberFromUrl', () => {
  it('GitHubのURL末尾の数字を取り出す', () => {
    expect(parsePullRequestNumberFromUrl('https://github.com/o/r/pull/12')).toBe(12);
  });

  it('GitLabのURL末尾の数字を取り出す', () => {
    expect(
      parsePullRequestNumberFromUrl('https://gitlab.example.com/g/p/-/merge_requests/34'),
    ).toBe(34);
  });

  it('末尾が数字でないURLはundefined', () => {
    expect(parsePullRequestNumberFromUrl('https://github.com/o/r/pulls')).toBeUndefined();
  });

  it('undefined相当の入力（空文字）はundefined', () => {
    expect(parsePullRequestNumberFromUrl('')).toBeUndefined();
  });
});

/**
 * `waitForCiChecks` / `runFinalMergeWithCiGate` の呼び出し順を確かめるための、呼び出し順に
 * 応答を返すフェイク（`SequencedGit`と同じ方針）。`FakeCli`（プレフィックス一致で常に同じ
 * 応答を返す）では「1回目はpendingを返し2回目でpassedになる」ような連続した呼び出しごとの
 * 応答差し替えができないため、この専用フェイクを使う。
 */
class SequencedCli implements CliCommandRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  constructor(private readonly results: CliCommandResult[]) {}

  async run(command: string, args: readonly string[], cwd: string): Promise<CliCommandResult> {
    this.calls.push({ command, args: [...args], cwd });
    const next = this.results.shift();
    return next ?? { code: 0, stdout: '', stderr: '' };
  }
}

const githubNoChecks = { code: 0, stdout: JSON.stringify({ statusCheckRollup: [] }), stderr: '' };
const githubPending = {
  code: 0,
  stdout: JSON.stringify({
    statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }],
  }),
  stderr: '',
};
const githubPassed = {
  code: 0,
  stdout: JSON.stringify({
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }),
  stderr: '',
};
const githubFailed = {
  code: 0,
  stdout: JSON.stringify({
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
  }),
  stderr: '',
};

describe('parseGithubCiConclusion', () => {
  it('statusCheckRollupが空配列ならnone（CI未設定）', () => {
    expect(parseGithubCiConclusion(githubNoChecks.stdout)).toEqual({ conclusion: 'none' });
  });

  it('全て完了かつ全てSUCCESSならpassed', () => {
    expect(parseGithubCiConclusion(githubPassed.stdout)).toEqual({ conclusion: 'passed' });
  });

  it('1件でも未完了（status !== COMPLETED）ならpending', () => {
    expect(parseGithubCiConclusion(githubPending.stdout)).toEqual({ conclusion: 'pending' });
  });

  it('完了したチェックにFAILUREがあればfailed（理由付き）', () => {
    const result = parseGithubCiConclusion(githubFailed.stdout);
    expect(result.conclusion).toBe('failed');
    expect(result.message).toContain('FAILURE');
  });

  it('StatusContext形式（stateフィールドのみ）のPENDINGもpendingとして扱う', () => {
    const stdout = JSON.stringify({ statusCheckRollup: [{ state: 'PENDING' }] });
    expect(parseGithubCiConclusion(stdout)).toEqual({ conclusion: 'pending' });
  });

  it('StatusContext形式のERRORはfailed', () => {
    const stdout = JSON.stringify({ statusCheckRollup: [{ state: 'ERROR' }] });
    expect(parseGithubCiConclusion(stdout).conclusion).toBe('failed');
  });

  it('壊れたJSONはfailedとして扱う（pendingのまま無期限に待たせない）', () => {
    expect(parseGithubCiConclusion('not json').conclusion).toBe('failed');
  });

  it('statusCheckRollupキー自体が無い応答はnone（0件）ではなくfailed（想定外の応答形。セキュリティ監査の指摘）', () => {
    const result = parseGithubCiConclusion(JSON.stringify({ someOtherField: 1 }));
    expect(result.conclusion).toBe('failed');
  });

  it('statusCheckRollupが配列でない応答もfailed（想定外の応答形）', () => {
    const result = parseGithubCiConclusion(JSON.stringify({ statusCheckRollup: 'not-an-array' }));
    expect(result.conclusion).toBe('failed');
  });

  it('conclusionが成功値ホワイトリストに無い未知の値（STALE等）はfailed（fail-closed。成功値のホワイトリスト方式）', () => {
    const stdout = JSON.stringify({
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'STALE' }],
    });
    const result = parseGithubCiConclusion(stdout);
    expect(result.conclusion).toBe('failed');
    expect(result.message).toContain('STALE');
  });
});

describe('parseGitlabCiConclusion', () => {
  it('head_pipelineがnullならnone（CI未設定）', () => {
    expect(parseGitlabCiConclusion(JSON.stringify({ head_pipeline: null }))).toEqual({
      conclusion: 'none',
    });
  });

  it('status: successはpassed', () => {
    expect(
      parseGitlabCiConclusion(JSON.stringify({ head_pipeline: { status: 'success' } })),
    ).toEqual({ conclusion: 'passed' });
  });

  it('status: failedはfailed（理由付き）', () => {
    const result = parseGitlabCiConclusion(JSON.stringify({ head_pipeline: { status: 'failed' } }));
    expect(result.conclusion).toBe('failed');
    expect(result.message).toContain('failed');
  });

  it('status: runningはpending', () => {
    expect(
      parseGitlabCiConclusion(JSON.stringify({ head_pipeline: { status: 'running' } })),
    ).toEqual({ conclusion: 'pending' });
  });

  it('壊れたJSONはfailedとして扱う', () => {
    expect(parseGitlabCiConclusion('not json').conclusion).toBe('failed');
  });

  it('head_pipelineキー自体が無い応答はnone（パイプライン無し）ではなくfailed（想定外の応答形。セキュリティ監査の指摘）', () => {
    const result = parseGitlabCiConclusion(JSON.stringify({ someOtherField: 1 }));
    expect(result.conclusion).toBe('failed');
  });

  it('head_pipelineがオブジェクトでも配列でもない（例: 文字列）応答もfailed', () => {
    const result = parseGitlabCiConclusion(JSON.stringify({ head_pipeline: 'unexpected' }));
    expect(result.conclusion).toBe('failed');
  });
});

describe('fetchCiConclusion', () => {
  it('GitHubは gh pr view <number> --json=statusCheckRollup を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'view'], githubPassed);
    const result = await fetchCiConclusion(cli, 'github', '/repo/_integration', 42);
    expect(result).toEqual({ conclusion: 'passed' });
    expect(cli.calls[0]).toEqual({
      command: 'gh',
      args: ['pr', 'view', '42', '--json=statusCheckRollup'],
      cwd: '/repo/_integration',
    });
  });

  it('GitLabは glab api projects/:id/merge_requests/<number> を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('glab', ['api'], {
      code: 0,
      stdout: JSON.stringify({ head_pipeline: { status: 'success' } }),
      stderr: '',
    });
    const result = await fetchCiConclusion(cli, 'gitlab', '/repo/_integration', 7);
    expect(result).toEqual({ conclusion: 'passed' });
    expect(cli.calls[0]).toEqual({
      command: 'glab',
      args: ['api', 'projects/:id/merge_requests/7'],
      cwd: '/repo/_integration',
    });
  });

  it('CLI呼び出し自体が失敗（終了コード非0）すればfailedとして扱う', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'view'], { code: 1, stdout: '', stderr: 'authentication failed' });
    const result = await fetchCiConclusion(cli, 'github', '/repo/_integration', 42);
    expect(result.conclusion).toBe('failed');
    expect(result.message).toContain('authentication failed');
  });
});

describe('isBranchNotUpToDateError', () => {
  it.each([
    ['GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)'],
    ['Pull Request is not up to date with the base branch'],
    ['The head branch was modified. Review and try the merge again.'],
    ['This branch is out of date with the base branch'],
    ['Merge request needs a rebase before it can be merged'],
  ])('baseの遅れを示すメッセージ「%s」はtrue', (message) => {
    expect(isBranchNotUpToDateError(message)).toBe(true);
  });

  it.each([['merge conflict'], ['fatal: Authentication failed for https://example/repo.git'], ['']])(
    'baseの遅れと無関係なメッセージ「%s」はfalse',
    (message) => {
      expect(isBranchNotUpToDateError(message)).toBe(false);
    },
  );
});

describe('waitForCiChecks', () => {
  it('CI未設定（statusCheckRollupが空）なら待たずにnoneを返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'view'], githubNoChecks);
    const waits: number[] = [];
    const result = await waitForCiChecks(
      cli,
      'github',
      '/repo/_integration',
      42,
      60_000,
      () => 0,
      async () => {
        waits.push(1);
      },
    );
    expect(result).toEqual({ kind: 'none' });
    expect(waits).toEqual([]);
  });

  it('すでに成功していれば待たずにpassedを返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'view'], githubPassed);
    const result = await waitForCiChecks(cli, 'github', '/repo/_integration', 42, 60_000, () => 0);
    expect(result).toEqual({ kind: 'passed' });
  });

  it('赤なら待たずにfailedを返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'view'], githubFailed);
    const result = await waitForCiChecks(cli, 'github', '/repo/_integration', 42, 60_000, () => 0);
    expect(result.kind).toBe('failed');
  });

  it('pendingが続いた後にpassedへ変われば、ポーリングを挟んでpassedを返す（実時間では待たない）', async () => {
    const cli = new SequencedCli([githubPending, githubPending, githubPassed]);
    const waits: number[] = [];
    const result = await waitForCiChecks(
      cli,
      'github',
      '/repo/_integration',
      42,
      60_000,
      () => 0,
      async () => {
        waits.push(1);
      },
    );
    expect(result).toEqual({ kind: 'passed' });
    expect(cli.calls).toHaveLength(3);
    // pending→pending→passedの間に2回だけ待っている
    expect(waits).toEqual([1, 1]);
  });

  it('待ち時間の上限を超えてもpendingのままならtimeoutを返す（赤と同じ扱い）', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'view'], githubPending);
    // nowを1回目の呼び出しでdeadlineちょうど、2回目以降は超過させる
    let now = 0;
    const result = await waitForCiChecks(
      cli,
      'github',
      '/repo/_integration',
      42,
      1000,
      () => {
        const current = now;
        now += 2000;
        return current;
      },
      async () => {
        // 実時間では待たない
      },
    );
    expect(result.kind).toBe('timeout');
  });

  it('isCancelledがtrueなら、CI状態の確認すら行わずcancelledを返す（セキュリティ監査の指摘。2026-08-23）', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'view'], githubPassed);
    const result = await waitForCiChecks(
      cli,
      'github',
      '/repo/_integration',
      42,
      60_000,
      () => 0,
      undefined,
      () => true,
    );
    expect(result).toEqual({ kind: 'cancelled' });
    // CI状態の取得自体を行わない（停止していれば何も問い合わせない）
    expect(cli.calls).toEqual([]);
  });

  it('ポーリングの途中でisCancelledがtrueへ変わればcancelledで打ち切る（wait()を跨いだ次の周回で確認する）', async () => {
    const cli = new SequencedCli([githubPending, githubPassed]);
    let cancelled = false;
    const result = await waitForCiChecks(
      cli,
      'github',
      '/repo/_integration',
      42,
      60_000,
      () => 0,
      async () => {
        // 1回目のwait()の最中に人が停止した、という状況を模す
        cancelled = true;
      },
      () => cancelled,
    );
    expect(result).toEqual({ kind: 'cancelled' });
    // 1回目のCI確認（pending）はするが、2回目（passedのはず）はCI状態を見る前に打ち切る
    expect(cli.calls).toHaveLength(1);
  });
});

describe('updatePullRequestBranch', () => {
  it('GitHubは gh pr update-branch <number> を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'update-branch'], { code: 0, stdout: '', stderr: '' });
    const result = await updatePullRequestBranch(cli, 'github', '/repo/_integration', 42);
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'gh',
      args: ['pr', 'update-branch', '42'],
      cwd: '/repo/_integration',
    });
  });

  it('GitLabは glab mr rebase <number> を呼ぶ', async () => {
    const cli = new FakeCli();
    cli.respond('glab', ['mr', 'rebase'], { code: 0, stdout: '', stderr: '' });
    const result = await updatePullRequestBranch(cli, 'gitlab', '/repo/_integration', 7);
    expect(result).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual({
      command: 'glab',
      args: ['mr', 'rebase', '7'],
      cwd: '/repo/_integration',
    });
  });

  it('失敗すればメッセージ付きで返す', async () => {
    const cli = new FakeCli();
    cli.respond('gh', ['pr', 'update-branch'], { code: 1, stdout: '', stderr: 'cannot rebase' });
    const result = await updatePullRequestBranch(cli, 'github', '/repo/_integration', 42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('cannot rebase');
    }
  });
});

describe('runFinalMergeWithCiGate（design.md §16.36、Issue #556）', () => {
  const gateConfig = { waitTimeoutMs: 60_000, maxUpdateBranchRetries: 2, now: () => 0 };

  it('CI未設定なら待たずに即マージする（従来どおり）', async () => {
    const cli = new SequencedCli([githubNoChecks, { code: 0, stdout: '', stderr: '' }]);
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, gateConfig);
    expect(result).toEqual({ ok: true });
    expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['pr', 'merge'],
    ]);
  });

  it('CIが緑ならマージする', async () => {
    const cli = new SequencedCli([githubPassed, { code: 0, stdout: '', stderr: '' }]);
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, gateConfig);
    expect(result).toEqual({ ok: true });
  });

  it('CIが赤ならマージせず理由付きで失敗を返す（マージコマンドを呼ばない）', async () => {
    const cli = new SequencedCli([githubFailed]);
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, gateConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ciFailed');
    }
    expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([['pr', 'view']]);
  });

  it('待ち時間の上限を超えたら赤と同じ扱いで失敗を返す（マージコマンドを呼ばない）', async () => {
    const cli = new SequencedCli([githubPending]);
    let now = 0;
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, {
      waitTimeoutMs: 1000,
      maxUpdateBranchRetries: 2,
      now: () => {
        const current = now;
        now += 2000;
        return current;
      },
      wait: async () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ciTimeout');
    }
    expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([['pr', 'view']]);
  });

  it('「baseの最新でない」で拒否されたら取り込み直してから再度CIを待ち、マージを再試行する', async () => {
    const notUpToDate = {
      code: 1,
      stdout: '',
      stderr: 'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)',
    };
    const cli = new SequencedCli([
      githubPassed, // 1回目のCI確認
      notUpToDate, // 1回目のマージ（失敗）
      { code: 0, stdout: '', stderr: '' }, // update-branch
      githubPassed, // 取り込み直し後のCI再確認
      { code: 0, stdout: '', stderr: '' }, // 2回目のマージ（成功）
    ]);
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, gateConfig);
    expect(result).toEqual({ ok: true });
    expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['pr', 'merge'],
      ['pr', 'update-branch'],
      ['pr', 'view'],
      ['pr', 'merge'],
    ]);
  });

  it('「baseの最新でない」以外の失敗（コンフリクト等）は取り込み直しを試みず即座に失敗を返す', async () => {
    const conflict = { code: 1, stdout: '', stderr: 'merge conflict' };
    const cli = new SequencedCli([githubPassed, conflict]);
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, gateConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('mergeFailed');
      expect(result.message).toContain('merge conflict');
    }
    // update-branchは呼ばれない
    expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['pr', 'merge'],
    ]);
  });

  it('取り込み直しが失敗すればそこで失敗を確定する', async () => {
    const notUpToDate = { code: 1, stdout: '', stderr: 'base branch was modified' };
    const updateBranchFailure = { code: 1, stdout: '', stderr: 'cannot rebase: conflict' };
    const cli = new SequencedCli([githubPassed, notUpToDate, updateBranchFailure]);
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, gateConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('updateBranchFailed');
    }
  });

  it('取り込み直しの上限回数を超えて「baseの最新でない」が続けば失敗として確定する', async () => {
    const notUpToDate = { code: 1, stdout: '', stderr: 'base branch was modified' };
    const updateOk = { code: 0, stdout: '', stderr: '' };
    // maxUpdateBranchRetries: 2 → マージ試行は最大3回（初回+2リトライ）
    const cli = new SequencedCli([
      githubPassed,
      notUpToDate,
      updateOk,
      githubPassed,
      notUpToDate,
      updateOk,
      githubPassed,
      notUpToDate,
    ]);
    const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, {
      waitTimeoutMs: 60_000,
      maxUpdateBranchRetries: 2,
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('mergeFailed');
      expect(result.updateBranchAttempts).toBe(2);
    }
    expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['pr', 'merge'],
      ['pr', 'update-branch'],
      ['pr', 'view'],
      ['pr', 'merge'],
      ['pr', 'update-branch'],
      ['pr', 'view'],
      ['pr', 'merge'],
    ]);
  });

  it('番号がundefinedのときはCI確認をせずrunFinalMergeと同じ振る舞いになる（カレントブランチ依存を避ける）', async () => {
    const cli = new FakeCli();
    const result = await runFinalMergeWithCiGate(
      cli,
      'github',
      '/repo/_integration',
      undefined,
      gateConfig,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('番号が不明');
    }
    expect(cli.calls).toEqual([]);
  });

  describe('停止（isCancelled）', () => {
    it('停止を立ててからCI待ちに入ると、その後CIが緑になってもpr mergeは一度も呼ばれない（セキュリティ監査の指摘。2026-08-23）', async () => {
      // pendingが1回続いた後に緑（githubPassed）へ変わる状況を用意する。isCancelled()は
      // 「その1回目のwait()の最中に人が停止した」を模して、1回目の呼び出し以降ずっとtrueを
      // 返す。cli.callsに'pr merge'が一度も現れないことで、CIが後から緑になってもマージへ
      // 進まないことを確かめる（cli.callsで確認する、というレビュー指摘の形そのもの）
      const cli = new SequencedCli([githubPending, githubPassed]);
      let cancelCalls = 0;
      const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, {
        waitTimeoutMs: 60_000,
        maxUpdateBranchRetries: 2,
        now: () => 0,
        wait: async () => {
          // ポーリングの待ち時間中に人が停止した、という状況を模す
        },
        isCancelled: () => {
          cancelCalls += 1;
          return cancelCalls > 1;
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('cancelled');
      }
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
      // 1回目のCI確認（pending）はするが、2回目（passedのはず）は確認する前に打ち切る
      expect(cli.calls).toHaveLength(1);
    });

    it('CIが緑になった直後（マージを呼ぶ直前）に停止していればマージを呼ばずcancelledを返す', async () => {
      // waitForCiChecksが'none'/'passed'で即座に返った直後、runFinalMergeを呼ぶ前にも
      // isCancelledを確認する（waitForCiChecksのポーリングを1回も経ないため、その内部の
      // 確認だけでは捕まえられない抜けを塞ぐ）。1回目（waitForCiChecksのループ先頭）は
      // falseを返して実際にCI状態を取得させ、2回目（runFinalMergeWithCiGate側の、
      // マージ直前の確認）でtrueへ変える
      const cli = new SequencedCli([githubPassed]);
      let calls = 0;
      const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, {
        ...gateConfig,
        isCancelled: () => {
          calls += 1;
          return calls > 1;
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('cancelled');
      }
      expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([['pr', 'view']]);
    });

    it('「baseの最新でない」で拒否された後、取り込み直しを呼ぶ直前に停止していれば取り込み直さずcancelledを返す', async () => {
      const notUpToDate = { code: 1, stdout: '', stderr: 'base branch was modified' };
      const cli = new SequencedCli([githubPassed, notUpToDate]);
      let calls = 0;
      const result = await runFinalMergeWithCiGate(cli, 'github', '/repo/_integration', 42, {
        ...gateConfig,
        isCancelled: () => {
          calls += 1;
          // 1回目（waitForCiChecksのループ先頭）・2回目（マージ直前）は通して、実際に
          // マージが「baseの最新でない」で失敗するところまで進める。3回目
          // （update-branch直前）で停止を検知させる
          return calls > 2;
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('cancelled');
      }
      // update-branchは呼ばれない
      expect(cli.calls.map((c) => c.args.slice(0, 2))).toEqual([
        ['pr', 'view'],
        ['pr', 'merge'],
      ]);
    });
  });
});
