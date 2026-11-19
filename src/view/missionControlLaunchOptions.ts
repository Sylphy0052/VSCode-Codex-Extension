import { CLAUDE_EFFORTS } from '../claude/types';
import { effortsFor, FALLBACK_EFFORTS, type ModelInfo } from '../codex/modelCatalog';
import { buildEffectivePresetConfig, type SessionPreset } from '../sessionPresets';
import {
  CLAUDE_PERMISSION_SAFETY_ORDER,
  clampClaudePermissionMode,
  clampCodexApprovalMode,
  CODEX_APPROVAL_SAFETY_ORDER,
  type SafetyBaseline,
} from '../util/safetyClamp';
import type {
  McLaunchChoices,
  McLaunchDefaults,
  McLaunchProviderChoices,
  McLaunchSettings,
  McProvider,
} from '../webview/missionControl/protocol';

/**
 * Mission Controlの開始ダイアログで選ぶmodel・effort・承認方針・プリセット（Issue #2149の2）。
 * vscodeに依らない部分。
 *
 * プリセット付きの起動（`agent.openPresetChat`）と同じく、実効値は
 * `buildEffectivePresetConfig`で組み立てる。承認方針は拡張機能の設定より緩められない。
 */

/** 1つの値の長さの上限（文字数）。model名・プリセット名に十分な長さ。 */
export const MAX_LAUNCH_SETTING_CHARS = 200;
/** repoごとに覚える前回の選択の件数。 */
export const MAX_LAUNCH_DEFAULTS = 50;

const PROVIDERS: readonly McProvider[] = ['codex', 'claude'];

/** 拡張機能の今の設定のうち、開始ダイアログに要る分。 */
export interface LaunchCurrentSettings {
  model: string;
  effort: string;
  approval: string;
}

export interface LaunchCatalog {
  models: Record<McProvider, readonly ModelInfo[]>;
  presets: readonly SessionPreset[];
  baseline: SafetyBaseline;
  current: Record<McProvider, LaunchCurrentSettings>;
}

function readSetting(value: unknown): string | undefined | false {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_LAUNCH_SETTING_CHARS ||
    // 制御文字はCLIの引数・設定へ渡す値として不正
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  return value;
}

