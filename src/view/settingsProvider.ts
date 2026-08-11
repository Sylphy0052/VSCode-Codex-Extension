import * as vscode from 'vscode';
import {
  extractClaudeDefaults,
  noClaudeDefaults,
  type ClaudeDefaults,
} from '../claude/settingsJson';
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  claudeFallbackModels,
  type ClaudeAgentInfo,
} from '../claude/types';
import { extractDefaults, noDefaults, type CodexDefaults } from '../codex/configToml';
import { effortsFor, parseModelCatalog, type ModelInfo } from '../codex/modelCatalog';
import { isSandboxRelaxed } from '../codex/sandboxPolicy';
import { readClaudeConfig, readConfig } from '../config';
import type { Logger } from '../log';
import { accountNotLoadedYet, type AccountSnapshot } from '../provider/account';
import type { McpServersSnapshot } from '../provider/mcpServers';
import type { CommandResult } from '../process/commandRunner';
import type { FileSystemPort } from '../session/ports';

/** 一覧をまだ読んでいない状態。CLIへの問い合わせが空だったのと区別する。 */
const notLoadedYet: McpServersSnapshot = { ok: false, reason: 'まだ読み込んでいません' };

/** `setMcpServerEnabled` / `ClaudeMcpProbe.toggle` と同じ形の結果。 */
export type McpToggleResult = { ok: true } | { ok: false; error: string };

/**
 * ログイン/ログアウト操作の結果。
 * `error` が `undefined` のときは確認ダイアログでの取り消しを意味し、エラー表示はしない。
 */
export type AccountActionResult = { ok: true } | { ok: false; error: string | undefined };

/** Webviewから変更を許すキー。ここに無いキーは無視する。 */
export const EDITABLE_KEYS = ['model', 'reasoningEffort', 'approvalMode', 'sandbox'] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];

export function isEditableKey(value: unknown): value is EditableKey {
  return typeof value === 'string' && (EDITABLE_KEYS as readonly string[]).includes(value);
}

/** Claude Code側でWebviewから変更を許すキー。 */
export const CLAUDE_EDITABLE_KEYS = ['model', 'effort', 'permissionMode', 'agent'] as const;
export type ClaudeEditableKey = (typeof CLAUDE_EDITABLE_KEYS)[number];

export function isClaudeEditableKey(value: unknown): value is ClaudeEditableKey {
  return typeof value === 'string' && (CLAUDE_EDITABLE_KEYS as readonly string[]).includes(value);
}

export interface SettingsSnapshot {
  models: ModelInfo[];
  /** 選択中のモデルで選べるeffort。 */
  efforts: string[];
  model: string;
  reasoningEffort: string;
  approvalMode: string;
  sandbox: string;
  /** 設定が空のときに実際に使われる値（config.toml 由来）。 */
  defaults: CodexDefaults;
  profile: string;
  /** MCPサーバーの一覧・状態（issue #27）。 */
  mcpServers: McpServersSnapshot;
  /** ログイン状態（issue #29）。 */
  account: AccountSnapshot;
}

export interface ClaudeSettingsSnapshot {
  models: ModelInfo[];
  /** 選択中のモデルで選べるeffort。effortを持たないモデルでは空になる。 */
  efforts: string[];
  permissionModes: string[];
  /**
   * 選べるカスタムエージェント。`initialize` の応答から取れなければ空配列
   * （取得できなかった場合と1件も無い場合を区別する意味が呼び出し側に無いため、
   * ここでは空配列に均す。選択肢を出さないだけで済む）。
   */
  agents: ClaudeAgentInfo[];
  model: string;
  effort: string;
  permissionMode: string;
  /** 起動時にのみ効く。セッション中は切り替えられない（設計書 §6・Issue #30）。 */
  agent: string;
  /** 設定が空のときに実際に使われる値（settings.json 由来）。 */
  defaults: ClaudeDefaults;
  /** MCPサーバーの一覧・状態（issue #27）。 */
  mcpServers: McpServersSnapshot;
  /** ログイン状態（issue #29）。 */
  account: AccountSnapshot;
}

/**
 * モデル・effort・承認方法・サンドボックスの選択肢と現在値を供給する。
 *
 * 設定パネルとCodex画面の両方が同じ選択肢と同じ書き込み規則を使うよう、ここに集約する。
 */
export class SettingsProvider {
  private models: ModelInfo[] = [];
  private defaults: CodexDefaults = noDefaults;
  private codexMcp: McpServersSnapshot = notLoadedYet;
  private codexAccount: AccountSnapshot = accountNotLoadedYet;

  private claudeModels: ModelInfo[] = [];
  private claudeDefaults: ClaudeDefaults = noClaudeDefaults;
  private claudeAgents: ClaudeAgentInfo[] = [];
  private claudeMcp: McpServersSnapshot = notLoadedYet;
  private claudeAccount: AccountSnapshot = accountNotLoadedYet;

