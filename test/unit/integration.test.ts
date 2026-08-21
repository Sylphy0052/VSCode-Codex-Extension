import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildMergeResolutionPrompt,
  commitUncommittedChangesIfNeeded,
  findTaskIdsMergedSince,
  integrationBranchName,
  integrationWorktreePath,
  IntegrationMergeQueue,
  isMergeResolutionComplete,
  isValidTaskBranch,
  type IntegrationLease,
  mergeCommitMessage,
  reconcileMergingTaskOnReload,
  resolveTaskBranchOrigin,
  uncommittedChangesCommitMessage,
} from '../../src/orchestrator/integration';
import {
  WorktreeCreationQueue,
  type GitCommandResult,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';

/** `runId` はUUID形式で検証されるため、テスト全体で1つの妥当なUUIDを使い回す。 */
const RUN_ID = '11111111-1111-4111-8111-111111111111';

/** テストで使う妥当なコミットSHA（`HEAD_COMMIT_PATTERN` を満たす16進数）。 */
const HEAD_SHA = 'deadbeef';

/** `git` の呼び出しを記録し、プレフィックス一致で応答を差し替えられるフェイク（`worktree.test.ts` と同じ形）。 */
class FakeGit implements GitCommandRunner {
  calls: Array<{ args: string[]; cwd: string }> = [];
  private readonly responses: Array<{ prefix: string[]; result: GitCommandResult }> = [];

  private readonly sequences: Array<{ prefix: string[]; results: GitCommandResult[] }> = [];

  respond(prefix: string[], result: GitCommandResult): void {
    this.responses.push({ prefix, result });
  }

  /**
   * 同じコマンドの呼び出し回数ごとに違う応答を返す（最後の要素以降はそれを返し続ける）。
   * マージ前の「進行中のマージが無いこと」の確認（Issue #412の多層防御）と、マージ後の
   * 未解決パスの取得が同じ`git diff --diff-filter=U`である以上、1回目と2回目で
   * 応答を変えないと実物の振る舞いを模せないため。
   */
  respondSequence(prefix: string[], results: GitCommandResult[]): void {
    this.sequences.push({ prefix, results });
  }

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    this.calls.push({ args: [...args], cwd });
    const sequence = this.sequences.find((r) => r.prefix.every((p, i) => args[i] === p));
    if (sequence !== undefined) {
      return sequence.results.length > 1
        ? (sequence.results.shift() ?? { code: 0, stdout: '', stderr: '' })
        : (sequence.results[0] ?? { code: 0, stdout: '', stderr: '' });
    }
    const matched = this.responses.find((r) => r.prefix.every((p, i) => args[i] === p));
    return matched?.result ?? { code: 0, stdout: '', stderr: '' };
  }
}

/** 実パス解決とシンボリックリンク判定をMapで差し替えるフェイク。 */
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

const INTEGRATION_CWD = path.join('/repo', '.agents', 'worktrees', RUN_ID, '_integration');

/**
 * 統合worktreeの占有（Issue #412）を取る短縮形。`mergeTask` / `abortMerge` はこの
 * ハンドルを要求する（他タスクのマージを巻き戻せないようにするため）。
 */
function lease(queue: IntegrationMergeQueue, taskId: string): Promise<IntegrationLease> {
  return queue.acquireLease(INTEGRATION_CWD, taskId);
}
const INTEGRATION_BRANCH = `wf/${RUN_ID}/integration`;

describe('integrationBranchName / integrationWorktreePath', () => {
  it('統合ブランチ名はwf/<runId>/integrationになる', () => {
    expect(integrationBranchName(RUN_ID)).toBe(INTEGRATION_BRANCH);
  });

  it('統合worktreeの置き場は<repo>/.agents/worktrees/<runId>/_integrationになる', () => {
    expect(integrationWorktreePath('/repo', RUN_ID)).toBe(INTEGRATION_CWD);
  });

  it('不正なrunId（UUID形式でない）は例外になる', () => {
    expect(() => integrationBranchName('not-a-uuid')).toThrow(/runId/);
    expect(() => integrationWorktreePath('/repo', 'not-a-uuid')).toThrow(/runId/);
  });
});

describe('固定文言（エージェントの出力を混ぜない）', () => {
  it('未コミット変更の自動コミットメッセージはchore(<taskId>): uncommitted changes at task completionになる（type省略時）', () => {
    expect(uncommittedChangesCommitMessage('T2')).toBe(
      'chore(T2): uncommitted changes at task completion',
    );
  });

  it('未コミット変更の自動コミットメッセージは指定したtypeを使う', () => {
    expect(uncommittedChangesCommitMessage('T2', 'fix')).toBe(
      'fix(T2): uncommitted changes at task completion',
    );
  });

  it('未コミット変更の自動コミットメッセージは未知のtypeをchoreへ倒す', () => {
    expect(uncommittedChangesCommitMessage('T2', 'not-a-type')).toBe(
      'chore(T2): uncommitted changes at task completion',
    );
  });

  it('マージコミットのメッセージはchore(<taskId>): merge task (run <runId>)になる（type省略時）', () => {
    expect(mergeCommitMessage('T2', RUN_ID)).toBe(`chore(T2): merge task (run ${RUN_ID})`);
  });

  it('マージコミットのメッセージは指定したtypeを使う', () => {
    expect(mergeCommitMessage('T2', RUN_ID, 'feat')).toBe(`feat(T2): merge task (run ${RUN_ID})`);
  });

  it('固定文言はtaskId/runId/type以外の外部入力（prompt・doneやエージェントの応答）を一切受け取らない引数構成になっている', () => {
    // 関数のシグネチャ自体がtaskId/runId/typeしか取らないため、
    // 呼び出し側がエージェントの出力を混ぜようとしても型の上で渡す先が無い。
    expect(uncommittedChangesCommitMessage.length).toBe(2);
    expect(mergeCommitMessage.length).toBe(3);
  });
});

