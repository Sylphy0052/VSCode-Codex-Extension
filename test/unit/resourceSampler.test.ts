import type * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const osMock = vi.hoisted(() => ({ totalmem: vi.fn(() => 0), freemem: vi.fn(() => 0) }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, totalmem: osMock.totalmem, freemem: osMock.freemem };
});

import {
  ResourceSampler,
  defaultResourceSamplerPorts,
  parseCgroupV2Path,
  parsePressureSomeTotal,
  terminateDescendants,
  type ResourceSamplerPorts,
} from '../../src/orchestrator/resourceSampler';

/** `/proc/<pid>/stat`の1行を作る（4: ppid、14: utime、15: stime）。 */
function statLine(pid: number, comm: string, ppid: number, utime = 0, stime = 0): string {
  return `${String(pid)} (${comm}) S ${String(ppid)} 0 0 0 0 0 0 0 0 0 ${String(utime)} ${String(stime)} 0 0 20 0 1 0 100 0 0\n`;
}

function cpuInfo(user: number, sys: number, idle: number): os.CpuInfo {
  return {
    model: 'test',
    speed: 0,
    times: { user, nice: 0, sys, idle, irq: 0 },
  };
}

interface FakeEnv {
  ports: ResourceSamplerPorts;
  files: Map<string, string>;
  dirs: Map<string, string[]>;
  clock: { now: number };
  cpus: os.CpuInfo[];
  loadavg: number[];
  execFile: Mock<(command: string, args: readonly string[]) => Promise<string>>;
}

function makeEnv(overrides: Partial<ResourceSamplerPorts> = {}): FakeEnv {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const clock = { now: 1_000_000 };
  const env: FakeEnv = {
    files,
    dirs,
    clock,
    cpus: [cpuInfo(0, 0, 0)],
    loadavg: [0, 0, 0],
    execFile: vi.fn(async () => ''),
    ports: undefined as unknown as ResourceSamplerPorts,
  };
  env.ports = {
    platform: 'linux',
    pid: 4242,
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return text;
    },
    readdir: async (path) => {
      const names = dirs.get(path);
      if (names === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return names;
    },
    execFile: (command, args) => env.execFile(command, args),
    now: () => clock.now,
    cpus: () => env.cpus,
    loadavg: () => env.loadavg,
    availableParallelism: () => 4,
    ...overrides,
  };
  return env;
}

