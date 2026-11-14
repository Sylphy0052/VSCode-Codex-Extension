import { describe, expect, it } from 'vitest';
import { buildSkillSelectState } from '../../src/reflex/skillSelect';

function lineOf(description: string): string {
  const state = buildSkillSelectState('依頼', [{ name: 's', description }]);
  const line = state.split('\n').find((l) => l.startsWith('- s: '));
  return (line ?? '').slice('- s: '.length);
}

describe('buildSkillSelectState の説明文', () => {
  it('200字より後ろのUse when節が含まれる', () => {
    const description = `${'概要'.repeat(150)} Use when: 目的を達成したいとき。`;
    const line = lineOf(description);
    expect(line).toContain('Use when: 目的を達成したいとき。');
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('Do not use節だけでも含まれる', () => {
    const description = `${'概要'.repeat(150)} Do not use: 単発の質問。`;
    const line = lineOf(description);
    expect(line).toContain('Do not use: 単発の質問。');
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('両節が長いときはUse whenを優先し、上限を超えない', () => {
    const description = `概要 Do not use: ${'否'.repeat(300)} Use when: ${'用'.repeat(120)}`;
    const line = lineOf(description);
    expect(line).toContain(`Use when: ${'用'.repeat(120)}`);
    expect(line).toContain('Do not use: ');
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('節が無い説明文は先頭200字で切る（従来どおり）', () => {
    const line = lineOf('あ'.repeat(300));
    expect(line).toBe(`${'あ'.repeat(200)}…`);
  });
});
