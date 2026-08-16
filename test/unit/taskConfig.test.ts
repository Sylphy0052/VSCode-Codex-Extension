import { describe, expect, it } from 'vitest';
import {
  buildEffectiveTaskConfig,
  type ExtensionSafetyBaseline,
} from '../../src/orchestrator/taskConfig';

const baseline: ExtensionSafetyBaseline = {
  codexSandbox: 'read-only',
  codexApprovalMode: 'on-request',
  claudePermissionMode: 'manual',
  allowAutoApprove: false,
  allowClaudeBypassPermissions: false,
};

describe('buildEffectiveTaskConfig（design.md §16.16の唯一の入口）', () => {
  it('拡張機能の設定より緩いsandboxを指定しても、緩まずに警告が出る', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: 'danger-full-access',
        autoApprove: false,
      },
      baseline,
    );
    expect(result.sandbox).toBe('read-only');
    expect(
      result.warnings.some((w) => w.includes('拡張機能の設定より緩い指定は無視しました')),
    ).toBe(true);
  });

  it('拡張機能の設定より緩いapprovalMode（Codex）を指定しても、緩まずに警告が出る', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: 'never',
        sandbox: undefined,
        autoApprove: false,
      },
      baseline,
    );
    expect(result.config.approvalMode).toBe('on-request');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('拡張機能の設定より緩いpermissionMode（Claude）を指定しても、緩まずに警告が出る', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'claude',
        model: undefined,
        effort: undefined,
        approvalMode: 'bypassPermissions',
        sandbox: undefined,
        autoApprove: false,
      },
      baseline,
    );
    expect(result.config.approvalMode).toBe('manual');
  });

  it('安全な方向へ絞るYAMLの指定はそのまま通る', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: 'untrusted',
        sandbox: undefined,
        autoApprove: false,
      },
      baseline,
    );
    expect(result.config.approvalMode).toBe('untrusted');
    expect(result.warnings).toEqual([]);
  });

  it('allowAutoApproveが無効なら、YAMLがautoApprove: trueでもfalseへ倒す', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: undefined,
        autoApprove: true,
      },
      baseline,
    );
    expect(result.autoApprove).toBe(false);
    expect(result.warnings.some((w) => w.includes('allowAutoApprove'))).toBe(true);
  });

  it('allowAutoApproveが有効ならautoApprove: trueがそのまま通る', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: undefined,
        autoApprove: true,
      },
      { ...baseline, allowAutoApprove: true },
    );
    expect(result.autoApprove).toBe(true);
  });

  it('modelとeffortはクランプせずそのまま通す', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: 'gpt-5-task',
        effort: 'high',
        approvalMode: undefined,
        sandbox: undefined,
        autoApprove: false,
      },
      baseline,
    );
    expect(result.config.model).toBe('gpt-5-task');
    expect(result.config.effort).toBe('high');
  });

  it('Claudeタスクのsandboxは常に空文字（Claudeにsandboxの概念が無いため）', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'claude',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: 'danger-full-access',
        autoApprove: false,
      },
      baseline,
    );
    expect(result.sandbox).toBe('');
  });

  it('拡張機能側の設定が既にbypassPermissionsのとき、危険判定が働く値へ落として警告する（issue #271）', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'claude',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: undefined,
        autoApprove: false,
      },
      { ...baseline, claudePermissionMode: 'bypassPermissions' },
    );
    // 落としたうえで続行する。落とさないと最終防御（runner.ts）が全タスクの開始を拒むため
    expect(result.config.approvalMode).toBe('acceptEdits');
    expect(result.warnings.some((w) => w.includes('bypassPermissions'))).toBe(true);
  });

  it('allowClaudeBypassPermissionsが有効なら読み替えず、危険判定が働かない旨を警告する（issue #278）', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'claude',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: undefined,
        autoApprove: false,
      },
      {
        ...baseline,
        claudePermissionMode: 'bypassPermissions',
        allowClaudeBypassPermissions: true,
      },
    );
    expect(result.config.approvalMode).toBe('bypassPermissions');
    expect(result.warnings.some((w) => w.includes('危険判定'))).toBe(true);
  });

  it('CodexタスクはbypassPermissionsの読み替えの対象外（Claude固有の値のため）', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: undefined,
        autoApprove: false,
      },
      { ...baseline, claudePermissionMode: 'bypassPermissions' },
    );
    expect(result.config.approvalMode).toBe(baseline.codexApprovalMode);
    expect(result.warnings).toEqual([]);
  });

  it('拡張機能側がbypassPermissionsでも、YAMLがより安全な値を明示すればそちらが勝つ', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'claude',
        model: undefined,
        effort: undefined,
        approvalMode: 'manual',
        sandbox: undefined,
        autoApprove: false,
      },
      { ...baseline, claudePermissionMode: 'bypassPermissions' },
    );
    expect(result.config.approvalMode).toBe('manual');
    expect(result.warnings).toEqual([]);
  });

  it('拡張機能の設定が既定の空文字（CLIへ委譲）でも、YAMLがsandbox: read-onlyを明示すれば通る', () => {
    // #58セキュリティ監査 critical。plannerだけでなく実行タスク側も同じクランプ
    // （buildEffectiveTaskConfig → clampSandbox → clampToSafer）を通るため、
    // baselineが空文字のときにYAML側の安全な明示指定が無視される欠陥は実行タスクにも
    // 及んでいた（clampToSaferの修正で解消）
    const emptyBaseline: ExtensionSafetyBaseline = {
      codexSandbox: '',
      codexApprovalMode: '',
      claudePermissionMode: '',
      allowAutoApprove: false,
      allowClaudeBypassPermissions: false,
    };
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: 'untrusted',
        sandbox: 'read-only',
        autoApprove: false,
      },
      emptyBaseline,
    );
    expect(result.sandbox).toBe('read-only');
    expect(result.config.approvalMode).toBe('untrusted');
    expect(result.warnings).toEqual([]);
  });

  it('拡張機能の設定が既定の空文字のとき、最安全値以外のYAML指定は無視される', () => {
    const emptyBaseline: ExtensionSafetyBaseline = {
      codexSandbox: '',
      codexApprovalMode: '',
      claudePermissionMode: '',
      allowAutoApprove: false,
      allowClaudeBypassPermissions: false,
    };
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: 'workspace-write',
        autoApprove: false,
      },
      emptyBaseline,
    );
    expect(result.sandbox).toBe('');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('未指定（undefined）のフィールドは拡張機能側の値をそのまま使い、警告を出さない', () => {
    const result = buildEffectiveTaskConfig(
      {
        provider: 'codex',
        model: undefined,
        effort: undefined,
        approvalMode: undefined,
        sandbox: undefined,
        autoApprove: false,
      },
      baseline,
    );
    expect(result.config.approvalMode).toBe('on-request');
    expect(result.sandbox).toBe('read-only');
    expect(result.warnings).toEqual([]);
  });
});
