import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  branchName,
  buildTaskBoundary,
  checkWorktreesGitignored,
  CONVENTIONAL_BRANCH_PATTERN,
  decideWorkingDirectory,
  DEFAULT_BRANCH_NAMING,
  isGitWorkingTree,
  isWorkflowBranchName,
  nodeGitCommandRunner,
  nodeWorktreeFileSystem,
  normalizeBranchNaming,
  resolveGitCommonDir,
  resolveHeadCommit,
  shouldRemoveWorktree,
  worktreePath,
  WorktreeCreationQueue,
  type CreateWorktreeRequest,
  type GitCommandResult,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';

/** `runId` はUUID形式で検証されるため、テスト全体で1つの妥当なUUIDを使い回す。 */
const RUN_ID = '11111111-1111-4111-8111-111111111111';

/** テストで使う妥当なコミットSHA（`HEAD_COMMIT_PATTERN` を満たす16進数）。 */
const HEAD_SHA = 'deadbeef';

/** `git` の呼び出しを記録し、プレフィックス一致で応答を差し替えられるフェイク。 */
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

/**
 * 実パス解決と`.gitignore`読み取りをMapで差し替えるフェイク。
 * `pathExists`は「登録が無ければ実在する」を既定にする（`missingPaths`へ登録した
 * パスだけが「無い」扱いになる）。既存のテストの大半は撤去済みディレクトリのケースを
 * 想定していないため、この既定にしておくと影響が最小で済む。
 */
class FakeFs implements WorktreeFileSystemPort {
  realpaths = new Map<string, string>();
  textFiles = new Map<string, string>();
  symlinks = new Set<string>();
  missingPaths = new Set<string>();

  async realpath(target: string): Promise<string | undefined> {
    return this.realpaths.get(target);
  }

  async readTextFile(target: string): Promise<string | undefined> {
    return this.textFiles.get(target);
  }

  async isSymbolicLink(target: string): Promise<boolean> {
    return this.symlinks.has(target);
  }

  async pathExists(target: string): Promise<boolean> {
    return !this.missingPaths.has(target);
  }
}

describe('worktreePath / branchName', () => {
  it('置き場は<repo>/.agents/worktrees/<runId>/<taskId>になる', () => {
    expect(worktreePath('/repo', RUN_ID, 'T2')).toBe(
      path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2'),
    );
  });

  it('並列の2タスクが別のworktreeパスになる', () => {
    const t2 = worktreePath('/repo', RUN_ID, 'T2');
    const t3 = worktreePath('/repo', RUN_ID, 'T3');
    expect(t2).not.toBe(t3);
  });

  it('retryを渡すとディレクトリ名にも-retry<n>が付く（branchNameと対称。high1修正）', () => {
    expect(worktreePath('/repo', RUN_ID, 'T2', 0)).toBe(
      path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2-retry0'),
    );
    expect(worktreePath('/repo', RUN_ID, 'T2', 3)).toBe(
      path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2-retry3'),
    );
  });

  it('ブランチ名はwf/<runId>/<taskId>になる', () => {
    expect(branchName(RUN_ID, 'T2')).toBe(`wf/${RUN_ID}/T2`);
  });

  it('再試行時のブランチ名は-retry<n>付きになる', () => {
    expect(branchName(RUN_ID, 'T2', 0)).toBe(`wf/${RUN_ID}/T2-retry0`);
    expect(branchName(RUN_ID, 'T2', 3)).toBe(`wf/${RUN_ID}/T2-retry3`);
  });

  it('不正なrunId（UUID形式でない）は例外になる', () => {
    expect(() => worktreePath('/repo', 'not-a-uuid', 'T2')).toThrow(/runId/);
    expect(() => branchName('not-a-uuid', 'T2')).toThrow(/runId/);
  });

  it('不正なtaskId（パストラバーサル等）は例外になる', () => {
    expect(() => worktreePath('/repo', RUN_ID, '../../../../etc/evil')).toThrow(/taskId/);
    expect(() => branchName(RUN_ID, '../../../../etc/evil')).toThrow(/taskId/);
  });
});

