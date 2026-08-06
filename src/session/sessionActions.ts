import { execFile } from 'node:child_process';
import { isSessionId } from '../codex/argvBuilder';

export type SessionAction = 'archive' | 'unarchive' | 'delete';

export interface CommandResult {
  code: number;
  stderr: string;
}

export interface CommandRunner {
  run(executable: string, args: string[]): Promise<CommandResult>;
}

/**
 * 破壊操作の引数を組み立てる。
 *
 * `delete` は対話端末が無いと拒否されるため `--force` が必須（実機検証済み）。
 * 拡張機能はTTYを持たないので、ユーザーへの確認は呼び出し側のダイアログで行う。
 */
export function buildActionArgs(action: SessionAction, sessionId: string): string[] {
  if (!isSessionId(sessionId)) {
    throw new Error(`不正なsession id: ${sessionId}`);
  }
  return action === 'delete' ? ['delete', '--force', sessionId] : [action, sessionId];
}

export const nodeCommandRunner: CommandRunner = {
  run(executable: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(executable, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stderr: stderr === '' ? error.message : stderr });
      });
    });
  },
};

export class SessionActions {
  constructor(
    private readonly runner: CommandRunner,
    private readonly codexPath: () => string,
  ) {}

  async run(action: SessionAction, sessionId: string): Promise<CommandResult> {
    return this.runner.run(this.codexPath(), buildActionArgs(action, sessionId));
  }
}
