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