describe('branchName（options: BranchNamingOptions。GitLab運用規約形式との切替）', () => {
  it('optionsを渡さない場合は既定のwf形式のまま（後方互換）', () => {
    expect(branchName(RUN_ID, 'T2', undefined, undefined)).toBe(`wf/${RUN_ID}/T2`);
  });

  it('naming: wfを明示した場合もwf形式のまま', () => {
    expect(
      branchName(RUN_ID, 'T2', undefined, { naming: 'wf', type: 'feat', issue: 42 }),
    ).toBe(`wf/${RUN_ID}/T2`);
  });

  it('naming: conventionalかつissueありでGitLab運用規約形式<type>/<issue>/<slug>になる', () => {
    const result = branchName(RUN_ID, 'my-task', undefined, {
      naming: 'conventional',
      type: 'fix',
      issue: 42,
    });
    expect(result).toBe(`fix/42/my-task-${RUN_ID.slice(0, 8)}`);
    expect(CONVENTIONAL_BRANCH_PATTERN.test(result)).toBe(true);
  });

  it('typeがfeatのときブランチ名の語彙はfeatureへ読み替える（GitLab運用規約側の語彙に合わせる）', () => {
    const result = branchName(RUN_ID, 'my-task', undefined, {
      naming: 'conventional',
      type: 'feat',
      issue: 7,
    });
    expect(result.startsWith('feature/7/')).toBe(true);
  });

  it('typeが未知の値のときchoreへ倒す（normalizeCommitTypeと同じ既定）', () => {
    const result = branchName(RUN_ID, 'my-task', undefined, {
      naming: 'conventional',
      type: 'bogus',
      issue: 7,
    });
    expect(result.startsWith('chore/7/')).toBe(true);
  });

  it('retryを渡すとslugに-retry<n>が挟まる', () => {
    const result = branchName(RUN_ID, 'my-task', 2, {
      naming: 'conventional',
      type: 'fix',
      issue: 42,
    });
    expect(result).toBe(`fix/42/my-task-retry2-${RUN_ID.slice(0, 8)}`);
  });

  it('naming: conventionalでもissueが未指定ならwf形式へ落とす（対応するIssueが無い場合の後方互換）', () => {
    const result = branchName(RUN_ID, 'T2', undefined, {
      naming: 'conventional',
      type: 'fix',
      issue: undefined,
    });
    expect(result).toBe(`wf/${RUN_ID}/T2`);
  });

  it('長いtaskIdはCONVENTIONAL_BRANCH_PATTERNの30文字制約に収まるよう末尾から削られる', () => {
    const longTaskId = 'a'.repeat(50);
    const result = branchName(RUN_ID, longTaskId, undefined, {
      naming: 'conventional',
      type: 'fix',
      issue: 1,
    });
    expect(CONVENTIONAL_BRANCH_PATTERN.test(result)).toBe(true);
  });
});

describe('normalizeBranchNaming（不正値は既定へ丸める）', () => {
  it('wf/conventionalはそのまま通す', () => {
    expect(normalizeBranchNaming('wf')).toBe('wf');
    expect(normalizeBranchNaming('conventional')).toBe('conventional');
  });

  it('未知の値・空文字はDEFAULT_BRANCH_NAMING（wf）へ丸める', () => {
    expect(normalizeBranchNaming('bogus')).toBe(DEFAULT_BRANCH_NAMING);
    expect(normalizeBranchNaming('')).toBe(DEFAULT_BRANCH_NAMING);
  });
});

describe('isWorkflowBranchName（conventional形式も認識する）', () => {
  it('wf形式・conventional形式のどちらも真になる', () => {
    expect(isWorkflowBranchName(`wf/${RUN_ID}/T2`)).toBe(true);
    expect(isWorkflowBranchName('fix/42/my-task-deadbeef')).toBe(true);
  });

  it('どちらの形にも一致しない文字列は偽になる', () => {
    expect(isWorkflowBranchName('main')).toBe(false);
    expect(isWorkflowBranchName('-rf')).toBe(false);
  });
});

describe('decideWorkingDirectory', () => {
  it('cwdを明示したタスクはisolationに関わらずexplicitCwdになる', () => {
    expect(decideWorkingDirectory({ isolation: 'worktree', cwd: '/explicit' }, true)).toEqual({
      kind: 'explicitCwd',
    });
    expect(decideWorkingDirectory({ isolation: 'shared', cwd: '/explicit' }, false)).toEqual({
      kind: 'explicitCwd',
    });
    expect(
      decideWorkingDirectory({ isolation: 'worktree-strict', cwd: '/explicit' }, false),
    ).toEqual({ kind: 'explicitCwd' });
  });

  it('isolation: sharedはgitの有無に関わらずsharedになる', () => {
    expect(decideWorkingDirectory({ isolation: 'shared', cwd: undefined }, true)).toEqual({
      kind: 'shared',
    });
    expect(decideWorkingDirectory({ isolation: 'shared', cwd: undefined }, false)).toEqual({
      kind: 'shared',
    });
  });

  it('isolation: worktreeはgitならworktreeを作る', () => {
    expect(decideWorkingDirectory({ isolation: 'worktree', cwd: undefined }, true)).toEqual({
      kind: 'worktree',
    });
  });

  it('isolation: worktreeはgitでなければ警告つきでsharedへフォールバックする', () => {
    const decision = decideWorkingDirectory({ isolation: 'worktree', cwd: undefined }, false);
    expect(decision.kind).toBe('sharedFallback');
    if (decision.kind === 'sharedFallback') {
      expect(decision.warning).toContain('shared');
      expect(decision.warning).toContain('{{T.branch}}');
    }
  });

  it('isolation: worktree-strictはgitならworktreeを作る', () => {
    expect(decideWorkingDirectory({ isolation: 'worktree-strict', cwd: undefined }, true)).toEqual({
      kind: 'worktree',
    });
  });

  it('isolation: worktree-strictはgitでなければ実行を開始せずエラーになる', () => {
    const decision = decideWorkingDirectory(
      { isolation: 'worktree-strict', cwd: undefined },
      false,
    );
    expect(decision.kind).toBe('error');
  });
});

