import * as vscode from 'vscode';
import type { CodexConfig } from './codex/types';
import type { HistoryScope } from './session/sessionStore';

export interface ExtensionConfig {
  executablePath: string;
  codexHome: string;
  codex: CodexConfig;
  restoreEnabled: boolean;
  restoreMaxTabs: number;
  historyScope: HistoryScope;
  historyMaxEntries: number;
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

  return {
    executablePath: str(c, 'executablePath', 'codex'),
    codexHome: str(c, 'codexHome'),
    codex: {
      model: str(c, 'model'),
      reasoningEffort: str(c, 'reasoningEffort'),
      profile: str(c, 'profile'),
      sandbox: str(c, 'sandbox'),
      approvalMode: str(c, 'approvalMode'),
      additionalArgs: Array.isArray(additional)
        ? additional.filter((a): a is string => typeof a === 'string')
        : [],
    },
    restoreEnabled: c.get<boolean>('restore.enabled') ?? true,
    restoreMaxTabs: num(c, 'restore.maxTabs', 8),
    historyScope: c.get<string>('history.scope') === 'all' ? 'all' : 'workspace',
    historyMaxEntries: num(c, 'history.maxEntries', 200),
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
