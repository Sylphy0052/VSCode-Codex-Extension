/**
 * オーケストレータモードで、ホストの資源（CPU・メモリ）と工程セッションのプロセスツリーの使用量を
 * 測る（Issue #1629）。OSごとの取り方の違いはここに閉じ込め、判定（`resourceMonitor.ts`）は
 * 数値だけを見る。
 *
 * - CPU: Linux・macOSは1分平均の負荷をコア数（`os.availableParallelism()`）で割る。Windowsは
 *   負荷平均が無い（常に0）ため、前回の計測からの`os.cpus()`の時間の差で使用率を出す
 * - メモリ: LinuxはMemAvailable（`/proc/meminfo`）、macOSは`process.availableMemory()`、
 *   Windowsは`os.freemem()`。Linuxではcgroup（v2・v1）の制限も読み、厳しい方を採る
 * - プロセス: 1回の計測で全プロセスの一覧（pidとppid）を取り、JS側でツリーを組む。pidごとに
 *   コマンドを起動しない
 *
 * `/proc`などから読んだ文字列は長く持たない。V8の`slice`・`split`で切り出した文字列は元の
 * 文字列を掴んだままになるため、数値へ直してから捨てる。
 */

import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import * as os from 'node:os';

/** ホスト全体（コンテナ内ならcgroupの制限も含む）の資源。測れなかった値は`undefined`。 */
export interface HostResources {
  /**
   * CPUの混み具合。Linux・macOSは1分平均の負荷をコア数で割った値（1.0で全コアが埋まっている）。
   * Windowsは前回の計測からの使用率（0〜1）。初回の計測では前回が無いため`undefined`。
   */
  cpuLoadPerCore: number | undefined;
  /** 使えるメモリの割合（0〜1）。cgroupの制限があればホストと比べて厳しい方。 */
  memoryAvailableRatio: number | undefined;
  memoryAvailableBytes: number | undefined;
  memoryTotalBytes: number | undefined;
  /** メモリの値をcgroupの制限から採った（ホストより厳しかった）。 */
  memoryFromCgroup: boolean;
}

/** プロセスツリー（根とその子孫）の使用量の合計。 */
export interface ProcessTreeUsage {
  rssBytes: number;
  /** 1コアを100%とするCPU使用率。前回の計測が無く差を取れないときは`undefined`。 */
  cpuPercent: number | undefined;
  /** ツリーに含まれるプロセスの数。根が既に終わっていれば0。 */
  processCount: number;
}

/** 全プロセスの一覧の1行。値は数値だけを持つ。 */
interface ProcessRow {
  pid: number;
  ppid: number;
  /** RSS（バイト）。一覧の時点では読んでいない（Linux）ことがある。 */
  rssBytes: number | undefined;
  /** 起動からの累積CPU時間（秒）。macOSは`ps`の使用率を直接使うため持たない。 */
  cpuSeconds: number | undefined;
  /** macOSの`ps`が出す使用率（%）。 */
  cpuPercent: number | undefined;
}

export interface ResourceSamplerPorts {
  platform: NodeJS.Platform;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  execFile(command: string, args: readonly string[]): Promise<string>;
  now(): number;
}

/**
 * Linuxの`/proc/<pid>/stat`の時間の単位（USER_HZ）。カーネルの設定に関わらずユーザー空間へは
 * 100で見せる（`sysconf(_SC_CLK_TCK)`が返す値）ため固定にする。
 */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/** WindowsのWin32_Processの`KernelModeTime`・`UserModeTime`の単位（100ns）。 */
const WINDOWS_CPU_TIME_UNITS_PER_SECOND = 10_000_000;

/** プロセス一覧を取るコマンドの時間と出力の上限。数百プロセスでも数十KBに収まる。 */
const PROCESS_LIST_TIMEOUT_MS = 10_000;
const PROCESS_LIST_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * cgroup v1の`memory.limit_in_bytes`は制限なしのとき巨大な値（ページ境界へ丸めた2^63-1）になる。
 * ホストの総メモリ以上の制限は、制限なしとみなす。
 */
