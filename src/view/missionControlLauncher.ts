import * as fsPromises from 'node:fs/promises';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import {
  nodeGitCommandRunner,
  nodeWorktreeFileSystem,
  WorktreeCreationQueue,
} from '../orchestrator/worktree';
import { withSafeGitConfig } from './missionControlGit';
import type { McProvider } from '../webview/missionControl/protocol';
import {
  buildLaunchRepos,
  launchMissionControlSession,
  pushRecentRepo,
  readRecentRepos,
} from './missionControlLaunch';
import type { McRepoResolver } from './missionControlModel';
import type { McLaunchPort } from './missionControlView';

/** Mission Controlから最近起動したrepo（globalState）。 */
const RECENT_REPOS_KEY = 'agent.missionControl.recentRepos';

const DEFAULT_STALL_MINUTES = 5;
const MAX_STALL_MINUTES = 1440;

/** 設定`agent.missionControl.stallMinutes`をmsで返す。範囲外・数値でない値は既定へ丸める。 */
export function readMissionControlStallMs(): number {
  const raw = vscode.workspace
    .getConfiguration('agent')
    .get<unknown>('missionControl.stallMinutes', DEFAULT_STALL_MINUTES);
  const minutes =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 && raw <= MAX_STALL_MINUTES
      ? raw
      : DEFAULT_STALL_MINUTES;
  return minutes * 60_000;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export interface MissionControlLauncherDeps {
  resolveRepo: McRepoResolver;
  globalState: vscode.Memento;
  /** 開いているセッションのcwd（全ウィンドウ）。 */
  sessionCwds(): Array<string | undefined>;
  /** 履歴に出るセッションのcwd（新しい順）。 */
  historyCwds(): Promise<Array<string | undefined>>;
  /** 既存の`openNew` / `openNewWithPrompt`で会話を開く。 */
  open(provider: McProvider, cwd: string, prompt: string): Promise<string | undefined>;
  log: Logger;
}

/** Mission Controlの新規起動（Issue #2137の1・2）のうち、vscodeに依る部分を組む。 */
export function createMissionControlLauncher(deps: MissionControlLauncherDeps): McLaunchPort {
  const worktrees = new WorktreeCreationQueue();
  const recent = (): string[] => readRecentRepos(deps.globalState.get<unknown>(RECENT_REPOS_KEY));
  const defined = (values: Array<string | undefined>): string[] =>
    values.filter((v): v is string => v !== undefined);
  return {
    async options() {
      let history: string[] = [];
      try {
        history = defined(await deps.historyCwds());
      } catch (e: unknown) {
        // 履歴が読めなくても、開いているセッションと最近使ったrepoは出す
        deps.log.warn(`Mission Control: 履歴から起動先の候補を読めませんでした: ${String(e)}`);
      }
      return buildLaunchRepos(
        { recent: recent(), sessionCwds: defined(deps.sessionCwds()), historyCwds: history },
        deps.resolveRepo,
        isDirectory,
      );
    },
    async pickFolder() {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'このフォルダで起動',
        title: 'Mission Control: 新規セッションの作業フォルダ',
      });
      const folder = picked?.[0];
      if (folder === undefined || folder.scheme !== 'file') {
        return undefined;
      }
      const info = deps.resolveRepo(folder.fsPath);
      return { path: folder.fsPath, key: info.key, label: info.label, source: 'picked' };
    },
    async launch(request) {
      const result = await launchMissionControlSession(request, {
        git: withSafeGitConfig(nodeGitCommandRunner),
        worktreeFs: nodeWorktreeFileSystem,
        worktrees,
        isDirectory,
        appendExclude: async (file, line) => {
          const current = await fsPromises.readFile(file, 'utf8').catch(() => '');
          if (current.split(/\r?\n/u).includes(line)) {
            return;
          }
          const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
          await fsPromises.appendFile(file, `${prefix}${line}\n`, 'utf8');
        },
        open: deps.open,
      });
      if (result.ok) {
        await deps.globalState.update(RECENT_REPOS_KEY, pushRecentRepo(recent(), request.cwd));
      }
      return result;
    },
  };
}
