import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FakeAppServerConnection } from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { waitFor } from './helpers/waitFor';

/**
 * Codex画面: 承認カード・問い合わせカードの往復（Issue #187、親Issue #186）。
 *
 * `docs/manual-test.md` の仕分け（Issue #186）で「機械」に入ったC群のうち、
 * app-serverからの`serverRequest`（承認・問い合わせ）が解決されるまでの往復を扱う。
 * 実CLIは起動せず、`FakeAppServerConnection`（`test/integration/helpers/chat.ts`）を
 * `ChatViewManager`へ差し替える。
 *
 * webviewの「許可」「拒否」ボタンはレンダラー側（別プロセス）のJSが押すため、拡張機能
 * ホスト側のテストコードから直接クリックを再現する手段が無い。そこでIssue #187で
 * `ChatTestApi.simulateCodexWebviewMessage`（`src/extension.ts`）を追加した。これは
 * `panel.webview.onDidReceiveMessage`が受け取るのと同じ形のメッセージを直接
 * `ChatViewManager.handleMessage`へ渡す入口で、ユニットテストの`simulateMessage`
 * （`test/mocks/vscode.ts`）と同じ考え方。本番のwebviewが送るメッセージと区別なく
 * 処理されるため、実際に通る経路（`ChatSession.decide` / `answerPrompt`）は変わらない。
 */
