import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createFakeClaudeSpawn, type FakeClaudeProcess } from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { waitFor } from './helpers/waitFor';

/**
 * Claude Code画面: control protocolのハンドシェイクと承認カードの往復（Issue #188、親Issue #186）。
 *
 * `docs/manual-test.md` の仕分け（Issue #186）で「機械」に入ったL群のうち、`initialize` の
 * ハンドシェイク（L-02）・`can_use_tool` の往復（L-03）・問い合わせカードの経路が無いこと
 * （L-18）を扱う。実CLIは起動せず、`FakeClaudeProcess`（`test/integration/helpers/chat.ts`）を
 * `ClaudeStreamSession` へ差し替える（`ChatTestApi.setClaudeSpawn`）。
 *
 * webviewの「許可」「拒否」ボタンはレンダラー側（別プロセス）のJSが押すため、拡張機能
 * ホスト側のテストコードから直接クリックを再現する手段が無い。Codex画面（#187）と同じく
 * `ChatTestApi.simulateClaudeWebviewMessage`（`src/extension.ts`、Issue #188で新設）を使い、
 * `panel.webview.onDidReceiveMessage` が受け取るのと同じ形のメッセージを直接
 * `ClaudeChatViewManager.handleMessage` へ渡す（`chatCodexApprovals.test.ts` の冒頭コメント
 * 参照）。
 */
