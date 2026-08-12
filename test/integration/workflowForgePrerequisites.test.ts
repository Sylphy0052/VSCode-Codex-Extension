import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activateExtension } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import {
  describeSnapshot,
  FakeTaskSessionHost,
  RecordingCli,
  stateOf,
  taskOf,
  warningsOfKind,
  type ForgeOverridesLike,
  type WorkflowRunSnapshotLike,
  type WorkflowTestApiLike,
} from './helpers/workflow';
import { waitFor } from './helpers/waitFor';

/**
 * PR/MRの前提（`origin` remote・`gh` / `glab` のPATH・認証）が欠けているときの挙動
 * （design.md §16.18「前提が欠けている場合」、Issue #169）。対応する手動手順は圧縮前の
 * [docs/manual-test.md](../../docs/manual-test.md) のW-18。
 *
 * 統合テストのfixtureリポジトリは `origin` remoteを持たず、`PATH` も `/usr/bin:/bin` に
 * 制限されている（`.vscode-test.mjs`）。つまり**前提が欠けている状態が既定**であり、
 * このIssueが確かめたい経路はそのまま作れる。`setForgeOverrides`（Issue #169で追加）で
 * ホストの判定結果とCLIの有無・認証状態だけを差し替え、欠けている項目を1つずつ変える。
 *
 * `git` は差し替えていないため、統合ブランチへのマージは実gitで行われる。`origin` への
 * pushは `LiveRunForgeState` が `active` の経路でしか呼ばれず、このファイルのケースは
 * 全て `skipped` になるので、テストがリモートへ触れることはない（`RecordingCli` も
 * 何も実行しない）。
 */
