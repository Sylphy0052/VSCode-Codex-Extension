import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ClaudeConfig } from './claude/types';
import type { CodexConfig } from './codex/types';
import type { HistoryScope } from './session/sessionStore';

export interface ExtensionConfig {
  executablePath: string;
  codexHome: string;
  codex: CodexConfig;
  historyScope: HistoryScope;
  historyMaxEntries: number;
}

/** 日報/週報へ流す作業記録の設定。プロバイダを跨ぐため `agent.*` 名前空間に置く。 */
export interface ActivityLogConfig {
  enabled: boolean;
  /** 空なら `DAILY_BUFFER_DIR` → `~/workspace/dairy/.buffer`（activityLogger が解決）。 */
  dir: string;
}

const str = (c: vscode.WorkspaceConfiguration, key: string, fallback = ''): string => {
  const v = c.get<string>(key);
  return typeof v === 'string' ? v : fallback;
};

const num = (c: vscode.WorkspaceConfiguration, key: string, fallback: number): number => {
  const v = c.get<number>(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/**
 * 実行経路と権限に関わるキーは package.json 側で machine スコープに固定してある。
 * リポジトリの .vscode/settings.json から差し替えられないことが前提（設計書 §7・§8）。
 */
export function readConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration('codex');
  const additional = c.get<unknown>('additionalArgs');
  const writableRoots = c.get<unknown>('sandboxWritableRoots');

  return {
    executablePath: str(c, 'executablePath', 'codex'),
    codexHome: str(c, 'codexHome'),
    codex: {
      model: str(c, 'model'),
      reasoningEffort: str(c, 'reasoningEffort'),
      profile: str(c, 'profile'),
      sandbox: str(c, 'sandbox'),
      sandboxWritableRoots: Array.isArray(writableRoots)
        ? writableRoots.filter((r): r is string => typeof r === 'string')
        : [],
      sandboxNetworkAccess: c.get<boolean>('sandboxNetworkAccess') === true,
      approvalMode: str(c, 'approvalMode'),
      additionalArgs: Array.isArray(additional)
        ? additional.filter((a): a is string => typeof a === 'string')
        : [],
    },
    historyScope: c.get<string>('history.scope') === 'all' ? 'all' : 'workspace',
    historyMaxEntries: num(c, 'history.maxEntries', 200),
  };
}

export interface ClaudeExtensionConfig {
  executablePath: string;
  configDir: string;
  claude: ClaudeConfig;
}

export function readClaudeConfig(): ClaudeExtensionConfig {
  const c = vscode.workspace.getConfiguration('claude');
  const additional = c.get<unknown>('additionalArgs');

  return {
    executablePath: str(c, 'executablePath', 'claude'),
    configDir: str(c, 'configDir'),
    claude: {
      model: str(c, 'model'),
      effort: str(c, 'effort'),
      permissionMode: str(c, 'permissionMode'),
      agent: str(c, 'agent'),
      additionalArgs: Array.isArray(additional)
        ? additional.filter((a): a is string => typeof a === 'string')
        : [],
    },
  };
}

export function readActivityLogConfig(): ActivityLogConfig {
  const c = vscode.workspace.getConfiguration('agent');
  return {
    enabled: c.get<boolean>('activityLog.enabled') ?? true,
    dir: str(c, 'activityLog.dir'),
  };
}

/** ワークフロー実行（design.md §16）の設定。 */
export interface WorkflowsConfig {
  /** 定義ファイルの置き場。ワークスペースフォルダ配下の相対パス（既定 `.agents/workflows`）。 */
  dir: string;
  /**
   * `autoApprove: true` を有効化できるか（machineスコープ）。無効なら、YAMLの指定に
   * 関わらず全ての承認を人へ回す（design.md §16.16）。`clampAutoApprove` の基準値。
   */
  allowAutoApprove: boolean;
  /**
   * ロードマップ（design.md §16.19）の出力先ディレクトリ。ワークスペースフォルダからの
   * 相対パス（既定 `docs/roadmap`）。`agent.workflows.dir` と同じく `machine-overridable`
   * （§16.16「成果の統合まわりの設定」）。出力先のパス自体であって実行するコマンドの選択には
   * 関わらないため、`agent.workflows.forge` / `finalMerge` ほど強い制限（`machine`固定）は要らない。
   */
  roadmapDir: string;
}

const DEFAULT_WORKFLOWS_DIR = '.agents/workflows';
const DEFAULT_ROADMAP_DIR = 'docs/roadmap';

/**
 * `agent.workflows.dir` の値として安全か。絶対パス、または `..` セグメントを含む値は拒否する。
 *
 * このキーは `resource` スコープ（`.vscode/settings.json` から上書きできる）のままにしてある。
 * マルチルートで「ワークスペースフォルダごとに置き場を変えたい」需要が自然にあり、
 * `machine` へ固定するとその用途を潰すため。ただし `resource` スコープはリポジトリ側の
 * 設定ファイルから差し替えられる以上、`..` を含む値でワークスペースフォルダの外を
 * 探索対象に混ぜられる余地は塞ぐ（レビュー指摘: warning）。
 */
function isSafeRelativeDir(value: string): boolean {
  if (value.trim() === '') {
    return false;
  }
  if (path.isAbsolute(value)) {
    return false;
  }
  return !value.split(/[\\/]/u).includes('..');
}

export function readWorkflowsConfig(): WorkflowsConfig {
  const c = vscode.workspace.getConfiguration('agent');
  const rawDir = str(c, 'workflows.dir', DEFAULT_WORKFLOWS_DIR);
  const rawRoadmapDir = str(c, 'workflows.roadmapDir', DEFAULT_ROADMAP_DIR);
  return {
    dir: isSafeRelativeDir(rawDir) ? rawDir : DEFAULT_WORKFLOWS_DIR,
    allowAutoApprove: c.get<boolean>('workflows.allowAutoApprove') ?? false,
    roadmapDir: isSafeRelativeDir(rawRoadmapDir) ? rawRoadmapDir : DEFAULT_ROADMAP_DIR,
  };
}

/** アクティブエディタが属するワークスペースフォルダ。無ければ先頭（設計書 §10）。 */
export function currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active !== undefined) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner !== undefined) {
      return owner;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
