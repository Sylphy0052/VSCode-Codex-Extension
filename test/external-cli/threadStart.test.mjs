// 実物のCodex CLI（`codex app-server`）を起動し、design.md §9.1 が前提とする現行の
// セッション紐付け（`thread/start` の応答から `threadId` を直接受け取る）が、
// APIキーなしで成立し続けているかを検査する（issue #458）。
//
// 目的はモックでは満たせない。設計書がもともと守りたかったのは「Codexの
// バージョンアップで本物の挙動が変わったら気づく」ことであり、モックで固めた
// テストは常に緑になるため、その目的をまったく果たさないうえ果たしているように
// 見せてしまう（issue #458 注意点）。そのためここでは実CLIだけを起動する。
//
// test/integration/ とは別区分。test/integration/fixtures/setup.mjs は実CLIを
// 絶対に呼ばせない方針を敷いている（issue #155、EPIPEの非捕捉例外で拡張機能
// ホストごと落ちた実績があるため）。このテストはVSCodeを一切介さず素のNode
// プロセスから起動するため、その防御とは競合しない。
//
// 起動先はCODEX_BIN環境変数で指定する（未指定時はPATH上のcodex）。CIでは
// バージョンを固定してインストールしたパスを渡す（.github/workflows/ci.yml の
// external-cliジョブ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const REQUEST_TIMEOUT_MS = 20_000;

test('codex app-serverのthread/startがAPIキーなしでthreadIdを返す（design.md §9.1）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-external-cli-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-external-cli-home-'));

  // APIキー系の環境変数を一切渡さない。thread/startがモデルを呼ばないことの実測
  // （issue #456: codex execがモデル呼び出しで401になってもロールアウトファイルと
  // originatorを書き込む）を、Codexのバージョンが上がるたびに機械的に確かめ直す。
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CODEX_HOME: codexHome,
  };

  const proc = spawn(CODEX_BIN, ['app-server'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  const stderrChunks = [];

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (line === '') {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(
            new Error(`${method}の応答がタイムアウトしました。stderr: ${stderrChunks.join('')}`),
          );
        }
      }, REQUEST_TIMEOUT_MS);
      // テストプロセスの終了をこのタイマーだけのために20秒待たせない。
      timer.unref();
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  try {
    const initializeResponse = await request('initialize', {
      clientInfo: { name: 'external-cli-test', version: '0.0.1' },
    });
    assert.equal(
      initializeResponse.error,
      undefined,
      `initializeが失敗した: ${JSON.stringify(initializeResponse.error)}`,
    );

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    const startResponse = await request('thread/start', { cwd });
    assert.equal(
      startResponse.error,
      undefined,
      `thread/startが失敗した（APIキーなしで通る前提が崩れた可能性）: ${JSON.stringify(startResponse.error)}`,
    );

    // src/appserver/chatSession.ts の readThreadId() が読む経路と同じ場所を検査する。
    const threadId = startResponse.result?.thread?.id;
    assert.equal(
      typeof threadId,
      'string',
      `threadIdが取得できない: ${JSON.stringify(startResponse.result)}`,
    );
    assert.notEqual(threadId, '');
  } finally {
    await terminateProcess(proc);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

// proc.kill()はシグナルを送るだけで、実際にプロセスが終了したかは待たない。
// codex app-serverがSIGTERMを無視するか終了に時間がかかる場合、`exit`/`close`を
// 誰も購読していないと`node --test`が子プロセスの終了を待ち続け、CIのジョブの
// timeout-minutes: 10まで無駄にハングしうる（issue #463）。
// ここではSIGTERMを送った後、一定時間内に終了しなければSIGKILLへエスカレーションし、
// それでも終了しない場合はエラーとして諦める（無限には待たない）。
const TERMINATE_GRACE_MS = 5_000;
const TERMINATE_KILL_MS = 5_000;

function terminateProcess(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer;

    const onExit = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(killTimer);
      resolve();
    };

    proc.once('exit', onExit);

    const graceTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      killTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        proc.removeListener('exit', onExit);
        reject(
          new Error(
            `codex app-serverがSIGKILL後も${TERMINATE_KILL_MS}ms以内に終了しなかった`,
          ),
        );
      }, TERMINATE_KILL_MS);
      // このタイマーだけのためにプロセス終了を待たせない。
      killTimer.unref();
    }, TERMINATE_GRACE_MS);
    // このタイマーだけのためにプロセス終了を待たせない。
    graceTimer.unref();

    proc.kill('SIGTERM');
  });
}
