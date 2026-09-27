import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoadmapRunController } from '../../src/orchestrator/roadmapRunController';
import {
  formatRoadmapLeaseRejection,
  isRoadmapRunLeaseStale,
  judgeRoadmapRunLease,
  normalizeRepoIdentity,
  parseRoadmapRunLease,
  RoadmapRunLeaseManager,
  roadmapLeaseFileName,
  ROADMAP_LEASE_STALE_MS,
  type RoadmapLeaseOwner,
  type RoadmapRunLease,
  type RoadmapRunLeaseManagerDeps,
} from '../../src/orchestrator/roadmapRunLease';
import type { RoadmapRun } from '../../src/orchestrator/roadmapRunState';

const T0 = new Date('2026-09-27T00:00:00.000Z');
const alive = (): boolean => true;
const dead = (): boolean => false;

function lease(overrides: Partial<RoadmapRunLease> = {}): RoadmapRunLease {
  return {
    version: 1,
    windowId: 'window-a',
    runId: 'run-1',
    roadmapIssueNumber: 1457,
    hostname: 'host-a',
    hostIdentity: '',
    pid: 100,
    acquiredAt: T0.toISOString(),
    heartbeatAt: T0.toISOString(),
    ...overrides,
  };
}

function after(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

const ownerB: RoadmapLeaseOwner = {
  windowId: 'window-b',
  hostname: 'host-b',
  hostIdentity: '',
  pid: 200,
};

describe('judgeRoadmapRunLease', () => {
  it('誰も持っていなければfree', () => {
    expect(judgeRoadmapRunLease(undefined, ownerB, 'run-1', T0, alive)).toBe('free');
  });

  it('別ホストのウィンドウが持っていてheartbeatが新しければbusy（PIDは見ない）', () => {
    expect(judgeRoadmapRunLease(lease(), ownerB, 'run-1', after(59_000), dead)).toBe('busy');
  });

  it('heartbeatが失効時間以上止まっていればstale', () => {
    expect(
      judgeRoadmapRunLease(lease(), ownerB, 'run-1', after(ROADMAP_LEASE_STALE_MS), alive),
    ).toBe('stale');
  });

  it('同じホストでPIDが死んでいれば、heartbeatを待たずにstale', () => {
    const self = { ...ownerB, hostname: 'host-a' };
    expect(judgeRoadmapRunLease(lease(), self, 'run-1', after(1_000), dead)).toBe('stale');
    expect(judgeRoadmapRunLease(lease(), self, 'run-1', after(1_000), alive)).toBe('busy');
  });

  it('同じホスト名でもhostIdentityが違えばPID生死を見ずbusy（--network=hostでPID名前空間が別）', () => {
    const self = { ...ownerB, hostname: 'host-a', hostIdentity: 'boot-b:ns-b' };
    const holder = lease({ hostIdentity: 'boot-a:ns-a' });
    expect(judgeRoadmapRunLease(holder, self, 'run-1', after(1_000), dead)).toBe('busy');
  });

  it('自分のものは新しいうちはown、失効時間の半分を過ぎたらstale（上書きせず取り直す）', () => {
    const self = { ...ownerB, windowId: 'window-a' };
    expect(judgeRoadmapRunLease(lease(), self, 'run-1', after(29_000), alive)).toBe('own');
    expect(judgeRoadmapRunLease(lease(), self, 'run-1', after(30_000), alive)).toBe('stale');
  });

  it('同windowでも別runIdなら自分のものではなくstale（マルチルートの別フォルダ）', () => {
    const self = { ...ownerB, windowId: 'window-a' };
    expect(judgeRoadmapRunLease(lease(), self, 'run-other', after(1_000), alive)).toBe('stale');
  });

  it('heartbeatの時刻が読めなければ失効扱い', () => {
    expect(isRoadmapRunLeaseStale(lease({ heartbeatAt: 'broken' }), ownerB, T0, alive)).toBe(true);
  });
});

describe('parseRoadmapRunLease', () => {
  it('形の合うものだけを読む', () => {
    expect(parseRoadmapRunLease(JSON.stringify(lease()))).toEqual(lease());
    expect(parseRoadmapRunLease('')).toBeUndefined();
    expect(parseRoadmapRunLease(JSON.stringify({ ...lease(), pid: '1' }))).toBeUndefined();
  });

  it('hostIdentityの無い古いリースファイルは、未識別（空文字列）として読む', () => {
    const legacy: Partial<RoadmapRunLease> = lease({ hostIdentity: 'boot:pid:[1]' });
    delete legacy.hostIdentity;
    expect(parseRoadmapRunLease(JSON.stringify(legacy))).toEqual(lease({ hostIdentity: '' }));
    expect(parseRoadmapRunLease(JSON.stringify({ ...lease(), hostIdentity: 1 }))).toEqual(
      lease({ hostIdentity: '' }),
    );
  });
});

describe('normalizeRepoIdentity', () => {
  it('SSHとHTTPSの同じrepoをそろえる', () => {
    const ssh = normalizeRepoIdentity('git@github.com:Sylphy0052/VSCode-Codex-Extension.git\n');
    expect(ssh).toBe('github.com/sylphy0052/vscode-codex-extension');
    expect(normalizeRepoIdentity('https://github.com/Sylphy0052/VSCode-Codex-Extension')).toBe(ssh);
    expect(
      normalizeRepoIdentity('ssh://git@github.com/Sylphy0052/VSCode-Codex-Extension.git/'),
    ).toBe(ssh);
  });

  it('読めない形はundefined', () => {
    expect(normalizeRepoIdentity('')).toBeUndefined();
    expect(normalizeRepoIdentity('not a url')).toBeUndefined();
  });

  it('ファイル名はrepoとIssue番号で決まる', () => {
    expect(roadmapLeaseFileName('a/b', 1)).toBe(roadmapLeaseFileName('a/b', 1));
    expect(roadmapLeaseFileName('a/b', 1)).not.toBe(roadmapLeaseFileName('a/b', 2));
  });
});

describe('RoadmapRunLeaseManager', () => {
  let dir: string;
  let now: Date;
  const managers: RoadmapRunLeaseManager[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'roadmap-lease-'));
    now = T0;
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) {
      m.dispose();
    }
    await rm(dir, { recursive: true, force: true });
  });

  function manager(
    owner: RoadmapLeaseOwner,
    overrides: Partial<RoadmapRunLeaseManagerDeps> = {},
  ): RoadmapRunLeaseManager {
    const m = new RoadmapRunLeaseManager({
      dir,
      owner,
      // ホストごとにパスが違っても、同じrepoなら同じ専有権になる
      resolveRepoIdentity: () => Promise.resolve('github.com/owner/repo'),
      onLost: () => undefined,
      log: () => undefined,
      now: () => now,
      isPidAlive: alive,
      ...overrides,
    });
    managers.push(m);
    return m;
  }

  const ownerA: RoadmapLeaseOwner = {
    windowId: 'window-a',
    hostname: 'host-a',
    hostIdentity: '',
    pid: 100,
  };
  const target = (runId: string, workspaceRoot = '/work/a') => ({
    runId,
    workspaceRoot,
    roadmapIssueNumber: 1457,
  });

  it('別のウィンドウが同じロードマップを持っていれば取れず、持ち主を返す', async () => {
    const a = manager(ownerA);
    const b = manager(ownerB);
    expect(await a.acquire(target('run-a'))).toEqual({ ok: true });
    const denied = await b.acquire(target('run-b', '/other/host/path'));
    expect(denied.ok).toBe(false);
    expect(denied.ok ? undefined : denied.holder).toMatchObject({
      windowId: 'window-a',
      runId: 'run-a',
      hostname: 'host-a',
    });
    expect(b.holds('run-b')).toBe(false);
  });

  it('同時に取りに行っても、取れるのは1つだけ', async () => {
    const a = manager(ownerA);
    const b = manager(ownerB);
    const results = await Promise.all([a.acquire(target('run-a')), b.acquire(target('run-b'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('解放すれば別のウィンドウが取れる', async () => {
    const a = manager(ownerA);
    const b = manager(ownerB);
    await a.acquire(target('run-a'));
    await a.release('run-a');
    expect(await b.acquire(target('run-b'))).toEqual({ ok: true });
  });

  it('heartbeatが止まった専有権は取り直せる', async () => {
    const a = manager(ownerA);
    const b = manager(ownerB);
    await a.acquire(target('run-a'));
    now = after(ROADMAP_LEASE_STALE_MS + 1);
    expect(await b.acquire(target('run-b'))).toEqual({ ok: true });
    const names = await readdir(dir);
    // 退避・一時ファイルは残さない
    expect(names).toHaveLength(1);
    const stored = parseRoadmapRunLease(await readFile(path.join(dir, names[0] ?? ''), 'utf8'));
    expect(stored?.windowId).toBe('window-b');
  });

  it('落ちたウィンドウの自分のrunの専有権は、同じホストでPIDが死んでいればすぐ取り直せる', async () => {
    const crashed = manager({ ...ownerA, pid: 999 });
    await crashed.acquire(target('run-a'));
    // 再読み込み後のウィンドウ（windowIdとPIDが変わる）
    const reloaded = manager(
      { ...ownerA, windowId: 'window-a2', pid: 101 },
      { isPidAlive: (pid) => pid !== 999 },
    );
    expect(await reloaded.acquire(target('run-a'))).toEqual({ ok: true });
  });

  it('別ホストの専有権はPIDが見えなくてもheartbeatが新しければ取らない', async () => {
    const a = manager(ownerA);
    const b = manager({ ...ownerB }, { isPidAlive: dead });
    await a.acquire(target('run-a'));
    now = after(ROADMAP_LEASE_STALE_MS - 1);
    expect((await b.acquire(target('run-b'))).ok).toBe(false);
  });

  it('取られた専有権の解放では、相手のファイルを消さない', async () => {
    const a = manager(ownerA);
    const b = manager(ownerB);
    await a.acquire(target('run-a'));
    now = after(ROADMAP_LEASE_STALE_MS + 1);
    await b.acquire(target('run-b'));
    await a.release('run-a');
    const c = manager({ windowId: 'window-c', hostname: 'host-c', hostIdentity: '', pid: 300 });
    expect((await c.acquire(target('run-c'))).ok).toBe(false);
  });

  it('heartbeatで取られたことに気づいたらonLostで知らせて手放す', async () => {
    const onLost = vi.fn();
    const a = manager(ownerA, { heartbeatMs: 10, onLost });
    const b = manager(ownerB);
    await a.acquire(target('run-a'));
    // heartbeatの書き直しより前にbが失効とみなして取り直した状況を作る
    const file = path.join(dir, (await readdir(dir))[0] ?? '');
    await writeFile(
      file,
      JSON.stringify(lease({ windowId: 'window-b', runId: 'run-b', hostname: 'host-b' })),
    );
    await vi.waitFor(() => expect(onLost).toHaveBeenCalled());
    expect(onLost.mock.calls[0]?.[0]).toBe('run-a');
    expect(a.holds('run-a')).toBe(false);
    expect((await b.acquire(target('run-b'))).ok).toBe(true);
  });

  it('heartbeatで自分の専有権の時刻を書き直す', async () => {
    const a = manager(ownerA, { heartbeatMs: 10 });
    await a.acquire(target('run-a'));
    const file = path.join(dir, (await readdir(dir))[0] ?? '');
    now = after(5_000);
    await vi.waitFor(async () => {
      const stored = parseRoadmapRunLease(await readFile(file, 'utf8'));
      expect(stored?.heartbeatAt).toBe(after(5_000).toISOString());
      expect(stored?.acquiredAt).toBe(T0.toISOString());
    });
  });

  it('disposeで自分の専有権のファイルを消す', async () => {
    const a = manager(ownerA);
    await a.acquire(target('run-a'));
    a.dispose();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('RoadmapRunControllerの専有権', () => {
  const run = {
    runId: 'run-1',
    workspaceRoot: '/work/a',
    roadmapIssueNumber: 1457,
    finishedAt: undefined,
  } as unknown as RoadmapRun;
  const holder = lease({ hostname: 'b90-container' });

  function controller(active: RoadmapRun | undefined) {
    const detectHost = vi.fn(() => Promise.resolve(undefined));
    const acquire = vi.fn(() => Promise.resolve({ ok: false as const, holder }));
    const update = vi.fn();
    const onDidChange = vi.fn();
    const c = new RoadmapRunController({
      store: {
        list: () => (active === undefined ? [] : [active]),
        find: () => active,
        findActive: () => active,
        update,
      },
      runner: {} as never,
      detectHost,
      resolvePlan: vi.fn(),
      applyPlan: vi.fn(),
      confirmPlan: vi.fn(),
      decidePlanChange: vi.fn(),
      useCurrentPlan: vi.fn(),
      regeneratePlan: vi.fn(),
      notifyStalled: vi.fn(),
      onDidChange,
      lease: { acquire, holds: () => false, release: vi.fn(() => Promise.resolve()) },
      log: () => undefined,
      now: () => T0,
    });
    return { c, detectHost, acquire, update, onDidChange };
  }

  const input = {
    workspaceRoot: '/work/a',
    roadmapIssueNumber: 1457,
    engine: 'codex' as const,
    mode: 'auto' as const,
    maxParallel: 1,
  };

  it('別のウィンドウが持っていれば、新しいrunを準備せずに拒否する', async () => {
    const { c, detectHost } = controller(undefined);
    const outcome = await c.startRun(input);
    expect(outcome).toEqual({
      ok: false,
      message: formatRoadmapLeaseRejection(1457, holder, T0),
    });
    expect(outcome.ok ? '' : outcome.message).toContain('b90-container');
    expect(detectHost).not.toHaveBeenCalled();
  });

  it('同じウィンドウの実行中のrunも、専有権が取れなければ開かない', async () => {
    const { c } = controller(run);
    const outcome = await c.startRun(input);
    expect(outcome.ok).toBe(false);
  });

  it('専有権を失ったら、runを止める（haltedByUser）更新を保存する', () => {
    const { c, update, onDidChange } = controller(run);
    c.handleLeaseLost('run-1', holder);
    expect(update).toHaveBeenCalledTimes(1);
    const [runId, updater] = update.mock.calls[0] as [string, (r: RoadmapRun) => RoadmapRun];
    expect(runId).toBe('run-1');
    const running = { ...run, haltedByUser: false } as RoadmapRun;
    expect(updater(running).haltedByUser).toBe(true);
    expect(onDidChange).toHaveBeenCalled();
  });
});
