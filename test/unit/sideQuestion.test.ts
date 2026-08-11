import { describe, expect, it } from 'vitest';
import { buildSideQuestionForkParams } from '../../src/codex/sideQuestion';

describe('buildSideQuestionForkParams', () => {
  it('threadIdとephemeral:trueを渡す（lastTurnIdは指定しない）', () => {
    expect(buildSideQuestionForkParams('th-1')).toEqual({
      threadId: 'th-1',
      ephemeral: true,
    });
  });
});
