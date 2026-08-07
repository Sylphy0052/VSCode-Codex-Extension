import * as vscode from 'vscode';
import { extractDefaults, noDefaults, type CodexDefaults } from '../codex/configToml';
import { effortsFor, parseModelCatalog, type ModelInfo } from '../codex/modelCatalog';
import { readConfig } from '../config';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';

/** Webviewから変更を許すキー。ここに無いキーは無視する。 */
export const EDITABLE_KEYS = ['model', 'reasoningEffort', 'approvalMode', 'sandbox'] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];

export function isEditableKey(value: unknown): value is EditableKey {
  return typeof value === 'string' && (EDITABLE_KEYS as readonly string[]).includes(value);
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

/**
 * モデル・effort・承認方法・サンドボックスの選択肢と現在値を供給する。
 *
 * 設定パネルとCodex画面の両方が同じ選択肢と同じ書き込み規則を使うよう、ここに集約する。
 */
export class SettingsProvider {
  private models: ModelInfo[] = [];
  private defaults: CodexDefaults = noDefaults;

  constructor(
    private readonly fs: FileSystemPort,
    private readonly modelsCachePath: string,
    private readonly configTomlPath: string,
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

  /** カタログと既定値を読み直す。 */
  async load(): Promise<void> {
    this.loaded = true;
    const catalog = await this.fs.readTextFile(this.modelsCachePath);
    if (catalog === undefined) {
      this.log.warn(`モデル一覧を読めませんでした: ${this.modelsCachePath}`);
      this.models = [];
    } else {
      this.models = parseModelCatalog(catalog);
      if (this.models.length === 0) {
        this.log.warn('モデル一覧が空でした。既知の値へフォールバックします');
      }
    }

    const toml = await this.fs.readTextFile(this.configTomlPath);
    this.defaults = toml === undefined ? noDefaults : extractDefaults(toml);
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

async function confirmUnsafe(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'サンドボックスと承認の両方を無効にします。Codexはコマンドを確認なしで実行します。',
    { modal: true },
    'この組み合わせにする',
  );
  return choice === 'この組み合わせにする';
}
