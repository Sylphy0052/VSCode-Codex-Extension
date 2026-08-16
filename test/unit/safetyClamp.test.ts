import { describe, expect, it } from 'vitest';
import {
  clampClaudePermissionMode,
  clampCodexApprovalMode,
  clampSandbox,
  clampToSafer,
} from '../../src/util/safetyClamp';

describe('clampSandbox', () => {
  it('拡張機能の設定より緩める指定は無視され警告が出る', () => {
    const result = clampSandbox('workspace-write', 'danger-full-access');
    expect(result.value).toBe('workspace-write');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能の設定より絞る指定は通る', () => {
    const result = clampSandbox('workspace-write', 'read-only');
    expect(result.value).toBe('read-only');
    expect(result.warning).toBeUndefined();
  });

  it('YAML側が未指定なら拡張機能側をそのまま使う', () => {
    const result = clampSandbox('workspace-write', '');
    expect(result.value).toBe('workspace-write');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能とYAMLが同じ値なら警告が出ない', () => {
    const result = clampSandbox('workspace-write', 'workspace-write');
    expect(result.value).toBe('workspace-write');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能の設定が既定の空文字（CLI側の設定に委譲）でも、YAMLの最安全値read-onlyは通る', () => {
    // #58セキュリティ監査 critical。空文字は`codex.sandbox`の既定値（何も指定しない）で、
    // 修正前はここが安全性判定不能として拡張機能側（空文字）をそのまま採用してしまい、
    // YAML側がread-onlyを明示しても無視されていた
    const result = clampSandbox('', 'read-only');
    expect(result.value).toBe('read-only');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能の設定が既定の空文字のとき、最安全値以外の指定は無視される', () => {
    const result = clampSandbox('', 'workspace-write');
    expect(result.value).toBe('');
    expect(result.warning).toBeDefined();
  });
});

describe('clampCodexApprovalMode', () => {
  it('拡張機能がon-requestのときYAMLのneverはon-requestに留める', () => {
    const result = clampCodexApprovalMode('on-request', 'never');
    expect(result.value).toBe('on-request');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能がon-requestのときYAMLのuntrustedは通る', () => {
    const result = clampCodexApprovalMode('on-request', 'untrusted');
    expect(result.value).toBe('untrusted');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能の設定が既定の空文字でも、YAMLの最安全値untrustedは通る（#58 critical）', () => {
    const result = clampCodexApprovalMode('', 'untrusted');
    expect(result.value).toBe('untrusted');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能の設定が既定の空文字のとき、最安全値以外の指定は無視される', () => {
    const result = clampCodexApprovalMode('', 'on-request');
    expect(result.value).toBe('');
    expect(result.warning).toBeDefined();
  });
});

describe('clampClaudePermissionMode', () => {
  it('拡張機能がmanualのときYAMLのbypassPermissionsは無視される', () => {
    const result = clampClaudePermissionMode('manual', 'bypassPermissions');
    expect(result.value).toBe('manual');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能がmanualのときYAMLのplanは通る', () => {
    const result = clampClaudePermissionMode('manual', 'plan');
    expect(result.value).toBe('plan');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能がdontAskのときYAMLのacceptEditsはdontAskのまま維持され警告が出る', () => {
    // dontAskは安全順序表に含めていない（他のモードと一次元で比較できないため）。
    // 拡張機能側がdontAskのとき、YAML側の値は安全性を判定できないものとして無視し、
    // 拡張機能側の値(dontAsk)をそのまま維持する。
    const result = clampClaudePermissionMode('dontAsk', 'acceptEdits');
    expect(result.value).toBe('dontAsk');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能がmanualのときYAMLのdontAskはmanualのまま維持され警告が出る', () => {
    const result = clampClaudePermissionMode('manual', 'dontAsk');
    expect(result.value).toBe('manual');
    expect(result.warning).toBeDefined();
  });

  it('拡張機能の設定が既定の空文字でも、YAMLの最安全値planは通る（#58 critical）', () => {
    const result = clampClaudePermissionMode('', 'plan');
    expect(result.value).toBe('plan');
    expect(result.warning).toBeUndefined();
  });

  it('拡張機能の設定が既定の空文字のとき、最安全値以外の指定は無視される', () => {
    const result = clampClaudePermissionMode('', 'manual');
    expect(result.value).toBe('');
    expect(result.warning).toBeDefined();
  });
});

describe('clampToSafer（baselineが安全順序表に無い値のとき。#58セキュリティ監査 critical）', () => {
  const order = ['a', 'b', 'c'];

  it('baselineが順序表に無くても、YAML側が最安全値（先頭）なら採用する', () => {
    const result = clampToSafer(order, 'unknown-baseline', 'a');
    expect(result.value).toBe('a');
    expect(result.warning).toBeUndefined();
  });

  it('baselineが空文字でも、YAML側が最安全値なら採用する', () => {
    const result = clampToSafer(order, '', 'a');
    expect(result.value).toBe('a');
    expect(result.warning).toBeUndefined();
  });

  it('baselineが順序表に無く、YAML側が最安全値でなければ拒否する（緩む可能性を否定できない）', () => {
    const result = clampToSafer(order, '', 'b');
    expect(result.value).toBe('');
    expect(result.warning).toBeDefined();
  });

  it('YAML側も順序表に無い値なら、baselineの状態に関わらず拒否する', () => {
    const result = clampToSafer(order, '', 'z');
    expect(result.value).toBe('');
    expect(result.warning).toBeDefined();
  });

  it('baseline・YAMLの両方が順序表にある通常の場合は従来どおり動く', () => {
    const result = clampToSafer(order, 'c', 'a');
    expect(result.value).toBe('a');
    expect(result.warning).toBeUndefined();
  });
});