describe('shouldRemoveWorktree', () => {
  it.each([
    ['remove', 'done', true],
    ['remove', 'failed', false],
    ['remove', 'pending', false],
    ['remove', 'running', false],
    ['remove', 'skipped', false],
    ['remove', 'merging', false],
    ['remove', 'blocked', false],
    ['keep', 'done', false],
    // design.md §16.17「worktreeの片付け」: after-mergeはdoneの時点で撤去する（remove同様）。
    // failed/blocked/merging/pending/running/skippedは残す
    ['after-merge', 'done', true],
    ['after-merge', 'failed', false],
    ['after-merge', 'blocked', false],
    ['after-merge', 'merging', false],
    ['after-merge', 'pending', false],
    ['after-merge', 'running', false],
    ['after-merge', 'skipped', false],
  ] as const)('cleanup=%s state=%s => %s', (cleanup, state, expected) => {
    expect(shouldRemoveWorktree(cleanup, state)).toBe(expected);
  });
});

describe('WorktreeCreationQueue.create', () => {
  it('isolation: worktreeのタスクが<repo>/.agents/worktrees/<runId>/<taskId>で、ブランチwf/<runId>/<taskId>で作られる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    const queue = new WorktreeCreationQueue();
    const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    const fs = new FakeFs();
    // 作成後の実パス確認（二次防御）が通るよう、リンクの無い通常の作られ方を模す
    fs.realpaths.set(cwd, cwd);
    fs.realpaths.set('/repo', '/repo');

    const result = await queue.create(
      { repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: HEAD_SHA, retry: undefined },
      git,
      fs,
    );

    expect(result).toEqual({
      ok: true,
      cwd: path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2'),
      branch: `wf/${RUN_ID}/T2`,
    });
    expect(git.calls).toEqual([
      { args: ['rev-parse', '--verify', '--quiet', `refs/heads/wf/${RUN_ID}/T2`], cwd: '/repo' },
      {
        args: [
          'worktree',
          'add',
          '-b',
          `wf/${RUN_ID}/T2`,
          path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2'),
          HEAD_SHA,
        ],
        cwd: '/repo',
      },
    ]);
  });

  it('branchNaming: conventionalかつissueありのとき、GitLab運用規約形式のブランチで作られる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    const queue = new WorktreeCreationQueue();
    const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    const fs = new FakeFs();
    fs.realpaths.set(cwd, cwd);
    fs.realpaths.set('/repo', '/repo');

    const result = await queue.create(
      {
        repoRoot: '/repo',
        runId: RUN_ID,
        taskId: 'T2',
        headCommit: HEAD_SHA,
        retry: undefined,
        branchNaming: { naming: 'conventional', type: 'fix', issue: 42 },
      },
      git,
      fs,
    );

    const expectedBranch = `fix/42/t2-${RUN_ID.slice(0, 8)}`;
    expect(result).toEqual({
      ok: true,
      cwd,
      branch: expectedBranch,
    });
    expect(git.calls[0]?.args).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${expectedBranch}`,
    ]);
  });

  it('branchNaming: conventionalでもissue未指定なら、従来どおりwf形式のブランチで作られる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    const queue = new WorktreeCreationQueue();
    const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    const fs = new FakeFs();
    fs.realpaths.set(cwd, cwd);
    fs.realpaths.set('/repo', '/repo');

    const result = await queue.create(
      {
        repoRoot: '/repo',
        runId: RUN_ID,
        taskId: 'T2',
        headCommit: HEAD_SHA,
        retry: undefined,
        branchNaming: { naming: 'conventional', type: 'fix', issue: undefined },
      },
      git,
      fs,
    );

    expect(result).toEqual({
      ok: true,
      cwd,
      branch: `wf/${RUN_ID}/T2`,
    });
  });

  it(
    '作成に成功したときのブランチ名は必ずisWorkflowBranchNameを満たす（多層防御。' +
      'branchName()の生成ロジックの正しさだけに依存しない自己検証を持つことの回帰確認。' +
      'レビュー指摘: pushBranch/mergeTaskBranchと同じくgitへ渡す直前で再検証する）',
    async () => {
      const git = new FakeGit();
      git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
      git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
      const queue = new WorktreeCreationQueue();
      const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
      const fs = new FakeFs();
      fs.realpaths.set(cwd, cwd);
      fs.realpaths.set('/repo', '/repo');

      const result = await queue.create(
        {
          repoRoot: '/repo',
          runId: RUN_ID,
          taskId: 'T2',
          headCommit: HEAD_SHA,
          retry: undefined,
          branchNaming: { naming: 'conventional', type: 'fix', issue: 42 },
        },
        git,
        fs,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(isWorkflowBranchName(result.branch)).toBe(true);
      }
    },
  );

  it('同名のブランチが既にあるときエラーになり、git worktree addを試みない', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 0, stdout: 'sha\n', stderr: '' });
    const queue = new WorktreeCreationQueue();

    const result = await queue.create(
      { repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: HEAD_SHA, retry: undefined },
      git,
      new FakeFs(),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'branchExists',
      message: `ブランチ wf/${RUN_ID}/T2 は既に存在します`,
    });
    expect(git.calls.some((c) => c.args[0] === 'worktree')).toBe(false);
  });

  it('git worktree add自体が失敗したときはgitErrorを返す（worktreeが作られなかったタスクは開始しない前提）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], {
      code: 128,
      stdout: '',
      stderr: 'fatal: something went wrong',
    });
    const queue = new WorktreeCreationQueue();

    const result = await queue.create(
      { repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: HEAD_SHA, retry: undefined },
      git,
      new FakeFs(),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'gitError',
      message: 'fatal: something went wrong',
    });
  });

  it('git worktree addのstderrは無害化してから返す（制御文字の除去・URL中のuserinfoのマスク。レビュー指摘: warning）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], {
      code: 128,
      stdout: '',
      stderr:
        "fatal: unable to access 'https://token123:x-oauth-basic@github.com/org/repo.git/': \x00control",
    });
    const queue = new WorktreeCreationQueue();

    const result = await queue.create(
      { repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: HEAD_SHA, retry: undefined },
      git,
      new FakeFs(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('token123');
    expect(result.message).not.toContain('x-oauth-basic');
    expect(result.message).not.toContain('\x00');
    expect(result.message).toContain('https://***@github.com/org/repo.git/');
  });

  it('不正なrunId/taskIdはinvalidIdentifierを返し、gitを一切呼ばない（high2修正）', async () => {
    const git = new FakeGit();
    const queue = new WorktreeCreationQueue();

    const badRunId = await queue.create(
      {
        repoRoot: '/repo',
        runId: 'not-a-uuid',
        taskId: 'T2',
        headCommit: HEAD_SHA,
        retry: undefined,
      },
      git,
      new FakeFs(),
    );
    expect(badRunId).toMatchObject({ ok: false, reason: 'invalidIdentifier' });

    const badTaskId = await queue.create(
      {
        repoRoot: '/repo',
        runId: RUN_ID,
        taskId: '../../../../etc/evil',
        headCommit: HEAD_SHA,
        retry: undefined,
      },
      git,
      new FakeFs(),
    );
    expect(badTaskId).toMatchObject({ ok: false, reason: 'invalidIdentifier' });

    expect(git.calls).toEqual([]);
  });

  it('不正なheadCommit（フラグとして解釈されうる文字列）はinvalidHeadCommitを返し、gitを一切呼ばない（low1修正）', async () => {
    const git = new FakeGit();
    const queue = new WorktreeCreationQueue();

    const result = await queue.create(
      { repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: '--force', retry: undefined },
      git,
      new FakeFs(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalidHeadCommit' });
    expect(git.calls).toEqual([]);
  });

  it('全タスクが同じHEAD（実行開始時に固定した値）から分岐する', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    const queue = new WorktreeCreationQueue();
    const fs = new FakeFs();
    fs.realpaths.set('/repo', '/repo');
    fs.realpaths.set(
      path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2'),
      path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2'),
    );
    fs.realpaths.set(
      path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T3'),
      path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T3'),
    );

    await queue.create(
      { repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: HEAD_SHA, retry: undefined },
      git,
      fs,
    );
    await queue.create(
      { repoRoot: '/repo', runId: RUN_ID, taskId: 'T3', headCommit: HEAD_SHA, retry: undefined },
      git,
      fs,
    );

    const addCalls = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(addCalls).toHaveLength(2);
    for (const call of addCalls) {
      expect(call.args.at(-1)).toBe(HEAD_SHA);
    }
  });
});

describe('WorktreeCreationQueue.createWithOrigin（Issue #380）', () => {
  it('resolveOriginが返したHEADでworktreeを作り、originCommitとして返す', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    const queue = new WorktreeCreationQueue();
    const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    const fs = new FakeFs();
    fs.realpaths.set(cwd, cwd);
    fs.realpaths.set('/repo', '/repo');

    const result = await queue.createWithOrigin(
      async () => HEAD_SHA,
      (headCommit) => ({
        repoRoot: '/repo',
        runId: RUN_ID,
        taskId: 'T2',
        headCommit,
        retry: undefined,
      }),
      git,
      fs,
    );

    expect(result).toEqual({
      ok: true,
      cwd,
      branch: `wf/${RUN_ID}/T2`,
      originCommit: HEAD_SHA,
    });
    // worktree作成の直前に、渡したHEADで`git worktree add`が呼ばれている
    expect(git.calls.at(-1)).toEqual({
      args: ['worktree', 'add', '-b', `wf/${RUN_ID}/T2`, cwd, HEAD_SHA],
      cwd: '/repo',
    });
  });

  it('resolveOriginがundefinedを返すとheadUnresolvedで失敗し、gitを一切呼ばない', async () => {
    const git = new FakeGit();
    const queue = new WorktreeCreationQueue();
    const fs = new FakeFs();

    const result = await queue.createWithOrigin(
      async () => undefined,
      (headCommit) => ({
        repoRoot: '/repo',
        runId: RUN_ID,
        taskId: 'T2',
        headCommit,
        retry: undefined,
      }),
      git,
      fs,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'headUnresolved',
      message: '統合ブランチのHEADコミットを解決できませんでした',
    });
    expect(git.calls).toEqual([]);
  });

  it(
    'HEAD解決とworktree作成の間に他の項目（マージ相当）が割り込まない' +
      '（分岐元が1マージ分古くなる競合の再現。Issue #380の指摘3）',
    async () => {
      const git = new FakeGit();
      git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
      git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
      const queue = new WorktreeCreationQueue();
      const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
      const fs = new FakeFs();
      fs.realpaths.set(cwd, cwd);
      fs.realpaths.set('/repo', '/repo');

      const order: string[] = [];
      // HEAD解決自体に遅延を挟み、その間に別項目がキューへ割り込もうとする隙を作る
      const createPromise = queue.createWithOrigin(
        async () => {
          order.push('resolveOrigin:start');
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push('resolveOrigin:end');
          return HEAD_SHA;
        },
        (headCommit) => ({
          repoRoot: '/repo',
          runId: RUN_ID,
          taskId: 'T2',
          headCommit,
          retry: undefined,
        }),
        git,
        fs,
      );
      // 「別タスクのマージ」に相当する、同じキューへの割り込み
      const mergePromise = queue.enqueue(async () => {
        order.push('merge');
      });

      await Promise.all([createPromise, mergePromise]);

      // マージ相当の項目は、HEAD解決とworktree作成の間ではなく、両方が終わった後に走る
      expect(order).toEqual(['resolveOrigin:start', 'resolveOrigin:end', 'merge']);
    },
  );
});

describe('WorktreeCreationQueue（直列化）', () => {
  it('worktree作成が直列化され、同時に複数要求してもgit呼び出しが重ならない', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const queue = new WorktreeCreationQueue();

    const makeTask = (label: string) => async (): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${label}`);
      active -= 1;
      return label;
    };

    const results = await Promise.all([
      queue.enqueue(makeTask('T2')),
      queue.enqueue(makeTask('T3')),
      queue.enqueue(makeTask('T4')),
    ]);

    // 直列化されていなければ、20ms遅延の間に複数のタスクが同時にactiveへ入りmaxActiveが2以上になる。
    expect(maxActive).toBe(1);
    expect(results).toEqual(['T2', 'T3', 'T4']);
    expect(order).toEqual(['start:T2', 'end:T2', 'start:T3', 'end:T3', 'start:T4', 'end:T4']);
  });

  it('前の項目が失敗しても後続の実行を妨げない', async () => {
    const queue = new WorktreeCreationQueue();
    const failing = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const following = queue.enqueue(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });

  it('createとremoveも同じキューに乗り、gitを実際に呼ぶまで直列化される（low2修正）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    git.respond(['status', '--porcelain'], { code: 0, stdout: '', stderr: '' });
    git.respond(['worktree', 'remove'], { code: 0, stdout: '', stderr: '' });
    const queue = new WorktreeCreationQueue();
    const fs = new FakeFs();
    const createdCwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    fs.realpaths.set('/repo', '/repo');
    fs.realpaths.set(createdCwd, createdCwd);

    const results = await Promise.all([
      queue.create(
        { repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: HEAD_SHA, retry: undefined },
        git,
        fs,
      ),
      queue.remove('/repo', RUN_ID, 'T3', undefined, git, fs),
    ]);

    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toEqual({ ok: true });
  });
});

