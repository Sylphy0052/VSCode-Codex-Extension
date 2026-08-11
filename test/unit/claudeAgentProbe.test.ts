import { describe, expect, it } from 'vitest';
import { readAgentsFromLine } from '../../src/claude/agentProbe';

describe('readAgentsFromLine', () => {
  const line = (value: unknown): string => JSON.stringify(value);

  it('initialize の応答からエージェント一覧を読む', () => {
    const agents = readAgentsFromLine(
      line({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: '1',
          response: {
            agents: [{ name: 'code-reviewer', description: 'コード品質レビュー専用subagent。' }],
          },
        },
      }),
    );
    expect(agents).toEqual([
      { name: 'code-reviewer', description: 'コード品質レビュー専用subagent。' },
    ]);
  });

  it('応答以外の行は素通しする', () => {
    expect(readAgentsFromLine(line({ type: 'system', subtype: 'init' }))).toBeUndefined();
    expect(readAgentsFromLine('壊れたJSON')).toBeUndefined();
    expect(readAgentsFromLine(line([1, 2]))).toBeUndefined();
  });

  it('エラー応答からは読まない', () => {
    const result = readAgentsFromLine(
      line({
        type: 'control_response',
        response: { subtype: 'error', request_id: '1', error: 'Unsupported' },
      }),
    );
    expect(result).toBeUndefined();
  });

  it('一覧を持たない応答では undefined を返す', () => {
    const result = readAgentsFromLine(
      line({
        type: 'control_response',
        response: { subtype: 'success', request_id: '1', response: { commands: [] } },
      }),
    );
    expect(result).toBeUndefined();
  });
});
