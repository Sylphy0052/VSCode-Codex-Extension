import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeAccountStore,
  describeIdentity,
  isValidAccountId,
  normalizeAccountName,
} from '../../src/claude/accountStore';
import type { AccountIdentity } from '../../src/claude/oauthProfile';

const FAR = 4_102_444_800_000;

function creds(token: string): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: FAR },
  });
}

function ident(n: string): AccountIdentity {
  return {
    accountUuid: `acc-${n}`,
    organizationUuid: `org-${n}`,
    email: `${n}@example.com`,
    organizationName: undefined,
  };
}

describe('accountStore helpers', () => {
  it('isValidAccountId', () => {
    expect(isValidAccountId('abc-1.x')).toBe(true);
    expect(isValidAccountId('..')).toBe(false);
    expect(isValidAccountId('.')).toBe(false);
    expect(isValidAccountId('a/b')).toBe(false);
    expect(isValidAccountId(5)).toBe(false);
  });
  it('normalizeAccountName', () => {
    expect(normalizeAccountName('  x ')).toBe('x');
    expect(normalizeAccountName('   ')).toBeUndefined();
    expect(normalizeAccountName('a'.repeat(41))).toBeUndefined();
    expect(normalizeAccountName('a\nb')).toBeUndefined();
  });
  it('describeIdentity', () => {
    expect(describeIdentity(ident('a'))).toContain('a@example.com');
    expect(describeIdentity({ ...ident('a'), organizationName: 'Org' })).toContain('Org');
  });
});