describe('WorktreeCreationQueue.remove', () => {
  it('未コミットの変更があるworktreeは撤去されず警告になる', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: ' M file.txt\n', stderr: '' });
    const fs = new FakeFs();
    const queue = new WorktreeCreationQueue();

    const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    const result = await queue.remove('/repo', RUN_ID, 'T2', undefined, git, fs);

    expect(result).toEqual({
      ok: false,
      reason: 'uncommittedChanges',
      message: `未コミットの変更があるため撤去しませんでした: ${cwd}`,
    });
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
  });

  it('クリーンなworktreeはgit worktree removeで撤去される（ディレクトリを直接消さない）', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: '', stderr: '' });
    git.respond(['worktree', 'remove'], { code: 0, stdout: '', stderr: '' });
    const fs = new FakeFs();
    const queue = new WorktreeCreationQueue();

    const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    const result = await queue.remove('/repo', RUN_ID, 'T2', undefined, git, fs);

    expect(result).toEqual({ ok: true });
    expect(git.calls).toEqual([
      { args: ['status', '--porcelain'], cwd },
      { args: ['worktree', 'remove', cwd], cwd: '/repo' },
    ]);
  });

  it('git statusの取得自体が失敗したらgitErrorを返す（本物のgitエラーは従来どおり失敗にする）', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    const fs = new FakeFs();
    const queue = new WorktreeCreationQueue();

    const result = await queue.remove('/repo', RUN_ID, 'T2', undefined, git, fs);
    expect(result).toEqual({
      ok: false,
      reason: 'gitError',
      message: 'fatal: not a git repository',
    });
  });

  it('不正なrunId/taskIdはinvalidIdentifierを返し、gitを一切呼ばない（high2修正）', async () => {
    const git = new FakeGit();
    const fs = new FakeFs();
    const queue = new WorktreeCreationQueue();

    const result = await queue.remove('/repo', 'not-a-uuid', 'T2', undefined, git, fs);
    expect(result).toMatchObject({ ok: false, reason: 'invalidIdentifier' });
    expect(git.calls).toEqual([]);
  });

  it('生のパスではなくrepoRoot/runId/taskId/retryから自分でパスを組み立てる（medium1修正）', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: '', stderr: '' });
    git.respond(['worktree', 'remove'], { code: 0, stdout: '', stderr: '' });
    const fs = new FakeFs();
    const queue = new WorktreeCreationQueue();

    const expectedCwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2-retry1');
    const result = await queue.remove('/repo', RUN_ID, 'T2', 1, git, fs);

    expect(result).toEqual({ ok: true });
    expect(git.calls[0]).toEqual({ args: ['status', '--porcelain'], cwd: expectedCwd });
    expect(git.calls[1]).toEqual({
      args: ['worktree', 'remove', expectedCwd],
      cwd: '/repo',
    });
  });

  it('cwdが既に存在しない（撤去済み）ならgitを呼ばずに成功として扱う（Issue #252修正）', async () => {
    // 既定のcleanup: after-mergeで自動撤去済みのworktreeへワークフローViewの
    // 「worktreeを撤去」がもう一度触ったケース。cwd不在でspawnがENOENTを返す前に
    // 存在確認で弾き、gitを一切呼ばない
    const git = new FakeGit();
    const fs = new FakeFs();
    const cwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    fs.missingPaths.add(cwd);
    const queue = new WorktreeCreationQueue();

    const result = await queue.remove('/repo', RUN_ID, 'T2', undefined, git, fs);

    expect(result).toEqual({ ok: true });
    expect(git.calls).toEqual([]);
  });
});

