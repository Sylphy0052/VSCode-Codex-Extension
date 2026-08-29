import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FakeAppServerConnection } from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { waitFor } from './helpers/waitFor';

/**
 * モードを固定した入口からの起動（Issue #972）。
 *
 * 単体テストが押さえているのは両端だけである。`test/unit/chatView.test.ts` が3つのボタンが
 * DOMへ出ることを、`test/unit/secondOpinionModeOverride.test.ts` が `startSecondOpinion()` へ
 * `modeOverride` を渡したときの分岐を見ている。その2つをつなぐ「webviewから届いた
 * `secondOpinionDirect` / `secondOpinionAskGpt` が、モードを添えて起動へ渡る」ところは
 * どちらも踏まない。分岐を1つ消しても、`'direct'` と `'askGpt'` を取り違えても、単体テストは
 * 全部通ってしまう。
 *
 * 判別はモードごとに逆になる2つの観測点で行う。追加資料のQuickPickが出たか（`direct`
 * では出る、`askGpt` では出ない）と、`thread/fork` が呼ばれたか（`askGpt` は質問文の
 * 組み立てのために呼ぶ、`direct` は呼ばない）である。
 *
 * どちらのケースもAdvisorのセッション（別プロセスのCodex）は開かせない。`askGpt` 側は
 * 生成文をわざと不正な形にして検証で止め、`direct` 側はAdvisorの `thread/start` を
 * 失敗させる。
 */
suite('Codex画面: モードを固定したセカンドオピニオンの起動（Issue #972）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 20_000, intervalMs: 50 } as const;

  let chat: ChatTestApiLike;

  setup(async () => {
    const api = await activateExtension();
    assert.ok(api.chat !== undefined, 'チャット画面のテスト用APIが公開されていない');
    chat = api.chat;
  });

  teardown(async () => {
    await vscode.workspace
      .getConfiguration('agent')
      .update('secondOpinion.mode', undefined, vscode.ConfigurationTarget.Workspace);
    chat.setCodexConnection(undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  async function setMode(mode: 'direct' | 'askGpt'): Promise<void> {
    await vscode.workspace
      .getConfiguration('agent')
      .update('secondOpinion.mode', mode, vscode.ConfigurationTarget.Workspace);
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
   * 依頼先・思考の深さ・追加資料・依頼文のダイアログを差し替える
   * （`chatCodexSecondOpinionAskGpt.test.ts` の `stubDialogs` と同じやり方）。
   *
   * 違いは2つ。出たQuickPickの中身を控えること（`direct` と `askGpt` の判別に使う）と、
   * 追加資料は必ず「追加資料なし」を選ぶことである。差分スナップショットを選ぶと
   * その場でgitを叩くため、統合テストの作業ディレクトリの状態に結果が左右される。
   */
  function stubDialogs(): { restore(): void; artifactPicks: number } {
    const state = { artifactPicks: 0 };
    const originalPick = vscode.window.showQuickPick;
    const originalInput = vscode.window.showInputBox;
    vscode.window.showQuickPick = (async (items: unknown) => {
      const list = await items;
      if (!Array.isArray(list)) {
        return undefined;
      }
      const artifact = (list as Array<{ artifactKind?: string }>).find(
        (item) => item.artifactKind === 'none',
      );
      if (artifact !== undefined) {
        state.artifactPicks += 1;
        return artifact;
      }
      return list[0];
    }) as typeof vscode.window.showQuickPick;
    vscode.window.showInputBox = (async () =>
      'この設計をレビューしてほしい') as typeof vscode.window.showInputBox;
    return {
      restore: () => {
        vscode.window.showQuickPick = originalPick;
        vscode.window.showInputBox = originalInput;
      },
      get artifactPicks(): number {
        return state.artifactPicks;
      },
    };
  }

  test('S-04: 設定がdirectでも、secondOpinionAskGptはaskGptで走る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await setMode('direct');
    const connection = await openChat('thread-mode-askgpt');
    connection.respond('thread/fork', () => ({ thread: { id: 'thread-mode-askgpt-side' } }));
    connection.respond('turn/start', () => ({}));
    const dialogs = stubDialogs();

    try {
      // awaitしない。この呼び出しは一連の流れが終わるまで返らないため、待つと下の通知を
      // 送れずに詰まる（既存のS-01と同じ理由）
      const started = chat.simulateCodexWebviewMessage('thread-mode-askgpt', {
        type: 'secondOpinionAskGpt',
      });

      await waitFor(
        () => connection.called('thread/fork'),
        (called) => called,
        WAIT_OPTIONS,
      );
      assert.deepEqual(
        connection.firstCall('thread/fork')?.params,
        { threadId: 'thread-mode-askgpt', ephemeral: true },
        '設定がdirectのとき、askGptの入口から押しても質問文の組み立てが始まっていない',
      );

      // 見出しを欠いた文を返す。生成ターンは完走するが、検証で止まる
      connection.notify('turn/started', {
        threadId: 'thread-mode-askgpt-side',
        turn: { id: 'turn-mode-askgpt' },
      });
      connection.notify('item/completed', {
        threadId: 'thread-mode-askgpt-side',
        turnId: 'turn-mode-askgpt',
        item: { id: 'item-1', type: 'agentMessage', text: '質問文を作りました。' },
      });
      connection.notify('turn/completed', { threadId: 'thread-mode-askgpt-side' });

      await started;
      // askGptでは追加資料を選ばせない（Issue #947 受入基準1）
      assert.equal(dialogs.artifactPicks, 0, 'askGptなのに追加資料のQuickPickが出ている');
      assert.equal(
        connection.callsFor('thread/start').length,
        1,
        'Advisorのセッションが開かれている',
      );
    } finally {
      dialogs.restore();
    }
  });

  test('S-05: 設定がaskGptでも、secondOpinionDirectはdirectで走る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await setMode('askGpt');
    const connection = await openChat('thread-mode-direct');
    // Advisorのセッションだけを失敗させる。会話そのものの`thread/start`は上で済んでいる。
    // ここで失敗させないと、開いたセッションのターンが完了通知を待ち続けて返らない
    connection.failNext('thread/start', 'テスト用: Advisorのセッションは開かない');
    const dialogs = stubDialogs();

    try {
      await chat.simulateCodexWebviewMessage('thread-mode-direct', {
        type: 'secondOpinionDirect',
      });

      // directでは追加資料を選ばせる
      assert.equal(dialogs.artifactPicks, 1, 'directなのに追加資料のQuickPickが出ていない');
      // 質問文の組み立ては行わない（forkしない）
      assert.equal(
        connection.called('thread/fork'),
        false,
        '設定がaskGptのとき、directの入口から押したのに質問文の組み立てが始まっている',
      );
      // Advisorのセッションを開こうとはする（失敗させたので開けない）
      assert.equal(
        connection.callsFor('thread/start').length,
        2,
        'Advisorのセッションを開こうとしていない',
      );
    } finally {
      dialogs.restore();
    }
  });
});
