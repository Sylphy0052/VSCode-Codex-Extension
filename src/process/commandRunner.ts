import { spawn } from 'node:child_process';
import { killWithEscalation } from './childProcess';
import { canWriteStdin, guardStdinErrors } from './stdinSafety';

/**
 * CLIサブコマンドを1回だけ実行する共通の抽象（issue #29）。
 *
 * `src/session/sessionActions.ts` の `CommandRunner` と同じ形だが、標準入力へ値を渡す
 * 経路（`stdin`）を持つ点だけ違う。APIキーでのログイン（`codex login --with-api-key`）は
 * キーを引数ではなく標準入力で渡す必要があるため（`--help` で確認。引数に渡すとプロセス
 * 一覧に平文で残ってしまう）、こちらを別に用意した。
 */
export interface CommandResult {
  code: number;
  stderr: string;
}

export interface CommandRunner {
  run(executable: string, args: string[], stdin?: string): Promise<CommandResult>;
}

/** 応答が返らないまま居座らせない。 */
const TIMEOUT_MS = 30_000;

export const nodeCommandRunner: CommandRunner = {
  run(executable: string, args: string[], stdin?: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const proc = spawn(executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      let settled = false;

      const finish = (result: CommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        // SIGTERMに応答しないハングしたプロセスも回収できるよう、SIGKILLへの
        // エスカレーションを共通処理へ寄せる（issue #402、2点目のLOW対応）。
        killWithEscalation(proc);
        finish({ code: 1, stderr: '応答がありませんでした' });
      }, TIMEOUT_MS);

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      proc.on('error', (e: Error) => finish({ code: 1, stderr: e.message }));
      proc.on('close', (code) => finish({ code: code ?? 1, stderr }));

      // `proc.on('error')`は起動失敗しか拾わない。起動後に相手が終了した状態へ書き込むと
      // 飛ぶEPIPE等はここで捕まえないとNodeの未捕捉例外になる（issue #155、design.md
      // §14.31）。この関数はAPIキーを`stdin`引数で受け取りうる経路（`codex login
      // --with-api-key`）なので、ここでは`e.message`（Nodeのシステムエラー文字列。書き込んだ
      // 内容は含まない）のみを使い、`stdin`引数はいかなる形でもログ・エラーメッセージへ
      // 混ぜないこと。
      guardStdinErrors(proc, (e: Error) => finish({ code: 1, stderr: e.message }));

      if (stdin !== undefined) {
        if (canWriteStdin(proc)) {
          proc.stdin.end(stdin);
        }
      } else if (canWriteStdin(proc)) {
        proc.stdin.end();
      }
    });
  },
};