describe('checkWorktreesGitignored', () => {
  it('.gitignoreが無ければ追記を促す', async () => {
    const fs = new FakeFs();
    const result = await checkWorktreesGitignored('/repo', fs);
    expect(result.needsEntry).toBe(true);
    expect(result.message).toContain('.agents/worktrees/');
  });

  it('.agents/worktrees/が書かれていれば追記を促さない', async () => {
    const fs = new FakeFs();
    fs.textFiles.set(path.join('/repo', '.gitignore'), 'node_modules/\n.agents/worktrees/\n');
    const result = await checkWorktreesGitignored('/repo', fs);
    expect(result).toEqual({ needsEntry: false, message: undefined });
  });

  it('.agents/のような上位ディレクトリのignoreでも追記を促さない', async () => {
    const fs = new FakeFs();
    fs.textFiles.set(path.join('/repo', '.gitignore'), '.agents/\n');
    const result = await checkWorktreesGitignored('/repo', fs);
    expect(result.needsEntry).toBe(false);
  });

  it('無関係な内容だけなら追記を促す', async () => {
    const fs = new FakeFs();
    fs.textFiles.set(path.join('/repo', '.gitignore'), 'dist/\n');
    const result = await checkWorktreesGitignored('/repo', fs);
    expect(result.needsEntry).toBe(true);
  });
});

