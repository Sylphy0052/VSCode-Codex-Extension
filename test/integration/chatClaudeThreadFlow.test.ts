import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createFakeClaudeSpawn, type FakeClaudeProcess } from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import { waitFor } from './helpers/waitFor';

/**
 * Claude Code画面: プロトコル上の状態遷移と配線（Issue #188、親Issue #186）。
 *
 * `docs/manual-test.md` の仕分け（Issue #186）で「機械」に入ったL群のうち、
 * `chatClaudeHandshake.test.ts` が扱うハンドシェイク・承認以外——中断（L-05）・
 * セッションidの紐付け（L-06）・`--resume` の配線と二重オープン防止（L-08 / L-09）・
 * 割り込みの手段が無いため常に待ち行列へ積まれること（C-13b）——を扱う。
 *
 * C-13bは元々C群（Codex画面）の番号だが、内容はClaude Code画面（stream-json）側の挙動
 * （`chatCodexThreadFlow.test.ts` 冒頭コメント参照）のため、L群と合わせてここで扱う
 * （design.md §11「C-13b（Claude Codeが常に待ち行列に積まれる挙動）はL群側（#188）へ残す」）。
 */
suite('Claude Code画面: プロトコルの状態遷移と配線（Issue #188）', () => {
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
    chat.setClaudeSpawn(undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /** 開いているタブの見出しを、エディタグループを問わずまとめて読む。 */
  function openTabLabels(): string[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
  }

  /** 新しいClaude Code画面を開き、フェイクプロセスとセッションidを結びつける。 */
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

  function initializeSuccessResponse(requestId: string): unknown {
    return {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    };
  }

  test('L-06: セッションidは起動前に採番され、--session-idに渡した値がそのままパネルの紐付けに使われる', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const { sessionId } = await openClaudeChat();

    // UUID形式であること（design.md §14.3。`isSessionId` が受け付ける形）
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // このidをキーにwebviewメッセージを送れる＝パネルはこのidで管理されている
    // （`ClaudeChatViewManager.panels` のキーが `--session-id` に渡した値と一致する）
    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'ready' });

    // 存在しないidでは「画面が見つからない」で拒否される（取り違えて別画面を操作しない）
    await assert.rejects(() =>
      chat.simulateClaudeWebviewMessage('not-a-real-session-id', { type: 'ready' }),
    );
  });

  test('L-05: 中断でinterrupt要求が飛ぶ', async function () {
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

    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '長い作業' });
    await waitFor(
      () => proc.writtenLines().some((l) => l['type'] === 'user'),
      (found) => found,
      WAIT_OPTIONS,
    );

    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'interrupt' });
    await waitFor(
      () =>
        proc
          .writtenLines()
          .some(
            (l) =>
              l['type'] === 'control_request' &&
              (l['request'] as { subtype?: string } | undefined)?.subtype === 'interrupt',
          ),
      (found) => found,
      WAIT_OPTIONS,
    );
  });

  test('L-08/L-09: 履歴からの再オープンは-rでresumeし、開いたままの同じセッションは二重に開かない', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const manifest = readManifest();
    const fake = createFakeClaudeSpawn();
    chat.setClaudeSpawn(fake.spawn);

    const session = {
      id: manifest.claude.inScope.id,
      threadName: manifest.claude.inScope.firstMessage,
      cwd: manifest.workspaceFolder,
    };
    await vscode.commands.executeCommand('claude.openChat', session);
    await waitFor(
      () => fake.processes.length,
      (count) => count > 0,
      WAIT_OPTIONS,
    );

    // `--resume` は標準出力に過去のやり取りを流さないため、初期表示はtranscriptを読んで
    // 作る経路（design.md §14.4）。ここでは実際に呼ばれた起動引数が `-r <id>` であり
    // （`--session-id` の新規経路ではない）、対象のtranscriptが実在するfixtureのidと
    // 一致することを確かめる（`store.resolveTranscriptPath` が実ファイルを解決できて
    // 初めてここまで進む）。
    const args = fake.calls[0]?.args ?? [];
    const idx = args.indexOf('-r');
    assert.ok(idx >= 0, `-r で起動していない: ${args.join(' ')}`);
    assert.equal(args[idx + 1], manifest.claude.inScope.id);
    assert.equal(args.includes('--session-id'), false, '--resumeなのに--session-idも渡している');
    assert.equal(
      args.includes('--fork-session'),
      false,
      '--resumeなのに--fork-sessionを渡している',
    );

    await waitFor(
      () => openTabLabels(),
      (labels) => labels.includes(`Claude Code: ${manifest.claude.inScope.firstMessage}`),
      WAIT_OPTIONS,
    );

    // 同じセッションをもう一度開く（履歴の項目を再クリックした想定）。既に開いているタブが
    // 前面に来るだけで、プロセスは再起動されずタブも増えない（`openThread` の既存判定）
    await vscode.commands.executeCommand('claude.openChat', session);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      fake.processes.length,
      1,
      'claudeプロセスが再起動している（タブが二重に開いている）',
    );
    assert.equal(openTabLabels().length, 1, 'タブが二重に開いている');
  });

  test('L-10: forkは-r <id> --fork-sessionで起動し、元のタブとは別の、idが未確定なタブが開く', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const manifest = readManifest();
    const fake = createFakeClaudeSpawn();
    chat.setClaudeSpawn(fake.spawn);

    // `forkSession`（extension.ts）は`session.provider`でCodex/Claudeを振り分けるため、
    // `claude.openChat`（provider不問）用の他テストと違い、ここでは明示しないと
    // `providers.get(undefined)`がundefinedになり何も起きない
    const session = {
      id: manifest.claude.inScope.id,
      provider: 'claude' as const,
      threadName: manifest.claude.inScope.firstMessage,
      cwd: manifest.workspaceFolder,
    };

    // 先に元のセッションを開いておく。fork後もこのタブが無傷のまま残ることを併せて確かめる
    await vscode.commands.executeCommand('claude.openChat', session);
    await waitFor(
      () => fake.processes.length,
      (count) => count > 0,
      WAIT_OPTIONS,
    );
    // このidで操作できる＝元のタブが`this.panels`に登録されていることの確認（L-06と同じ考え方）
    await chat.simulateClaudeWebviewMessage(session.id, { type: 'ready' });

    // 履歴のコンテキストメニュー相当のコマンド。`codex.forkSession`を流用せず新設した
    // `claude.forkSession`（issue #218、package.jsonのview/item/context参照）
    await vscode.commands.executeCommand('claude.forkSession', session);
    await waitFor(
      () => fake.processes.length,
      (count) => count > 1,
      WAIT_OPTIONS,
    );

    // 2件目の起動が実際のfork。`-r <元のid> --fork-session`で、`--session-id`（新規経路）は
    // 混ざらない（argvBuilder.tsのtargetArgs参照）
    const forkArgs = fake.calls[1]?.args ?? [];
    const idx = forkArgs.indexOf('-r');
    assert.ok(idx >= 0, `-r で起動していない: ${forkArgs.join(' ')}`);
    assert.equal(forkArgs[idx + 1], session.id);
    assert.ok(
      forkArgs.includes('--fork-session'),
      `--fork-sessionが渡っていない: ${forkArgs.join(' ')}`,
    );
    assert.equal(forkArgs.includes('--session-id'), false, 'forkなのに--session-idも渡している');

    // タブが2枚に増える（元のタブを置き換えたのではなく、別タブが開いた）
    await waitFor(
      () => openTabLabels().length,
      (count) => count === 2,
      WAIT_OPTIONS,
    );

    // 元のセッションのタブは、forkの後も引き続き同じidで操作できる（無傷で残っている）
    await chat.simulateClaudeWebviewMessage(session.id, { type: 'ready' });

    // 分岐先の新しいidはCLIが振るため拡張機能からは追跡できず、`this.panels`には元のidとは
    // 別の合成キーで登録される（design.md §14.40）。外部から確かめられる唯一の手がかりは
    // 「元のidでは新しいタブを名指しできない」ことで、それはこのテストの前段（元のidが
    // 引き続き元のタブだけを指すこと）で既に確認済み。復元・作業記録の対象外になることは
    // `state.threadId`が確定しないという単体テスト側の検証（`claudeChatViewManager.test.ts`）
    // で担保する
  });

  test('C-13b: 割り込みの手段が無いため待ち行列に積み、ターン完了後に順に送る。「今すぐ送る」は中断してから送る', async function () {
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

    function userTexts(): string[] {
      return proc
        .writtenLines()
        .filter((l) => l['type'] === 'user')
        .map((l) => {
          const content = (l['message'] as { content?: unknown } | undefined)?.content;
          const first = Array.isArray(content)
            ? (content[0] as { text?: string } | undefined)
            : undefined;
          return first?.text ?? '';
        });
    }

    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '最初の指示' });
    await waitFor(
      () => userTexts().length,
      (n) => n === 1,
      WAIT_OPTIONS,
    );

    // 応答中（busy）に送った指示は、Claude側に割り込みの手段が無いため待ち行列へ積まれる
    // （design.md §9.7「Claude Code: 割り込みに相当する制御が見つかっていない」）。
    // Codex（`turn/steer`）と違い、CLIへは一切送られない。
    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '2件目' });
    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '3件目' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(
      userTexts(),
      ['最初の指示'],
      '待ち行列に積まれるはずの指示がCLIへ送られている',
    );

    // ターンが終わる（busyがtrue→falseに変わる）と、待ち行列の先頭から順に送られる
    proc.emitLine({ type: 'result', subtype: 'success', result: 'ok' });
    await waitFor(
      () => userTexts().length,
      (n) => n === 2,
      WAIT_OPTIONS,
    );
    assert.deepEqual(userTexts(), ['最初の指示', '2件目']);

    // 「今すぐ送る」はCodexの`turn/steer`と違い、応答を中断してから送る
    // （design.md §9.7「Claude Codeは従来どおり中断してから送る」）。
    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'flushQueue' });
    await waitFor(
      () =>
        proc
          .writtenLines()
          .some(
            (l) =>
              l['type'] === 'control_request' &&
              (l['request'] as { subtype?: string } | undefined)?.subtype === 'interrupt',
          ),
      (found) => found,
      WAIT_OPTIONS,
    );
    await waitFor(
      () => userTexts().length,
      (n) => n === 3,
      WAIT_OPTIONS,
    );
    assert.deepEqual(userTexts(), ['最初の指示', '2件目', '3件目']);

    // interruptが「3件目」の送信より前に書かれている（中断してから送る、の順序確認）
    const lines = proc.writtenLines();
    const interruptIndex = lines.findIndex(
      (l) =>
        l['type'] === 'control_request' &&
        (l['request'] as { subtype?: string } | undefined)?.subtype === 'interrupt',
    );
    const lastUserIndex = lines.map((l) => l['type']).lastIndexOf('user');
    assert.ok(
      interruptIndex >= 0 && interruptIndex < lastUserIndex,
      'interruptより先に3件目が送られている',
    );
  });
});
