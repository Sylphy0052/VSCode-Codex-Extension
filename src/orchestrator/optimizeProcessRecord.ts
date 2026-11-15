import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 拡張が起動したプロセスの記録（Issue #2110）。最適化の試行のセッション（#2107）と計測の
 * プロセスで共用する。
 *
 * `runVerifyCommand`はdetachedで起動するため、拡張が落ちても孤児として残りうる。起動したら
 * PID・プロセスグループID・開始時刻（`/proc/<pid>/stat`の22番目の値）を`dir`（拡張の
 * globalStorage配下。worktreeの外）へ1プロセス1ファイルで残し、Reloadや再開の前に読んで止める。
 * PIDが生きていて開始時刻も一致するときだけグループごと止め、開始時刻が違えばPIDの使い回し
 * とみなして止めずに記録だけ消す。
 */

export interface ProcessRecord {
  pid: number;
  /** `detached`で起動したので通常はpidと同じ。 */
  pgid: number;
  /** `/proc/<pid>/stat`の22番目（起動からのclock tick）。読めない環境では`undefined`。 */
  startTime: string | undefined;
  label: string;
}

export interface ProcessRecordPorts {
  readStat(pid: number): Promise<string | undefined>;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
}

export function defaultProcessRecordPorts(): ProcessRecordPorts {
  return {
    readStat: async (pid) => {
      try {
        return await readFile(`/proc/${pid}/stat`, 'utf8');
      } catch {
        return undefined;
      }
    },
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
  };
}

/**
 * `/proc/<pid>/stat`の22番目（starttime）を取り出す。2番目のプロセス名は空白や括弧を含みうる
 * ため、最後の`)`より後ろを数える（`)`の直後が3番目`state`）。
 */
export function parseStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) {
    return undefined;
  }
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const value = fields[19];
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
}

function recordPath(dir: string, pid: number): string {
  return path.join(dir, `process-${pid}.json`);
}

/** 起動したプロセスを記録する。`onSpawn`から呼ぶ。 */
export async function writeProcessRecord(
  dir: string,
  input: { pid: number; pgid?: number; label: string },
  ports: ProcessRecordPorts = defaultProcessRecordPorts(),
): Promise<void> {
  const stat = await ports.readStat(input.pid);
  const record: ProcessRecord = {
    pid: input.pid,
    pgid: input.pgid ?? input.pid,
    startTime: stat === undefined ? undefined : parseStartTime(stat),
    label: input.label,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(recordPath(dir, input.pid), JSON.stringify(record), 'utf8');
}

export async function removeProcessRecord(dir: string, pid: number): Promise<void> {
  await rm(recordPath(dir, pid), { force: true });
}

function parseRecord(text: string): ProcessRecord | undefined {
  try {
    const raw = JSON.parse(text) as Partial<ProcessRecord> | null;
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !Number.isInteger(raw.pid) ||
      !Number.isInteger(raw.pgid) ||
      (raw.pid ?? 0) <= 1 ||
      (raw.pgid ?? 0) <= 1
    ) {
      return undefined;
    }
    return {
      pid: raw.pid as number,
      pgid: raw.pgid as number,
      startTime: typeof raw.startTime === 'string' ? raw.startTime : undefined,
      label: typeof raw.label === 'string' ? raw.label : '',
    };
  } catch {
    return undefined;
  }
}

export interface StaleProcessReport {
  /** プロセスグループごと止めた記録。 */
  killed: ProcessRecord[];
  /** 止めずに記録だけ消した記録（既に終了、またはPIDの使い回し）。 */
  discarded: ProcessRecord[];
  /** 読めず・消せなかったファイルの数。 */
  unreadable: number;
}

/**
 * 残っている記録を読み、生きていて開始時刻が一致するプロセスだけをグループごと止める。
 * 開始時刻を読めない・記録に無いときは、別のプロセスを止めないよう止めずに記録を消す。
 */
export async function killRecordedProcesses(
  dir: string,
  ports: ProcessRecordPorts = defaultProcessRecordPorts(),
): Promise<StaleProcessReport> {
  const report: StaleProcessReport = { killed: [], discarded: [], unreadable: 0 };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return report;
  }
  for (const name of names.filter((n) => /^process-\d+\.json$/.test(n))) {
    const file = path.join(dir, name);
    let record: ProcessRecord | undefined;
    try {
      record = parseRecord(await readFile(file, 'utf8'));
    } catch {
      record = undefined;
    }
    if (record === undefined) {
      report.unreadable += 1;
      await rm(file, { force: true });
      continue;
    }
    const stat = await ports.readStat(record.pid);
    const current = stat === undefined ? undefined : parseStartTime(stat);
    if (current !== undefined && record.startTime !== undefined && current === record.startTime) {
      try {
        // 負の値はプロセスグループ全体
        ports.kill(-record.pgid, 'SIGKILL');
      } catch {
        // 既に空
      }
      report.killed.push(record);
    } else {
      report.discarded.push(record);
    }
    await rm(file, { force: true });
  }
  return report;
}
