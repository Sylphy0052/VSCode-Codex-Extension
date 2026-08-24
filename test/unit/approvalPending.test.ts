import { describe, expect, it } from 'vitest';
import { approvalPendingBadge, approvalStatusBarText } from '../../src/view/approvalPending';

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

describe('approvalStatusBarText（issue #755）', () => {
  it('0件は空文字（項目を隠す合図）', () => {
    expect(approvalStatusBarText(0)).toBe('');
  });

  it('負の数も空文字', () => {
    expect(approvalStatusBarText(-1)).toBe('');
  });

  it('件数とアイコンを出す', () => {
    expect(approvalStatusBarText(2)).toBe('$(bell-dot) 承認待ち 2');
  });

  it('履歴ツリーの承認待ちと同じアイコンを使う', () => {
    // `sessionTreeProvider.ts`の`buildSessionIcon`が承認待ちに使うのと同じid
    expect(approvalStatusBarText(1)).toContain('$(bell-dot)');
  });
});