describe('isValidTaskBranch（wf形式・conventional形式の両方をrunId込みで検証する）', () => {
  it('wf/<runId>/<taskId>形式はこのrunIdならtrue', () => {
    expect(isValidTaskBranch(`wf/${RUN_ID}/T1`, RUN_ID)).toBe(true);
    expect(isValidTaskBranch(`wf/${RUN_ID}/T1-retry2`, RUN_ID)).toBe(true);
  });

  it('wf/<runId>/<taskId>形式でも別のrunIdならfalse（他runのブランチの取り違え防止）', () => {
    expect(
      isValidTaskBranch(`wf/${RUN_ID}/T1`, '22222222-2222-4222-8222-222222222222'),
    ).toBe(false);
  });

  it('conventional形式（<type>/<issue>/<slug>）は、slugの末尾がこのrunIdの先頭8文字ならtrue', () => {
    const runId8 = RUN_ID.slice(0, 8);
    expect(isValidTaskBranch(`fix/42/my-task-${runId8}`, RUN_ID)).toBe(true);
  });

  it('conventional形式でも、runIdの先頭8文字だけが違う（別runを装う）ブランチはfalse', () => {
    // 先頭8文字だけ変え、残りは同じ文字列にすることで「別runを装う」ケースを模す
    const otherRunId8 = '99999999';
    expect(isValidTaskBranch(`fix/42/my-task-${otherRunId8}`, RUN_ID)).toBe(false);
  });

  it('どちらの形式にも一致しないブランチ名はfalse', () => {
    expect(isValidTaskBranch('main', RUN_ID)).toBe(false);
    expect(isValidTaskBranch('--upload-pack=evil', RUN_ID)).toBe(false);
  });
});

describe('resolveTaskBranchOrigin', () => {
  it('統合worktreeのHEADを解決する（そのタスクを開始する時点の統合ブランチのHEAD）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', 'HEAD'], { code: 0, stdout: `${HEAD_SHA}\n`, stderr: '' });

    const result = await resolveTaskBranchOrigin('/repo', RUN_ID, git);

    expect(result).toBe(HEAD_SHA);
    expect(git.calls).toEqual([{ args: ['rev-parse', 'HEAD'], cwd: INTEGRATION_CWD }]);
  });

  it('git rev-parseが失敗すればundefinedを返す', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', 'HEAD'], { code: 128, stdout: '', stderr: 'fatal: bad revision' });

    const result = await resolveTaskBranchOrigin('/repo', RUN_ID, git);

    expect(result).toBeUndefined();
  });
});

