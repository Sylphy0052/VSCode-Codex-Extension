import { spawn } from 'node:child_process';
import type { Logger } from '../log';
import { isSessionId } from './argvBuilder';
import {
  consumeFrames,
  encodeNotification,
  encodeRequest,
  readForkedThreadId,
  type JsonRpcMessage,
} from './jsonRpc';

export type ForkResult = { ok: true; threadId: string } | { ok: false; error: string };

const CLIENT_NAME = 'vscode-codex-extension';
const CLIENT_VERSION = '0.0.1';

/**
 * `codex app-server` を必要な瞬間だけ起動し、1回のRPCを行って終了する。
 *
 * 常駐させないのは、承認要求や大量の通知を処理する責任を負わないため。会話の描画は
 * 従来どおりTUIに任せ、app-serverはCLIに無い操作（ターン指定のfork）だけに使う。
 */
export class AppServerClient {
  constructor(
    private readonly codexPath: () => string,
    private readonly log: Logger,
    private readonly timeoutMs = 30_000,
  ) {}

  /** 指定ターンまでで分岐した新しいスレッドを作る。元のスレッドは変更されない。 */
  async forkThread(threadId: string, lastTurnId: string): Promise<ForkResult> {
    if (!isSessionId(threadId) || !isSessionId(lastTurnId)) {
      return { ok: false, error: '不正なidです' };
    }

    return new Promise<ForkResult>((resolve) => {
      const proc = spawn(this.codexPath(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const pending = new Map<number, (m: JsonRpcMessage) => void>();
      let buffer = '';
      let settled = false;

      const finish = (result: ForkResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        proc.kill();
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ ok: false, error: 'app-serverが応答しませんでした' }),
        this.timeoutMs,
      );

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const { messages, rest } = consumeFrames(buffer);
        buffer = rest;
        for (const message of messages) {
          if (typeof message.id === 'number') {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim();
        if (line !== '') {
          this.log.info(`[app-server] ${line.slice(0, 300)}`);
        }
      });

      proc.on('error', (e) => finish({ ok: false, error: e.message }));
      proc.on('exit', (code) => {
        if (!settled) {
          finish({ ok: false, error: `app-serverが終了しました (code ${code ?? 'unknown'})` });
        }
      });

      const request = (id: number, method: string, params: unknown): Promise<JsonRpcMessage> =>
        new Promise((res) => {
          pending.set(id, res);
          proc.stdin.write(encodeRequest(id, method, params));
        });

      void (async () => {
        const init = await request(1, 'initialize', {
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        });
        if (init.error !== undefined) {
          finish({ ok: false, error: init.error.message });
          return;
        }
        proc.stdin.write(encodeNotification('initialized', {}));

        const forked = await request(2, 'thread/fork', { threadId, lastTurnId });
        if (forked.error !== undefined) {
          finish({ ok: false, error: forked.error.message });
          return;
        }

        const newId = readForkedThreadId(forked.result);
        finish(
          newId === undefined
            ? { ok: false, error: '分岐後のスレッドidを読み取れませんでした' }
            : { ok: true, threadId: newId },
        );
      })();
    });
  }
}
