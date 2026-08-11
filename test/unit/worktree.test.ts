import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  branchName,
  buildTaskBoundary,
  checkWorktreesGitignored,
  createWorktree,
  decideWorkingDirectory,
  isGitWorkingTree,
  nodeGitCommandRunner,
  nodeWorktreeFileSystem,
  removeWorktree,
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

/** 実パス解決と`.gitignore`読み取りをMapで差し替えるフェイク。 */
class FakeFs implements WorktreeFileSystemPort {
  realpaths = new Map<string, string>();
  textFiles = new Map<string, string>();

  async realpath(target: string): Promise<string | undefined> {
    return this.realpaths.get(target);
  }

  async readTextFile(target: string): Promise<string | undefined> {
    return this.textFiles.get(target);
  }
}

describe('worktreePath / branchName', () => {
  it('置き場は<repo>/.agents/worktrees/<runId>/<taskId>になる', () => {
    expect(worktreePath('/repo', 'run1', 'T2')).toBe(
      path.join('/repo', '.agents', 'worktrees', 'run1', 'T2'),
    );
  });

  it('並列の2タスクが別のworktreeパスになる', () => {
    const t2 = worktreePath('/repo', 'run1', 'T2');
    const t3 = worktreePath('/repo', 'run1', 'T3');
    expect(t2).not.toBe(t3);
  });

  it('ブランチ名はwf/<runId>/<taskId>になる', () => {
    expect(branchName('run1', 'T2')).toBe('wf/run1/T2');
  });

  it('再試行時のブランチ名は-retry<n>付きになる', () => {
    expect(branchName('run1', 'T2', 0)).toBe('wf/run1/T2-retry0');
    expect(branchName('run1', 'T2', 3)).toBe('wf/run1/T2-retry3');
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
    ['keep', 'done', false],
  ] as const)('cleanup=%s state=%s => %s', (cleanup, state, expected) => {
    expect(shouldRemoveWorktree(cleanup, state)).toBe(expected);
  });
});

describe('createWorktree', () => {
  it('isolation: worktreeのタスクが<repo>/.agents/worktrees/<runId>/<taskId>で、ブランチwf/<runId>/<taskId>で作られる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });

    const result = await createWorktree(
      { repoRoot: '/repo', runId: 'run1', taskId: 'T2', headCommit: 'deadbeef', retry: undefined },
      git,
    );

    expect(result).toEqual({
      ok: true,
      cwd: path.join('/repo', '.agents', 'worktrees', 'run1', 'T2'),
      branch: 'wf/run1/T2',
    });
    expect(git.calls).toEqual([
      { args: ['rev-parse', '--verify', '--quiet', 'refs/heads/wf/run1/T2'], cwd: '/repo' },
      {
        args: [
          'worktree',
          'add',
          '-b',
          'wf/run1/T2',
          path.join('/repo', '.agents', 'worktrees', 'run1', 'T2'),
          'deadbeef',
        ],
        cwd: '/repo',
      },
    ]);
  });

  it('同名のブランチが既にあるときエラーになり、git worktree addを試みない', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 0, stdout: 'sha\n', stderr: '' });

    const result = await createWorktree(
      { repoRoot: '/repo', runId: 'run1', taskId: 'T2', headCommit: 'deadbeef', retry: undefined },
      git,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'branchExists',
      message: 'ブランチ wf/run1/T2 は既に存在します',
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

    const result = await createWorktree(
      { repoRoot: '/repo', runId: 'run1', taskId: 'T2', headCommit: 'deadbeef', retry: undefined },
      git,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'gitError',
      message: 'fatal: something went wrong',
    });
  });

  it('全タスクが同じHEAD（実行開始時に固定した値）から分岐する', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });

    const fixedHead = 'fixed-head-sha';
    await createWorktree(
      { repoRoot: '/repo', runId: 'run1', taskId: 'T2', headCommit: fixedHead, retry: undefined },
      git,
    );
    await createWorktree(
      { repoRoot: '/repo', runId: 'run1', taskId: 'T3', headCommit: fixedHead, retry: undefined },
      git,
    );

    const addCalls = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(addCalls).toHaveLength(2);
    for (const call of addCalls) {
      expect(call.args.at(-1)).toBe(fixedHead);
    }
  });
});

describe('WorktreeCreationQueue', () => {
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
});

describe('removeWorktree', () => {
  it('未コミットの変更があるworktreeは撤去されず警告になる', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: ' M file.txt\n', stderr: '' });

    const cwd = path.join('/repo', '.agents', 'worktrees', 'run1', 'T2');
    const result = await removeWorktree(cwd, '/repo', git);

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

    const cwd = path.join('/repo', '.agents', 'worktrees', 'run1', 'T2');
    const result = await removeWorktree(cwd, '/repo', git);

    expect(result).toEqual({ ok: true });
    expect(git.calls).toEqual([
      { args: ['status', '--porcelain'], cwd },
      { args: ['worktree', 'remove', cwd], cwd: '/repo' },
    ]);
  });

  it('git statusの取得自体が失敗したらgitErrorを返す', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });

    const result = await removeWorktree('/repo/.agents/worktrees/run1/T2', '/repo', git);
    expect(result).toEqual({
      ok: false,
      reason: 'gitError',
      message: 'fatal: not a git repository',
    });
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
    expect(result).toBe('/real/repo/.git');
  });

  it('gitでないときundefinedになる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    const fs = new FakeFs();

    await expect(resolveGitCommonDir('/repo', git, fs)).resolves.toBeUndefined();
  });
});

