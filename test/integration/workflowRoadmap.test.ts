import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activateExtension } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import {
  describeSnapshot,
  FakeTaskSessionHost,
  stateOf,
  taskOf,
  type WorkflowRunSnapshotLike,
  type WorkflowTestApiLike,
} from './helpers/workflow';
import { waitFor } from './helpers/waitFor';

/**
 * ロードマップ一周のうちCLIに依らない範囲（design.md §16.19「ロードマップの更新」・
 * §16.17「worktreeの片付け」、Issue #173）。対応する手動手順は圧縮前の
 * [docs/manual-test.md](../../docs/manual-test.md) のW-21。
 *
 * ロードマップ本文の生成はモデルの出力に依存するため自動化できないが、生成済みの
 * ロードマップを入力とする以降の工程（runの結果の書き戻し・片付け）はCLIを必要としない。
 * ワークフロー定義が持つ `roadmap`（生成時に `withRoadmapReference` が足す）を頼りに、
 * runが終わった時点で `done` になったタスクの項目だけへチェックが入る。
 */
suite('ロードマップの更新と片付け（design.md §16.19・§16.17）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 30_000, intervalMs: 100 } as const;

  let workflow: WorkflowTestApiLike;
  let host: FakeTaskSessionHost;
  let workspaceFolder: string;
  let roadmapMarkdown: string;
  /** ケースごとに掘るロードマップと定義（後述の`makeCase`）。 */
  let defPath: string;
  let roadmapPath: string;
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
    workspaceFolder = manifest.workspaceFolder;
    roadmapMarkdown = manifest.roadmap.markdown;

    // ロードマップの書き戻しはrunの終了後に非同期で走る。1組のファイルを使い回すと、
    // 前のケースの書き戻しが次のケースの内容へ着地しうるため、ケースごとに別の
    // ロードマップと定義を掘る。
    caseIndex += 1;
    const relative = `${manifest.roadmap.dir}/case-${caseIndex}.md`;
    roadmapPath = path.join(workspaceFolder, relative);
    fs.mkdirSync(path.dirname(roadmapPath), { recursive: true });
    fs.writeFileSync(roadmapPath, roadmapMarkdown, 'utf8');
    defPath = path.join(
      workspaceFolder,
      manifest.roadmap.workflowDir,
      `roadmap-case-${caseIndex}.yaml`,
    );
    fs.writeFileSync(
      defPath,
      manifest.roadmap.defTemplate.replace(manifest.roadmap.markdownRelativePath, relative),
      'utf8',
    );
  });

  teardown(async () => {
    for (const runId of startedRunIds) {
      workflow.runner.stop(runId);
      await workflow.runner.removeWorktrees(runId);
    }
    startedRunIds.length = 0;
    workflow.setTaskSessionHost('codex', undefined);
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

  /** 実行を開始し、R1のセッションが開かれるまで待つ。 */
  async function start(): Promise<string> {
    const result = await workflow.runner.start(defPath, workspaceFolder);
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
      (s) => taskOf(s, 'R1')?.hasLiveSession === true,
      'R1のセッションが開かれる',
    );
    return runId;
  }

  /** ロードマップの現在の内容を行の配列で読む。 */
  function roadmapLines(): string[] {
    return fs.readFileSync(roadmapPath, 'utf8').split('\n');
  }

  function lineOf(id: string): string {
    const found = roadmapLines().find((l) => l.includes(` ${id} `));
    assert.ok(found !== undefined, `ロードマップに項目 ${id} が無い`);
    return found;
  }

  test('runが終わると、doneになったタスクの項目にだけチェックが入る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();

    host.get('R1').finishDone('R1の結果');
    await waitForSnapshot(runId, (s) => taskOf(s, 'R2')?.hasLiveSession === true, 'R2が開始される');
    host.get('R2').finishDone('R2の結果');
    const finished = await waitForSnapshot(
      runId,
      (s) => s !== undefined && s.outcome !== 'running',
      'runが終わる',
    );
    assert.equal(finished.outcome, 'succeeded', describeSnapshot(finished));

    // 書き戻しはrunの終了後に非同期で走る。
    await waitFor(
      () => lineOf('R1'),
      (line) => line.includes('[x]'),
      WAIT_OPTIONS,
    );
    assert.ok(lineOf('R1').startsWith('- [x]'), `R1にチェックが入っていない: ${lineOf('R1')}`);
    assert.ok(lineOf('R2').startsWith('- [x]'), `R2にチェックが入っていない: ${lineOf('R2')}`);
    // このrunに含まれない項目は触らない。
    assert.ok(lineOf('R3').startsWith('- [ ]'), `含まれない項目R3が変わった: ${lineOf('R3')}`);
    assert.ok(lineOf('R4').startsWith('- [ ]'), `別フェーズの項目R4が変わった: ${lineOf('R4')}`);

    // 書き換えるのはチェックボックスの記号だけ（design.md §16.19）。人が書いた文面は不変。
    const before = roadmapMarkdown.split('\n');
    const after = roadmapLines();
    assert.equal(after.length, before.length, '行数が変わっている');
    for (const [index, line] of after.entries()) {
      const original = before[index] ?? '';
      assert.equal(
        line.replace('[x]', '[ ]'),
        original,
        `チェック以外の文面が変わっている（${index + 1}行目）: ${original} -> ${line}`,
      );
    }
  });

  test('doneにならなかったタスクの項目にはチェックが入らない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();

    // R1が失敗すると、依存するR2はskippedになる（どちらもdoneではない）。
    host.get('R1').finishFailed();
    const finished = await waitForSnapshot(
      runId,
      (s) => s !== undefined && s.outcome !== 'running',
      'runが終わる',
    );
    assert.equal(stateOf(finished, 'R1'), 'failed');
    assert.equal(stateOf(finished, 'R2'), 'skipped');

    // 書き戻しはrunの結果を問わず走るが、doneが1件も無いのでファイルは変わらない。
    await waitFor(
      () => workflow.runner.getSnapshot(runId)?.outcome,
      (outcome) => outcome !== 'running',
      WAIT_OPTIONS,
    );
    assert.equal(fs.readFileSync(roadmapPath, 'utf8'), roadmapMarkdown, 'ロードマップが変わった');
  });

  test('runが実行中の間は片付けが失敗し、統合worktreeは撤去されない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();

    const result = await workflow.runner.cleanupIntegration(runId);
    assert.equal(result.integrationRemoved, false, '実行中なのに統合worktreeを撤去した');
    assert.ok(
      result.integrationFailedMessage?.includes('実行中') === true,
      `実行中である旨が返らない: ${String(result.integrationFailedMessage)}`,
    );
    // 走行中のタスクのworktreeも残る。
    const cwd = taskOf(workflow.runner.getSnapshot(runId), 'R1')?.cwd;
    assert.ok(cwd !== undefined && fs.existsSync(cwd), '走行中タスクのworktreeが消えた');
  });

  test('片付けで統合worktreeとタスクのworktreeが撤去され、ブランチは残る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();

    const r1Cwd = taskOf(workflow.runner.getSnapshot(runId), 'R1')?.cwd;
    host.get('R1').finishDone('R1の結果');
    await waitForSnapshot(runId, (s) => taskOf(s, 'R2')?.hasLiveSession === true, 'R2が開始される');
    const r2Cwd = taskOf(workflow.runner.getSnapshot(runId), 'R2')?.cwd;
    host.get('R2').finishDone('R2の結果');
    await waitForSnapshot(
      runId,
      (s) => s !== undefined && s.outcome !== 'running',
      'runが終わる',
    );

    const integrationCwd = path.join(
      workspaceFolder,
      '.agents',
      'worktrees',
      runId,
      '_integration',
    );
    assert.ok(fs.existsSync(integrationCwd), '統合worktreeが作られていない');

    const result = await workflow.runner.cleanupIntegration(runId);
    assert.equal(result.integrationRemoved, true, `統合worktreeが撤去されない: ${JSON.stringify(result)}`);
    assert.equal(fs.existsSync(integrationCwd), false, '統合worktreeのディレクトリが残っている');
    for (const cwd of [r1Cwd, r2Cwd]) {
      assert.ok(cwd !== undefined);
      assert.equal(fs.existsSync(cwd), false, `タスクのworktreeが残っている: ${cwd}`);
    }

    // ブランチ自体は消さない（PR/MRから辿れる状態を保つ。design.md §16.17）。
    const branches = execFileSync('git', ['branch', '--list', `wf/${runId}/*`], {
      cwd: workspaceFolder,
      encoding: 'utf8',
    });
    for (const name of [`wf/${runId}/R1`, `wf/${runId}/R2`, `wf/${runId}/integration`]) {
      assert.ok(branches.includes(name), `ブランチが消えている: ${name}（${branches}）`);
    }
  });
});
