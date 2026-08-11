import { describe, expect, it } from 'vitest';
import { isValidSkillPath } from '../../src/provider/skills';

describe('isValidSkillPath', () => {
  it('絶対パスらしい文字列を許可する', () => {
    expect(isValidSkillPath('/home/user/.codex/skills/foo/SKILL.md')).toBe(true);
    expect(isValidSkillPath('/workspace/repo/.codex/skills/bar/SKILL.md')).toBe(true);
  });

  it('相対パス・空文字を拒否する', () => {
    expect(isValidSkillPath('relative/SKILL.md')).toBe(false);
    expect(isValidSkillPath('')).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    expect(isValidSkillPath(undefined)).toBe(false);
    expect(isValidSkillPath(123)).toBe(false);
    expect(isValidSkillPath(null)).toBe(false);
  });
});
