import * as vscode from 'vscode';
import type { ClaudePaths } from './cliLocator';

export interface TranscriptWatcherHandlers {
  /** transcriptが作られた/追記された。一覧と作業記録の更新契機。 */
  onTranscriptChanged(filePath: string): void;
}

/**
 * `~/.claude/projects` を監視する。
 *
 * Claude Codeには `session_index.jsonl` にあたる索引が無いため、
 * transcript そのものの作成・追記を一覧更新の契機にする。
 */
export class ClaudeTranscriptWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(paths: ClaudePaths, handlers: TranscriptWatcherHandlers) {
    const transcripts = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(paths.projects), '**/*.jsonl'),
    );
    this.disposables.push(
      transcripts,
      transcripts.onDidCreate((uri) => handlers.onTranscriptChanged(uri.fsPath)),
      transcripts.onDidChange((uri) => handlers.onTranscriptChanged(uri.fsPath)),
      transcripts.onDidDelete((uri) => handlers.onTranscriptChanged(uri.fsPath)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
