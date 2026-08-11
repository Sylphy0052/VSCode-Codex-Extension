import { spawn } from 'node:child_process';

/**
 * bashモード（`!`。design.md §14.29、Issue #5）の1回分の実行結果。
 */
export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  /** プロセスの終了コード。起動に失敗した・タイムアウト/中断で打ち切った場合は null。 */
  code: number | null;
  timedOut: boolean;
  /**
   * `AbortSignal` で中断されたか（タブを閉じた、拡張機能が終了した等。design.md §14.29、
   * Issue #5のレビュー指摘: タブを閉じても実行中のコマンドが生き残る）。
   */
  aborted: boolean;
  /** シェル自体の起動に失敗した理由（ENOENT等）。起動できた場合は undefined。 */
  spawnError: string | undefined;
  /** stdout/stderrいずれかが上限を超えて先頭を切り詰めたか。 */
  truncated: boolean;
}

/**
 * シェルコマンドの実行を1回だけ行う抽象（`src/process/commandRunner.ts` と同じ流儀）。
 * 既定実装はNodeの子プロセス、テストではfakeに差し替える。
 *
 * `signal` が渡され、実行中にabortされたら子プロセスを打ち切り、`aborted: true` で
 * 解決する（rejectはしない。呼び出し側が毎回try/catchを書かずに済むよう、失敗の種類は
 * 常に `ShellCommandResult` の中で表現する方針で揃えてある）。
 */
export interface ShellCommandRunner {
  run(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ShellCommandResult>;
}

/** 出力の上限（1MB程度）。超えた分は先頭を捨てる（`appserver/chatState.ts` の `capOutput` と同じ考え方）。 */
const MAX_OUTPUT_CHARS = 1_000_000;

/**
 * SIGTERM送出後、まだプロセスが決着していなければSIGKILLへエスカレーションするまでの
 * 猶予（ミリ秒）。`trap '' TERM` 等でSIGTERMを無視するプロセスがあると、SIGTERMだけでは
 * `close` イベントが永遠に来ず、会話の「実行中」項目が残り続ける（レビュー指摘。実プロセスで
 * `trap '' TERM; sleep 30` に対して確認済み）。
 */
const DEFAULT_SIGKILL_GRACE_MS = 3000;

function appendCapped(current: string, chunk: string): { text: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= MAX_OUTPUT_CHARS) {
    return { text: combined, truncated: false };
  }
  return { text: combined.slice(combined.length - MAX_OUTPUT_CHARS), truncated: true };
}

/**
 * プロセスグループへシグナルを送る。POSIXでは `detached: true` で起動しているため
 * `-pid`（プロセスグループid）で子孫まで含めて狙える。グループ宛の送出に失敗したら
 * （既に居ない等）通常killへフォールバックする。
 */
function killProcessGroup(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // フォールバックへ続く
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // 既に終了している等。closeイベント待ちに任せる
  }
}

/**
 * `!` の入力をシェルへそのまま渡す既定実装を作る。
 *
 * **意図的にコマンド文字列をサニタイズしない。** bashモードは任意コマンドを通すことが
 * 目的の機能であり、防御は「既定無効（`claude.bashMode.enabled`）」と「実行のたびの
 * モーダル確認」の二重ゲートのみに絞っている（design.md §14.29）。パイプ・リダイレクト・
 * 変数展開が効くよう `shell: true` で実行する。
 *
 * `sigkillGraceMs` はSIGKILLへエスカレーションするまでの猶予をテストから短縮できるよう
 * 引数化してある。既定実装 `nodeShellCommandRunner` は `DEFAULT_SIGKILL_GRACE_MS`（3秒）を使う。
 */
export function createNodeShellCommandRunner(
  sigkillGraceMs: number = DEFAULT_SIGKILL_GRACE_MS,
): ShellCommandRunner {
  return {
    run(
      command: string,
      cwd: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<ShellCommandResult> {
      if (signal?.aborted === true) {
        // 呼び出された時点で既に中断済み。起動そのものをしない
        return Promise.resolve({
          stdout: '',
          stderr: '',
          code: null,
          timedOut: false,
          aborted: true,
          spawnError: undefined,
          truncated: false,
        });
      }

      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let killGraceTimer: ReturnType<typeof setTimeout> | undefined;

        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn(command, {
            cwd,
            shell: true,
            // POSIXではプロセスグループごと殺せるようにする（パイプでできた子プロセスの
            // 取りこぼしを防ぐ）。Windowsでは効かないため通常killへフォールバックする
            detached: process.platform !== 'win32',
          });
        } catch (e) {
          resolve({
            stdout: '',
            stderr: '',
            code: null,
            timedOut: false,
            aborted: false,
            spawnError: e instanceof Error ? e.message : String(e),
            truncated: false,
          });
          return;
        }

        const scheduleKillEscalation = (): void => {
          killGraceTimer = setTimeout(() => {
            killProcessGroup(proc, 'SIGKILL');
          }, sigkillGraceMs);
        };

        const onAbort = (): void => {
          aborted = true;
          killProcessGroup(proc, 'SIGTERM');
          scheduleKillEscalation();
        };
        signal?.addEventListener('abort', onAbort);

        const finish = (result: ShellCommandResult): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearTimeout(killGraceTimer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(proc, 'SIGTERM');
          scheduleKillEscalation();
        }, timeoutMs);

        proc.stdout?.on('data', (chunk: Buffer) => {
          const appended = appendCapped(stdout, chunk.toString('utf8'));
          stdout = appended.text;
          truncated = truncated || appended.truncated;
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          const appended = appendCapped(stderr, chunk.toString('utf8'));
          stderr = appended.text;
          truncated = truncated || appended.truncated;
        });
        proc.on('error', (e: Error) => {
          finish({ stdout, stderr, code: null, timedOut, aborted, spawnError: e.message, truncated });
        });
        proc.on('close', (code) => {
          finish({ stdout, stderr, code, timedOut, aborted, spawnError: undefined, truncated });
        });
      });
    },
  };
}

export const nodeShellCommandRunner: ShellCommandRunner = createNodeShellCommandRunner();
