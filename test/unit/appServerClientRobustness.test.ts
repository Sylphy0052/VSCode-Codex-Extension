import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { type JsonRpcMessage } from '../../src/codex/jsonRpc';
/**
 * このテストでの受信バッファの1行上限（issue #795）。
 *
 * 実際の既定値（`MAX_APP_SERVER_LINE_BYTES`）は384MBあり、超過させるだけのために
 * その大きさの文字列を作るとテストが重くなる。上限値そのものはここでの関心では
 * ないため、コンストラクタから小さい値を渡して挙動だけを見る。
 */
const TEST_MAX_LINE_BYTES = 1024;

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
import { createFakeChildProcess as fakeChildProcess } from '../helpers/fakeChildProcess';

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

describe('AppServerClient: exit経由のfinish()ではkillを飛ばさない（issue #419、LOW）', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('子プロセスが自分で終了した場合、finish()は既に死んだ子へkillWithEscalationを掛けない', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.forkThread(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );

    // `initialize`へ応答する前に、子プロセスが自分で終了した想定（`proc.on('exit')`から
    // `finish()`が呼ばれる経路）。修正前はここで死んだ子へ`kill()`（SIGTERM相当）を送り、
    // 3秒のエスカレーションタイマーだけが無意味に残っていた
    fake.emitExit(1);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(fake.kill).not.toHaveBeenCalled();
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
    const outer = call.call(
      client,
      async (request) => {
        await request('probe/first', {});
        seen.push('first-resolved');
        // 修正前は、finish()が先に確定してもここが永久にハングしていた
        // （`pending`に残ったままの`request()`が誰にも解決されないため）
        const second = await request('probe/second', {});
        seen.push('second-resolved');
        return { ok: true, value: second.error?.message ?? 'no-error' };
      },
      20,
    );

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
    const client = new AppServerClient(() => 'codex', fakeLogger(), 30_000, TEST_MAX_LINE_BYTES);

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
    const overflowTail = 'x'.repeat(TEST_MAX_LINE_BYTES + 1);
    fake.proc.stdout.emit('data', Buffer.from(responseLine + overflowTail));

    // overflowより先にmessagesが処理されるため、正常だった応答は失敗へすり替わらない
    await expect(pending).resolves.toEqual({
      ok: true,
      threadId: '019fd880-dd5b-7a03-a07a-bfd9a1fc4808',
    });
  });

  it('overflow検知時にクロージャ内のbufferが確実にクリアされる（レビュー指摘・MEDIUM）', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger(), 30_000, TEST_MAX_LINE_BYTES);

    const pending = client.forkThread(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );

    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    // 改行を一切含まない上限超過分だけのチャンク（completeなmessagesは無い）
    const overflowTail = 'x'.repeat(TEST_MAX_LINE_BYTES + 1);
    fake.proc.stdout.emit('data', Buffer.from(overflowTail));

    // bufferがクリアされていれば、続くチャンクは単独で解釈される。クリアされて
    // いなければ、10MB超のoverflow分（改行なし）へ連結された結果、この応答行の
    // 直前に改行が無いままとなり、1行としてパースに失敗し応答が届かない
    const forkId = requestId(fake.writes, 'thread/fork');
    const responseLine = `${respond(forkId, {
      thread: { id: '019fd880-dd5b-7a03-a07a-bfd9a1fc4808' },
    })}
`;
    fake.proc.stdout.emit('data', Buffer.from(responseLine));

    // bufferがクリアされているため、この応答は単独で完成した行として解決され、
    // `body`の続きが（overflow起因のfinishより先に）成功で確定する
    await expect(pending).resolves.toEqual({
      ok: true,
      threadId: '019fd880-dd5b-7a03-a07a-bfd9a1fc4808',
    });
  });

  it('通知リスナーが同期的に例外を投げても、overflow時の後始末（打ち切りの予約）は行われる（レビュー指摘・LOW）', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger(), 30_000, TEST_MAX_LINE_BYTES);

    const call = (client as unknown as { call: CallMethod }).call;
    const outer = call.call(
      client,
      async (_request, notify) => {
        notify.onEach(() => {
          throw new Error('boom');
        });
        // 通知が届くまで待つだけ。応答は来ない想定で、決着は overflow 起因の
        // finish() に任せる
        return await new Promise<{ ok: true; value: string } | { ok: false; error: string }>(
          () => undefined,
        );
      },
      30,
    );

    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    // 完成した通知行の直後に、改行を含まない上限超過分を同居させる
    const notifyLine = `${JSON.stringify({ jsonrpc: '2.0', method: 'some/event', params: {} })}
`;
    const overflowTail = 'x'.repeat(TEST_MAX_LINE_BYTES + 1);

    // 通知リスナーの例外はforループ内で起きるため、'data'イベントの外まで伝播する
    // （try/finallyは握り潰さない。ここではfinallyでの後始末だけを確かめる）
    expect(() => {
      fake.proc.stdout.emit('data', Buffer.from(notifyLine + overflowTail));
    }).toThrow('boom');

    // 例外が起きても、finally側でoverflow時の打ち切り（finishのsetImmediate予約）は
    // 行われる
    const result = await outer;
    expect(result.ok).toBe(false);
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });
});

