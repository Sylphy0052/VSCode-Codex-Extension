import { randomUUID } from 'node:crypto';
import type { FSWatcher } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import {
  generateWindowId,
  isSharedApprovalDecision,
  isSharedHandoffDecision,
  SessionHubReader,
  SessionHubRequestPort,
  SessionHubRequestWatcher,
  SessionHubWriter,
  sessionHubRoot,
  type SessionHubReply,
  type SessionHubRequest,
  type SessionHubRequestOutcome,
  type SharedSession,
} from '../../src/view/sessionHub';

/**
 * セッション統括の共有ファイル層（Issue #1244 / #1258 / #1461 / #1809）。
 *
 * 実ファイルシステム（一時ディレクトリ）の上で、書き手・読み手・要求の送受信を通す。
 * `fs`をモックすると「renameで置き換える」「消せた側だけが処理する」といった肝の
 * 挙動が検証できないため。
 */

// fake timersで`setTimeout`を差し替えても、実I/Oの完了待ちは本物の時計で行う
const realSetTimeout = globalThis.setTimeout;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** 条件が満たされるまで、本物の時計で待つ（fake timers下でも進める）。 */
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await cond())) {
    if (performance.now() > deadline) {
      throw new Error('条件が満たされないまま時間切れになった');
    }
    await realSleep(10);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface FakeLog extends Logger {
  info: ReturnType<typeof vi.fn<(message: string) => void>>;
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
}

function makeLog(): FakeLog {
  return {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    show: vi.fn<() => void>(),
  };
}

function session(threadId: string, overrides: Partial<SharedSession> = {}): SharedSession {
  return {
    threadId,
    title: `title-${threadId}`,
    cwd: '/work',
    provider: 'codex',
    activity: 'idle',
    ...overrides,
  };
}

let root: string;
const disposables: Array<{ dispose(): unknown }> = [];

function track<T extends { dispose(): unknown }>(d: T): T {
  disposables.push(d);
  return d;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'session-hub-test-'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const d of disposables.splice(0)) {
    await d.dispose();
  }
  await rm(root, { recursive: true, force: true });
});

function sessionsPath(windowId: string): string {
  return path.join(root, 'sessions', `${windowId}.json`);
}

async function putSessionFile(
  windowId: string,
  body: unknown,
  opts: { ageMs?: number } = {},
): Promise<string> {
  await mkdir(path.join(root, 'sessions'), { recursive: true });
  const file = sessionsPath(windowId);
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  if (opts.ageMs !== undefined) {
    const t = new Date(Date.now() - opts.ageMs);
    await utimes(file, t, t);
  }
  return file;
}

/** 書き込み途中を拾わせないよう、tmp→renameで置き換える（実際の書き手と同じ）。 */
async function replaceSessionFile(windowId: string, body: unknown): Promise<void> {
  const file = sessionsPath(windowId);
  const tmp = `${file}.tmp-test`;
  await writeFile(tmp, JSON.stringify(body), 'utf8');
  await rename(tmp, file);
}

