import { describe, expect, it } from 'vitest';
import { consumeNdjson } from '../../src/util/ndjson';
import { MAX_LINE_BUFFER_BYTES } from '../../src/process/childProcess';

describe('consumeNdjson', () => {
  it('完成した行だけを値にする', () => {
    const { values, rest } = consumeNdjson('{"type":"a"}\n{"type":"b"');
    expect(values).toHaveLength(1);
    expect(values[0]?.['type']).toBe('a');
    expect(rest).toBe('{"type":"b"');
  });

  it('分割して届いても連結すれば読める', () => {
    const first = consumeNdjson('{"type":"a');
    expect(first.values).toEqual([]);
    const second = consumeNdjson(`${first.rest}"}\n`);
    expect(second.values[0]?.['type']).toBe('a');
  });

  it('JSONでない行を捨てる（診断出力が混ざるため）', () => {
    const { values } = consumeNdjson('起動しました\n{"type":"a"}\n');
    expect(values).toHaveLength(1);
  });

  it('配列やスカラーの行を受け付けない', () => {
    expect(consumeNdjson('[1,2]\n"x"\n3\n').values).toEqual([]);
  });

  it('空行を無視する', () => {
    expect(consumeNdjson('\n\n{"type":"a"}\n').values).toHaveLength(1);
  });

  it('restが上限以内ならoverflowは立たない', () => {
    const { overflow } = consumeNdjson('{"type":"a"}\n' + 'x'.repeat(1024));
    expect(overflow).toBe(false);
  });

  it('改行を含まない出力が上限を超えるとoverflowが立つ（issue #402、1点目）', () => {
    const huge = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);
    const { values, rest, overflow } = consumeNdjson(huge);
    expect(values).toEqual([]);
    expect(rest).toBe(huge);
    expect(overflow).toBe(true);
  });

  it('上限ちょうどまではoverflowが立たない（境界値）', () => {
    const atLimit = 'x'.repeat(MAX_LINE_BUFFER_BYTES);
    expect(consumeNdjson(atLimit).overflow).toBe(false);
  });
});
