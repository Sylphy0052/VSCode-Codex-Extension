import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '../log';
import {
  consumeFrames,
  encodeErrorResponse,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  isServerRequest,
  type JsonRpcMessage,
} from '../codex/jsonRpc';

export interface ServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
/** 応答を返さないとCodexは待ち続けるため、必ず値を解決すること。 */
export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown>;

/**
 * `ChatSession` が実際に使う面だけを切り出した抽象。
 *
 * `AppServerConnection` は構造的にこれを満たすため、実装側は何も変えずそのまま渡せる。
 * テストでは子プロセスを立てないフェイクに差し替え、`thread/start` 等の応答を
 * その場で組み立てられるようにする（design.md §16.10、開始待ちの複数化のテストで使う）。
 */
export interface AppServerConnectionPort {
  ensureStarted(): Promise<void>;
  request(method: string, params: unknown): Promise<JsonRpcMessage>;
  dispose(): void;
}

const CLIENT_NAME = 'vscode-codex-extension';
const CLIENT_VERSION = '0.0.1';
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * `codex app-server` との接続を1本維持する。
 *
 * 会話のストリーミング（item系の通知）と承認要求（requestApproval系）を扱うため、
 * forkだけを行う AppServerClient と違いプロセスを常駐させる。スレッドは複数を
 * 1接続で扱えるので、拡張機能全体で1プロセスに収める。
 */
export class AppServerConnection {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();
  private starting: Promise<void> | undefined;

  constructor(
    private readonly codexPath: () => string,
    private readonly log: Logger,
    private readonly onNotification: NotificationHandler,
    private readonly onServerRequest: ServerRequestHandler,
  ) {}

  /** 起動と初期化。多重呼び出しは同じ処理を共有する。 */
  async ensureStarted(): Promise<void> {
    if (this.proc !== undefined) {
      return;
    }
    this.starting ??= this.start();
    await this.starting;
  }

  private async start(): Promise<void> {
    const proc = spawn(this.codexPath(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stdout.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line !== '') {
        this.log.info(`[app-server] ${line.slice(0, 300)}`);
      }
    });
    proc.on('exit', (code) => {
      this.log.warn(`app-serverが終了しました (code ${code ?? 'unknown'})`);
      this.reset();
    });
    proc.on('error', (e) => {
      this.log.error(`app-serverを起動できません: ${e.message}`);
      this.reset();
    });

    await this.request('initialize', {
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    this.write(encodeNotification('initialized', {}));
    this.log.info('app-serverに接続しました');
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    const { messages, rest } = consumeFrames(this.buffer);
    this.buffer = rest;

    for (const message of messages) {
      if (isServerRequest(message)) {
        void this.handleServerRequest(message);
        continue;
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
        continue;
      }
      if (message.method !== undefined) {
        this.onNotification(message.method, asRecord(message.params));
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    const method = message.method;
    if (id === undefined || method === undefined) {
      return;
    }
    try {
      const result = await this.onServerRequest({ id, method, params: asRecord(message.params) });
      this.write(encodeResponse(id, result));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.error(`要求 ${method} の処理に失敗しました: ${reason}`);
      this.write(encodeErrorResponse(id, reason));
    }
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-serverが応答しません: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) {
          reject(new Error(message.error.message));
          return;
        }
        resolve(message);
      });
      this.write(encodeRequest(id, method, params));
    });
  }

  notify(method: string, params: unknown): void {
    this.write(encodeNotification(method, params));
  }

  private write(line: string): void {
    this.proc?.stdin.write(line);
  }

  private reset(): void {
    this.proc = undefined;
    this.starting = undefined;
    this.buffer = '';
    for (const resolve of this.pending.values()) {
      resolve({ error: { code: -1, message: 'app-serverとの接続が切れました' } });
    }
    this.pending.clear();
  }

  dispose(): void {
    this.proc?.kill();
    this.reset();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