describe('resolveGitCommonDir', () => {
  it('git rev-parse --git-common-dirの結果を実パス解決したものになる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], { code: 0, stdout: '.git\n', stderr: '' });
    const fs = new FakeFs();
    fs.realpaths.set(path.resolve('/repo', '.git'), '/real/repo/.git');

    const result = await resolveGitCommonDir('/repo', git, fs);
    expect(result).toEqual({ ok: true, value: '/real/repo/.git' });
  });

  it('gitでないときnotGitになる（正常系）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    const fs = new FakeFs();

    const result = await resolveGitCommonDir('/repo', git, fs);
    expect(result).toEqual({ ok: false, reason: 'notGit' });
  });

  it('gitコマンドが「gitでない」以外の理由で失敗したときはcommandFailedになる（notGitとは区別する。medium2修正）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], {
      code: 1,
      stdout: '',
      stderr: 'fatal: unable to read some other error',
    });
    const fs = new FakeFs();

    const result = await resolveGitCommonDir('/repo', git, fs);
    expect(result).toEqual({
      ok: false,
      reason: 'commandFailed',
      message: 'fatal: unable to read some other error',
    });
  });

  it('実パス解決が失敗したときはrealpathFailedになる（medium2修正）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], { code: 0, stdout: '.git', stderr: '' });
    const fs = new FakeFs(); // realpathを登録しない = 解決失敗

    const result = await resolveGitCommonDir('/repo', git, fs);
    expect(result).toEqual({
      ok: false,
      reason: 'realpathFailed',
      path: path.resolve('/repo', '.git'),
    });
  });
});