suite('Claude Code画面: ハンドシェイクと承認の往復（Issue #188）', () => {
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
    chat.setClaudeSpawn(undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /**
   * 新しいClaude Code画面を開き、フェイクプロセスとセッションidを結びつける。
   *
   * セッションidは起動前に採番され、`--session-id` としてそのままCLI引数に渡る
   * （design.md §14.3）。ここで拾って返すことで、`simulateClaudeWebviewMessage` の
   * 宛先（＝パネルのキー）が起動時に決めたidと一致することも併せて確かめられる。
   */
  async function openClaudeChat(): Promise<{ proc: FakeClaudeProcess; sessionId: string }> {
    const fake = createFakeClaudeSpawn();
    chat.setClaudeSpawn(fake.spawn);
    await vscode.commands.executeCommand('claude.newChat');
    await waitFor(
      () => fake.processes.length,
      (count) => count > 0,
      WAIT_OPTIONS,
    );
    const proc = fake.processes[0] as FakeClaudeProcess;
    const args = fake.calls[0]?.args ?? [];
    const idx = args.indexOf('--session-id');
    const sessionId = idx >= 0 ? args[idx + 1] : undefined;
    assert.ok(sessionId !== undefined, '--session-idがCLI引数に渡っていない');
    return { proc, sessionId: sessionId as string };
  }

  /** `initialize` への成功応答（`control_response`）を組み立てる。 */
  function initializeSuccessResponse(requestId: string): unknown {
    return {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    };
  }

  test('L-02: initializeハンドシェイクが成功すると、警告を出さず会話を始める前の値を読み直す', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { proc } = await openClaudeChat();

    const first = (
      await waitFor(
        () => proc.writtenLines(),
        (lines) => lines.length > 0,
        WAIT_OPTIONS,
      )
    )[0];
    assert.equal(first?.['type'], 'control_request', `control_requestで始まっていない: ${JSON.stringify(first)}`);
    const request = first?.['request'] as { subtype?: string; hooks?: unknown } | undefined;
    assert.equal(request?.subtype, 'initialize');
    assert.deepEqual(request?.hooks, {});
    const requestId = first?.['request_id'] as string;

    const warnings: unknown[] = [];
    const original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = ((...args: unknown[]) => {
      warnings.push(args[0]);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showWarningMessage;
    try {
      proc.emitLine(initializeSuccessResponse(requestId));
      // ハンドシェイク成功後は「会話を始める前の値」（コンテキスト残量・セッションコスト）を
      // 読み直す（`streamSession.ts` の `handleControlResponse` 末尾）。これが飛ぶことが
      // ハンドシェイク成功を経て通常どおり動いていることの確認になる（L-12の前提でもある）。
      await waitFor(
        () => proc.writtenLines(),
        (lines) =>
          lines.some(
            (l) => (l['request'] as { subtype?: string } | undefined)?.subtype === 'get_context_usage',
          ),
        WAIT_OPTIONS,
      );
    } finally {
      vscode.window.showWarningMessage = original;
    }
    assert.deepEqual(warnings, [], 'ハンドシェイク成功時に警告が出ている');
  });

  test('L-02: initializeハンドシェイクが失敗すると一度だけ警告が出るが、会話は続けられる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { proc, sessionId } = await openClaudeChat();

    const first = (
      await waitFor(
        () => proc.writtenLines(),
        (lines) => lines.length > 0,
        WAIT_OPTIONS,
      )
    )[0];
    const requestId = first?.['request_id'] as string;

    const warnings: unknown[] = [];
    const original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = ((...args: unknown[]) => {
      warnings.push(args[0]);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showWarningMessage;
    try {
      proc.emitLine({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: 'Unsupported control request subtype: initialize' },
      });
      await waitFor(
        () => warnings.length,
        (count) => count > 0,
        WAIT_OPTIONS,
      );
      assert.deepEqual(warnings, [
        'この画面ではツール実行の承認を受け取れませんでした。claude.permissionMode の設定に従って動作します。',
      ]);

      // 会話自体は続けられる（ハンドシェイク失敗が送信をブロックしない）
      await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: 'こんにちは' });
      await waitFor(
        () => proc.writtenLines(),
        (lines) => lines.some((l) => l['type'] === 'user'),
        WAIT_OPTIONS,
      );
    } finally {
      vscode.window.showWarningMessage = original;
    }
  });

  test('L-03: can_use_toolの往復で、許可・拒否・セッション内許可のいずれも正しいdecisionが返る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { proc, sessionId } = await openClaudeChat();
    const initRequestId = (
      await waitFor(
        () => proc.writtenLines(),
        (lines) => lines.length > 0,
        WAIT_OPTIONS,
      )
    )[0]?.['request_id'] as string;
    proc.emitLine(initializeSuccessResponse(initRequestId));

    /**
     * `approve` メッセージを送って応答を待つ。
     *
     * `can_use_tool` の受け取り（`ClaudeStreamSession.resolveApproval`）は
     * `interceptApproval` を `await` する非同期処理のため、CLIから要求が届いてから
     * 実際に `waiting` へ登録されるまでにマイクロタスク1回分のずれがある。1回だけ
     * `approve` を送ると、このずれの間に届いた分は黙って無視される（`decide()` は
     * `waiting` に無いrequestIdを早期returnで捨てる）。`decide()` は同じ決定を
     * 何度送っても副作用が増えない（未登録なら無視、登録済みなら1回だけ解決して
     * 消える）ため、応答が来るまで送り直しても安全。ここでは `waitFor` のポーリングへ
     * 送信そのものを乗せることで、登録が完了した回だけ確実に解決させる。
     */
    async function approveAndAwaitResponse(
      requestId: string,
      decision: 'accept' | 'decline' | 'acceptForSession',
    ): Promise<unknown> {
      const line = await waitFor(
        async () => {
          await chat.simulateClaudeWebviewMessage(sessionId, { type: 'approve', requestId, decision });
          return proc
            .writtenLines()
            .find(
              (l) =>
                l['type'] === 'control_response' &&
                (l['response'] as { request_id?: string } | undefined)?.request_id === requestId,
            );
        },
        (found) => found !== undefined,
        WAIT_OPTIONS,
      );
      return (line?.['response'] as { response?: unknown } | undefined)?.response;
    }

    // 許可（accept）: 実行を許すdecisionが返る
    proc.emitLine({
      type: 'control_request',
      request_id: 'ask-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch a.txt' } },
    });
    assert.deepEqual(await approveAndAwaitResponse('ask-1', 'accept'), {
      behavior: 'allow',
      updatedInput: { command: 'touch a.txt' },
    });

    // 拒否（decline）: 実行させないdecisionが返る
    proc.emitLine({
      type: 'control_request',
      request_id: 'ask-2',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
    });
    assert.deepEqual(await approveAndAwaitResponse('ask-2', 'decline'), {
      behavior: 'deny',
      message: 'ユーザーが拒否しました',
    });

    // セッション内許可（acceptForSession）: CLI側に区別が無いため許可として返るが、
    // 別のrequestId（＝別の要求）はコマンド文字列が同じでも自動では解決されない
    // （拡張機能側に「直前セッション許可の記憶」が無いこと。Codex画面のC-05と同じ確認）
    proc.emitLine({
      type: 'control_request',
      request_id: 'ask-3',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch same.txt' } },
    });
    assert.deepEqual(await approveAndAwaitResponse('ask-3', 'acceptForSession'), {
      behavior: 'allow',
      updatedInput: { command: 'touch same.txt' },
    });

    proc.emitLine({
      type: 'control_request',
      request_id: 'ask-4',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch same.txt' } },
    });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    assert.equal(
      proc
        .writtenLines()
        .some(
          (l) =>
            l['type'] === 'control_response' &&
            (l['response'] as { request_id?: string } | undefined)?.request_id === 'ask-4',
        ),
      false,
      '2件目の要求が明示的な決定なしに解決されている（クライアント側で勝手に許可した）',
    );
    // 後始末: 解決しないまま残さない
    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'approve', requestId: 'ask-4', decision: 'decline' });
  });

  test('L-18: can_use_tool以外の制御要求は空応答を返すだけで、問い合わせカードの経路が無い', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { proc, sessionId } = await openClaudeChat();
    const initRequestId = (
      await waitFor(
        () => proc.writtenLines(),
        (lines) => lines.length > 0,
        WAIT_OPTIONS,
      )
    )[0]?.['request_id'] as string;
    proc.emitLine(initializeSuccessResponse(initRequestId));

    // Claude Code側にはrequestUserInput/elicitationに相当する制御要求が届かない
    // （design.md §14.6）。ここでは「万一未知のsubtypeが届いても、カードを出さず
    // 黙って空応答を返すだけで会話を止めない」という劣化方針（`streamSession.ts` の
    // `handleControlRequest`）を確認する。CLIは応答が返るまで待ち続けるため、
    // 空応答であっても必ず返すことが重要。
    proc.emitLine({
      type: 'control_request',
      request_id: 'unknown-1',
      request: { subtype: 'requestUserInput', questions: [] },
    });

    const response = await waitFor(
      () =>
        proc
          .writtenLines()
          .find(
            (l) =>
              l['type'] === 'control_response' &&
              (l['response'] as { request_id?: string } | undefined)?.request_id === 'unknown-1',
          ),
      (line) => line !== undefined,
      WAIT_OPTIONS,
    );
    assert.deepEqual((response?.['response'] as { response?: unknown } | undefined)?.response, {});

    // 応答を返した後も会話はそのまま続けられる（画面が固まらない）
    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '続けられますか' });
    await waitFor(
      () => proc.writtenLines().some((l) => l['type'] === 'user'),
      (found) => found,
      WAIT_OPTIONS,
    );
  });
});
