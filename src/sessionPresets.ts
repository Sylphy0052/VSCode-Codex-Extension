import { realpath } from 'node:fs/promises';
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

/** QuickPickの1件分の表示用文字列（ラベル・説明・詳細）。`vscode`には依存しない純粋関数。 */
export interface SessionPresetQuickPickLabel {
  label: string;
  description: string;
  detail: string;
}

/**
 * プリセット1件分のQuickPick表示文字列を組み立てる（`src/extension.ts`の`openPresetChat`から
 * 切り出し。design.md §14.56）。
 *
 * `detail`の承認・サンドボックスは`buildEffectivePresetConfig`を通した実効値を使う。
 * プリセットの生値（`preset.approvalMode` / `preset.sandbox`）をそのまま出すと、選択画面には
 * `danger-full-access`のような値が見えるのに、実際に開く会話はクランプ済みの値になり、
 * 表示と実際の挙動が食い違う（コードレビュー指摘）。
 */
export function buildSessionPresetQuickPickLabel(
  preset: SessionPreset,
  baseline: PresetSafetyBaseline,
): SessionPresetQuickPickLabel {
  const effective = buildEffectivePresetConfig(preset, baseline);
  return {
    label: preset.name,
    description: [preset.provider, preset.model, preset.effort]
      .filter((v) => v !== '')
      .join(' / '),
    detail: [
      effective.approvalMode !== '' ? `承認: ${effective.approvalMode}` : undefined,
      preset.provider === 'codex' && effective.sandbox !== ''
        ? `サンドボックス: ${effective.sandbox}`
        : undefined,
      preset.workingDirectory !== '' ? `作業ディレクトリ: ${preset.workingDirectory}` : undefined,
    ]
      .filter((v): v is string => v !== undefined)
      .join('  '),
  };
}

export interface ResolvedWorkingDirectory {
  /** 有効な作業ディレクトリ。未指定または無効なら`undefined`。 */
  path: string | undefined;
  warning: string | undefined;
}

/**
 * `path`を`fs.realpath`で実体解決する。存在しない（`ENOENT`）・アクセス権が無い等、
 * 理由を問わず失敗した場合は`undefined`を返し、例外を外へ投げない
 * （`src/orchestrator/worktree.ts`の`nodeWorktreeFileSystem.realpath`と同じ流儀）。
 */
async function tryRealpath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

/**
 * プリセットの `workingDirectory` を検証する（design.md §14.56）。
 *
 * ワークスペースフォルダ配下の絶対パスに限る。相対パスは複数ワークスペースフォルダの
 * どれを基準にするか一意に決められないため受け付けない。外を指す、または絶対パスでない
 * 値は無視して警告を返す（呼び出し側はその後の作業ディレクトリ選択にフォールバックする）。
 *
 * 候補パス・ワークスペースフォルダの両方を`fs.realpath`で実体解決してから包含判定する
 * （セキュリティ監査指摘: `escape -> /home/victim`のようなリポジトリ内シンボリックリンクを
 * `workingDirectory`に指定すると、文字列比較のみの境界チェックはすり抜けてしまい、
 * `sandbox: workspace-write`の基準点がワークスペース外へ付け替わる）。片方だけ解決しても
 * 不十分で、ワークスペースルート自体がシンボリックリンク経由で開かれている環境では
 * 正当なパスを誤って弾く。候補パスの実体解決に失敗した場合（存在しない・権限が無い等）は
 * 「解決できなかった」として拒否する（fail-closed。存在しないディレクトリを作業ディレクトリに
 * 指定する意味は無い）。`.vscode/settings.json`経由で供給される値は利用者の手入力ではなく
 * cloneしたリポジトリが与えうる値のため、`approvalMode` / `sandbox`と同じ強度の防御が要る
 * と判断した（design.md §14.56）。
 */
export async function resolveWorkingDirectory(
  candidate: string,
  workspaceFolderPaths: readonly string[],
): Promise<ResolvedWorkingDirectory> {
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
  const realCandidate = await tryRealpath(normalized);
  if (realCandidate === undefined) {
    return {
      path: undefined,
      warning: `プリセットの作業ディレクトリの実体を解決できないため無視しました（存在しないか、アクセスできません）: ${candidate}`,
    };
  }

  let inside = false;
  for (const root of workspaceFolderPaths) {
    const realRoot = await tryRealpath(path.resolve(root));
    if (realRoot === undefined) {
      continue;
    }
    if (realCandidate === realRoot) {
      inside = true;
      break;
    }
    const rel = path.relative(realRoot, realCandidate);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      inside = true;
      break;
    }
  }
  if (!inside) {
    return {
      path: undefined,
      warning: `プリセットの作業ディレクトリがワークスペースの外を指しているため無視しました: ${candidate}`,
    };
  }
  // 実体解決したパスを返す（解決前の`normalized`ではなく）。CLIへ渡すのが実体パスであれば、
  // 検証したあと・実際に使うまでの間にシンボリックリンクを差し替えられても、その差し替えが
  // 作業ディレクトリの行き先を変えられない。判定と利用で同じ実体を指すようにするための選択。
  return { path: realCandidate, warning: undefined };
}
