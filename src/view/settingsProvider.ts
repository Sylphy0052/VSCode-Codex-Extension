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
import type { FileSystemPort } from '../session/ports';

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
}

/**
 * モデル・effort・承認方法・サンドボックスの選択肢と現在値を供給する。
 *
 * 設定パネルとCodex画面の両方が同じ選択肢と同じ書き込み規則を使うよう、ここに集約する。
 */
export class SettingsProvider {
  private models: ModelInfo[] = [];
  private defaults: CodexDefaults = noDefaults;

  private claudeModels: ModelInfo[] = [];
  private claudeDefaults: ClaudeDefaults = noClaudeDefaults;
  private claudeAgents: ClaudeAgentInfo[] = [];

  /**
   * @param listCodexModels `model/list` の結果。取れなければ空配列。
   * @param listClaudeModels `initialize` の応答の一覧。取れなければ `undefined`。
   * @param listClaudeAgents `initialize` の応答の `agents`。取れなければ `undefined`
   *   （モデルと違い意味のあるフォールバック一覧が無いため、呼び出し側は選択肢を出さない）。
   */
  constructor(
    private readonly fs: FileSystemPort,
    private readonly modelsCachePath: string,
    private readonly configTomlPath: string,
    private readonly claudeSettingsPath: string,
    private readonly listCodexModels: () => Promise<ModelInfo[]>,
    private readonly listClaudeModels: () => Promise<ModelInfo[] | undefined>,
    private readonly listClaudeAgents: () => Promise<ClaudeAgentInfo[] | undefined>,
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

  /** モデル一覧と既定値を読み直す。 */
  async load(): Promise<void> {
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
    };
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
