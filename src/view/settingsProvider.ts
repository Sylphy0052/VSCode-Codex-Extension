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
import type { HooksSnapshot } from '../provider/hooks';
import { accountNotLoadedYet, type AccountSnapshot } from '../provider/account';
import type { McpServersSnapshot } from '../provider/mcpServers';
import type { AppsSnapshot, PluginsSnapshot } from '../provider/plugins';
import type { SkillsSnapshot } from '../provider/skills';
import {
  isValidImportItemKey,
  type ImportHistorySnapshot,
  type ImportItemView,
  type ImportRunResult,
  type ImportSnapshot,
} from '../provider/import';
import type { CommandResult } from '../process/commandRunner';
import type { FileSystemPort } from '../session/ports';

/** 一覧をまだ読んでいない状態。CLIへの問い合わせが空だったのと区別する。 */
const notLoadedYet: McpServersSnapshot = { ok: false, reason: 'まだ読み込んでいません' };

/** hooksの一覧をまだ読んでいない状態。 */
const hooksNotLoadedYet: HooksSnapshot = { ok: false, reason: 'まだ読み込んでいません' };

/** skillsの一覧をまだ読んでいない状態。 */
const skillsNotLoadedYet: SkillsSnapshot = { ok: false, reason: 'まだ読み込んでいません' };

/** pluginsの一覧をまだ読んでいない状態。 */
const pluginsNotLoadedYet: PluginsSnapshot = { ok: false, reason: 'まだ読み込んでいません' };

/** appsの一覧をまだ読んでいない状態（Codexのみ）。 */
const appsNotLoadedYet: AppsSnapshot = { ok: false, reason: 'まだ読み込んでいません' };

/** インポート候補の一覧をまだ読んでいない状態（Codexのみ、issue #36）。 */
const importNotLoadedYet: ImportSnapshot = { ok: false, reason: 'まだ読み込んでいません' };

/** インポート履歴をまだ読んでいない状態（Codexのみ、issue #36）。 */
const importHistoryNotLoadedYet: ImportHistorySnapshot = {
  ok: false,
  reason: 'まだ読み込んでいません',
};

/**
 * `setMcpServerEnabled` / `ClaudeMcpProbe.toggle` / `setHookTrusted` と同じ形の結果。
 * MCPサーバーの切替以外（hookの信頼）にも使うため、名前はそのままに用途を広げている。
 */
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

/**
 * 遅延取得の対象となるセクション識別子（issue #225）。
 *
 * Codex側の7セクション（アカウント/MCP/hooks/skills/plugins/apps/インポート）と
 * Claude Code側の5セクション（アカウント/MCP/hooks/skills/plugins）を合わせた12種類。
 * 展開されたときだけ `SettingsProvider.ensureSectionLoaded` が対応する取得を行う。
 */
