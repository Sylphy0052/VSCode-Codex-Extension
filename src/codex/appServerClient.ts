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
import { parseModelList, readNextCursor, type ModelInfo } from './modelCatalog';

export type ForkResult = { ok: true; threadId: string } | { ok: false; error: string };

type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** JSON-RPCの1往復。応答は `error` を含みうるため、呼び出し側で見ること。 */
type Request = (method: string, params: unknown) => Promise<JsonRpcMessage>;

const CLIENT_NAME = 'vscode-codex-extension';
const CLIENT_VERSION = '0.0.1';

/** `model/list` のページ数の上限。応答が壊れて無限ループになるのを防ぐ。 */
const MAX_MODEL_PAGES = 20;

/**
 * `codex app-server` を必要な瞬間だけ起動し、1回のRPCを行って終了する。
 *
 * 常駐させないのは、承認要求や大量の通知を処理する責任を負わないため。会話の描画は
 * 会話用の接続（AppServerConnection）に任せ、こちらはそれと無関係に使える単発の問い合わせ
 * （ターン指定のfork、モデル一覧）だけに使う。
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

    const result = await this.call<string>(async (request) => {
      const forked = await request('thread/fork', { threadId, lastTurnId });
      if (forked.error !== undefined) {
        return { ok: false, error: forked.error.message };
      }
      const newId = readForkedThreadId(forked.result);
      return newId === undefined
        ? { ok: false, error: '分岐後のスレッドidを読み取れませんでした' }
        : { ok: true, value: newId };
    });

    return result.ok ? { ok: true, threadId: result.value } : { ok: false, error: result.error };
  }

  /**
   * 選べるモデルの一覧を取る。
   *
   * 取得できない場合（CLIが古い、app-serverが起動しない）は空配列を返す。呼び出し側は
   * キャッシュファイル由来の一覧へ退避すること。選択肢を空にしてはいけない。
   */
  async listModels(): Promise<ModelInfo[]> {
    const result = await this.call<ModelInfo[]>(async (request) => {
      const models: ModelInfo[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const response = await request(
          'model/list',
          cursor === undefined ? {} : { cursor },
        );
        if (response.error !== undefined) {
          return { ok: false, error: response.error.message };
        }
        models.push(...parseModelList(response.result));
        cursor = readNextCursor(response.result);
        if (cursor === undefined) {
          break;
        }
      }
      return { ok: true, value: models };
    });

    if (!result.ok) {
      this.log.warn(`モデル一覧を取得できませんでした: ${result.error}`);
      return [];
    }
    return result.value;
  }

  /**
   * app-serverを起動し、初期化してから `body` の要求を行い、終わったら落とす。
   *
   * 応答が来ない場合に居座らせないよう、必ずタイムアウトで決着させる。
   */
  private call<T>(body: (request: Request) => Promise<CallResult<T>>): Promise<CallResult<T>> {
    return new Promise<CallResult<T>>((resolve) => {
      const proc = spawn(this.codexPath(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const pending = new Map<number, (m: JsonRpcMessage) => void>();
      let buffer = '';
      let settled = false;
      let nextId = 1;

      const finish = (result: CallResult<T>): void => {
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

      const request: Request = (method, params) =>
        new Promise((res) => {
          const id = nextId;
          nextId += 1;
          pending.set(id, res);
          proc.stdin.write(encodeRequest(id, method, params));
        });

      void (async () => {
        const init = await request('initialize', {
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        });
        if (init.error !== undefined) {
          finish({ ok: false, error: init.error.message });
          return;
        }
        proc.stdin.write(encodeNotification('initialized', {}));

        finish(await body(request));
      })();
    });
  }
}