/** `writes`からn番目（0始まり）に一致するmethodの要求idを取り出す。 */
function requestIdAt(writes: string[], method: string, occurrence: number): number {
  const matches = writes.filter((w) => w.includes(`"method":"${method}"`));
  const line = matches[occurrence];
  if (line === undefined) {
    throw new Error(`${method}要求(${occurrence}番目)が送信されていません`);
  }
  return (JSON.parse(line) as { id: number }).id;
}

describe('AppServerClient.listThreads（issue #1346: cursorページングの頑健化）', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('limitが0以下なら要求を送らず空配列を返す', async () => {
    const client = new AppServerClient(() => 'codex', fakeLogger());
    await expect(client.listThreads(0, '/archived')).resolves.toEqual({ ok: true, sessions: [] });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('limitが安全な整数でなければ要求を送らず空配列を返す', async () => {
    const client = new AppServerClient(() => 'codex', fakeLogger());
    await expect(client.listThreads(Number.POSITIVE_INFINITY, '/archived')).resolves.toEqual({
      ok: true,
      sessions: [],
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('nextCursorが無くなるまでページングし、正規化した結果を返す（consumePage無し）', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listThreads(50, '/archived');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 0), {
        data: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', updatedAt: 1700000000 }],
        nextCursor: 'cursor-1',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 1), {
        data: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', updatedAt: 1700000001 }],
      }),
    );

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.ok && result.sessions.map((s) => s.id)).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ]);
  });

  it('thread/listがエラー応答なら失敗として返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listThreads(50, '/archived');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestIdAt(fake.writes, 'thread/list', 0),
        error: { code: -1, message: '応答できません' },
      }),
    );

    const result = await pending;
    expect(result).toEqual({ ok: false, error: '応答できません' });
  });

  it('空ページなのにnextCursorが続く場合はページングが進まないとして失敗させる', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listThreads(50, '/archived');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 0), { data: [], nextCursor: 'cursor-1' }),
    );

    const result = await pending;
    expect(result).toEqual({
      ok: false,
      error: 'thread/listのページングが進みませんでした',
    });
  });

  it('nextCursorが直前と同じまま変化しない場合はページングが進まないとして失敗させる', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listThreads(50, '/archived');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 0), {
        data: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', updatedAt: 1700000000 }],
        nextCursor: 'cursor-1',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 1), {
        data: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', updatedAt: 1700000001 }],
        nextCursor: 'cursor-1',
      }),
    );

    const result = await pending;
    expect(result).toEqual({
      ok: false,
      error: 'thread/listのページングが進みませんでした',
    });
  });

  it('consumePageが指定されたら各ページを渡し、falseを返した時点で打ち切る', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const seenPages: number[] = [];
    const pending = client.listThreads(50, '/archived', async (page) => {
      seenPages.push(page.rawCount);
      return false;
    });
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 0), {
        data: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', updatedAt: 1700000000 }],
        nextCursor: 'cursor-1',
      }),
    );

    const result = await pending;
    // consumePageがfalseを返した時点で打ち切るため、2ページ目は要求しない
    expect(seenPages).toEqual([1]);
    expect(result).toEqual({ ok: true, sessions: [] });
    expect(fake.writes.filter((w) => w.includes('"method":"thread/list"'))).toHaveLength(1);
  });

  it('consumePageがtrueを返し続けても、nextCursorが無くなればそこで打ち切る', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const seenPages: number[] = [];
    const pending = client.listThreads(50, '/archived', async (page) => {
      seenPages.push(page.rawCount);
      return true;
    });
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    // 1ページ目はnextCursorがあるため、continueScanがtrueなら通常どおり2ページ目へ進む
    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 0), {
        data: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', updatedAt: 1700000000 }],
        nextCursor: 'cursor-1',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'thread/list', 1), {
        data: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', updatedAt: 1700000001 }],
      }),
    );

    const result = await pending;
    // 2ページ目でnextCursorが無いため、consumePageがtrueでもそこで打ち切る
    expect(seenPages).toEqual([1, 1]);
    expect(result).toEqual({ ok: true, sessions: [] });
  });
});