  /**
   * @param listCodexModels `model/list` の結果。取れなければ空配列。
   * @param listClaudeModels `initialize` の応答の一覧。取れなければ `undefined`。
   * @param listClaudeAgents `initialize` の応答の `agents`。取れなければ `undefined`
   *   （モデルと違い意味のあるフォールバック一覧が無いため、呼び出し側は選択肢を出さない）。
   * @param listCodexMcpServers `mcpServerStatus/list` + `config/read` を突き合わせた結果。
   * @param listClaudeMcpServers `mcp_status` の結果。
   * @param setCodexMcpServerEnabled `config/value/write` + `config/mcpServer/reload`。
   * @param setClaudeMcpServerEnabled `mcp_toggle`。
   * @param readCodexAccount `account/read` の結果（issue #29）。
   * @param readClaudeAccount `claude auth status --json` の結果（issue #29）。
   * @param logoutCodexCli `codex logout` の実行結果。
   * @param logoutClaudeCli `claude auth logout` の実行結果。
   * @param loginCodexApiKeyCli `codex login --with-api-key` の実行結果。
   */
  constructor(
    private readonly fs: FileSystemPort,
    private readonly modelsCachePath: string,
    private readonly configTomlPath: string,
    private readonly claudeSettingsPath: string,
    private readonly listCodexModels: () => Promise<ModelInfo[]>,
    private readonly listClaudeModels: () => Promise<ModelInfo[] | undefined>,
    private readonly listClaudeAgents: () => Promise<ClaudeAgentInfo[] | undefined>,
    private readonly listCodexMcpServers: () => Promise<McpServersSnapshot>,
    private readonly listClaudeMcpServers: () => Promise<McpServersSnapshot>,
    private readonly setCodexMcpServerEnabled: (
      name: string,
      enabled: boolean,
    ) => Promise<McpToggleResult>,
    private readonly setClaudeMcpServerEnabled: (
      name: string,
      enabled: boolean,
    ) => Promise<McpToggleResult>,
    private readonly readCodexAccount: () => Promise<AccountSnapshot>,
    private readonly readClaudeAccount: () => Promise<AccountSnapshot>,
    private readonly logoutCodexCli: () => Promise<CommandResult>,
    private readonly logoutClaudeCli: () => Promise<CommandResult>,
    private readonly loginCodexApiKeyCli: (apiKey: string) => Promise<CommandResult>,
    private readonly log: Logger,
  ) {}

  /** 一度でも読み込んだか。未読込のまま snapshot を返すと選択肢が空になる。 */
  private loaded = false;

  /** 未読込なら読む。読み込み済みなら何もしない。 */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  /** モデル一覧・既定値・MCPサーバー一覧・ログイン状態を読み直す。 */
  async load(): Promise<void> {
    this.loaded = true;
    // CLIの起動を待つ時間が二重にならないよう、まとめて聞く
    [
      this.models,
      this.claudeModels,
      this.claudeAgents,
      this.codexMcp,
      this.claudeMcp,
      this.codexAccount,
      this.claudeAccount,
    ] = await Promise.all([
      this.loadCodexModels(),
      this.loadClaudeModels(),
      this.loadClaudeAgents(),
      this.listCodexMcpServers(),
      this.listClaudeMcpServers(),
      this.readCodexAccount(),
      this.readClaudeAccount(),
    ]);

    const toml = await this.fs.readTextFile(this.configTomlPath);
    this.defaults = toml === undefined ? noDefaults : extractDefaults(toml);

    const claudeSettings = await this.fs.readTextFile(this.claudeSettingsPath);
    this.claudeDefaults =
      claudeSettings === undefined ? noClaudeDefaults : extractClaudeDefaults(claudeSettings);
  }

  /**
   * Codexのモデル一覧。`model/list` を優先し、取れなければキャッシュファイルを読む。
   *
   * CLIが新しいモデルに対応したとき拡張の更新なしで追随させたいので、静的な
   * キャッシュより実行時の問い合わせを上に置く。どちらも取れなければ空のまま返し、
   * effortの選択肢だけが既知の値へフォールバックする。
   */
  private async loadCodexModels(): Promise<ModelInfo[]> {
    const fromCli = await this.listCodexModels();
    if (fromCli.length > 0) {
      return fromCli;
    }

    this.log.warn('CLIからモデル一覧を取得できませんでした。キャッシュを読みます');
    const catalog = await this.fs.readTextFile(this.modelsCachePath);
    if (catalog === undefined) {
      this.log.warn(`モデル一覧を読めませんでした: ${this.modelsCachePath}`);
      return [];
    }
    const models = parseModelCatalog(catalog);
    if (models.length === 0) {
      this.log.warn('モデル一覧が空でした。既知の値へフォールバックします');
    }
    return models;
  }

