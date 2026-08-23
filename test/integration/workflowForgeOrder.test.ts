import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activateExtension } from './helpers/extension';
import { createForgeRepo, type ForgeRepo } from './helpers/forgeRepo';
import { readManifest } from './helpers/manifest';
import {
  describeSnapshot,
  FakeTaskSessionHost,
  ForgeCallLog,
  realGit,
  RecordingCli,
  RecordingGit,
  stateOf,
  taskOf,
  type WorkflowRunSnapshotLike,
  type WorkflowTestApiLike,
} from './helpers/workflow';
import { waitFor } from './helpers/waitFor';

/**
 * PR/MRの作成順序と統合→mainの最終マージ（design.md §16.18、Issue #172）。対応する手動手順は
 * 圧縮前の [docs/manual-test.md](../../docs/manual-test.md) のW-16 / W-17。
 *
 * 実行の起点には**ローカルのbareリポジトリを `origin` に持つ作業ツリー**を使う
 * （`helpers/forgeRepo.ts`）。`git push` は本物が走り、送り先はローカルのファイルパスなので、
 * テストがネットワーク越しのホストへ触れることはない（Issue #178）。`gh` / `glab` は記録
 * するだけのフェイク（`RecordingCli`）が受ける。gitも記録するが、動作は実物へ委譲する
 * （`RecordingGit`）。push（git）とPR/MR作成（CLI）にまたがる順序を、1本の時系列
 * （`ForgeCallLog`）で確かめるため。
 */
