import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('拡張機能の設定より厳しいapprovalMode（Codex）の指定は通る', () => {
    const result = buildEffectivePresetConfig(codexPreset({ approvalMode: 'untrusted' }), {
      ...baseline,
      codexApprovalMode: 'never',
    });
    expect(result.approvalMode).toBe('untrusted');
    expect(result.warnings).toEqual([]);
  });

  it('approvalMode未指定（Claude）なら拡張機能側の現在値を継承する', () => {
    const result = buildEffectivePresetConfig(claudePreset(), baseline);
    expect(result.approvalMode).toBe('manual');
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
  // 実体解決（fs.realpath）を挟むようになったため、存在しない架空のパス（旧テストの
  // `/workspace/a`等）ではfail-closedで常に拒否されてしまう。実在する一時ディレクトリを
  // 使って検証する（セキュリティ監査指摘: シンボリックリンクによる境界チェック迂回）。
  let tmpRoot: string;
  let rootA: string;
  let rootB: string;
  let outsideDir: string;

  // シンボリックリンク作成の可否を、テスト登録時点（`it.skipIf`の判定）で同期に確かめる。
  // `beforeAll`はテスト登録が終わった後に実行されるため`skipIf`の条件には使えない。
  // Windowsでは開発者モード/管理者権限が無いと`EPERM`になりうるため、その場合は
  // 関連テストをスキップする（理由をここに明記する）。
  const symlinksSupported = (() => {
    const probeDir = mkdtempSync(path.join(os.tmpdir(), 'session-presets-symlink-probe-'));
    try {
      const target = path.join(probeDir, 'target');
      const link = path.join(probeDir, 'link');
      mkdirSync(target);
      symlinkSync(target, link, 'dir');
      return true;
    } catch {
      return false;
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  })();

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'session-presets-test-'));
    rootA = path.join(tmpRoot, 'workspace-a');
    rootB = path.join(tmpRoot, 'workspace-b');
    outsideDir = path.join(tmpRoot, 'outside');
    await mkdir(path.join(rootA, 'packages', 'api'), { recursive: true });
    await mkdir(path.join(rootB, 'sub'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'workspace-ab'), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const roots = () => [rootA, rootB];

  it('未指定（空文字）はそのままundefinedを返し、警告も出さない', async () => {
    await expect(resolveWorkingDirectory('', roots())).resolves.toEqual({
      path: undefined,
      warning: undefined,
    });
  });

  it('ワークスペースフォルダ配下の実在する絶対パスはそのまま通る', async () => {
    const candidate = path.join(rootA, 'packages', 'api');
    const result = await resolveWorkingDirectory(candidate, roots());
    expect(result.path).toBe(candidate);
    expect(result.warning).toBeUndefined();
  });

  it('ワークスペースフォルダそのものも通る', async () => {
    const result = await resolveWorkingDirectory(rootB, roots());
    expect(result.path).toBe(rootB);
    expect(result.warning).toBeUndefined();
  });

  it('ワークスペースフォルダの外を指す絶対パスは無視され、警告が出る', async () => {
    const result = await resolveWorkingDirectory(outsideDir, roots());
    expect(result.path).toBeUndefined();
    expect(result.warning).toContain('ワークスペースの外');
  });

  it('似た名前だが別フォルダの兄弟パス（workspace-ab）は外側とみなす', async () => {
    const sibling = path.join(tmpRoot, 'workspace-ab');
    const result = await resolveWorkingDirectory(sibling, roots());
    expect(result.path).toBeUndefined();
    expect(result.warning).toContain('ワークスペースの外');
  });

  it('相対パスは無視され、警告が出る', async () => {
    const result = await resolveWorkingDirectory('packages/api', roots());
    expect(result.path).toBeUndefined();
    expect(result.warning).toContain('絶対パス');
  });

  it('".." を含む絶対パスはpath.resolveで正規化された上で境界チェックされる', async () => {
    // `path.join`は内部で正規化してしまい".."が消えるため、意図的に文字列結合で組み立てる
    // （関数内部の`path.resolve`による正規化そのものを検証するため）
    const candidate = `${rootA}${path.sep}..${path.sep}workspace-b${path.sep}sub`;
    const result = await resolveWorkingDirectory(candidate, roots());
    expect(result.path).toBe(path.join(rootB, 'sub'));
    expect(result.warning).toBeUndefined();
  });

  it('存在しないパスはfail-closedで拒否され、警告が出る', async () => {
    const missing = path.join(rootA, 'does-not-exist');
    const result = await resolveWorkingDirectory(missing, roots());
    expect(result.path).toBeUndefined();
    expect(result.warning).toContain('実体を解決できない');
  });

  it.skipIf(!symlinksSupported)(
    'ワークスペース外を指すシンボリックリンクは拒否され、警告が出る（境界チェックの迂回対策）',
    async () => {
      const link = path.join(rootA, 'escape');
      await symlink(outsideDir, link, 'dir');
      const result = await resolveWorkingDirectory(link, roots());
      expect(result.path).toBeUndefined();
      expect(result.warning).toContain('ワークスペースの外');
    },
  );

  it.skipIf(!symlinksSupported)(
    'ワークスペース内を指すシンボリックリンクは通る（正当なケースを誤って壊さない）',
    async () => {
      const link = path.join(rootA, 'link-to-b');
      await symlink(rootB, link, 'dir');
      const result = await resolveWorkingDirectory(link, roots());
      expect(result.path).toBe(link);
      expect(result.warning).toBeUndefined();
    },
  );
});
