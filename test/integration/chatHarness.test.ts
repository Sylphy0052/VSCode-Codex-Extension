import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  createFakeClaudeSpawn,
  FakeAppServerConnection,
  type FakeClaudeProcess,
} from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { waitFor } from './helpers/waitFor';

/**
 * チャット画面の統合テストの土台（Issue #186）。
 *
 * C群・L群を移送するための差し替え口が実際に効くことだけを確かめる。個々のケースの移送は
 * #187（Codex）/ #188（Claude Code）で進める。
 *
 * 差し替えるのは**CLIとの境界だけ**で、会話の組み立て・状態遷移・パネルの生成は実物を通る。
 * Codexは `app-server` との接続（`AppServerConnectionPort`）、Claude Codeはプロセスの起動
 * （`ClaudeSpawnPort`）が境界にあたる。
 */
suite('チャット画面の統合テストの土台（Issue #186）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 20_000, intervalMs: 50 } as const;

  let chat: ChatTestApiLike;

  setup(async () => {
    const api = await activateExtension();
    assert.ok(
      api.chat !== undefined,
      'AGENT_SESSIONS_INTEGRATION_TEST=1 のときチャット画面のテスト用APIが公開される',
    );
    chat = api.chat;
  });

  teardown(async () => {
    chat.setCodexConnection(undefined);
    chat.setClaudeSpawn(undefined);
    // 開いたチャット画面のタブを閉じる（次のケースへ持ち越さない）。
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Codex画面はapp-serverとの接続を差し替えると、実CLIなしでスレッドを開始する', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    let fake: FakeAppServerConnection | undefined;
    chat.setCodexConnection((onNotification, onServerRequest) => {
      fake = new FakeAppServerConnection(onNotification, onServerRequest);
      fake.respond('thread/start', () => ({ thread: { id: 'fake-thread-1' } }));
      return fake;
    });

    await vscode.commands.executeCommand('codex.newChat');

    const connection = fake;
    assert.ok(connection !== undefined, '接続のファクトリが呼ばれていない');
    await waitFor(
      () => connection.called('thread/start'),
      (called) => called,
      WAIT_OPTIONS,
    );

    // 接続を張ってからスレッドを開始する（`ChatSession.start`）。
    assert.ok(connection.startedCount > 0, 'ensureStartedが呼ばれていない');
    const start = connection.firstCall('thread/start');
    const params = start?.params as { cwd?: string } | undefined;
    assert.ok(
      typeof params?.cwd === 'string' && params.cwd !== '',
      `thread/start にcwdが渡っていない: ${JSON.stringify(start?.params)}`,
    );
    // 実CLIは一切起動していない（フェイクだけが要求を受けている）。
    assert.deepEqual(
      connection.calls.map((c) => c.method).filter((m) => m === 'thread/start'),
      ['thread/start'],
      'thread/start が複数回呼ばれている',
    );
  });

  test('Claude Code画面はプロセスの起動を差し替えると、実CLIなしでcontrol protocolを話し始める', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const fake = createFakeClaudeSpawn();
    chat.setClaudeSpawn(fake.spawn);

    await vscode.commands.executeCommand('claude.newChat');

    await waitFor(
      () => fake.processes.length,
      (count) => count > 0,
      WAIT_OPTIONS,
    );
    const launched = fake.calls[0];
    assert.ok(launched !== undefined);
    // `--print --input-format stream-json` の常駐プロセスとして起動する（design.md §14.4）。
    assert.ok(
      launched.args.includes('--input-format') && launched.args.includes('stream-json'),
      `stream-jsonで起動していない: ${launched.args.join(' ')}`,
    );
    // 巻き戻し（`rewind_files`）のためのゲート（design.md「Claude Codeの巻き戻し」）。
    assert.equal(launched.env['CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING'], '1');

    // 起動直後にcontrol protocolの初期化を送る。中身はフェイクのstdinでそのまま見える。
    const proc = fake.processes[0] as FakeClaudeProcess;
    await waitFor(
      () => proc.writtenLines(),
      (lines) => lines.length > 0,
      WAIT_OPTIONS,
    );
    const first = proc.writtenLines()[0];
    assert.equal(
      first?.['type'],
      'control_request',
      `control_requestで始まっていない: ${JSON.stringify(first)}`,
    );
    const request = first?.['request'] as { subtype?: string } | undefined;
    assert.equal(request?.subtype, 'initialize');
  });

  test('差し替えを外すと実物へ戻る（本番の経路を残す）', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    let fake: FakeAppServerConnection | undefined;
    chat.setCodexConnection((onNotification, onServerRequest) => {
      fake = new FakeAppServerConnection(onNotification, onServerRequest);
      fake.respond('thread/start', () => ({ thread: { id: 'fake-thread-2' } }));
      return fake;
    });
    chat.setCodexConnection(undefined);

    // 実物へ戻っているので、フェイクは一度も呼ばれない。実CLIのパスは存在しないパスへ
    // 固定してあるため（`fixtures/setup.mjs`）、画面は開くが接続は失敗する。
    await vscode.commands.executeCommand('codex.newChat');
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(fake?.calls ?? [], [], '差し替えを外したのにフェイクが呼ばれている');
    assert.equal(fake?.disposed, true, '差し替えを外したときにフェイクが片付けられていない');
  });
});
