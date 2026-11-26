import { describe, expect, it, vi } from 'vitest';
import { AccountAutoSwitcher, type AutoSwitchPorts } from '../../src/claude/accountAutoSwitch';
import type { SavedAccountView } from '../../src/claude/accountStore';

const NOW = 1_000_000_000;
const SLOTS = {} as never;

function acct(
  id: string,
  priority: number,
  opts: { current?: boolean; pct?: number; noUsage?: boolean; recordedAt?: number } = {},
): SavedAccountView {
  return {
    id,
    name: `N-${id}`,
    priority,
    email: undefined,
    current: opts.current ?? false,
    usage: opts.noUsage
      ? undefined
      : {
          recordedAt: opts.recordedAt ?? NOW,
          fiveHour: { pct: opts.pct ?? 0, resetsAt: undefined },
          weekly: undefined,
        },
  };
}

function setup(
  accounts: SavedAccountView[],
  extra: Partial<AutoSwitchPorts> = {},
  config = { enabled: true, thresholdPct: 95 },
) {
  const state = { accounts, currentId: accounts.find((a) => a.current)?.id };
  const store = {
    list: vi.fn(async () => ({ ok: true as const, accounts: state.accounts })),
    currentId: vi.fn(async () => state.currentId),
    switchTo: vi.fn(async (id: string): Promise<Record<string, unknown>> => {
      state.currentId = id;
      return { ok: true };
    }),
    recordUsage: vi.fn(async () => ({ ok: true as const })),
    recordCachedUsage: vi.fn(async () => 42 as number | undefined),
    recordLimitHit: vi.fn(async () => ({ ok: true as const })),
  };
  const ports = {
    store,
    config: () => config,
    notify: vi.fn(),
    onSwitched: vi.fn(async () => undefined),
    warn: vi.fn(),
    ...extra,
  } as unknown as AutoSwitchPorts;
  return { sw: new AccountAutoSwitcher(ports), store, ports, state };
}

const full = () => [acct('cur', 1, { current: true, pct: 99 }), acct('b', 2, { pct: 10 })];

describe('record / recordCached / currentId', () => {
  it('currentIdはstoreへ委譲する', async () => {
    const { sw } = setup(full());
    expect(await sw.currentId()).toBe('cur');
  });
  it('record: 失敗時だけwarn', async () => {
    const { sw, store, ports } = setup(full());
    await sw.record('cur', SLOTS, NOW);
    expect(ports.warn).not.toHaveBeenCalled();
    store.recordUsage.mockResolvedValueOnce({ ok: false, reason: 'ng' } as never);
    await sw.record('cur', SLOTS, NOW);
    expect(ports.warn).toHaveBeenCalledWith('使用率を記録できませんでした: ng');
  });
  it('recordCached: 値を返し、例外はwarnしてundefined', async () => {
    const { sw, store, ports } = setup(full());
    expect(await sw.recordCached('cur')).toBe(42);
    store.recordCachedUsage.mockRejectedValueOnce(new Error('boom'));
    expect(await sw.recordCached('cur')).toBeUndefined();
    store.recordCachedUsage.mockRejectedValueOnce('str');
    await sw.recordCached('cur');
    expect(ports.warn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.warn).mock.calls[0]?.[0]).toContain('boom');
    expect(vi.mocked(ports.warn).mock.calls[1]?.[0]).toContain('str');
  });
});

describe('pollStandby / usageChanged', () => {
  it('無効なら呼ばない', async () => {
    const pollStandby = vi.fn(async () => undefined);
    const { sw } = setup(full(), { pollStandby }, { enabled: false, thresholdPct: 95 });
    await sw.pollStandby(NOW);
    expect(pollStandby).not.toHaveBeenCalled();
  });
  it('有効なら呼び、例外はwarn。portが無くても落ちない', async () => {
    const pollStandby = vi.fn(async () => undefined);
    const a = setup(full(), { pollStandby });
    await a.sw.pollStandby(NOW);
    expect(pollStandby).toHaveBeenCalledWith(NOW);
    pollStandby.mockRejectedValueOnce(new Error('x'));
    await a.sw.pollStandby(NOW);
    expect(a.ports.warn).toHaveBeenCalledOnce();
    pollStandby.mockRejectedValueOnce('s');
    await a.sw.pollStandby(NOW);
    expect(a.ports.warn).toHaveBeenCalledTimes(2);
    await setup(full()).sw.pollStandby(NOW);
  });
  it('usageChanged: 例外はwarn', async () => {
    const onUsageChanged = vi.fn(async () => undefined);
    const a = setup(full(), { onUsageChanged });
    await a.sw.usageChanged();
    expect(onUsageChanged).toHaveBeenCalled();
    onUsageChanged.mockRejectedValueOnce(new Error('x'));
    await a.sw.usageChanged();
    onUsageChanged.mockRejectedValueOnce('s');
    await a.sw.usageChanged();
    expect(a.ports.warn).toHaveBeenCalledTimes(2);
    await setup(full()).sw.usageChanged();
  });
});