function pressureText(total: number): string {
  return `some avg10=0.12 avg60=0.34 avg300=0.56 total=${String(total)}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
}

describe('parsePressureSomeTotal', () => {
  it('someの行のtotalを数値で返す', () => {
    expect(parsePressureSomeTotal(pressureText(123456))).toBe(123456);
  });

  it('形式が違えばundefinedを返す', () => {
    expect(parsePressureSomeTotal('')).toBeUndefined();
    expect(parsePressureSomeTotal('some avg10=x avg60=0 avg300=0 total=1')).toBeUndefined();
    expect(
      parsePressureSomeTotal('full avg10=0.00 avg60=0.00 avg300=0.00 total=5'),
    ).toBeUndefined();
  });
});

describe('parseCgroupV2Path', () => {
  it('0::の行からパスを返す', () => {
    expect(parseCgroupV2Path('0::/user.slice/session.scope\n')).toBe('/user.slice/session.scope');
    expect(parseCgroupV2Path('0::/\n')).toBe('/');
  });

  it('v1だけの環境はundefinedを返す', () => {
    expect(parseCgroupV2Path('12:memory:/docker/abc\n1:name=systemd:/\n')).toBeUndefined();
  });

  it('..を含むパスは使わない', () => {
    expect(parseCgroupV2Path('0::/a/../b\n')).toBeUndefined();
  });
});

describe('defaultResourceSamplerPorts', () => {
  it('実環境の値を返し、readFileとreadFile失敗とexecFileが動く', async () => {
    const ports = defaultResourceSamplerPorts();
    expect(ports.platform).toBe(process.platform);
    expect(ports.pid).toBe(process.pid);
    expect(typeof ports.now()).toBe('number');
    expect(Array.isArray(ports.loadavg())).toBe(true);
    expect(ports.availableParallelism()).toBeGreaterThan(0);
    expect(Array.isArray(ports.cpus())).toBe(true);
    expect(await ports.readFile(__filename)).toContain('defaultResourceSamplerPorts');
    expect(Array.isArray(await ports.readdir(__dirname))).toBe(true);
    await expect(ports.readFile('/nonexistent/resource-sampler-test')).rejects.toThrow();
    const out = await ports.execFile(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(out).toBe('ok');
    await expect(ports.execFile('/nonexistent/command-xyz', [])).rejects.toThrow();
  });
});

describe('ResourceSampler.sampleHost', () => {
  it('PSIが無ければ使用率で判定し、初回はpercentがundefinedで2回目に差から出す', async () => {
    const env = makeEnv();
    env.files.set('/proc/meminfo', 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n');
    const sampler = new ResourceSampler(env.ports);

    env.cpus = [cpuInfo(100, 0, 100)];
    const first = await sampler.sampleHost();
    expect(first.cpu).toEqual({ method: 'usage', percent: undefined });
    expect(first.cpuUsagePercent).toBeUndefined();
    expect(first.cpuCores).toBe(4);

    env.cpus = [cpuInfo(150, 0, 150)];
    const second = await sampler.sampleHost();
    expect(second.cpu.method).toBe('usage');
    expect(second.cpu.percent).toBeCloseTo(50);
    expect(second.cpuUsagePercent).toBeCloseTo(50);
  });

  it('cpus合計が増えない（差が取れない）ときはundefinedになる', async () => {
    const env = makeEnv();
    const sampler = new ResourceSampler(env.ports);
    env.cpus = [cpuInfo(10, 0, 10)];
    await sampler.sampleHost();
    const second = await sampler.sampleHost();
    expect(second.cpuUsagePercent).toBeUndefined();
  });

  it('loadPerCoreは1分平均をコア数で割る。Windowsとloadavgが空のときはundefined', async () => {
    const env = makeEnv();
    env.loadavg = [2, 0, 0];
    expect((await new ResourceSampler(env.ports).sampleHost()).loadPerCore).toBe(0.5);

    env.loadavg = [];
    expect((await new ResourceSampler(env.ports).sampleHost()).loadPerCore).toBeUndefined();

    const win = makeEnv({ platform: 'win32' });
    win.loadavg = [3, 0, 0];
    osMock.totalmem.mockReturnValue(1000);
    osMock.freemem.mockReturnValue(100);
    expect((await new ResourceSampler(win.ports).sampleHost()).loadPerCore).toBeUndefined();
  });

  it('cores<=0のときloadPerCoreはundefined', async () => {
    const env = makeEnv({ availableParallelism: () => 0 });
    env.loadavg = [2, 0, 0];
    expect((await new ResourceSampler(env.ports).sampleHost()).loadPerCore).toBeUndefined();
  });

  describe('PSI', () => {
    it('cgroupのcpu.pressureを先に読み、前回との差からCPUを待った割合を出す', async () => {
      const env = makeEnv();
      env.files.set('/proc/4242/cgroup', '0::/my/group\n');
      env.files.set('/sys/fs/cgroup/my/group/cpu.pressure', pressureText(1_000_000));
      const sampler = new ResourceSampler(env.ports);

      const first = await sampler.sampleHost();
      expect(first.cpu).toEqual({ method: 'psi', percent: undefined, pressureSource: 'cgroup' });

      // 1秒（1_000_000us）の間に250_000usを待った
      env.clock.now += 1000;
      env.files.set('/sys/fs/cgroup/my/group/cpu.pressure', pressureText(1_250_000));
      const second = await sampler.sampleHost();
      expect(second.cpu.method).toBe('psi');
      expect(second.cpu.percent).toBeCloseTo(25);
      expect(second.cpu.pressureSource).toBe('cgroup');
    });

    it('割合は100%を超えない', async () => {
      const env = makeEnv();
      env.files.set('/proc/pressure/cpu', pressureText(0));
      const sampler = new ResourceSampler(env.ports);
      await sampler.sampleHost();
      env.clock.now += 10;
      env.files.set('/proc/pressure/cpu', pressureText(10_000_000));
      expect((await sampler.sampleHost()).cpu.percent).toBe(100);
    });

    it('cgroupが根（/）ならルートのcpu.pressureを読む', async () => {
      const env = makeEnv();
      env.files.set('/proc/4242/cgroup', '0::/\n');
      env.files.set('/sys/fs/cgroup/cpu.pressure', pressureText(5));
      const result = await new ResourceSampler(env.ports).sampleHost();
      expect(result.cpu.pressureSource).toBe('cgroup');
    });

    it('cgroupのpressureが読めなければ/proc/pressure/cpuへ落ちる', async () => {
      const env = makeEnv();
      env.files.set('/proc/4242/cgroup', '0::/my/group\n');
      env.files.set('/proc/pressure/cpu', pressureText(10));
      const result = await new ResourceSampler(env.ports).sampleHost();
      expect(result.cpu).toEqual({ method: 'psi', percent: undefined, pressureSource: 'system' });
    });

    it('cgroupのpressureの形式が不正でもsystemへ落ちる', async () => {
      const env = makeEnv();
      env.files.set('/proc/4242/cgroup', '0::/g\n');
      env.files.set('/sys/fs/cgroup/g/cpu.pressure', 'garbage');
      env.files.set('/proc/pressure/cpu', pressureText(10));
      const result = await new ResourceSampler(env.ports).sampleHost();
      expect(result.cpu.pressureSource).toBe('system');
    });

    it('読み元が替わった直後は差を出さない', async () => {
      const env = makeEnv();
      env.files.set('/proc/4242/cgroup', '0::/g\n');
      env.files.set('/sys/fs/cgroup/g/cpu.pressure', pressureText(100));
      const sampler = new ResourceSampler(env.ports);
      await sampler.sampleHost();

      env.files.delete('/sys/fs/cgroup/g/cpu.pressure');
      env.files.set('/proc/pressure/cpu', pressureText(200));
      env.clock.now += 1000;
      const result = await sampler.sampleHost();
      expect(result.cpu).toEqual({ method: 'psi', percent: undefined, pressureSource: 'system' });
    });

    it('時刻が進まない、またはtotalが減ったときは差を出さない', async () => {
      const env = makeEnv();
      env.files.set('/proc/pressure/cpu', pressureText(1000));
      const sampler = new ResourceSampler(env.ports);
      await sampler.sampleHost();

      env.files.set('/proc/pressure/cpu', pressureText(2000));
      expect((await sampler.sampleHost()).cpu.percent).toBeUndefined();

      env.clock.now += 1000;
      env.files.set('/proc/pressure/cpu', pressureText(10));
      expect((await sampler.sampleHost()).cpu.percent).toBeUndefined();
    });

    it('PSIが使えなくなったら記憶を捨て、再び使えても初回扱いになる', async () => {
      const env = makeEnv();
      env.files.set('/proc/pressure/cpu', pressureText(100));
      const sampler = new ResourceSampler(env.ports);
      await sampler.sampleHost();

      env.files.delete('/proc/pressure/cpu');
      expect((await sampler.sampleHost()).cpu.method).toBe('usage');

      env.clock.now += 1000;
      env.files.set('/proc/pressure/cpu', pressureText(500));
      expect((await sampler.sampleHost()).cpu.percent).toBeUndefined();
    });

    it('Linux以外ではPSIを読まない', async () => {
      const env = makeEnv({ platform: 'darwin' });
      env.files.set('/proc/pressure/cpu', pressureText(100));
      osMock.totalmem.mockReturnValue(1000);
      vi.spyOn(process, 'availableMemory').mockReturnValue(500);
      const result = await new ResourceSampler(env.ports).sampleHost();
      expect(result.cpu.method).toBe('usage');
    });
  });

  describe('メモリ', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('LinuxはMemAvailableとMemTotalから割合を出す', async () => {
      const env = makeEnv();
      env.files.set('/proc/meminfo', 'MemTotal:  1000 kB\nMemFree: 1 kB\nMemAvailable:  250 kB\n');
      const result = await new ResourceSampler(env.ports).sampleHost();
      expect(result.memoryTotalBytes).toBe(1000 * 1024);
      expect(result.memoryAvailableBytes).toBe(250 * 1024);
      expect(result.memoryAvailableRatio).toBe(0.25);
      expect(result.memoryFromCgroup).toBe(false);
    });

    it('meminfoが読めなければすべてundefined', async () => {
      const env = makeEnv();
      const result = await new ResourceSampler(env.ports).sampleHost();
      expect(result.memoryAvailableBytes).toBeUndefined();
      expect(result.memoryTotalBytes).toBeUndefined();
      expect(result.memoryAvailableRatio).toBeUndefined();
    });

    it('MemTotalが0なら割合はundefined', async () => {
      const env = makeEnv();
      env.files.set('/proc/meminfo', 'MemTotal: 0 kB\nMemAvailable: 0 kB\n');
      expect(
        (await new ResourceSampler(env.ports).sampleHost()).memoryAvailableRatio,
      ).toBeUndefined();
    });

    it('macOSはprocess.availableMemory()を使う', async () => {
      const env = makeEnv({ platform: 'darwin' });
      osMock.totalmem.mockReturnValue(2000);
      vi.spyOn(process, 'availableMemory').mockReturnValue(500);
      const result = await new ResourceSampler(env.ports).sampleHost();
      expect(result).toMatchObject({
        memoryTotalBytes: 2000,
        memoryAvailableBytes: 500,
        memoryAvailableRatio: 0.25,
        memoryFromCgroup: false,
      });
    });

    it('Windowsはos.freemem()を使い、総メモリ0なら割合はundefined', async () => {
      const env = makeEnv({ platform: 'win32' });
      osMock.totalmem.mockReturnValue(4000);
      osMock.freemem.mockReturnValue(1000);
      expect((await new ResourceSampler(env.ports).sampleHost()).memoryAvailableRatio).toBe(0.25);

      osMock.totalmem.mockReturnValue(0);
      expect(
        (await new ResourceSampler(env.ports).sampleHost()).memoryAvailableRatio,
      ).toBeUndefined();
    });

    describe('cgroup', () => {
      const MIB = 1024 * 1024;

      function linuxEnv(): FakeEnv {
        const env = makeEnv();
        // ホスト: 1000MiB中900MiBが空き
        env.files.set(
          '/proc/meminfo',
          `MemTotal: ${String(1000 * 1024)} kB\nMemAvailable: ${String(900 * 1024)} kB\n`,
        );
        return env;
      }

      it('v2の制限がホストより厳しければcgroupの値を採る（inactive_fileは使用量から引く）', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory.max', String(100 * MIB));
        env.files.set('/sys/fs/cgroup/memory.current', String(80 * MIB));
        env.files.set(
          '/sys/fs/cgroup/memory.stat',
          `anon 1\ninactive_file ${String(30 * MIB)}\nactive_file 5\n`,
        );
        const result = await new ResourceSampler(env.ports).sampleHost();
        expect(result.memoryFromCgroup).toBe(true);
        expect(result.memoryTotalBytes).toBe(100 * MIB);
        expect(result.memoryAvailableBytes).toBe(50 * MIB);
        expect(result.memoryAvailableRatio).toBe(0.5);
      });

      it('v2でmemory.statが無ければinactive_fileは0として扱う', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory.max', String(100 * MIB));
        env.files.set('/sys/fs/cgroup/memory.current', String(20 * MIB));
        const result = await new ResourceSampler(env.ports).sampleHost();
        expect(result.memoryAvailableBytes).toBe(80 * MIB);
      });

      it('v2でmemory.maxがmaxなら制限なしでホストの値を使う', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory.max', 'max\n');
        const result = await new ResourceSampler(env.ports).sampleHost();
        expect(result.memoryFromCgroup).toBe(false);
        expect(result.memoryTotalBytes).toBe(1000 * MIB);
      });

      it('v2でmemory.currentが読めなければcgroupは使わない', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory.max', String(100 * MIB));
        const result = await new ResourceSampler(env.ports).sampleHost();
        expect(result.memoryFromCgroup).toBe(false);
      });

      it('制限がホストの総メモリ以上なら制限なしとみなす', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory.max', String(2000 * MIB));
        env.files.set('/sys/fs/cgroup/memory.current', '0');
        expect((await new ResourceSampler(env.ports).sampleHost()).memoryFromCgroup).toBe(false);
      });

      it('制限が厳しくてもホストの空き割合の方が小さければホストの値を使う', async () => {
        const env = makeEnv();
        env.files.set('/proc/meminfo', 'MemTotal: 1024 kB\nMemAvailable: 10 kB\n');
        env.files.set('/sys/fs/cgroup/memory.max', String(512 * 1024));
        env.files.set('/sys/fs/cgroup/memory.current', '0');
        const result = await new ResourceSampler(env.ports).sampleHost();
        expect(result.memoryFromCgroup).toBe(false);
        expect(result.memoryAvailableBytes).toBe(10 * 1024);
      });

      it('meminfoが無くcgroupの制限があればcgroupの値を使う', async () => {
        const env = makeEnv();
        env.files.set('/sys/fs/cgroup/memory.max', String(100 * MIB));
        env.files.set('/sys/fs/cgroup/memory.current', String(10 * MIB));
        const result = await new ResourceSampler(env.ports).sampleHost();
        expect(result.memoryFromCgroup).toBe(true);
        expect(result.memoryAvailableBytes).toBe(90 * MIB);
      });

      it('使用量がinactive_fileより小さくても空きは制限を超えない', async () => {
        const env = makeEnv();
        env.files.set('/sys/fs/cgroup/memory.max', String(100 * MIB));
        env.files.set('/sys/fs/cgroup/memory.current', String(10 * MIB));
        env.files.set('/sys/fs/cgroup/memory.stat', `inactive_file ${String(50 * MIB)}\n`);
        expect((await new ResourceSampler(env.ports).sampleHost()).memoryAvailableBytes).toBe(
          100 * MIB,
        );
      });

      it('v1の制限を読む（total_inactive_fileを引く）', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory/memory.limit_in_bytes', String(100 * MIB));
        env.files.set('/sys/fs/cgroup/memory/memory.usage_in_bytes', String(90 * MIB));
        env.files.set(
          '/sys/fs/cgroup/memory/memory.stat',
          `cache 1\ntotal_inactive_file ${String(40 * MIB)}\n`,
        );
        const result = await new ResourceSampler(env.ports).sampleHost();
        expect(result.memoryFromCgroup).toBe(true);
        expect(result.memoryTotalBytes).toBe(100 * MIB);
        expect(result.memoryAvailableBytes).toBe(50 * MIB);
      });

      it('v1でmemory.statが無ければinactiveは0', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory/memory.limit_in_bytes', String(100 * MIB));
        env.files.set('/sys/fs/cgroup/memory/memory.usage_in_bytes', String(90 * MIB));
        expect((await new ResourceSampler(env.ports).sampleHost()).memoryAvailableBytes).toBe(
          10 * MIB,
        );
      });

      it('v1で巨大な値（制限なし）・usage不明・limit不明はcgroupを使わない', async () => {
        const env = linuxEnv();
        env.files.set('/sys/fs/cgroup/memory/memory.limit_in_bytes', '9223372036854771712');
        env.files.set('/sys/fs/cgroup/memory/memory.usage_in_bytes', '1');
        expect((await new ResourceSampler(env.ports).sampleHost()).memoryFromCgroup).toBe(false);

        const noUsage = linuxEnv();
        noUsage.files.set('/sys/fs/cgroup/memory/memory.limit_in_bytes', String(100 * MIB));
        expect((await new ResourceSampler(noUsage.ports).sampleHost()).memoryFromCgroup).toBe(
          false,
        );

        const noLimit = linuxEnv();
        expect((await new ResourceSampler(noLimit.ports).sampleHost()).memoryFromCgroup).toBe(
          false,
        );
      });
    });
  });
});

describe('ResourceSampler.sampleProcessTrees（Linux）', () => {
  /** /proc配下に1プロセス分を置く。 */
  function addProc(
    env: FakeEnv,
    pid: number,
    ppid: number,
    opts: { ticks?: number; rssKb?: number; pssKb?: number; comm?: string } = {},
  ): void {
    const p = String(pid);
    env.files.set(
      `/proc/${p}/stat`,
      statLine(pid, opts.comm ?? `proc${p}`, ppid, opts.ticks ?? 0, 0),
    );
    if (opts.rssKb !== undefined) {
      env.files.set(`/proc/${p}/status`, `Name: x\nVmRSS:\t${String(opts.rssKb)} kB\n`);
    }
    if (opts.pssKb !== undefined) {
      env.files.set(`/proc/${p}/smaps_rollup`, `Rss: 1 kB\nPss:   ${String(opts.pssKb)} kB\n`);
    }
  }

  function setProcList(env: FakeEnv, pids: Array<number | string>): void {
    env.dirs.set('/proc', pids.map(String));
  }

  it('rootPidsが空なら一覧を取らずに空のMapを返す', async () => {
    const env = makeEnv();
    const readdir = vi.spyOn(env.ports, 'readdir');
    expect((await new ResourceSampler(env.ports).sampleProcessTrees([])).size).toBe(0);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('一覧が取れなければ空のMapを返す', async () => {
    const env = makeEnv();
    expect((await new ResourceSampler(env.ports).sampleProcessTrees([1])).size).toBe(0);
  });

  it('ツリーのRSS・PSS・プロセス数を合計する。ツリー外は含まない', async () => {
    const env = makeEnv();
    setProcList(env, [1, 10, 11, 100, 200, 'self', 'cpuinfo']);
    addProc(env, 1, 0, { rssKb: 1000, pssKb: 900 });
    addProc(env, 10, 1, { rssKb: 100, pssKb: 50 });
    addProc(env, 11, 10, { rssKb: 10, pssKb: 5 });
    addProc(env, 100, 0, { rssKb: 9999, pssKb: 9999 });
    addProc(env, 200, 0, { rssKb: 1, pssKb: 1 });
    const result = await new ResourceSampler(env.ports).sampleProcessTrees([1, 200]);
    expect(result.get(1)).toEqual({
      rssBytes: 1110 * 1024,
      pssBytes: 955 * 1024,
      cpuPercent: undefined,
      processCount: 3,
    });
    expect(result.get(200)?.processCount).toBe(1);
    expect(result.get(200)?.rssBytes).toBe(1024);
  });

  it('根が一覧に無ければprocessCountは0でRSSも0', async () => {
    const env = makeEnv();
    setProcList(env, [1]);
    addProc(env, 1, 0, { rssKb: 10, pssKb: 10 });
    const result = await new ResourceSampler(env.ports).sampleProcessTrees([777]);
    expect(result.get(777)).toMatchObject({ rssBytes: 0, pssBytes: 0, processCount: 0 });
  });

  it('PSSを読めないプロセスがあればpssBytesはundefined。RSSが0のプロセスは数えなくてよい', async () => {
    const env = makeEnv();
    setProcList(env, [1, 2, 3]);
    addProc(env, 1, 0, { rssKb: 100, pssKb: 80 });
    addProc(env, 2, 1, { rssKb: 100 }); // smaps_rollupなし
    const unreadable = await new ResourceSampler(env.ports).sampleProcessTrees([1]);
    expect(unreadable.get(1)?.pssBytes).toBeUndefined();
    expect(unreadable.get(1)?.rssBytes).toBe(200 * 1024);

    const env2 = makeEnv();
    setProcList(env2, [1, 2]);
    addProc(env2, 1, 0, { rssKb: 100, pssKb: 80 });
    addProc(env2, 2, 1, { rssKb: 0 }); // RSSが0ならPSSが無くても許す
    const zero = await new ResourceSampler(env2.ports).sampleProcessTrees([1]);
    expect(zero.get(1)?.pssBytes).toBe(80 * 1024);
  });

  it('statが読めないプロセスや壊れたstatは一覧から外す。コマンド名に括弧や空白を含んでも読める', async () => {
    const env = makeEnv();
    setProcList(env, [1, 2, 3, 4]);
    addProc(env, 1, 0, { rssKb: 1, pssKb: 1, comm: 'a b) (c' });
    env.files.set('/proc/2/stat', 'no paren here');
    env.files.set('/proc/3/stat', '3 (x) S notnumber');
    // 4はstatなし
    const result = await new ResourceSampler(env.ports).sampleProcessTrees([1, 2, 3, 4]);
    expect(result.get(1)?.processCount).toBe(1);
    expect(result.get(2)?.processCount).toBe(0);
    expect(result.get(3)?.processCount).toBe(0);
    expect(result.get(4)?.processCount).toBe(0);
  });

  it('utime・stimeが欠けるstatはCPU時間なしになる', async () => {
    const env = makeEnv();
    setProcList(env, [1]);
    env.files.set('/proc/1/stat', '1 (x) S 0 0 0');
    env.files.set('/proc/1/status', 'VmRSS: 4 kB\n');
    env.files.set('/proc/1/smaps_rollup', 'Pss: 4 kB\n');
    const sampler = new ResourceSampler(env.ports);
    await sampler.sampleProcessTrees([1]);
    env.clock.now += 1000;
    const second = await sampler.sampleProcessTrees([1]);
    // cpuSecondsが無い行は数えず、cpuPercentは0のまま
    expect(second.get(1)?.cpuPercent).toBe(0);
  });

  it('自己参照のppid（ppid==pid）で無限ループしない', async () => {
    const env = makeEnv();
    setProcList(env, [1]);
    addProc(env, 1, 1, { rssKb: 1, pssKb: 1 });
    expect(
      (await new ResourceSampler(env.ports).sampleProcessTrees([1])).get(1)?.processCount,
    ).toBe(1);
  });

  it('CPU使用率は初回undefined、2回目に累積CPU時間の差から1コア=100%で出す', async () => {
    const env = makeEnv();
    setProcList(env, [1, 2]);
    addProc(env, 1, 0, { ticks: 100, rssKb: 1, pssKb: 1 });
    addProc(env, 2, 1, { ticks: 0, rssKb: 1, pssKb: 1 });
    const sampler = new ResourceSampler(env.ports);
    expect((await sampler.sampleProcessTrees([1])).get(1)?.cpuPercent).toBeUndefined();

    // 2秒で根が1秒（100tick）・子が0.5秒（50tick）使った → 50% + 25%
    env.clock.now += 2000;
    addProc(env, 1, 0, { ticks: 200, rssKb: 1, pssKb: 1 });
    addProc(env, 2, 1, { ticks: 50, rssKb: 1, pssKb: 1 });
    expect((await sampler.sampleProcessTrees([1])).get(1)?.cpuPercent).toBeCloseTo(75);
  });

  it('累積CPU時間が減っても負にならない。新しい子は数えない', async () => {
    const env = makeEnv();
    setProcList(env, [1]);
    addProc(env, 1, 0, { ticks: 500, rssKb: 1, pssKb: 1 });
    const sampler = new ResourceSampler(env.ports);
    await sampler.sampleProcessTrees([1]);

    env.clock.now += 1000;
    setProcList(env, [1, 2]);
    addProc(env, 1, 0, { ticks: 100, rssKb: 1, pssKb: 1 });
    addProc(env, 2, 1, { ticks: 9999, rssKb: 1, pssKb: 1 });
    expect((await sampler.sampleProcessTrees([1])).get(1)?.cpuPercent).toBe(0);
  });

  it('時刻が進んでいないときはCPU使用率を出さない', async () => {
    const env = makeEnv();
    setProcList(env, [1]);
    addProc(env, 1, 0, { ticks: 10, rssKb: 1, pssKb: 1 });
    const sampler = new ResourceSampler(env.ports);
    await sampler.sampleProcessTrees([1]);
    expect((await sampler.sampleProcessTrees([1])).get(1)?.cpuPercent).toBeUndefined();
  });

  it('根が前回の計測に無かった（新しい）プロセスならCPU使用率はundefined', async () => {
    const env = makeEnv();
    setProcList(env, [1, 2]);
    addProc(env, 1, 0, { ticks: 10, rssKb: 1, pssKb: 1 });
    addProc(env, 2, 0, { ticks: 10, rssKb: 1, pssKb: 1 });
    const sampler = new ResourceSampler(env.ports);
    await sampler.sampleProcessTrees([1]);
    env.clock.now += 1000;
    const result = await sampler.sampleProcessTrees([1, 2]);
    expect(result.get(2)?.cpuPercent).toBeUndefined();
    expect(result.get(1)?.cpuPercent).toBe(0);
  });

  it('statusが読めないプロセスのRSSは0として数える', async () => {
    const env = makeEnv();
    setProcList(env, [1]);
    addProc(env, 1, 0); // statusなし
    const result = await new ResourceSampler(env.ports).sampleProcessTrees([1]);
    expect(result.get(1)).toMatchObject({ rssBytes: 0, pssBytes: 0 });
  });
});

describe('ResourceSampler.sampleProcessTrees（macOS・Windows）', () => {
  it('macOSはpsの出力からRSS（KB）とpcpuを合計する', async () => {
    const env = makeEnv({ platform: 'darwin' });
    env.execFile.mockResolvedValue(
      [
        ' 1 0 1000 1.5',
        ' 10 1 200 2.5',
        ' 20 10 100 0.0',
        ' 99 0 5 50.0',
        '',
        'garbage line',
        '30 1',
      ].join('\n'),
    );
    const result = await new ResourceSampler(env.ports).sampleProcessTrees([1]);
    expect(env.execFile).toHaveBeenCalledWith('ps', ['-eo', 'pid=,ppid=,rss=,pcpu=']);
    expect(result.get(1)).toEqual({
      rssBytes: (1000 + 200 + 100 + 0) * 1024,
      pssBytes: undefined,
      cpuPercent: 4,
      processCount: 4,
    });
  });

  it('psの実行に失敗したら空のMap', async () => {
    const env = makeEnv({ platform: 'darwin' });
    env.execFile.mockRejectedValue(new Error('boom'));
    expect((await new ResourceSampler(env.ports).sampleProcessTrees([1])).size).toBe(0);
  });

  it('psでpcpuが無い行はCPUを数えず、行にRSSも無ければ0', async () => {
    const env = makeEnv({ platform: 'darwin' });
    env.execFile.mockResolvedValue('1 0\n');
    const result = await new ResourceSampler(env.ports).sampleProcessTrees([1]);
    expect(result.get(1)).toMatchObject({ rssBytes: 0, cpuPercent: 0, processCount: 1 });
  });

  it('WindowsはPowerShellの出力から累積CPU時間（100ns単位）の差で使用率を出す', async () => {
    const env = makeEnv({ platform: 'win32' });
    const sampler = new ResourceSampler(env.ports);
    env.execFile.mockResolvedValue('5 0 4096 10000000\r\n6 5 2048 0\r\n');
    const first = await sampler.sampleProcessTrees([5]);
    expect(env.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
    );
    expect(first.get(5)).toEqual({
      rssBytes: 4096 + 2048,
      pssBytes: undefined,
      cpuPercent: undefined,
      processCount: 2,
    });

    env.clock.now += 2000;
    // 根が2秒で1秒分（10_000_000単位）、子は0.5秒分
    env.execFile.mockResolvedValue('5 0 4096 20000000\r\n6 5 2048 5000000\r\n');
    const second = await sampler.sampleProcessTrees([5]);
    expect(second.get(5)?.cpuPercent).toBeCloseTo(75);
  });

  it('Windowsで列が足りない行はCPU時間なしとして扱い、不正な行は無視する', async () => {
    const env = makeEnv({ platform: 'win32' });
    env.execFile.mockResolvedValue('7 0 100\nabc def\n');
    const result = await new ResourceSampler(env.ports).sampleProcessTrees([7]);
    expect(result.get(7)).toMatchObject({ rssBytes: 100, cpuPercent: 0, processCount: 1 });
  });
});

describe('ResourceSampler.listDescendantPids', () => {
  it('根を含まず、深い順（孫が先）に返す', async () => {
    const env = makeEnv();
    env.dirs.set('/proc', ['1', '2', '3', '4']);
    env.files.set('/proc/1/stat', statLine(1, 'a', 0));
    env.files.set('/proc/2/stat', statLine(2, 'b', 1));
    env.files.set('/proc/3/stat', statLine(3, 'c', 2));
    env.files.set('/proc/4/stat', statLine(4, 'd', 99));
    expect(await new ResourceSampler(env.ports).listDescendantPids(1)).toEqual([3, 2]);
  });

  it('根が無ければ空配列。一覧が取れなければ例外を伝える', async () => {
    const env = makeEnv();
    await expect(new ResourceSampler(env.ports).listDescendantPids(1)).rejects.toThrow();
    env.dirs.set('/proc', []);
    expect(await new ResourceSampler(env.ports).listDescendantPids(1)).toEqual([]);
  });
});

describe('terminateDescendants', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function linuxTree(env: FakeEnv, pids: Array<[number, number]>): void {
    env.dirs.set(
      '/proc',
      pids.map(([pid]) => String(pid)),
    );
    for (const [pid, ppid] of pids) {
      env.files.set(`/proc/${String(pid)}/stat`, statLine(pid, 'p', ppid));
    }
  }

  it('Windowsはtaskkill /T /Fで根ごと止める', async () => {
    const env = makeEnv({ platform: 'win32' });
    await terminateDescendants(123, env.ports);
    expect(env.execFile).toHaveBeenCalledWith('taskkill', ['/PID', '123', '/T', '/F']);
  });

  it('子孫が無ければSIGTERMを送らず待たずに返る', async () => {
    const env = makeEnv({ now: () => Date.now() });
    linuxTree(env, [[1, 0]]);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await terminateDescendants(1, env.ports);
    expect(kill).not.toHaveBeenCalled();
  });

  it('SIGTERMで全部終われば猶予を待たずSIGKILLも送らない', async () => {
    const env = makeEnv({ now: () => Date.now() });
    linuxTree(env, [
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    const alive = new Set([2, 3]);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      sig?: string | number,
    ) => {
      if (sig === 'SIGTERM') {
        // 次のpollingまでに終わる
        setTimeout(() => {
          alive.clear();
          env.files.delete('/proc/2/stat');
          env.files.delete('/proc/3/stat');
        }, 100);
        return true;
      }
      if (sig === 0) {
        if (alive.has(pid)) {
          return true;
        }
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);
    const done = terminateDescendants(1, env.ports);
    await vi.runAllTimersAsync();
    await done;
    // 孫から先に
    const termCalls = kill.mock.calls.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid);
    expect(termCalls).toEqual([3, 2]);
    expect(kill.mock.calls.some(([, sig]) => sig === 'SIGKILL')).toBe(false);
  });

  it('猶予の後も残る子孫にだけSIGKILLを送る。EPERMは生存扱い、kill失敗は握りつぶす', async () => {
    const env = makeEnv({ now: () => Date.now() });
    linuxTree(env, [
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
    const kill = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      sig?: string | number,
    ) => {
      if (sig === 0) {
        // 3は終わり、2は権限が無いだけ（生きている）
        if (pid === 3) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      if (sig === 'SIGTERM' && pid === 3) {
        // 3はSIGTERMで終わり、猶予後の再列挙には現れない
        env.files.delete('/proc/3/stat');
      }
      if (sig === 'SIGKILL' && pid === 2) {
        throw new Error('already gone');
      }
      return true;
    }) as typeof process.kill);
    const done = terminateDescendants(1, env.ports);
    await vi.runAllTimersAsync();
    await done;
    const killed = kill.mock.calls.filter(([, sig]) => sig === 'SIGKILL').map(([pid]) => pid);
    expect(killed).toEqual([2]);
  });
});
