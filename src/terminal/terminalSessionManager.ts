import * as vscode from 'vscode';
import { buildLaunchEnv, buildShellArgs } from '../codex/argvBuilder';
import { parseSessionMeta } from '../codex/sessionMeta';
import type { CodexConfig, LaunchTarget } from '../codex/types';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import { SessionBinder, createLaunchTag } from './sessionBinder';

/** 起動失敗とみなす猶予。これより早い異常終了はユーザーに通知する（設計書 §5.6）。 */
const STARTUP_FAILURE_WINDOW_MS = 5_000;

export interface TrackedTerminal {
  terminal: vscode.Terminal;
  tag: string;
  startedAt: number;
  /** 紐付けが確定するまで undefined。未確定のタブは復元対象にしない。 */
  sessionId: string | undefined;
  cwd: string | undefined;
  /** Codexが付けた要約名。タブ名の追従と復元時の表示に使う。 */
  threadName: string | undefined;
}

export interface LaunchRequest {
  target: LaunchTarget;
  cwd: string | undefined;
  config: CodexConfig;
  name: string;
  /** 復元時は列を指定しフォーカスを奪わない（設計書 §5.5）。 */
  location?: vscode.TerminalEditorLocationOptions;
  /** resume/fork では起動前からidが判っているため、紐付けを待たずに確定させる。 */
  sessionId?: string;
  /** resume時は既知の要約名。 */
  threadName?: string;
}

export interface ManagerHandlers {
  /** 紐付けが確定した。永続化と一覧更新の契機。 */
  onBound(tracked: TrackedTerminal): void;
  /** 追跡していた端末が閉じた。永続化から落とす。 */
  onClosed(tracked: TrackedTerminal, exitCode: number | undefined): void;
}

export class TerminalSessionManager implements vscode.Disposable {
  private readonly tracked = new Map<vscode.Terminal, TrackedTerminal>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    /** 設定変更に追従するため、起動のたびに解決し直す。 */
    private readonly codexPath: () => string,
    private readonly binder: SessionBinder,
    private readonly fs: FileSystemPort,
    private readonly log: Logger,
    private readonly handlers: ManagerHandlers,
  ) {
    this.disposables.push(vscode.window.onDidCloseTerminal((t) => this.handleClosed(t)));
  }

  /**
   * Codexをエディタタブとして起動する。
   * シェルを経由せずプロセスそのものをCodexにするため、引数のエスケープは不要
   * （設計書 §5.2）。
   */
  launch(request: LaunchRequest): { terminal: vscode.Terminal; warnings: string[] } {
    const { args, warnings } = buildShellArgs({
      target: request.target,
      cwd: request.cwd,
      config: request.config,
    });
    for (const w of warnings) {
      this.log.warn(w);
    }

    const tag = createLaunchTag();
    const terminal = vscode.window.createTerminal({
      name: request.name,
      shellPath: this.codexPath(),
      shellArgs: args,
      env: buildLaunchEnv(tag),
      // -C と重複するが、Codexが -C を解釈する前の起動ディレクトリも合わせておく
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      location: request.location ?? vscode.TerminalLocation.Editor,
      isTransient: true,
    });

    const tracked: TrackedTerminal = {
      terminal,
      tag,
      startedAt: Date.now(),
      // resume/fork は起動前からidが判っているので待つ必要がない
      sessionId: request.sessionId,
      cwd: request.cwd,
      threadName: request.threadName,
    };
    this.tracked.set(terminal, tracked);

    if (request.sessionId === undefined) {
      this.binder.register(tag);
    }

    this.log.info(`起動 tag=${tag} args=${JSON.stringify(args)}`);
    if (request.sessionId === undefined) {
      // TUIは最初のユーザー発言時にロールアウトを作るため、それまで紐付かないのが正常。
      this.log.info('Codexに最初の発言をするとセッションidが確定します');
    }
    return { terminal, warnings };
  }

  /** ロールアウトの新規作成通知を受けて紐付けを試みる。 */
  async handleRolloutCreated(filePath: string): Promise<void> {
    if (this.binder.pendingTags().length === 0) {
      return;
    }

    const line = await this.fs.readFirstLine(filePath);
    if (line === undefined) {
      return;
    }

    const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
    const bound = this.binder.onRolloutCreated(fileName, parseSessionMeta(line));
    if (bound === undefined) {
      return;
    }

    const tracked = this.findByTag(bound.tag);
    if (tracked === undefined) {
      // 端末が既に閉じている。紐付けだけ捨てる
      return;
    }

    tracked.sessionId = bound.sessionId;
    tracked.cwd = bound.cwd;
    this.log.info(`紐付け確定 tag=${bound.tag} session=${bound.sessionId}`);
    this.handlers.onBound(tracked);
  }

  findBySessionId(sessionId: string): TrackedTerminal | undefined {
    for (const tracked of this.tracked.values()) {
      if (tracked.sessionId === sessionId) {
        return tracked;
      }
    }
    return undefined;
  }

  /** 紐付けが確定しているタブだけを、生成順に返す。 */
  trackedSessions(): TrackedTerminal[] {
    return [...this.tracked.values()].filter((t) => t.sessionId !== undefined);
  }

  /** Codexが要約名を確定/更新したときに反映する。 */
  setThreadName(sessionId: string, threadName: string): TrackedTerminal | undefined {
    const tracked = this.findBySessionId(sessionId);
    if (tracked === undefined || tracked.threadName === threadName) {
      return undefined;
    }
    tracked.threadName = threadName;
    return tracked;
  }

  openSessionIds(): string[] {
    return [...this.tracked.values()]
      .map((t) => t.sessionId)
      .filter((id): id is string => id !== undefined);
  }

  private findByTag(tag: string): TrackedTerminal | undefined {
    for (const tracked of this.tracked.values()) {
      if (tracked.tag === tag) {
        return tracked;
      }
    }
    return undefined;
  }

  private handleClosed(terminal: vscode.Terminal): void {
    const tracked = this.tracked.get(terminal);
    if (tracked === undefined) {
      return;
    }
    this.tracked.delete(terminal);
    this.binder.cancel(tracked.tag);

    const status = terminal.exitStatus;
    const code = status?.code;
    const lived = Date.now() - tracked.startedAt;

    if (code !== undefined && code !== 0 && lived < STARTUP_FAILURE_WINDOW_MS) {
      this.log.error(
        `起動に失敗しました (exit ${code})。codexの導入とログイン状態を確認してください`,
      );
      void vscode.window
        .showErrorMessage(`Codexの起動に失敗しました (exit ${code})`, '出力を表示')
        .then((choice) => {
          if (choice !== undefined) {
            this.log.show();
          }
        });
    } else {
      this.log.info(`終了 tag=${tracked.tag} exit=${code ?? 'n/a'}`);
    }

    this.handlers.onClosed(tracked, code);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.tracked.clear();
  }
}
