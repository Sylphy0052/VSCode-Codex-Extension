import { spawn } from 'node:child_process';
import type { Logger } from '../log';
import type { HooksSnapshot } from '../provider/hooks';
import { isValidMcpServerName, type McpServersSnapshot } from '../provider/mcpServers';
import type { AccountSnapshot } from '../provider/account';
import { isValidSkillPath, type SkillsSnapshot } from '../provider/skills';
import { isValidPluginName, type AppsSnapshot, type PluginsSnapshot } from '../provider/plugins';
import type {
  ImportHistorySnapshot,
  ImportRunItemResult,
  ImportRunResult,
  ImportSnapshot,
} from '../provider/import';
import { parseAccountRead } from './accountStatus';
import { mergeApps, parseAppsInstalled, parseAppsRead } from './appsStatus';
import { isSessionId } from './argvBuilder';
import { buildHookTrustEdit, parseHooksList } from './hooksStatus';
import {
  parseDetectResponse,
  parseImportNotification,
  parseImportResponse,
  parseReadHistoriesResponse,
} from './importStatus';
import {
  consumeFrames,
  encodeNotification,
  encodeRequest,
  readForkedThreadId,
  type JsonRpcMessage,
} from './jsonRpc';
import { killWithEscalation, MAX_LINE_BUFFER_BYTES } from '../process/childProcess';
import { guardStdinErrors, safeWriteStdin } from '../process/stdinSafety';
import {
  mergeMcpServers,
  parseConfigMcpServersEnabled,
  parseMcpServerStatusList,
} from './mcpStatus';
import { parseModelList, readNextCursor, type ModelInfo } from './modelCatalog';
import { parsePluginInstalled, parsePluginProvides, type PluginReadRef } from './pluginsStatus';
import { parseSkillsList } from './skillsStatus';
import { normalizeThreadList, parseThreadListPage, type ThreadListOutcome } from './threadList';

export type ForkResult = { ok: true; threadId: string } | { ok: false; error: string };

type CallResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** JSON-RPCの1往復。応答は `error` を含みうるため、呼び出し側で見ること。 */
type Request = (method: string, params: unknown) => Promise<JsonRpcMessage>;

/**
 * 通知（idを持たないメッセージ）を購読する口。`externalAgentConfig/import` のように、
 * 最初の応答（`importId`）の後に非同期の通知（`.../progress` `.../completed`）が続く
 * 要求のためだけに使う。他のメソッドは単発の要求・応答で完結するため使わない。
 */
type NotificationBus = {
  /** 通知が来るたびに呼ばれる。戻り値の関数を呼ぶと購読を止める。 */
  onEach: (listener: (message: JsonRpcMessage) => void) => () => void;
};

const CLIENT_NAME = 'vscode-codex-extension';
const CLIENT_VERSION = '0.0.1';

/** `model/list` のページ数の上限。応答が壊れて無限ループになるのを防ぐ。 */
const MAX_MODEL_PAGES = 20;

/** `thread/list` の1回あたりの要求件数。応答が壊れて無限ループになるのを防ぐページ数上限も併せて持つ。 */
const THREAD_LIST_PAGE_SIZE = 100;
const MAX_THREAD_LIST_PAGES = 20;

/** `plugin/read` を呼ぶ件数の上限。導入数が多い環境でパネルが固まらないようにする。 */
const MAX_PLUGIN_READ_CALLS = 25;

/** `app/read` の `appIds` の上限（スキーマの説明: 「最大100件、重複除去」）。 */
const MAX_APP_READ_IDS = 100;

/**
 * `externalAgentConfig/import` の完了通知を待つ上限（issue #36、design.md TP-57）。
 *
 * Phase 0で確認されたバイナリのUI文言（「Import started. You can keep working while it
 * finishes.」）から非同期に進むことが分かっており、セッション移行など項目数が多い場合は
 * 数分かかる可能性がある。単発起動のこのクライアントは常駐できないため、待ちに上限を設け、
 * 超えたら「開始はしたが完了は確認できていない」として返す（`runImport` 参照。実行系のため
 * 実測していない値であり、余裕を持たせている）。
 */