describe('measureBeforeSwitch / measureAfterSwitch', () => {
  it('probeLiveの失敗はwarnして表示更新は続ける', async () => {
    const probeLive = vi.fn(async () => undefined);
    const onUsageChanged = vi.fn(async () => undefined);
    const a = setup(full(), { probeLive, onUsageChanged });
    await a.sw.measureBeforeSwitch();
    expect(probeLive).toHaveBeenCalledOnce();
    probeLive.mockRejectedValueOnce(new Error('e1'));
    await a.sw.measureAfterSwitch();
    probeLive.mockRejectedValueOnce('e2');
    await a.sw.measureBeforeSwitch();
    expect(onUsageChanged).toHaveBeenCalledTimes(3);
    expect(vi.mocked(a.ports.warn).mock.calls[0]?.[0]).toContain('切り替え後');
    expect(vi.mocked(a.ports.warn).mock.calls[1]?.[0]).toContain('切り替え前');
    await setup(full()).sw.measureBeforeSwitch();
  });
});

describe('onProbed', () => {
  it('無効・list失敗・稼働中なしでは何もしない', async () => {
    const a = setup(full(), {}, { enabled: false, thresholdPct: 95 });
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.store.list).not.toHaveBeenCalled();

    const b = setup(full());
    b.store.list.mockResolvedValueOnce({ ok: false, reason: 'x' } as never);
    await b.sw.onProbed(SLOTS, NOW);
    expect(b.store.switchTo).not.toHaveBeenCalled();

    const c = setup([acct('a', 1), acct('b', 2)]);
    await c.sw.onProbed(SLOTS, NOW);
    expect(c.store.switchTo).not.toHaveBeenCalled();
  });

  it('閾値に達したら次のアカウントへ切り替える', async () => {
    const a = setup(full());
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.store.switchTo).toHaveBeenCalledWith('b');
    expect(a.ports.notify).toHaveBeenCalledWith(
      '「N-cur」の使用率が95%に達したため、Claude Codeのアカウントを「N-b」へ切り替えました',
    );
    expect(a.ports.onSwitched).toHaveBeenCalled();
  });

  it('計測を待つ間に手動で切り替えられていたら切り替えない', async () => {
    const a = setup(full());
    a.store.currentId.mockResolvedValueOnce('other');
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.store.switchTo).not.toHaveBeenCalled();
  });

  it('切り替え先が無ければ1回だけ通知し、閾値未満に戻ると再通知できる', async () => {
    const a = setup([acct('cur', 1, { current: true, pct: 99 }), acct('b', 2, { pct: 99 })]);
    await a.sw.onProbed(SLOTS, NOW);
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.ports.notify).toHaveBeenCalledTimes(1);
    a.state.accounts = [acct('cur', 1, { current: true, pct: 10 })];
    await a.sw.onProbed(SLOTS, NOW);
    a.state.accounts = [acct('cur', 1, { current: true, pct: 99 })];
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.ports.notify).toHaveBeenCalledTimes(2);
  });

  it('閾値未満なら優先度の高いアカウントへ戻す。戻り先が無ければ何もしない', async () => {
    const a = setup([acct('cur', 5, { current: true, pct: 10 }), acct('hi', 1, { pct: 5 })]);
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.store.switchTo).toHaveBeenCalledWith('hi');
    expect(vi.mocked(a.ports.notify).mock.calls[0]?.[0]).toContain(
      '優先度の高いアカウントの枠が戻ったため',
    );

    const b = setup([acct('cur', 1, { current: true, pct: 10 }), acct('lo', 2)]);
    await b.sw.onProbed(SLOTS, NOW);
    expect(b.store.switchTo).not.toHaveBeenCalled();
  });

  it('切り替え先の記録が古ければ計測してから選び直す', async () => {
    const stale = acct('b', 2, { pct: 10, recordedAt: NOW - 2 * 3_600_000 });
    const probeStandby = vi.fn(async () => {
      a.state.accounts = [
        acct('cur', 1, { current: true, pct: 99 }),
        acct('b', 2, { pct: 99 }),
        acct('c', 3, { pct: 1 }),
      ];
    });
    const a = setup([acct('cur', 1, { current: true, pct: 99 }), stale, acct('c', 3, { pct: 1 })], {
      probeStandby,
    });
    await a.sw.onProbed(SLOTS, NOW);
    expect(probeStandby).toHaveBeenCalledWith('b', NOW);
    expect(a.store.switchTo).toHaveBeenCalledWith('c');
  });

  it('計測の例外はwarnして記録のまま選ぶ。再取得に失敗しても元の先を使う', async () => {
    const stale = acct('b', 2, { pct: 10, recordedAt: NOW - 2 * 3_600_000 });
    const probeStandby = vi.fn(async () => {
      throw new Error('probe');
    });
    const a = setup([acct('cur', 1, { current: true, pct: 99 }), stale], { probeStandby });
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.ports.warn).toHaveBeenCalledOnce();
    expect(a.store.switchTo).toHaveBeenCalledWith('b');

    const probeStandby2 = vi.fn(async () => {
      throw 'str';
    });
    const b = setup([acct('cur', 1, { current: true, pct: 99 }), stale], {
      probeStandby: probeStandby2,
    });
    b.store.list.mockResolvedValueOnce({ ok: true, accounts: b.state.accounts });
    b.store.list.mockResolvedValueOnce({ ok: false, reason: 'x' } as never);
    await b.sw.onProbed(SLOTS, NOW);
    expect(b.store.switchTo).toHaveBeenCalledWith('b');
  });

  it('同じアカウントは1回しか計測しない', async () => {
    const stale = acct('b', 2, { pct: 10, recordedAt: NOW - 2 * 3_600_000 });
    const probeStandby = vi.fn(async () => undefined);
    const a = setup([acct('cur', 1, { current: true, pct: 99 }), stale], { probeStandby });
    await a.sw.onProbed(SLOTS, NOW);
    expect(probeStandby).toHaveBeenCalledTimes(1);
    expect(a.store.switchTo).toHaveBeenCalledWith('b');
  });
});