/** webviewから届いた設定を確かめる。不正なら理由の文を返す。 */
export function parseLaunchSettings(message: Record<string, unknown>): McLaunchSettings | string {
  const result: McLaunchSettings = {};
  for (const key of ['model', 'effort', 'approval', 'preset'] as const) {
    const value = readSetting(message[key]);
    if (value === false) {
      return `${key}の指定が不正です`;
    }
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function effortFallback(provider: McProvider): readonly string[] {
  return provider === 'claude' ? CLAUDE_EFFORTS : FALLBACK_EFFORTS;
}

function approvalOrder(provider: McProvider): readonly string[] {
  return provider === 'claude' ? CLAUDE_PERMISSION_SAFETY_ORDER : CODEX_APPROVAL_SAFETY_ORDER;
}

function clampApproval(provider: McProvider, baseline: SafetyBaseline, value: string) {
  return provider === 'claude'
    ? clampClaudePermissionMode(baseline.claudePermissionMode, value)
    : clampCodexApprovalMode(baseline.codexApprovalMode, value);
}

/** 拡張機能の設定と同じか、それより厳しい承認方針（クランプで通るものだけ）。 */
export function allowedApprovals(provider: McProvider, baseline: SafetyBaseline): string[] {
  return approvalOrder(provider).filter((value) => {
    const result = clampApproval(provider, baseline, value);
    return result.warning === undefined && result.value === value;
  });
}

function providerChoices(provider: McProvider, catalog: LaunchCatalog): McLaunchProviderChoices {
  const models = catalog.models[provider];
  return {
    models: models.map((model) => ({
      slug: model.slug,
      label: model.displayName === '' ? model.slug : model.displayName,
      efforts: effortsFor([...models], model.slug, effortFallback(provider)),
    })),
    efforts: effortsFor([...models], '', effortFallback(provider)),
    approvals: allowedApprovals(provider, catalog.baseline).map((value) => ({
      value,
      label: value,
    })),
    current: catalog.current[provider],
  };
}

export function buildLaunchChoices(
  catalog: LaunchCatalog,
  defaults: Record<string, McLaunchDefaults>,
): McLaunchChoices {
  return {
    providers: {
      codex: providerChoices('codex', catalog),
      claude: providerChoices('claude', catalog),
    },
    presets: catalog.presets.map((preset) => ({
      name: preset.name,
      provider: preset.provider === 'claude' ? 'claude' : 'codex',
      model: preset.model,
      effort: preset.effort,
      approval: preset.approvalMode,
    })),
    defaults,
  };
}

/** 起動に使う実効値。`openNew`へ渡す設定の上書き分。 */
export interface EffectiveLaunchSettings {
  model: string;
  effort: string;
  approvalMode: string;
  /** Codexのみ。プリセットの`sandbox`をクランプした値（空文字は設定のまま）。 */
  sandbox: string;
  /** プリセットの緩める指定を無視した等の警告。ログへ出す。 */
  warnings: string[];
}

/**
 * 選んだ設定から実効値を組み立てる。何も選んでいなければ`undefined`（既定の起動のまま）。
 * 候補に無いmodel・effort、設定より緩い承認方針は理由の文で断る。
 */
export function resolveLaunchSettings(
  provider: McProvider,
  settings: McLaunchSettings,
  catalog: LaunchCatalog,
): EffectiveLaunchSettings | undefined | { error: string } {
  if (
    settings.model === undefined &&
    settings.effort === undefined &&
    settings.approval === undefined &&
    settings.preset === undefined
  ) {
    return undefined;
  }
  let preset: SessionPreset | undefined;
  if (settings.preset !== undefined) {
    preset = catalog.presets.find((p) => p.name === settings.preset);
    if (preset === undefined) {
      return { error: `プリセット「${settings.preset}」が見つかりません` };
    }
    if (preset.provider !== provider) {
      return { error: `プリセット「${preset.name}」は${preset.provider}用です` };
    }
  }
  const current = catalog.current[provider];
  const models = catalog.models[provider];
  const model = settings.model ?? (preset?.model || current.model);
  if (settings.model !== undefined && models.length > 0) {
    if (!models.some((m) => m.slug === settings.model)) {
      return { error: `model「${settings.model}」は候補にありません` };
    }
  }
  const effort = settings.effort ?? (preset?.effort || current.effort);
  if (settings.effort !== undefined) {
    const allowed = effortsFor([...models], model, effortFallback(provider));
    if (!allowed.includes(settings.effort)) {
      return { error: `effort「${settings.effort}」はこのmodelでは選べません` };
    }
  }
  if (
    settings.approval !== undefined &&
    !allowedApprovals(provider, catalog.baseline).includes(settings.approval)
  ) {
    return { error: '承認方針は拡張機能の設定より緩められません' };
  }
  const effective = buildEffectivePresetConfig(
    {
      name: preset?.name ?? 'Mission Control',
      provider,
      model,
      effort,
      approvalMode: settings.approval ?? preset?.approvalMode ?? '',
      sandbox: preset?.sandbox ?? '',
      workingDirectory: '',
    },
    catalog.baseline,
  );
  return {
    model: effective.model,
    effort: effective.effort,
    approvalMode: effective.approvalMode,
    sandbox: effective.sandbox,
    warnings: effective.warnings,
  };
}

/** globalStateに覚えた前回の選択を読む。形の合わないものは捨てる。 */
export function readLaunchDefaults(raw: unknown): Record<string, McLaunchDefaults> {
  const result: Record<string, McLaunchDefaults> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return result;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const v = value as Record<string, unknown>;
    if (!PROVIDERS.includes(v.provider as McProvider)) {
      continue;
    }
    const settings = parseLaunchSettings(v);
    if (typeof settings === 'string') {
      continue;
    }
    result[key] = { ...settings, provider: v.provider as McProvider };
  }
  return result;
}

/** 前回の選択を覚える。新しいものを後ろへ置き、上限を超えたら古いものから捨てる。 */
export function rememberLaunchDefaults(
  current: Record<string, McLaunchDefaults>,
  repoKey: string,
  value: McLaunchDefaults,
): Record<string, McLaunchDefaults> {
  const entries = Object.entries(current).filter(([key]) => key !== repoKey);
  entries.push([repoKey, value]);
  return Object.fromEntries(entries.slice(-MAX_LAUNCH_DEFAULTS));
}
