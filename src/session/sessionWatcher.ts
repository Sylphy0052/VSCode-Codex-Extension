import * as vscode from 'vscode';
import type { CodexPaths } from '../codex/cliLocator';

export interface SessionWatcherHandlers {
  /** ロールアウトが新規に作られた。紐付けの検知トリガー（設計書 §9.1）。 */
  onRolloutCreated(filePath: string): void;
  /** ロールアウトが追記された。使用量の更新契機（頻発するため呼び先で間引く）。 */
  onRolloutChanged(): void;
  /** session_index.jsonl が変化した。一覧とタブ名の更新契機。 */
  onIndexChanged(): void;
}

/**
 * ~/.codex を監視する。ワークスペース外のパスだが、RelativePattern に Uri を渡せば
 * VSCodeのウォッチャで扱える。
 */
export class SessionWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(paths: CodexPaths, handlers: SessionWatcherHandlers) {
    const rollouts = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(paths.sessions), '**/rollout-*.jsonl'),
      false,
      false,
      true,
    );
    this.disposables.push(
      rollouts,
      // 作成は紐付けに、追記は使用量の更新に使う（1行目は不変なのでmeta再読込は不要）
      rollouts.onDidCreate((uri) => {
        handlers.onRolloutCreated(uri.fsPath);
        handlers.onRolloutChanged();
      }),
      rollouts.onDidChange(() => handlers.onRolloutChanged()),
    );

    const index = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(paths.home), 'session_index.jsonl'),
    );
    this.disposables.push(
      index,
      index.onDidCreate(() => handlers.onIndexChanged()),
      index.onDidChange(() => handlers.onIndexChanged()),
      index.onDidDelete(() => handlers.onIndexChanged()),
    );

    // アーカイブ操作でファイルが移動するため、一覧の更新契機として拾う
    const archived = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(paths.archivedSessions), 'rollout-*.jsonl'),
    );
    this.disposables.push(
      archived,
      archived.onDidCreate(() => handlers.onIndexChanged()),
      archived.onDidDelete(() => handlers.onIndexChanged()),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