describe('補助関数', () => {
  it('generateWindowIdはUUID形式で毎回異なる', () => {
    const a = generateWindowId();
    const b = generateWindowId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('sessionHubRootはglobalStorage配下のsession-hubを指す', () => {
    expect(sessionHubRoot('/g/storage')).toBe(path.join('/g/storage', 'session-hub'));
  });

  it('isSharedApprovalDecisionはacceptとdeclineだけを通す', () => {
    expect(isSharedApprovalDecision('accept')).toBe(true);
    expect(isSharedApprovalDecision('decline')).toBe(true);
    expect(isSharedApprovalDecision('acceptForSession')).toBe(false);
    expect(isSharedApprovalDecision('cancel')).toBe(false);
    expect(isSharedApprovalDecision(undefined)).toBe(false);
  });

  it('isSharedHandoffDecisionは4値だけを通す', () => {
    for (const ok of ['proceed', 'repick', 'reclassify', 'cancel']) {
      expect(isSharedHandoffDecision(ok)).toBe(true);
    }
    expect(isSharedHandoffDecision('abort')).toBe(false);
    expect(isSharedHandoffDecision(1)).toBe(false);
  });
});

describe('SessionHubWriter', () => {
  it('write()は自ウィンドウのセッションを共有ファイルへ書く', async () => {
    const windowId = randomUUID();
    const writer = new SessionHubWriter(
      root,
      windowId,
      () => [session('t1', { activity: 'running', loop: { running: true, paused: false } })],
      makeLog(),
    );
    await writer.write();
    const written = JSON.parse(await readFile(sessionsPath(windowId), 'utf8')) as {
      windowId: string;
      updatedAt: number;
      sessions: SharedSession[];
    };
    expect(written.windowId).toBe(windowId);
    expect(typeof written.updatedAt).toBe('number');
    expect(written.sessions).toEqual([
      session('t1', { activity: 'running', loop: { running: true, paused: false } }),
    ]);
    // 一時ファイルは残さない
    expect(await readdir(path.join(root, 'sessions'))).toEqual([`${windowId}.json`]);
  });

  it('書き込みに失敗してもwarnを残して例外にしない', async () => {
    // rootが通常ファイルなので、sessionsのmkdirがENOTDIRになる
    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'x');
    const log = makeLog();
    const writer = new SessionHubWriter(blocker, randomUUID(), () => [], log);
    await expect(writer.write()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain('共有ファイルの書き込みに失敗');
  });

  it('実行中のwrite()は印だけ付けて戻り、終わった直後に最新の状態でもう1回書く', async () => {
    const windowId = randomUUID();
    let n = 0;
    const getSessions = vi.fn(() => {
      n += 1;
      return [session(`gen-${n}`)];
    });
    const writer = new SessionHubWriter(root, windowId, getSessions, makeLog());
    const first = writer.write();
    const second = writer.write(); // 実行中なので待たずに戻る
    await second;
    expect(getSessions).toHaveBeenCalledTimes(1);
    await first;
    expect(getSessions).toHaveBeenCalledTimes(2);
    const written = JSON.parse(await readFile(sessionsPath(windowId), 'utf8')) as {
      sessions: SharedSession[];
    };
    expect(written.sessions.map((s) => s.threadId)).toEqual(['gen-2']);
  });

  it('dispose()は実行中の書き込みを待ってからファイルを消し、以後は書かない', async () => {
    const windowId = randomUUID();
    const getSessions = vi.fn(() => [session('t1')]);
    const writer = new SessionHubWriter(root, windowId, getSessions, makeLog());
    const inflight = writer.write();
    await writer.dispose();
    await inflight;
    expect(await exists(sessionsPath(windowId))).toBe(false);
    getSessions.mockClear();
    await writer.write();
    expect(getSessions).not.toHaveBeenCalled();
    expect(await exists(sessionsPath(windowId))).toBe(false);
  });

  it('dispose()は消すファイルが無くても失敗しない', async () => {
    const writer = new SessionHubWriter(root, randomUUID(), () => [], makeLog());
    await expect(writer.dispose()).resolves.toBeUndefined();
  });

  it('requestWrite()は最初の1件をすぐ書き、以降は間隔ごとにまとめる', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(10_000_000);
    const windowId = randomUUID();
    const getSessions = vi.fn(() => [session('t1')]);
    const writer = track(new SessionHubWriter(root, windowId, getSessions, makeLog()));

    writer.requestWrite();
    expect(getSessions).toHaveBeenCalledTimes(1); // 即時
    await until(() => exists(sessionsPath(windowId)));
    await realSleep(30); // writeLoopの完了を待つ

    writer.requestWrite(); // 1秒以内なのでタイマー予約
    writer.requestWrite(); // 予約済みなので何もしない
    expect(getSessions).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(getSessions).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(getSessions).toHaveBeenCalledTimes(2); // まとめた1回だけ
  });

  it('start()は即時に書き、heartbeatで書き直し、dispose()で止まる', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(20_000_000);
    const windowId = randomUUID();
    const getSessions = vi.fn(() => [session('t1')]);
    const writer = new SessionHubWriter(root, windowId, getSessions, makeLog());
    writer.start();
    expect(getSessions).toHaveBeenCalledTimes(1);
    await until(() => exists(sessionsPath(windowId)));
    await realSleep(30);

    vi.advanceTimersByTime(15_000);
    expect(getSessions).toHaveBeenCalledTimes(2);
    await realSleep(30);

    // 予約中のrequestWriteもdisposeで取り消される
    writer.requestWrite();
    await writer.dispose();
    getSessions.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(getSessions).not.toHaveBeenCalled();
    expect(await exists(sessionsPath(windowId))).toBe(false);
  });
});