describe('buildTaskBoundary', () => {
  it('実パス解決済みのallowedRootsとgitCommonDirを組み立てる（警告は無い）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], { code: 0, stdout: '.git', stderr: '' });
    const fs = new FakeFs();
    const rawRoot = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T1');
    fs.realpaths.set(rawRoot, `/real/repo/.agents/worktrees/${RUN_ID}/T1`);
    fs.realpaths.set(path.resolve('/repo', '.git'), '/real/repo/.git');

    const result = await buildTaskBoundary([rawRoot], '/repo', git, fs);

    expect(result).toEqual({
      boundary: {
        allowedRoots: [`/real/repo/.agents/worktrees/${RUN_ID}/T1`],
        gitCommonDir: '/real/repo/.git',
      },
      gitCommonDirWarning: undefined,
    });
  });

  it('gitでないときgitCommonDirがundefinedになり、警告も出ない（正常系）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    const fs = new FakeFs();
    fs.realpaths.set('/work', '/work');

    const result = await buildTaskBoundary(['/work'], '/work', git, fs);
    expect(result.boundary.gitCommonDir).toBeUndefined();
    expect(result.gitCommonDirWarning).toBeUndefined();
  });

  it('git-common-dirの取得が「gitでない」以外の理由で失敗したときは警告付きで返す（medium2修正）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], {
      code: 1,
      stdout: '',
      stderr: 'fatal: index file corrupt',
    });
    const fs = new FakeFs();
    fs.realpaths.set('/work', '/work');

    const result = await buildTaskBoundary(['/work'], '/work', git, fs);
    expect(result.boundary.gitCommonDir).toBeUndefined();
    expect(result.gitCommonDirWarning).toContain('commandFailed');
    expect(result.gitCommonDirWarning).toContain('fatal: index file corrupt');
  });

  it('実パス解決できないrootは黙って除く', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    const fs = new FakeFs();

    const result = await buildTaskBoundary(['/does-not-exist'], '/repo', git, fs);
    expect(result.boundary.allowedRoots).toEqual([]);
  });
});

/**
 * ここから下は実際の `git` バイナリを使った統合テスト。フェイクだけでは
 * 「worktreeの`.git`が実体ファイルであること」「未コミットの変更を実際にgitがどう見せるか」
 * 「execFileが本当にシェルを経由しないか」「failedで残ったworktreeとリトライの衝突」までは
 * 確認できないため、実機で確かめる。
 */
