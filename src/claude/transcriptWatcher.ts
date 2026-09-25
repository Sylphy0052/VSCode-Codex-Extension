import * as vscode from 'vscode';
import type { ClaudePaths } from './cliLocator';

export interface TranscriptWatcherHandlers {
  /** transcriptが作られた/追記された。一覧と作業記録の更新契機。 */
  onTranscriptChanged(filePath: string): void;
}

/**
 * ファイル単位の通知の間引き間隔（Issue #1460）。
 *
 * Claude Codeの追記は短時間に連続することがあり、間引かないと1追記ごとに
 * `refreshFile` が走る。最後の変更からこの時間だけ待って1回にまとめる。
 */
const NOTIFY_DEBOUNCE_MS = 500;

/**
 * `~/.claude/projects` を監視する。
 *
 * Claude Codeには `session_index.jsonl` にあたる索引が無いため、
 * transcript そのものの作成・追記を一覧更新の契機にする。
 */
export class ClaudeTranscriptWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** ファイルパスごとの間引きタイマー（Issue #1460）。 */
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(paths: ClaudePaths, handlers: TranscriptWatcherHandlers) {
    const transcripts = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(paths.projects), '**/*.jsonl'),
    );
    const notify = (filePath: string): void => {
      const existing = this.pending.get(filePath);
      if (existing !== undefined) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        this.pending.delete(filePath);
        handlers.onTranscriptChanged(filePath);
      }, NOTIFY_DEBOUNCE_MS);
      timer.unref?.();
      this.pending.set(filePath, timer);
    };
    this.disposables.push(
      transcripts,
      transcripts.onDidCreate((uri) => notify(uri.fsPath)),
      transcripts.onDidChange((uri) => notify(uri.fsPath)),
      transcripts.onDidDelete((uri) => notify(uri.fsPath)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
