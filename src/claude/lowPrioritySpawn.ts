import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClaudeSpawnPort } from './streamSession';

/**
 * 工程セッションのCLIを起動するときのnice値（Issue #1807）。対話中のウィンドウとCPUを同じ条件で
 * 取り合わないよう下げる。
 */
export const LOW_PRIORITY_NICE = 10;

export interface LowPrioritySpawnPorts {
  platform: NodeJS.Platform;
  /** `PATH`から`nice`の実行ファイルを探す。見つからなければ`undefined`。 */
  findNice(pathValue: string | undefined): string | undefined;
  setPriority(pid: number, priority: number): void;
}

const niceCache = new Map<string, string | undefined>();

function findNiceOnPath(pathValue: string | undefined): string | undefined {
  const key = pathValue ?? '';
  if (niceCache.has(key)) {
    return niceCache.get(key);
  }
  let found: string | undefined;
  for (const dir of key.split(path.delimiter)) {
    if (dir === '') {
      continue;
    }
    const candidate = path.join(dir, 'nice');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      found = candidate;
      break;
    } catch {
      // 次の候補へ
    }
  }
  niceCache.set(key, found);
  return found;
}

const DEFAULT_PORTS: LowPrioritySpawnPorts = {
  platform: process.platform,
  findNice: findNiceOnPath,
  setPriority: (pid, priority) => os.setPriority(pid, priority),
};

const defaultSpawn: ClaudeSpawnPort = (command, args, options) =>
  spawn(command, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });

/**
 * CLIを低い優先度で起動する`ClaudeSpawnPort`を返す（Issue #1807）。
 *
 * - Linux・macOS: `nice -n 10 <cli> ...`の形で起動する。spawnした後に`os.setPriority`を掛けると、
 *   起動直後の高負荷の区間に間に合わないため。`nice`はexecでCLIへ置き換わるので、pidはCLIのものになる
 * - Windows: `nice`が無いため、spawnした後に`os.setPriority`で下げる
 *
 * `nice`が見つからない・優先度を下げられないときは、通常の優先度で起動してログに残す（工程は止めない）。
 */
export function lowPrioritySpawn(
  log: (message: string) => void,
  base: ClaudeSpawnPort = defaultSpawn,
  ports: LowPrioritySpawnPorts = DEFAULT_PORTS,
): ClaudeSpawnPort {
  return (command, args, options) => {
    if (ports.platform === 'win32') {
      const child = base(command, args, options);
      if (child.pid !== undefined) {
        try {
          ports.setPriority(child.pid, LOW_PRIORITY_NICE);
        } catch (e) {
          log(
            `CLIの優先度を下げられないため通常の優先度で動かす: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return child;
    }
    const nice = ports.findNice(options.env['PATH']);
    if (nice === undefined) {
      log('niceが見つからないため、CLIを通常の優先度で起動する');
      return base(command, args, options);
    }
    return base(nice, ['-n', String(LOW_PRIORITY_NICE), command, ...args], options);
  };
}