suite('PR/MRの前提が欠けている場合（design.md §16.18）', () => {
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

  /** 前提を差し替えたうえで実行を開始し、T1のセッションが開かれるまで待つ。 */
  async function startWith(overrides: ForgeOverridesLike): Promise<string> {
    workflow.setForgeOverrides(overrides);
    const result = await workflow.runner.start(defPath, workspaceFolder);
    assert.equal(
      result.ok,
      true,
      `前提が欠けているだけで実行が止まっている: ${(result.errors ?? [])
        .map((e) => e.message)
        .join(' / ')}`,
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

  /** `agent.workflows.forge` などの設定を丸ごと返す差し替え。 */
  function config(
    host: 'auto' | 'github' | 'gitlab' | 'none',
    finalMerge: string,
  ): NonNullable<ForgeOverridesLike['readConfig']> {
    return () => ({ host, pullRequest: 'per-task', finalMerge });
  }

  /** fixtureリポジトリで `git` を実行する（統合ブランチの確認用）。 */
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: workspaceFolder, encoding: 'utf8' }).trim();
  }

  /**
   * タスクのworktreeで成果物を1件コミットしてから完了を宣言する。
   *
   * 実運用ではCLIがコミットまで行うが、フェイクのセッションは何も書かない。コミットが
   * 無いとタスクブランチが統合ブランチと同じコミットのままで、`git merge --no-ff` が
   * 「Already up to date」になりマージコミットが残らない（＝マージされたことを確かめ
   * られない）ため、テスト側で実際に差分を作る。
   */
  function commitAndFinish(taskId: string, fileName: string): void {
    const session = host.get(taskId);
    const runGit = (...args: string[]): void => {
      execFileSync('git', args, { cwd: session.cwd, stdio: 'pipe' });
    };
    fs.writeFileSync(path.join(session.cwd, fileName), `${taskId}の成果\n`, 'utf8');
    runGit('add', fileName);
    runGit('commit', '--no-verify', '-m', `feat: ${taskId}の成果`);
    session.finishDone(`${taskId}の結果`);
  }

  test('originのremoteが無いと、ホストを判定できない旨の警告が出てPR/MRを飛ばす', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const cli = new RecordingCli(true);

    // `agent.workflows.forge` は既定の `auto`。remoteが無いためホストを判定できない。
    const runId = await startWith({ cli, readConfig: config('auto', 'auto') });

    const snapshot = workflow.runner.getSnapshot(runId);
    const skipped = warningsOfKind(snapshot, 'forgeSkipped');
    assert.ok(
      skipped.some((w) => w.message.includes('origin')),
      `originのremoteに触れた警告が出ていない: ${describeSnapshot(snapshot)}`,
    );
    assert.deepEqual(cli.calls, [], 'ホストを判定できないのにCLIを呼んでいる');
  });

  test('gh / glab がPATHに無いと警告のうえPR/MRを飛ばし、ローカルのマージだけ進む', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const cli = new RecordingCli(true);

    // ホストは設定で確定させ、CLIが見つからない状態を作る。remoteが無いことも
    // 同時に検知されるため、警告は2件出る（どちらも「飛ばす」理由として正しい）。
    const runId = await startWith({
      cli,
      cliAvailability: { isOnPath: () => Promise.resolve(false) },
      readConfig: config('github', 'auto'),
    });

    const snapshot = workflow.runner.getSnapshot(runId);
    const skipped = warningsOfKind(snapshot, 'forgeSkipped');
    assert.ok(
      skipped.some((w) => w.message.includes('gh') && w.message.includes('PATH')),
      `ghがPATHに無い旨の警告が出ていない: ${describeSnapshot(snapshot)}`,
    );
    assert.ok(
      skipped.some((w) => w.message.includes('origin')),
      `originのremoteが無い旨の警告が出ていない: ${describeSnapshot(snapshot)}`,
    );
    assert.deepEqual(cli.calls, [], 'PATHに無いと判定したのにCLIを呼んでいる');

    // ワークフロー自体は止まらず、統合ブランチへのローカルのマージまで進む。
    commitAndFinish('T1', 't1.md');
    const merged = await waitForSnapshot(runId, (s) => stateOf(s, 'T1') === 'done', 'T1がdoneになる');
    assert.equal(stateOf(merged, 'T1'), 'done');

    const log = git('log', '--oneline', `wf/${runId}/integration`);
    assert.ok(
      log.includes(`Merge task T1 (run ${runId})`),
      `統合ブランチへローカルのマージが入っていない: ${log}`,
    );
  });

  test('認証が通っていないと警告のうえPR/MRを飛ばす（auth status以外は呼ばない）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const cli = new RecordingCli(false);

    const runId = await startWith({
      cli,
      cliAvailability: { isOnPath: () => Promise.resolve(true) },
      readConfig: config('github', 'auto'),
    });

    const snapshot = workflow.runner.getSnapshot(runId);
    const skipped = warningsOfKind(snapshot, 'forgeSkipped');
    assert.ok(
      skipped.some((w) => w.message.includes('認証')),
      `認証が通っていない旨の警告が出ていない: ${describeSnapshot(snapshot)}`,
    );
    assert.deepEqual(
      cli.calls.map((c) => `${c.command} ${c.args.join(' ')}`),
      ['gh auth status'],
      '前提チェック以外でCLIを呼んでいる',
    );
  });

  test('finalMerge: auto でも、前提が欠けていればmainへのマージは行われない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const cli = new RecordingCli(true);
    const mainBefore = git('rev-parse', 'main');

    const runId = await startWith({
      cli,
      cliAvailability: { isOnPath: () => Promise.resolve(false) },
      readConfig: config('github', 'auto'),
    });

    // 全タスクを完了させ、runを最後まで走らせる（finalMergeが動きうる状態にする）。
    host.get('T1').finishDone('T1の結果');
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T2')?.hasLiveSession === true && taskOf(s, 'T3')?.hasLiveSession === true,
      'T2とT3が並列で走る',
    );
    host.get('T2').finishDone('T2の結果');
    host.get('T3').finishDone('T3の結果');
    await waitForSnapshot(runId, (s) => taskOf(s, 'T4')?.hasLiveSession === true, 'T4が走る');
    host.get('T4').finishDone('T4の結果');

    const finished = await waitForSnapshot(
      runId,
      (s) => s !== undefined && s.outcome !== 'running',
      'runが終わる',
    );
    assert.equal(
      finished.outcome,
      'succeeded',
      `前提が欠けているだけでrunが失敗している: ${describeSnapshot(finished)}`,
    );

    assert.equal(git('rev-parse', 'main'), mainBefore, 'mainが進んでいる');
    assert.deepEqual(cli.nonAuthCalls(), [], 'PR/MRの作成やマージのためにCLIを呼んでいる');

    // 統合ブランチはローカルに残る（PR/MRから辿れる状態を保つ、というgit側の意図と同じ）。
    const branches = git('branch', '--list', `wf/${runId}/integration`);
    assert.notEqual(branches, '', '統合ブランチがローカルに残っていない');
  });
});
