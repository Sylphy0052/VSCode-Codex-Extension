import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_LEASE_STALE_MS,
  TaskRunLeaseManager,
  computeHostIdentity,
  formatTaskRunLeaseHolder,
  formatTaskRunLeaseRejection,
  isProcessAlive,
  isTaskRunLeaseStale,
  judgeTaskRunLease,
  parseTaskRunLease,
  taskRunLeaseFileName,
  type TaskLeaseOwner,
  type TaskRunLease,
  type TaskRunLeaseManagerDeps,
} from '../../src/orchestrator/taskRunLease';

const BASE_MS = Date.parse('2026-10-03T00:00:00.000Z');
const RUN_ID = 'run-1';

const SELF: TaskLeaseOwner = {
  windowId: 'win-self-0001',
  hostname: 'host-a',
  hostIdentity: 'id-a',
  pid: 1000,
};

function makeLease(over: Partial<TaskRunLease> = {}): TaskRunLease {
  const iso = new Date(BASE_MS).toISOString();
  return {
    version: 1,
    windowId: 'win-other-0001',
    runId: RUN_ID,
    hostname: 'host-b',
    hostIdentity: 'id-b',
    pid: 2000,
    acquiredAt: iso,
    heartbeatAt: iso,
    ...over,
  };
}

describe('parseTaskRunLease', () => {
  it('正しい形のJSONを読める', () => {
    const lease = makeLease();
    expect(parseTaskRunLease(JSON.stringify(lease))).toEqual(lease);
  });

  it('hostIdentityが無い古い形式は空文字として読む', () => {
    const legacy: Partial<TaskRunLease> = makeLease();
    delete legacy.hostIdentity;
    expect(parseTaskRunLease(JSON.stringify(legacy))?.hostIdentity).toBe('');
  });

  it.each([
    ['JSONではない', 'not json'],
    ['null', 'null'],
    ['配列でも版が違う', '[]'],
    ['版が違う', JSON.stringify({ ...makeLease(), version: 2 })],
    ['windowIdが文字列ではない', JSON.stringify({ ...makeLease(), windowId: 1 })],
    ['runIdが文字列ではない', JSON.stringify({ ...makeLease(), runId: null })],
    ['hostnameが文字列ではない', JSON.stringify({ ...makeLease(), hostname: 1 })],
    ['pidが文字列', JSON.stringify({ ...makeLease(), pid: '1' })],
    ['pidが小数', JSON.stringify({ ...makeLease(), pid: 1.5 })],
    ['pidが巨大値', JSON.stringify({ ...makeLease(), pid: 1e20 })],
    ['acquiredAtが文字列ではない', JSON.stringify({ ...makeLease(), acquiredAt: 1 })],
    ['heartbeatAtが文字列ではない', JSON.stringify({ ...makeLease(), heartbeatAt: 1 })],
  ])('%sものはundefined', (_name, text) => {
    expect(parseTaskRunLease(text)).toBeUndefined();
  });
});

