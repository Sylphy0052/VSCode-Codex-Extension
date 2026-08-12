import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activateExtension } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import { waitFor } from './helpers/waitFor';
import {
  describeSnapshot,
  FakeTaskSessionHost,
  stateOf,
  taskOf,
  type WorkflowRunSnapshotLike,
  type WorkflowTestApiLike,
} from './helpers/workflow';

/**
 * ワークフロー（design.md §16）の実行を実VSCode上で確かめる（Issue #158）。
 * 対応する手動手順は [docs/manual-test.md](../../docs/manual-test.md) のW-01 / W-02 /
 * W-04 / W-05（手順書の圧縮後はW-A。旧番号との対応はW群の冒頭にある）。W-05は手動から
 * 落としてあり、残る番号の観点も画面の見え方だけがW-Aへ残っている。
 *
 * CLIとの境界（`TaskSessionHost.openTaskSession`）だけをフェイクへ差し替え、worktreeの
 * 作成・スケジューリング・状態遷移・workspaceStateへの保存は実物を通す。ターンは
 * 自動では進まないので、「T2とT3が同時にrunningである瞬間」を取りこぼさずに観測できる。
 */
suite('ワークフローの並列実行（Issue #51の受入基準）', () => {
  /** worktreeの作成とgitの実行を含むため、既定の20秒では足りないことがある。 */
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 30_000, intervalMs: 100 } as const;

  let workflow: WorkflowTestApiLike;
  let host: FakeTaskSessionHost;
  let defPath: string;
  let workspaceFolder: string;
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
    defPath = manifest.workflow.defPath;
    workspaceFolder = manifest.workspaceFolder;
  });

  teardown(async () => {
    for (const runId of startedRunIds) {
      workflow.runner.stop(runId);
      await workflow.runner.removeWorktrees(runId);
    }
    startedRunIds.length = 0;
    workflow.setTaskSessionHost('codex', undefined);
  });

  /**
   * 条件を満たすスナップショットを待つ。満たさないまま時間切れになったときは、
   * そのときの状態（各タスクの状態・セッションの有無・失敗理由・警告）を添えて落とす。
   */
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

  /** 定義を実行し、T1のセッションが開かれるまで待つ。 */
  async function startAndWaitForT1(): Promise<string> {
    const result = await workflow.runner.start(defPath, workspaceFolder);
    assert.equal(
      result.ok,
      true,
      `実行を開始できない: ${(result.errors ?? []).map((e) => e.message).join(' / ')}`,
    );
    const runId = result.runId;
    assert.ok(runId !== undefined, 'runIdが返る');
    startedRunIds.push(runId);

    // 「running」だけでは早すぎる（worktreeを作っている最中もrunning）。セッションが
    // 実際に開かれる（＝フェイクのopenTaskSessionが呼ばれた）ところまで待つ。
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T1')?.hasLiveSession === true,
      'T1のセッションが開かれる',
    );
    return runId;
  }

  /** T1を完了させ、T2とT3が「同時に」runningになった瞬間のスナップショットを返す。 */
  async function advanceToParallel(runId: string): Promise<WorkflowRunSnapshotLike> {
    host.get('T1').finishDone('T1の結果');
    return await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T2')?.hasLiveSession === true && taskOf(s, 'T3')?.hasLiveSession === true,
      'T2とT3が同時に走る',
    );
  }

  test('T1 → (T2 || T3) → T4 が最後まで通り、T2とT3が同時に走る（W-01 / W-02）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await startAndWaitForT1();

    // 依存を満たしていないタスクは開始していない（design.md §16.2）
    const beforeT1Done = workflow.runner.getSnapshot(runId);
    assert.equal(stateOf(beforeT1Done, 'T2'), 'pending');
    assert.equal(stateOf(beforeT1Done, 'T3'), 'pending');
    assert.equal(stateOf(beforeT1Done, 'T4'), 'pending');

    // T1の完了で、T2とT3が同じ瞬間にrunningになる（＝実行区間が重なっている）
    const parallel = await advanceToParallel(runId);
    assert.equal(stateOf(parallel, 'T1'), 'done');
    assert.equal(stateOf(parallel, 'T4'), 'pending');
    for (const taskId of ['T2', 'T3']) {
      const task = taskOf(parallel, taskId);
      assert.ok(task?.startedAt !== undefined, `${taskId}に開始時刻がある`);
      assert.equal(task?.hasLiveSession, true, `${taskId}のセッションが生きている`);
    }

    // T2とT3が終わってはじめてT4が始まる
    host.get('T2').finishDone('T2の結果');
    host.get('T3').finishDone('T3の結果');
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T4')?.hasLiveSession === true,
      'T4のセッションが開かれる',
    );

    host.get('T4').finishDone('T4の結果');
    const finished = await waitForSnapshot(runId, (s) => stateOf(s, 'T4') === 'done', 'T4の完了');
    for (const taskId of ['T1', 'T2', 'T3', 'T4']) {
      assert.equal(stateOf(finished, taskId), 'done', `${taskId}がdoneで終わる`);
    }
  });

  test('並列で走るT2とT3は別々のworktreeで動く（受入基準「互いのファイルを踏まない」）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await startAndWaitForT1();
    const parallel = await advanceToParallel(runId);

    const t2 = taskOf(parallel, 'T2');
    const t3 = taskOf(parallel, 'T3');
    assert.ok(t2?.cwd !== undefined && t3?.cwd !== undefined, '両方に作業ディレクトリがある');
    assert.notEqual(t2.cwd, t3.cwd, 'T2とT3の作業ディレクトリが別である');
    assert.notEqual(t2.branch, t3.branch, 'T2とT3のブランチが別である');

    for (const cwd of [t2.cwd, t3.cwd]) {
      assert.ok(fs.existsSync(cwd), `作業ディレクトリが実在する: ${cwd}`);
      // git worktreeの作業ツリーでは`.git`がディレクトリではなくファイルになる
      assert.ok(fs.existsSync(path.join(cwd, '.git')), `gitの作業ツリーである: ${cwd}`);
      assert.notEqual(
        path.resolve(cwd),
        path.resolve(workspaceFolder),
        'ワークスペース直下をそのまま共有していない',
      );
    }

    // フェイクのセッションにも、それぞれのworktreeがcwdとして渡っている
    assert.equal(host.get('T2').cwd, t2.cwd);
    assert.equal(host.get('T3').cwd, t3.cwd);

    // 片方のworktreeへ書いても、もう片方には現れない
    fs.writeFileSync(path.join(t2.cwd, 'from-t2.txt'), 'T2が書いた\n', 'utf8');
    assert.equal(fs.existsSync(path.join(t3.cwd, 'from-t2.txt')), false);
  });

  test('「タスク停止」でそのタスクだけが止まり、並列の相手は走り続ける（W-05）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await startAndWaitForT1();
    await advanceToParallel(runId);

    workflow.runner.stopTask(runId, 'T2');

    const stopped = await waitForSnapshot(runId, (s) => stateOf(s, 'T2') === 'failed', 'T2の停止');
    assert.equal(stateOf(stopped, 'T3'), 'running', 'T3は走り続ける');
    assert.equal(host.get('T3').disposed, false, 'T3のセッションは解放されていない');
  });

  test('「中断」は進行中のターンだけを止め、タスクはrunningのまま続く（W-04）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await startAndWaitForT1();
    await advanceToParallel(runId);

    await workflow.runner.interruptTask(runId, 'T2');

    assert.equal(host.get('T2').interruptCount, 1, 'セッションのinterruptが呼ばれる');
    assert.equal(
      stateOf(workflow.runner.getSnapshot(runId), 'T2'),
      'running',
      'タスク自体は走り続ける',
    );
    assert.equal(host.get('T2').disposed, false, 'セッションは解放されていない');
  });

  test('Viewのノードから会話タブへ移動できる（W-03のうち導線の配線）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await startAndWaitForT1();

    assert.equal(workflow.runner.revealTask(runId, 'T1'), true);
    assert.equal(host.get('T1').revealCount, 1, 'セッションのrevealが呼ばれる');
  });
});