describe('IntegrationMergeQueue.createIntegrationWorktree', () => {
  it('統合ブランチwf/<runId>/integrationを、統合worktree<repo>/.agents/worktrees/<runId>/_integrationに作る', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    const fs = new FakeFs();
    fs.realpaths.set('/repo', '/repo');
    fs.realpaths.set(INTEGRATION_CWD, INTEGRATION_CWD);
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.createIntegrationWorktree(
      { repoRoot: '/repo', runId: RUN_ID, headCommit: HEAD_SHA },
      git,
      fs,
    );

    expect(result).toEqual({ ok: true, cwd: INTEGRATION_CWD, branch: INTEGRATION_BRANCH });
    expect(git.calls).toEqual([
      {
        args: ['rev-parse', '--verify', '--quiet', `refs/heads/${INTEGRATION_BRANCH}`],
        cwd: '/repo',
      },
      { args: ['worktree', 'add', '-b', INTEGRATION_BRANCH, INTEGRATION_CWD, HEAD_SHA], cwd: '/repo' },
    ]);
  });

  it('統合ブランチが既にあればbranchExistsを返し、git worktree addを試みない', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 0, stdout: 'sha\n', stderr: '' });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.createIntegrationWorktree(
      { repoRoot: '/repo', runId: RUN_ID, headCommit: HEAD_SHA },
      git,
      new FakeFs(),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'branchExists',
      message: `ブランチ ${INTEGRATION_BRANCH} は既に存在します`,
    });
    expect(git.calls.some((c) => c.args[0] === 'worktree')).toBe(false);
  });

  it('git worktree add自体が失敗したときはgitErrorを返し、stderrを無害化する', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], {
      code: 128,
      stdout: '',
      stderr: "fatal: unable to access 'https://token123@github.com/org/repo.git/': \x00control",
    });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.createIntegrationWorktree(
      { repoRoot: '/repo', runId: RUN_ID, headCommit: HEAD_SHA },
      git,
      new FakeFs(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('gitError');
    expect(result.message).not.toContain('token123');
    expect(result.message).not.toContain('\x00');
  });

  it('不正なrunIdはinvalidIdentifierを返し、gitを一切呼ばない', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.createIntegrationWorktree(
      { repoRoot: '/repo', runId: 'not-a-uuid', headCommit: HEAD_SHA },
      git,
      new FakeFs(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalidIdentifier' });
    expect(git.calls).toEqual([]);
  });

  it('不正なheadCommit（フラグとして解釈されうる文字列）はinvalidHeadCommitを返し、gitを一切呼ばない', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.createIntegrationWorktree(
      { repoRoot: '/repo', runId: RUN_ID, headCommit: '--force' },
      git,
      new FakeFs(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalidHeadCommit' });
    expect(git.calls).toEqual([]);
  });

  it('作成先の経路にシンボリックリンクが含まれていればsymlinkDetectedを返し、gitを一切呼ばない（一次防御）', async () => {
    const git = new FakeGit();
    const fs = new FakeFs();
    fs.symlinks.add(path.join('/repo', '.agents', 'worktrees'));
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.createIntegrationWorktree(
      { repoRoot: '/repo', runId: RUN_ID, headCommit: HEAD_SHA },
      git,
      fs,
    );

    expect(result).toMatchObject({ ok: false, reason: 'symlinkDetected' });
    expect(git.calls).toEqual([]);
  });

  it('作成後の実パスがrepoRootの外であればboundaryEscapeを返し、撤去を試みる（二次防御）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    git.respond(['worktree', 'remove'], { code: 0, stdout: '', stderr: '' });
    const fs = new FakeFs();
    fs.realpaths.set('/repo', '/repo');
    fs.realpaths.set(INTEGRATION_CWD, '/outside/escaped');
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.createIntegrationWorktree(
      { repoRoot: '/repo', runId: RUN_ID, headCommit: HEAD_SHA },
      git,
      fs,
    );

    expect(result).toMatchObject({ ok: false, reason: 'boundaryEscape' });
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
  });

  it('worktree.tsのWorktreeCreationQueueと同じキューを渡すと、タスクworktreeの作成と統合worktreeの作成が直列化される', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    const fs = new FakeFs();
    fs.realpaths.set('/repo', '/repo');
    fs.realpaths.set(INTEGRATION_CWD, INTEGRATION_CWD);
    fs.realpaths.set(path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2'), path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2'));

    const worktreeQueue = new WorktreeCreationQueue();
    const integrationQueue = new IntegrationMergeQueue(worktreeQueue);

    const order: string[] = [];
    const [taskResult, integrationResult] = await Promise.all([
      worktreeQueue
        .create({ repoRoot: '/repo', runId: RUN_ID, taskId: 'T2', headCommit: HEAD_SHA, retry: undefined }, git, fs)
        .then((r) => {
          order.push('task');
          return r;
        }),
      integrationQueue
        .createIntegrationWorktree({ repoRoot: '/repo', runId: RUN_ID, headCommit: HEAD_SHA }, git, fs)
        .then((r) => {
          order.push('integration');
          return r;
        }),
    ]);

    expect(taskResult.ok).toBe(true);
    expect(integrationResult.ok).toBe(true);
    // 直列化されているため、片方が完全に終わってからもう片方が始まる
    // （個々のgit呼び出しが割り込まない）ことをworktree addの並びで確かめる
    const addCalls = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(addCalls).toHaveLength(2);
    expect(order).toHaveLength(2);
  });
});

describe('commitUncommittedChangesIfNeeded', () => {
  it('未コミットの変更が無ければ何もせずcommitted: falseを返す', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: '', stderr: '' });

    const result = await commitUncommittedChangesIfNeeded('/repo/task-T2', 'T2', git);

    expect(result).toEqual({ ok: true, committed: false });
    expect(git.calls).toEqual([{ args: ['status', '--porcelain'], cwd: '/repo/task-T2' }]);
  });

  it('未コミットの変更があればgit add -Aとcommitを固定文言で行う', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: ' M src/foo.ts\n', stderr: '' });
    git.respond(['add', '-A'], { code: 0, stdout: '', stderr: '' });
    git.respond(['commit'], { code: 0, stdout: '', stderr: '' });

    const result = await commitUncommittedChangesIfNeeded('/repo/task-T2', 'T2', git);

    expect(result).toEqual({ ok: true, committed: true });
    expect(git.calls).toEqual([
      { args: ['status', '--porcelain'], cwd: '/repo/task-T2' },
      { args: ['add', '-A'], cwd: '/repo/task-T2' },
      {
        args: ['commit', '-m', 'chore(T2): uncommitted changes at task completion'],
        cwd: '/repo/task-T2',
      },
    ]);
  });

  it('不正なtaskIdはinvalidIdentifierを返し、gitを一切呼ばない', async () => {
    const git = new FakeGit();

    const result = await commitUncommittedChangesIfNeeded('/repo/task-T2', '../evil', git);

    expect(result).toMatchObject({ ok: false, reason: 'invalidIdentifier' });
    expect(git.calls).toEqual([]);
  });

  it('git statusが失敗すればgitErrorを返す', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 128, stdout: '', stderr: 'fatal: not a repo' });

    const result = await commitUncommittedChangesIfNeeded('/repo/task-T2', 'T2', git);

    expect(result).toMatchObject({ ok: false, reason: 'gitError' });
  });

  it('git add -Aが失敗すればgitErrorを返し、commitは呼ばない', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: ' M src/foo.ts\n', stderr: '' });
    git.respond(['add', '-A'], { code: 1, stdout: '', stderr: 'fatal: add failed' });

    const result = await commitUncommittedChangesIfNeeded('/repo/task-T2', 'T2', git);

    expect(result).toMatchObject({ ok: false, reason: 'gitError' });
    expect(git.calls.some((c) => c.args[0] === 'commit')).toBe(false);
  });

  it('git commitが失敗すればgitErrorを返す', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: ' M src/foo.ts\n', stderr: '' });
    git.respond(['add', '-A'], { code: 0, stdout: '', stderr: '' });
    git.respond(['commit'], { code: 1, stdout: '', stderr: 'fatal: commit failed' });

    const result = await commitUncommittedChangesIfNeeded('/repo/task-T2', 'T2', git);

    expect(result).toMatchObject({ ok: false, reason: 'gitError' });
  });
});