describe('isTaskRunLeaseStale', () => {
  const now = new Date(BASE_MS);
  const alive = (): boolean => true;
  const dead = (): boolean => false;

  it('heartbeatが新しく別ホストなら失効していない', () => {
    expect(isTaskRunLeaseStale(makeLease(), SELF, now, dead)).toBe(false);
  });

  it('heartbeatがstaleMs以上古ければ失効', () => {
    const lease = makeLease({
      heartbeatAt: new Date(BASE_MS - TASK_LEASE_STALE_MS).toISOString(),
    });
    expect(isTaskRunLeaseStale(lease, SELF, now, alive)).toBe(true);
  });

  it('heartbeatの時刻が読めなければ失効', () => {
    expect(isTaskRunLeaseStale(makeLease({ heartbeatAt: 'xx' }), SELF, now, alive)).toBe(true);
  });

  it('自分の時計で観測した変化なし時間がstaleMs以上なら、heartbeatが未来でも失効', () => {
    const future = makeLease({ heartbeatAt: new Date(BASE_MS + 10 * 60_000).toISOString() });
    expect(isTaskRunLeaseStale(future, SELF, now, alive)).toBe(false);
    expect(
      isTaskRunLeaseStale(future, SELF, now, alive, TASK_LEASE_STALE_MS, {
        unchangedMs: TASK_LEASE_STALE_MS,
      }),
    ).toBe(true);
  });

  it('同じホストでPIDが死んでいれば、heartbeatが新しくても失効', () => {
    const lease = makeLease({ hostname: SELF.hostname, hostIdentity: SELF.hostIdentity });
    expect(isTaskRunLeaseStale(lease, SELF, now, dead)).toBe(true);
    expect(isTaskRunLeaseStale(lease, SELF, now, alive)).toBe(false);
  });

  it('PIDが0以下なら生死を確かめず失効としない', () => {
    const lease = makeLease({ hostname: SELF.hostname, hostIdentity: '', pid: 0 });
    expect(isTaskRunLeaseStale(lease, SELF, now, dead)).toBe(false);
  });

  it('同じhostnameでもhostIdentityが両方読めて違えば、PIDで失効としない', () => {
    const lease = makeLease({ hostname: SELF.hostname, hostIdentity: 'id-other' });
    expect(isTaskRunLeaseStale(lease, SELF, now, dead)).toBe(false);
  });

  it('hostIdentityの片方が空なら、同じホストとしてPIDで判定する', () => {
    const lease = makeLease({ hostname: SELF.hostname, hostIdentity: '' });
    expect(isTaskRunLeaseStale(lease, SELF, now, dead)).toBe(true);
    const self = { hostname: SELF.hostname, hostIdentity: '' };
    const other = makeLease({ hostname: SELF.hostname, hostIdentity: 'id-other' });
    expect(isTaskRunLeaseStale(other, self, now, dead)).toBe(true);
  });
});

describe('judgeTaskRunLease', () => {
  const now = new Date(BASE_MS);
  const dead = (): boolean => false;

  it('既存が無ければfree', () => {
    expect(judgeTaskRunLease(undefined, SELF, now, dead)).toBe('free');
  });

  it('自分のもので新しければown', () => {
    const lease = makeLease({ windowId: SELF.windowId });
    expect(judgeTaskRunLease(lease, SELF, now, dead)).toBe('own');
  });

  it('自分のものでもheartbeatがstaleMsの半分以上止まっていればstale', () => {
    const lease = makeLease({
      windowId: SELF.windowId,
      heartbeatAt: new Date(BASE_MS - TASK_LEASE_STALE_MS / 2).toISOString(),
    });
    expect(judgeTaskRunLease(lease, SELF, now, dead)).toBe('stale');
  });

  it('他のウィンドウで新しければbusy、古ければstale', () => {
    expect(judgeTaskRunLease(makeLease(), SELF, now, dead)).toBe('busy');
    const old = makeLease({ heartbeatAt: new Date(BASE_MS - 120_000).toISOString() });
    expect(judgeTaskRunLease(old, SELF, now, dead)).toBe('stale');
  });
});

describe('taskRunLeaseFileName', () => {
  it('runIdから決まる32桁の16進＋.jsonになり、runIdを含まない', () => {
    const name = taskRunLeaseFileName(RUN_ID);
    expect(name).toMatch(/^[0-9a-f]{32}\.json$/u);
    expect(name).not.toContain(RUN_ID);
    expect(taskRunLeaseFileName(RUN_ID)).toBe(name);
    expect(taskRunLeaseFileName('run-2')).not.toBe(name);
  });
});