describe('AppServerClient: 未テストだった単発要求メソッドの成功・失敗経路', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('setThreadName: 成功すればtrueを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setThreadName('11111111-1111-1111-1111-111111111111', '名前');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'thread/name/set'), {}));

    await expect(pending).resolves.toBe(true);
  });

  it('setThreadName: 失敗すればfalseを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setThreadName('11111111-1111-1111-1111-111111111111', '名前');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'thread/name/set'),
        error: { code: -1, message: '保存できません' },
      }),
    );

    await expect(pending).resolves.toBe(false);
  });

  it('listMcpServers: mcpServerStatus/listが失敗すれば理由付きで失敗を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listMcpServers();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'mcpServerStatus/list'),
        error: { code: -1, message: '取得できません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, reason: '取得できません' });
  });

  it('listMcpServers: config/readが失敗すれば理由付きで失敗を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listMcpServers();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'mcpServerStatus/list'), { servers: [] }));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'config/read'),
        error: { code: -1, message: '設定を読めません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, reason: '設定を読めません' });
  });

  it('listMcpServers: 両方成功すればサーバー一覧を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listMcpServers();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'mcpServerStatus/list'), { servers: [] }));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'config/read'), {}));

    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it('setMcpServerEnabled: 不正なサーバー名は要求を送らずエラーを返す', async () => {
    const client = new AppServerClient(() => 'codex', fakeLogger());
    await expect(client.setMcpServerEnabled('bad name!', true)).resolves.toEqual({
      ok: false,
      error: '不正なサーバー名です',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('setMcpServerEnabled: config/value/writeが失敗すればエラーを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setMcpServerEnabled('my-server', true);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'config/value/write'),
        error: { code: -1, message: '書き込めません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, error: '書き込めません' });
  });

  it('setMcpServerEnabled: config/mcpServer/reloadが失敗すればエラーを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setMcpServerEnabled('my-server', true);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'config/value/write'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'config/mcpServer/reload'),
        error: { code: -1, message: '再読込できません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, error: '再読込できません' });
  });

  it('setMcpServerEnabled: 両方成功すればokを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setMcpServerEnabled('my-server', false);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'config/value/write'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'config/mcpServer/reload'), {}));

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('listHooks: cwdsを省略すると空paramsで要求し、成功すれば一覧を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listHooks([]);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    const hooksReq = JSON.parse(
      fake.writes.find((w) => w.includes('"method":"hooks/list"')) ?? '{}',
    ) as { id: number; params: unknown };
    expect(hooksReq.params).toEqual({});
    fake.emitStdout(respond(hooksReq.id, { data: [] }));

    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it('listHooks: cwdsを渡すとそのまま要求へ乗せ、失敗すれば理由を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listHooks(['/workspace/root']);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    const hooksReq = JSON.parse(
      fake.writes.find((w) => w.includes('"method":"hooks/list"')) ?? '{}',
    ) as { id: number; params: unknown };
    expect(hooksReq.params).toEqual({ cwds: ['/workspace/root'] });
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: hooksReq.id,
        error: { code: -1, message: 'hooksを取得できません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, reason: 'hooksを取得できません' });
  });

  it('listModels: nextCursorが無くなるまでページングし、モデル一覧を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listModels();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'model/list', 0), {
        data: [{ id: 'gpt-x' }],
        nextCursor: 'cursor-1',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      respond(requestIdAt(fake.writes, 'model/list', 1), { data: [{ id: 'gpt-y' }] }),
    );

    const result = await pending;
    expect(result.length).toBeGreaterThan(0);
  });

  it('listModels: model/listが失敗すれば空配列を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listModels();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'model/list'),
        error: { code: -1, message: 'モデルを取得できません' },
      }),
    );

    await expect(pending).resolves.toEqual([]);
  });

  it('setHookTrusted: 不正なkeyは要求を送らずエラーを返す', async () => {
    const client = new AppServerClient(() => 'codex', fakeLogger());
    await expect(client.setHookTrusted('', 'hash')).resolves.toEqual({
      ok: false,
      error: '不正なhookのkeyです: ',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('setHookTrusted: config/batchWriteが失敗すればエラーを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setHookTrusted('PreToolUse', 'hash');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'config/batchWrite'),
        error: { code: -1, message: '書き込めません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, error: '書き込めません' });
  });

  it('setHookTrusted: 成功すればokを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setHookTrusted('PreToolUse', 'hash');
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'config/batchWrite'), {}));

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('listSkills: cwdsを省略すると空paramsで要求し、失敗すれば理由を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listSkills([]);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    const skillsReq = JSON.parse(
      fake.writes.find((w) => w.includes('"method":"skills/list"')) ?? '{}',
    ) as { id: number; params: unknown };
    expect(skillsReq.params).toEqual({});
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: skillsReq.id,
        error: { code: -1, message: 'skillsを取得できません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, reason: 'skillsを取得できません' });
  });

  it('listSkills: cwdsを渡すとそのまま要求へ乗せ、成功すれば一覧を返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.listSkills(['/workspace/root']);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();

    const skillsReq = JSON.parse(
      fake.writes.find((w) => w.includes('"method":"skills/list"')) ?? '{}',
    ) as { id: number; params: unknown };
    expect(skillsReq.params).toEqual({ cwds: ['/workspace/root'] });
    fake.emitStdout(respond(skillsReq.id, { data: [] }));

    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it('setSkillEnabled: 不正なパスは要求を送らずエラーを返す', async () => {
    const client = new AppServerClient(() => 'codex', fakeLogger());
    await expect(client.setSkillEnabled('relative/path', true)).resolves.toEqual({
      ok: false,
      error: '不正なパスです',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('setSkillEnabled: skills/config/writeが失敗すればエラーを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setSkillEnabled('/abs/path', true);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId(fake.writes, 'skills/config/write'),
        error: { code: -1, message: '切替できません' },
      }),
    );

    await expect(pending).resolves.toEqual({ ok: false, error: '切替できません' });
  });

  it('setSkillEnabled: 成功すればokを返す', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger());

    const pending = client.setSkillEnabled('/abs/path', false);
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'initialize'), {}));
    await Promise.resolve();
    await Promise.resolve();
    fake.emitStdout(respond(requestId(fake.writes, 'skills/config/write'), {}));

    await expect(pending).resolves.toEqual({ ok: true });
  });
});