function isEffectiveLimit(limit: number, hostTotal: number | undefined): boolean {
  return Number.isFinite(limit) && limit > 0 && (hostTotal === undefined || limit < hostTotal);
}

function toNumber(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** `Key:   1234 kB`形式の行から、指定したキーの値（kB）を読む。 */
function readKbField(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
  return match === null ? undefined : toNumber(match[1]);
}

/** cgroupの`memory.stat`から指定したキーの値（バイト）を読む。 */
function readStatField(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key}\\s+(\\d+)`, 'm').exec(text);
  return match === null ? undefined : toNumber(match[1]);
}

export function defaultResourceSamplerPorts(): ResourceSamplerPorts {
  return {
    platform: process.platform,
    readFile: (path) => fsPromises.readFile(path, 'utf8'),
    readdir: (path) => fsPromises.readdir(path),
    execFile: (command, args) =>
      new Promise((resolve, reject) => {
        execFile(
          command,
          [...args],
          { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: PROCESS_LIST_MAX_BUFFER, windowsHide: true },
          (error, stdout) => {
            if (error !== null) {
              reject(error);
              return;
            }
            resolve(stdout);
          },
        );
      }),
    now: () => Date.now(),
  };
}

export class ResourceSampler {
  /** Windowsのホストの使用率の差を取るための前回の`os.cpus()`の合計（ms）。 */
  private previousHostCpu: { busy: number; total: number } | undefined;
  /** プロセスごとの前回の累積CPU時間（秒）と計測時刻。CPU使用率の差を取るのに使う。 */
  private previousProcessCpu: { at: number; seconds: Map<number, number> } | undefined;

  constructor(private readonly ports: ResourceSamplerPorts = defaultResourceSamplerPorts()) {}

  async sampleHost(): Promise<HostResources> {
    const cpuLoadPerCore = this.sampleHostCpu();
    const memory = await this.sampleHostMemory();
    return { cpuLoadPerCore, ...memory };
  }

  private sampleHostCpu(): number | undefined {
    if (this.ports.platform !== 'win32') {
      const load = os.loadavg()[0];
      const cores = os.availableParallelism();
      return load === undefined || cores <= 0 ? undefined : load / cores;
    }
    let busy = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
      const { user, nice, sys, idle, irq } = cpu.times;
      busy += user + nice + sys + irq;
      total += user + nice + sys + idle + irq;
    }
    const previous = this.previousHostCpu;
    this.previousHostCpu = { busy, total };
    if (previous === undefined || total <= previous.total) {
      return undefined;
    }
    return (busy - previous.busy) / (total - previous.total);
  }

  private async sampleHostMemory(): Promise<Omit<HostResources, 'cpuLoadPerCore'>> {
    const { platform } = this.ports;
    if (platform === 'linux') {
      return this.sampleLinuxMemory();
    }
    const total = os.totalmem();
    const available = platform === 'darwin' ? process.availableMemory() : os.freemem();
    return {
      memoryAvailableRatio: total > 0 ? available / total : undefined,
      memoryAvailableBytes: available,
      memoryTotalBytes: total,
      memoryFromCgroup: false,
    };
  }

  private async sampleLinuxMemory(): Promise<Omit<HostResources, 'cpuLoadPerCore'>> {
    let hostAvailable: number | undefined;
    let hostTotal: number | undefined;
    const meminfo = await this.readOptional('/proc/meminfo');
    if (meminfo !== undefined) {
      const availableKb = readKbField(meminfo, 'MemAvailable');
      const totalKb = readKbField(meminfo, 'MemTotal');
      hostAvailable = availableKb === undefined ? undefined : availableKb * 1024;
      hostTotal = totalKb === undefined ? undefined : totalKb * 1024;
    }
    const host = {
      memoryAvailableRatio:
        hostAvailable !== undefined && hostTotal !== undefined && hostTotal > 0
          ? hostAvailable / hostTotal
          : undefined,
      memoryAvailableBytes: hostAvailable,
      memoryTotalBytes: hostTotal,
      memoryFromCgroup: false,
    };
    const cgroup = await this.sampleCgroupMemory(hostTotal);
    if (cgroup === undefined) {
      return host;
    }
    const cgroupRatio = cgroup.available / cgroup.limit;
    if (host.memoryAvailableRatio !== undefined && host.memoryAvailableRatio <= cgroupRatio) {
      return host;
    }
    return {
      memoryAvailableRatio: cgroupRatio,
      memoryAvailableBytes: cgroup.available,
      memoryTotalBytes: cgroup.limit,
      memoryFromCgroup: true,
    };
  }

  /**
   * cgroupのメモリ制限と、その中で使える残り。制限が無ければ`undefined`。使用量からはすぐに
   * 捨てられるページキャッシュ（inactive_file）を引く（`docker stats`と同じ数え方）。
   */
  private async sampleCgroupMemory(
    hostTotal: number | undefined,
  ): Promise<{ limit: number; available: number } | undefined> {
    // v2: `memory.max`が`max`なら制限なし
    const v2Max = await this.readOptional('/sys/fs/cgroup/memory.max');
    if (v2Max !== undefined) {
      const limit = v2Max.trim() === 'max' ? undefined : toNumber(v2Max);
      if (limit === undefined || !isEffectiveLimit(limit, hostTotal)) {
        return undefined;
      }
      const current = toNumber(await this.readOptional('/sys/fs/cgroup/memory.current'));
      if (current === undefined) {
        return undefined;
      }
      const stat = await this.readOptional('/sys/fs/cgroup/memory.stat');
      const inactive = stat === undefined ? 0 : (readStatField(stat, 'inactive_file') ?? 0);
      return { limit, available: Math.max(0, limit - Math.max(0, current - inactive)) };
    }
    // v1
    const limit = toNumber(await this.readOptional('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    if (limit === undefined || !isEffectiveLimit(limit, hostTotal)) {
      return undefined;
    }
    const usage = toNumber(await this.readOptional('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
    if (usage === undefined) {
      return undefined;
    }
    const stat = await this.readOptional('/sys/fs/cgroup/memory/memory.stat');
    const inactive = stat === undefined ? 0 : (readStatField(stat, 'total_inactive_file') ?? 0);
    return { limit, available: Math.max(0, limit - Math.max(0, usage - inactive)) };
  }

  /**
   * 根のpidごとに、そのプロセスツリーの使用量を測る。全プロセスの一覧は1回だけ取る。
   * 一覧を取れなければ空のMapを返す（計測の失敗で工程を止めない）。
   */
  async sampleProcessTrees(rootPids: readonly number[]): Promise<Map<number, ProcessTreeUsage>> {
    const result = new Map<number, ProcessTreeUsage>();
    if (rootPids.length === 0) {
      return result;
    }
    let rows: Map<number, ProcessRow>;
    try {
      rows = await this.listProcesses();
    } catch {
      return result;
    }
    const children = buildChildren(rows);
    const trees = new Map(rootPids.map((pid) => [pid, collectTree(pid, rows, children)]));
    if (this.ports.platform === 'linux') {
      await this.fillLinuxRss(rows, new Set([...trees.values()].flat()));
    }
    const at = this.ports.now();
    const previous = this.previousProcessCpu;
    const seconds = new Map<number, number>();
    for (const [root, pids] of trees) {
      let rssBytes = 0;
      let cpuPercent: number | undefined = 0;
      for (const pid of pids) {
        const row = rows.get(pid);
        if (row === undefined) {
          continue;
        }
        rssBytes += row.rssBytes ?? 0;
        if (row.cpuPercent !== undefined) {
          cpuPercent = cpuPercent === undefined ? undefined : cpuPercent + row.cpuPercent;
          continue;
        }
        if (row.cpuSeconds === undefined) {
          continue;
        }
        seconds.set(pid, row.cpuSeconds);
        const before = previous?.seconds.get(pid);
        const elapsed = previous === undefined ? 0 : (at - previous.at) / 1000;
        if (before === undefined || elapsed <= 0) {
          // 前回の計測に無かった（新しい）プロセスは、差を取れないため数えない。根まで
          // 新しければ使用率そのものを出さない
          if (pid === root) {
            cpuPercent = undefined;
          }
          continue;
        }
        if (cpuPercent !== undefined) {
          cpuPercent += (Math.max(0, row.cpuSeconds - before) / elapsed) * 100;
        }
      }
      result.set(root, { rssBytes, cpuPercent, processCount: pids.length });
    }
    this.previousProcessCpu = { at, seconds };
    return result;
  }

  /** 根の子孫のpid（根を含まない）。深い順（子より孫が先）に並べる。 */
  async listDescendantPids(rootPid: number): Promise<number[]> {
    const rows = await this.listProcesses();
    const tree = collectTree(rootPid, rows, buildChildren(rows));
    return tree.filter((pid) => pid !== rootPid).reverse();
  }

  private async listProcesses(): Promise<Map<number, ProcessRow>> {
    switch (this.ports.platform) {
      case 'linux':
        return this.listLinuxProcesses();
      case 'win32':
        return this.listWindowsProcesses();
      default:
        return this.listPsProcesses();
    }
  }

  /** 全プロセスの`/proc/<pid>/stat`からpid・ppid・累積CPU時間を読む。RSSは対象のツリーだけ後で読む。 */
  private async listLinuxProcesses(): Promise<Map<number, ProcessRow>> {
    const names = await this.ports.readdir('/proc');
    const rows = await Promise.all(
      names
        .filter((name) => /^\d+$/.test(name))
        .map(async (name): Promise<ProcessRow | undefined> => {
          const stat = await this.readOptional(`/proc/${name}/stat`);
          return stat === undefined ? undefined : parseLinuxStat(Number(name), stat);
        }),
    );
    return new Map(
      rows.filter((row): row is ProcessRow => row !== undefined).map((row) => [row.pid, row]),
    );
  }

  private async fillLinuxRss(rows: Map<number, ProcessRow>, pids: ReadonlySet<number>): Promise<void> {
    await Promise.all(
      [...pids].map(async (pid) => {
        const row = rows.get(pid);
        const status = row === undefined ? undefined : await this.readOptional(`/proc/${String(pid)}/status`);
        if (row === undefined || status === undefined) {
          return;
        }
        const rssKb = readKbField(status, 'VmRSS');
        rows.set(pid, { ...row, rssBytes: rssKb === undefined ? undefined : rssKb * 1024 });
      }),
    );
  }

  /** macOS（とその他のUnix）: `ps`の1回の呼び出しで全プロセスを取る。RSSはKB。 */
  private async listPsProcesses(): Promise<Map<number, ProcessRow>> {
    const out = await this.ports.execFile('ps', ['-eo', 'pid=,ppid=,rss=,pcpu=']);
    const rows = new Map<number, ProcessRow>();
    for (const line of out.split('\n')) {
      const [pid, ppid, rss, pcpu] = line.trim().split(/\s+/).map(toNumber);
      if (pid === undefined || ppid === undefined) {
        continue;
      }
      rows.set(pid, {
        pid,
        ppid,
        rssBytes: rss === undefined ? undefined : rss * 1024,
        cpuSeconds: undefined,
        cpuPercent: pcpu,
      });
    }
    return rows;
  }

  /** Windows: `Get-CimInstance Win32_Process`の1回の呼び出しで全プロセスを取る。 */
  private async listWindowsProcesses(): Promise<Map<number, ProcessRow>> {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { ' +
      '"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $([UInt64]$_.KernelModeTime + [UInt64]$_.UserModeTime)" }';
    const out = await this.ports.execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    const rows = new Map<number, ProcessRow>();
    for (const line of out.split('\n')) {
      const [pid, ppid, rss, cpuUnits] = line.trim().split(/\s+/).map(toNumber);
      if (pid === undefined || ppid === undefined) {
        continue;
      }
      rows.set(pid, {
        pid,
        ppid,
        rssBytes: rss,
        cpuSeconds: cpuUnits === undefined ? undefined : cpuUnits / WINDOWS_CPU_TIME_UNITS_PER_SECOND,
        cpuPercent: undefined,
      });
    }
    return rows;
  }

  private async readOptional(path: string): Promise<string | undefined> {
    try {
      return await this.ports.readFile(path);
    } catch {
      return undefined;
    }
  }
}

/**
 * `/proc/<pid>/stat`の1行を読む。2番目の欄（コマンド名）は括弧の中に空白や括弧を含みうるため、
 * 最後の`)`より後ろを空白で区切る。区切った先頭が3番目の欄（状態）になる。
 */
function parseLinuxStat(pid: number, stat: string): ProcessRow | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) {
    return undefined;
  }
  const fields = stat.slice(close + 2).split(' ');
  // 欄の番号nは`fields[n - 3]`。4: ppid、14: utime、15: stime
  const ppid = toNumber(fields[1]);
  const utime = toNumber(fields[11]);
  const stime = toNumber(fields[12]);
  if (ppid === undefined) {
    return undefined;
  }
  return {
    pid,
    ppid,
    rssBytes: undefined,
    cpuSeconds:
      utime === undefined || stime === undefined
        ? undefined
        : (utime + stime) / LINUX_CLOCK_TICKS_PER_SECOND,
    cpuPercent: undefined,
  };
}

function buildChildren(rows: ReadonlyMap<number, ProcessRow>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of rows.values()) {
    if (row.ppid === row.pid) {
      continue;
    }
    const list = children.get(row.ppid);
    if (list === undefined) {
      children.set(row.ppid, [row.pid]);
    } else {
      list.push(row.pid);
    }
  }
  return children;
}

/** 根とその子孫のpid（根が先、幅優先）。根が一覧に無ければ空。 */
function collectTree(
  root: number,
  rows: ReadonlyMap<number, ProcessRow>,
  children: ReadonlyMap<number, readonly number[]>,
): number[] {
  if (!rows.has(root)) {
    return [];
  }
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i += 1) {
    for (const child of children.get(queue[i] ?? -1) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return queue;
}

/** 一時停止で子孫プロセスへSIGTERMを送ってから、残っていればSIGKILLを送るまでの猶予。 */
const DESCENDANT_KILL_GRACE_MS = 3000;

/** 猶予の間に子孫が終わったかを確かめる間隔。 */
const DESCENDANT_POLL_MS = 200;

/**
 * 根のプロセスの子孫を終わらせる（工程の一時停止。Issue #1629）。根そのものは呼び出し側が
 * 止める。根を止めると子孫は親を失って`init`の子になり、ツリーからたどれなくなるため、
 * 根より先に呼ぶ。SIGTERMを送り、猶予の後も残っていればSIGKILLを送る。終わるまで待ってから返る。
 *
 * Windowsは`taskkill /T /F`で根ごと止める（シグナルの段階は無い）。
 */
export async function terminateDescendants(
  rootPid: number,
  ports: ResourceSamplerPorts = defaultResourceSamplerPorts(),
): Promise<void> {
  if (ports.platform === 'win32') {
    await ports.execFile('taskkill', ['/PID', String(rootPid), '/T', '/F']);
    return;
  }
  const sampler = new ResourceSampler(ports);
  const pids = await sampler.listDescendantPids(rootPid);
  const signal = (targets: readonly number[], sig: NodeJS.Signals): void => {
    for (const pid of targets) {
      try {
        process.kill(pid, sig);
      } catch {
        // 既に終わった
      }
    }
  };
  signal(pids, 'SIGTERM');
  if (pids.length === 0) {
    return;
  }
  // 呼び出し側がメモリを空けたと報告できるよう、終わるまで待つ（全部終われば猶予を待たずに抜ける）
  const deadline = ports.now() + DESCENDANT_KILL_GRACE_MS;
  while (ports.now() < deadline && pids.some(isPidAlive)) {
    await new Promise((resolve) => setTimeout(resolve, DESCENDANT_POLL_MS));
  }
  // 猶予の後も根の子孫として残るものだけに送る。猶予の前の一覧をそのまま使うと、その間に
  // 終わったpidが無関係なプロセスへ再利用されていた場合に誤って止める
  const remaining = new Set(await sampler.listDescendantPids(rootPid));
  signal(pids.filter((pid) => remaining.has(pid)), 'SIGKILL');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // 権限が無いだけなら生きている
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