describe('formatTaskRunLeaseHolder / formatTaskRunLeaseRejection', () => {
  const now = new Date(BASE_MS + 12_000);

  it('持ち主が分からなければ汎用の表現', () => {
    expect(formatTaskRunLeaseHolder(undefined, now)).toBe('別のウィンドウ');
  });

  it('ホスト・PID・ウィンドウ・最終応答を並べる', () => {
    const text = formatTaskRunLeaseHolder(makeLease({ windowId: '12345678abcdef' }), now);
    expect(text).toBe(
      '別のウィンドウ（ホスト host-b、PID 2000、ウィンドウ 12345678、最終応答 12秒前）',
    );
  });

  it('hostnameが空ならホスト不明、PIDが0以下なら省略、windowIdが空なら省略する', () => {
    const text = formatTaskRunLeaseHolder(makeLease({ hostname: '', pid: 0, windowId: '' }), now);
    expect(text).toBe('別のウィンドウ（ホスト 不明、最終応答 12秒前）');
  });

  it('heartbeatの時刻が読めなければ最終応答を出さない', () => {
    const text = formatTaskRunLeaseHolder(makeLease({ heartbeatAt: 'xx' }), now);
    expect(text).not.toContain('最終応答');
  });

  it('heartbeatが未来でも負の秒数を出さない', () => {
    const text = formatTaskRunLeaseHolder(
      makeLease({ heartbeatAt: new Date(BASE_MS + 60_000).toISOString() }),
      now,
    );
    expect(text).toContain('最終応答 0秒前');
  });

  it('制御文字を除き、長すぎるhostnameを切り詰める', () => {
    const text = formatTaskRunLeaseHolder(makeLease({ hostname: `a\nb${'x'.repeat(100)}` }), now);
    expect(text).not.toContain('\n');
    expect(text).toContain('…');
  });

  it('拒否文に持ち主と失効秒数を含む', () => {
    const text = formatTaskRunLeaseRejection(makeLease(), now);
    expect(text).toContain('別のウィンドウ（ホスト host-b');
    expect(text).toContain('60秒途絶えてから');
    expect(text).toContain('専有権を移す');
  });
});

describe('isProcessAlive / computeHostIdentity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('自プロセスは生きている', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('ESRCHは死んでいる、EPERMは生きている、その他のエラーは死んでいる扱い', () => {
    const spy = vi.spyOn(process, 'kill');
    spy.mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'ESRCH' });
    });
    expect(isProcessAlive(1)).toBe(false);
    spy.mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'EPERM' });
    });
    expect(isProcessAlive(1)).toBe(true);
    spy.mockImplementation(() => {
      throw new Error('コードなし');
    });
    expect(isProcessAlive(1)).toBe(false);
  });

  it('hostIdentityは空文字か「boot_id:pid名前空間」', () => {
    const id = computeHostIdentity();
    expect(id === '' || id.includes(':')).toBe(true);
  });
});

