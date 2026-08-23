import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

/**
 * チャット画面の統合テスト（Issue #186）が使うフェイク。
 *
 * 実VSCode上でCLI（codex / claude）を起動することはできないため、**CLIとの境界だけ**を
 * ここへ差し替える。会話の組み立て・承認の往復・状態遷移・パネルの復元は実物を通る。
 */

/** `JsonRpcMessage`（`src/appserver/jsonRpc.ts`）と構造互換な最小の口。 */
export interface JsonRpcMessageLike {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
}

/** `AppServerConnectionPort`（`src/appserver/connection.ts`）と構造互換な口。 */
export interface AppServerConnectionPortLike {
  ensureStarted(): Promise<void>;
  request(method: string, params: unknown): Promise<JsonRpcMessageLike>;
  dispose(): void;
}

/**
 * `codex app-server` との接続のフェイク。要求を記録し、`respond` で登録した応答を返す。
 *
 * 通知（`item/*` など）と承認要求は、`ChatViewManager` から渡されたハンドラを
 * `notify` / `serverRequest` で直接呼んで流し込む（本物の接続がプロセスから受け取って
 * 呼ぶのと同じ経路）。
 */
export class FakeAppServerConnection implements AppServerConnectionPortLike {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  startedCount = 0;
  disposed = false;
  private readonly responders = new Map<string, (params: unknown) => unknown>();
  /** `failNext` で登録した、次の1回だけ拒否させる要求。 */
  private readonly failures = new Map<string, () => Error>();

  constructor(
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onServerRequest: (request: unknown) => Promise<unknown>,
  ) {}

  /**
   * 次にその要求が来たとき、応答の代わりに一度だけ拒否させる（C-13: `turn/steer` が
   * ターンの入れ替わりで失敗し、待ち行列へ積み直される競合を再現するのに使う）。
   */
  failNext(method: string, message: string): void {
    this.failures.set(method, () => new Error(message));
  }

  /** `method` への応答（`result` の中身）を決める。登録が無ければ空オブジェクトを返す。 */
  respond(method: string, build: (params: unknown) => unknown): void {
    this.responders.set(method, build);
  }

  /** その要求が来たかどうか。 */
  called(method: string): boolean {
    return this.calls.some((c) => c.method === method);
  }

  /** その要求のうち最初のもの。 */
  firstCall(method: string): { method: string; params: unknown } | undefined {
    return this.calls.find((c) => c.method === method);
  }

  /** その要求のうち最後のもの。同じmethodを複数回呼ぶケース（steer・待ち行列など）で使う。 */
  lastCall(method: string): { method: string; params: unknown } | undefined {
    return [...this.calls].reverse().find((c) => c.method === method);
  }

  /** その要求が来た回数と順序。呼ばれた順を確かめたいケース（分岐→resumeなど）で使う。 */
  callsFor(method: string): Array<{ method: string; params: unknown }> {
    return this.calls.filter((c) => c.method === method);
  }

  /** サーバからの通知を流し込む。 */
  notify(method: string, params: Record<string, unknown>): void {
    this.onNotification(method, params);
  }

  /** サーバからの要求（承認など）を流し込む。 */
  serverRequest(request: unknown): Promise<unknown> {
    return this.onServerRequest(request);
  }

  ensureStarted(): Promise<void> {
    this.startedCount += 1;
    return Promise.resolve();
  }

  request(method: string, params: unknown): Promise<JsonRpcMessageLike> {
    this.calls.push({ method, params });
    const failer = this.failures.get(method);
    if (failer !== undefined) {
      this.failures.delete(method);
      return Promise.reject(failer());
    }
    const build = this.responders.get(method);
    return Promise.resolve({
      jsonrpc: '2.0',
      id: this.calls.length,
      result: build?.(params) ?? {},
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * `claude` プロセスのフェイク。`stdin` へ書かれた行（control_request と stream-json）を
 * 記録し、`emit` で `stdout` へ応答を流す。
 *
 * `ClaudeStreamSession` は実物のまま動くため、**送っているJSONの中身と順序**をここで
 * そのまま観測できる。
 */
export class FakeClaudeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  killed = false;
  readonly pid = 4242;
  readonly stdin: Writable;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.written.push(chunk.toString());
        callback();
      },
    });
  }

  /** `stdin` へ書かれた内容を1行ずつのJSONとして読む（空行は捨てる）。 */
  writtenLines(): Array<Record<string, unknown>> {
    return this.written
      .join('')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }

  /** `stdout` へ1行流す（CLIからの出力に相当）。 */
  emitLine(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

/** 起動されたフェイクプロセスを覚えておく `ClaudeSpawnPort` 互換の関数を作る。 */
export function createFakeClaudeSpawn(): {
  spawn: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => FakeClaudeProcess;
  processes: FakeClaudeProcess[];
  calls: Array<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }>;
} {
  const processes: FakeClaudeProcess[] = [];
  const calls: Array<{
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }> = [];
  return {
    processes,
    calls,
    spawn: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      const proc = new FakeClaudeProcess();
      processes.push(proc);
      return proc;
    },
  };
}
