import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createFakeClaudeSpawn, type FakeClaudeProcess } from './helpers/chat';
import { activateExtension, type ChatTestApiLike } from './helpers/extension';
import { readManifest } from './helpers/manifest';
import { waitFor } from './helpers/waitFor';

/**
 * Claude Code画面: 設定変更・コマンド送信・巻き戻し・入力欄モードの配線（Issue #188、親Issue #186）。
 *
 * `docs/manual-test.md` の仕分け（Issue #186）で「機械」に入ったL群のうち、コンテキスト残量と
 * 手動圧縮（L-12）・`set_model` / `set_permission_mode` の送信（L-14）・Plan modeの往復
 * （L-15）・レビューボタンの送信内容（L-24）・`rewind_files` のパラメータ（L-29）・行頭
 * `!` / `#` が拡張機能側で完結すること（L-39 / L-40）を扱う。
 *
 * `chatClaudeHandshake.test.ts` / `chatClaudeThreadFlow.test.ts` と同じく
 * `ChatTestApi.simulateClaudeWebviewMessage` でwebviewからの発言・操作を模擬する。
 *
 * モデル・承認方法の変更（L-14）は実際のVSCode設定（`claude.*`、globalスコープ）を書き換える
 * 経路を通るため、各テストは必ず `finally` で既定値へ戻す。戻し忘れると同じVSCodeプロセスで
 * 後から走る `configuration.test.ts`（既定値どおりに読めることを確認するテスト）を壊す。
 */
