import { spawn } from 'node:child_process';
import type { Logger } from '../log';
import type { HooksSnapshot } from '../provider/hooks';
import { isValidMcpServerName, type McpServersSnapshot } from '../provider/mcpServers';
import type { AccountSnapshot } from '../provider/account';
import { isValidSkillPath, type SkillsSnapshot } from '../provider/skills';
import { parseAccountRead } from './accountStatus';
import { isSessionId } from './argvBuilder';
import { buildHookTrustEdit, parseHooksList } from './hooksStatus';
import {
  consumeFrames,
  encodeNotification,
  encodeRequest,
  readForkedThreadId,
  type JsonRpcMessage,
} from './jsonRpc';
import { mergeMcpServers, parseConfigMcpServersEnabled, parseMcpServerStatusList } from './mcpStatus';
import { parseModelList, readNextCursor, type ModelInfo } from './modelCatalog';
import { parseSkillsList } from './skillsStatus';

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
   * MCPサーバーの一覧を取る（issue #27、design.md TP-50）。
   *
   * `mcpServerStatus/list` と `config/read` を1回ずつ呼び、接続状況（ツール数など）と
   * 有効/無効を突き合わせる。どちらか一方が失敗しても一覧は返さず、理由を添えて返す
   * （空配列と「取得できなかった」を区別するため。詳細は `mcpStatus.ts` のコメントを参照）。
   */
  async listMcpServers(): Promise<McpServersSnapshot> {
    const result = await this.call<ReturnType<typeof mergeMcpServers>>(async (request) => {
      const statusResponse = await request('mcpServerStatus/list', { detail: 'full' });
      if (statusResponse.error !== undefined) {
        return { ok: false, error: statusResponse.error.message };
      }
      const configResponse = await request('config/read', {});
      if (configResponse.error !== undefined) {
        return { ok: false, error: configResponse.error.message };
      }
      const statusList = parseMcpServerStatusList(statusResponse.result);
      const enabledMap = parseConfigMcpServersEnabled(configResponse.result);
      return { ok: true, value: mergeMcpServers(statusList, enabledMap) };
    });

    if (!result.ok) {
      this.log.warn(`MCPサーバー一覧を取得できませんでした: ${result.error}`);
      return { ok: false, reason: result.error };
    }
    return { ok: true, servers: result.value };
  }

  /**
   * MCPサーバーの有効/無効を切り替える（issue #27）。
   *
   * 実測で確認した手順: `config/value/write` で `config.toml` の
   * `mcp_servers.<name>.enabled` を書き換え、`config/mcpServer/reload` で読み直させる。
   * `config/mcpServer/reload` はサーバー名を取らず、設定ファイル全体を再読込するだけ
   * （実測）。
   */
  async setMcpServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isValidMcpServerName(name)) {
      return { ok: false, error: '不正なサーバー名です' };
    }

    const result = await this.call<void>(async (request) => {
      const write = await request('config/value/write', {
        keyPath: `mcp_servers.${name}.enabled`,
        mergeStrategy: 'upsert',
        value: enabled,
      });
      if (write.error !== undefined) {
        return { ok: false, error: write.error.message };
      }
      const reload = await request('config/mcpServer/reload', null);
      if (reload.error !== undefined) {
        return { ok: false, error: reload.error.message };
      }
      return { ok: true, value: undefined };
    });

    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /**
   * hooksの一覧を取る（issue #28、design.md TP-52）。
   *
   * `hooks/list`（`HooksListParams { cwds? }` → `HooksListResponse { data: [{cwd, hooks,
   * warnings, errors}] }`）は実測でスレッドを開始していなくても呼べる。`cwds` を省略すると
   * 「現在のセッションの作業ディレクトリ」が使われる（スキーマの説明。単発起動でセッションが
   * 無い場合の挙動は未確認）ため、明示的にワークスペースフォルダを渡す。
   */
  async listHooks(cwds: string[]): Promise<HooksSnapshot> {
    const result = await this.call<ReturnType<typeof parseHooksList>>(async (request) => {
      const response = await request('hooks/list', cwds.length === 0 ? {} : { cwds });
      if (response.error !== undefined) {
        return { ok: false, error: response.error.message };
      }
      return { ok: true, value: parseHooksList(response.result) };
    });

    if (!result.ok) {
      this.log.warn(`hooks一覧を取得できませんでした: ${result.error}`);
      return { ok: false, reason: result.error };
    }
    return { ok: true, hooks: result.value.hooks, warnings: result.value.warnings };
  }

  /**
   * hookを信頼する（issue #28）。
   *
   * **根拠は実行ファイルの文字列調査(strings)のみ**で、実際に書き込んで確認してはいない
   * （この環境の `~/.codex/config.toml` を書き換えない方針のため。`hooksStatus.ts` の
   * `buildHookTrustEdit` のコメントを参照）。信頼を取り消す経路は見つかっていない
   * （`MergeStrategy` が `replace` / `upsert` のみで、キーの削除に相当する操作が無い）。
   */
  async setHookTrusted(
    key: string,
    currentHash: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let edit: ReturnType<typeof buildHookTrustEdit>;
    try {
      edit = buildHookTrustEdit(key, currentHash);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const result = await this.call<void>(async (request) => {
      const write = await request('config/batchWrite', { edits: [edit] });
      if (write.error !== undefined) {
        return { ok: false, error: write.error.message };
      }
      return { ok: true, value: undefined };
    });

    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /**
   * skillsの一覧を取る（issue #35、design.md TP-56）。
   *
   * `skills/list`（`SkillsListParams { cwds?, forceReload? }` → `SkillsListResponse`）は
   * 実測でスレッドを開始していなくても呼べる。`cwds` を省略すると「現在のセッションの
   * 作業ディレクトリ」に委ねられる（スキーマの説明。`hooks/list` と同じ設計）ため、
   * `listHooks` と同じくワークスペースフォルダを明示して渡す。
   */
  async listSkills(cwds: string[]): Promise<SkillsSnapshot> {
    const result = await this.call<ReturnType<typeof parseSkillsList>>(async (request) => {
      const response = await request('skills/list', cwds.length === 0 ? {} : { cwds });
      if (response.error !== undefined) {
        return { ok: false, error: response.error.message };
      }
      return { ok: true, value: parseSkillsList(response.result) };
    });

    if (!result.ok) {
      this.log.warn(`skills一覧を取得できませんでした: ${result.error}`);
      return { ok: false, reason: result.error };
    }
    return { ok: true, skills: result.value.skills, warnings: result.value.warnings };
  }

  /**
   * skillの有効/無効を切り替える（issue #35）。
   *
   * `skills/config/write`（`SkillsConfigWriteParams { enabled, name?, path? }` →
   * `SkillsConfigWriteResponse { effectiveEnabled }`）はスキーマ根拠（`codex app-server
   * generate-json-schema --out` で確認）。この環境のskill設定を書き換えない方針のため、
   * **実際に切り替えて確認してはいない**。`path` は `skills/list` が返す一意なファイル
   * パスをそのまま渡す（`name` 選択子は同名skillが複数scopeに存在しうるため使わない）。
   */
  async setSkillEnabled(
    path: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isValidSkillPath(path)) {
      return { ok: false, error: '不正なパスです' };
    }

    const result = await this.call<void>(async (request) => {
      const write = await request('skills/config/write', { enabled, path });
      if (write.error !== undefined) {
        return { ok: false, error: write.error.message };
      }
      return { ok: true, value: undefined };
    });

    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /**
   * ログイン状態を読む（issue #29、design.mdのTP-53）。
   *
   * `account/read`（`GetAccountParams {}` → `GetAccountResponse { account, requiresOpenaiAuth }`）
   * はスレッドを開始していなくても呼べる（実測。`mcpServerStatus/list` と同じ性質）。
   * login/logoutの実行そのものはCLIのサブコマンド（`src/codex/accountActions.ts`）に委ねており、
   * ここでは読み取りだけを行う。
   */
  async readAccount(): Promise<AccountSnapshot> {
    const result = await this.call<ReturnType<typeof parseAccountRead>>(async (request) => {
      const response = await request('account/read', {});
      if (response.error !== undefined) {
        return { ok: false, error: response.error.message };
      }
      return { ok: true, value: parseAccountRead(response.result) };
    });

    if (!result.ok) {
      this.log.warn(`ログイン状態を取得できませんでした: ${result.error}`);
      return { ok: false, reason: result.error };
    }
    return { ok: true, account: result.value };
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