describe('SessionHubReader', () => {
  const selfId = randomUUID();

  function makeReader(log: Logger = makeLog()) {
    const reader = track(new SessionHubReader(root, selfId, log));
    const internals = reader as unknown as {
      reconcileAll(): Promise<void>;
      cleanupStaleSessionFiles(): Promise<void>;
      watcher: FSWatcher | undefined;
    };
    return { reader, internals };
  }

  function fileBody(windowId: string, sessions: unknown[], updatedAt = Date.now()) {
    return { windowId, updatedAt, sessions };
  }

  it('他ウィンドウのセッションを読み、windowIdは中身ではなくファイル名から採る', async () => {
    const { reader, internals } = makeReader();
    const other = randomUUID();
    await putSessionFile(other, fileBody('../../evil', [session('t1')]));
    await internals.reconcileAll();
    const others = reader.getOthers();
    expect(others).toHaveLength(1);
    expect(others[0]?.windowId).toBe(other);
    expect(others[0]?.sessions.map((s) => s.threadId)).toEqual(['t1']);
  });

  it('自分のファイル・形の合わないファイル名・json以外は読まない', async () => {
    const { reader, internals } = makeReader();
    await putSessionFile(selfId, fileBody(selfId, [session('mine')]));
    await putSessionFile('not-a-uuid', fileBody('x', [session('bad-name')]));
    const ok = randomUUID();
    await putSessionFile(ok, fileBody(ok, [session('ok')]));
    await writeFile(path.join(root, 'sessions', `${randomUUID()}.txt`), 'junk');
    await internals.reconcileAll();
    expect(reader.getOthers().map((o) => o.windowId)).toEqual([ok]);
  });

  it('壊れたファイル・必須項目の欠けたファイルは無視し、他のウィンドウは読める', async () => {
    const { reader, internals } = makeReader();
    const broken = randomUUID();
    const notObject = randomUUID();
    const missing = randomUUID();
    const noSessions = randomUUID();
    const good = randomUUID();
    await putSessionFile(broken, '{not json');
    await putSessionFile(notObject, 'null');
    await putSessionFile(missing, { updatedAt: Date.now(), sessions: [] });
    await putSessionFile(noSessions, { windowId: noSessions, updatedAt: Date.now() });
    await putSessionFile(good, fileBody(good, []));
    await internals.reconcileAll();
    expect(reader.getOthers().map((o) => o.windowId)).toEqual([good]);
  });

  it('形の合わないセッション要素だけを落とし、不正なloopは外して取り込む', async () => {
    const { reader, internals } = makeReader();
    const other = randomUUID();
    await putSessionFile(
      other,
      fileBody(other, [
        session('ok-with-loop', { loop: { running: true, paused: true } }),
        session('bad-loop', { loop: { running: 'yes' } as never }),
        session('no-cwd', { cwd: undefined }),
        { threadId: 't', title: 'x', provider: 'codex', activity: 'exploding' },
        { threadId: 't', title: 'x', provider: 'gemini', activity: 'idle' },
        { threadId: 1, title: 'x', provider: 'codex', activity: 'idle' },
        null,
        'str',
      ]),
    );
    await internals.reconcileAll();
    const sessions = reader.getOthers()[0]?.sessions ?? [];
    expect(sessions.map((s) => s.threadId)).toEqual(['ok-with-loop', 'bad-loop', 'no-cwd']);
    expect(sessions[0]?.loop).toEqual({ running: true, paused: true });
    expect(sessions[1]?.loop).toBeUndefined();
  });

  it('stale（mtimeまたはupdatedAtが45秒超）のウィンドウは除外する', async () => {
    const { reader, internals } = makeReader();
    const oldMtime = randomUUID();
    const oldUpdated = randomUUID();
    const fresh = randomUUID();
    await putSessionFile(oldMtime, fileBody(oldMtime, [session('a')]), { ageMs: 60_000 });
    await putSessionFile(oldUpdated, fileBody(oldUpdated, [session('b')], Date.now() - 60_000));
    await putSessionFile(fresh, fileBody(fresh, [session('c')]));
    await internals.reconcileAll();
    expect(reader.getOthers().map((o) => o.windowId)).toEqual([fresh]);
  });

  it('消えたファイルはキャッシュから外れ、ディレクトリ自体が無ければ空になる', async () => {
    const { reader, internals } = makeReader();
    const a = randomUUID();
    const b = randomUUID();
    await putSessionFile(a, fileBody(a, [session('a')]));
    await putSessionFile(b, fileBody(b, [session('b')]));
    await internals.reconcileAll();
    expect(reader.getOthers()).toHaveLength(2);

    await rm(sessionsPath(a));
    await internals.reconcileAll();
    expect(reader.getOthers().map((o) => o.windowId)).toEqual([b]);

    await rm(path.join(root, 'sessions'), { recursive: true });
    await internals.reconcileAll();
    expect(reader.getOthers()).toEqual([]);
  });

  it('中身（updatedAtを除く）が変わらなければ発火せず、変われば発火する', async () => {
    const { reader, internals } = makeReader();
    const fired = vi.fn();
    reader.onDidChange(fired);
    // readdirの並び順に依らず並べ替えて比べるため、複数ウィンドウで通す
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      await putSessionFile(id, fileBody(id, [session(`t-${id}`)]));
    }
    await internals.reconcileAll();
    expect(fired).toHaveBeenCalledTimes(1);

    // heartbeatだけ（updatedAtの更新）は発火しない
    await replaceSessionFile(
      ids[0] as string,
      fileBody(ids[0] as string, [session(`t-${ids[0]}`)], Date.now() + 1),
    );
    await internals.reconcileAll();
    expect(fired).toHaveBeenCalledTimes(1);

    // activityが変われば発火する
    await replaceSessionFile(
      ids[0] as string,
      fileBody(ids[0] as string, [session(`t-${ids[0]}`, { activity: 'running' })]),
    );
    await internals.reconcileAll();
    expect(fired).toHaveBeenCalledTimes(2);
    expect(reader.getOthers().find((o) => o.windowId === ids[0])?.sessions[0]?.activity).toBe(
      'running',
    );
  });

  it('変化の無いファイルは再読込せず、キャッシュの中身を保つ', async () => {
    const { reader, internals } = makeReader();
    const id = randomUUID();
    const file = await putSessionFile(id, fileBody(id, [session('t1')]));
    await internals.reconcileAll();
    const before = reader.getOthers()[0];
    // mtime/size/inoが同じ間は中身を読み直さない。キャッシュ済みのオブジェクトがそのまま返る
    await internals.reconcileAll();
    expect(reader.getOthers()[0]).toBe(before);
    expect(await exists(file)).toBe(true);
  });

  it('start()は既存の一覧を読み、監視で追加されたウィンドウを拾う', async () => {
    const { reader } = makeReader();
    const first = randomUUID();
    await putSessionFile(first, fileBody(first, [session('a')]));
    const fired = vi.fn();
    reader.onDidChange(fired);
    reader.start();
    await until(() => reader.getOthers().length === 1);
    expect(fired).toHaveBeenCalled();

    const second = randomUUID();
    await putSessionFile(second, fileBody(second, [session('b')]));
    await until(() => reader.getOthers().length === 2);
    expect(
      reader
        .getOthers()
        .map((o) => o.windowId)
        .sort(),
    ).toEqual([first, second].sort());
  });

  it('一時ファイルやjson以外の通知では読み直さない', async () => {
    const { reader } = makeReader();
    const internals = reader as unknown as {
      scheduleReload(filename: string | Buffer | null): void;
      pendingNames: Set<string>;
      pendingFullScan: boolean;
    };
    internals.scheduleReload(`${randomUUID()}.json.tmp-1`);
    internals.scheduleReload('readme.txt');
    expect(internals.pendingNames.size).toBe(0);
    expect(internals.pendingFullScan).toBe(false);
    // Bufferで届く場合も文字列へ直して扱う（reloadは走らせず積むだけ確認するためdispose後に積む前の状態を見る）
    const id = randomUUID();
    await putSessionFile(id, fileBody(id, [session('buf')]));
    internals.scheduleReload(Buffer.from(`${id}.json`, 'utf8'));
    await until(() => reader.getOthers().length === 1);
  });

  it('監視のerrorはwarnに残し、ディレクトリを作れないときもwarnで済ます', async () => {
    const log = makeLog();
    const { reader, internals } = makeReader(log);
    reader.start();
    await until(() => internals.watcher !== undefined);
    internals.watcher?.emit('error', new Error('boom'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('監視が止まりました'));

    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'x');
    const badLog = makeLog();
    const bad = track(new SessionHubReader(blocker, selfId, badLog));
    bad.start();
    await until(() => badLog.warn.mock.calls.some((c) => String(c[0]).includes('監視開始に失敗')));
    expect(bad.getOthers()).toEqual([]);
  });

  it('dispose()後は発火せず、監視も止まる', async () => {
    const { reader } = makeReader();
    const fired = vi.fn();
    reader.onDidChange(fired);
    reader.start();
    reader.dispose();
    const id = randomUUID();
    await putSessionFile(id, fileBody(id, [session('late')]));
    await realSleep(500);
    expect(fired).not.toHaveBeenCalled();
    expect(reader.getOthers()).toEqual([]);
  });

  it('1時間より古いsessionsのjsonとtmpだけを掃除する', async () => {
    const { reader, internals } = makeReader();
    const oldId = randomUUID();
    const freshId = randomUUID();
    const hour = 60 * 60 * 1000;
    await putSessionFile(oldId, fileBody(oldId, []), { ageMs: hour + 60_000 });
    await putSessionFile(freshId, fileBody(freshId, []));
    const oldTmp = path.join(root, 'sessions', `${oldId}.json.tmp-9`);
    const freshTmp = path.join(root, 'sessions', `${freshId}.json.tmp-9`);
    const unrelated = path.join(root, 'sessions', 'notes.txt');
    for (const f of [oldTmp, freshTmp, unrelated]) {
      await writeFile(f, 'x');
    }
    const past = new Date(Date.now() - hour - 60_000);
    await utimes(oldTmp, past, past);
    await utimes(unrelated, past, past);

    await internals.cleanupStaleSessionFiles();
    expect(await exists(sessionsPath(oldId))).toBe(false);
    expect(await exists(oldTmp)).toBe(false);
    expect(await exists(sessionsPath(freshId))).toBe(true);
    expect(await exists(freshTmp)).toBe(true);
    expect(await exists(unrelated)).toBe(true); // 無関係のファイルには触れない

    // ディレクトリが無くても落ちない。破棄後は何もしない
    await rm(path.join(root, 'sessions'), { recursive: true });
    await expect(internals.cleanupStaleSessionFiles()).resolves.toBeUndefined();
    reader.dispose();
    await expect(internals.cleanupStaleSessionFiles()).resolves.toBeUndefined();
  });
});