describe('実gitでの統合テスト', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'worktree-repo-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'worktree-test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Worktree Test'], { cwd: repoDir });
    await writeFile(path.join(repoDir, 'README.md'), 'init\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('gitの作業ツリーであることを実際に判定できる', async () => {
    await expect(isGitWorkingTree(repoDir, nodeGitCommandRunner)).resolves.toBe(true);
  });

  it('gitでないディレクトリはfalseになる', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'worktree-plain-'));
    try {
      await expect(isGitWorkingTree(plain, nodeGitCommandRunner)).resolves.toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('HEADコミットを実際に解決できる', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('WorktreeCreationQueue.createが実際にworktreeとブランチを作る。同名ブランチの2回目はエラーになる', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    expect(head).toBeDefined();
    const queue = new WorktreeCreationQueue();
    const request: CreateWorktreeRequest = {
      repoRoot: repoDir,
      runId: RUN_ID,
      taskId: 'T1',
      headCommit: head as string,
      retry: undefined,
    };

    const first = await queue.create(request, nodeGitCommandRunner, nodeWorktreeFileSystem);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.branch).toBe(`wf/${RUN_ID}/T1`);
      expect(first.cwd).toBe(worktreePath(repoDir, RUN_ID, 'T1'));
      await expect(stat(first.cwd)).resolves.toBeDefined();
    }

    const second = await queue.create(request, nodeGitCommandRunner, nodeWorktreeFileSystem);
    expect(second).toMatchObject({ ok: false, reason: 'branchExists' });
  });

  it('1回目のworktreeがfailedで残ったままでも、リトライは別ディレクトリ・別ブランチで成功する（high1修正）', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    const queue = new WorktreeCreationQueue();

    const first = await queue.create(
      {
        repoRoot: repoDir,
        runId: RUN_ID,
        taskId: 'T1',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(first.ok).toBe(true);
    // design.mdの規則どおり、failedになったタスクのworktreeは撤去せず残す
    // （`shouldRemoveWorktree` は `done` のときしか撤去を許さない）。ここでは撤去せず放置する。

    const retry = await queue.create(
      { repoRoot: repoDir, runId: RUN_ID, taskId: 'T1', headCommit: head as string, retry: 0 },
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );

    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.cwd).not.toBe(first.cwd);
      expect(retry.branch).toBe(`wf/${RUN_ID}/T1-retry0`);
      // 修正前は同じディレクトリへの2回目の`git worktree add`が
      // `fatal: '<path>' already exists` で必ず失敗していた。
      await expect(stat(first.cwd)).resolves.toBeDefined();
      await expect(stat(retry.cwd)).resolves.toBeDefined();
    }
  });

  it('worktreeのgit-common-dirは親リポジトリの.gitを指す（実パス解決込み）', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    const queue = new WorktreeCreationQueue();
    const created = await queue.create(
      {
        repoRoot: repoDir,
        runId: RUN_ID,
        taskId: 'T1',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const commonDir = await resolveGitCommonDir(
      created.cwd,
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    const expected = await nodeWorktreeFileSystem.realpath(path.join(repoDir, '.git'));
    expect(commonDir).toEqual({ ok: true, value: expected });
  });

  it('未コミットの変更があるworktreeはWorktreeCreationQueue.removeで撤去されず警告になる。クリーンなworktreeは実際に撤去される', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    const queue = new WorktreeCreationQueue();

    const clean = await queue.create(
      {
        repoRoot: repoDir,
        runId: RUN_ID,
        taskId: 'Clean',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    const dirty = await queue.create(
      {
        repoRoot: repoDir,
        runId: RUN_ID,
        taskId: 'Dirty',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(true);
    if (!clean.ok || !dirty.ok) return;

    await writeFile(path.join(dirty.cwd, 'uncommitted.txt'), 'まだコミットしていない\n');

    const dirtyResult = await queue.remove(
      repoDir,
      RUN_ID,
      'Dirty',
      undefined,
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(dirtyResult).toMatchObject({ ok: false, reason: 'uncommittedChanges' });
    await expect(stat(dirty.cwd)).resolves.toBeDefined();

    const cleanResult = await queue.remove(
      repoDir,
      RUN_ID,
      'Clean',
      undefined,
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(cleanResult).toEqual({ ok: true });
    await expect(stat(clean.cwd)).rejects.toThrow();
  });

  it('撤去済み（既にディレクトリが無い）worktreeへもう一度removeしても成功のまま（実環境でのENOENT再現。Issue #252）', async () => {
    // 修正前は、既に撤去済みのcwdへ`git status --porcelain`を投げると`spawn git ENOENT`
    // （cwd不在によるもので「gitが無い」わけではない）になり、gitErrorとして失敗していた
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    const queue = new WorktreeCreationQueue();

    const created = await queue.create(
      {
        repoRoot: repoDir,
        runId: RUN_ID,
        taskId: 'AlreadyGone',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await queue.remove(
      repoDir,
      RUN_ID,
      'AlreadyGone',
      undefined,
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(first).toEqual({ ok: true });
    await expect(stat(created.cwd)).rejects.toThrow();

    // ここでディレクトリは既に無い。ワークフローViewの「worktreeを撤去」を
    // もう一度押した状況を再現する
    const second = await queue.remove(
      repoDir,
      RUN_ID,
      'AlreadyGone',
      undefined,
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    expect(second).toEqual({ ok: true });
  });

  it('シェルメタ文字を含む引数がシェル解釈されない（execFileでargv配列を渡すため）', async () => {
    const marker = path.join(repoDir, 'injected.txt');
    // シェルなら`;`以降が別コマンドとして実行されファイルが作られてしまうが、
    // execFileはargv配列をそのまま渡すため`--pretty=...`という1つの引数の中身でしかない。
    await nodeGitCommandRunner.run(['log', '-1', `--pretty=%H; touch ${marker}`], repoDir);
    await expect(stat(marker)).rejects.toThrow();
  });

  /**
   * `.agents/worktrees` がシンボリックリンクだと、文字列結合だけで組み立てた
   * `worktreePath` の実体はリンク先（リポジトリの外）になる（design.md §16.6、
   * レビュー指摘: critical 4）。`git worktree add` 自体はエラーにならずリンクを
   * 黙って辿ってしまうため、一次防御（事前のリンク検知）が無いと気づけない。
   */
  it('.agents/worktreesがシンボリックリンクだと、worktreeの作成を拒否しリポジトリの外に何も作らない', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'worktree-outside-'));
    try {
      await mkdir(path.join(repoDir, '.agents'), { recursive: true });
      // リポジトリの中身（cloneしただけで手に入る）がリンクを仕込める、という前提を再現する
      await symlink(outsideDir, path.join(repoDir, '.agents', 'worktrees'));

      const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
      expect(head).toBeDefined();
      const queue = new WorktreeCreationQueue();

      const result = await queue.create(
        {
          repoRoot: repoDir,
          runId: RUN_ID,
          taskId: 'T1',
          headCommit: head as string,
          retry: undefined,
        },
        nodeGitCommandRunner,
        nodeWorktreeFileSystem,
      );

      expect(result).toMatchObject({ ok: false, reason: 'symlinkDetected' });
      // リンク先（リポジトリの外）に何も作られていないことを実際に確認する
      await expect(readdir(outsideDir)).resolves.toEqual([]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