  /** Claude Codeのモデル一覧。取れなければエイリアスの一覧へ退避する。 */
  private async loadClaudeModels(): Promise<ModelInfo[]> {
    const fromCli = await this.listClaudeModels();
    if (fromCli !== undefined && fromCli.length > 0) {
      return fromCli;
    }
    this.log.warn(
      'Claude Codeのモデル一覧を取得できませんでした。エイリアスの一覧へフォールバックします',
    );
    return claudeFallbackModels();
  }

  /**
   * Claude Codeのエージェント一覧。取れなければ空配列にする。
   *
   * モデルと違い「よく使われるエイリアス」のような意味のあるフォールバックが無い
   * （エージェント名はユーザー定義のカスタムエージェント次第で環境ごとに違う）ため、
   * 取得できなければ単に選択肢を出さない。既定（空文字＝CLI委譲）は常に選べる。
   */
  private async loadClaudeAgents(): Promise<ClaudeAgentInfo[]> {
    const fromCli = await this.listClaudeAgents();
    if (fromCli !== undefined) {
      return fromCli;
    }
    this.log.warn('Claude Codeのエージェント一覧を取得できませんでした。選択肢は既定のみになります');
    return [];
  }

  snapshot(): SettingsSnapshot {
    const config = readConfig();
    return {
      models: this.models,
      efforts: effortsFor(this.models, config.codex.model),
      model: config.codex.model,
      reasoningEffort: config.codex.reasoningEffort,
      approvalMode: config.codex.approvalMode,
      sandbox: config.codex.sandbox,
      defaults: this.defaults,
      profile: config.codex.profile,
      mcpServers: this.codexMcp,
      account: this.codexAccount,
    };
  }

  claudeSnapshot(): ClaudeSettingsSnapshot {
    const config = readClaudeConfig().claude;
    return {
      models: this.claudeModels,
      efforts: effortsFor(this.claudeModels, config.model, CLAUDE_EFFORTS),
      permissionModes: [...CLAUDE_PERMISSION_MODES],
      agents: this.claudeAgents,
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      agent: config.agent,
      defaults: this.claudeDefaults,
      mcpServers: this.claudeMcp,
      account: this.claudeAccount,
    };
  }

  /**
   * MCPサーバーの有効/無効を切り替える。
   *
   * 切替そのものはCLI側の状態を変えるだけで、この時点ではパネルの表示は更新しない。
   * 呼び出し側（`ControlPanelViewProvider`）が `load()` を呼び直してから表示を反映する
   * こと（成功/失敗にかかわらず、実際の状態を出すため）。
   */
  async toggleMcpServer(
    cli: 'codex' | 'claude',
    name: string,
    enabled: boolean,
  ): Promise<McpToggleResult> {
    const result = await (cli === 'codex'
      ? this.setCodexMcpServerEnabled(name, enabled)
      : this.setClaudeMcpServerEnabled(name, enabled));
    if (!result.ok) {
      this.log.warn(`MCPサーバーを切り替えられませんでした (${cli}/${name}): ${result.error}`);
    }
    return result;
  }

  /**
   * Codexからログアウトする（issue #29）。`codex logout` は資格情報を削除する不可逆な操作
   * のため、MCPの有効/無効切替とは違い確認ダイアログを必ず挟む。
   */
  async logoutCodex(): Promise<AccountActionResult> {
    if (!(await confirmLogout('Codex'))) {
      return { ok: false, error: undefined };
    }
    const result = await this.logoutCodexCli();
    if (result.code !== 0) {
      this.log.warn(`Codexからログアウトできませんでした: ${result.stderr.trim()}`);
      return { ok: false, error: result.stderr.trim() || '不明なエラー' };
    }
    this.log.info('Codexからログアウトしました');
    return { ok: true };
  }

  /** Claude Codeからログアウトする（issue #29）。 */
  async logoutClaude(): Promise<AccountActionResult> {
    if (!(await confirmLogout('Claude Code'))) {
      return { ok: false, error: undefined };
    }
    const result = await this.logoutClaudeCli();
    if (result.code !== 0) {
      this.log.warn(`Claude Codeからログアウトできませんでした: ${result.stderr.trim()}`);
      return { ok: false, error: result.stderr.trim() || '不明なエラー' };
    }
    this.log.info('Claude Codeからログアウトしました');
    return { ok: true };
  }