/** 要求ファイルを直接置く（受信側の読み取り口を試すため）。 */
async function putRequest(
  windowId: string,
  overrides: Record<string, unknown> = {},
  fileName?: string,
): Promise<{ requestId: string; file: string }> {
  const requestId = randomUUID();
  const dir = path.join(root, 'requests', windowId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName ?? `${requestId}.json`);
  const body = {
    requestId,
    kind: 'open',
    from: randomUUID(),
    issuedAt: Date.now(),
    provider: 'codex',
    threadId: 'thread-1',
    ...overrides,
  };
  await writeFile(
    file,
    typeof overrides.__raw === 'string' ? overrides.__raw : JSON.stringify(body),
  );
  return { requestId: String(body.requestId), file };
}

function replyPath(requestId: string): string {
  return path.join(root, 'replies', `${requestId}.json`);
}

describe('SessionHubRequestWatcher', () => {
  const target = randomUUID();

  function makeWatcher(
    onRequest: (
      r: SessionHubRequest,
    ) => Promise<SessionHubRequestOutcome> | SessionHubRequestOutcome,
    log: Logger = makeLog(),
  ) {
    return track(new SessionHubRequestWatcher(root, target, onRequest, log));
  }

  it('届いていた要求を実行し、結果を応答ファイルへ書いて要求を消す', async () => {
    const handler = vi.fn((): SessionHubRequestOutcome => ({
      ok: true,
      payload: { capturedAt: 1, turns: [] },
    }));
    const log = makeLog();
    const { requestId, file } = await putRequest(target, {
      kind: 'send',
      text: 'hello',
      approvalRequestId: 'ap-1',
      decision: 'accept',
      limit: 5,
      sideQuestionId: 'sq',
      handoffRequestId: 'hr',
      handoffDecision: 'repick',
      handoffModel: 'm',
      handoffEffort: 'e',
      ignoredExtra: 'zzz',
    });
    makeWatcher(handler, log).start();
    await until(() => exists(replyPath(requestId)));

    expect(handler).toHaveBeenCalledTimes(1);
    const req = (handler.mock.calls[0] as unknown as [SessionHubRequest])[0];
    expect(req).toMatchObject({
      requestId,
      kind: 'send',
      provider: 'codex',
      threadId: 'thread-1',
      text: 'hello',
      approvalRequestId: 'ap-1',
      decision: 'accept',
      limit: 5,
      sideQuestionId: 'sq',
      handoffRequestId: 'hr',
      handoffDecision: 'repick',
      handoffModel: 'm',
      handoffEffort: 'e',
    });
    expect(req).not.toHaveProperty('ignoredExtra');
    expect(await exists(file)).toBe(false);
    const reply = JSON.parse(await readFile(replyPath(requestId), 'utf8')) as SessionHubReply;
    expect(reply.requestId).toBe(requestId);
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({ capturedAt: 1, turns: [] });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('sendの要求を受け付けました'));
  });

  it('start後に置かれた要求もfs.watchで拾い、同期ハンドラの結果も返せる', async () => {
    const handler = vi.fn((): SessionHubRequestOutcome => ({ ok: false, error: 'nope' }));
    makeWatcher(handler).start();
    await realSleep(100); // 監視が張られるのを待つ
    const { requestId } = await putRequest(target, { kind: 'interrupt' });
    await until(() => exists(replyPath(requestId)));
    const reply = JSON.parse(await readFile(replyPath(requestId), 'utf8')) as SessionHubReply;
    expect(reply).toMatchObject({ requestId, ok: false, error: 'nope' });
  });

  it('ハンドラが例外を投げたらok:falseで応答する', async () => {
    const { requestId } = await putRequest(target, { kind: 'interrupt' });
    makeWatcher(() => Promise.reject(new Error('kaboom'))).start();
    await until(() => exists(replyPath(requestId)));
    const reply = JSON.parse(await readFile(replyPath(requestId), 'utf8')) as SessionHubReply;
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('kaboom');
  });

  it('期限切れ・壊れた・形の不正な要求は実行せず、要求ファイルは消す', async () => {
    const handler = vi.fn((): SessionHubRequestOutcome => ({ ok: true }));
    const log = makeLog();
    const expired = await putRequest(target, { issuedAt: Date.now() - 120_000 });
    const broken = await putRequest(target, { __raw: '{oops' });
    const unsafe = await putRequest(target, { requestId: '../escape' });
    const notObject = await putRequest(target, { __raw: '[]' });
    const badProvider = await putRequest(target, { provider: 'other' });
    const txt = path.join(root, 'requests', target, 'ignore.txt');
    await writeFile(txt, 'x');
    const valid = await putRequest(target, { kind: 'open' });

    makeWatcher(handler, log).start();
    await until(() => exists(replyPath(valid.requestId)));
    for (const bad of [expired, broken, unsafe, notObject, badProvider]) {
      await until(async () => !(await exists(bad.file)));
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as unknown as [SessionHubRequest])[0].requestId).toBe(
      valid.requestId,
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('期限切れの要求を捨てました'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('要求の解析に失敗'));
    expect(await exists(replyPath(expired.requestId))).toBe(false);
    expect(await exists(txt)).toBe(true);
  });

  it('応答ファイルを書けなくてもwarnで済ます', async () => {
    const log = makeLog();
    const { requestId, file } = await putRequest(target, { kind: 'open' });
    // 応答の置き場所をディレクトリで塞ぐ（renameがEISDIRで失敗する）
    await mkdir(replyPath(requestId), { recursive: true });
    makeWatcher(() => ({ ok: true }), log).start();
    await until(() =>
      log.warn.mock.calls.some((c) => String(c[0]).includes('応答の書き込みに失敗')),
    );
    expect(await exists(file)).toBe(false);
  });

  it('dispose()後に届いた要求は実行しない', async () => {
    const handler = vi.fn((): SessionHubRequestOutcome => ({ ok: true }));
    const watcher = makeWatcher(handler);
    watcher.start();
    await realSleep(100);
    watcher.dispose();
    const { file } = await putRequest(target, { kind: 'open' });
    await realSleep(300);
    expect(handler).not.toHaveBeenCalled();
    expect(await exists(file)).toBe(true);
  });

  it('取り残された要求・応答と、閉じたウィンドウ宛てのディレクトリを掃除する', async () => {
    const minute2 = 120_000;
    const old = new Date(Date.now() - minute2);
    const ownDir = path.join(root, 'requests', target);
    await mkdir(ownDir, { recursive: true });
    await mkdir(path.join(root, 'replies'), { recursive: true });
    const staleOwn = path.join(ownDir, 'stale.txt');
    const freshOwn = path.join(ownDir, 'fresh.txt');
    const staleReply = path.join(root, 'replies', 'stale.json');
    const freshReply = path.join(root, 'replies', 'fresh.json');
    for (const f of [staleOwn, freshOwn, staleReply, freshReply]) {
      await writeFile(f, 'x');
    }
    await utimes(staleOwn, old, old);
    await utimes(staleReply, old, old);

    const abandoned = path.join(root, 'requests', randomUUID());
    const mixed = path.join(root, 'requests', randomUUID());
    const empty = path.join(root, 'requests', randomUUID());
    for (const d of [abandoned, mixed, empty]) {
      await mkdir(d, { recursive: true });
    }
    await writeFile(path.join(abandoned, 'a.json'), 'x');
    await writeFile(path.join(abandoned, 'b.json'), 'x');
    await utimes(path.join(abandoned, 'a.json'), old, old);
    await utimes(path.join(abandoned, 'b.json'), old, old);
    await writeFile(path.join(mixed, 'old.json'), 'x');
    await writeFile(path.join(mixed, 'new.json'), 'x');
    await utimes(path.join(mixed, 'old.json'), old, old);

    makeWatcher(() => ({ ok: true })).start();
    await until(async () => !(await exists(abandoned)));

    expect(await exists(staleOwn)).toBe(false);
    expect(await exists(freshOwn)).toBe(true);
    expect(await exists(staleReply)).toBe(false);
    expect(await exists(freshReply)).toBe(true);
    expect(await exists(mixed)).toBe(true); // 新しい要求が残っているので消さない
    expect(await exists(empty)).toBe(true); // 空は消さない
    expect(await exists(ownDir)).toBe(true);
  });

  it('監視のerrorと、ディレクトリを作れない開始失敗はwarnに残す', async () => {
    const log = makeLog();
    const watcher = makeWatcher(() => ({ ok: true }), log);
    watcher.start();
    const internals = watcher as unknown as { watcher: FSWatcher | undefined };
    await until(() => internals.watcher !== undefined);
    internals.watcher?.emit('error', new Error('gone'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('要求の監視が止まりました'));

    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'x');
    const badLog = makeLog();
    track(new SessionHubRequestWatcher(blocker, target, () => ({ ok: true }), badLog)).start();
    await until(() => badLog.warn.mock.calls.some((c) => String(c[0]).includes('監視開始に失敗')));
  });
});

