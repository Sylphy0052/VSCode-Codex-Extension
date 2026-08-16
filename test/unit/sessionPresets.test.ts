import { describe, expect, it } from 'vitest';
import {
  buildEffectivePresetConfig,
  parseSessionPresets,
  resolveWorkingDirectory,
  type PresetSafetyBaseline,
  type SessionPreset,
} from '../../src/sessionPresets';

const baseline: PresetSafetyBaseline = {
  codexSandbox: 'read-only',
  codexApprovalMode: 'on-request',
  claudePermissionMode: 'manual',
};

function codexPreset(overrides: Partial<SessionPreset> = {}): SessionPreset {
  return {
    name: 'p1',
    provider: 'codex',
    model: '',
    effort: '',
    approvalMode: '',
    sandbox: '',
    workingDirectory: '',
    ...overrides,
  };
}

function claudePreset(overrides: Partial<SessionPreset> = {}): SessionPreset {
  return {
    name: 'p1',
    provider: 'claude',
    model: '',
    effort: '',
    approvalMode: '',
    sandbox: '',
    workingDirectory: '',
    ...overrides,
  };
}

describe('parseSessionPresets（agent.sessionPresetsの検証）', () => {
  it('プリセットが空（既定値[]、未設定undefined）のときは空配列を返し、警告も出さない', () => {
    expect(parseSessionPresets([])).toEqual({ presets: [], warnings: [] });
    expect(parseSessionPresets(undefined)).toEqual({ presets: [], warnings: [] });
  });

  it('配列でない値は無視し、警告を出す', () => {
    const result = parseSessionPresets({ name: 'p1' });
    expect(result.presets).toEqual([]);
    expect(result.warnings.some((w) => w.includes('配列ではない'))).toBe(true);
  });

  it('nameが無い項目は無視する', () => {
    const result = parseSessionPresets([{ provider: 'codex' }]);
    expect(result.presets).toEqual([]);
    expect(result.warnings.some((w) => w.includes('name'))).toBe(true);
  });

  it('providerが未知の値の項目は無視する（型違い・未知の値）', () => {
    const result = parseSessionPresets([{ name: 'p1', provider: 'unknown-cli' }]);
    expect(result.presets).toEqual([]);
    expect(result.warnings.some((w) => w.includes('provider'))).toBe(true);
  });

  it('providerが数値など文字列でない項目は無視する', () => {
    const result = parseSessionPresets([{ name: 'p1', provider: 42 }]);
    expect(result.presets).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('modelが文字列でない場合は未指定（空文字）へ丸め、警告を出す（型違い）', () => {
    const result = parseSessionPresets([{ name: 'p1', provider: 'codex', model: 123 }]);
    expect(result.presets).toEqual([codexPreset()]);
    expect(result.warnings.some((w) => w.includes('model') && w.includes('文字列'))).toBe(true);
  });

  it('name重複は先勝ちで後続を無視する', () => {
    const result = parseSessionPresets([
      { name: 'p1', provider: 'codex', model: 'first' },
      { name: 'p1', provider: 'claude', model: 'second' },
    ]);
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0]?.model).toBe('first');
    expect(result.warnings.some((w) => w.includes('重複'))).toBe(true);
  });

  it('要素が配列やnullなどオブジェクトでない場合は無視する', () => {
    const result = parseSessionPresets([null, ['x'], 'y', { name: 'p1', provider: 'codex' }]);
    expect(result.presets).toEqual([codexPreset()]);
    expect(result.warnings.filter((w) => w.includes('オブジェクトではない'))).toHaveLength(3);
  });

  it('有効な項目は全フィールドを読み取る', () => {
    const result = parseSessionPresets([
      {
        name: 'backend',
        provider: 'codex',
        model: 'gpt-5',
        effort: 'high',
        approvalMode: 'untrusted',
        sandbox: 'read-only',
        workingDirectory: '/workspace/backend',
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.presets).toEqual([
      {
        name: 'backend',
        provider: 'codex',
        model: 'gpt-5',
        effort: 'high',
        approvalMode: 'untrusted',
        sandbox: 'read-only',
        workingDirectory: '/workspace/backend',
      },
    ]);
  });
});

describe('buildEffectivePresetConfig（design.md §14.56・§16.16と同じクランプ方針）', () => {
  it('拡張機能の設定より緩いsandbox（Codex）を指定しても緩まず、警告が出る', () => {
    const result = buildEffectivePresetConfig(
      codexPreset({ sandbox: 'danger-full-access' }),
      baseline,
    );
    expect(result.sandbox).toBe('read-only');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('拡張機能の設定より緩いapprovalMode（Codex）を指定しても緩まず、警告が出る', () => {
    const result = buildEffectivePresetConfig(codexPreset({ approvalMode: 'never' }), baseline);
    expect(result.approvalMode).toBe('on-request');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('拡張機能の設定より緩いpermissionMode（Claude）を指定しても緩まず、警告が出る', () => {
    const result = buildEffectivePresetConfig(
      claudePreset({ approvalMode: 'bypassPermissions' }),
      baseline,
    );
    expect(result.approvalMode).toBe('manual');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('拡張機能の設定より厳しいsandbox（Codex）の指定は通る', () => {
    const result = buildEffectivePresetConfig(codexPreset({ sandbox: 'read-only' }), {
      ...baseline,
      codexSandbox: 'workspace-write',
    });
    expect(result.sandbox).toBe('read-only');
    expect(result.warnings).toEqual([]);
  });

  it('拡張機能の設定より厳しいpermissionMode（Claude）の指定は通る', () => {
    const result = buildEffectivePresetConfig(claudePreset({ approvalMode: 'plan' }), {
      ...baseline,
      claudePermissionMode: 'acceptEdits',
    });
    expect(result.approvalMode).toBe('plan');
    expect(result.warnings).toEqual([]);
  });

  it('未知のapprovalMode値は安全性を判定できないため無視される', () => {
    const result = buildEffectivePresetConfig(
      codexPreset({ approvalMode: 'not-a-real-mode' }),
      baseline,
    );
    expect(result.approvalMode).toBe('on-request');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('Claudeプリセットのsandbox指定は常に無視され、空文字になる（クランプ自体が無意味なため警告は出さない）', () => {
    const result = buildEffectivePresetConfig(
      claudePreset({ sandbox: 'danger-full-access' }),
      baseline,
    );
    expect(result.sandbox).toBe('');
  });

  it('modelとeffortはクランプせずそのまま通す', () => {
    const result = buildEffectivePresetConfig(
      codexPreset({ model: 'o3', effort: 'high' }),
      baseline,
    );
    expect(result.model).toBe('o3');
    expect(result.effort).toBe('high');
  });

  it('approvalMode/sandboxが未指定（空文字）なら拡張機能側の現在値をそのまま継承する', () => {
    const result = buildEffectivePresetConfig(codexPreset(), baseline);
    expect(result.approvalMode).toBe('on-request');
    expect(result.sandbox).toBe('read-only');
    expect(result.warnings).toEqual([]);
  });
});

describe('resolveWorkingDirectory（design.md §14.56）', () => {
  const roots = ['/workspace/a', '/workspace/b'];

  it('未指定（空文字）はそのままundefinedを返し、警告も出さない', () => {
    expect(resolveWorkingDirectory('', roots)).toEqual({ path: undefined, warning: undefined });
  });

  it('ワークスペースフォルダ配下の絶対パスはそのまま通る', () => {
    const result = resolveWorkingDirectory('/workspace/a/packages/api', roots);
    expect(result.path).toBe('/workspace/a/packages/api');
    expect(result.warning).toBeUndefined();
  });

  it('ワークスペースフォルダそのものも通る', () => {
    const result = resolveWorkingDirectory('/workspace/b', roots);
    expect(result.path).toBe('/workspace/b');
    expect(result.warning).toBeUndefined();
  });

  it('ワークスペースフォルダの外を指す絶対パスは無視され、警告が出る', () => {
    const result = resolveWorkingDirectory('/etc/passwd', roots);
    expect(result.path).toBeUndefined();
    expect(result.warning).toContain('ワークスペースの外');
  });

  it('似た名前だが別フォルダの兄弟パス（/workspace/ab）は外側とみなす', () => {
    const result = resolveWorkingDirectory('/workspace/ab', roots);
    expect(result.path).toBeUndefined();
    expect(result.warning).toContain('ワークスペースの外');
  });

  it('相対パスは無視され、警告が出る', () => {
    const result = resolveWorkingDirectory('packages/api', roots);
    expect(result.path).toBeUndefined();
    expect(result.warning).toContain('絶対パス');
  });

  it('".." を含む絶対パスはpath.resolveで正規化された上で境界チェックされる', () => {
    const result = resolveWorkingDirectory('/workspace/a/../b/sub', roots);
    expect(result.path).toBe('/workspace/b/sub');
    expect(result.warning).toBeUndefined();
  });
});
