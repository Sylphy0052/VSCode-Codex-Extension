import { describe, expect, it } from 'vitest';
import { readModelsFromLine } from '../../src/claude/modelProbe';

describe('readModelsFromLine', () => {
  const line = (value: unknown): string => JSON.stringify(value);

  it('initialize の応答からモデル一覧を読む', () => {
    const models = readModelsFromLine(
      line({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: '1',
          response: {
            models: [{ value: 'sonnet', displayName: 'Sonnet', supportsEffort: true }],
          },
        },
      }),
    );
    expect(models?.map((m) => m.slug)).toEqual(['sonnet']);
  });

  it('応答以外の行は素通しする', () => {
    expect(readModelsFromLine(line({ type: 'system', subtype: 'init' }))).toBeUndefined();
    expect(readModelsFromLine('壊れたJSON')).toBeUndefined();
    expect(readModelsFromLine(line([1, 2]))).toBeUndefined();
  });

  it('エラー応答からは読まない', () => {
    const result = readModelsFromLine(
      line({
        type: 'control_response',
        response: { subtype: 'error', request_id: '1', error: 'Unsupported' },
      }),
    );
    expect(result).toBeUndefined();
  });

  it('一覧を持たない応答では undefined を返す', () => {
    const result = readModelsFromLine(
      line({
        type: 'control_response',
        response: { subtype: 'success', request_id: '1', response: { commands: [] } },
      }),
    );
    expect(result).toBeUndefined();
  });
});
