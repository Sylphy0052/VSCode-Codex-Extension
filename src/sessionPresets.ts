import * as path from 'node:path';
import { isProviderId, type ProviderId } from './provider/id';
import {
  clampClaudePermissionMode,
  clampCodexApprovalMode,
  clampSandbox,
} from './orchestrator/workflow';

/**
 * 検証済みのセッションプリセット1件（issue #295、design.md §14.56）。
 *
 * `agent.sessionPresets` から読んだ生の値を {@link parseSessionPresets} で検証した後の形。
 * `model` / `effort` / `approvalMode` / `sandbox` / `workingDirectory` はいずれも
 * 空文字が「未指定」を表す（`src/config.ts` の既存の読み出しと同じ規約）。
 */
export interface SessionPreset {
  /** QuickPickの表示名・重複排除のキー。空文字は不可。 */
  name: string;
  provider: ProviderId;
  model: string;
  effort: string;
  /** Codexは`approvalMode`、Claudeは`permissionMode`に相当する値。空文字は未指定。 */
  approvalMode: string;
  /** Codexのみ意味を持つ。Claudeのプリセットでは無視する。 */
  sandbox: string;
  /** ワークスペースフォルダ配下の絶対パス。空文字は未指定（`resolveWorkingDirectory`参照）。 */
  workingDirectory: string;
}

export interface ParsedSessionPresets {
  presets: SessionPreset[];
  /** 無視した項目・型違いの理由。呼び出し側がログ・通知へ出す。 */
  warnings: string[];
}

/** 文字列型なら値を、そうでなければ未指定（空文字）へ丸め、型違いの場合だけ警告を積む。 */
function readOptionalString(
  entry: Record<string, unknown>,
  key: string,
  presetLabel: string,
  warnings: string[],
): string {
  const value = entry[key];
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  warnings.push(
    `プリセット「${presetLabel}」の ${key} が文字列ではないため無視しました: ${JSON.stringify(value)}`,
  );
  return '';
}

/**
 * `agent.sessionPresets`（`resource`スコープ、machineには固定していない）の生値を検証する。
 *
 * 権限に関わる値（`approvalMode` / `sandbox`）はここでは正規化するだけで緩めない方向への
 * クランプはしない。クランプは実際に会話を開く直前、拡張機能側の現在の設定を基準にして
 * {@link buildEffectivePresetConfig} が行う（design.md §16.16と同じ「実効値を組み立てる
 * 唯一の入口」の考え方。§14.56）。ここでの検証は型・必須項目・重複名だけを見る。
 *
 * 配列でない・要素がオブジェクトでない・`name`/`provider`が欠けている/不正な要素は、
 * その項目だけを無視して警告を積む（他の項目は生かす）。名前の重複は先勝ちで後続を無視する
 * （QuickPickの選択が一意になるように）。
 */
export function parseSessionPresets(raw: unknown): ParsedSessionPresets {
  if (!Array.isArray(raw)) {
    const warnings =
      raw === undefined ? [] : ['agent.sessionPresets は配列ではないため無視しました'];
    return { presets: [], warnings };
  }

  const presets: SessionPreset[] = [];
  const warnings: string[] = [];
  const seenNames = new Set<string>();

  raw.forEach((rawEntry, index) => {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      warnings.push(`agent.sessionPresets[${index}] はオブジェクトではないため無視しました`);
      return;
    }
    const entry = rawEntry as Record<string, unknown>;

    const rawName = entry.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name === '') {
      warnings.push(`agent.sessionPresets[${index}] は name が無いため無視しました`);
      return;
    }
    if (seenNames.has(name)) {
      warnings.push(
        `プリセット名が重複しているため agent.sessionPresets[${index}]（${name}）を無視しました`,
      );
      return;
    }

    const rawProvider = entry.provider;
    if (!isProviderId(rawProvider)) {
      warnings.push(
        `プリセット「${name}」の provider が不正なため無視しました（codexまたはclaudeを指定してください）: ${JSON.stringify(rawProvider)}`,
      );
      return;
    }

    seenNames.add(name);
    presets.push({
      name,
      provider: rawProvider,
      model: readOptionalString(entry, 'model', name, warnings),
      effort: readOptionalString(entry, 'effort', name, warnings),
      approvalMode: readOptionalString(entry, 'approvalMode', name, warnings),
      sandbox: readOptionalString(entry, 'sandbox', name, warnings),
      workingDirectory: readOptionalString(entry, 'workingDirectory', name, warnings),
    });
  });

  return { presets, warnings };
}

