import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activateExtension } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import { listTasks, sendMessage } from './helpers/mcpClient';
import {
  describeSnapshot,
  FakeTaskSession,
  FakeTaskSessionHost,
  stateOf,
  taskOf,
  warningsOfKind,
  type WorkflowRunSnapshotLike,
  type WorkflowTestApiLike,
} from './helpers/workflow';
import { waitFor } from './helpers/waitFor';

/**
 * タスク間メッセージング（design.md §16.21、Issue #171）。対応する手動手順は圧縮前の
 * [docs/manual-test.md](../../docs/manual-test.md) のW-20。
 *
 * runごとに立つMCPサーバ（HTTP）は統合テストでも実物が動く（外部CLIに依存しない）。
 * タスクごとの接続URLは `TaskSessionInput.mcp.url` としてフェイクの `TaskSessionHost` へ
 * 渡るため、テストはそのURLへ実際にJSON-RPCを投げる。送信元はサーバがURLのトークンから
 * 判別するので、**引数で名乗っても無視される**ことまで本物の経路で確かめられる。
 */
suite('タスク間メッセージング（design.md §16.21）', () => {
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
    defPath = manifest.workflow.messagingDefPath;
    workspaceFolder = manifest.workspaceFolder;
  });

  teardown(async () => {
    for (const runId of startedRunIds) {
      workflow.runner.stop(runId);
      await workflow.runner.removeWorktrees(runId);
    }
    startedRunIds.length = 0;
    workflow.setTaskSessionHost('codex', undefined);
    await vscode.workspace
      .getConfiguration('agent')
      .update('workflows.replyTimeoutSec', undefined, vscode.ConfigurationTarget.Workspace);
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

  /** 実行を開始し、全タスクのセッションが開かれるまで待つ。 */
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
        taskOf(s, 'T3')?.hasLiveSession === true,
      '全タスクのセッションが開かれる',
    );
    return runId;
  }

  /** そのタスクへ発行されたMCPの接続先。無ければ失敗させる。 */
  function mcpUrlOf(session: FakeTaskSession): string {
    const url = session.mcpUrl;
    assert.ok(url !== undefined, 'タスクへMCPサーバの接続先が渡っていない');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/u, 'MCPの接続先の形が違う');
    return url;
  }

  test('expectReply: true で送るとwaitingReplyになり、ループが止まる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();
    const t1 = host.get('T1');

    const result = await sendMessage(mcpUrlOf(t1), {
      to: 'T2',
      body: 'T2の進捗を教えてください',
      expectReply: true,
    });
    assert.equal(result.isError, false, `送信が受理されない: ${result.text}`);

    const snapshot = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T1') === 'waitingReply',
      'T1がwaitingReplyになる',
    );
    assert.equal(stateOf(snapshot, 'T1'), 'waitingReply');
    // 状態だけを倒さず、実際にループを止める（design.md §16.21）。
    assert.equal(t1.pauseLoopCount, 1, 'ループが実際に止まっていない');
    assert.equal(stateOf(snapshot, 'T2'), 'running', '宛先タスクは走り続ける');
  });

  test('返信が届くとrunningへ戻り、次の指示に返信の本文が添えられる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();
    const t1 = host.get('T1');
    const t2 = host.get('T2');

    await sendMessage(mcpUrlOf(t1), { to: 'T2', body: '進捗を教えて', expectReply: true });
    await waitForSnapshot(runId, (s) => stateOf(s, 'T1') === 'waitingReply', 'T1がwaitingReplyになる');

    await sendMessage(mcpUrlOf(t2), { to: 'T1', body: 'T2は実装を終えました', expectReply: false });

    const resumed = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T1') === 'running',
      'T1がrunningへ戻る',
    );
    assert.equal(stateOf(resumed, 'T1'), 'running');
    assert.equal(t1.resumeLoopCount, 1, 'ループが再開されていない');

    // 走行中のターンには割り込まず、次の指示の先頭へ添えられる（design.md §16.21「配送」）。
    const next = t1.transformPrompt('続けてください');
    assert.ok(next.includes('T2は実装を終えました'), `返信の本文が添えられていない: ${next}`);
    assert.ok(next.includes('T2'), `送信元が分からない: ${next}`);
    assert.ok(next.endsWith('続けてください'), `元の指示が末尾に残っていない: ${next}`);
  });

  test('送信元は接続から判別され、引数で別タスクを騙れない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();
    const t1 = host.get('T1');
    const t2 = host.get('T2');

    // T2の接続で、引数の `from` にはT1を名乗って送る。
    await sendMessage(
      mcpUrlOf(t2),
      { to: 'T1', body: '本当はT2からの連絡', expectReply: false },
      { from: 'T1' },
    );

    // 届いたメッセージは次の指示へ添えるときにキューから取り出される（1回きり）ため、
    // 待ち合わせで得た文字列をそのまま検証する。
    const delivered = await waitFor(
      () => t1.transformPrompt('続けてください'),
      (text) => text.includes('本当はT2からの連絡'),
      WAIT_OPTIONS,
    );
    assert.ok(delivered.includes('T2'), `送信元がT2として扱われていない: ${delivered}`);
    assert.ok(
      !/T1\s*から/u.test(delivered),
      `引数で名乗ったT1が送信元として扱われている: ${delivered}`,
    );

    // list_tasks は同じrunの一覧をそのまま返す（送信元の判別とは独立した確認）。
    const tasks = await listTasks(mcpUrlOf(t1));
    assert.deepEqual(
      tasks.map((t) => t.id).sort(),
      ['T1', 'T2', 'T3'],
      `list_tasksの一覧が違う: ${JSON.stringify(tasks)}`,
    );
    assert.ok(runId !== '');
  });

  test('走行中の全タスクが返信待ちになると、待たずに再開して警告が残る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const runId = await start();
    const t1 = host.get('T1');
    const t2 = host.get('T2');
    const t3 = host.get('T3');

    // T1とT2は、どちらも走行中のT3へ返信を求めて送る（互いに送り合うと、相手の待ちが
    // その配送で解けてしまい全員待ちにならない）。
    await sendMessage(mcpUrlOf(t1), { to: 'T3', body: 'T3の状況は？', expectReply: true });
    await sendMessage(mcpUrlOf(t2), { to: 'T3', body: 'T3の状況は？（T2から）', expectReply: true });
    await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T1') === 'waitingReply' && stateOf(s, 'T2') === 'waitingReply',
      'T1とT2がwaitingReplyになる',
    );

    // T3宛のメッセージを次の指示として受け取り（未配送を0にする）、T3自身は完了させる。
    // 残る走行中のタスクが全て返信待ちになった状況で、待ちぼうけの検出が働く。
    await waitFor(
      () => t3.transformPrompt('続けてください'),
      (text) => text.includes('T3の状況は？'),
      WAIT_OPTIONS,
    );
    t3.finishDone('T3の結果');
    await waitForSnapshot(runId, (s) => stateOf(s, 'T3') === 'done', 'T3がdoneになる');

    const released = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T1') === 'running' && stateOf(s, 'T2') === 'running',
      '全タスクがrunningへ戻る',
    );
    const warnings = warningsOfKind(released, 'messagingStalled');
    assert.ok(
      warnings.some((w) => w.message.includes('誰も動けなくなった')),
      `待ちぼうけ（全員待ち）の警告が出ていない: ${describeSnapshot(released)}`,
    );
  });

  test('replyTimeoutSec を超えると、待たずに再開して警告が残る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    // 実時間で300秒待たないよう、上限を最小値（1秒）へ落とす。
    await vscode.workspace
      .getConfiguration('agent')
      .update('workflows.replyTimeoutSec', 1, vscode.ConfigurationTarget.Workspace);

    const runId = await start();
    const t1 = host.get('T1');

    await sendMessage(mcpUrlOf(t1), { to: 'T2', body: '返事が来ない相手へ送る', expectReply: true });
    await waitForSnapshot(runId, (s) => stateOf(s, 'T1') === 'waitingReply', 'T1がwaitingReplyになる');

    // 返信は送らない。上限を超えた時点で、定期チェックが待ちを解く。
    const released = await waitForSnapshot(
      runId,
      (s) => stateOf(s, 'T1') === 'running',
      'T1が返信を待たずにrunningへ戻る',
    );
    const warnings = warningsOfKind(released, 'messagingStalled');
    assert.ok(
      warnings.some((w) => w.message.includes('上限を超えた')),
      `待ちぼうけ（タイムアウト）の警告が出ていない: ${describeSnapshot(released)}`,
    );
    assert.equal(t1.resumeLoopCount, 1, 'ループが再開されていない');
  });

  test('MCPサーバのツールが見えなければ警告が出るが、ワークフローは最後まで走る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    // 開いたセッションが「ツールが見えない」と答えるようにしておく。
    const originalOpen = host.openTaskSession.bind(host);
    host.openTaskSession = async (input) => {
      const session = (await originalOpen(input)) as FakeTaskSession;
      session.messagingToolVisible = false;
      return session;
    };

    const runId = await start();
    const warned = await waitForSnapshot(
      runId,
      (s) => warningsOfKind(s, 'messagingUnavailable').length > 0,
      'ツールが見えない旨の警告が出る',
    );
    assert.ok(warningsOfKind(warned, 'messagingUnavailable').length > 0);

    // 通信なしでも、ワークフロー自体は最後まで走る。
    host.get('T1').finishDone('T1の結果');
    host.get('T2').finishDone('T2の結果');
    host.get('T3').finishDone('T3の結果');
    const finished = await waitForSnapshot(
      runId,
      (s) => s !== undefined && s.outcome !== 'running',
      'runが終わる',
    );
    assert.equal(finished.outcome, 'succeeded', `runが完走していない: ${describeSnapshot(finished)}`);
  });
});