suite('Codex画面: 承認・問い合わせの往復（Issue #187）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 20_000, intervalMs: 50 } as const;
  /** 応答が来ないことを確かめるときの待ち時間。短すぎると偽陰性、長すぎるとテストが重い。 */
  const SETTLE_MS = 500;

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
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /** 新しいCodex画面を開き、フェイク接続とスレッドidを結びつける。 */
  async function openChat(threadId: string): Promise<FakeAppServerConnection> {
    let connection: FakeAppServerConnection | undefined;
    chat.setCodexConnection((onNotification, onServerRequest) => {
      connection = new FakeAppServerConnection(onNotification, onServerRequest);
      connection.respond('thread/start', () => ({ thread: { id: threadId } }));
      return connection;
    });
    await vscode.commands.executeCommand('codex.newChat');
    await waitFor(
      () => connection?.called('thread/start') ?? false,
      (called) => called,
      WAIT_OPTIONS,
    );
    assert.ok(connection !== undefined, '接続のファクトリが呼ばれていない');
    return connection;
  }

  test('C-03: 許可（accept）でコマンド実行を許すdecisionが返る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-accept');
    const pending = connection.serverRequest({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-accept', command: 'touch a.txt', cwd: '/work' },
    });
    await chat.simulateCodexWebviewMessage('thread-accept', {
      type: 'approve',
      requestId: 1,
      decision: 'accept',
    });
    assert.deepEqual(await pending, { decision: 'accept' });
  });

  test('C-04: 拒否（decline）で実行させないdecisionが返る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-decline');
    const pending = connection.serverRequest({
      id: 2,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-decline', command: 'rm -rf /tmp/x', cwd: '/work' },
    });
    await chat.simulateCodexWebviewMessage('thread-decline', {
      type: 'approve',
      requestId: 2,
      decision: 'decline',
    });
    assert.deepEqual(await pending, { decision: 'decline' });
  });

  test('C-05: 「このセッションでは常に許可」がacceptForSessionとして渡り、次の別要求には引き継がれない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-session');

    const first = connection.serverRequest({
      id: 3,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-session', command: 'touch same.txt', cwd: '/work' },
    });
    await chat.simulateCodexWebviewMessage('thread-session', {
      type: 'approve',
      requestId: 3,
      decision: 'acceptForSession',
    });
    assert.deepEqual(await first, { decision: 'acceptForSession' });

    // 別のrequestId（＝別の要求）はコマンド文字列が同じでも自動では解決されない。
    // 拡張機能側に「直前セッション許可の記憶」が無いこと（app-server任せであること）の確認。
    const second = connection.serverRequest({
      id: 4,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-session', command: 'touch same.txt', cwd: '/work' },
    });
    const settled = await Promise.race([
      second.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SETTLE_MS)),
    ]);
    assert.equal(
      settled,
      'timeout',
      '2件目の要求が明示的な決定なしに解決されている（クライアント側で勝手に許可した）',
    );
    // 後始末: 解決しないまま残すとteardownのcancelで拾われるので、明示しなくても片付く。
    await chat.simulateCodexWebviewMessage('thread-session', {
      type: 'approve',
      requestId: 4,
      decision: 'decline',
    });
    await second;
  });

  test('C-06: 保留中の承認を残したままタブを閉じるとcancelで解放される', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-close');
    const pending = connection.serverRequest({
      id: 5,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-close', command: 'echo hi', cwd: '/work' },
    });

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    assert.deepEqual(await pending, { decision: 'cancel' });
  });

  test('C-21: serverRequest/resolvedで解決済みの承認は、タブを閉じても改めて応答されない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-resolved');
    const pending = connection.serverRequest({
      id: 6,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-resolved', command: 'echo hi', cwd: '/work' },
    });

    // 別経路（TUI等）で既に解決された、という通知。カードはここで取り下げられる
    // （`ChatSession.dropResolvedApproval`）。
    connection.notify('serverRequest/resolved', { threadId: 'thread-resolved', requestId: 6 });

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // C-06と対照的に、dispose()時点で`waiting`から既に取り除かれているため、
    // 「タブを閉じたときのcancel」が二重に飛ぶことはない＝このPromiseは解決されない
    // （実際の応答は、この拡張機能とは別の経路が既に返している）。
    const settled = await Promise.race([
      pending.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SETTLE_MS)),
    ]);
    assert.equal(
      settled,
      'timeout',
      '解決済みのはずの承認が、タブを閉じたときに改めて応答されている（二重解決）',
    );
  });

  test('C-18: 問い合わせ（requestUserInput）に回答すると、質問idごとの答えが返る。拒否は空の回答になる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-prompt');

    const submitted = connection.serverRequest({
      id: 7,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-prompt',
        isBlocking: true,
        questions: [{ id: 'q1', header: '名前', question: 'お名前は？', isSecret: false }],
      },
    });
    await chat.simulateCodexWebviewMessage('thread-prompt', {
      type: 'prompt',
      requestId: 7,
      submission: { action: 'submit', values: { q1: ['太郎'] } },
    });
    assert.deepEqual(await submitted, { answers: { q1: { answers: ['太郎'] } } });

    const declined = connection.serverRequest({
      id: 8,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-prompt',
        isBlocking: true,
        questions: [{ id: 'q2', header: '年齢', question: '年齢は？', isSecret: false }],
      },
    });
    await chat.simulateCodexWebviewMessage('thread-prompt', {
      type: 'prompt',
      requestId: 8,
      submission: { action: 'decline', values: {} },
    });
    assert.deepEqual(await declined, { answers: { q2: { answers: [] } } });

    // カードが出たままタブを閉じたときも解放される（`ChatSession.dispose`が
    // `waitingPrompts`もcancelで払う）。
    const leftOpen = connection.serverRequest({
      id: 9,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-prompt',
        isBlocking: true,
        questions: [{ id: 'q3', header: '好きな色', question: '好きな色は？', isSecret: false }],
      },
    });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.deepEqual(await leftOpen, { answers: { q3: { answers: [] } } });
  });

  test('C-19: MCPサーバのelicitationは送信で内容が届き、拒否・取り消しはdecline/cancelとして届く', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-elicit');

    const submitted = connection.serverRequest({
      id: 10,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-elicit',
        serverName: 'my-mcp',
        mode: 'form',
        message: '設定を入力してください',
        requestedSchema: {
          properties: { age: { type: 'number', title: '年齢' } },
          required: ['age'],
        },
      },
    });
    await chat.simulateCodexWebviewMessage('thread-elicit', {
      type: 'prompt',
      requestId: 10,
      submission: { action: 'submit', values: { age: ['42'] } },
    });
    // 数値のフィールドは数値として届く（文字列のまま送らない）
    assert.deepEqual(await submitted, { action: 'accept', content: { age: 42 } });

    const declined = connection.serverRequest({
      id: 11,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-elicit',
        serverName: 'my-mcp',
        mode: 'form',
        message: '設定を入力してください',
        requestedSchema: { properties: { age: { type: 'number' } } },
      },
    });
    await chat.simulateCodexWebviewMessage('thread-elicit', {
      type: 'prompt',
      requestId: 11,
      submission: { action: 'decline', values: {} },
    });
    assert.deepEqual(await declined, { action: 'decline' });

    const cancelled = connection.serverRequest({
      id: 12,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-elicit',
        serverName: 'my-mcp',
        mode: 'url',
        message: '外部で認証してください',
        url: 'https://example.test/auth',
      },
    });
    await chat.simulateCodexWebviewMessage('thread-elicit', {
      type: 'prompt',
      requestId: 12,
      submission: { action: 'cancel', values: {} },
    });
    assert.deepEqual(await cancelled, { action: 'cancel' });
  });
});
