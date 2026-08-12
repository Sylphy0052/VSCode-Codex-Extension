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
  warningsOfKind,
  type WorkflowRunSnapshotLike,
  type WorkflowTestApiLike,
} from './helpers/workflow';

/**
 * gitの作業ツリーでないワークスペースでの隔離（design.md §16.20、Issue #168）を
 * 実VSCode上で確かめる。対応する手動手順は圧縮前の [docs/manual-test.md](../../docs/manual-test.md)
 * のW-19とW-07。
 *
 * `WorkflowRunner.start(defPath, repoRoot)` の `repoRoot` はVSCodeが開いている
 * ワークスペースフォルダである必要がない。そこで、fixtureが作った**gitリポジトリでない**
 * 親ディレクトリの下にケースごとの使い捨てフォルダを掘り、それを `repoRoot` として渡す。
 * ワークスペースの切り替え（＝別のVSCode起動）が要らないぶん、既存の統合テストと同じ
 * 1回の起動に相乗りできる。
 *
 * `#158` と同じくCLIとの境界（`TaskSessionHost.openTaskSession`）だけをフェイクへ差し替え、
 * 複製の作成・差分の計算・統合・ワークスペースへの反映は実物（`pseudoWorktree.ts`）を通す。
 * フェイクのセッションは `cwd`（＝複製先）を持っているので、テストはそこへ実際にファイルを
 * 書いてから完了を宣言することで「タスクが成果物を作った」状態を作れる。
 */