export const SECTION_IDS = [
  'codexAccount',
  'codexMcp',
  'codexHooks',
  'codexSkills',
  'codexPlugins',
  'codexApps',
  'codexImport',
  'claudeAccount',
  'claudeMcp',
  'claudeHooks',
  'claudeSkills',
  'claudePlugins',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string' && (SECTION_IDS as readonly string[]).includes(value);
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
  /** hooksの一覧・信頼状態（issue #28）。 */
  hooks: HooksSnapshot;
  /** skillsの一覧・有効無効（issue #35、design.md TP-56）。 */
  skills: SkillsSnapshot;
  /** ログイン状態（issue #29）。 */
  account: AccountSnapshot;
  /** pluginsの一覧（issue #32、design.md §14.20）。 */
  plugins: PluginsSnapshot;
  /** appsの一覧（issue #32、design.md §14.20。Codexのみ）。 */
  apps: AppsSnapshot;
  /** 他エージェントからの設定インポート候補（issue #36、design.md TP-57。Codexのみ）。 */
  importCandidates: ImportSnapshot;
  /** インポートの実行履歴（issue #36。Codexのみ）。 */
  importHistory: ImportHistorySnapshot;
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
  /** hooksの一覧（issue #28）。Claude Codeは信頼状態を返さない（`HookView.trust` が参照）。 */
  hooks: HooksSnapshot;
  /**
   * skillsの一覧（issue #35、design.md TP-56）。Claude Codeは有効/無効を切り替える経路も
   * 判別する経路も無い（`SkillView.toggleable` が参照）。
   */
  skills: SkillsSnapshot;
  /** ログイン状態（issue #29）。 */
  account: AccountSnapshot;
  /**
   * pluginsの一覧（issue #32、design.md §14.20）。Claude Codeは有効/無効・
   * インストール/アンインストールをすべてCLIサブコマンド経由で扱える（`PluginView.toggleable`
   * / `removable` が参照）。
   */
  plugins: PluginsSnapshot;
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
  private codexHooks: HooksSnapshot = hooksNotLoadedYet;
  private codexSkills: SkillsSnapshot = skillsNotLoadedYet;
  private codexAccount: AccountSnapshot = accountNotLoadedYet;
  private codexPlugins: PluginsSnapshot = pluginsNotLoadedYet;
  private codexApps: AppsSnapshot = appsNotLoadedYet;
  private codexImport: ImportSnapshot = importNotLoadedYet;
  private codexImportHistory: ImportHistorySnapshot = importHistoryNotLoadedYet;
  /** `runCodexImport` へそのまま再送するための、キーごとの生の項目（issue #36）。 */
  private codexImportRawByKey: Map<string, unknown> = new Map();
  /**
   * 一度でも展開して取得したセクション（issue #225）。`load()` はここに含まれる
   * セクションだけを読み直し、含まれないセクション（畳んだまま一度も開いていないもの）
   * のCLIは起動しない。
   */
  private loadedSections: Set<SectionId> = new Set();

  private claudeModels: ModelInfo[] = [];
  private claudeDefaults: ClaudeDefaults = noClaudeDefaults;
  private claudeAgents: ClaudeAgentInfo[] = [];
  private claudeMcp: McpServersSnapshot = notLoadedYet;
  private claudeHooks: HooksSnapshot = hooksNotLoadedYet;
  private claudeSkills: SkillsSnapshot = skillsNotLoadedYet;
  private claudeAccount: AccountSnapshot = accountNotLoadedYet;
  private claudePlugins: PluginsSnapshot = pluginsNotLoadedYet;

  /**
   * @param listCodexModels `model/list` の結果。取れなければ空配列。
   * @param listClaudeModels `initialize` の応答の一覧。取れなければ `undefined`。
   * @param listClaudeAgents `initialize` の応答の `agents`。取れなければ `undefined`
   *   （モデルと違い意味のあるフォールバック一覧が無いため、呼び出し側は選択肢を出さない）。
   * @param listCodexMcpServers `mcpServerStatus/list` + `config/read` を突き合わせた結果。
   * @param listClaudeMcpServers `mcp_status` の結果。
   * @param setCodexMcpServerEnabled `config/value/write` + `config/mcpServer/reload`。
   * @param setClaudeMcpServerEnabled `mcp_toggle`。
   * @param listCodexHooks `hooks/list` の結果。
   * @param listClaudeHooks `get_settings` の `effective.hooks` から組み立てた結果。
   * @param setCodexHookTrusted `config/batchWrite` でhookの信頼を書く（issue #28）。
   *   Claude Code側には対応する経路が無いため、書き込みメソッドを持たない。
   * @param listCodexSkills `skills/list` の結果（issue #35、design.md TP-56）。
   * @param listClaudeSkills `reload_skills` の結果。
   * @param setCodexSkillEnabled `skills/config/write` でskillの有効/無効を書く。
   *   Claude Code側には対応する経路が無いため、書き込みメソッドを持たない。
   * @param readCodexAccount `account/read` の結果（issue #29）。
   * @param readClaudeAccount `claude auth status --json` の結果（issue #29）。
   * @param logoutCodexCli `codex logout` の実行結果。
   * @param logoutClaudeCli `claude auth logout` の実行結果。
   * @param loginCodexApiKeyCli `codex login --with-api-key` の実行結果。
   * @param listCodexPlugins `plugin/installed` + `plugin/read` を突き合わせた結果
   *   （issue #32、design.md §14.20）。
   * @param listClaudePlugins `claude plugin list --json` + `claude plugin details` を
   *   突き合わせた結果。
   * @param installCodexPluginCli `plugin/install`。Codexには有効/無効の書き込み経路が無い
   *   （`PluginView.toggleable` が参照）。
   * @param uninstallCodexPluginCli `plugin/uninstall`。
   * @param toggleClaudePluginCli `claude plugin enable` / `disable`。
   * @param installClaudePluginCli `claude plugin install`。
   * @param uninstallClaudePluginCli `claude plugin uninstall`。
   * @param listCodexApps `app/installed` + `app/read` を突き合わせた結果（Codexのみ。
   *   有効/無効・インストール操作の確定した経路が無いため閲覧のみ）。
   * @param detectCodexImportCandidates `externalAgentConfig/detect` の結果（issue #36、
   *   design.md TP-57。Codexのみ）。`snapshot` は画面表示用、`rawByKey` は
   *   `runCodexImport` が実行時にそのまま再送するための生データ。
   * @param readCodexImportHistories `externalAgentConfig/import/readHistories` の結果。
   * @param runCodexImportCli `externalAgentConfig/import`。設定を書き換える操作のため、
   *   `runCodexImport` が確認ダイアログを必ず挟んでから呼ぶ。
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
    private readonly listCodexHooks: () => Promise<HooksSnapshot>,
    private readonly listClaudeHooks: () => Promise<HooksSnapshot>,
    private readonly setCodexHookTrusted: (
      key: string,
      currentHash: string,
    ) => Promise<McpToggleResult>,
    private readonly listCodexSkills: () => Promise<SkillsSnapshot>,
    private readonly listClaudeSkills: () => Promise<SkillsSnapshot>,
    private readonly setCodexSkillEnabled: (
      path: string,
      enabled: boolean,
    ) => Promise<McpToggleResult>,
    private readonly readCodexAccount: () => Promise<AccountSnapshot>,
    private readonly readClaudeAccount: () => Promise<AccountSnapshot>,
    private readonly logoutCodexCli: () => Promise<CommandResult>,
    private readonly logoutClaudeCli: () => Promise<CommandResult>,
    private readonly loginCodexApiKeyCli: (apiKey: string) => Promise<CommandResult>,
    private readonly listCodexPlugins: () => Promise<PluginsSnapshot>,
    private readonly listClaudePlugins: () => Promise<PluginsSnapshot>,
    private readonly installCodexPluginCli: (
      pluginName: string,
      marketplace: { path: string | undefined; remoteMarketplaceName: string | undefined },
    ) => Promise<McpToggleResult>,
    private readonly uninstallCodexPluginCli: (pluginId: string) => Promise<McpToggleResult>,
    private readonly toggleClaudePluginCli: (
      id: string,
      scope: string | undefined,
      enabled: boolean,
    ) => Promise<CommandResult>,
    private readonly installClaudePluginCli: (
      spec: string,
      scope: string | undefined,
    ) => Promise<CommandResult>,
    private readonly uninstallClaudePluginCli: (
      id: string,
      scope: string | undefined,
    ) => Promise<CommandResult>,
    private readonly listCodexApps: () => Promise<AppsSnapshot>,
    private readonly detectCodexImportCandidates: () => Promise<{
      snapshot: ImportSnapshot;
      rawByKey: Map<string, unknown>;
    }>,
    private readonly readCodexImportHistories: () => Promise<ImportHistorySnapshot>,
    private readonly runCodexImportCli: (items: unknown[]) => Promise<ImportRunResult>,
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

  /**
   * 即時に読むもの（モデル・reasoning effort・エージェントの選択肢と、config.toml /
   * settings.jsonの既定値）を読み直す（issue #225）。
   *
   * モデル・エージェントの一覧はCLIの起動を伴うが、常にパネルへ表示する項目
   * （セクションの開閉に関わらず要る）のため、ここでは畳み対応の対象にしない。
   * config.toml / settings.jsonの読みはファイル読みのみでプロセス起動を伴わない。
   */
  private async loadImmediate(): Promise<void> {
    this.loaded = true;
    // CLIの起動を待つ時間が二重にならないよう、まとめて聞く
    [this.models, this.claudeModels, this.claudeAgents] = await Promise.all([
      this.loadCodexModels(),
      this.loadClaudeModels(),
      this.loadClaudeAgents(),
    ]);

    const toml = await this.fs.readTextFile(this.configTomlPath);
    this.defaults = toml === undefined ? noDefaults : extractDefaults(toml);

    const claudeSettings = await this.fs.readTextFile(this.claudeSettingsPath);
    this.claudeDefaults =
      claudeSettings === undefined ? noClaudeDefaults : extractClaudeDefaults(claudeSettings);
  }

  /**
   * 指定したセクション1件だけを実際に取得し、結果を保持する（issue #225）。
   * 呼ぶたびに必ずCLIを起動し直す。キャッシュを見て起動を省くかどうかは
   * 呼び出し側（`ensureSectionLoaded`）の責務にする。
   */
  private async fetchSection(id: SectionId): Promise<void> {
    switch (id) {
      case 'codexAccount':
        this.codexAccount = await this.readCodexAccount();
        break;
      case 'claudeAccount':
        this.claudeAccount = await this.readClaudeAccount();
        break;
      case 'codexMcp':
        this.codexMcp = await this.listCodexMcpServers();
        break;
      case 'claudeMcp':
        this.claudeMcp = await this.listClaudeMcpServers();
        break;
      case 'codexHooks':
        this.codexHooks = await this.listCodexHooks();
        break;
      case 'claudeHooks':
        this.claudeHooks = await this.listClaudeHooks();
        break;
      case 'codexSkills':
        this.codexSkills = await this.listCodexSkills();
        break;
      case 'claudeSkills':
        this.claudeSkills = await this.listClaudeSkills();
        break;
      case 'codexPlugins':
        this.codexPlugins = await this.listCodexPlugins();
        break;
      case 'claudePlugins':
        this.claudePlugins = await this.listClaudePlugins();
        break;
      case 'codexApps':
        this.codexApps = await this.listCodexApps();
        break;
      case 'codexImport':
        // 候補一覧と履歴は同じ「インポート」セクションの中身なので、まとめて1回で取得する
        [this.codexImport, this.codexImportHistory] = await Promise.all([
          this.loadCodexImportCandidates(),
          this.readCodexImportHistories(),
        ]);
        break;
      default: {
        const exhaustive: never = id;
        throw new Error(`未知のセクションです: ${String(exhaustive)}`);
      }
    }
    this.loadedSections.add(id);
  }

  /**
   * セクションを未取得なら取得する（issue #225、webviewの`toggleSection`から呼ぶ）。
   * 既に一度取得済みのセクションは何もしない（開き直すたびにCLIを起動し直さないため）。
   * 取り直したいときは `load()` を呼ぶこと。
   */
  async ensureSectionLoaded(id: SectionId): Promise<void> {
    if (!this.loadedSections.has(id)) {
      await this.fetchSection(id);
    }
  }

  /**
   * 即時に読むものと、これまでに一度でも展開して取得したセクションをまとめて読み直す
   * （issue #225）。一度も展開していないセクションはここでも読まない
   * （パネルを開いた直後・畳んだままのセクションでCLIを起動しないのが目的）。
   *
   * MCPの有効/無効切替やhookの信頼など、既存の操作の直後にこれを呼ぶことで、
   * 開いているセクションの表示を実際の状態へ揃える（展開済みセクションは
   * 引き続き読み直しの対象になる）。
   */
  async load(): Promise<void> {
    await this.loadImmediate();
    await Promise.all([...this.loadedSections].map((id) => this.fetchSection(id)));
  }

  /**
   * インポート候補を読み、実行時に再送する生データ（`codexImportRawByKey`）を
   * 副作用として更新する（issue #36）。`load()` の `Promise.all` から呼ぶため、
   * 一覧の値（`ImportSnapshot`）だけを返す形に揃えている。
   */
  private async loadCodexImportCandidates(): Promise<ImportSnapshot> {
    const { snapshot, rawByKey } = await this.detectCodexImportCandidates();
    this.codexImportRawByKey = rawByKey;
    return snapshot;
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
    this.log.warn(
      'Claude Codeのエージェント一覧を取得できませんでした。選択肢は既定のみになります',
    );
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
      hooks: this.codexHooks,
      skills: this.codexSkills,
      account: this.codexAccount,
      plugins: this.codexPlugins,
      apps: this.codexApps,
      importCandidates: this.codexImport,
      importHistory: this.codexImportHistory,
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
      hooks: this.claudeHooks,
      skills: this.claudeSkills,
      account: this.claudeAccount,
      plugins: this.claudePlugins,
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
   * Codexのhookを信頼する（issue #28）。
   *
   * Claude Codeには対応する経路が無い（`hooksSettings.ts` 参照）ため、Codex専用にする。
   * `toggleMcpServer` と同じく、この時点ではパネルの表示は更新しない。呼び出し側が
   * `load()` を呼び直してから表示を反映すること。
   */
  async trustCodexHook(key: string, currentHash: string): Promise<McpToggleResult> {
    const result = await this.setCodexHookTrusted(key, currentHash);
    if (!result.ok) {
      this.log.warn(`hookを信頼できませんでした (${key}): ${result.error}`);
    }
    return result;
  }

  /**
   * skillの有効/無効を切り替える（issue #35）。
   *
   * Claude Codeには対応する経路が無い（`skillsList.ts` 参照）ため、Codex専用にする。
   * `trustCodexHook` と同じく、この時点ではパネルの表示は更新しない。呼び出し側が
   * `load()` を呼び直してから表示を反映すること。
   */
  async toggleCodexSkill(path: string, enabled: boolean): Promise<McpToggleResult> {
    const result = await this.setCodexSkillEnabled(path, enabled);
    if (!result.ok) {
      this.log.warn(`skillを切り替えられませんでした (${path}): ${result.error}`);
    }
    return result;
  }

  /**
   * Claude Codeのskills一覧を読み直す（issue #202、design.md TP-90）。
   *
   * Claude Codeには一覧専用の経路が無く、`reload_skills` control_requestが一覧取得を
   * 兼ねる（`skillsList.ts`参照）ため、`listClaudeSkills`を呼び直すだけで「読み直し」
   * そのものになる。skills一覧だけを対象にした軽い読み直しにするため、`load()`の
   * ように他の一覧（モデル・MCP・hooks等）まで含めた全体の読み直しはしない。呼び出し側
   * （`ControlPanelViewProvider`）はこの後で画面を再描画すること。
   */
  async reloadClaudeSkills(): Promise<void> {
    this.claudeSkills = await this.listClaudeSkills();
    // ボタンはskillsセクションの中にしか無く、押せる時点でセクションは展開済みのはずだが、
    // 万一のずれに備えて明示的に「取得済み」へ揃えておく（issue #225）
    this.loadedSections.add('claudeSkills');
  }

  /**
   * 他エージェントからの設定インポートを実行する（issue #36、design.md TP-57）。
   * **設定を書き換える操作**。実行前に対象（何を・どこから・どこへ）を示して確認を取る
   * （§8のセキュリティ考慮）。
   *
   * `keys` は直前の `load()` で読んだ `codexImportRawByKey` のキー。一覧が更新される前の
   * 古いキーが渡された場合はその項目だけを黙って除外する（一覧の再読込を跨いだ選択の
   * ずれをエラーにはしない）。
   */
  async runCodexImport(keys: string[]): Promise<ImportRunResult> {
    const validKeys = new Set(keys.filter(isValidImportItemKey));
    const items =
      this.codexImport.ok === true
        ? this.codexImport.items.filter((item) => validKeys.has(item.key))
        : [];
    if (items.length === 0) {
      return { ok: false, error: '選択された項目がありません' };
    }

    if (!(await confirmImport(items))) {
      return { ok: false, error: undefined };
    }

    const rawItems = items
      .map((item) => this.codexImportRawByKey.get(item.key))
      .filter((raw): raw is NonNullable<typeof raw> => raw !== undefined);
    if (rawItems.length === 0) {
      return {
        ok: false,
        error: '選択された項目の内容を読み直せませんでした。一覧を更新してからやり直してください',
      };
    }

    const result = await this.runCodexImportCli(rawItems);
    if (!result.ok) {
      this.log.warn(`インポートを実行できませんでした: ${result.error}`);
    } else if (result.results === undefined) {
      this.log.warn(
        `インポート完了の通知が届きませんでした (importId: ${result.importId})。履歴一覧で後から確認してください`,
      );
    } else {
      this.log.info(`インポートを実行しました (importId: ${result.importId})`);
    }
    return result;
  }

  /**
   * Codexのpluginをインストールする（issue #32）。
   *
   * pluginは任意のコード（hookやMCPサーバー）を持ち込む仕組みのため、確認ダイアログで
   * 「何をどこから入れるか」を明示してから実行する（design.md §14.20・§8のセキュリティ考慮）。
   */
  async installCodexPlugin(
    pluginName: string,
    marketplace: { name: string; path: string | undefined },
  ): Promise<AccountActionResult> {
    if (!(await confirmInstallPlugin(pluginName, marketplace.name))) {
      return { ok: false, error: undefined };
    }
    const result = await this.installCodexPluginCli(pluginName, {
      path: marketplace.path,
      remoteMarketplaceName: marketplace.path === undefined ? marketplace.name : undefined,
    });
    if (!result.ok) {
      this.log.warn(`pluginをインストールできませんでした (${pluginName}): ${result.error}`);
      return { ok: false, error: result.error };
    }
    this.log.info(`pluginをインストールしました (${pluginName})`);
    return { ok: true };
  }

  /**
   * Codexのpluginをアンインストールする（issue #32）。ローカルのコードを削除する
   * 不可逆な操作のため、確認ダイアログを必ず挟む。
   */
  async uninstallCodexPlugin(pluginId: string, pluginName: string): Promise<AccountActionResult> {
    if (!(await confirmUninstallPlugin(pluginName))) {
      return { ok: false, error: undefined };
    }
    const result = await this.uninstallCodexPluginCli(pluginId);
    if (!result.ok) {
      this.log.warn(`pluginをアンインストールできませんでした (${pluginId}): ${result.error}`);
      return { ok: false, error: result.error };
    }
    this.log.info(`pluginをアンインストールしました (${pluginId})`);
    return { ok: true };
  }

  /**
   * Claude Codeのpluginの有効/無効を切り替える（issue #32）。
   *
   * `claude plugin enable` / `disable` は破壊的操作ではない（コードの削除もダウンロードも
   * 伴わない）ため、MCP/skillsの切替と同じく確認ダイアログは挟まない。
   */
  async toggleClaudePlugin(
    id: string,
    scope: string | undefined,
    enabled: boolean,
  ): Promise<McpToggleResult> {
    const result = await this.toggleClaudePluginCli(id, scope, enabled);
    if (result.code !== 0) {
      const error = result.stderr.trim() || '不明なエラー';
      this.log.warn(`pluginを切り替えられませんでした (${id}): ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  }

  /**
   * Claude Codeのpluginをインストールする（issue #32）。
   *
   * pluginは任意のコード（hookやMCPサーバー）を持ち込む仕組みのため、確認ダイアログで
   * 「何をどこから入れるか」を明示してから実行する（design.md §14.20・§8のセキュリティ考慮）。
   */
  async installClaudePlugin(spec: string): Promise<AccountActionResult> {
    if (!(await confirmInstallPlugin(spec, undefined))) {
      return { ok: false, error: undefined };
    }
    const result = await this.installClaudePluginCli(spec, undefined);
    if (result.code !== 0) {
      const error = result.stderr.trim() || '不明なエラー';
      this.log.warn(`pluginをインストールできませんでした (${spec}): ${error}`);
      return { ok: false, error };
    }
    this.log.info(`pluginをインストールしました (${spec})`);
    return { ok: true };
  }

  /**
   * Claude Codeのpluginをアンインストールする（issue #32）。ローカルのコードを削除する
   * 不可逆な操作のため、確認ダイアログを必ず挟む。
   */
  async uninstallClaudePlugin(
    id: string,
    scope: string | undefined,
    pluginName: string,
  ): Promise<AccountActionResult> {
    if (!(await confirmUninstallPlugin(pluginName))) {
      return { ok: false, error: undefined };
    }
    const result = await this.uninstallClaudePluginCli(id, scope);
    if (result.code !== 0) {
      const error = result.stderr.trim() || '不明なエラー';
      this.log.warn(`pluginをアンインストールできませんでした (${id}): ${error}`);
      return { ok: false, error };
    }
    this.log.info(`pluginをアンインストールしました (${id})`);
    return { ok: true };
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

/**
 * 他エージェントからの設定インポートは既存の設定を書き換えうる操作のため、
 * 何を・どこから・どこへ取り込むかを明示して必ず確認を挟む（issue #36、design.md TP-57、
 * §8のセキュリティ考慮）。`description` はCLIが返す文言（英語、そのまま）で、
 * 何を・どこから・どこへが書かれている。
 */
async function confirmImport(items: ImportItemView[]): Promise<boolean> {
  const lines = items.map((item) => `・${item.label}: ${item.description}`);
  const hasConfig = items.some((item) => item.itemType === 'CONFIG');
  const detailLines = hasConfig
    ? [...lines, '', '「設定」を含むため、既存の config.toml の値を上書きすることがあります。']
    : lines;
  const choice = await vscode.window.showWarningMessage(
    `選択した${items.length}件をインポートします。`,
    { modal: true, detail: detailLines.join('\n') },
    'インポートする',
  );
  return choice === 'インポートする';
}

/**
 * pluginのインストールは外部から任意のコード（hookやMCPサーバーを含む）を持ち込む操作
 * のため、何をどこから入れるかを明示して必ず確認を挟む（issue #32、design.md §14.20）。
 */
async function confirmInstallPlugin(
  pluginName: string,
  marketplace: string | undefined,
): Promise<boolean> {
  const source = marketplace === undefined ? '' : `（マーケットプレイス: ${marketplace}）`;
  const choice = await vscode.window.showWarningMessage(
    `plugin「${pluginName}」${source}をインストールします。hookやMCPサーバーなど任意のコードが持ち込まれる可能性があります。`,
    { modal: true },
    'インストールする',
  );
  return choice === 'インストールする';
}

/** pluginのアンインストールはローカルのコードを削除する不可逆な操作のため、必ず確認を挟む（issue #32）。 */
async function confirmUninstallPlugin(pluginName: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `plugin「${pluginName}」をアンインストールします。ローカルに保存されているコードが削除されます。`,
    { modal: true },
    'アンインストールする',
  );
  return choice === 'アンインストールする';
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
