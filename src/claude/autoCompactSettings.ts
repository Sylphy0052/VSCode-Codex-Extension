import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MIN_AUTO_COMPACT_LIMIT } from '../appserver/chatState';
import type { Logger } from '../log';

/** settings.jsonとして読むファイルの大きさの上限。これを超えるものは読まない。 */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * settingsの `autoCompactWindow` を読む（Issue #1747）。
 *
 * control protocolには現在値を問い合わせる手段が無い（`initialize` / `get_settings` のどちらの
 * 応答にも出ない。`chatState.ts` の `AutocompactWindowView` 参照）ため、CLIと同じファイルを
 * 直接読む。優先順はCLIと同じく local > project > user で、最初に有効な値が見つかった層を使う。
 * どの層にも無ければ `undefined` を返し、残量は従来どおりモデルの上限を分母にする。
 */
export function readClaudeAutoCompactWindow(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string) => string | undefined = (path) => readTextOrUndefined(path, log),
  log?: Logger,
): number | undefined {
  const fromEnv = env['CLAUDE_CONFIG_DIR'];
  const home =
    fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.claude');
  const candidates = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(home, 'settings.json'),
  ];
  for (const path of candidates) {
    const text = readText(path);
    const value = text === undefined ? undefined : extractAutoCompactWindow(text);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** settingsの本文から `autoCompactWindow` を取り出す。正の有限数でなければ `undefined`。 */
export function extractAutoCompactWindow(content: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const value = (parsed as Record<string, unknown>)['autoCompactWindow'];
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_AUTO_COMPACT_LIMIT
    ? value
    : undefined;
}

function readTextOrUndefined(path: string, log: Logger | undefined): string | undefined {
  try {
    const stat = statSync(path);
    // FIFOや巨大なファイルを同期で読むと拡張ホストが止まる
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) {
      log?.info(`[claude] settingsを読みません（通常ファイルでないか大きすぎます）: ${path}`);
      return undefined;
    }
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log?.info(`[claude] settingsを読めません: ${path}: ${String(e)}`);
    }
    return undefined;
  }
}
