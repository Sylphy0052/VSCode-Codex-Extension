import { describe, expect, it } from 'vitest';
import { parseSkillsList } from '../../src/codex/skillsStatus';

/**
 * `skills/list` の応答の形。実測（codex-cli 0.147.0。このリポジトリの調査用一時ディレクトリ
 * で`cwds`を指定して呼び出し、実際の応答を確認した。本番のskill設定は変更していない）に
 * `interface` / `shortDescription` の省略を加えたもの。
 */
const skillsListResult = {
  data: [
    {
      cwd: '/workspace/repo',
      errors: [{ message: 'invalid frontmatter', path: '/workspace/repo/.codex/skills/broken' }],
      skills: [
        {
          name: 'add-rule',
          description: 'ルールを追加する',
          path: '/home/user/.codex/skills/add-rule/SKILL.md',
          scope: 'user',
          enabled: true,
        },
        {
          name: 'probe-skill',
          description: 'プロジェクト側のskill',
          path: '/workspace/repo/.codex/skills/probe-skill/SKILL.md',
          scope: 'repo',
          enabled: true,
        },
        {
          name: 'imagegen',
          description: '画像を作る',
          path: '/home/user/.codex/skills/.system/imagegen/SKILL.md',
          scope: 'system',
          enabled: true,
        },
        {
          name: 'org-skill',
          description: '組織配布のskill',
          path: '/etc/codex/skills/org-skill/SKILL.md',
          scope: 'admin',
          enabled: false,
        },
      ],
    },
  ],
};

describe('parseSkillsList', () => {
  it('scopeをoriginへ対応させ、pathをkeyにする', () => {
    const { skills } = parseSkillsList(skillsListResult);
    expect(skills).toHaveLength(4);

    const projectSkill = skills.find((s) => s.name === 'probe-skill');
    expect(projectSkill).toEqual({
      key: '/workspace/repo/.codex/skills/probe-skill/SKILL.md',
      name: 'probe-skill',
      description: 'プロジェクト側のskill',
      origin: 'project',
      originDetail: '/workspace/repo/.codex/skills/probe-skill/SKILL.md',
      enabled: true,
      toggleable: true,
    });
  });

  it('scope=user/system/adminをそれぞれ対応するoriginへ変換する', () => {
    const { skills } = parseSkillsList(skillsListResult);
    expect(skills.find((s) => s.name === 'add-rule')?.origin).toBe('user');
    expect(skills.find((s) => s.name === 'imagegen')?.origin).toBe('system');
    expect(skills.find((s) => s.name === 'org-skill')?.origin).toBe('admin');
  });

  it('enabled: falseを尊重する', () => {
    const { skills } = parseSkillsList(skillsListResult);
    expect(skills.find((s) => s.name === 'org-skill')?.enabled).toBe(false);
  });

  it('errorsをwarningsへまとめる', () => {
    const { warnings } = parseSkillsList(skillsListResult);
    expect(warnings).toEqual([
      'invalid frontmatter (/workspace/repo/.codex/skills/broken)',
    ]);
  });

  it('名前順に並べる', () => {
    const { skills } = parseSkillsList(skillsListResult);
    expect(skills.map((s) => s.name)).toEqual(['add-rule', 'imagegen', 'org-skill', 'probe-skill']);
  });

  it('name/pathを持たないskillは読み飛ばす', () => {
    const { skills } = parseSkillsList({ data: [{ skills: [{ description: 'x' }] }] });
    expect(skills).toEqual([]);
  });

  it('同じpathが複数のcwdに現れても1件に畳む', () => {
    const dup = {
      data: [
        { skills: [{ name: 'a', path: '/p', scope: 'user', enabled: true, description: '' }] },
        { skills: [{ name: 'a', path: '/p', scope: 'user', enabled: true, description: '' }] },
      ],
    };
    expect(parseSkillsList(dup).skills).toHaveLength(1);
  });

  it('未知のscopeはunknownへ倒す', () => {
    const { skills } = parseSkillsList({
      data: [
        {
          skills: [
            { name: 'x', path: '/p', scope: 'somethingNew', enabled: true, description: '' },
          ],
        },
      ],
    });
    expect(skills[0]?.origin).toBe('unknown');
  });

  it('想定外の形では空を返す', () => {
    expect(parseSkillsList(undefined)).toEqual({ skills: [], warnings: [] });
    expect(parseSkillsList(null)).toEqual({ skills: [], warnings: [] });
    expect(parseSkillsList({})).toEqual({ skills: [], warnings: [] });
    expect(parseSkillsList({ data: 'x' })).toEqual({ skills: [], warnings: [] });
  });
});
