import * as fsPromises from 'node:fs/promises';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import {
  nodeGitCommandRunner,
  nodeWorktreeFileSystem,
  WorktreeCreationQueue,
} from '../orchestrator/worktree';
import { withSafeGitConfig } from './missionControlGit';
import type { McLaunchDefaults, McProvider } from '../webview/missionControl/protocol';
import {
  buildLaunchRepos,
  launchMissionControlSession,
  pushRecentRepo,
  readRecentRepos,
} from './missionControlLaunch';
import {
  buildLaunchChoices,
  readLaunchDefaults,
  rememberLaunchDefaults,
  resolveLaunchSettings,
  type EffectiveLaunchSettings,
  type LaunchCatalog,
} from './missionControlLaunchOptions';
import type { McRepoResolver } from './missionControlModel';
import type { McLaunchPort } from './missionControlView';

/** Mission Controlから最近起動したrepo（globalState）。 */
const RECENT_REPOS_KEY = 'agent.missionControl.recentRepos';
/** repoごとの前回の起動オプション（globalState。Issue #2149の2）。 */
const LAUNCH_DEFAULTS_KEY = 'agent.missionControl.launchDefaults';

const DEFAULT_STALL_MINUTES = 5;
const DEFAULT_REPLY_WAIT_MINUTES = 30;
const MAX_MINUTES = 1440;

/** `agent`節の分数の設定をmsで返す。範囲外（1〜1440）・数値でない値は既定へ丸める。 */
function readMinutesMs(key: string, fallback: number): number {
  const raw = vscode.workspace.getConfiguration('agent').get<unknown>(key, fallback);
  const minutes =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 && raw <= MAX_MINUTES
      ? raw
      : fallback;
  return minutes * 60_000;
}

/** 設定`agent.missionControl.stallMinutes`をmsで返す。範囲外・数値でない値は既定へ丸める。 */
export function readMissionControlStallMs(): number {
  return readMinutesMs('missionControl.stallMinutes', DEFAULT_STALL_MINUTES);
}

/** 設定`agent.missionControl.replyWaitMinutes`をmsで返す（Issue #2171）。丸め方は停滞と同じ。 */
export function readMissionControlReplyWaitMs(): number {
  return readMinutesMs('missionControl.replyWaitMinutes', DEFAULT_REPLY_WAIT_MINUTES);
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
  /** 既存の`openNew` / `openNewWithPrompt`で会話を開く。`settings`があればその設定で開く。 */
  open(
    provider: McProvider,
    cwd: string,
    prompt: string,
    settings?: EffectiveLaunchSettings,
  ): Promise<string | undefined>;
  /** model・プリセット・拡張機能の設定（起動オプションの候補と検証に使う）。 */
  catalog(): Promise<LaunchCatalog>;
  log: Logger;
}

/** Mission Controlの新規起動（Issue #2137の1・2）のうち、vscodeに依る部分を組む。 */
export function createMissionControlLauncher(deps: MissionControlLauncherDeps): McLaunchPort {
  const worktrees = new WorktreeCreationQueue();
  const recent = (): string[] => readRecentRepos(deps.globalState.get<unknown>(RECENT_REPOS_KEY));
  const defined = (values: Array<string | undefined>): string[] =>
    values.filter((v): v is string => v !== undefined);
  const defaults = (): Record<string, McLaunchDefaults> =>
    readLaunchDefaults(deps.globalState.get<unknown>(LAUNCH_DEFAULTS_KEY));
  return {
    async choices() {
      return buildLaunchChoices(await deps.catalog(), defaults());
    },
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
      const resolved = resolveLaunchSettings(request.provider, request, await deps.catalog());
      if (resolved !== undefined && 'error' in resolved) {
        return { ok: false, error: resolved.error };
      }
      for (const warning of resolved?.warnings ?? []) {
        deps.log.warn(`Mission Control: ${warning}`);
      }
      const result = await launchMissionControlSession(
        request,
        {
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
        },
        resolved,
      );
      if (result.ok) {
        await deps.globalState.update(RECENT_REPOS_KEY, pushRecentRepo(recent(), request.cwd));
        await deps.globalState.update(
          LAUNCH_DEFAULTS_KEY,
          rememberLaunchDefaults(defaults(), deps.resolveRepo(request.cwd).key, {
            provider: request.provider,
            model: request.model,
            effort: request.effort,
            approval: request.approval,
            preset: request.preset,
          }),
        );
      }
      return result;
    },
  };
}
