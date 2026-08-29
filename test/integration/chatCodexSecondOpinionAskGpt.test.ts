import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FakeAppServerConnection } from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { waitFor } from './helpers/waitFor';

/**
 * askGptモード（Issue #947）の生成ターンが、タブを開かずに完走することの確認（受入基準14）。
 *
 * 単体テストでは確かめられない部分がここにある。「タブを開かない」は `showPanel` を呼ばない
 * という実装の書き方の問題に見えるが、実際にはそれだけでは足りず、fork先のスレッドを
 * `panels` へ登録しないと `turn/completed` の宛先が見つからず、生成が必ずタイムアウトする。
 * 画面を持たないまま通知が届き、ターンが確定するところまでを通しで踏む必要がある。
 *
 * 生成文はわざと不正な形（8セクションを満たさない）にして、検証で止まることまで見る。
 * ここで止まればAdvisorのセッションは開かれないため、`runSecondOpinion` の実挙動
 * （別プロセスのCodex起動）へは踏み込まずに済む。
 */
suite('Codex画面: askGptモードの質問文の組み立て（Issue #947）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 20_000, intervalMs: 50 } as const;
  /** 生成用のforkスレッドに付くタブの見出し（`secondOpinion/askGpt.ts` の定数と同じ）。 */
  const ASK_GPT_TAB_TITLE = 'セカンドオピニオン: 質問文の組み立て';

  let chat: ChatTestApiLike;

  setup(async () => {
    const api = await activateExtension();
    assert.ok(api.chat !== undefined, 'チャット画面のテスト用APIが公開されていない');
    chat = api.chat;
    await vscode.workspace
      .getConfiguration('agent')
      .update('secondOpinion.mode', 'askGpt', vscode.ConfigurationTarget.Workspace);
  });

  teardown(async () => {
    await vscode.workspace
      .getConfiguration('agent')
      .update('secondOpinion.mode', undefined, vscode.ConfigurationTarget.Workspace);
    chat.setCodexConnection(undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  function openTabLabels(): string[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
  }

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

  /**
   * 依頼先・思考の深さ・依頼文の3つのダイアログを差し替える（直接クリックできないため。
   * `chatCodexThreadFlow.test.ts` の `codex.renameChat` と同じやり方）。戻り値で元へ戻す。
   */
  function stubDialogs(): () => void {
    const originalPick = vscode.window.showQuickPick;
    const originalInput = vscode.window.showInputBox;
    vscode.window.showQuickPick = (async (items: unknown) => {
      const list = await items;
      return Array.isArray(list) ? list[0] : undefined;
    }) as typeof vscode.window.showQuickPick;
    vscode.window.showInputBox = (async () =>
      'この設計をレビューしてほしい') as typeof vscode.window.showInputBox;
    return () => {
      vscode.window.showQuickPick = originalPick;
      vscode.window.showInputBox = originalInput;
    };
  }

  /** 組み立ての指示がfork先のスレッドへ送られるまで待つ。 */
  async function waitForSideTurn(
    connection: FakeAppServerConnection,
    sideThreadId: string,
  ): Promise<void> {
    await waitFor(
      () =>
        connection
          .callsFor('turn/start')
          .some((c) => (c.params as { threadId?: string }).threadId === sideThreadId),
      (found) => found,
      WAIT_OPTIONS,
    );
  }

  /**
   * Advisorのセッションが開かれていないことを確かめる。
   *
   * Advisorは `TaskSessionHost.openTaskSession()`（＝この画面の管理者）を通って開くため、
   * 開いていればこの接続へ2本目の `thread/start` が飛ぶ。1本目は会話そのものの開始。
   */
  function assertAdvisorNotStarted(connection: FakeAppServerConnection): void {
    assert.equal(
      connection.callsFor('thread/start').length,
      1,
      'Advisorのセッションが開かれている',
    );
  }

  test('S-01: 質問文はephemeralなforkの上で作られ、タブは開かない。形式違反は送信前に止まる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-askgpt-src');
    connection.respond('thread/fork', () => ({ thread: { id: 'thread-askgpt-side' } }));
    connection.respond('turn/start', () => ({}));

    const restore = stubDialogs();

    try {
      // awaitしない。この呼び出しはセカンドオピニオンの一連の流れ全体（生成ターンの
      // 待ち合わせを含む）が終わるまで返らないため、待つと下の通知を送れずに詰まる
      const started = chat.simulateCodexWebviewMessage('thread-askgpt-src', {
        type: 'secondOpinion',
      });

      await waitFor(
        () => connection.called('thread/fork'),
        (called) => called,
        WAIT_OPTIONS,
      );
      assert.deepEqual(
        connection.firstCall('thread/fork')?.params,
        { threadId: 'thread-askgpt-src', ephemeral: true },
        '生成ターンがephemeralなforkの上で走っていない',
      );

      // 組み立ての指示はfork先へ送られる。本流のスレッドへは何も送らない（受入基準2）
      await waitFor(
        () =>
          connection
            .callsFor('turn/start')
            .some((c) => (c.params as { threadId?: string }).threadId === 'thread-askgpt-side'),
        (found) => found,
        WAIT_OPTIONS,
      );
      const sideCall = connection
        .callsFor('turn/start')
        .find((c) => (c.params as { threadId?: string }).threadId === 'thread-askgpt-side');
      const input = (sideCall?.params as { input?: Array<{ text?: string }> }).input ?? [];
      assert.ok(
        input.some((part) => (part.text ?? '').includes('## 5. 関連コード')),
        '8セクションの指定が指示に含まれていない',
      );
      assert.ok(
        input.some((part) => (part.text ?? '').includes('この設計をレビューしてほしい')),
        '人が書いた依頼文が指示に含まれていない',
      );
      assert.equal(
        connection
          .callsFor('turn/start')
          .some((c) => (c.params as { threadId?: string }).threadId === 'thread-askgpt-src'),
        false,
        '本流のスレッドへも送られている',
      );

      // 見出しを欠いた文を返す。生成ターン自体は完走するが、検証で止まる
      connection.notify('turn/started', {
        threadId: 'thread-askgpt-side',
        turn: { id: 'turn-askgpt' },
      });
      connection.notify('item/completed', {
        threadId: 'thread-askgpt-side',
        turnId: 'turn-askgpt',
        item: { id: 'item-1', type: 'agentMessage', text: '質問文を作りました。以下が本文です。' },
      });
      connection.notify('turn/completed', { threadId: 'thread-askgpt-side' });

      // 形式違反で止まるため、Advisorのセッション（別プロセスのCodex）は開かれずに
      // 一連の流れが終わる。ここが返ること自体が「検証で止まった」ことの確認でもある
      await started;
      assert.equal(
        openTabLabels().includes(ASK_GPT_TAB_TITLE),
        false,
        '質問文の組み立て用のタブが開いている',
      );
      assertAdvisorNotStarted(connection);
    } finally {
      restore();
    }
  });

  test('S-02: 生成ターンが失敗したらAdvisorを開始しない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-askgpt-fail');
    connection.respond('thread/fork', () => ({ thread: { id: 'thread-askgpt-fail-side' } }));
    connection.respond('turn/start', () => ({}));
    const restore = stubDialogs();

    try {
      const started = chat.simulateCodexWebviewMessage('thread-askgpt-fail', {
        type: 'secondOpinion',
      });
      await waitForSideTurn(connection, 'thread-askgpt-fail-side');

      connection.notify('turn/started', {
        threadId: 'thread-askgpt-fail-side',
        turn: { id: 'turn-askgpt-fail' },
      });
      connection.notify('turn/failed', { threadId: 'thread-askgpt-fail-side' });

      await started;
      assert.equal(
        openTabLabels().includes(ASK_GPT_TAB_TITLE),
        false,
        '質問文の組み立て用のタブが開いている',
      );
      assertAdvisorNotStarted(connection);
    } finally {
      restore();
    }
  });

  test('S-03: 生成ターンが返らなければ打ち切りを要求し、Advisorを開始しない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    // 設定の下限は10秒（`config.ts` が丸める）。ここは実際に待たせて確かめる
    await vscode.workspace
      .getConfiguration('agent')
      .update('secondOpinion.timeoutMs', 10_000, vscode.ConfigurationTarget.Workspace);
    const connection = await openChat('thread-askgpt-timeout');
    connection.respond('thread/fork', () => ({ thread: { id: 'thread-askgpt-timeout-side' } }));
    connection.respond('turn/start', () => ({}));
    connection.respond('turn/interrupt', () => ({}));
    const restore = stubDialogs();

    try {
      const started = chat.simulateCodexWebviewMessage('thread-askgpt-timeout', {
        type: 'secondOpinion',
      });
      await waitForSideTurn(connection, 'thread-askgpt-timeout-side');
      // 応答も完了通知も返さない。turnIdだけ確定させ、打ち切り要求が送れる状態にする
      connection.notify('turn/started', {
        threadId: 'thread-askgpt-timeout-side',
        turn: { id: 'turn-askgpt-timeout' },
      });

      await started;
      assert.deepEqual(
        connection.lastCall('turn/interrupt')?.params,
        { threadId: 'thread-askgpt-timeout-side', turnId: 'turn-askgpt-timeout' },
        '打ち切りを要求していない',
      );
      assert.equal(
        openTabLabels().includes(ASK_GPT_TAB_TITLE),
        false,
        '質問文の組み立て用のタブが開いている',
      );
      assertAdvisorNotStarted(connection);
    } finally {
      restore();
      await vscode.workspace
        .getConfiguration('agent')
        .update('secondOpinion.timeoutMs', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
