import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FakeAppServerConnection } from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { waitFor } from './helpers/waitFor';

/**
 * Codex画面: プロトコル上の状態遷移と配線（Issue #187、親Issue #186）。
 *
 * `docs/manual-test.md` の仕分け（Issue #186）で「機械」に入ったC群のうち、
 * `chatCodexApprovals.test.ts` が扱う承認・問い合わせの往復以外——中断・タブ名の追従・
 * 分岐・タブ復元/二重オープン防止・割り込みと待ち行列・擬似コマンド（`/init` `/btw`）
 * ——を扱う。承認と同じく `chat.simulateCodexWebviewMessage` でwebviewからの発言を模擬する
 * （詳しい理由は `chatCodexApprovals.test.ts` の冒頭コメント参照）。
 *
 * C-13bは対象外: manual-test.mdの記述どおりClaude Code画面（stream-json）側の挙動
 * （割り込み手段が無く常に待ち行列へ積まれる）で、Codexの`app-server`接続を扱う
 * このIssueの範囲外（L群、Issue #188で扱う）。
 */
suite('Codex画面: プロトコルの状態遷移と配線（Issue #187）', () => {
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

  /** 開いているタブの見出しを、エディタグループを問わずまとめて読む。 */
  function openTabLabels(): string[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
  }

  test('C-07: turn/interruptにturnIdが乗る。turnIdが判らない間は要求そのものを送らない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-interrupt');
    connection.respond('turn/start', () => ({}));

    await chat.simulateCodexWebviewMessage('thread-interrupt', { type: 'send', text: '長い作業' });
    await waitFor(
      () => connection.called('turn/start'),
      (called) => called,
      WAIT_OPTIONS,
    );

    // ターンが始まった通知（`turn/started`）がまだ届いていない間は、中断のしようが無い
    // （turnIdを知らないままapp-serverへ送っても失敗する）。ここで要求を送らないことが
    // 「turnIdを渡せていないと止まらないまま最後まで流れる」（manual-test.md C-07の注記）
    // を防いでいる側の保証。
    await chat.simulateCodexWebviewMessage('thread-interrupt', { type: 'interrupt' });
    assert.equal(connection.called('turn/interrupt'), false, 'turnId不明のまま要求を送っている');

    connection.notify('turn/started', { threadId: 'thread-interrupt', turn: { id: 'turn-77' } });
    await chat.simulateCodexWebviewMessage('thread-interrupt', { type: 'interrupt' });

    const call = connection.lastCall('turn/interrupt');
    assert.deepEqual(call?.params, { threadId: 'thread-interrupt', turnId: 'turn-77' });
  });

  test('C-08: thread/name/updatedでタブ名が追従する', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-name-updated');
    await waitFor(
      () => openTabLabels(),
      (labels) => labels.includes('Codex'),
      WAIT_OPTIONS,
    );

    connection.notify('thread/name/updated', {
      threadId: 'thread-name-updated',
      threadName: 'ログの調査',
    });

    await waitFor(
      () => openTabLabels(),
      (labels) => labels.includes('Codex: ログの調査'),
      WAIT_OPTIONS,
    );
  });

  test('C-09: codex.renameChatがthread/name/setを送り、タブ名にも反映される', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-rename');
    await waitFor(
      () => openTabLabels(),
      (labels) => labels.includes('Codex'),
      WAIT_OPTIONS,
    );

    // `codex.renameChat` は `vscode.window.showInputBox` で名前を1つだけ聞く
    // （`ChatViewManager.renameActive`）。実VSCode上のテストではwebviewと同じく
    // このダイアログを直接クリックする手段が無いため、`vscode.window.showInputBox` を
    // 一時的に差し替えて即答させる（実VSCode拡張機能のテストでよく使われる手法で、
    // `vscode.window` はテスト側から書き換え可能な通常のオブジェクト）。
    const original = vscode.window.showInputBox;
    vscode.window.showInputBox = (async () => '新しい名前') as typeof vscode.window.showInputBox;
    try {
      await vscode.commands.executeCommand('codex.renameChat');
    } finally {
      vscode.window.showInputBox = original;
    }

    await waitFor(
      () => connection.called('thread/name/set'),
      (called) => called,
      WAIT_OPTIONS,
    );
    assert.deepEqual(connection.firstCall('thread/name/set')?.params, {
      threadId: 'thread-rename',
      name: '新しい名前',
    });
    await waitFor(
      () => openTabLabels(),
      (labels) => labels.includes('Codex: 新しい名前'),
      WAIT_OPTIONS,
    );
  });

  test('C-10: thread/forkはlastTurnIdまでの範囲だけを引き継ぎ、新しいタブが別に開く', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-fork-src');
    connection.respond('thread/fork', () => ({ thread: { id: 'thread-fork-dst' } }));
    connection.respond('thread/resume', (params) => {
      const p = params as { threadId: string };
      return { thread: { id: p.threadId, turns: [] } };
    });

    await waitFor(
      () => openTabLabels().length,
      (count) => count === 1,
      WAIT_OPTIONS,
    );

    await chat.simulateCodexWebviewMessage('thread-fork-src', { type: 'fork', turnId: 'turn-A' });

    await waitFor(
      () => connection.called('thread/fork'),
      (called) => called,
      WAIT_OPTIONS,
    );
    // 分岐は「押した指示の手前まで」だけを引き継ぐ。スレッド全体ではなく
    // `lastTurnId` で範囲を切ることがこの要求の中身から確かめられる（C-10）。
    assert.deepEqual(connection.firstCall('thread/fork')?.params, {
      threadId: 'thread-fork-src',
      lastTurnId: 'turn-A',
    });

    // 分岐先は新しいスレッドとして`thread/resume`で開き直され、元のタブとは別に増える
    // （元のスレッドの状態には一切触れない）。
    await waitFor(
      () => connection.callsFor('thread/resume').some((c) => (c.params as { threadId?: string }).threadId === 'thread-fork-dst'),
      (found) => found,
      WAIT_OPTIONS,
    );
    await waitFor(
      () => openTabLabels().length,
      (count) => count === 2,
      WAIT_OPTIONS,
    );
  });

  test('C-11/C-12: 履歴からの再オープンはthread/resumeを呼ぶが、開いたままの同じスレッドは二重に開かない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    let connection: FakeAppServerConnection | undefined;
    chat.setCodexConnection((onNotification, onServerRequest) => {
      connection = new FakeAppServerConnection(onNotification, onServerRequest);
      connection.respond('thread/resume', (params) => {
        const p = params as { threadId: string };
        return { thread: { id: p.threadId, name: '過去の会話', turns: [] } };
      });
      return connection;
    });

    const session = { id: 'thread-history', threadName: '過去の会話', cwd: undefined };
    await vscode.commands.executeCommand('codex.openChat', session);
    await waitFor(
      () => connection?.called('thread/resume') ?? false,
      (called) => called,
      WAIT_OPTIONS,
    );
    assert.equal(connection?.callsFor('thread/resume').length, 1);
    assert.deepEqual(connection?.firstCall('thread/resume')?.params, { threadId: 'thread-history' });
    await waitFor(
      () => openTabLabels().length,
      (count) => count === 1,
      WAIT_OPTIONS,
    );

    // 同じスレッドをもう一度開く（履歴の項目を再クリックした想定）。既に開いているタブが
    // 前面に来るだけで、thread/resumeは再送されずタブも増えない（C-12）。
    await vscode.commands.executeCommand('codex.openChat', session);
    // 非同期の副作用が無いことを確かめるので、少し待って安定させてから数える
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(connection?.callsFor('thread/resume').length, 1, 'thread/resumeが再送されている');
    assert.equal(openTabLabels().length, 1, 'タブが二重に開いている');
  });

  test('C-13: 応答中の指示はturn/steerで割り込み、turnIdが未確定の間は待ち行列に積んでターン完了後に送る', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-steer');
    connection.respond('turn/start', () => ({}));
    connection.respond('turn/steer', () => ({}));

    await chat.simulateCodexWebviewMessage('thread-steer', { type: 'send', text: '最初の指示' });
    await waitFor(
      () => connection.called('turn/start'),
      (called) => called,
      WAIT_OPTIONS,
    );

    // turn/startedがまだ届いていない（turnId不明）間に送った指示は、割り込めないので
    // 待ち行列へ積まれる。turn/steerもturn/startも送らない。
    await chat.simulateCodexWebviewMessage('thread-steer', { type: 'send', text: '割り込めない指示' });
    assert.equal(connection.called('turn/steer'), false);
    assert.equal(connection.callsFor('turn/start').length, 1);

    // turnIdが判ったあとの指示はturn/steerで割り込む（待ち行列には積まれない）
    connection.notify('turn/started', { threadId: 'thread-steer', turn: { id: 'turn-1' } });
    await chat.simulateCodexWebviewMessage('thread-steer', { type: 'send', text: '割り込む指示' });
    await waitFor(
      () => connection.called('turn/steer'),
      (called) => called,
      WAIT_OPTIONS,
    );
    assert.deepEqual(connection.firstCall('turn/steer')?.params, {
      threadId: 'thread-steer',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: '割り込む指示' }],
    });

    // turn/steerがapp-server側の都合（ターンの入れ替わりなど）で失敗したときは、
    // 指示を失わず待ち行列へ積み直す（ログに「割り込めなかったため待ち行列へ積みます」）。
    connection.failNext('turn/steer', 'expectedTurnId mismatch');
    await chat.simulateCodexWebviewMessage('thread-steer', { type: 'send', text: '積み直される指示' });
    assert.equal(connection.callsFor('turn/steer').length, 2, '失敗した割り込みが記録されていない');

    // ターンが終わると、待ち行列の先頭（「割り込めない指示」）から順に送られる
    connection.notify('turn/completed', { threadId: 'thread-steer' });
    await waitFor(
      () => connection.callsFor('turn/start').length,
      (count) => count === 2,
      WAIT_OPTIONS,
    );
    assert.deepEqual(connection.lastCall('turn/start')?.params, {
      threadId: 'thread-steer',
      input: [{ type: 'text', text: '割り込めない指示' }],
    });
  });

  test('C-41: /initは既存ファイルの有無で指示文を変え、既存があるときは確認を挟む', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder !== undefined, 'テスト用のワークスペースフォルダが開かれていない');
    const agentsFilePath = path.join(folder.uri.fsPath, 'AGENTS.md');
    if (fs.existsSync(agentsFilePath)) {
      fs.rmSync(agentsFilePath);
    }

    try {
      const connection = await openChat('thread-init-new');
      connection.respond('turn/start', () => ({}));
      await chat.simulateCodexWebviewMessage('thread-init-new', { type: 'send', text: '/init' });
      await waitFor(
        () => connection.called('turn/start'),
        (called) => called,
        WAIT_OPTIONS,
      );
      const params = connection.firstCall('turn/start')?.params as { input?: unknown };
      assert.deepEqual(params.input, [
        {
          type: 'text',
          text:
            'AGENTS.mdを新規に作成してください。プロジェクトの構成・ビルド方法・テスト方法・' +
            '作業時の注意点など、次にこのリポジトリを触るエージェントが最初に知っておくべき情報を' +
            'まとめてください。',
        },
      ]);

      // 既存ファイルがある状態で送ると、確認モーダル（`vscode.window.showWarningMessage`）で
      // 「更新する」を選ぶまで送信されない。閉じる（選ばない）と何も送られない
      fs.writeFileSync(agentsFilePath, '# 既存のAGENTS.md\n');
      const connection2 = await openChat('thread-init-existing');
      connection2.respond('turn/start', () => ({}));

      const original = vscode.window.showWarningMessage;
      vscode.window.showWarningMessage = (async () =>
        undefined) as typeof vscode.window.showWarningMessage;
      try {
        await chat.simulateCodexWebviewMessage('thread-init-existing', {
          type: 'send',
          text: '/init',
        });
      } finally {
        vscode.window.showWarningMessage = original;
      }
      // モーダルを閉じた（更新しない）ので送信されない
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(connection2.called('turn/start'), false, 'モーダルを閉じたのに送信されている');

      // 「更新する」を選ぶと、既存を踏まえた文面で送られる
      vscode.window.showWarningMessage = (async () =>
        '更新する') as typeof vscode.window.showWarningMessage;
      try {
        await chat.simulateCodexWebviewMessage('thread-init-existing', {
          type: 'send',
          text: '/init',
        });
      } finally {
        vscode.window.showWarningMessage = original;
      }
      await waitFor(
        () => connection2.called('turn/start'),
        (called) => called,
        WAIT_OPTIONS,
      );
      const params2 = connection2.firstCall('turn/start')?.params as { input?: unknown };
      assert.deepEqual(params2.input, [
        {
          type: 'text',
          text:
            '既存のAGENTS.mdの内容を踏まえて、最新の状態に更新してください。プロジェクトの構成・' +
            'ビルド方法・テスト方法・作業時の注意点など、次にこのリポジトリを触るエージェントが' +
            '最初に知っておくべき情報をまとめてください。',
        },
      ]);
    } finally {
      if (fs.existsSync(agentsFilePath)) {
        fs.rmSync(agentsFilePath);
      }
    }
  });

  test('C-42: /btwは元のスレッドをephemeralにforkし、別タブで一往復だけ聞く。質問なしはエラーで送らない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const connection = await openChat('thread-btw-src');
    connection.respond('thread/fork', () => ({ thread: { id: 'thread-btw-side' } }));
    connection.respond('turn/start', () => ({}));

    // 質問を書かずに送ると、拡張機能側でエラーを出して何も送らない
    await chat.simulateCodexWebviewMessage('thread-btw-src', { type: 'send', text: '/btw' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(connection.called('thread/fork'), false, '質問無しなのにforkしている');

    await chat.simulateCodexWebviewMessage('thread-btw-src', {
      type: 'send',
      text: '/btw 今のタイムゾーンは？',
    });

    await waitFor(
      () => connection.called('thread/fork'),
      (called) => called,
      WAIT_OPTIONS,
    );
    assert.deepEqual(connection.firstCall('thread/fork')?.params, {
      threadId: 'thread-btw-src',
      ephemeral: true,
    });

    // 脇道の質問は新しいスレッド（fork応答をそのまま使う。thread/resumeは呼ばない）へ
    // 送られる。元のスレッドの会話は一切汚れない（turn/startが飛ぶのは新スレッドだけ）
    await waitFor(
      () =>
        connection
          .callsFor('turn/start')
          .some((c) => (c.params as { threadId?: string }).threadId === 'thread-btw-side'),
      (found) => found,
      WAIT_OPTIONS,
    );
    const sideCall = connection
      .callsFor('turn/start')
      .find((c) => (c.params as { threadId?: string }).threadId === 'thread-btw-side');
    assert.deepEqual((sideCall?.params as { input?: unknown }).input, [
      { type: 'text', text: '今のタイムゾーンは？' },
    ]);
    assert.equal(
      connection.callsFor('turn/start').some((c) => (c.params as { threadId?: string }).threadId === 'thread-btw-src'),
      false,
      '本流のスレッドへも送られている',
    );
    assert.equal(connection.called('thread/resume'), false, 'ephemeralスレッドをresumeで開き直している');

    await waitFor(
      () => openTabLabels(),
      (labels) => labels.includes('脇道'),
      WAIT_OPTIONS,
    );
  });
});
