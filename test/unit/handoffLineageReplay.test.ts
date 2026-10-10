import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CONTEXT_BUDGET,
  renderLineageReplay,
  type LineageRecord,
} from '../../src/view/handoffLineage';

function records(): LineageRecord[] {
  const out: LineageRecord[] = [];
  for (let i = 1; i <= 6; i++) {
    out.push({
      kind: 'assistant',
      id: `A${i}`,
      gen: 1,
      sessionId: 's',
      at: '2026-10-01T00:00:00.000Z',
      text: 'a'.repeat(1500),
    });
    out.push({
      kind: 'user',
      id: `U${i}`,
      gen: 1,
      sessionId: 's',
      at: '2026-10-01T00:00:00.000Z',
      text: `発話${i}`,
      source: i === 3 ? 'auto' : 'human',
    });
  }
  return out;
}

describe('renderLineageReplay の縮小', () => {
  const text = renderLineageReplay({
    ref: { lineageId: 'L1', snapshot: 'S1' },
    records: records(),
    snapshotPath: '/tmp/s.jsonl',
    parentMissing: false,
  });

  it('予算を縮小している', () => {
    expect(ASSISTANT_CONTEXT_BUDGET).toBe(4000);
  });

  it('USERはatを持たず、humanのsourceも付けない。autoだけ付ける', () => {
    expect(text).not.toContain(' at="');
    expect(text).toContain('<USER id="U1" gen="1">');
    expect(text).toContain('<USER id="U3" gen="1" source="auto">');
  });

  it('省いた応答は1行にまとめ、自己終了タグ行を出さない', () => {
    expect(text).not.toContain('omitted=');
    expect(text).not.toContain('authoritative=');
    expect(text.match(/予算超過で省いた応答\d+件/gu)).toHaveLength(1);
    expect(text).toContain('予算超過で省いた応答4件は系列ファイルにある');
  });
});