describe('TaskRunLeaseManager', () => {
  let root: string;
  let dir: string;
  let nowMs: number;
  let aliveByPid: Map<number, boolean>;
  let onLost: ReturnType<typeof vi.fn<(runId: string, holder: TaskRunLease | undefined) => void>>;
  let log: ReturnType<typeof vi.fn<(message: string) => void>>;
  const managers: TaskRunLeaseManager[] = [];

  function makeManager(
    over: Partial<TaskRunLeaseManagerDeps> = {},
    owner: TaskLeaseOwner = SELF,
  ): TaskRunLeaseManager {
    const manager = new TaskRunLeaseManager({
      dir,
      owner,
      onLost,
      log,
      now: () => new Date(nowMs),
      isPidAlive: (pid) => aliveByPid.get(pid) ?? true,
      heartbeatMs: 1000,
      ...over,
    });
    managers.push(manager);
    return manager;
  }

  function leaseFile(runId = RUN_ID): string {
    return path.join(dir, taskRunLeaseFileName(runId));
  }

  function writeLease(lease: TaskRunLease, runId = RUN_ID): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(leaseFile(runId), JSON.stringify(lease), 'utf8');
  }

  function readLeaseFile(runId = RUN_ID): TaskRunLease | undefined {
    return parseTaskRunLease(fs.readFileSync(leaseFile(runId), 'utf8'));
  }

  function isoAt(offsetMs: number): string {
    return new Date(nowMs + offsetMs).toISOString();
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-run-lease-'));
    dir = path.join(root, 'leases');
    nowMs = BASE_MS;
    aliveByPid = new Map();
    onLost = vi.fn();
    log = vi.fn();
  });

  afterEach(() => {
    for (const m of managers.splice(0)) {
      m.dispose();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('acquire', () => {
    it('誰も持っていなければ取れて、ファイルに自分の情報が書かれる', async () => {
      const manager = makeManager();
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
      expect(manager.holds(RUN_ID)).toBe(true);
      expect(readLeaseFile()).toEqual({
        version: 1,
        windowId: SELF.windowId,
        runId: RUN_ID,
        hostname: SELF.hostname,
        hostIdentity: SELF.hostIdentity,
        pid: SELF.pid,
        acquiredAt: isoAt(0),
        heartbeatAt: isoAt(0),
      });
      expect(await manager.peek(RUN_ID)).toEqual(readLeaseFile());
    });

    it('取得後に一時ファイルが残らない', async () => {
      await makeManager().acquire(RUN_ID);
      expect(fs.readdirSync(dir)).toEqual([taskRunLeaseFileName(RUN_ID)]);
    });

    it('自分が持っているものを再度取るとheartbeatを更新して取れる', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      nowMs += 5000;
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
      const lease = readLeaseFile();
      expect(lease?.heartbeatAt).toBe(isoAt(0));
      expect(lease?.acquiredAt).toBe(new Date(BASE_MS + 5000).toISOString());
    });

    it('別のウィンドウが新しく持っていればbusyで持ち主を返し、ファイルは変えない', async () => {
      const other = makeLease({ heartbeatAt: isoAt(-1000) });
      writeLease(other);
      const manager = makeManager();
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: false, holder: other });
      expect(manager.holds(RUN_ID)).toBe(false);
      expect(readLeaseFile()).toEqual(other);
    });

    it('別のウィンドウのheartbeatが失効していれば取り直せる', async () => {
      writeLease(makeLease({ heartbeatAt: isoAt(-TASK_LEASE_STALE_MS) }));
      const manager = makeManager();
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
      expect(readLeaseFile()?.windowId).toBe(SELF.windowId);
      expect(fs.readdirSync(dir)).toEqual([taskRunLeaseFileName(RUN_ID)]);
    });

    it('staleMsを短く指定すると、その長さで失効を判定する', async () => {
      writeLease(makeLease({ heartbeatAt: isoAt(-2000) }));
      const manager = makeManager({ staleMs: 1000 });
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
    });

    it('同じホストで持ち主のPIDが死んでいれば、heartbeatが新しくても取り直せる', async () => {
      writeLease(
        makeLease({ hostname: SELF.hostname, hostIdentity: SELF.hostIdentity, pid: 4242 }),
      );
      aliveByPid.set(4242, false);
      const manager = makeManager();
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
    });

    it('同じホストでも持ち主のPIDが生きていればbusy', async () => {
      writeLease(
        makeLease({ hostname: SELF.hostname, hostIdentity: SELF.hostIdentity, pid: 4242 }),
      );
      aliveByPid.set(4242, true);
      const manager = makeManager();
      expect((await manager.acquire(RUN_ID)).ok).toBe(false);
    });

    it('別ホストのPIDが死んでいても、heartbeatが新しければbusy', async () => {
      writeLease(makeLease({ pid: 4242 }));
      aliveByPid.set(4242, false);
      const manager = makeManager();
      expect((await manager.acquire(RUN_ID)).ok).toBe(false);
    });

    it('持ち主の時計が進んでheartbeatが未来でも、変化が止まったまま時間が経てば取れる', async () => {
      writeLease(makeLease({ heartbeatAt: isoAt(10 * 60_000) }));
      const manager = makeManager();
      expect((await manager.acquire(RUN_ID)).ok).toBe(false);
      nowMs += 30_000;
      expect((await manager.acquire(RUN_ID)).ok).toBe(false);
      nowMs += 30_000;
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
      expect(readLeaseFile()?.windowId).toBe(SELF.windowId);
    });

    it('観測中に中身が変われば、変化なし時間を数え直す', async () => {
      writeLease(makeLease({ heartbeatAt: isoAt(10 * 60_000) }));
      const manager = makeManager();
      expect((await manager.acquire(RUN_ID)).ok).toBe(false);
      nowMs += 50_000;
      writeLease(makeLease({ heartbeatAt: isoAt(10 * 60_000 + 1) }));
      expect((await manager.acquire(RUN_ID)).ok).toBe(false);
      nowMs += 50_000;
      expect((await manager.acquire(RUN_ID)).ok).toBe(false);
    });

    it('壊れたファイルは更新時刻をheartbeatとみなし、新しければbusy（持ち主不明）', async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(leaseFile(), 'broken', 'utf8');
      fs.utimesSync(leaseFile(), new Date(nowMs), new Date(nowMs));
      const manager = makeManager();
      const outcome = await manager.acquire(RUN_ID);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.holder?.windowId).toBe('');
        expect(outcome.holder?.pid).toBe(0);
      }
      expect(fs.readFileSync(leaseFile(), 'utf8')).toBe('broken');
    });

    it('壊れたファイルの更新時刻が古ければ取り直せる', async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(leaseFile(), 'broken', 'utf8');
      const old = new Date(nowMs - 120_000);
      fs.utimesSync(leaseFile(), old, old);
      const manager = makeManager();
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
      expect(readLeaseFile()?.windowId).toBe(SELF.windowId);
    });

    it('runIdが違えば別のファイルで独立に取れる', async () => {
      writeLease(makeLease());
      const manager = makeManager();
      await expect(manager.acquire('run-2')).resolves.toEqual({ ok: true });
      expect(manager.holds('run-2')).toBe(true);
      expect(manager.holds(RUN_ID)).toBe(false);
    });

    it('同時に取りにいく2つのウィンドウのうち、取れるのは1つだけ', async () => {
      const a = makeManager({}, SELF);
      const b = makeManager({}, { ...SELF, windowId: 'win-self-0002', hostname: 'host-b', pid: 1 });
      const [ra, rb] = await Promise.all([a.acquire(RUN_ID), b.acquire(RUN_ID)]);
      expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
      expect(fs.readdirSync(dir)).toEqual([taskRunLeaseFileName(RUN_ID)]);
    });

    it('置き場がファイルで作れなければ例外を投げる', async () => {
      fs.writeFileSync(dir, 'x', 'utf8');
      await expect(makeManager().acquire(RUN_ID)).rejects.toThrow();
    });

    it('失効と判定した後に別のウィンドウが取り直していたら、退避を元へ戻して諦める', async () => {
      aliveByPid.set(3000, false);
      aliveByPid.set(3001, true);
      const replacement = makeLease({ windowId: 'win-c1', pid: 3001, hostname: SELF.hostname });
      let replaced = false;
      const manager = makeManager({
        isPidAlive: (pid) => {
          if (pid === 3000 && !replaced) {
            replaced = true;
            writeLease(replacement);
          }
          return aliveByPid.get(pid) ?? true;
        },
      });
      // 同じホストの持ち主にして、PID判定（失効の判定）に入らせる
      writeLease(
        makeLease({ windowId: 'win-c0', pid: 3000, hostname: SELF.hostname, hostIdentity: 'id-a' }),
      );
      const outcome = await manager.acquire(RUN_ID);
      expect(outcome.ok).toBe(false);
      expect(readLeaseFile()?.windowId).toBe('win-c1');
      expect(fs.readdirSync(dir)).toEqual([taskRunLeaseFileName(RUN_ID)]);
    });

    it('判定と退避の間に持ち主のファイルが消えていても、そのまま作り直して取れる', async () => {
      writeLease(
        makeLease({ windowId: 'win-c0', pid: 3000, hostname: SELF.hostname, hostIdentity: 'id-a' }),
      );
      const manager = makeManager({
        isPidAlive: () => {
          fs.rmSync(leaseFile());
          return false;
        },
      });
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
      expect(readLeaseFile()?.windowId).toBe(SELF.windowId);
    });

    it('取り合いが続いて試行の上限に達したら、最後に読んだ持ち主を返して諦める', async () => {
      let n = 0;
      const next = (): TaskRunLease =>
        makeLease({
          windowId: `win-c${String(n++)}`,
          pid: 3000 + n,
          hostname: SELF.hostname,
          hostIdentity: 'id-a',
        });
      writeLease(next());
      const manager = makeManager({
        isPidAlive: () => {
          writeLease(next());
          return false;
        },
      });
      const outcome = await manager.acquire(RUN_ID);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.holder?.windowId).toBe('win-c2');
      }
      expect(manager.holds(RUN_ID)).toBe(false);
    });

    it('dispose済みなら取れず、ファイルも作らない', async () => {
      const manager = makeManager();
      manager.dispose();
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: false, holder: undefined });
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('取得の途中でdisposeされたら、作ったファイルを消して取れなかった扱いにする', async () => {
      const manager = makeManager();
      const pending = manager.acquire(RUN_ID);
      manager.dispose();
      await expect(pending).resolves.toEqual({ ok: false, holder: undefined });
      expect(fs.existsSync(leaseFile())).toBe(false);
      expect(manager.holds(RUN_ID)).toBe(false);
    });
  });

  describe('forceAcquire', () => {
    it('別のウィンドウが生きて持っていても奪え、元の持ち主はheartbeatでonLostに気づく', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const owner = makeManager();
      await owner.acquire(RUN_ID);
      const thief = makeManager({}, { ...SELF, windowId: 'win-thief-001', pid: 1001 });
      await thief.forceAcquire(RUN_ID);
      expect(thief.holds(RUN_ID)).toBe(true);
      expect(readLeaseFile()?.windowId).toBe('win-thief-001');
      expect(fs.readdirSync(dir)).toEqual([taskRunLeaseFileName(RUN_ID)]);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(onLost).toHaveBeenCalled();
      });
      expect(onLost.mock.calls[0]?.[0]).toBe(RUN_ID);
      expect(onLost.mock.calls[0]?.[1]?.windowId).toBe('win-thief-001');
      expect(owner.holds(RUN_ID)).toBe(false);
    });

    it('誰も持っていなくても取れる', async () => {
      const manager = makeManager();
      await manager.forceAcquire(RUN_ID);
      expect(manager.holds(RUN_ID)).toBe(true);
      expect(readLeaseFile()?.windowId).toBe(SELF.windowId);
    });

    it('dispose済みなら何もしない', async () => {
      const manager = makeManager();
      manager.dispose();
      await manager.forceAcquire(RUN_ID);
      expect(manager.holds(RUN_ID)).toBe(false);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('奪っている途中でdisposeされたら、作ったファイルを消す', async () => {
      const manager = makeManager();
      const pending = manager.forceAcquire(RUN_ID);
      manager.dispose();
      await pending;
      expect(fs.existsSync(leaseFile())).toBe(false);
      expect(manager.holds(RUN_ID)).toBe(false);
    });
  });

  describe('peek', () => {
    it('ファイルが無ければundefined', async () => {
      expect(await makeManager().peek(RUN_ID)).toBeUndefined();
    });

    it('持っていなくても他のウィンドウの専有権を読める', async () => {
      const other = makeLease();
      writeLease(other);
      expect(await makeManager().peek(RUN_ID)).toEqual(other);
    });

    it('読めないファイル（ディレクトリ）は例外を投げる', async () => {
      fs.mkdirSync(leaseFile(), { recursive: true });
      await expect(makeManager().peek(RUN_ID)).rejects.toThrow();
    });
  });

  describe('release', () => {
    it('自分のファイルを消して、持っていない状態になる', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      await manager.release(RUN_ID);
      expect(manager.holds(RUN_ID)).toBe(false);
      expect(fs.existsSync(leaseFile())).toBe(false);
    });

    it('持っていないrunの解放は何もしない', async () => {
      const other = makeLease();
      writeLease(other);
      await makeManager().release(RUN_ID);
      expect(readLeaseFile()).toEqual(other);
    });

    it('別のウィンドウのものに替わっていたら、ファイルは消さない', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      const other = makeLease();
      writeLease(other);
      await manager.release(RUN_ID);
      expect(manager.holds(RUN_ID)).toBe(false);
      expect(readLeaseFile()).toEqual(other);
    });

    it('解放後にまた取れる', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      await manager.release(RUN_ID);
      await expect(manager.acquire(RUN_ID)).resolves.toEqual({ ok: true });
    });

    it('最後の専有権を手放すとheartbeatのタイマーも止まる', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      await manager.acquire('run-2');
      expect(vi.getTimerCount()).toBe(1);
      await manager.release(RUN_ID);
      expect(vi.getTimerCount()).toBe(1);
      await manager.release('run-2');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('dispose', () => {
    it('持っている専有権のファイルを同期的に消し、タイマーも止める', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      manager.dispose();
      expect(fs.existsSync(leaseFile())).toBe(false);
      expect(manager.holds(RUN_ID)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('別のウィンドウのものに替わっていたら消さない', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      const other = makeLease();
      writeLease(other);
      manager.dispose();
      expect(readLeaseFile()).toEqual(other);
    });

    it('ファイルが既に無ければ失敗をログに残して続行する', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      fs.rmSync(leaseFile());
      manager.dispose();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toContain(RUN_ID);
    });

    it('何も持っていなくても例外にならず、2回呼んでもよい', () => {
      const manager = makeManager();
      manager.dispose();
      expect(() => {
        manager.dispose();
      }).not.toThrow();
    });
  });

  describe('一時ファイルの掃除', () => {
    it('取得時に、更新が古い取り残しだけを消す', async () => {
      fs.mkdirSync(dir, { recursive: true });
      const hex = 'a'.repeat(32);
      const oldTmp = path.join(dir, `${hex}.json.tmp-win-x-0`);
      const oldStale = path.join(dir, `${hex}.json.stale-win-x-1`);
      const freshTmp = path.join(dir, `${hex}.json.tmp-win-x-2`);
      const unrelated = path.join(dir, 'memo.txt');
      for (const f of [oldTmp, oldStale, freshTmp, unrelated]) {
        fs.writeFileSync(f, 'x', 'utf8');
      }
      const old = new Date(nowMs - 120_000);
      for (const f of [oldTmp, oldStale, unrelated]) {
        fs.utimesSync(f, old, old);
      }
      fs.utimesSync(freshTmp, new Date(nowMs), new Date(nowMs));

      await makeManager().acquire(RUN_ID);

      expect(fs.existsSync(oldTmp)).toBe(false);
      expect(fs.existsSync(oldStale)).toBe(false);
      expect(fs.existsSync(freshTmp)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    it('一定間隔でheartbeatAtを書き直し、acquiredAtは保つ', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      nowMs += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(readLeaseFile()?.heartbeatAt).toBe(isoAt(0));
      });
      expect(readLeaseFile()?.acquiredAt).toBe(new Date(BASE_MS).toISOString());
      expect(manager.holds(RUN_ID)).toBe(true);
      expect(onLost).not.toHaveBeenCalled();
    });

    it('別のウィンドウのものに替わっていたら手放してonLostで持ち主を知らせる', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      const other = makeLease({ heartbeatAt: isoAt(0) });
      writeLease(other);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(onLost).toHaveBeenCalledWith(RUN_ID, other);
      });
      expect(manager.holds(RUN_ID)).toBe(false);
      expect(readLeaseFile()).toEqual(other);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ファイルが消えていたら取り直す', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      fs.rmSync(leaseFile());
      nowMs += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(fs.existsSync(leaseFile())).toBe(true);
      });
      expect(readLeaseFile()?.windowId).toBe(SELF.windowId);
      expect(manager.holds(RUN_ID)).toBe(true);
      expect(onLost).not.toHaveBeenCalled();
    });

    it('自分のものでも失効間際まで止まっていたら、失効扱いで取り直して持ち続ける', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      nowMs += TASK_LEASE_STALE_MS / 2 + 1;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(readLeaseFile()?.heartbeatAt).toBe(isoAt(0));
      });
      expect(manager.holds(RUN_ID)).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([taskRunLeaseFileName(RUN_ID)]);
      expect(onLost).not.toHaveBeenCalled();
    });

    it('読めない状態が続いても、staleMs経つまでは持ち続け、超えたらonLostで手放す', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      // ファイルをディレクトリに替えて、読むたびに失敗させる
      fs.rmSync(leaseFile());
      fs.mkdirSync(leaseFile());

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledTimes(1);
      });
      expect(log.mock.calls[0]?.[0]).toContain(RUN_ID);
      expect(manager.holds(RUN_ID)).toBe(true);
      expect(onLost).not.toHaveBeenCalled();

      nowMs += TASK_LEASE_STALE_MS;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(onLost).toHaveBeenCalledWith(RUN_ID, undefined);
      });
      expect(manager.holds(RUN_ID)).toBe(false);
    });

    it('1件が失敗しても、残りの専有権のheartbeatは続ける', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      await manager.acquire('run-2');
      fs.rmSync(leaseFile());
      fs.mkdirSync(leaseFile());
      nowMs += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(readLeaseFile('run-2')?.heartbeatAt).toBe(isoAt(0));
      });
      expect(log).toHaveBeenCalled();
    });

    it('disposeした後はheartbeatを書き直さない', async () => {
      const manager = makeManager();
      await manager.acquire(RUN_ID);
      manager.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fs.existsSync(leaseFile())).toBe(false);
    });
  });
});