suite('疑似worktree（design.md §16.20）', () => {
  /** 複製・スナップショット・統合はファイル操作を伴うため、既定の20秒では足りないことがある。 */
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 30_000, intervalMs: 100 } as const;

  let workflow: WorkflowTestApiLike;
  let host: FakeTaskSessionHost;
  let pseudoRoot: string;
  let defTemplate: string;
  let strictDefTemplate: string;
  const startedRunIds: string[] = [];
  const createdWorkspaces: string[] = [];

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
    pseudoRoot = manifest.pseudoWorktree.root;
    defTemplate = manifest.pseudoWorktree.defTemplate;
    strictDefTemplate = manifest.pseudoWorktree.strictDefTemplate;
  });

  teardown(() => {
    for (const runId of startedRunIds) {
      workflow.runner.stop(runId);
    }
    startedRunIds.length = 0;
    // 使い捨てワークスペースは複製と統合結果を含むので、フォルダごと消す
    // （gitのworktreeではないため `removeWorktrees` の対象にならない）。
    for (const dir of createdWorkspaces) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    createdWorkspaces.length = 0;
    workflow.setTaskSessionHost('codex', undefined);
  });

  /**
   * ケース1件分の使い捨てワークスペースを作る。**gitリポジトリにはしない**（それがこの
   * テストの前提）。定義のひな形をコピーし、ワークスペース直下に既存ファイルを1つ置く
   * （反映の確認と「実行中の人の編集」の検知に使う）。
   */
  function createWorkspace(
    caseName: string,
    template = defTemplate,
  ): {
    root: string;
    defPath: string;
  } {
    const root = path.join(pseudoRoot, caseName);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    createdWorkspaces.push(root);
    fs.writeFileSync(path.join(root, 'README.md'), '疑似worktreeの統合テスト\n', 'utf8');
    const defPath = path.join(root, 'workflow.yaml');
    fs.copyFileSync(template, defPath);
    assert.equal(
      fs.existsSync(path.join(root, '.git')),
      false,
      'このテストの前提として、ワークスペースはgitリポジトリであってはならない',
    );
    return { root, defPath };
  }

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
  async function startAndWaitForT1(defPath: string, root: string): Promise<string> {
    const result = await workflow.runner.start(defPath, root);
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
    return runId;
  }

  /** タスクの作業ディレクトリへファイルを書いてから完了を宣言する。 */
  function finishWithFile(taskId: string, relativePath: string, content: string): void {
    const session = host.get(taskId);
    const target = path.join(session.cwd, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    session.finishDone(`${taskId}の結果`);
  }

  test('タスクごとに複製が作られ、互いに別ディレクトリになる（W-19 / 旧W-07の警告つき）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { root, defPath } = createWorkspace('clone-per-task');

    const runId = await startAndWaitForT1(defPath, root);

    // gitの作業ツリーでないため、`decideWorkingDirectory` は `sharedFallback` へ倒れ、
    // その旨が警告として残る（旧W-07）。倒れた先が疑似worktreeであることを下で確かめる。
    const started = workflow.runner.getSnapshot(runId);
    assert.ok(
      warningsOfKind(started, 'gitFallback').some((w) => w.taskId === 'T1'),
      `gitの作業ツリーでない旨の警告が出ていない: ${describeSnapshot(started)}`,
    );

    const t1Cwd = host.get('T1').cwd;
    assert.equal(
      t1Cwd,
      path.join(root, '.agents', 'worktrees', runId, 'T1'),
      '複製先が .agents/worktrees/<runId>/<taskId> になっていない',
    );
    assert.ok(fs.existsSync(t1Cwd), '複製先ディレクトリが実際に作られていない');
    assert.ok(
      fs.existsSync(path.join(t1Cwd, 'README.md')),
      'ワークスペースの中身が複製されていない',
    );
    assert.equal(
      fs.existsSync(path.join(t1Cwd, '.agents', 'worktrees')),
      false,
      '複製先へ .agents/worktrees が入っている（無限再帰の防止が効いていない）',
    );

    finishWithFile('T1', 'docs/t1.md', 'T1\n');
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T2')?.hasLiveSession === true && taskOf(s, 'T3')?.hasLiveSession === true,
      'T2とT3が並列で走る',
    );

    const t2Cwd = host.get('T2').cwd;
    const t3Cwd = host.get('T3').cwd;
    assert.notEqual(t2Cwd, t3Cwd, '並列タスクが同じディレクトリを共有している');
    assert.ok(fs.existsSync(t2Cwd) && fs.existsSync(t3Cwd), '複製先が実在しない');

    // 互いのファイルを踏まないこと。T2の書き込みがT3から見えてはいけない。
    fs.writeFileSync(path.join(t2Cwd, 'only-t2.md'), 'T2\n', 'utf8');
    assert.equal(
      fs.existsSync(path.join(t3Cwd, 'only-t2.md')),
      false,
      '片方のタスクの書き込みがもう片方の作業ディレクトリへ漏れている',
    );
  });

  test('runが失敗で終わっても、統合できた分はワークスペースへ反映される', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { root, defPath } = createWorkspace('reflect-on-failure');

    const runId = await startAndWaitForT1(defPath, root);
    finishWithFile('T1', 'docs/t1.md', 'T1\n');
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T2')?.hasLiveSession === true && taskOf(s, 'T3')?.hasLiveSession === true,
      'T2とT3が並列で走る',
    );

    // T2は成果を残して完了、T3は失敗。runの結果は失敗になる。
    finishWithFile('T2', 'docs/t2.md', 'T2\n');
    await waitForSnapshot(runId, (s) => stateOf(s, 'T2') === 'done', 'T2がdoneになる');
    host.get('T3').finishFailed();

    const finished = await waitForSnapshot(
      runId,
      (s) => s !== undefined && s.outcome !== 'running',
      'runが終わる',
    );
    assert.notEqual(finished.outcome, 'succeeded', 'T3が失敗したのにrunが成功扱いになっている');

    // design.md §16.20「runが終わったら、統合先の内容をワークスペースへ反映する」。
    // 反映はrunの結果を条件にしていないため、失敗で終わっても統合済みの分は反映される。
    await waitFor(
      () => fs.existsSync(path.join(root, 'docs', 't2.md')),
      (exists) => exists,
      WAIT_OPTIONS,
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'docs', 't1.md'), 'utf8'),
      'T1\n',
      'T1の成果がワークスペースへ反映されていない',
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'docs', 't2.md'), 'utf8'),
      'T2\n',
      'T2の成果がワークスペースへ反映されていない',
    );
  });

  test('同じファイルを変更した並列タスクは、解決用セッションを開かず直接blockedになる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { root, defPath } = createWorkspace('conflict');

    const runId = await startAndWaitForT1(defPath, root);
    finishWithFile('T1', 'docs/t1.md', 'T1\n');
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T2')?.hasLiveSession === true && taskOf(s, 'T3')?.hasLiveSession === true,
      'T2とT3が並列で走る',
    );

    const sessionsBeforeConflict = host.sessions.length;

    // 同じパスへ別の内容を書く。先に統合されたT2が通り、あとから来たT3が衝突する
    // （3-way mergeができないため、内容を見ずに衝突として扱われる）。
    finishWithFile('T2', 'docs/shared.md', 'T2が書いた\n');
    await waitForSnapshot(runId, (s) => stateOf(s, 'T2') === 'done', 'T2がdoneになる');
    finishWithFile('T3', 'docs/shared.md', 'T3が書いた（内容が違う）\n');

    const blocked = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T3') === 'blocked',
      'T3がblockedになる',
    );
    const conflicts = warningsOfKind(blocked, 'pseudoWorktreeConflict');
    assert.ok(
      conflicts.some((w) => w.taskId === 'T3' && w.message.includes('docs/shared.md')),
      `衝突したパスを含む警告が出ていない: ${describeSnapshot(blocked)}`,
    );

    // design.md §16.20「衝突解決セッションは開かない」。統合先（`_integration`）を
    // cwdにしたセッションが増えていないことで確かめる。
    assert.equal(
      host.sessions.length,
      sessionsBeforeConflict,
      '衝突の解決用セッションが開かれている（疑似worktreeでは開かない）',
    );
    assert.equal(
      host.sessions.some((s) => s.cwd.endsWith('_integration')),
      false,
      '統合先を作業ディレクトリにしたセッションが開かれている',
    );
  });

  test('実行中にワークスペースが変更されると、反映せずに警告を残す', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { root, defPath } = createWorkspace('workspace-changed');

    const runId = await startAndWaitForT1(defPath, root);

    // run開始時に取ったスナップショットとの差分が出るよう、人の編集を模して
    // ワークスペース直下のファイルを書き換える（サイズが変わる内容にする）。
    fs.writeFileSync(
      path.join(root, 'README.md'),
      '人が実行中に書き換えた内容。上書きされてはいけない。\n',
      'utf8',
    );

    finishWithFile('T1', 'docs/t1.md', 'T1\n');
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T2')?.hasLiveSession === true && taskOf(s, 'T3')?.hasLiveSession === true,
      'T2とT3が並列で走る',
    );
    finishWithFile('T2', 'docs/t2.md', 'T2\n');
    finishWithFile('T3', 'docs/t3.md', 'T3\n');

    const finished = await waitForSnapshot(
      runId,
      (s) => s !== undefined && s.outcome !== 'running',
      'runが終わる',
    );

    const blockedWarnings = await waitFor(
      () => warningsOfKind(workflow.runner.getSnapshot(runId), 'pseudoWorktreeReflectBlocked'),
      (list) => list.length > 0,
      WAIT_OPTIONS,
    ).catch(() => {
      throw new Error(`反映の中止が警告として残らなかった: ${describeSnapshot(finished)}`);
    });
    assert.ok(
      blockedWarnings[0]?.message.includes('README.md'),
      `変更されたパスが警告に含まれていない: ${JSON.stringify(blockedWarnings)}`,
    );

    assert.equal(
      fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
      '人が実行中に書き換えた内容。上書きされてはいけない。\n',
      '人の編集が上書きされている',
    );
    assert.equal(
      fs.existsSync(path.join(root, 'docs', 't1.md')),
      false,
      'ワークスペースが変更されているのに統合結果が反映されている',
    );
  });

  test('gitでないワークスペースでは isolation: worktree-strict が1タスクも開始せず拒否される', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { root, defPath } = createWorkspace('strict', strictDefTemplate);

    const result = await workflow.runner.start(defPath, root);

    assert.equal(result.ok, false, 'worktree-strict なのに実行が始まっている');
    assert.equal(result.runId, undefined, '拒否されたのにrunIdが返っている');
    const messages = (result.errors ?? []).map((e) => e.message).join(' / ');
    assert.ok(
      messages.includes('worktree-strict'),
      `理由が worktree-strict に触れていない: ${messages}`,
    );
    assert.equal(host.sessions.length, 0, '拒否されたのにセッションが開かれている');
    assert.equal(
      fs.existsSync(path.join(root, '.agents', 'worktrees')),
      false,
      '拒否されたのに複製先ディレクトリが作られている',
    );
  });
});
