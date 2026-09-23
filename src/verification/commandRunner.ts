import { spawn, type ChildProcess } from 'node:child_process';

/**
 * `verify.commands` の1コマンドを拡張機能自身が実行する（Issue #1378）。
 *
 * シェル経由で実行する。`verify.commands` は `npm run lint && npm test` のようにシェル構文を
 * 前提に書かれており、引数配列にすると既存の定義が動かなくなる。実行する文字列は定義に
 * 書かれ、利用者に示して許可を得たものそのままで、外から来た値を埋め込まない。
 *
 * 子プロセスが残らないよう、POSIXではプロセスグループとして起動し、時間切れ・中断時は
 * グループごと終了させる（シェルが起こした孫プロセスまで届かせるため）。
 */

/** 1コマンドの時間切れ（ミリ秒） */
export const VERIFY_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;

/** メモリに保持する出力の上限（バイト）。stdoutとstderrを合わせた末尾だけを残す */
export const VERIFY_COMMAND_MAX_OUTPUT_BYTES = 256 * 1024;

/** SIGTERMを送ってからSIGKILLへ切り替えるまでの猶予（ミリ秒） */
export const VERIFY_COMMAND_KILL_GRACE_MS = 3_000;

export interface VerifyCommandResult {
  /** 正常に終了したときのexit code。時間切れ・中断・起動失敗・シグナルでの終了では無い */
  readonly exitCode: number | undefined;
  /** stdoutとstderrを届いた順に合わせた出力の末尾 */
  readonly output: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** 起動に失敗した・シグナルで終了した場合の説明 */
  readonly error?: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
}

export interface RunVerifyCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
}

/** 末尾だけを残すバッファ。上限を超えた分は古い側から捨てる */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const excess = this.size - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        // `subarray` は元の大きなチャンクを掴んだままにするのでコピーする
        this.chunks[0] = Buffer.from(head.subarray(excess));
        this.size -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** プロセスツリーごと終了させる。既に終わっていれば何もしない */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (child.pid === undefined) {
    return;
  }
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => child.kill(signal));
    return;
  }
  // シェル（グループの先頭）が先に終わっても、SIGTERMを無視した孫はグループに残る。
  // 先頭の状態では判断せず、グループへ送る
  try {
    // 負のpidはプロセスグループ全体（`detached: true` で起動したグループ）を指す
    process.kill(-child.pid, signal);
  } catch {
    // グループが既に空なら何もしない
  }
}

export function runVerifyCommand(options: RunVerifyCommandOptions): Promise<VerifyCommandResult> {
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? VERIFY_COMMAND_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? VERIFY_COMMAND_KILL_GRACE_MS;
  const output = new TailBuffer(options.maxOutputBytes ?? VERIFY_COMMAND_MAX_OUTPUT_BYTES);
  const startedAt = now();

  return new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve({
        exitCode: undefined,
        output: '',
        timedOut: false,
        aborted: true,
        startedAt,
        endedAt: now(),
      });
      return;
    }

    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true,
    });

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      killProcessTree(child, 'SIGTERM', platform);
      killTimer ??= setTimeout(() => killProcessTree(child, 'SIGKILL', platform), killGraceMs);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));

    const finish = (
      exitCode: number | undefined,
      error: string | undefined,
      cleanupGroup: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      if (cleanupGroup && platform !== 'win32' && child.pid !== undefined) {
        // シェルが終わっても、バックグラウンドへ回した孫がグループに残りうるので片付ける
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // グループが既に空なら何もしない
        }
      }
      resolve({
        exitCode: timedOut || aborted ? undefined : exitCode,
        output: output.toString(),
        timedOut,
        aborted,
        ...(error === undefined ? {} : { error }),
        startedAt,
        endedAt: now(),
      });
    };

    child.on('error', (error) => finish(undefined, error.message, false));
    child.on('close', (code, signal) => {
      finish(
        code ?? undefined,
        code === null && signal !== null ? `シグナル ${signal} で終了しました` : undefined,
        true,
      );
    });
  });
}
