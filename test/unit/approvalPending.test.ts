import { describe, expect, it } from 'vitest';
import { approvalPendingBadge, countApprovalPending } from '../../src/view/approvalPending';
import type { SessionActivityState } from '../../src/view/sessionActivity';

describe('countApprovalPending（issue #734）', () => {
  it('承認待ちだけを数える', () => {
    const states: SessionActivityState[] = [
      'approvalPending',
      'running',
      'idle',
      'approvalPending',
    ];
    expect(countApprovalPending(states)).toBe(2);
  });

  it('実行中は数に含めない', () => {
    expect(countApprovalPending(['running', 'running'])).toBe(0);
  });

  it('開いている画面が無ければ0', () => {
    expect(countApprovalPending([])).toBe(0);
  });
});

describe('approvalPendingBadge（issue #734）', () => {
  it('0件はバッジを出さない', () => {
    expect(approvalPendingBadge(0)).toBeUndefined();
  });

  it('件数と件数入りのtooltipを返す', () => {
    expect(approvalPendingBadge(3)).toEqual({ value: 3, tooltip: '承認待ち 3件' });
  });

  it('負の数もバッジを出さない（件数の算出が壊れたときに0未満を表示しない）', () => {
    expect(approvalPendingBadge(-1)).toBeUndefined();
  });
});
