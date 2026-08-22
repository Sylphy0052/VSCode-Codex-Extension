import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { activateExtension } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import {
  describeSnapshot,
  FakeTaskSession,
  FakeTaskSessionHost,
  mergeCommitSubject,
  stateOf,
  taskOf,
  type WorkflowRunSnapshotLike,
  type WorkflowTestApiLike,
} from './helpers/workflow';
import { waitFor } from './helpers/waitFor';

/**
 * 統合の衝突と自動解決（design.md §16.17、Issue #170）。対応する手動手順は圧縮前の
 * [docs/manual-test.md](../../docs/manual-test.md) のW-15。
 *
 * 必要なのは**実gitの衝突を起こすこと**だけで、外部CLIは要らない。フェイクの
 * `TaskSession` はタスクのworktreeを `cwd` として受け取るので、テスト側がそこへ同じ
 * ファイルの同じ行を書いてコミットすれば、後からマージする側で必ず衝突する。
 *
 * 衝突解決セッションもフェイクの `TaskSessionHost` が受けるため、渡されるプロンプトの
 * 中身まで確かめられる（統合worktreeの `cwd`・未解決パス・突き合わせる2タスクの
 * `prompt` と `done`）。実際に「解ける」かどうかはモデルの出力に依存するため、そこだけは
 * manual-test.md のW-Dに残る。
 */