describe('buildTaskBoundary', () => {
  it('実パス解決済みのallowedRootsとgitCommonDirを組み立てる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], { code: 0, stdout: '.git', stderr: '' });
    const fs = new FakeFs();
    const rawRoot = path.join('/repo', '.agents', 'worktrees', 'run1', 'T1');
    fs.realpaths.set(rawRoot, '/real/repo/.agents/worktrees/run1/T1');
    fs.realpaths.set(path.resolve('/repo', '.git'), '/real/repo/.git');

    const boundary = await buildTaskBoundary([rawRoot], '/repo', git, fs);

    expect(boundary).toEqual({
      allowedRoots: ['/real/repo/.agents/worktrees/run1/T1'],
      gitCommonDir: '/real/repo/.git',
    });
  });

  it('gitでないときgitCommonDirがundefinedになる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], { code: 128, stdout: '', stderr: '' });
    const fs = new FakeFs();
    fs.realpaths.set('/work', '/work');

    const boundary = await buildTaskBoundary(['/work'], '/work', git, fs);
    expect(boundary.gitCommonDir).toBeUndefined();
    expect(boundary.allowedRoots).toEqual(['/work']);
  });

  it('実パス解決できないrootは黙って除く', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--git-common-dir'], { code: 128, stdout: '', stderr: '' });
    const fs = new FakeFs();

    const boundary = await buildTaskBoundary(['/does-not-exist'], '/repo', git, fs);
    expect(boundary.allowedRoots).toEqual([]);
  });
});

/**
 * ここから下は実際の `git` バイナリを使った統合テスト。フェイクだけでは
 * 「worktreeの`.git`が実体ファイルであること」「未コミットの変更を実際にgitがどう見せるか」
 * 「execFileが本当にシェルを経由しないか」までは確認できないため、実機で確かめる。
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

  it('createWorktreeが実際にworktreeとブランチを作る。同名ブランチの2回目はエラーになる', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    expect(head).toBeDefined();
    const request: CreateWorktreeRequest = {
      repoRoot: repoDir,
      runId: 'run1',
      taskId: 'T1',
      headCommit: head as string,
      retry: undefined,
    };

    const first = await createWorktree(request, nodeGitCommandRunner);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.branch).toBe('wf/run1/T1');
      expect(first.cwd).toBe(worktreePath(repoDir, 'run1', 'T1'));
      await expect(stat(first.cwd)).resolves.toBeDefined();
    }

    const second = await createWorktree(request, nodeGitCommandRunner);
    expect(second).toMatchObject({ ok: false, reason: 'branchExists' });
  });

  it('worktreeのgit-common-dirは親リポジトリの.gitを指す（実パス解決込み）', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);
    const created = await createWorktree(
      {
        repoRoot: repoDir,
        runId: 'run1',
        taskId: 'T1',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const commonDir = await resolveGitCommonDir(
      created.cwd,
      nodeGitCommandRunner,
      nodeWorktreeFileSystem,
    );
    const expected = await nodeWorktreeFileSystem.realpath(path.join(repoDir, '.git'));
    expect(commonDir).toBe(expected);
  });

  it('未コミットの変更があるworktreeはremoveWorktreeで撤去されず警告になる。クリーンなworktreeは実際に撤去される', async () => {
    const head = await resolveHeadCommit(repoDir, nodeGitCommandRunner);

    const clean = await createWorktree(
      {
        repoRoot: repoDir,
        runId: 'run1',
        taskId: 'Clean',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
    );
    const dirty = await createWorktree(
      {
        repoRoot: repoDir,
        runId: 'run1',
        taskId: 'Dirty',
        headCommit: head as string,
        retry: undefined,
      },
      nodeGitCommandRunner,
    );
    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(true);
    if (!clean.ok || !dirty.ok) return;

    await writeFile(path.join(dirty.cwd, 'uncommitted.txt'), 'まだコミットしていない\n');

    const dirtyResult = await removeWorktree(dirty.cwd, repoDir, nodeGitCommandRunner);
    expect(dirtyResult).toMatchObject({ ok: false, reason: 'uncommittedChanges' });
    await expect(stat(dirty.cwd)).resolves.toBeDefined();

    const cleanResult = await removeWorktree(clean.cwd, repoDir, nodeGitCommandRunner);
    expect(cleanResult).toEqual({ ok: true });
    await expect(stat(clean.cwd)).rejects.toThrow();
  });

  it('シェルメタ文字を含む引数がシェル解釈されない（execFileでargv配列を渡すため）', async () => {
    const marker = path.join(repoDir, 'injected.txt');
    // シェルなら`;`以降が別コマンドとして実行されファイルが作られてしまうが、
    // execFileはargv配列をそのまま渡すため`--pretty=...`という1つの引数の中身でしかない。
    await nodeGitCommandRunner.run(['log', '-1', `--pretty=%H; touch ${marker}`], repoDir);
    await expect(stat(marker)).rejects.toThrow();
  });
});