  /**
   * CodexへAPIキーでログインする（issue #29）。
   * キーの値はここから先（`codex login --with-api-key` の標準入力）にしか渡らず、
   * ログにも設定にも残さない。
   */
  async loginCodexApiKey(apiKey: string): Promise<AccountActionResult> {
    const result = await this.loginCodexApiKeyCli(apiKey);
    if (result.code !== 0) {
      this.log.warn(`CodexへAPIキーでログインできませんでした: ${result.stderr.trim()}`);
      return { ok: false, error: result.stderr.trim() || '不明なエラー' };
    }
    this.log.info('CodexへAPIキーでログインしました');
    return { ok: true };
  }

  /**
   * Claude Code側の設定を書き換える。
   *
   * `permissionMode` を `bypassPermissions` にすると確認なしでツールが動くため、
   * Codex側の危険な組み合わせと同じく明示の同意を取る。
   */
  async updateClaude(key: ClaudeEditableKey, value: string): Promise<boolean> {
    if (key === 'permissionMode' && value === 'bypassPermissions' && !(await confirmBypass())) {
      return false;
    }

    const section = vscode.workspace.getConfiguration('claude');
    await section.update(key, value, vscode.ConfigurationTarget.Global);
    this.log.info(`Claude設定を更新しました ${key}=${value === '' ? '(既定)' : value}`);

    // モデルによって選べるeffortが変わる（haikuのようにeffortを持たないモデルもある）
    if (key === 'model') {
      const allowed = effortsFor(this.claudeModels, value, CLAUDE_EFFORTS);
      const current = readClaudeConfig().claude.effort;
      if (current !== '' && !allowed.includes(current)) {
        await section.update('effort', '', vscode.ConfigurationTarget.Global);
        this.log.info(`${value} は effort=${current} に対応しないため既定へ戻しました`);
      }
    }

    return true;
  }

  /**
   * 設定を書き換える。
   *
   * `approvalMode` と `sandbox` は machine スコープのため、必ずユーザー設定へ書く。
   * ワークスペース設定への書き込みは失敗する。
   *
   * @returns 実際に変更したら true。確認で取り消された場合は false。
   */
  async update(key: EditableKey, value: string): Promise<boolean> {
    const config = readConfig();
    const next = { ...config.codex, [key]: value };

    // 権限を広げる変更は、会話の途中でも必ず断りを入れる（次の発言から効く）
    if (
      key === 'sandbox' &&
      isSandboxRelaxed(config.codex.sandbox, value) &&
      !(await confirmRelaxedSandbox(value))
    ) {
      return false;
    }

    if (
      next.sandbox === 'danger-full-access' &&
      next.approvalMode === 'never' &&
      !(await confirmUnsafe())
    ) {
      return false;
    }

    const section = vscode.workspace.getConfiguration('codex');
    await section.update(key, value, vscode.ConfigurationTarget.Global);
    this.log.info(`設定を更新しました ${key}=${value === '' ? '(既定)' : value}`);

    // モデルを変えると選べるeffortが変わる。現在値が非対応なら既定へ戻す。
    if (key === 'model') {
      const allowed = effortsFor(this.models, value);
      const current = readConfig().codex.reasoningEffort;
      if (current !== '' && !allowed.includes(current)) {
        await section.update('reasoningEffort', '', vscode.ConfigurationTarget.Global);
        this.log.info(`${value} は effort=${current} に対応しないため既定へ戻しました`);
      }
    }

    return true;
  }
}

/** ログアウトは資格情報を削除する不可逆な操作のため、必ず確認を挟む（issue #29）。 */
async function confirmLogout(label: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `${label}からログアウトします。保存されている認証情報が削除されます。`,
    { modal: true },
    'ログアウトする',
  );
  return choice === 'ログアウトする';
}

async function confirmBypass(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    '承認を無効にします。Claude Codeはツールを確認なしで実行します。',
    { modal: true },
    'この設定にする',
  );
  return choice === 'この設定にする';
}

/** 広げる先ごとの、実際に何が起きるか。 */
const RELAXED_SANDBOX_DETAIL: Record<string, string> = {
  'workspace-write': 'Codexは作業フォルダの中へ承認なしで書き込めるようになります。',
  'danger-full-access': 'Codexはファイルもネットワークも制限なく扱えるようになります。',
};

async function confirmRelaxedSandbox(value: string): Promise<boolean> {
  const detail = RELAXED_SANDBOX_DETAIL[value] ?? 'Codexの権限が広がります。';
  const choice = await vscode.window.showWarningMessage(
    `サンドボックスを ${value} に変更します。${detail}`,
    { modal: true },
    'この設定にする',
  );
  return choice === 'この設定にする';
}

async function confirmUnsafe(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'サンドボックスと承認の両方を無効にします。Codexはコマンドを確認なしで実行します。',
    { modal: true },
    'この組み合わせにする',
  );
  return choice === 'この組み合わせにする';
}
