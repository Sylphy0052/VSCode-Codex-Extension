import { describe, expect, it } from 'vitest';
import { readSkillsList } from '../../src/codex/skillsList';

const result = {
  data: [
    {
      cwd: '/work',
      skills: [
        {
          name: 'gitlab-commit',
          description: 'コミットする',
          path: '/home/u/.codex/skills/gitlab-commit/SKILL.md',
          scope: 'user',
          enabled: true,
        },
        {
          name: 'disabled-one',
          description: '無効',
          path: '/home/u/.codex/skills/disabled-one/SKILL.md',
          scope: 'user',
          enabled: false,
        },
      ],
    },
  ],
};

describe('readSkillsList', () => {
  it('有効なスキルだけを候補にする', () => {
    expect(readSkillsList(result).map((c) => c.name)).toEqual(['gitlab-commit']);
  });

  it('descriptionを引き継ぐ', () => {
    expect(readSkillsList(result)[0]?.description).toBe('コミットする');
  });

  it('複数のcwd分をまとめる', () => {
    const two = {
      data: [
        { cwd: '/a', skills: [{ name: 'x', description: '', enabled: true }] },
        { cwd: '/b', skills: [{ name: 'y', description: '', enabled: true }] },
      ],
    };
    expect(readSkillsList(two).map((c) => c.name)).toEqual(['x', 'y']);
  });

  it('enabledが無ければ有効として扱う', () => {
    const noFlag = { data: [{ cwd: '/a', skills: [{ name: 'x', description: '' }] }] };
    expect(readSkillsList(noFlag)).toHaveLength(1);
  });

  it('形が違えば空を返す', () => {
    expect(readSkillsList(undefined)).toEqual([]);
    expect(readSkillsList({ data: 'not array' })).toEqual([]);
    expect(readSkillsList({ data: [{ skills: 'not array' }] })).toEqual([]);
  });

  it('名前が無いものは捨てる', () => {
    const broken = { data: [{ cwd: '/a', skills: [{ description: '名前なし', enabled: true }] }] };
    expect(readSkillsList(broken)).toEqual([]);
  });
});