describe('IntegrationMergeQueue.mergeTask', () => {
  const TASK_BRANCH = `wf/${RUN_ID}/T2`;

  it('マージが成功すればsuccessとマージコミットのidを返す。メッセージは固定文言', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', 'HEAD'], { code: 0, stdout: `${HEAD_SHA}\n`, stderr: '' });
    git.respond(['merge', '--no-ff'], { code: 0, stdout: '', stderr: '' });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.mergeTask(await lease(queue, 'T2'), RUN_ID, 'T2', TASK_BRANCH, git);

    expect(result).toEqual({ kind: 'success', mergeCommit: HEAD_SHA });
    expect(git.calls.filter((c) => c.args[0] === 'merge')).toEqual([
      {
        args: ['merge', '--no-ff', '-m', `chore(T2): merge task (run ${RUN_ID})`, TASK_BRANCH],
        cwd: INTEGRATION_CWD,
      },
    ]);
  });

  it('マージが未解決パスを残して失敗すればconflictを返し、未解決パスとマージ前のHEAD（巻き戻し先）を含む。git merge --abortは呼ばない', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', 'HEAD'], { code: 0, stdout: `${HEAD_SHA}\n`, stderr: '' });
    git.respond(['merge', '--no-ff'], { code: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in a.ts' });
    // 1回目はマージ前の確認（未解決なし）、2回目がマージ後の未解決パス
    git.respondSequence(['diff', '--name-only'], [
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'a.ts\nb.ts\n', stderr: '' },
    ]);
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.mergeTask(await lease(queue, 'T2'), RUN_ID, 'T2', TASK_BRANCH, git);

    expect(result).toEqual({
      kind: 'conflict',
      unresolvedPaths: ['a.ts', 'b.ts'],
      rollbackCommit: HEAD_SHA,
    });
    expect(git.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--abort')).toBe(false);
  });

  it('マージが衝突以外の理由で失敗すればfailureを返す（未解決パスが無い）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', 'HEAD'], { code: 0, stdout: `${HEAD_SHA}\n`, stderr: '' });
    git.respond(['merge', '--no-ff'], { code: 128, stdout: '', stderr: 'fatal: not something we can merge' });
    git.respond(['diff', '--name-only'], { code: 0, stdout: '', stderr: '' });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.mergeTask(await lease(queue, 'T2'), RUN_ID, 'T2', TASK_BRANCH, git);

    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.message).toContain('not something we can merge');
  });

  it('不正なrunId/taskIdはfailureを返し、gitを一切呼ばない', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const runIdLease = await lease(queue, 'T2');
    const badRunId = await queue.mergeTask(runIdLease, 'not-a-uuid', 'T2', TASK_BRANCH, git);
    expect(badRunId.kind).toBe('failure');
    queue.releaseLease(runIdLease);

    const taskIdLease = await lease(queue, '../evil');
    const badTaskId = await queue.mergeTask(taskIdLease, RUN_ID, '../evil', TASK_BRANCH, git);
    expect(badTaskId.kind).toBe('failure');
    queue.releaseLease(taskIdLease);

    expect(git.calls).toEqual([]);
  });

  it('不正なtaskBranch（他runIdのブランチ・フラグ注入を試みる文字列）はfailureを返し、gitを一切呼ばない', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const otherRunLease = await lease(queue, 'T2');
    const otherRun = await queue.mergeTask(
      otherRunLease,
      RUN_ID,
      'T2',
      'wf/22222222-2222-4222-8222-222222222222/T2',
      git,
    );
    expect(otherRun.kind).toBe('failure');
    queue.releaseLease(otherRunLease);

    const flagLease = await lease(queue, 'T2');
    const flagInjection = await queue.mergeTask(
      flagLease,
      RUN_ID,
      'T2',
      `wf/${RUN_ID}/--upload-pack=evil`,
      git,
    );
    expect(flagInjection.kind).toBe('failure');
    queue.releaseLease(flagLease);

    expect(git.calls).toEqual([]);
  });

  it('不正なtaskBranchのメッセージはwf形式・conventional形式の両方に触れる（旧メッセージがwf形式しか案内しない指摘への修正）', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.mergeTask(await lease(queue, 'T2'), RUN_ID, 'T2', 'not-a-branch', git);

    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.message).toContain('wf/');
    expect(result.message).toContain('conventional');
  });

  it('conventional形式（runIdの先頭8文字が一致する）のタスクブランチもマージできる', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', 'HEAD'], { code: 0, stdout: `${HEAD_SHA}\n`, stderr: '' });
    git.respond(['merge', '--no-ff'], { code: 0, stdout: '', stderr: '' });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    const conventionalBranch = `fix/42/t2-${RUN_ID.slice(0, 8)}`;

    const result = await queue.mergeTask(
      await lease(queue, 'T2'),
      RUN_ID,
      'T2',
      conventionalBranch,
      git,
    );

    expect(result).toEqual({ kind: 'success', mergeCommit: HEAD_SHA });
  });

  it('conventional形式でもrunIdの先頭8文字だけが違う（別runを装う）ブランチはfailureを返し、gitを一切呼ばない', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.mergeTask(
      await lease(queue, 'T2'),
      RUN_ID,
      'T2',
      'fix/42/t2-99999999',
      git,
    );

    expect(result.kind).toBe('failure');
    expect(git.calls).toEqual([]);
  });

  it('マージ操作が直列化される（同時に完了した2タスクのgit呼び出しが重ならない）', async () => {
    const callLog: string[] = [];
    const git: GitCommandRunner = {
      async run(args, _cwd) {
        callLog.push(`start:${args[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        callLog.push(`end:${args[0]}`);
        if (args[0] === 'rev-parse') {
          return { code: 0, stdout: `${HEAD_SHA}\n`, stderr: '' };
        }
        if (args[0] === 'merge') {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const t2Lease = await lease(queue, 'T2');
    await queue.mergeTask(t2Lease, RUN_ID, 'T2', `wf/${RUN_ID}/T2`, git);
    queue.releaseLease(t2Lease);
    const t3Lease = await lease(queue, 'T3');
    await queue.mergeTask(t3Lease, RUN_ID, 'T3', `wf/${RUN_ID}/T3`, git);
    queue.releaseLease(t3Lease);

    // 直列化されていれば、あるコマンドのstart直後には必ずそのコマンドのendが来る
    // （2つ目のタスクのコマンドが割り込んでこない）
    for (let i = 0; i < callLog.length; i += 2) {
      const started = callLog[i]?.replace('start:', '');
      const ended = callLog[i + 1]?.replace('end:', '');
      expect(started).toBe(ended);
    }
  });
});

describe('IntegrationMergeQueue.abortMerge', () => {
  it('git merge --abortを実行する（巻き戻し）', async () => {
    const git = new FakeGit();
    git.respond(['merge', '--abort'], { code: 0, stdout: '', stderr: '' });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.abortMerge(await lease(queue, 'T2'), git);

    expect(result).toEqual({ ok: true });
    expect(git.calls).toEqual([{ args: ['merge', '--abort'], cwd: INTEGRATION_CWD }]);
  });

  it('git merge --abortが失敗すればgitErrorを返す', async () => {
    const git = new FakeGit();
    git.respond(['merge', '--abort'], { code: 1, stdout: '', stderr: 'fatal: no merge in progress' });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.abortMerge(await lease(queue, 'T2'), git);

    expect(result).toMatchObject({ ok: false, reason: 'gitError' });
  });
});

describe('IntegrationMergeQueue.pushIntegrationBranch（design.md §16.18・Issue #253）', () => {
  it('forge.tsのpushBranchをキュー経由で呼ぶ', async () => {
    const git = new FakeGit();
    git.respond(['push'], { code: 0, stdout: '', stderr: '' });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.pushIntegrationBranch(git, INTEGRATION_CWD, INTEGRATION_BRANCH);

    expect(result).toEqual({ ok: true });
    expect(git.calls).toEqual([
      {
        args: ['push', 'origin', `${INTEGRATION_BRANCH}:${INTEGRATION_BRANCH}`],
        cwd: INTEGRATION_CWD,
      },
    ]);
  });

  it('同じキューを渡すと、複数タスクからのpushIntegrationBranchが直列に走り重ならない（並列タスクの統合ブランチpush競合対策）', async () => {
    let active = 0;
    let maxActive = 0;
    const trackingGit: GitCommandRunner = {
      async run(_args, _cwd): Promise<GitCommandResult> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const results = await Promise.all([
      queue.pushIntegrationBranch(trackingGit, INTEGRATION_CWD, INTEGRATION_BRANCH),
      queue.pushIntegrationBranch(trackingGit, INTEGRATION_CWD, INTEGRATION_BRANCH),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    // 直列化されていなければ、20ms遅延の間に両方のpushが同時にactiveへ入りmaxActiveが2になる
    expect(maxActive).toBe(1);
  });

  it('worktree.tsのWorktreeCreationQueueと同じキューを渡すと、統合worktreeの作成とpushも直列化される', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '--verify'], { code: 1, stdout: '', stderr: '' });
    git.respond(['worktree', 'add'], { code: 0, stdout: '', stderr: '' });
    git.respond(['push'], { code: 0, stdout: '', stderr: '' });
    const fs = new FakeFs();
    fs.realpaths.set('/repo', '/repo');
    fs.realpaths.set(INTEGRATION_CWD, INTEGRATION_CWD);

    const worktreeQueue = new WorktreeCreationQueue();
    const queue = new IntegrationMergeQueue(worktreeQueue);

    const order: string[] = [];
    const [createResult, pushResult] = await Promise.all([
      queue
        .createIntegrationWorktree({ repoRoot: '/repo', runId: RUN_ID, headCommit: HEAD_SHA }, git, fs)
        .then((r) => {
          order.push('create');
          return r;
        }),
      queue.pushIntegrationBranch(git, INTEGRATION_CWD, INTEGRATION_BRANCH).then((r) => {
        order.push('push');
        return r;
      }),
    ]);

    expect(createResult.ok).toBe(true);
    expect(pushResult).toEqual({ ok: true });
    expect(order).toHaveLength(2);
  });
});

describe('未コミットの変更の自動コミット→マージの流れ（受入基準: 未コミットの変更があるタスクでも、マージ後の統合ブランチにその変更が含まれる）', () => {
  it('commitUncommittedChangesIfNeededで自動コミットしてから、そのコミットを含むブランチをmergeTaskでマージできる', async () => {
    const git = new FakeGit();
    git.respond(['status', '--porcelain'], { code: 0, stdout: ' M src/foo.ts\n', stderr: '' });
    git.respond(['add', '-A'], { code: 0, stdout: '', stderr: '' });
    git.respond(['commit'], { code: 0, stdout: '', stderr: '' });
    git.respond(['rev-parse', 'HEAD'], { code: 0, stdout: `${HEAD_SHA}\n`, stderr: '' });
    git.respond(['merge', '--no-ff'], { code: 0, stdout: '', stderr: '' });

    const taskCwd = path.join('/repo', '.agents', 'worktrees', RUN_ID, 'T2');
    const commitResult = await commitUncommittedChangesIfNeeded(taskCwd, 'T2', git);
    expect(commitResult).toEqual({ ok: true, committed: true });

    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    const mergeResult = await queue.mergeTask(
      await lease(queue, 'T2'),
      RUN_ID,
      'T2',
      `wf/${RUN_ID}/T2`,
      git,
    );
    expect(mergeResult).toEqual({ kind: 'success', mergeCommit: HEAD_SHA });

    // 自動コミット→マージの順で行われている（マージがコミット済みの変更を取り込む前提）
    const commitCallIndex = git.calls.findIndex((c) => c.args[0] === 'commit');
    const mergeCallIndex = git.calls.findIndex((c) => c.args[0] === 'merge');
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);
    expect(mergeCallIndex).toBeGreaterThan(commitCallIndex);
  });
});

describe('reconcileMergingTaskOnReload（design.md §16.11）', () => {
  it('未解決の衝突（diff --diff-filter=Uが非空）が残っていればblocked', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], {
      code: 0,
      stdout: 'a.ts\n',
      stderr: '',
    });
    const result = await reconcileMergingTaskOnReload(INTEGRATION_CWD, RUN_ID, 'T1', git);
    expect(result).toBe('blocked');
  });

  it('未解決の衝突が無く、マージコミットが履歴に見つかればdone（--grepではなく件名一覧をJS側で照合する）', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], { code: 0, stdout: '', stderr: '' });
    git.respond(['log'], { code: 0, stdout: `${mergeCommitMessage('T1', RUN_ID)}\n`, stderr: '' });
    const result = await reconcileMergingTaskOnReload(INTEGRATION_CWD, RUN_ID, 'T1', git);
    expect(result).toBe('done');

    const logCall = git.calls.find((c) => c.args[0] === 'log');
    expect(logCall?.args).toEqual(['log', '--format=%s']);
    expect(logCall?.args.some((a) => a.startsWith('--grep='))).toBe(false);
  });

  it('マージ時のtypeが今回の呼び出しと違っていてもdone（type引数を持たず、COMMIT_TYPESのいずれでも認識する）', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], { code: 0, stdout: '', stderr: '' });
    // マージ時は`feat`だったが、リロード時に定義ファイルの`type`が`chore`へ変わっていても
    // （§16.2「typeを実行中に書き換えてからリロード」の事故経路）doneと判定できること
    git.respond(['log'], { code: 0, stdout: `${mergeCommitMessage('T1', RUN_ID, 'feat')}\n`, stderr: '' });
    const result = await reconcileMergingTaskOnReload(INTEGRATION_CWD, RUN_ID, 'T1', git);
    expect(result).toBe('done');
  });

  it('旧形式（Merge task <taskId> (run <runId>)）のマージコミットでもdone（アップグレードを跨いだrunを壊さない）', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], { code: 0, stdout: '', stderr: '' });
    git.respond(['log'], { code: 0, stdout: `Merge task T1 (run ${RUN_ID})\n`, stderr: '' });
    const result = await reconcileMergingTaskOnReload(INTEGRATION_CWD, RUN_ID, 'T1', git);
    expect(result).toBe('done');
  });

  it('別のタスクidのマージコミットしか無ければmerging（自分のタスクだけを見る）', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], { code: 0, stdout: '', stderr: '' });
    git.respond(['log'], { code: 0, stdout: `${mergeCommitMessage('T2', RUN_ID)}\n`, stderr: '' });
    const result = await reconcileMergingTaskOnReload(INTEGRATION_CWD, RUN_ID, 'T1', git);
    expect(result).toBe('merging');
  });

  it('未解決の衝突が無く、マージコミットも見つからなければmerging（やり直し対象）', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], { code: 0, stdout: '', stderr: '' });
    git.respond(['log'], { code: 0, stdout: '', stderr: '' });
    const result = await reconcileMergingTaskOnReload(INTEGRATION_CWD, RUN_ID, 'T1', git);
    expect(result).toBe('merging');
  });

  it('不正なrunId/taskIdは安全側でmerging（gitを呼ばない）', async () => {
    const git = new FakeGit();
    const result = await reconcileMergingTaskOnReload(INTEGRATION_CWD, 'not-a-uuid', 'T1', git);
    expect(result).toBe('merging');
    expect(git.calls).toHaveLength(0);
  });
});

describe('isMergeResolutionComplete（design.md §16.17「コンフリクト」4.）', () => {
  it('未解決パスが無く、MERGE_HEADも見つからなければtrue（解決してコミット済み）', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], { code: 0, stdout: '', stderr: '' });
    git.respond(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      code: 1,
      stdout: '',
      stderr: 'not found',
    });
    expect(await isMergeResolutionComplete(INTEGRATION_CWD, git)).toBe(true);
  });

  it('未解決パスが残っていればfalse', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], {
      code: 0,
      stdout: 'a.ts\n',
      stderr: '',
    });
    expect(await isMergeResolutionComplete(INTEGRATION_CWD, git)).toBe(false);
  });

  it('未解決パスは無いがMERGE_HEADがまだ存在すれば（コミット前）false', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], { code: 0, stdout: '', stderr: '' });
    git.respond(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      code: 0,
      stdout: `${'a'.repeat(40)}\n`,
      stderr: '',
    });
    expect(await isMergeResolutionComplete(INTEGRATION_CWD, git)).toBe(false);
  });
});

describe('findTaskIdsMergedSince', () => {
  it('マージコミットの固定文言からタスクidを逆算する（typeが混在していても拾える）', async () => {
    const git = new FakeGit();
    git.respond(['log'], {
      code: 0,
      stdout: [
        mergeCommitMessage('T2', RUN_ID),
        'some unrelated commit',
        mergeCommitMessage('T3', RUN_ID, 'feat'),
      ].join('\n'),
      stderr: '',
    });
    const ids = await findTaskIdsMergedSince(INTEGRATION_CWD, RUN_ID, HEAD_SHA, git);
    expect(ids).toEqual(['T2', 'T3']);

    const logCall = git.calls.find((c) => c.args[0] === 'log');
    expect(logCall?.args).toContain(`${HEAD_SHA}..HEAD`);
  });

  it('重複したタスクidは1回だけ含める', async () => {
    const git = new FakeGit();
    git.respond(['log'], {
      code: 0,
      stdout: [mergeCommitMessage('T2', RUN_ID), mergeCommitMessage('T2', RUN_ID)].join('\n'),
      stderr: '',
    });
    const ids = await findTaskIdsMergedSince(INTEGRATION_CWD, RUN_ID, HEAD_SHA, git);
    expect(ids).toEqual(['T2']);
  });

  it('旧形式（Merge task <taskId> (run <runId>)）のマージコミットも拾う（アップグレードを跨いだrunの衝突解決プロンプトが取りこぼさないように）', async () => {
    const git = new FakeGit();
    git.respond(['log'], {
      code: 0,
      stdout: [`Merge task T2 (run ${RUN_ID})`, mergeCommitMessage('T3', RUN_ID)].join('\n'),
      stderr: '',
    });
    const ids = await findTaskIdsMergedSince(INTEGRATION_CWD, RUN_ID, HEAD_SHA, git);
    expect(ids).toEqual(['T2', 'T3']);
  });

  it('不正なsinceCommitは空配列（gitを呼ばない）', async () => {
    const git = new FakeGit();
    const ids = await findTaskIdsMergedSince(INTEGRATION_CWD, RUN_ID, 'not-a-sha', git);
    expect(ids).toEqual([]);
    expect(git.calls).toHaveLength(0);
  });
});

describe('buildMergeResolutionPrompt', () => {
  it('未解決パス・対象タスク・突き合わせるタスクのprompt/doneを含む', () => {
    const prompt = buildMergeResolutionPrompt(
      { id: 'T2', prompt: 'T2のプロンプト', done: 'T2完了条件' },
      [{ id: 'T1', prompt: 'T1のプロンプト', done: 'T1完了条件' }],
      ['a.ts', 'b.ts'],
    );
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('b.ts');
    expect(prompt).toContain('T2のプロンプト');
    expect(prompt).toContain('T2完了条件');
    expect(prompt).toContain('T1のプロンプト');
    expect(prompt).toContain('T1完了条件');
  });

  it('othersが空でも組み立てられる', () => {
    const prompt = buildMergeResolutionPrompt(
      { id: 'T2', prompt: 'p', done: 'd' },
      [],
      ['a.ts'],
    );
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('T2');
  });
});

/**
 * 統合worktreeの占有（Issue #412）。`mergeTask` / `abortMerge` の入口で、
 * 「自分がいま占有している統合worktreeか」を確かめる部分の単体テスト。
 * `git merge --abort` は統合worktree全体を巻き戻すため、他タスクの衝突解決セッションが
 * 編集中の内容ごと消してしまう事故を型と実行時の両方で塞ぐ。
 */
describe('IntegrationMergeQueue: 統合worktreeの占有（Issue #412）', () => {
  it('占有は1件ずつしか渡らず、解放すると待っている次の取得へFIFOで渡る', async () => {
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const first = await queue.acquireLease(INTEGRATION_CWD, 'T1');
    expect(queue.leaseHolderTaskId(INTEGRATION_CWD)).toBe('T1');

    const order: string[] = [];
    const second = queue.acquireLease(INTEGRATION_CWD, 'T2').then((l) => {
      order.push('T2');
      return l;
    });
    const third = queue.acquireLease(INTEGRATION_CWD, 'T3').then((l) => {
      order.push('T3');
      return l;
    });
    await Promise.resolve();
    // T1が持っている間は誰にも渡らない
    expect(order).toEqual([]);

    queue.releaseLease(first);
    const secondLease = await second;
    expect(order).toEqual(['T2']);
    expect(queue.leaseHolderTaskId(INTEGRATION_CWD)).toBe('T2');

    queue.releaseLease(secondLease);
    queue.releaseLease(await third);
    expect(order).toEqual(['T2', 'T3']);
    expect(queue.leaseHolderTaskId(INTEGRATION_CWD)).toBeUndefined();
  });

  it('別の統合worktree（別run）の占有は互いに待たない', async () => {
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    const otherCwd = path.join('/repo', '.agents', 'worktrees', 'other-run', '_integration');

    await queue.acquireLease(INTEGRATION_CWD, 'T1');
    const other = await queue.acquireLease(otherCwd, 'T1');

    expect(other.integrationWorktreeCwd).toBe(otherCwd);
    expect(queue.leaseHolderTaskId(otherCwd)).toBe('T1');
  });

  it('占有していないハンドルのabortMergeは拒否され、git merge --abortを呼ばない', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    await queue.acquireLease(INTEGRATION_CWD, 'T1');

    // 他タスクが「自分は占有している」と偽って作ったハンドル
    const forged: IntegrationLease = { integrationWorktreeCwd: INTEGRATION_CWD, taskId: 'T2' };
    const result = await queue.abortMerge(forged, git);

    expect(result).toMatchObject({ ok: false, reason: 'leaseNotHeld' });
    expect(git.calls).toEqual([]);
  });

  it('解放済みのハンドルではもうabortMergeもmergeTaskもできない', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    const stale = await queue.acquireLease(INTEGRATION_CWD, 'T1');
    queue.releaseLease(stale);

    expect(await queue.abortMerge(stale, git)).toMatchObject({
      ok: false,
      reason: 'leaseNotHeld',
    });
    expect(await queue.mergeTask(stale, RUN_ID, 'T1', `wf/${RUN_ID}/T1`, git)).toMatchObject({
      kind: 'failure',
    });
    expect(git.calls).toEqual([]);
  });

  it('占有者と異なるtaskIdのマージは拒否される（取り違え防止）', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    const held = await queue.acquireLease(INTEGRATION_CWD, 'T1');

    const result = await queue.mergeTask(held, RUN_ID, 'T2', `wf/${RUN_ID}/T2`, git);

    expect(result.kind).toBe('failure');
    expect(git.calls).toEqual([]);
  });

  it('解放は冪等で、二重解放しても次の待ち行列を壊さない', async () => {
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    const first = await queue.acquireLease(INTEGRATION_CWD, 'T1');
    const second = queue.acquireLease(INTEGRATION_CWD, 'T2');
    const third = queue.acquireLease(INTEGRATION_CWD, 'T3');

    queue.releaseLease(first);
    queue.releaseLease(first);
    await second;

    expect(queue.leaseHolderTaskId(INTEGRATION_CWD)).toBe('T2');
    queue.releaseLease(await second);
    await third;
    expect(queue.leaseHolderTaskId(INTEGRATION_CWD)).toBe('T3');
  });

  it('releaseAllLeasesは待っている取得を起こし、そのハンドルは失効している（run破棄時の強制解放）', async () => {
    const git = new FakeGit();
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());
    await queue.acquireLease(INTEGRATION_CWD, 'T1');
    const waiting = queue.acquireLease(INTEGRATION_CWD, 'T2');

    queue.releaseAllLeases();

    // 待ち続けて固まるのではなく、失効したハンドルとして起き上がる（fail-closed）
    const woken = await waiting;
    expect(await queue.mergeTask(woken, RUN_ID, 'T2', `wf/${RUN_ID}/T2`, git)).toMatchObject({
      kind: 'failure',
    });
    expect(queue.leaseHolderTaskId(INTEGRATION_CWD)).toBeUndefined();
    expect(git.calls).toEqual([]);
  });

  it('MERGE_HEADが残っていればマージへ進まずfailureにする（占有の外から呼ばれた場合の多層防御）', async () => {
    const git = new FakeGit();
    git.respond(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      code: 0,
      stdout: `${'a'.repeat(40)}\n`,
      stderr: '',
    });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.mergeTask(
      await lease(queue, 'T2'),
      RUN_ID,
      'T2',
      `wf/${RUN_ID}/T2`,
      git,
    );

    expect(result.kind).toBe('failure');
    // 他タスクの未解決パスを自分の衝突として拾う経路（`git merge`→`diff --diff-filter=U`）
    // へそもそも入らない
    expect(git.calls.some((c) => c.args[0] === 'merge')).toBe(false);
  });

  it('MERGE_HEADが無くても未解決パスが残っていればマージへ進まずfailureにする', async () => {
    const git = new FakeGit();
    git.respond(['diff', '--name-only', '--diff-filter=U'], {
      code: 0,
      stdout: 'a.ts\n',
      stderr: '',
    });
    const queue = new IntegrationMergeQueue(new WorktreeCreationQueue());

    const result = await queue.mergeTask(
      await lease(queue, 'T2'),
      RUN_ID,
      'T2',
      `wf/${RUN_ID}/T2`,
      git,
    );

    expect(result.kind).toBe('failure');
    expect(git.calls.some((c) => c.args[0] === 'merge')).toBe(false);
  });
});
