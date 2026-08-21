import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { MAX_LINE_BUFFER_BYTES, type JsonRpcMessage } from '../../src/codex/jsonRpc';

/**
 * issue #402（T17: ストリーム受信とプロセス終了の頑健性）の2点目・3点目を、
 * `AppServerClient` 側で確かめる。
 *
 * `AppServerClient`は`node:child_process`を直接importするため、`connection.test.ts`と
 * 同じ方針でモジュールごとモックする。
 */
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// `vi.mock`はホイストされるため、この静的importは差し替え後の`spawn`を使う
import { AppServerClient } from '../../src/codex/appServerClient';

interface FakeChildProcess {
  proc: ChildProcessWithoutNullStreams;
  kill: ReturnType<typeof vi.fn>;
  writes: string[];
  emitStdout: (line: string) => void;
  emitExit: (code: number | null) => void;
}

function fakeChildProcess(): FakeChildProcess {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  });
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn();
  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill,
    killed: false,
  }) as unknown as ChildProcessWithoutNullStreams;

  return {
    proc,
    kill,
    writes,
    emitStdout: (line: string) => stdout.emit('data', Buffer.from(`${line}\n`)),
    emitExit: (code: number | null) => emitter.emit('exit', code),
  };
}

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    show: () => undefined,
  };
}

/** 送信済みの行から、指定メソッドの要求idを取り出す（`request()`はidを連番で振る）。 */
function requestId(writes: string[], method: string): number {
  const line = writes.find((w) => w.includes(`"method":"${method}"`));
  if (line === undefined) {
    throw new Error(`${method}要求が送信されていません`);
  }
  return (JSON.parse(line) as { id: number }).id;
}

function respond(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/** private `call()` をテストから直接呼ぶための最小限の型（TSのprivateは実行時には保護されない）。 */
type CallMethod = <T>(
  body: (
    request: (method: string, params: unknown) => Promise<JsonRpcMessage>,
    notify: { onEach: (listener: (message: JsonRpcMessage) => void) => () => void },
  ) => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  timeoutOverrideMs?: number,
) => Promise<{ ok: true; value: T } | { ok: false; error: string }>;

describe('AppServerClient: SIGKILLエスカレーション（issue #402、2点目）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SIGTERMに応答しないプロセスは一定時間後にSIGKILLされる', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger(), 30_000);

    const pending = client.forkThread(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );

    // `initialize`に応答しないままタイムアウトさせ、`finish()`（内部でkill）を発火させる
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    // SIGTERM相当（既定シグナル、引数なし）が1回目
    expect(fake.kill).toHaveBeenNthCalledWith(1);
    expect(fake.kill).toHaveBeenCalledTimes(1);

    // `exit`が届かないまま猶予（3秒）が過ぎると、SIGKILLへエスカレーションする
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.kill).toHaveBeenCalledTimes(2);
    expect(fake.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('猶予時間内にexitが届けば、SIGKILLは送られない（正常終了への巻き込み防止）', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger(), 30_000);

    const pending = client.forkThread(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(fake.kill).toHaveBeenCalledTimes(1);

    // SIGTERMで素直に終了した想定
    fake.emitExit(0);
    await vi.advanceTimersByTimeAsync(3_000);

    // タイマーがクリアされているため、猶予後もSIGKILLは送られない
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });
});

describe('AppServerClient: finish()後のpending解放（issue #402、3点目）', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('finish()がタイムアウトで先に確定しても、bodyが待っていたrequest()は宙に浮かず解決される', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const seen: string[] = [];
    const call = (client as unknown as { call: CallMethod }).call;
    const outer = call.call(client, async (request) => {
      await request('probe/first', {});
      seen.push('first-resolved');
      // 修正前は、finish()が先に確定してもここが永久にハングしていた
      // （`pending`に残ったままの`request()`が誰にも解決されないため）
      const second = await request('probe/second', {});
      seen.push('second-resolved');
      return { ok: true, value: second.error?.message ?? 'no-error' };
    }, 20);

    // `initialize`に応答して起動シーケンスを終わらせる
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    // `probe/first`にだけ応答する。`probe/second`は誰も応答しない（ハング相当）
    fake.emitStdout(respond(requestId(fake.writes, 'probe/first'), {}));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['first-resolved']);

    // タイムアウトでfinish()が確定する（`settled`ガードにより以後の`finish()`は無視される）
    await new Promise((resolve) => setTimeout(resolve, 40));
    const result = await outer;

    expect(result.ok).toBe(false);
    // `probe/second`の応答待ちがfinish()でエラー値により解決され、bodyの続きが実行された
    expect(seen).toEqual(['first-resolved', 'second-resolved']);
  });
});

describe('AppServerClient: 受信バッファの上限（issue #402、1点目・レビュー指摘のMEDIUM）', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('同じチャンクに正常な応答と上限超過の未完成行が同居しても、正常な応答は処理される', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.forkThread(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );

    // `initialize`に応答して起動シーケンスを終わらせる
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    // `thread/fork`への正常な応答を、完成した行として先頭に置く
    const forkId = requestId(fake.writes, 'thread/fork');
    const responseLine = `${respond(forkId, {
      thread: { id: '019fd880-dd5b-7a03-a07a-bfd9a1fc4808' },
    })}
`;
    // 同じstdoutチャンクの中に、改行を含まない上限超過分（未完成行）を同居させる
    const overflowTail = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);
    fake.proc.stdout.emit('data', Buffer.from(responseLine + overflowTail));

    // overflowより先にmessagesが処理されるため、正常だった応答は失敗へすり替わらない
    await expect(pending).resolves.toEqual({
      ok: true,
      threadId: '019fd880-dd5b-7a03-a07a-bfd9a1fc4808',
    });
  });
});
