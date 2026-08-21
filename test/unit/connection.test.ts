import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';

/**
 * issue #354・1点目: `initialize` が失敗してもプロセス自体は生きているため`exit`は
 * 発火せず、`ensureStarted()`が`proc !== undefined`だけを見て早期returnする限り、
 * ハンドシェイク未完了の壊れた接続を使い続けてしまう問題を確かめる。
 *
 * `spawn`を差し替えて子プロセスを立てずに検証する（`AppServerConnection`は
 * `node:child_process`を直接importするため、モジュールごとモックする）。
 */
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// `vi.mock`はホイストされるため、この静的importは差し替え後の`spawn`を使う
import { AppServerConnection } from '../../src/appserver/connection';
import { MAX_LINE_BUFFER_BYTES } from '../../src/process/childProcess';
import { createFakeChildProcess as fakeChildProcess } from '../helpers/fakeChildProcess';

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    show: () => undefined,
  };
}

/** 送信済みの行から`initialize`要求のidを取り出す（`request()`はidを連番で振る）。 */
function initializeRequestId(writes: string[]): number {
  const line = writes.find((w) => w.includes('"method":"initialize"'));
  if (line === undefined) {
    throw new Error('initialize要求が送信されていません');
  }
  return (JSON.parse(line) as { id: number }).id;
}

