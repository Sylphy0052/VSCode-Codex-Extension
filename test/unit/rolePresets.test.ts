import { describe, expect, it } from 'vitest';

import {
  escalationModel,
  isTeamRole,
  roleDefaults,
  roleLabel,
  roleTier,
  TEAM_ROLES,
  type TeamRole,
} from '../../src/orchestrator/rolePresets';
import { PROVIDERS, type Provider } from '../../src/orchestrator/workflow';

describe('isTeamRole（design.md §16.44、Issue #693）', () => {
  it('TEAM_ROLESに列挙された値はすべて役割として認識する', () => {
    for (const role of TEAM_ROLES) {
      expect(isTeamRole(role)).toBe(true);
    }
  });

  it('未知の文字列は役割として認識しない（綴り違いを黙って受け入れない）', () => {
    expect(isTeamRole('implementer2')).toBe(false);
    expect(isTeamRole('マネージャー')).toBe(false);
    expect(isTeamRole('')).toBe(false);
  });

  it('文字列以外の値は役割として認識しない', () => {
    expect(isTeamRole(undefined)).toBe(false);
    expect(isTeamRole(null)).toBe(false);
    expect(isTeamRole(1)).toBe(false);
    expect(isTeamRole({})).toBe(false);
  });
});

describe('roleLabel / roleTier', () => {
  it('全役割に空でない日本語ラベルが定義されている', () => {
    for (const role of TEAM_ROLES) {
      const label = roleLabel(role);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('全役割の重さが light/standard/deep のいずれか（escalationは既定値に現れない）', () => {
    for (const role of TEAM_ROLES) {
      expect(['light', 'standard', 'deep']).toContain(roleTier(role));
    }
  });

  it('進行役・マネージャー・EM・アーキテクト・設計者はdeep（判断の質がrun全体の質になるため）', () => {
    const deepRoles: TeamRole[] = ['orchestrator', 'manager', 'em', 'architect', 'designer'];
    for (const role of deepRoles) {
      expect(roleTier(role)).toBe('deep');
    }
  });

  it('実装・レビュワー・テスターはlight（速度と量を優先する）', () => {
    const lightRoles: TeamRole[] = ['implementer', 'reviewer', 'tester'];
    for (const role of lightRoles) {
      expect(roleTier(role)).toBe('light');
    }
  });

  it('ライター・リサーチャーはstandard', () => {
    expect(roleTier('writer')).toBe('standard');
    expect(roleTier('researcher')).toBe('standard');
  });
});

describe('roleDefaults（プロバイダごとのmodel/effort）', () => {
  it.each(PROVIDERS)('codex/claudeの両方で %s ごとの既定値を返す', (provider: Provider) => {
    for (const role of TEAM_ROLES) {
      const defaults = roleDefaults(role, provider);
      expect(typeof defaults.model).toBe('string');
      expect(defaults.model.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(defaults.effort);
    }
  });

  it('deep役割はcodexでgpt-5.6-terra、claudeでopusを返す', () => {
    expect(roleDefaults('architect', 'codex').model).toBe('gpt-5.6-terra');
    expect(roleDefaults('architect', 'claude').model).toBe('opus');
    expect(roleDefaults('architect', 'codex').effort).toBe('high');
  });

  it('light役割はcodexでgpt-5.6-luna、claudeでsonnetを返す', () => {
    expect(roleDefaults('implementer', 'codex').model).toBe('gpt-5.6-luna');
    expect(roleDefaults('implementer', 'claude').model).toBe('sonnet');
    expect(roleDefaults('implementer', 'codex').effort).toBe('low');
  });

  it('standard役割はcodexでgpt-5.6-luna、claudeでsonnetを返す（effortはmedium）', () => {
    expect(roleDefaults('writer', 'codex').model).toBe('gpt-5.6-luna');
    expect(roleDefaults('writer', 'claude').model).toBe('sonnet');
    expect(roleDefaults('writer', 'codex').effort).toBe('medium');
  });

  it('xhigh/max/ultraのようなプロバイダ固有effortは既定値に現れない', () => {
    for (const role of TEAM_ROLES) {
      for (const provider of PROVIDERS) {
        expect(roleDefaults(role, provider).effort).not.toBe('xhigh');
        expect(roleDefaults(role, provider).effort).not.toBe('max');
        expect(roleDefaults(role, provider).effort).not.toBe('ultra');
      }
    }
  });
});

describe('escalation段はどの役割の既定値にもならない（Issue #693「詰まったときだけ使う」）', () => {
  it('TEAM_ROLES全件で、codex/claude双方のroleDefaults().modelがescalationModel()と一致しない', () => {
    for (const role of TEAM_ROLES) {
      for (const provider of PROVIDERS) {
        expect(roleDefaults(role, provider).model).not.toBe(escalationModel(provider));
      }
    }
  });

  it('escalationModelはcodexでgpt-5.6-sol、claudeでfableを返す', () => {
    expect(escalationModel('codex')).toBe('gpt-5.6-sol');
    expect(escalationModel('claude')).toBe('fable');
  });
});
