import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readNotificationsConfig } from '../config';
import type { Logger } from '../log';
import type { GitCommandRunner } from '../orchestrator/worktree';
import { formatSessionTarget } from '../orchestrator/sessionBridge';
import type { McProvider } from '../webview/missionControl/protocol';
import { McNotifier, notificationMessage } from './missionControlNotifier';
import type { ReviewTracker } from './missionControlReview';
import type { RunningTurnEntry } from './missionControlResume';
import type { McHostPort } from './missionControlView';
import { playNotificationSound } from './notificationSound';

/**
 * Mission Controlのレビュー待ち・再開待ち・Reload・通知（Issue #2138）のうち、vscodeに依る部分。
 */

/** diffエディタの左側（比較元のファイル）を読む仮想ドキュメントのscheme。 */
export const MC_BASE_SCHEME = 'agent-mc-base';

export interface McHostDeps {
  review: ReviewTracker;
  git: GitCommandRunner;
  windowId: string;
  /** Reloadで切れた会話（`provider:threadId` → 中身）。再開・外すとここから消す。 */
  resumable: Map<string, RunningTurnEntry>;
  openThread(
    provider: McProvider,
    threadId: string,
    title: string,
    cwd: string | undefined,
  ): Promise<void>;
  /** このウィンドウで実行中のターンを持つ会話の数。 */
  runningTurnCount(): number;
  /** MCを開く（通知の「開く」）。 */
  showMissionControl(): void;
  log: Logger;
}

export function resumeKey(target: { provider: McProvider; threadId: string }): string {
  return `${target.provider}:${target.threadId}`;
}

interface BaseQuery {
  key?: string | undefined;
  file?: string | undefined;
}

function baseUri(query: BaseQuery, file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: MC_BASE_SCHEME,
    path: `/${file}`,
    query: JSON.stringify(query),
  });
}

function parseBaseQuery(uri: vscode.Uri): BaseQuery {
  try {
    const value = JSON.parse(uri.query) as unknown;
    if (typeof value !== 'object' || value === null) {
      return {};
    }
    const v = value as Record<string, unknown>;
    return {
      key: typeof v.key === 'string' ? v.key : undefined,
      file: typeof v.file === 'string' ? v.file : undefined,
    };
  } catch {
    return {};
  }
}

export function createMissionControlHost(deps: McHostDeps): {
  port: McHostPort;
  disposables: vscode.Disposable[];
} {
  const notifier = new McNotifier({
    enabled: () => readNotificationsConfig().approvalPending,
    show: (notification) => {
      playNotificationSound('approvalPending', false);
      void vscode.window
        .showInformationMessage(notificationMessage(notification), 'Mission Controlを開く')
        .then((choice) => {
          if (choice !== undefined) {
            deps.showMissionControl();
          }
        });
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  // 比較元の中身は、レビュー待ちの一覧に載っているファイルだけを読む（`diffSource`が確かめる）
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri) => {
      const query = parseBaseQuery(uri);
      if (query.key === undefined || query.file === undefined) {
        return '';
      }
      const source = deps.review.diffSource(query.key, query.file);
      if (source === undefined || source.file.untracked) {
        return '';
      }
      const shown = await deps.git.run(
        ['show', `${source.base}:${source.file.path}`],
        source.toplevel,
      );
      return shown.code === 0 ? shown.stdout : '';
    },
  };

  const port: McHostPort = {
    async openDiff(target, file) {
      const key = formatSessionTarget(target);
      const source = deps.review.diffSource(key, file);
      if (source === undefined) {
        return 'このファイルはレビュー待ちの一覧にありません';
      }
      const absolute = path.join(source.toplevel, source.file.path);
      const left = baseUri({ key, file }, source.file.path);
      // 消したファイルは右側を空の文書にする（実ファイルが無いと開けない）
      const right = existsSync(absolute)
        ? vscode.Uri.file(absolute)
        : baseUri({}, source.file.path);
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${source.file.path}（${path.basename(source.toplevel)}）`,
      );
      return undefined;
    },
    reviewAck(target) {
      return deps.review.acknowledge(formatSessionTarget(target))
        ? undefined
        : 'このセッションはレビュー待ちではありません';
    },
    async resume(target) {
      const entry = deps.resumable.get(resumeKey(target));
      if (entry === undefined || target.windowId !== deps.windowId) {
        return 'この会話は再開待ちではありません';
      }
      await deps.openThread(entry.provider, entry.threadId, entry.title, entry.cwd);
      deps.resumable.delete(resumeKey(target));
      deps.log.info(`Mission Control: Reloadで切れた会話を開き直した（${entry.provider}）`);
      return undefined;
    },
    resumeDismiss(target) {
      return deps.resumable.delete(resumeKey(target))
        ? undefined
        : 'この会話は再開待ちではありません';
    },
    async reloadWindow() {
      const running = deps.runningTurnCount();
      if (running > 0) {
        const proceed = 'Reloadする';
        const choice = await vscode.window.showWarningMessage(
          `実行中のターンが${String(running)}件あります。Reloadすると中断され、Mission Controlに「再開待ち」として出ます。Reloadしますか？`,
          { modal: true },
          proceed,
        );
        if (choice !== proceed) {
          return 'Reloadを取りやめました';
        }
      }
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return undefined;
    },
    observe(snapshot, foreground) {
      notifier.observe(snapshot, foreground);
    },
  };

  return {
    port,
    disposables: [
      vscode.workspace.registerTextDocumentContentProvider(MC_BASE_SCHEME, provider),
      { dispose: () => notifier.dispose() },
    ],
  };
}

/** 会話の`activity`から、Reloadで切れる「実行中のターン」かを判定する。 */
export function isRunningTurn(activity: string): boolean {
  return activity !== 'idle';
}