describe('AppServerConnection.ensureStarted（issue #354・1点目）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializeがタイムアウトで失敗したら、プロセスをkillしthis.procを残さない', async () => {
    const proc1 = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc1.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
      onDisconnect,
    );

    const started = connection.ensureStarted();
    // fake timerでタイムアウトを進める前に拒否のハンドラを付けておく（付け忘れると
    // 進めた瞬間にunhandled rejectionとして先に飛んでしまう）
    const rejected = expect(started).rejects.toThrow(/応答しません/u);
    // REQUEST_TIMEOUT_MS（120秒）が経過するまでinitializeへ応答しない
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(proc1.kill).toHaveBeenCalledTimes(1);
    // 接続断の通知経路（2点目の土台）も一度だけ呼ばれる
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('初期化失敗の後、ensureStartedを呼び直すと再度起動を試みる（壊れた接続を使い続けない）', async () => {
    const proc1 = fakeChildProcess();
    const proc2 = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc1.proc).mockReturnValueOnce(proc2.proc);
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
    );

    const first = connection.ensureStarted();
    const firstRejected = expect(first).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120_000);
    await firstRejected;

    // 修正前は`this.proc`が残ったままで、ここが早期returnして再起動しなかった
    const second = connection.ensureStarted();
    const id = initializeRequestId(proc2.writes);
    proc2.emitStdout(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    await expect(second).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('killしたprocのexitイベントが後から届いても、onDisconnectは二重に発火しない（自己レビュー: 再入防止）', async () => {
    const proc1 = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc1.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
      onDisconnect,
    );

    const started = connection.ensureStarted();
    const rejected = expect(started).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // `proc.kill()`は非同期にexitを発火させる。既にreset済みのため二度目は無視される
    proc1.emitExit(null);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('AppServerConnection: 受信バッファの上限（issue #402、1点目）', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('改行を含まない出力が上限を超えて届くと、接続を切って再起動できる状態にする', async () => {
    const proc1 = fakeChildProcess();
    const proc2 = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc1.proc).mockReturnValueOnce(proc2.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
      onDisconnect,
    );

    const started = connection.ensureStarted();
    const id = initializeRequestId(proc1.writes);
    proc1.emitStdout(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    await started;

    // 改行を一切含まない巨大な出力（診断ログの乱れ・バイナリ混入等を模す）
    proc1.proc.stdout.emit('data', Buffer.from('x'.repeat(MAX_LINE_BUFFER_BYTES + 1)));

    expect(proc1.kill).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // `reset()`により`this.proc`が`undefined`へ戻るため、次の`ensureStarted()`が
    // 新しいプロセスを起動し直す（＝「切って再起動」を確かめる）
    const second = connection.ensureStarted();
    const id2 = initializeRequestId(proc2.writes);
    proc2.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: id2, result: {} }));
    await expect(second).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('上限以内の出力（改行なしでも）では接続を切らない', async () => {
    const proc = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
      onDisconnect,
    );

    const started = connection.ensureStarted();
    const id = initializeRequestId(proc.writes);
    proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    await started;

    proc.proc.stdout.emit('data', Buffer.from('x'.repeat(1024)));

    expect(proc.kill).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('同じチャンクに正常な応答と上限超過の未完成行が同居しても、正常な応答は処理される（レビュー指摘・MEDIUM）', async () => {
    const proc = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
      onDisconnect,
    );

    const started = connection.ensureStarted();
    const initId = initializeRequestId(proc.writes);
    proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: initId, result: {} }));
    await started;

    // `request()`で送った要求の応答を、完成した行として先頭に置く
    const pending = connection.request('thread/fork', { threadId: 'a', lastTurnId: 'b' });
    const forkId = (JSON.parse(proc.writes.at(-1)!.trim()) as { id: number }).id;
    const responseLine = `${JSON.stringify({ jsonrpc: '2.0', id: forkId, result: { ok: true } })}
`;
    // 同じstdoutチャンクの中に、改行を含まない上限超過分（未完成行）を同居させる
    const overflowTail = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);
    proc.proc.stdout.emit('data', Buffer.from(responseLine + overflowTail));

    // overflowより先にmessagesが処理されるため、正常だった応答は失敗へすり替わらない
    await expect(pending).resolves.toEqual({
      jsonrpc: '2.0',
      id: forkId,
      result: { ok: true },
    });
    // その後、上限超過分でreset()（接続断）は起きる
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('通知ハンドラが同期的に例外を投げても、overflow時の後始末（切断・再起動）は行われる（レビュー指摘・LOW）', async () => {
    const proc = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => {
        throw new Error('boom');
      },
      async () => undefined,
      onDisconnect,
    );

    const started = connection.ensureStarted();
    const initId = initializeRequestId(proc.writes);
    proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: initId, result: {} }));
    await started;

    // 完成した通知行の直後に、改行を含まない上限超過分を同居させる
    const notifyLine = `${JSON.stringify({ jsonrpc: '2.0', method: 'some/event', params: {} })}
`;
    const overflowTail = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);

    // 通知ハンドラの例外はforループ内で起きるため、receive()の外まで伝播する
    // （try/finallyは握り潰さない。ここではfinallyでの後始末だけを確かめる）
    expect(() => {
      proc.proc.stdout.emit('data', Buffer.from(notifyLine + overflowTail));
    }).toThrow('boom');

    // 例外が起きても、finally側の後始末（切断・再起動できる状態にする）は実行される
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('AppServerConnection: 通常起動後の接続断（issue #354・2点目の土台）', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('起動成功後にプロセスが終了すると、onDisconnectが呼ばれる', async () => {
    const proc = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
      onDisconnect,
    );

    const started = connection.ensureStarted();
    const id = initializeRequestId(proc.writes);
    proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    await started;
    expect(onDisconnect).not.toHaveBeenCalled();

    proc.emitExit(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('AppServerConnection: 古い世代のプロセスからの通知を捨てる（issue #419、CRITICAL）', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('overflowでreset()した後、新しい接続が繋がってから古いprocのexitが遅れて届いても、新しい接続を落とさない', async () => {
    const proc1 = fakeChildProcess();
    const proc2 = fakeChildProcess();
    spawnMock.mockReturnValueOnce(proc1.proc).mockReturnValueOnce(proc2.proc);
    const onDisconnect = vi.fn();
    const connection = new AppServerConnection(
      () => 'codex',
      fakeLogger(),
      () => undefined,
      async () => undefined,
      onDisconnect,
    );

    // proc1で起動し、上限超過でreset()させる（issue #402と同じ経路で古い世代を作る）
    const started = connection.ensureStarted();
    const initId1 = initializeRequestId(proc1.writes);
    proc1.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: initId1, result: {} }));
    await started;
    proc1.proc.stdout.emit('data', Buffer.from('x'.repeat(MAX_LINE_BUFFER_BYTES + 1)));
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // 新しいプロセス（proc2）で繋ぎ直す
    const second = connection.ensureStarted();
    const initId2 = initializeRequestId(proc2.writes);
    proc2.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: initId2, result: {} }));
    await second;

    // 新しい接続（proc2）越しに要求を出す。まだ応答は届いていない状態にしておく
    const pending = connection.request('thread/fork', { threadId: 'a', lastTurnId: 'b' });
    const forkId = (JSON.parse(proc2.writes.at(-1)!.trim()) as { id: number }).id;

    // 修正前は、古い世代（proc1）のexitが遅れて届くと`connected`だけを見て素通りし、
    // 新しい接続（proc2）を巻き込んでreset()してしまっていた（onDisconnectの二重発火、
    // proc2越しのpendingが「app-serverとの接続が切れました」で誤って棄却される）
    proc1.emitExit(null);

    // 古い世代からの通知は捨てられるため、onDisconnectは増えない
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // proc2越しのpendingも誤って棄却されておらず、実際の応答で正常に解決される
    proc2.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: forkId, result: { ok: true } }));
    await expect(pending).resolves.toEqual({
      jsonrpc: '2.0',
      id: forkId,
      result: { ok: true },
    });
  });
});