const IMPORT_COMPLETE_TIMEOUT_MS = 5 * 60_000;

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
        const response = await request('model/list', cursor === undefined ? {} : { cursor });
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
   * セッション一覧を `thread/list` で取る（issue #45）。
   *
   * 失敗しても空配列に丸めず `ok:false` を返す。「空だから退避する」のか「エラーだから
   * 退避する」のかを呼び出し側（SessionStore）が区別し、出力パネルに理由を残せるように
   * するため（他のメソッドのように内部で握りつぶさない）。
   */
  async listThreads(limit: number, archivedSessionsDir: string): Promise<ThreadListOutcome> {
    if (limit <= 0) {
      return { ok: true, sessions: [] };
    }

    const result = await this.call<unknown[]>(async (request) => {
      const items: unknown[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < MAX_THREAD_LIST_PAGES && items.length < limit; page += 1) {
        const response = await request('thread/list', {
          limit: Math.min(THREAD_LIST_PAGE_SIZE, limit - items.length),
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (response.error !== undefined) {
          return { ok: false, error: response.error.message };
        }
        const parsed = parseThreadListPage(response.result);
        items.push(...parsed.items);
        cursor = parsed.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
      return { ok: true, value: items };
    });

    if (!result.ok) {
      this.log.warn(`スレッド一覧を取得できませんでした: ${result.error}`);
      return { ok: false, error: result.error };
    }
    return { ok: true, sessions: normalizeThreadList(result.value, archivedSessionsDir) };
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
   * **実測で確認済み**（issue #146。隔離環境での検証結果は `hooksStatus.ts` の
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
   * `SkillsConfigWriteResponse { effectiveEnabled }`）は**実測で確認済み**（issue #146。
   * `CODEX_HOME` を隔離した環境で実際に切り替え、`config.toml` の `[[skills.config]]` と
   * 続く `skills/list` の両方に反映されることを確認した）。`path` は `skills/list` が返す
   * 一意なファイルパスをそのまま渡す（`name` 選択子は同名skillが複数scopeに存在しうるため
   * 使わない）。
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
   * pluginの一覧を取る（issue #32、design.md §14.20）。
   *
   * `plugin/installed` で導入済みの一覧を読み、`plugin/read` で1件ずつ「提供するもの」の
   * 内訳（hooks/mcpServers/skillsの件数）を補う。`plugin/read` はスキーマ上必須の
   * `marketplacePath` か `remoteMarketplaceName` のどちらか一方が要る（実測でエラー文言を
   * 確認）ため、`plugin/installed` が返すマーケットプレイスの `path`（ローカル）の有無で
   * 使い分ける。導入数が多い環境でパネルが固まらないよう呼び出し件数に上限を設け、
   * 超えた分は内訳が空のまま返す（一覧・有効無効・出どころは失わない）。
   *
   * `plugin/read` が1件失敗しても、その1件の内訳だけを諦めて続行する（一覧全体は失わない）。
   */
  async listPlugins(): Promise<PluginsSnapshot> {
    const result = await this.call<ReturnType<typeof parsePluginInstalled>>(async (request) => {
      const response = await request('plugin/installed', {});
      if (response.error !== undefined) {
        return { ok: false, error: response.error.message };
      }
      const parsed = parsePluginInstalled(response.result);

      const provideByKey = new Map<string, PluginReadRef>();
      for (const ref of parsed.refs) {
        provideByKey.set(ref.key, ref);
      }
      for (const plugin of parsed.plugins.slice(0, MAX_PLUGIN_READ_CALLS)) {
        const ref = provideByKey.get(plugin.key);
        if (ref === undefined) {
          continue;
        }
        const readParams =
          ref.marketplacePath === undefined
            ? { pluginName: ref.pluginName, remoteMarketplaceName: ref.marketplaceName }
            : { pluginName: ref.pluginName, marketplacePath: ref.marketplacePath };
        const readResponse = await request('plugin/read', readParams);
        if (readResponse.error !== undefined) {
          continue;
        }
        const provides = parsePluginProvides(readResponse.result);
        if (provides !== undefined) {
          plugin.provides = provides;
        }
      }

      return { ok: true, value: parsed };
    });

    if (!result.ok) {
      this.log.warn(`plugin一覧を取得できませんでした: ${result.error}`);
      return { ok: false, reason: result.error };
    }
    const warnings = [...result.value.warnings];
    if (result.value.plugins.length > MAX_PLUGIN_READ_CALLS) {
      warnings.push(
        `導入数が多いため、${MAX_PLUGIN_READ_CALLS}件を超えるpluginの内訳は表示していません。`,
      );
    }
    return {
      ok: true,
      plugins: result.value.plugins,
      installable: true,
      marketplaces: result.value.marketplaces,
      warnings,
    };
  }

  /**
   * pluginをインストールする（issue #32）。
   *
   * `plugin/install`（`PluginInstallParams { pluginName, marketplacePath?,
   * remoteMarketplaceName? }`）は**実測で確認済み**（issue #146。ネットワークを使わない
   * 完全ローカルのマーケットプレイスを隔離環境に用意し、実際にインストールして
   * `plugin/installed` に反映されることを確認した。`marketplacePath` は
   * `plugin/installed` が返す `marketplaces[].path`（マーケットプレイスの
   * マニフェストファイルそのもののパス。ディレクトリを渡すと失敗する）をそのまま使うこと）。
   * 呼び出し側（`SettingsProvider.installCodexPlugin`）が確認ダイアログで
   * 「何をどこから入れるか」を明示してから呼ぶこと。
   */
  async installPlugin(
    pluginName: string,
    marketplace: { path: string | undefined; remoteMarketplaceName: string | undefined },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isValidPluginName(pluginName)) {
      return { ok: false, error: '不正なplugin名です' };
    }

    const result = await this.call<void>(async (request) => {
      const write = await request('plugin/install', {
        pluginName,
        marketplacePath: marketplace.path ?? null,
        remoteMarketplaceName: marketplace.remoteMarketplaceName ?? null,
      });
      if (write.error !== undefined) {
        return { ok: false, error: write.error.message };
      }
      return { ok: true, value: undefined };
    });

    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /**
   * pluginをアンインストールする（issue #32）。
   *
   * `plugin/uninstall`（`PluginUninstallParams { pluginId }`）は**実測で確認済み**
   * （issue #146。`installPlugin` と同じ隔離環境で実際に削除し、`plugin/installed` から
   * 消えることを確認した）。`pluginId` は `plugin/installed` が返す一覧の `key`
   * （`<name>@<marketplace>`）をそのまま渡す。
   */
  async uninstallPlugin(pluginId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isValidPluginName(pluginId)) {
      return { ok: false, error: '不正なplugin idです' };
    }

    const result = await this.call<void>(async (request) => {
      const write = await request('plugin/uninstall', { pluginId });
      if (write.error !== undefined) {
        return { ok: false, error: write.error.message };
      }
      return { ok: true, value: undefined };
    });

    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /**
   * appの一覧を取る（issue #32、design.md §14.20）。
   *
   * `app/installed`（導入済みの一覧。`id` / `runtimeName` / `enabled` / `callable` のみ）と
   * `app/read`（人が読める `name` / `description`）を突き合わせる。`app/list`
   * （マーケットプレイスのカタログ全体）は `plugin/list` と同じ理由でこの環境では応答が
   * 非常に大きいため使わない。
   *
   * **有効/無効・インストール/アンインストールの確定した書き込み経路が無い**ため閲覧のみ。
   * `AppInfo.isEnabled` の説明に `config.toml` の `[apps.<id>] enabled = false` が例示されて
   * いるが、対応する書き込みメソッド（`config/app/reload` 相当）がスキーマに見当たらず、
   * `config/value/write` だけで反映されるかは未確認（この環境のapp設定を書き換えない方針の
   * ため検証していない）。確証の無い書き込みは実装しない方針に合わせ、読み取りのみとする。
   */
  async listApps(): Promise<AppsSnapshot> {
    const result = await this.call<ReturnType<typeof mergeApps>>(async (request) => {
      const installedResponse = await request('app/installed', {});
      if (installedResponse.error !== undefined) {
        return { ok: false, error: installedResponse.error.message };
      }
      const installed = parseAppsInstalled(installedResponse.result);
      if (installed.length === 0) {
        return { ok: true, value: [] };
      }

      const appIds = installed.slice(0, MAX_APP_READ_IDS).map((app) => app.id);
      const readResponse = await request('app/read', { appIds });
      const details =
        readResponse.error === undefined ? parseAppsRead(readResponse.result) : new Map();
      return { ok: true, value: mergeApps(installed, details) };
    });

    if (!result.ok) {
      this.log.warn(`app一覧を取得できませんでした: ${result.error}`);
      return { ok: false, reason: result.error };
    }
    return { ok: true, apps: result.value };
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
   * 他エージェントからの設定インポートの候補を検出する（issue #36、design.md TP-57）。
   *
   * `externalAgentConfig/detect`（`ExternalAgentConfigDetectParams { cwds?, includeHome?,
   * migrationSource?, ... }` → `ExternalAgentConfigDetectResponse { items, connectors }`）は
   * スレッドを開始していなくても呼べる（実測）。`includeHome: true` を常に渡す
   * （実測: 省略すると常に空になる。詳細は `importStatus.ts` のコメント参照）。`cwds` には
   * ワークスペースフォルダを渡し、プロジェクト側の設定（リポジトリのcloneに含まれる
   * `.claude/` 等）も検出対象にする。`migrationSource` は指定しない（既定でClaude Code、
   * issueのスコープと一致。詳細は `importStatus.ts` 参照）。
   *
   * 戻り値の `rawByKey` は `runImport` へそのまま渡すための生の項目。webviewへは
   * `snapshot`（`ImportItemView[]`）だけを渡し、生データは呼び出し側（`SettingsProvider`）に
   * 留める。
   */
  async detectImportCandidates(
    cwds: string[],
  ): Promise<{ snapshot: ImportSnapshot; rawByKey: Map<string, unknown> }> {
    const result = await this.call<ReturnType<typeof parseDetectResponse>>(async (request) => {
      const response = await request('externalAgentConfig/detect', {
        includeHome: true,
        ...(cwds.length === 0 ? {} : { cwds }),
      });
      if (response.error !== undefined) {
        return { ok: false, error: response.error.message };
      }
      return { ok: true, value: parseDetectResponse(response.result) };
    });

    if (!result.ok) {
      this.log.warn(`インポート候補を検出できませんでした: ${result.error}`);
      return { snapshot: { ok: false, reason: result.error }, rawByKey: new Map() };
    }
    return { snapshot: { ok: true, items: result.value.items }, rawByKey: result.value.rawByKey };
  }

  /**
   * 過去のインポート実行履歴を読む（issue #36）。
   *
   * `externalAgentConfig/import/readHistories`（params: `null` → `{data, connectors}`）は
   * 実測。この一覧を見せることで、実行前に「前回いつ何を取り込んだか」が分かるようにする
   * （受入基準「実行前に何が変わるかが分かる」の一部）。
   */
  async readImportHistories(): Promise<ImportHistorySnapshot> {
    const result = await this.call<ReturnType<typeof parseReadHistoriesResponse>>(
      async (request) => {
        const response = await request('externalAgentConfig/import/readHistories', null);
        if (response.error !== undefined) {
          return { ok: false, error: response.error.message };
        }
        return { ok: true, value: parseReadHistoriesResponse(response.result) };
      },
    );

    if (!result.ok) {
      this.log.warn(`インポート履歴を取得できませんでした: ${result.error}`);
      return { ok: false, reason: result.error };
    }
    return { ok: true, entries: result.value };
  }

  /**
   * 選ばれた項目を実際にインポートする（issue #36）。**設定を書き換える操作**。
   *
   * `migrationItems` には `detectImportCandidates` が返した `rawByKey` の値をそのまま渡す
   * こと（`ExternalAgentConfigMigrationItem` の形をこのクライアントが再構築するのではなく、
   * CLIが返した生のJSONを再送する。スキーマの型が一致しているため）。呼び出し側
   * （`SettingsProvider.runCodexImport`）が実行前に確認ダイアログで対象を明示すること。
   *
   * **実測で確認済み**（issue #146。`CODEX_HOME` と、Claude Code側の探索元となる `$HOME` の
   * 両方を隔離した環境で `HOOKS` / `SKILLS` を実行し、完了通知が届いて実際にファイルへ
   * 反映されることを確認した。詳細はdesign.md §14.30参照）。`externalAgentConfig/import` は
   * `{importId}` を即座に返し、実際の結果は `externalAgentConfig/import/completed` 通知で
   * 非同期に届く（Phase 0調査で確認されたUI文言「Import started. You can keep working while
   * it finishes.」と整合。実測では数十ミリ秒以内に届いた）。このクライアントは単発起動で
   * 常駐できないため、完了通知を `IMPORT_COMPLETE_TIMEOUT_MS` まで待ってからプロセスを
   * 終える。**タイムアウト後にCLI側で処理が実際に継続するかどうかは未確認**（実測した
   * 範囲ではタイムアウトに達する前に完了したため、この境界条件だけは実測できていない。
   * プロセスを終了させることで中断される可能性がある）。タイムアウトを失敗とはせず、
   * 「開始はできた」ことが分かる形（`results: undefined`）で返す。
   *
   * 通知の購読は要求を送る**前**に始める。応答（`importId`）と完了通知が同じ受信チャンクに
   * 混ざって届いた場合、応答を待ってから購読すると通知を取りこぼす競合があるため。
   * このapp-serverプロセスはこの1回のインポートのためだけに起動しているので、観測する
   * `.../progress` `.../completed` 通知はすべてこの実行のものとみなしてよい。
   */
  async runImport(migrationItems: unknown[]): Promise<ImportRunResult> {
    if (migrationItems.length === 0) {
      return { ok: false, error: 'インポートする項目が選ばれていません' };
    }

    const result = await this.call<{
      importId: string;
      results: ImportRunItemResult[] | undefined;
    }>(async (request, notify) => {
      let resolveCompletion: (results: ImportRunItemResult[]) => void = () => {};
      const completion = new Promise<ImportRunItemResult[]>((resolve) => {
        resolveCompletion = resolve;
      });
      const stop = notify.onEach((message) => {
        if (message.method === 'externalAgentConfig/import/progress') {
          const progress = parseImportNotification(message.params);
          if (progress !== undefined) {
            this.log.info(
              `インポート進行中 (${progress.importId}): ${progress.results
                .map((r) => `${r.label} 成功${r.successCount}/失敗${r.failureCount}`)
                .join(' ・ ')}`,
            );
          }
          return;
        }
        if (message.method === 'externalAgentConfig/import/completed') {
          const completed = parseImportNotification(message.params);
          if (completed !== undefined) {
            resolveCompletion(completed.results);
          }
        }
      });

      const response = await request('externalAgentConfig/import', { migrationItems });
      if (response.error !== undefined) {
        stop();
        return { ok: false, error: response.error.message };
      }
      const importId = parseImportResponse(response.result);
      if (importId === undefined) {
        stop();
        return { ok: false, error: '応答からimportIdを読み取れませんでした' };
      }

      const results = await new Promise<ImportRunItemResult[] | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), IMPORT_COMPLETE_TIMEOUT_MS);
        void completion.then((r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
      stop();

      return { ok: true, value: { importId, results } };
    }, IMPORT_COMPLETE_TIMEOUT_MS);

    if (!result.ok) {
      this.log.warn(`インポートを実行できませんでした: ${result.error}`);
      return { ok: false, error: result.error };
    }
    if (result.value.results === undefined) {
      this.log.warn(
        `インポート完了の通知が届きませんでした (importId: ${result.value.importId})。CLI側で処理が継続している可能性があります`,
      );
      return { ok: true, importId: result.value.importId, results: undefined };
    }
    this.log.info(`インポートが完了しました (importId: ${result.value.importId})`);
    return { ok: true, importId: result.value.importId, results: result.value.results };
  }

  /**
   * app-serverを起動し、初期化してから `body` の要求を行い、終わったら落とす。
   *
   * 応答が来ない場合に居座らせないよう、必ずタイムアウトで決着させる。
   */
  private call<T>(
    body: (request: Request, notify: NotificationBus) => Promise<CallResult<T>>,
    timeoutOverrideMs?: number,
  ): Promise<CallResult<T>> {
    return new Promise<CallResult<T>>((resolve) => {
      const proc = spawn(this.codexPath(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const pending = new Map<number, (m: JsonRpcMessage) => void>();
      const notificationListeners = new Set<(message: JsonRpcMessage) => void>();
      const notify: NotificationBus = {
        onEach: (listener) => {
          notificationListeners.add(listener);
          return () => notificationListeners.delete(listener);
        },
      };
      let buffer = '';
      let settled = false;
      let alreadyExited = false;
      let nextId = 1;

      const finish = (result: CallResult<T>): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // `finish()`がタイムアウトやexitで先に確定しても、`body`が内部で`await`している
        // `request()`のPromiseが未解決のまま残ると、そちらを待ち続ける処理が永久にハング
        // する（issue #402、3点目）。`pending`に残っている応答待ちをここでエラー値により
        // 即時解決し、Mapを空にする
        for (const resolvePending of pending.values()) {
          resolvePending({ error: { code: -1, message: 'app-serverとのやり取りが終了しました' } });
        }
        pending.clear();
        // `proc.on('exit')`経由で`finish()`に来た場合、子は既に終了している。そこへ
        // `killWithEscalation()`を掛けると、死んだpidへ無駄なSIGTERM/SIGKILLを送りかね
        // ない上、3秒のエスカレーションタイマーだけが無意味に残る（issue #419、LOW）。
        // SIGTERMに応答しないハングしたプロセスの回収が目的なので、既に終了済みなら
        // 何もしない
        if (!alreadyExited) {
          // SIGTERMに応答しないハングしたプロセスも回収できるよう、SIGKILLへの
          // エスカレーションを共通処理へ寄せる（issue #402、2点目）
          killWithEscalation(proc);
        }
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ ok: false, error: 'app-serverが応答しませんでした' }),
        timeoutOverrideMs ?? this.timeoutMs,
      );

      // `proc.on('error')`は起動失敗しか拾わない。起動後に相手が終了した状態へ書き込むと
      // 飛ぶEPIPE等はここで捕まえないとNodeの未捕捉例外になる（issue #155、design.md
      // §14.31）。単発の問い合わせなので、既に決着させる作りの`finish`へそのまま寄せる。
      guardStdinErrors(proc, (e) =>
        finish({ ok: false, error: `app-serverへの書き込みに失敗しました: ${e.message}` }),
      );

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const { messages, rest, overflow } = consumeFrames(buffer);
        buffer = rest;
        try {
          // 完成した行（messages）は、上限超過の判定より先に処理する（レビュー指摘・MEDIUM）。
          // overflowを先に見て早期returnすると、同じチャンクの中に「正常に完成した応答」と
          // 「上限超過の未完成行」が同居していた場合、正常に届いていた応答まで握りつぶして
          // しまう（本来成功していた応答が失敗応答へすり替わってしまう）
          for (const message of messages) {
            if (typeof message.id === 'number') {
              pending.get(message.id)?.(message);
              pending.delete(message.id);
            } else if (message.method !== undefined) {
              // idを持たないメッセージ（通知）。既定のメソッドは要求・応答だけで完結し
              // 通知を無視するが、`runImport` のように非同期の続報を待つ呼び出しもある
              for (const listener of notificationListeners) {
                listener(message);
              }
            }
          }
        } finally {
          // `finally`へ置くのは、forループ中のリスナー（`notificationListeners`）が
          // 同期的に例外を投げた場合でも、overflow時の後始末（バッファ解放・打ち切り）を
          // 必ず実行するため（レビュー指摘・LOW）。ループを先に処理する形へ入れ替えた際、
          // 例外で`if (overflow)`まで到達しない経路ができていた
          if (overflow) {
            // 改行を含まない出力が上限を超えて溜まり続けた（issue #402、1点目）。
            // クロージャ内の`buffer`（このコールバックの外側で`let`宣言）はここで
            // 明示的に空にする。overflow検知時点の`rest`＝上限超過分そのものが
            // `buffer`に残ったままだと、`setImmediate`で`finish`するまでの間に
            // 次の`data`イベントが来た場合、10MB超のバッファへさらに追記して
            // `consumeFrames`のフル再パースが走ってしまう（レビュー指摘・MEDIUM）
            buffer = '';
            // 単発の問い合わせなので、既に決着させる作りの`finish`へそのまま寄せて打ち切る。
            //
            // ただし`finish`をここで同期的に呼ぶと、直前の`for`ループで応答を受け取った
            // 直後の`request()`（Promiseは既に解決済み）が、`body`側の`await`の続き
            // （`.then`のマイクロタスク）を消化する前に`settled`を先取りしてしまい、
            // 本来成功していた応答が失敗応答へすり替わる（レビュー指摘・MEDIUM）。
            // `setImmediate`（マクロタスク）まで遅らせることで、既に受け取り済みの応答を
            // 使い切る`body`の同期的な後続処理（追加のI/O待ちが無い部分）を先に終わらせて
            // から`finish`する。`body`がまだ別の応答を待っている場合はどのみち届かないため、
            // 遅らせても結果は変わらない
            setImmediate(() => {
              finish({
                ok: false,
                error: `app-serverからの出力が上限（${MAX_LINE_BUFFER_BYTES}バイト）を超えて改行なしで届きました`,
              });
            });
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
        alreadyExited = true;
        if (!settled) {
          finish({ ok: false, error: `app-serverが終了しました (code ${code ?? 'unknown'})` });
        }
      });

      const request: Request = (method, params) =>
        new Promise((res) => {
          const id = nextId;
          nextId += 1;
          pending.set(id, res);
          safeWriteStdin(proc, encodeRequest(id, method, params));
        });

      void (async () => {
        const init = await request('initialize', {
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        });
        if (init.error !== undefined) {
          finish({ ok: false, error: init.error.message });
          return;
        }
        safeWriteStdin(proc, encodeNotification('initialized', {}));

        finish(await body(request, notify));
      })();
    });
  }
}