suite('PR/MRの作成順序と最終マージ（design.md §16.18）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 30_000, intervalMs: 100 } as const;

  let workflow: WorkflowTestApiLike;
  let host: FakeTaskSessionHost;
  let forgeRoot: string;
  let defTemplate: string;
  let caseIndex = 0;
  const startedRunIds: string[] = [];

  setup(async () => {
    const api = await activateExtension();
    assert.ok(
      api.workflow !== undefined,
      'AGENT_SESSIONS_INTEGRATION_TEST=1 のときワークフローのテスト用APIが公開される',
    );
    workflow = api.workflow;
    host = new FakeTaskSessionHost();
    workflow.setTaskSessionHost('codex', host);

    const manifest = readManifest();
    forgeRoot = manifest.forge.root;
    defTemplate = manifest.forge.defTemplate;
  });

  teardown(async () => {
    for (const runId of startedRunIds) {
      workflow.runner.stop(runId);
      await workflow.runner.removeWorktrees(runId);
    }
    startedRunIds.length = 0;
    workflow.setTaskSessionHost('codex', undefined);
    workflow.setForgeOverrides(undefined);
  });

  async function waitForSnapshot(
    runId: string,
    predicate: (snapshot: WorkflowRunSnapshotLike | undefined) => boolean,
    what: string,
  ): Promise<WorkflowRunSnapshotLike> {
    try {
      const snapshot = await waitFor(
        () => workflow.runner.getSnapshot(runId),
        predicate,
        WAIT_OPTIONS,
      );
      assert.ok(snapshot !== undefined, 'スナップショットが取れる');
      return snapshot;
    } catch (error) {
      const detail = describeSnapshot(workflow.runner.getSnapshot(runId));
      throw new Error(`${what}を待てなかった: ${detail}`, { cause: error });
    }
  }

  /**
   * 統合PR/MRのURL末尾から番号を取り出す（`RecordingCli` は作成順に採番したURLを返す）。
   *
   * 最終マージのコマンドには**この番号がそのまま位置引数として渡る**のが正しい姿
   * （Issue #404、design.md §16.18「最終マージ」）。番号を省くとマージ対象が「cwdの
   * カレントブランチに紐づくPR/MR」という暗黙の状態依存になるため、テスト側も番号を
   * 決め打ちせず、実際に作られた統合PR/MRの番号と一致することを確かめる。
   */
  function integrationNumber(snapshot: WorkflowRunSnapshotLike): string {
    const url = snapshot.integrationPullRequestUrl ?? '';
    const matched = /\/(?<number>\d+)$/u.exec(url);
    assert.ok(matched !== null, `統合PR/MRのURLから番号を取れない: ${url}`);
    return matched.groups?.number ?? '';
  }

  interface RunResult {
    runId: string;
    repo: ForgeRepo;
    log: ForgeCallLog;
    cli: RecordingCli;
    git: RecordingGit;
    snapshot: WorkflowRunSnapshotLike;
  }

  /**
   * 1タスクのワークフローを最後まで走らせ、記録した呼び出し列と最終スナップショットを返す。
   *
   * フェイクのセッションは何も書かないため、タスクのworktreeでテスト側が1件コミットする
   * （差分が無いと `git merge --no-ff` が「Already up to date」になり、マージされたことを
   * 確かめられない。`workflowForgePrerequisites.test.ts` と同じ理由）。
   */
  async function runOnce(options: {
    host: 'github' | 'gitlab';
    pullRequest: 'none' | 'integration' | 'per-task';
    finalMerge: 'auto' | 'pr-only';
  }): Promise<RunResult> {
    caseIndex += 1;
    // 1つのテストの中で複数回走らせるケースがあるため、セッションのフェイクも毎回作り直す
    // （`FakeTaskSessionHost.get` はcwdの末尾で引くので、前のケースのセッションが残っていると
    // 既に片付けたworktreeを掴む）。
    host = new FakeTaskSessionHost();
    workflow.setTaskSessionHost('codex', host);
    const repo = createForgeRepo(forgeRoot, `case-${caseIndex}`, defTemplate);
    const log = new ForgeCallLog();
    const cli = new RecordingCli(true, log);
    const git = new RecordingGit(realGit, log);

    workflow.setForgeOverrides({
      cli,
      git,
      cliAvailability: { isOnPath: () => Promise.resolve(true) },
      readConfig: () => ({
        host: options.host,
        pullRequest: options.pullRequest,
        finalMerge: options.finalMerge,
      }),
    });

    const result = await workflow.runner.start(repo.defPath, repo.workspace);
    assert.equal(
      result.ok,
      true,
      `実行を開始できない: ${(result.errors ?? []).map((e) => e.message).join(' / ')}`,
    );
    const runId = result.runId;
    assert.ok(runId !== undefined, 'runIdが返る');
    startedRunIds.push(runId);

    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T1')?.hasLiveSession === true,
      'T1のセッションが開かれる',
    );

    const session = host.get('T1');
    fs.writeFileSync(path.join(session.cwd, 't1.md'), 'T1の成果\n', 'utf8');
    execFileSync('git', ['add', 't1.md'], { cwd: session.cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '--no-verify', '-m', 'feat: T1の成果'], {
      cwd: session.cwd,
      stdio: 'pipe',
    });
    session.finishDone('T1の結果');

    // 統合層の後処理（`finalizeForge`）はrunの完了より後に走る。ここで待たずに次のケースへ
    // 進むと、まだ動いている前のケースの呼び出しが次のケースの記録へ混ざる。
    const settled = (s: WorkflowRunSnapshotLike | undefined): boolean => {
      if (s === undefined || s.outcome === 'running') {
        return false;
      }
      if (options.pullRequest === 'none') {
        return true;
      }
      if (s.integrationPullRequestUrl === undefined) {
        return false;
      }
      return options.finalMerge !== 'auto' || s.finalMergeOutcome !== undefined;
    };
    const snapshot = await waitForSnapshot(runId, settled, 'runと統合層の後処理が終わる');
    assert.equal(snapshot.outcome, 'succeeded', `runが失敗した: ${describeSnapshot(snapshot)}`);
    assert.equal(stateOf(snapshot, 'T1'), 'done');

    return { runId, repo, log, cli, git, snapshot };
  }

  test('W-16: タスク層はpush→push→PR/MR作成→マージ+pushの順で進む', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const run = await runOnce({ host: 'github', pullRequest: 'per-task', finalMerge: 'pr-only' });

    // 先にマージしてしまうとbaseとheadの間に差分が無くなりPR/MRの作成が失敗する
    // （design.md §16.18「作る順序」）。この順序が守られていることを記録から確かめる。
    assert.deepEqual(run.log.forgeSteps().slice(0, 5), [
      `push wf/${run.runId}/T1`,
      `push wf/${run.runId}/integration`,
      'createPullRequest',
      'merge',
      `push wf/${run.runId}/integration`,
    ]);

    // PR/MRのbaseは統合ブランチ、headはタスクブランチ。
    const create = run.cli.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    assert.ok(
      create !== undefined,
      `gh pr create が呼ばれていない: ${JSON.stringify(run.cli.calls)}`,
    );
    assert.ok(
      create.args.includes(`--base=wf/${run.runId}/integration`),
      'baseが統合ブランチでない',
    );
    assert.ok(create.args.includes(`--head=wf/${run.runId}/T1`), 'headがタスクブランチでない');

    // 実際にpushされた先はローカルのbareリポジトリ。
    assert.ok(
      run.repo.remoteBranches().includes(`wf/${run.runId}/integration`),
      `統合ブランチがoriginへpushされていない: ${run.repo.remoteBranches().join(', ')}`,
    );

    // ワークフローViewの統合状況に載るリンク（design.md §16.11）。
    assert.match(taskOf(run.snapshot, 'T1')?.pullRequestUrl ?? '', /^https:\/\/github\.invalid\//u);
  });

  test('W-17: finalMerge: auto なら統合PR/MR作成に続けて最終マージまで実行する', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const run = await runOnce({ host: 'github', pullRequest: 'per-task', finalMerge: 'auto' });

    const steps = run.log.forgeSteps();
    assert.deepEqual(steps.slice(-3), [
      `push wf/${run.runId}/integration`,
      'createPullRequest',
      'finalMerge',
    ]);

    const merge = run.cli.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
    assert.deepEqual(merge?.args, ['pr', 'merge', integrationNumber(run.snapshot), '--merge']);
    assert.equal(run.snapshot.finalMergeOutcome, 'merged');
    assert.match(run.snapshot.integrationPullRequestUrl ?? '', /^https:\/\/github\.invalid\//u);

    // 統合PR/MRの本文にはrunIdと完了したタスクidが入る（design.md §16.18）。
    const integrationBody = run.cli.bodies.at(-1) ?? '';
    assert.ok(integrationBody.includes(run.runId), `本文にrunIdが無い: ${integrationBody}`);
    assert.ok(integrationBody.includes('T1'), `本文に完了したタスクidが無い: ${integrationBody}`);

    // mainへマージした後も統合ブランチはローカルに残る（design.md §16.18）。
    const branches = execFileSync('git', ['branch', '--list', `wf/${run.runId}/integration`], {
      cwd: run.repo.workspace,
      encoding: 'utf8',
    }).trim();
    assert.notEqual(branches, '', '統合ブランチがローカルに残っていない');
  });

  test('finalMerge: pr-only ではPR/MRは作られるがマージは実行されない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const run = await runOnce({
      host: 'github',
      pullRequest: 'integration',
      finalMerge: 'pr-only',
    });

    assert.ok(
      run.snapshot.integrationPullRequestUrl !== undefined,
      `統合PR/MRが作られていない: ${describeSnapshot(run.snapshot)}`,
    );

    assert.deepEqual(
      run.cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge'),
      [],
      'pr-only なのにマージを実行している',
    );
    assert.equal(run.snapshot.finalMergeOutcome, undefined);
  });

  test('pullRequest の層ごとに作られるPR/MRが変わる（integration / none）', async function () {
    this.timeout(TEST_TIMEOUT_MS);

    // integration: タスク層のPR/MRは作らず、統合→mainの1本だけ作る。
    const integrationOnly = await runOnce({
      host: 'github',
      pullRequest: 'integration',
      finalMerge: 'pr-only',
    });
    assert.equal(
      integrationOnly.log.forgeSteps().filter((s) => s === 'createPullRequest').length,
      1,
      'integration ではPR/MRは統合層の1本だけ',
    );
    assert.equal(taskOf(integrationOnly.snapshot, 'T1')?.pullRequestUrl, undefined);

    // none: どの層のPR/MRも作らない。ローカルのマージだけ進む。
    const none = await runOnce({ host: 'github', pullRequest: 'none', finalMerge: 'pr-only' });
    assert.deepEqual(
      none.log.forgeSteps().filter((s) => s === 'createPullRequest'),
      [],
      'none なのにPR/MRを作っている',
    );
    assert.ok(none.log.forgeSteps().includes('merge'), 'ローカルのマージまで進んでいない');
  });

  test('ホストがGitLabなら glab が選ばれ、本文はファイル経由（--field description=@）で渡る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const run = await runOnce({ host: 'gitlab', pullRequest: 'per-task', finalMerge: 'auto' });

    assert.deepEqual(
      run.cli.calls.map((c) => c.command),
      run.cli.calls.map(() => 'glab'),
      'GitLab指定なのに gh を呼んでいる',
    );

    const create = run.cli.calls.find(
      (c) => c.args[0] === 'api' && c.args[1] === 'projects/:id/merge_requests',
    );
    assert.ok(create !== undefined, `glab api が呼ばれていない: ${JSON.stringify(run.cli.calls)}`);
    const description = create.args.find((a) => a.startsWith('--field=description=@'));
    assert.ok(
      description !== undefined,
      `本文がファイル経由で渡っていない: ${create.args.join(' ')}`,
    );
    assert.ok(
      create.args.includes(`--field=source_branch=wf/${run.runId}/T1`),
      'source_branchがタスクブランチでない',
    );

    const merge = run.cli.calls.find((c) => c.args[0] === 'mr' && c.args[1] === 'merge');
    assert.deepEqual(merge?.args, [
      'mr',
      'merge',
      integrationNumber(run.snapshot),
      '--remove-source-branch',
    ]);
    assert.match(
      run.snapshot.integrationPullRequestUrl ?? '',
      /^https:\/\/gitlab\.invalid\//u,
      'glab api のJSONからweb_urlを拾えていない',
    );
  });
});
