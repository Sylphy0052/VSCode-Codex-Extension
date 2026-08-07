import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LocatorDeps {
  isExecutable(candidate: string): boolean;
  env: NodeJS.ProcessEnv;
  homedir(): string;
  /** PATH区切り文字。テストでプラットフォームを固定するために注入する。 */
  delimiter: string;
}

export const nodeLocatorDeps: LocatorDeps = {
  isExecutable(candidate: string): boolean {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
  env: process.env,
  homedir: os.homedir,
  delimiter: path.delimiter,
};

export type LocateResult =
  | { ok: true; path: string; source: 'setting' | 'path' }
  | { ok: false; reason: 'setting-not-executable' | 'not-found'; attempted: string };

/**
 * codex実行ファイルを解決する。
 *
 * `configured` は machine スコープ設定 `codex.executablePath`（設計書 §7）。
 * リポジトリ側の設定から差し替えられないため、ここでの値は信頼してよい。
 */
export function resolveCodexPath(configured: string, deps: LocatorDeps): LocateResult {
  return resolveExecutable(configured, 'codex', deps);
}

/**
 * PATH（またはパス指定）から実行ファイルを解決する。プロバイダ共通。
 *
 * `configured` は machine スコープ設定のため、ここでの値は信頼してよい。
 */
export function resolveExecutable(
  configured: string,
  defaultName: string,
  deps: LocatorDeps,
): LocateResult {
  const trimmed = configured.trim();

  // 明示指定がパスを含む場合は、それだけを見る。PATHへのフォールバックはしない
  // （指定が誤っていることに気づけなくなるため）。
  if (trimmed !== '' && trimmed.includes('/')) {
    return deps.isExecutable(trimmed)
      ? { ok: true, path: trimmed, source: 'setting' }
      : { ok: false, reason: 'setting-not-executable', attempted: trimmed };
  }

  const name = trimmed === '' ? defaultName : trimmed;
  const dirs = (deps.env['PATH'] ?? '').split(deps.delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    const candidate = `${dir}/${name}`;
    if (deps.isExecutable(candidate)) {
      return { ok: true, path: candidate, source: 'path' };
    }
  }

  return { ok: false, reason: 'not-found', attempted: name };
}

/**
 * CODEX_HOME の解決。設定 > 環境変数 > ~/.codex の順（設計書 §4.3）。
 */
export function resolveCodexHome(configured: string, deps: LocatorDeps): string {
  const trimmed = configured.trim();
  if (trimmed !== '') {
    return trimmed;
  }

  const fromEnv = deps.env['CODEX_HOME'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv;
  }

  return `${deps.homedir()}/.codex`;
}

export interface CodexPaths {
  home: string;
  sessions: string;
  archivedSessions: string;
  sessionIndex: string;
  /** Codexが更新するモデル一覧。こちらからは読むだけ。 */
  modelsCache: string;
  /** Codex側の既定値。拡張機能の設定が空のときに実際に使われる値の表示に使う。 */
  configToml: string;
}

/**
 * アーカイブ済みセッションは archived_sessions/ へフラットに移動される。
 * どちらのディレクトリに在るかがアーカイブ状態の判定そのものになる（設計書 §4.2）。
 */
export function codexPaths(home: string): CodexPaths {
  return {
    home,
    sessions: `${home}/sessions`,
    archivedSessions: `${home}/archived_sessions`,
    sessionIndex: `${home}/session_index.jsonl`,
    modelsCache: `${home}/models_cache.json`,
    configToml: `${home}/config.toml`,
  };
}
