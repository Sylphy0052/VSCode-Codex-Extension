import { describe, expect, it } from 'vitest';
import { parseClaudeSkillsList } from '../../src/claude/skillsList';

describe('parseClaudeSkillsList', () => {
  it('末尾が " (user)" ならuser originにし、注記を取り除く', () => {
    const skills = parseClaudeSkillsList({
      skills: [{ name: 'add-rule', description: 'ルールを追加する (user)', argumentHint: '' }],
    });
    expect(skills).toEqual([
      {
        key: 'add-rule',
        name: 'add-rule',
        description: 'ルールを追加する',
        origin: 'user',
        originDetail: undefined,
        enabled: true,
        toggleable: false,
      },
    ]);
  });

  it('末尾が " (project)" ならproject originにする（実測: 調査用の一時ディレクトリで確認）', () => {
    const skills = parseClaudeSkillsList({
      skills: [{ name: 'probe-skill', description: 'プロジェクト側のskill (project)' }],
    });
    expect(skills?.[0]?.origin).toBe('project');
    expect(skills?.[0]?.description).toBe('プロジェクト側のskill');
  });

  it('nameが"plugin:skill"の形ならplugin originにし、先頭の(pluginId)を取り除く', () => {
    const skills = parseClaudeSkillsList({
      skills: [
        {
          name: 'genshijin:genshijin-commit',
          description: '(genshijin) 超圧縮コミットメッセージ生成',
        },
      ],
    });
    expect(skills?.[0]).toMatchObject({
      key: 'genshijin:genshijin-commit',
      origin: 'plugin',
      originDetail: 'genshijin',
      description: '超圧縮コミットメッセージ生成',
    });
  });

  it('注記が無いものはunknownにし、説明はそのまま残す（Anthropic公式の同梱skillなど）', () => {
    const skills = parseClaudeSkillsList({
      skills: [{ name: 'dataviz', description: 'Use this skill whenever...' }],
    });
    expect(skills?.[0]?.origin).toBe('unknown');
    expect(skills?.[0]?.description).toBe('Use this skill whenever...');
  });

  it('enabled/toggleableは常にtrue/falseにする（プロトコルに経路が無いため）', () => {
    const skills = parseClaudeSkillsList({ skills: [{ name: 'a', description: 'x (user)' }] });
    expect(skills?.[0]?.enabled).toBe(true);
    expect(skills?.[0]?.toggleable).toBe(false);
  });

  it('同じ名前が複数現れても先に見つけたものを残す', () => {
    const skills = parseClaudeSkillsList({
      skills: [
        { name: 'a', description: '1つ目 (user)' },
        { name: 'a', description: '2つ目 (project)' },
      ],
    });
    expect(skills).toHaveLength(1);
    expect(skills?.[0]?.description).toBe('1つ目');
  });

  it('nameを持たないskillは読み飛ばす', () => {
    const skills = parseClaudeSkillsList({ skills: [{ description: 'x' }] });
    expect(skills).toEqual([]);
  });

  it('一覧そのものが無いときはundefinedを返す（空配列と区別する）', () => {
    expect(parseClaudeSkillsList({})).toBeUndefined();
    expect(parseClaudeSkillsList(undefined)).toBeUndefined();
    expect(parseClaudeSkillsList({ skills: 'x' })).toBeUndefined();
  });

  it('skillsが空配列なら空配列を返す（0件そのもの）', () => {
    expect(parseClaudeSkillsList({ skills: [] })).toEqual([]);
  });
});
