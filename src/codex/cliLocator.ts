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
 * `PATHEXT`（Windowsのみ環境変数として設定される）を考慮した実行ファイル名の候補を返す。
 *
 * Windowsでは`gh` / `glab`のような実行ファイルが`gh.exe` / `glab.cmd`のように拡張子付きで
 * 配置されるため、拡張子なしの名前をそのまま`fs.access`しても見つからない（Issue #404）。
 * `PATHEXT`は`;`区切りの拡張子一覧（例: `.COM;.EXE;.BAT;.CMD`）。未設定・空（Windows以外の
 * 通常の環境）では元の名前だけを候補にする。`name`が既にいずれかの拡張子で終わっている場合
 * （設定で`gh.exe`のように明示された場合）は展開しない。
 *
 * `src/orchestrator/forge.ts`の`nodeCliAvailability.isOnPath`と共有する（重複実装にしない。
 * Issue #404）。
 */
export function executableNameCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const pathext = env['PATHEXT'];
  if (pathext === undefined || pathext.trim() === '') {
    return [name];
  }
  const exts = pathext
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (exts.length === 0) {
    return [name];
  }
  const lowerName = name.toLowerCase();
  if (exts.some((ext) => lowerName.endsWith(ext.toLowerCase()))) {
    return [name];
  }
  return [name, ...exts.map((ext) => `${name}${ext}`)];
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
  // （指定が誤っていることに気づけなくなるため）。拡張子省略（Windowsで`gh`のように
  // 拡張子なしで設定された場合）にも`executableNameCandidates`で対応する。
  if (trimmed !== '' && trimmed.includes('/')) {
    for (const candidate of executableNameCandidates(trimmed, deps.env)) {
      if (deps.isExecutable(candidate)) {
        return { ok: true, path: candidate, source: 'setting' };
      }
    }
    return { ok: false, reason: 'setting-not-executable', attempted: trimmed };
  }

  const name = trimmed === '' ? defaultName : trimmed;
  const dirs = (deps.env['PATH'] ?? '').split(deps.delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    for (const candidateName of executableNameCandidates(name, deps.env)) {
      const candidate = `${dir}/${candidateName}`;
      if (deps.isExecutable(candidate)) {
        return { ok: true, path: candidate, source: 'path' };
      }
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