suite('統合の衝突と自動解決（design.md §16.17）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 30_000, intervalMs: 100 } as const;
  /** 2つの並列タスクが同じ行を書き換えるファイル。 */
  const SHARED_FILE = 'shared.md';
  /** 統合worktreeのディレクトリ名（`INTEGRATION_DIR_NAME`）。 */
  const INTEGRATION_DIR = '_integration';

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
    defPath = manifest.workflow.conflictDefPath;
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

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** 共有ファイルへ `line` を書き、コミットする。 */
  function writeAndCommit(cwd: string, line: string, message: string): void {
    fs.writeFileSync(path.join(cwd, SHARED_FILE), `${line}\n`, 'utf8');
    git(cwd, 'add', SHARED_FILE);
    git(cwd, 'commit', '--no-verify', '-m', message);
  }

  /** 実行を開始し、依存の無いタスクのセッションが開かれるまで待つ。 */
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
      (s) =>
        taskOf(s, 'T1')?.hasLiveSession === true &&
        taskOf(s, 'T2')?.hasLiveSession === true &&
        taskOf(s, 'T4')?.hasLiveSession === true,
      '依存の無いタスクのセッションが開かれる',
    );
    return runId;
  }

  /**
   * T1を先にマージして `done` にし、続けてT2で衝突させる。衝突解決セッションが開いた
   * ところまで進めて返す。
   */
  async function conflictOnT2(): Promise<{ runId: string; resolution: FakeTaskSession }> {
    const runId = await start();

    writeAndCommit(host.get('T1').cwd, 'T1が書いた行', 'feat: T1の成果');
    host.get('T1').finishDone('T1の結果');
    await waitForSnapshot(runId, (s) => stateOf(s, 'T1') === 'done', 'T1がdoneになる');

    writeAndCommit(host.get('T2').cwd, 'T2が書いた行', 'feat: T2の成果');
    host.get('T2').finishDone('T2の結果');

    await waitFor(
      () => host.find(INTEGRATION_DIR),
      (s) => s !== undefined,
      WAIT_OPTIONS,
    );
    return { runId, resolution: host.get(INTEGRATION_DIR) };
  }

  test('先にマージしたタスクはdoneになり、後から衝突したタスクで解決用セッションが開く', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { runId, resolution } = await conflictOnT2();

    // 解決用セッションのcwdは統合worktree（design.md §16.17「コンフリクト」3.）。
    assert.equal(path.basename(resolution.cwd), INTEGRATION_DIR);
    assert.ok(
      resolution.cwd.includes(runId),
      `解決用セッションが別のrunの統合worktreeで開いている: ${resolution.cwd}`,
    );

    const plan = resolution.runLoopCalls[0] as
      | { initialPrompt?: string; maxIterations?: number; condition?: string }
      | undefined;
    const prompt = plan?.initialPrompt ?? '';
    assert.ok(prompt.includes(SHARED_FILE), `未解決パスがプロンプトに無い: ${prompt}`);
    assert.ok(prompt.includes('T1のプロンプト'), `相手タスクのpromptがプロンプトに無い: ${prompt}`);
    assert.ok(prompt.includes('T1の終了条件'), `相手タスクのdoneがプロンプトに無い: ${prompt}`);
    assert.ok(prompt.includes('T2のプロンプト'), `対象タスクのpromptがプロンプトに無い: ${prompt}`);
    assert.ok(prompt.includes('T2の終了条件'), `対象タスクのdoneがプロンプトに無い: ${prompt}`);
    // 上限は小さく固定する（design.md §16.17「既定は小さくする（5）」）。
    assert.equal(plan?.maxIterations, 5);

    // 衝突解決セッションの承認は標準の承認カードへ委ねる＝タスク側のallow/autoApproveを
    // 持ち込まない（design.md §16.17「コンフリクト」5.）。
    assert.equal(
      resolution.setApprovalHandlerCount,
      0,
      '解決用セッションにタスク側の承認ハンドラが差し込まれている',
    );
  });

  test('解決してコミットするとタスクがdoneになり、統合ブランチへ取り込まれる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { runId, resolution } = await conflictOnT2();

    // 統合worktreeで衝突を解いてコミットする（解決用セッションの成果に相当）。
    fs.writeFileSync(
      path.join(resolution.cwd, SHARED_FILE),
      'T1が書いた行とT2が書いた行を統合した行\n',
      'utf8',
    );
    git(resolution.cwd, 'add', SHARED_FILE);
    // マージ中のコミットなので `--no-edit` で `MERGE_MSG`（`<type>(<taskId>): merge task
    // (run <runId>)`）がそのまま使われる。リロード後の再判定（design.md §16.11）が
    // この文言を手がかりにする。
    git(resolution.cwd, 'commit', '--no-verify', '--no-edit');
    resolution.finishDone('解決した');

    const snapshot = await waitForSnapshot(runId, (s) => stateOf(s, 'T2') === 'done', 'T2がdoneになる');
    assert.equal(stateOf(snapshot, 'T2'), 'done');

    const log = git(resolution.cwd, 'log', '--oneline', '--format=%s');
    assert.ok(
      log.includes(mergeCommitSubject('T2', runId)),
      `統合ブランチにT2のマージコミットが無い: ${log}`,
    );

    // T2に依存するT3は、T2がdoneになったので開始される。
    await waitForSnapshot(
      runId,
      (s) => taskOf(s, 'T3')?.hasLiveSession === true,
      'T3が開始される',
    );
  });

  test('解決できないままセッションが終わるとマージが巻き戻り、blockedと後続のskippedになる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { runId, resolution } = await conflictOnT2();
    const integrationCwd = resolution.cwd;
    const beforeHead = git(integrationCwd, 'rev-parse', 'HEAD').trim();

    // 上限に達して終わる（実物のループ制御は`ChatViewManager`側にあるため、フェイクは
    // `LoopStopReason` を直接渡して同じ状況を作る）。
    resolution.finishWith('maxIterations');

    const blocked = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T2') === 'blocked',
      'T2がblockedになる',
    );
    assert.equal(stateOf(blocked, 'T2'), 'blocked');

    // 統合ブランチはマージ前のコミットへ巻き戻り、未解決のパスも残らない
    // （design.md §16.17「コンフリクト」7.）。
    assert.equal(git(integrationCwd, 'rev-parse', 'HEAD').trim(), beforeHead);
    assert.equal(git(integrationCwd, 'diff', '--name-only', '--diff-filter=U').trim(), '');

    // 独立した枝（T4）は最後まで走り、T2に依存するT3だけがskippedになる。
    host.get('T4').finishDone('T4の結果');
    const settled = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T4') === 'done' && stateOf(s, 'T3') === 'skipped',
      'T4がdone・T3がskippedになる',
    );
    assert.equal(stateOf(settled, 'T3'), 'skipped');
    assert.equal(stateOf(settled, 'T4'), 'done');
  });

  test('人が解決したうえで再マージするとdoneになり、統合ブランチへ入る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { runId, resolution } = await conflictOnT2();
    const integrationCwd = resolution.cwd;
    resolution.finishWith('maxIterations');
    await waitForSnapshot(runId, (s) => stateOf(s, 'T2') === 'blocked', 'T2がblockedになる');

    // 「人が解決する」= タスク側のworktreeで統合ブランチを取り込み、衝突を解いてコミット
    // する。タスクブランチ側に解決の記録が残るため、次のマージは衝突しない（内容を統合
    // ブランチへ合わせるだけでは、gitは双方の変更として再び衝突と判定する）。
    const taskCwd = host.get('T2').cwd;
    const integrationBranch = `wf/${runId}/integration`;
    try {
      git(taskCwd, 'merge', '--no-ff', '--no-commit', integrationBranch);
    } catch {
      // 衝突して終了コードが0以外になるのが想定どおり。解決はこの下で行う。
    }
    fs.writeFileSync(path.join(taskCwd, SHARED_FILE), 'T1が書いた行\nT2が追記した行\n', 'utf8');
    git(taskCwd, 'add', SHARED_FILE);
    git(taskCwd, 'commit', '--no-verify', '-m', 'fix: 統合ブランチを取り込んで解決');

    assert.equal(workflow.runner.retryMerge(runId, 'T2'), true, '再マージを受け付けない');

    const snapshot = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T2') === 'done',
      '再マージでT2がdoneになる',
    );
    assert.equal(stateOf(snapshot, 'T2'), 'done');
    const log = git(integrationCwd, 'log', '--format=%s');
    assert.ok(
      log.includes(mergeCommitSubject('T2', runId)),
      `再マージ後も統合ブランチにマージコミットが無い: ${log}`,
    );
  });
});