describe('ClaudeAccountStore', () => {
  let dir: string;
  let home: string;
  let globalConfig: string;
  let store: ClaudeAccountStore;
  const tokens: Record<string, AccountIdentity | undefined> = {};

  const live = (): string => join(home, '.credentials.json');
  const setLive = (token: string): Promise<void> => writeFile(live(), creds(token));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'account-store-'));
    home = join(dir, 'claude');
    await mkdir(home, { recursive: true });
    globalConfig = join(dir, 'claude.json');
    for (const k of Object.keys(tokens)) {
      delete tokens[k];
    }
    tokens['tokA'] = ident('a');
    tokens['tokB'] = ident('b');
    store = new ClaudeAccountStore(home, async (t) => tokens[t], globalConfig);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list is empty without accounts', async () => {
    expect(await store.list()).toEqual({ ok: true, accounts: [] });
  });

  it('register rejects invalid name, no login, broken file, unknown identity', async () => {
    expect((await store.register('')).ok).toBe(false);
    expect((await store.register('A')).ok).toBe(false);
    await writeFile(live(), 'not json');
    expect((await store.register('A')).ok).toBe(false);
    await setLive('unknown');
    expect((await store.register('A')).ok).toBe(false);
  });

  it('register, duplicate rejection, list and liveEmail', async () => {
    await setLive('tokA');
    expect(await store.liveEmail()).toBe('a@example.com');
    expect(await store.register('A')).toMatchObject({ ok: true });
    expect((await store.register('A2')).ok).toBe(false);
    const snap = await store.list();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.accounts).toHaveLength(1);
      expect(snap.accounts[0]).toMatchObject({ name: 'A', current: true, email: 'a@example.com' });
      const id = snap.accounts[0]!.id;
      expect(await store.currentId()).toBe(id);
      expect(await store.isRegistered(id)).toBe(true);
      expect(await store.displayName(id)).toBe('A');
    }
    expect(await store.isRegistered('../x')).toBe(false);
  });

  it('liveEmail is undefined without file', async () => {
    expect(await store.liveEmail()).toBeUndefined();
  });

  async function twoAccounts(): Promise<[string, string]> {
    await setLive('tokA');
    await store.register('A');
    await setLive('tokB');
    await store.register('B');
    const snap = await store.list();
    if (!snap.ok) {
      throw new Error('list failed');
    }
    const byName = (n: string): string => snap.accounts.find((a) => a.name === n)!.id;
    return [byName('A'), byName('B')];
  }

  it('switchTo swaps credentials and writes back', async () => {
    const [a, b] = await twoAccounts();
    expect(await store.currentId()).toBe(b);
    expect((await store.switchTo('nope')).ok).toBe(false);
    expect((await store.switchTo(b)).ok).toBe(true);
    expect((await store.switchTo(a)).ok).toBe(true);
    expect(await readFile(live(), 'utf8')).toBe(creds('tokA'));
    expect(await store.currentId()).toBe(a);
    await writeFile(
      live(),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tokA', refreshToken: 'new', expiresAt: FAR },
      }),
    );
    expect((await store.switchTo(b)).ok).toBe(true);
    expect(await readFile(join(home, 'accounts', a, '.credentials.json'), 'utf8')).toContain('new');
  });

  it('switchTo refuses when live is unparsable or owner unknown', async () => {
    const [a] = await twoAccounts();
    await writeFile(live(), 'garbage');
    expect((await store.switchTo(a)).ok).toBe(false);
    tokens['tokZ'] = ident('z');
    await setLive('tokZ');
    expect((await store.switchTo(a)).ok).toBe(false);
  });

  it('switchTo works when live credentials are missing', async () => {
    const [a] = await twoAccounts();
    await rm(live());
    expect((await store.switchTo(a)).ok).toBe(true);
    expect(await readFile(live(), 'utf8')).toBe(creds('tokA'));
  });

  it('switchTo syncs oauthAccount into the global config', async () => {
    await writeFile(
      globalConfig,
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@example.com', accountUuid: 'acc-a' },
        other: 1,
      }),
    );
    const [a] = await twoAccounts();
    await writeFile(
      globalConfig,
      JSON.stringify({
        oauthAccount: { emailAddress: 'b@example.com', accountUuid: 'acc-b' },
        other: 1,
      }),
    );
    await store.switchTo(a);
    const cfg = JSON.parse(await readFile(globalConfig, 'utf8')) as Record<string, unknown>;
    expect(cfg['other']).toBe(1);
  });

  it('rename validates and updates', async () => {
    const [a] = await twoAccounts();
    expect((await store.rename('zz', 'N')).ok).toBe(false);
    expect((await store.rename(a, '')).ok).toBe(false);
    expect((await store.rename(a, 'New')).ok).toBe(true);
    expect(await store.displayName(a)).toBe('New');
  });

  it('move reorders and handles edges', async () => {
    const [a, b] = await twoAccounts();
    expect((await store.move('zz', 'up')).ok).toBe(false);
    expect((await store.move(a, 'up')).ok).toBe(true);
    expect((await store.move(b, 'down')).ok).toBe(true);
    expect((await store.move(b, 'up')).ok).toBe(true);
    const snap = await store.list();
    if (snap.ok) {
      expect(snap.accounts.map((x) => x.id)).toEqual([b, a]);
    }
    expect((await store.move(b, 'down')).ok).toBe(true);
    const snap2 = await store.list();
    if (snap2.ok) {
      expect(snap2.accounts.map((x) => x.id)).toEqual([a, b]);
    }
  });

  it('remove refuses unknown and current, removes others', async () => {
    const [a, b] = await twoAccounts();
    expect((await store.remove('zz')).ok).toBe(false);
    expect((await store.remove(b)).ok).toBe(false);
    expect((await store.remove(a)).ok).toBe(true);
    expect(await store.isRegistered(a)).toBe(false);
  });

  it('recordUsage and recordLimitHit', async () => {
    const [a, b] = await twoAccounts();
    expect((await store.recordUsage(a, { fiveHour: undefined, weekly: undefined }, 1)).ok).toBe(
      false,
    );
    expect(
      (
        await store.recordUsage(
          b,
          { fiveHour: { pct: 10, resetsAt: 5 }, weekly: { pct: 20, resetsAt: 6 } },
          100,
        )
      ).ok,
    ).toBe(true);
    expect((await store.recordUsage(b, { fiveHour: undefined, weekly: undefined }, 101)).ok).toBe(
      true,
    );
    expect((await store.recordLimitHit(a, ['fiveHour'], 9, 1)).ok).toBe(false);
    expect((await store.recordLimitHit(b, ['fiveHour', 'weekly'], 9, 2)).ok).toBe(true);
    expect((await store.recordLimitHit(b, ['weekly'], 10, 3)).ok).toBe(true);
    const snap = await store.list();
    if (snap.ok) {
      const cur = snap.accounts.find((x) => x.id === b)!;
      expect(cur.usage?.recordedAt).toBe(3);
      expect(cur.usage?.fiveHour?.pct).toBe(100);
      expect(cur.usage?.weekly?.resetsAt).toBe(10);
    }
  });

  it('adoptCurrent checks id and identity', async () => {
    const [a, b] = await twoAccounts();
    expect((await store.adoptCurrent(a, ident('b'))).ok).toBe(false);
    expect((await store.adoptCurrent(b, ident('a'))).ok).toBe(false);
    expect((await store.adoptCurrent(b, ident('b'))).ok).toBe(true);
  });

  it('recordCachedUsage copies matching cached usage', async () => {
    const [, b] = await twoAccounts();
    await expect(store.recordCachedUsage('zz')).rejects.toThrow();
    expect(await store.recordCachedUsage(b)).toBeUndefined();
    const fetchedAtMs = Date.now() - 1000;
    await writeFile(
      globalConfig,
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs,
          accountUuid: 'acc-b',
          utilization: {
            five_hour: { utilization: 12, resets_at: '2030-01-01T00:00:00Z' },
            seven_day: { utilization: 30, resets_at: '2030-01-02T00:00:00Z' },
          },
        },
      }),
    );
    expect(await store.recordCachedUsage(b)).toBe(fetchedAtMs);
    expect(await store.recordCachedUsage(b)).toBeUndefined();
    await writeFile(
      globalConfig,
      JSON.stringify({
        cachedUsageUtilization: { fetchedAtMs: Date.now(), accountUuid: 'other', utilization: {} },
      }),
    );
    expect(await store.recordCachedUsage(b)).toBeUndefined();
  });

  it('list repairs legacy accounts and tolerates a stale lock', async () => {
    await mkdir(join(home, 'accounts', 'legacy'), { recursive: true });
    await writeFile(join(home, 'accounts', 'legacy', '.credentials.json'), creds('tokA'));
    await writeFile(join(home, 'accounts', '.current'), 'legacy\n');
    const snap = await store.list();
    expect(snap.ok).toBe(true);
    if (!snap.ok) throw new Error('list failed');
    expect(snap.accounts[0]).toMatchObject({ id: 'legacy', name: 'legacy', current: true });
    const lock = join(home, 'accounts', '.ext-op.lock');
    await writeFile(lock, '');
    // src/claude/accountStore.ts の STALE_LOCK_MS (30_000、非export) より十分古くする
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    expect((await store.rename('legacy', 'L')).ok).toBe(true);
  });

  it('probeStandby skips current, unregistered and live-identical accounts', async () => {
    const [a, b] = await twoAccounts();
    let calls = 0;
    const measure = async (): Promise<undefined> => {
      calls += 1;
      return undefined;
    };
    expect(await store.probeStandby(b, measure, Date.now())).toEqual({ ok: true });
    expect(await store.probeStandby('zz', measure, Date.now())).toEqual({ ok: true });
    await setLive('tokA');
    expect(await store.probeStandby(a, measure, Date.now())).toEqual({ ok: true });
    expect(calls).toBe(0);
  });

  it('probeStandby measures a standby account and records usage', async () => {
    const [a] = await twoAccounts();
    let seen = '';
    const r = await store.probeStandby(
      a,
      async (configDir) => {
        seen = configDir;
        return { fiveHour: { pct: 7, resetsAt: 123 }, weekly: { pct: 8, resetsAt: 456 } };
      },
      Date.now(),
    );
    expect(r.ok).toBe(true);
    expect(seen).toContain('@probe-');
    const snap = await store.list();
    expect(snap.ok).toBe(true);
    if (!snap.ok) throw new Error('list failed');
    expect(snap.accounts.find((x) => x.id === a)?.usage?.fiveHour?.pct).toBe(7);
  });

  it('probeStandby reports measure failures and empty results', async () => {
    const [a] = await twoAccounts();
    const thrown = await store.probeStandby(
      a,
      async () => {
        throw new Error('boom');
      },
      Date.now(),
    );
    expect(thrown).toMatchObject({
      ok: false,
      reason: expect.stringContaining('計測できませんでした'),
    });
    const empty = await store.probeStandby(a, async () => undefined, Date.now());
    expect(empty).toMatchObject({
      ok: false,
      reason: expect.stringContaining('計測できませんでした'),
    });
  });

  it('probeStandby writes back a rotated token', async () => {
    const [a] = await twoAccounts();
    const r = await store.probeStandby(
      a,
      async (configDir) => {
        await writeFile(
          join(configDir, '.credentials.json'),
          JSON.stringify({
            claudeAiOauth: { accessToken: 'tokA', refreshToken: 'rotated', expiresAt: FAR },
          }),
        );
        return { fiveHour: { pct: 1, resetsAt: 1 }, weekly: undefined };
      },
      Date.now(),
    );
    expect(r.ok).toBe(true);
    const saved = await readFile(join(home, 'accounts', a, '.credentials.json'), 'utf8');
    expect(saved).toContain('rotated');
  });

  it('probeStandby fails when the saved credentials are missing', async () => {
    const [a] = await twoAccounts();
    await writeFile(join(home, 'accounts', a, '.credentials.json'), '{}');
    const r = await store.probeStandby(a, async () => undefined, Date.now());
    expect(r.ok).toBe(false);
  });

  it('cleanupProbeDirs removes leftover probe dirs', async () => {
    await twoAccounts();
    const probe = join(home, 'accounts', '@probe-abc123');
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, '.credentials.json'), creds('tokA'));
    expect((await store.cleanupProbeDirs()).ok).toBe(true);
    await expect(readFile(join(probe, '.credentials.json'))).rejects.toThrow();
  });

  it('cleanupProbeDirs is a no-op without accounts dir', async () => {
    expect(await store.cleanupProbeDirs()).toEqual({ ok: true });
  });

  it('cleanupProbeDirs succeeds with no probe dirs', async () => {
    const [a] = await twoAccounts();
    expect((await store.cleanupProbeDirs()).ok).toBe(true);
    expect(await store.isRegistered(a)).toBe(true);
  });
});