suite('Claude Code画面: 設定変更・コマンド・入力欄モードの配線（Issue #188）', () => {
  const TEST_TIMEOUT_MS = 60_000;
  const WAIT_OPTIONS = { timeoutMs: 20_000, intervalMs: 50 } as const;
  const SHELL_TERMINAL_NAME = 'Agent Sessions: シェルコマンド入力';

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
    // L-39が作る統合ターミナルを次のテストへ持ち越さない
    for (const terminal of vscode.window.terminals) {
      if (terminal.name === SHELL_TERMINAL_NAME) {
        terminal.dispose();
      }
    }
  });

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

  /** 確認モーダル（`showWarningMessage`）を、渡された肯定ボタンのラベルで自動承認する。 */
  function acceptWarnings(): void {
    vscode.window.showWarningMessage = (async (...args: unknown[]) =>
      args[args.length - 1]) as typeof vscode.window.showWarningMessage;
  }

  /** 確認モーダルを常に取り消す（何も選ばず閉じた扱い）。 */
  function cancelWarnings(): void {
    vscode.window.showWarningMessage = (async () =>
      undefined) as typeof vscode.window.showWarningMessage;
  }

  function lastUserMessageContent(proc: FakeClaudeProcess): unknown {
    const lines = proc.writtenLines().filter((l) => l['type'] === 'user');
    const last = lines[lines.length - 1];
    return (last?.['message'] as { content?: unknown } | undefined)?.content;
  }

  test('L-12: ハンドシェイク成功直後にget_context_usageを読み、圧縮ボタンは確認したときだけ/compactを送る', async function () {
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

    // 会話を始める前の値として、コンテキスト残量が自動で問い合わせられる（design.md §14.9）
    const contextReq = await waitFor(
      () =>
        proc
          .writtenLines()
          .find(
            (l) =>
              l['type'] === 'control_request' &&
              (l['request'] as { subtype?: string } | undefined)?.subtype === 'get_context_usage',
          ),
      (line) => line !== undefined,
      WAIT_OPTIONS,
    );
    proc.emitLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: contextReq?.['request_id'],
        response: { totalTokens: 1000, maxTokens: 10000 },
      },
    });

    const original = vscode.window.showWarningMessage;
    try {
      // 取り消すと何も送らない（「元の内容には戻せません」の確認で取り消した想定）
      cancelWarnings();
      await chat.simulateClaudeWebviewMessage(sessionId, { type: 'compact' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        proc.writtenLines().some((l) => l['type'] === 'user'),
        false,
        '確認を取り消したのに/compactが送られている',
      );

      // 実行すると、TUIと同じ/compactが発言として送られる（専用の制御要求は無い）
      acceptWarnings();
      await chat.simulateClaudeWebviewMessage(sessionId, { type: 'compact' });
      await waitFor(
        () => proc.writtenLines().some((l) => l['type'] === 'user'),
        (found) => found,
        WAIT_OPTIONS,
      );
      assert.deepEqual(lastUserMessageContent(proc), [{ type: 'text', text: '/compact' }]);
    } finally {
      vscode.window.showWarningMessage = original;
    }
  });

  test('L-14: 設定行からのモデル・承認方法の変更がcontrol_requestとして送られ、既定へ戻す・bypassPermissionsの取消では送らない', async function () {
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

    const config = vscode.workspace.getConfiguration('claude');
    const originalWarning = vscode.window.showWarningMessage;
    try {
      // モデルの変更 → set_model
      await chat.simulateClaudeWebviewMessage(sessionId, {
        type: 'config',
        key: 'model',
        value: 'sonnet',
      });
      const modelReq = await waitFor(
        () =>
          proc
            .writtenLines()
            .find(
              (l) =>
                l['type'] === 'control_request' &&
                (l['request'] as { subtype?: string } | undefined)?.subtype === 'set_model',
            ),
        (line) => line !== undefined,
        WAIT_OPTIONS,
      );
      assert.equal((modelReq?.['request'] as { model?: string } | undefined)?.model, 'sonnet');

      // 承認方法の変更 → set_permission_mode
      await chat.simulateClaudeWebviewMessage(sessionId, {
        type: 'config',
        key: 'approvalMode',
        value: 'plan',
      });
      const modeReq = await waitFor(
        () =>
          proc
            .writtenLines()
            .find(
              (l) =>
                l['type'] === 'control_request' &&
                (l['request'] as { subtype?: string } | undefined)?.subtype ===
                  'set_permission_mode',
            ),
        (line) => line !== undefined,
        WAIT_OPTIONS,
      );
      assert.equal((modeReq?.['request'] as { mode?: string } | undefined)?.mode, 'plan');

      // bypassPermissionsへ変え、確認ダイアログを取り消すとセッションへは送られない
      const beforeBypass = proc.writtenLines().length;
      cancelWarnings();
      await chat.simulateClaudeWebviewMessage(sessionId, {
        type: 'config',
        key: 'approvalMode',
        value: 'bypassPermissions',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        proc.writtenLines().length,
        beforeBypass,
        '確認を取り消したのに要求が増えている',
      );

      // 「既定」（空文字）へ戻す操作はCLI側に戻す手段が無いため何も送らない
      const beforeDefault = proc.writtenLines().length;
      await chat.simulateClaudeWebviewMessage(sessionId, {
        type: 'config',
        key: 'model',
        value: '',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(proc.writtenLines().length, beforeDefault, '既定へ戻したのに要求が増えている');
    } finally {
      vscode.window.showWarningMessage = originalWarning;
      // globalスコープの設定を必ず既定へ戻す（他のテストへ持ち越さない）
      await config.update('model', undefined, vscode.ConfigurationTarget.Global);
      await config.update('permissionMode', undefined, vscode.ConfigurationTarget.Global);
      await config.update('effort', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('L-15: 計画モードの切替はset_permission_modeとして送られ、抜けるときは設定の承認方法（既定はmanual）へ戻る', async function () {
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

    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'planMode', on: true });
    const requests = await waitFor(
      () =>
        proc
          .writtenLines()
          .filter(
            (l) =>
              l['type'] === 'control_request' &&
              (l['request'] as { subtype?: string } | undefined)?.subtype === 'set_permission_mode',
          ),
      (lines) => lines.length >= 1,
      WAIT_OPTIONS,
    );
    assert.equal((requests[0]?.['request'] as { mode?: string } | undefined)?.mode, 'plan');

    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'planMode', on: false });
    const requestsAfterExit = await waitFor(
      () =>
        proc
          .writtenLines()
          .filter(
            (l) =>
              l['type'] === 'control_request' &&
              (l['request'] as { subtype?: string } | undefined)?.subtype === 'set_permission_mode',
          ),
      (lines) => lines.length >= 2,
      WAIT_OPTIONS,
    );
    // claude.permissionModeが既定（空文字）のときはmanualへ戻る（`setPlanMode`のフォールバック）
    assert.equal(
      (requestsAfterExit[1]?.['request'] as { mode?: string } | undefined)?.mode,
      'manual',
    );
  });

  test('L-24: レビューは専用の要求を持たず、/code-reviewをそのまま発言として送るだけ', async function () {
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

    // 「レビュー」ボタンが押されたふりをする。Codexの`/compact`のような擬似コマンドの
    // 割り振りは無く、素通しでCLIへ送るだけ（design.mdの説明どおり、専用のメソッドが無い）。
    // ボタンの表示・非表示（コマンド一覧に無ければ隠す）は画面の見え方のため対象外
    // （manual-test.mdのL-24の仕分けは「送る内容」までが機械の範囲）。
    await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '/code-review' });
    await waitFor(
      () => proc.writtenLines().some((l) => l['type'] === 'user'),
      (found) => found,
      WAIT_OPTIONS,
    );
    const userLines = proc.writtenLines().filter((l) => l['type'] === 'user');
    assert.equal(userLines.length, 1, '/code-reviewが特別扱いされ、複数のメッセージに分かれている');
    assert.deepEqual(lastUserMessageContent(proc), [{ type: 'text', text: '/code-review' }]);
  });

  test('L-29: rewind_filesはスネークケースのuser_message_id/dry_runを送り、対象が無ければ確認を出さない', async function () {
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

    const originalWarning = vscode.window.showWarningMessage;
    const originalInfo = vscode.window.showInformationMessage;
    try {
      // 1) 対象ファイルが無いプレビュー結果では、確認ダイアログを出さず案内だけ出す
      const infoMessages: unknown[] = [];
      const warningCalls: unknown[] = [];
      vscode.window.showInformationMessage = ((...args: unknown[]) => {
        infoMessages.push(args[0]);
        return Promise.resolve(undefined);
      }) as typeof vscode.window.showInformationMessage;
      vscode.window.showWarningMessage = ((...args: unknown[]) => {
        warningCalls.push(args[0]);
        return Promise.resolve(undefined);
      }) as typeof vscode.window.showWarningMessage;

      await chat.simulateClaudeWebviewMessage(sessionId, {
        type: 'rewind',
        messageId: 'user-msg-1',
      });
      const previewReq = await waitFor(
        () =>
          proc
            .writtenLines()
            .find(
              (l) =>
                l['type'] === 'control_request' &&
                (l['request'] as { subtype?: string } | undefined)?.subtype === 'rewind_files',
            ),
        (line) => line !== undefined,
        WAIT_OPTIONS,
      );
      assert.deepEqual(previewReq?.['request'], {
        subtype: 'rewind_files',
        user_message_id: 'user-msg-1',
        dry_run: true,
      });
      proc.emitLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: previewReq?.['request_id'],
          response: { canRewind: true, filesChanged: [] },
        },
      });
      await waitFor(
        () => infoMessages.length,
        (count) => count > 0,
        WAIT_OPTIONS,
      );
      assert.equal(warningCalls.length, 0, '対象ファイルが無いのに確認ダイアログを出している');

      // 2) 対象ファイルがある場合は、確認 → 適用の順にdry_run:true/falseで送る
      acceptWarnings();
      await chat.simulateClaudeWebviewMessage(sessionId, {
        type: 'rewind',
        messageId: 'user-msg-2',
      });
      const preview2 = await waitFor(
        () =>
          proc
            .writtenLines()
            .filter(
              (l) =>
                l['type'] === 'control_request' &&
                (l['request'] as { subtype?: string } | undefined)?.subtype === 'rewind_files' &&
                (l['request'] as { user_message_id?: string } | undefined)?.user_message_id ===
                  'user-msg-2',
            ),
        (lines) => lines.length >= 1,
        WAIT_OPTIONS,
      );
      assert.deepEqual(preview2[0]?.['request'], {
        subtype: 'rewind_files',
        user_message_id: 'user-msg-2',
        dry_run: true,
      });
      proc.emitLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: preview2[0]?.['request_id'],
          response: { canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 0 },
        },
      });

      const apply2 = await waitFor(
        () =>
          proc
            .writtenLines()
            .filter(
              (l) =>
                l['type'] === 'control_request' &&
                (l['request'] as { subtype?: string } | undefined)?.subtype === 'rewind_files' &&
                (l['request'] as { user_message_id?: string } | undefined)?.user_message_id ===
                  'user-msg-2' &&
                (l['request'] as { dry_run?: boolean } | undefined)?.dry_run === false,
            ),
        (lines) => lines.length >= 1,
        WAIT_OPTIONS,
      );
      assert.deepEqual(apply2[0]?.['request'], {
        subtype: 'rewind_files',
        user_message_id: 'user-msg-2',
        dry_run: false,
      });
    } finally {
      vscode.window.showWarningMessage = originalWarning;
      vscode.window.showInformationMessage = originalInfo;
    }
  });

  test('L-39: 行頭!はCLIへ送らず、確認後に統合ターミナルへ入力するだけ（同名ターミナルは再利用）', async function () {
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
    const before = proc.writtenLines().length;

    const original = vscode.window.showWarningMessage;
    try {
      acceptWarnings();
      await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '!echo hello' });
      await waitFor(
        () => vscode.window.terminals.find((t) => t.name === SHELL_TERMINAL_NAME),
        (terminal) => terminal !== undefined,
        WAIT_OPTIONS,
      );
    } finally {
      vscode.window.showWarningMessage = original;
    }
    // 確認して入力した後もCLIへは一切送られていない（トークンを消費しない）
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      proc.writtenLines().length,
      before,
      'CLIへ送られている（!echo helloが発言として届いている）',
    );
    assert.equal(
      proc.writtenLines().some((l) => l['type'] === 'user'),
      false,
    );

    const terminalsBefore = vscode.window.terminals.filter(
      (t) => t.name === SHELL_TERMINAL_NAME,
    ).length;
    try {
      acceptWarnings();
      await chat.simulateClaudeWebviewMessage(sessionId, { type: 'send', text: '!ls' });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      vscode.window.showWarningMessage = original;
    }
    assert.equal(
      vscode.window.terminals.filter((t) => t.name === SHELL_TERMINAL_NAME).length,
      terminalsBefore,
      '同じ名前のターミナルが再利用されず増えている',
    );
  });

  test('L-40: 行頭#はCLIへ送らず、確認後にCLAUDE.mdへ直接追記する', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    const manifest = readManifest();
    const claudeMdPath = path.join(manifest.workspaceFolder, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      fs.rmSync(claudeMdPath);
    }

    try {
      const { proc, sessionId } = await openClaudeChat();
      const initRequestId = (
        await waitFor(
          () => proc.writtenLines(),
          (lines) => lines.length > 0,
          WAIT_OPTIONS,
        )
      )[0]?.['request_id'] as string;
      proc.emitLine(initializeSuccessResponse(initRequestId));
      const before = proc.writtenLines().length;

      const originalPick = vscode.window.showQuickPick;
      const originalWarning = vscode.window.showWarningMessage;
      try {
        // QuickPickの先頭候補（プロジェクト側）を選んだふりをする
        vscode.window.showQuickPick = (async (items: unknown) => {
          const resolved = (await items) as unknown[];
          return resolved[0];
        }) as typeof vscode.window.showQuickPick;
        acceptWarnings();
        await chat.simulateClaudeWebviewMessage(sessionId, {
          type: 'send',
          text: '#常にpnpmを使う',
        });
        await waitFor(
          () => fs.existsSync(claudeMdPath),
          (exists) => exists,
          WAIT_OPTIONS,
        );
      } finally {
        vscode.window.showQuickPick = originalPick;
        vscode.window.showWarningMessage = originalWarning;
      }

      // CLIへは一切送られていない（control_requestに専用の経路が無いため拡張機能側で完結する）
      assert.equal(
        proc.writtenLines().length,
        before,
        'CLIへ送られている（#常にpnpmを使うが発言として届いている）',
      );
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      assert.match(content, /- 常にpnpmを使う/);
    } finally {
      if (fs.existsSync(claudeMdPath)) {
        fs.rmSync(claudeMdPath);
      }
    }
  });
});