/**
 * 送信側が待っている応答を、任意の中身で返す（`parsePayload`等の読み取り口を試すため）。
 * 要求が置かれたら`build`が返す文字列をそのまま応答ファイルにする。
 */
function respondWith(
  windowId: string,
  build: (requestId: string) => string,
  opts: { garbageFirst?: boolean } = {},
): void {
  const dir = path.join(root, 'requests', windowId);
  void (async () => {
    for (let i = 0; i < 400; i += 1) {
      const names = await readdir(dir).catch(() => [] as string[]);
      const name = names.find((n) => n.endsWith('.json'));
      if (name !== undefined) {
        const requestId = name.slice(0, -'.json'.length);
        const file = replyPath(requestId);
        await mkdir(path.dirname(file), { recursive: true });
        if (opts.garbageFirst === true) {
          await writeFile(file, '{"requestId": 1}');
          await realSleep(200);
        }
        const tmp = `${file}.tmp-r`;
        await writeFile(tmp, build(requestId));
        await rename(tmp, file);
        return;
      }
      await realSleep(5);
    }
  })();
}

describe('SessionHubRequestPort', () => {
  const selfId = randomUUID();
  const target = randomUUID();

  function makePort(log: Logger = makeLog()) {
    return new SessionHubRequestPort(root, selfId, log);
  }

  it('宛先のwindowIdの形が不正なら要求を送らない', async () => {
    const log = makeLog();
    const reply = await makePort(log).request('../x', {
      kind: 'open',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('宛先のウィンドウを特定できません');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(await exists(path.join(root, 'requests'))).toBe(false);
  });

  it('要求ファイルを書けなければok:falseで返す', async () => {
    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'x');
    const log = makeLog();
    const reply = await new SessionHubRequestPort(blocker, selfId, log).request(target, {
      kind: 'open',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply).toMatchObject({ ok: false, error: '要求を送れませんでした' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('要求の送信に失敗しました（open）'),
    );
  });

  it('受信側と往復し、応答の中身を受け取って応答ファイルを消す', async () => {
    const handler = vi.fn((): SessionHubRequestOutcome => ({
      ok: true,
      payload: {
        approvals: [
          {
            requestId: 'ap-1',
            kind: 'commandExecution',
            title: 'run',
            detail: 'ls',
            paths: ['/a'],
            decidable: true,
          },
        ],
      },
    }));
    track(new SessionHubRequestWatcher(root, target, handler, makeLog())).start();
    const reply = await makePort().request(target, {
      kind: 'approvalDetail',
      provider: 'claude',
      threadId: 'thread-9',
      text: 'hi',
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload?.approvals).toEqual([
      {
        requestId: 'ap-1',
        kind: 'commandExecution',
        title: 'run',
        detail: 'ls',
        paths: ['/a'],
        decidable: true,
      },
    ]);
    const req = (handler.mock.calls[0] as unknown as [SessionHubRequest])[0];
    expect(req).toMatchObject({
      kind: 'approvalDetail',
      from: selfId,
      provider: 'claude',
      threadId: 'thread-9',
      text: 'hi',
    });
    expect(await exists(replyPath(reply.requestId))).toBe(false);
  });

  it('応答が無ければ5秒で打ち切り、要求ファイルを取り下げる', async () => {
    const reply = await makePort().request(target, {
      kind: 'interrupt',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('応答がありませんでした');
    expect(await readdir(path.join(root, 'requests', target))).toEqual([]);
  }, 15_000);

  it('読めない応答は無視して待ち続け、後から来た正しい応答を採る', async () => {
    respondWith(target, (requestId) => JSON.stringify({ requestId, ok: true, error: 'warned' }), {
      garbageFirst: true,
    });
    const reply = await makePort().request(target, {
      kind: 'open',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply).toMatchObject({ ok: true, error: 'warned' });
    expect(reply.payload).toBeUndefined();
  });

  it('脇道の質問の応答は長さを切り詰め、不正なstatusは捨てる', async () => {
    respondWith(target, (requestId) =>
      JSON.stringify({
        requestId,
        ok: true,
        payload: {
          sideQuestion: {
            id: 'q1',
            status: 'done',
            question: 'q'.repeat(3000),
            answer: 'a'.repeat(9000),
            error: 'e'.repeat(3000),
          },
        },
      }),
    );
    const reply = await makePort().request(target, {
      kind: 'sideQuestionResult',
      provider: 'codex',
      threadId: 't',
      sideQuestionId: 'q1',
    });
    const sq = reply.payload?.sideQuestion;
    expect(sq?.id).toBe('q1');
    expect(sq?.status).toBe('done');
    expect(sq?.question).toHaveLength(2000);
    expect(sq?.answer).toHaveLength(8000);
    expect(sq?.error).toHaveLength(2000);
  });

  it('脇道の質問の応答は不正なstatusならpayloadごと捨てる', async () => {
    respondWith(target, (requestId) =>
      JSON.stringify({
        requestId,
        ok: true,
        payload: { sideQuestion: { id: 'q2', status: 'weird', question: 'x' } },
      }),
    );
    const bad = await makePort().request(target, {
      kind: 'sideQuestion',
      provider: 'codex',
      threadId: 't',
    });
    expect(bad.ok).toBe(true);
    expect(bad.payload).toBeUndefined();
  });

  it('直近のやり取りは件数・文字数を上限で切り、形の合わない要素を落とす', async () => {
    const entries: unknown[] = [
      null,
      'str',
      { role: 'system', text: 'x' },
      { role: 'user', text: 5 },
      { role: 'user', text: 'u'.repeat(2500) },
      { role: 'agent', text: 'short', truncated: true },
      { role: 'agent', text: 'plain' },
    ];
    for (let i = 0; i < 50; i += 1) {
      entries.push({ role: 'user', text: `n${i}` });
    }
    respondWith(target, (requestId) =>
      JSON.stringify({ requestId, ok: true, payload: { turns: entries, capturedAt: 123 } }),
    );
    const reply = await makePort().request(target, {
      kind: 'recentTurns',
      provider: 'codex',
      threadId: 't',
      limit: 10,
    });
    const turns = reply.payload?.turns ?? [];
    expect(turns).toHaveLength(40);
    expect(turns[0]).toEqual({ role: 'user', text: 'u'.repeat(2000), truncated: true });
    expect(turns[1]).toEqual({ role: 'agent', text: 'short', truncated: true });
    expect(turns[2]).toEqual({ role: 'agent', text: 'plain', truncated: false });
    expect(reply.payload?.capturedAt).toBe(123);
  });

  it('turnsのcapturedAtが数値でなければ省く', async () => {
    respondWith(target, (requestId) =>
      JSON.stringify({ requestId, ok: true, payload: { turns: [], capturedAt: 'now' } }),
    );
    const reply = await makePort().request(target, {
      kind: 'recentTurns',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply.payload).toEqual({ turns: [], capturedAt: undefined });
  });

  it('引き継ぎ確認の応答は理由・候補を上限で切り、既定値へ倒す', async () => {
    const reasons: unknown[] = [1, null];
    for (let i = 0; i < 50; i += 1) {
      reasons.push(`r${i}`);
    }
    reasons.push('z'.repeat(3000));
    const models: unknown[] = [
      null,
      { label: 'no slug' },
      { slug: 'a', label: 'A', efforts: ['low', 3] },
    ];
    models.push({ slug: 'b', label: '' });
    models.push({ slug: 'c', efforts: 'nope' });
    for (let i = 0; i < 120; i += 1) {
      models.push({ slug: `m${i}` });
    }
    respondWith(target, (requestId) =>
      JSON.stringify({
        requestId,
        ok: true,
        payload: { handoff: { requestId: 'h1', model: 'gpt', reasons, models } },
      }),
    );
    const reply = await makePort().request(target, {
      kind: 'handoffDetail',
      provider: 'codex',
      threadId: 't',
    });
    const handoff = reply.payload?.handoff;
    expect(handoff).toMatchObject({
      requestId: 'h1',
      model: 'gpt',
      effort: '',
      trigger: '',
      canReclassify: false,
    });
    expect(handoff?.reasons).toHaveLength(40);
    expect(handoff?.reasons[0]).toBe('r0');
    expect(handoff?.models).toHaveLength(100);
    expect(handoff?.models.slice(0, 3)).toEqual([
      { slug: 'a', label: 'A', efforts: ['low'] },
      { slug: 'b', label: 'b', efforts: [] },
      { slug: 'c', label: 'c', efforts: [] },
    ]);
  });

  it('引き継ぎ確認の長い理由は切り詰め、effort・trigger・canReclassifyは読める', async () => {
    respondWith(target, (requestId) =>
      JSON.stringify({
        requestId,
        ok: true,
        payload: {
          handoff: {
            requestId: 'h2',
            model: '',
            effort: 'high',
            trigger: 'ctx',
            canReclassify: true,
            reasons: ['z'.repeat(3000)],
            models: 'not-array',
          },
        },
      }),
    );
    const reply = await makePort().request(target, {
      kind: 'handoffDetail',
      provider: 'codex',
      threadId: 't',
    });
    const handoff = reply.payload?.handoff;
    expect(handoff?.effort).toBe('high');
    expect(handoff?.trigger).toBe('ctx');
    expect(handoff?.canReclassify).toBe(true);
    expect(handoff?.reasons[0]).toHaveLength(2000);
    expect(handoff?.models).toEqual([]);
  });

  it('必須項目の欠けた引き継ぎ確認はpayloadごと捨てる', async () => {
    respondWith(target, (requestId) =>
      JSON.stringify({ requestId, ok: true, payload: { handoff: { requestId: 'h3' } } }),
    );
    const reply = await makePort().request(target, {
      kind: 'handoffDetail',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply.ok).toBe(true);
    expect(reply.payload).toBeUndefined();
  });

  it('承認待ちの応答は読めない要素を落とし、decidableはtrueのときだけ許す', async () => {
    respondWith(target, (requestId) =>
      JSON.stringify({
        requestId,
        ok: true,
        payload: {
          approvals: [
            null,
            { requestId: 1, kind: 'x' },
            { requestId: 'a', kind: 7 },
            {
              requestId: 'b',
              kind: 'fileChange',
              paths: ['/p', 3],
              title: 't',
              detail: 'd',
              decidable: 'yes',
            },
            { requestId: 'c', kind: 'commandExecution', decidable: true },
          ],
        },
      }),
    );
    const reply = await makePort().request(target, {
      kind: 'approvalDetail',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply.payload?.approvals).toEqual([
      {
        requestId: 'b',
        kind: 'fileChange',
        title: 't',
        detail: 'd',
        paths: ['/p'],
        decidable: false,
      },
      {
        requestId: 'c',
        kind: 'commandExecution',
        title: '',
        detail: '',
        paths: [],
        decidable: true,
      },
    ]);
  });

  it('payloadが無い・形が合わない応答はpayloadなしで返す', async () => {
    respondWith(target, (requestId) =>
      JSON.stringify({ requestId, ok: false, error: 'denied', payload: { approvals: 'nope' } }),
    );
    const reply = await makePort().request(target, {
      kind: 'approvalDetail',
      provider: 'codex',
      threadId: 't',
    });
    expect(reply).toMatchObject({ ok: false, error: 'denied' });
    expect(reply.payload).toBeUndefined();
  });
});