describe('switchTo の失敗系', () => {
  it('失敗は通知し、同じ理由は繰り返さない。confirmCurrentで注記する', async () => {
    const a = setup(full());
    a.store.switchTo.mockResolvedValue({ ok: false, reason: 'ng' });
    await a.sw.onProbed(SLOTS, NOW);
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.ports.notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(a.ports.notify).mock.calls[0]?.[0]).toContain(
      '「N-b」へ自動で切り替えられませんでした: ng',
    );
    a.store.switchTo.mockResolvedValue({ ok: false, reason: 'ng', confirmCurrent: true });
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.ports.notify).toHaveBeenCalledTimes(2);
    expect(vi.mocked(a.ports.notify).mock.calls[1]?.[0]).toContain('手動で切り替えると');
  });

  it('warning付きの成功はwarnして通知に含める', async () => {
    const a = setup(full());
    a.store.switchTo.mockResolvedValue({ ok: true, warning: 'w' });
    await a.sw.onProbed(SLOTS, NOW);
    expect(a.ports.warn).toHaveBeenCalledWith('w');
    expect(vi.mocked(a.ports.notify).mock.calls[0]?.[0]).toContain('（w）');
  });
});

describe('switchOnLimit', () => {
  const hit = { limitLabel: '5時間', resetsAt: 2000 };

  it('無効でも上限を記録し、切り替えない', async () => {
    const a = setup(full(), {}, { enabled: false, thresholdPct: 95 });
    const r = await a.sw.switchOnLimit(hit, NOW);
    expect(r).toEqual({ switched: false, reason: '自動切り替えが無効です' });
    expect(a.store.recordLimitHit).toHaveBeenCalledWith('cur', ['fiveHour'], 2_000_000, NOW);
  });

  it('枠の種別から記録する枠を決める。解除時刻なし・稼働中なしは記録しない', async () => {
    const a = setup(full(), {}, { enabled: false, thresholdPct: 95 });
    await a.sw.switchOnLimit({ limitLabel: '週次', resetsAt: 1 }, NOW);
    expect(a.store.recordLimitHit).toHaveBeenLastCalledWith('cur', ['weekly'], 1000, NOW);
    await a.sw.switchOnLimit({ limitLabel: undefined, resetsAt: 1 }, NOW);
    expect(a.store.recordLimitHit).toHaveBeenLastCalledWith(
      'cur',
      ['fiveHour', 'weekly'],
      1000,
      NOW,
    );
    const n = a.store.recordLimitHit.mock.calls.length;
    await a.sw.switchOnLimit({ limitLabel: '週次', resetsAt: undefined }, NOW);
    expect(a.store.recordLimitHit.mock.calls.length).toBe(n);
    a.state.currentId = undefined;
    await a.sw.switchOnLimit(hit, NOW);
    expect(a.store.recordLimitHit.mock.calls.length).toBe(n);
  });

  it('記録失敗はwarn', async () => {
    const a = setup(full(), {}, { enabled: false, thresholdPct: 95 });
    a.store.recordLimitHit.mockResolvedValueOnce({ ok: false, reason: 'ng' } as never);
    await a.sw.switchOnLimit(hit, NOW);
    expect(a.ports.warn).toHaveBeenCalledWith('上限に達したことを記録できませんでした: ng');
  });

  it('list失敗の理由を返す', async () => {
    const a = setup(full());
    a.store.list.mockResolvedValueOnce({ ok: false, reason: 'lf' } as never);
    expect(await a.sw.switchOnLimit(hit, NOW)).toEqual({ switched: false, reason: 'lf' });
  });

  it('余裕のあるアカウントへ切り替える（切り替え前の計測も行う）', async () => {
    const probeLive = vi.fn(async () => undefined);
    const a = setup(full(), { probeLive });
    const r = await a.sw.switchOnLimit(hit, NOW);
    expect(r).toEqual({ switched: true, name: 'N-b' });
    expect(probeLive).toHaveBeenCalled();
  });

  it('切り替え先が無ければ通知して失敗を返す', async () => {
    const a = setup([acct('cur', 1, { current: true, pct: 99 })]);
    const r = await a.sw.switchOnLimit(hit, NOW);
    expect(r).toEqual({ switched: false, reason: '切り替え先がありません' });
    expect(a.ports.notify).toHaveBeenCalledOnce();
  });

  it('既に別の切り替えが済んでいれば、その先を成功として返す', async () => {
    const a = setup(full());
    a.store.currentId.mockResolvedValueOnce('cur'); // recordLimitHit
    a.store.currentId.mockResolvedValueOnce('b');
    const r = await a.sw.switchOnLimit(hit, NOW);
    expect(r).toEqual({ switched: true, name: 'N-b' });
    expect(a.store.switchTo).not.toHaveBeenCalled();

    const b = setup(full());
    b.store.currentId.mockResolvedValueOnce('cur');
    b.store.currentId.mockResolvedValueOnce('zzz');
    expect(await b.sw.switchOnLimit(hit, NOW)).toEqual({ switched: true, name: 'zzz' });
  });

  it('切り替えの最中なら重ねずその完了を返す', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = setup(full());
    a.ports.onSwitched = vi.fn(() => gate);
    const first = a.sw.onProbed(SLOTS, NOW);
    await vi.waitFor(() => {
      expect(a.store.switchTo).toHaveBeenCalled();
    });
    const second = a.sw.switchOnLimit(hit, NOW);
    release();
    await first;
    expect(await second).toEqual({ switched: true, name: 'N-b' });
    expect(a.store.switchTo).toHaveBeenCalledTimes(1);
    // 切り替え中の記録は行わない
    expect(a.store.recordLimitHit).not.toHaveBeenCalled();
  });

  it('計測を待つ間に切り替えが始まったら、その完了を返す', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let probes = 0;
    const probeStandby = vi.fn(async () => {
      probes += 1;
      if (probes > 1) {
        // 入れ子のonProbedでは計測済みとして記録を新しくする
        a.state.accounts = [acct('cur', 1, { current: true, pct: 99 }), acct('b', 2, { pct: 10 })];
        return;
      }
      void a.sw.onProbed(SLOTS, NOW);
      await vi.waitFor(() => {
        expect(a.store.switchTo).toHaveBeenCalled();
      });
    });
    const stale = acct('b', 2, { pct: 10, recordedAt: NOW - 2 * 3_600_000 });
    const a = setup([acct('cur', 1, { current: true, pct: 99 }), stale], { probeStandby });
    a.ports.onSwitched = vi.fn(() => gate);
    const p = a.sw.switchOnLimit(hit, NOW);
    await vi.waitFor(() => {
      expect(a.ports.onSwitched).toHaveBeenCalled();
    });
    release();
    expect((await p).switched).toBe(true);
  });

  it('switchTo直呼びの重なりは「切り替え中です」', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = setup(full());
    a.ports.onSwitched = vi.fn(() => gate);
    const first = a.sw.onProbed(SLOTS, NOW);
    await vi.waitFor(() => {
      expect(a.ports.onSwitched).toHaveBeenCalled();
    });
    const r = await (
      a.sw as unknown as {
        switchTo(i: string, n: string, w: string, m: boolean): Promise<unknown>;
      }
    ).switchTo('b', 'N-b', 'x', false);
    expect(r).toEqual({ switched: false, reason: '切り替え中です' });
    release();
    await first;
  });
});
