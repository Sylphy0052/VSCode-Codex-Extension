import { describe, expect, it } from 'vitest';
import { extractClaudeDefaults, noClaudeDefaults } from '../../src/claude/settingsJson';

describe('extractClaudeDefaults', () => {
  it('model・effortLevel・permissions.defaultMode を読む', () => {
    const json = JSON.stringify({
      model: 'opus',
      effortLevel: 'high',
      permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(git:*)'] },
    });
    expect(extractClaudeDefaults(json)).toEqual({
      model: 'opus',
      effort: 'high',
      permissionMode: 'bypassPermissions',
    });
  });

  it('無いキーは undefined になる', () => {
    expect(extractClaudeDefaults('{"effortLevel":"low"}')).toEqual({
      model: undefined,
      effort: 'low',
      permissionMode: undefined,
    });
  });

  it('文字列でない値は無視する', () => {
    const json = JSON.stringify({ model: 3, effortLevel: null, permissions: { defaultMode: [] } });
    expect(extractClaudeDefaults(json)).toEqual(noClaudeDefaults);
  });

  it('壊れたJSONは既定値なしとして扱う', () => {
    expect(extractClaudeDefaults('{ not json')).toEqual(noClaudeDefaults);
  });

  it('permissions がオブジェクトでなくても落ちない', () => {
    expect(extractClaudeDefaults('{"permissions":"all"}')).toEqual(noClaudeDefaults);
  });
});