/** {@link buildEffectivePresetConfig} が緩める方向へ動かせないようにする基準値。 */
export interface PresetSafetyBaseline {
  /** `codex.sandbox`。 */
  codexSandbox: string;
  /** `codex.approvalMode`。 */
  codexApprovalMode: string;
  /** `claude.permissionMode`。 */
  claudePermissionMode: string;
}

export interface EffectivePresetConfig {
  provider: ProviderId;
  model: string;
  effort: string;
  approvalMode: string;
  /** Codexのみ意味を持つ。Claudeでは常に空文字。 */
  sandbox: string;
  /** 緩める指定を無視した等の警告。呼び出し側がログ・通知で出す。 */
  warnings: string[];
}

/**
 * プリセットの実効値を組み立てる唯一の入口（design.md §14.56・§16.16と同じ方針）。
 *
 * `approvalMode` / `sandbox` は拡張機能側の現在の設定（`baseline`）より緩い方向へは動かず、
 * 無視した場合は警告を返す。`clampCodexApprovalMode` / `clampClaudePermissionMode` /
 * `clampSandbox`（`src/orchestrator/workflow.ts`、ワークフローYAMLのクランプと同じ実装）を
 * そのまま再利用する。`model` / `effort` はクランプ対象外（machine-overridableな設定と同じ
 * 扱い。実行経路や権限には関わらないため）。
 */
export function buildEffectivePresetConfig(
  preset: SessionPreset,
  baseline: PresetSafetyBaseline,
): EffectivePresetConfig {
  const warnings: string[] = [];

  let approvalMode: string;
  if (preset.provider === 'claude') {
    const result = clampClaudePermissionMode(baseline.claudePermissionMode, preset.approvalMode);
    approvalMode = result.value;
    if (result.warning !== undefined) {
      warnings.push(result.warning);
    }
  } else {
    const result = clampCodexApprovalMode(baseline.codexApprovalMode, preset.approvalMode);
    approvalMode = result.value;
    if (result.warning !== undefined) {
      warnings.push(result.warning);
    }
  }

  // サンドボックスはCodex固有の概念（Claudeには起動時のフラグが無い）。Claudeプリセットでは
  // クランプそのものが無意味なので空文字にする（buildEffectiveTaskConfigと同じ扱い）
  let sandbox = '';
  if (preset.provider === 'codex') {
    const result = clampSandbox(baseline.codexSandbox, preset.sandbox);
    sandbox = result.value;
    if (result.warning !== undefined) {
      warnings.push(result.warning);
    }
  }

  return {
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort,
    approvalMode,
    sandbox,
    warnings,
  };
}

export interface ResolvedWorkingDirectory {
  /** 有効な作業ディレクトリ。未指定または無効なら`undefined`。 */
  path: string | undefined;
  warning: string | undefined;
}

/**
 * プリセットの `workingDirectory` を検証する（design.md §14.56）。
 *
 * ワークスペースフォルダ配下の絶対パスに限る。相対パスは複数ワークスペースフォルダの
 * どれを基準にするか一意に決められないため受け付けない。外を指す、または絶対パスでない
 * 値は無視して警告を返す（呼び出し側はその後の作業ディレクトリ選択にフォールバックする）。
 *
 * 文字列比較のみで判定し、シンボリックリンクの実体解決はしない。`buildTaskBoundary`
 * （`src/orchestrator/worktree.ts`）のような実パス解決はワークフローの無人実行向けの
 * 多層防御であり、こちらは対話的にQuickPickで選ぶ操作の入力補助にすぎないため、
 * 同じ強度は求めない（design.md §14.56に明記）。
 */
export function resolveWorkingDirectory(
  candidate: string,
  workspaceFolderPaths: readonly string[],
): ResolvedWorkingDirectory {
  if (candidate.trim() === '') {
    return { path: undefined, warning: undefined };
  }
  if (!path.isAbsolute(candidate)) {
    return {
      path: undefined,
      warning: `プリセットの作業ディレクトリは絶対パスで指定してください（無視しました）: ${candidate}`,
    };
  }

  const normalized = path.resolve(candidate);
  const inside = workspaceFolderPaths.some((root) => {
    const normalizedRoot = path.resolve(root);
    if (normalized === normalizedRoot) {
      return true;
    }
    const rel = path.relative(normalizedRoot, normalized);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!inside) {
    return {
      path: undefined,
      warning: `プリセットの作業ディレクトリがワークスペースの外を指しているため無視しました: ${candidate}`,
    };
  }
  return { path: normalized, warning: undefined };
}
