import { describe, expect, it } from 'vitest';
import type { ApprovalPendingSession } from '../../src/view/approvalPending';
import { ApprovalStatusBar, SHOW_APPROVAL_PENDING_COMMAND } from '../../src/view/approvalStatusBar';

/** 実装が持つ `vscode.StatusBarItem`（モックは `FakeStatusBarItem`）を覗く。 */
function itemOf(bar: InstanceType<typeof ApprovalStatusBar>): {
  text: string;
  visible: boolean;
  command: string | undefined;
  tooltip: { value: string } | string | undefined;
  backgroundColor: { id: string } | undefined;
  alignment: number;
} {
  return (bar as unknown as { item: never })['item'];
}

const session = (threadId: string, title: string): ApprovalPendingSession => ({
  threadId,
  title,
  provider: 'codex',
});

describe('ApprovalStatusBar（issue #755）', () => {
  it('0件では見せない', () => {
    const bar = new ApprovalStatusBar();
    bar.update([]);
    expect(itemOf(bar).visible).toBe(false);
  });

  it('承認待ちがあれば件数を出す', () => {
    const bar = new ApprovalStatusBar();
    bar.update([session('t1', 'ひとつめ'), session('t2', 'ふたつめ')]);
    const item = itemOf(bar);
    expect(item.visible).toBe(true);
    expect(item.text).toBe('$(bell-dot) 承認待ち 2');
  });

  it('解決すると消える', () => {
    const bar = new ApprovalStatusBar();
    bar.update([session('t1', 'ひとつめ')]);
    expect(itemOf(bar).visible).toBe(true);
    bar.update([]);
    expect(itemOf(bar).visible).toBe(false);
  });

  it('押すと承認待ちを開くコマンドを呼ぶ', () => {
    const bar = new ApprovalStatusBar();
    expect(itemOf(bar).command).toBe(SHOW_APPROVAL_PENDING_COMMAND);
  });

  it('目立つ背景色を付ける', () => {
    const bar = new ApprovalStatusBar();
    expect(itemOf(bar).backgroundColor?.id).toBe('statusBarItem.warningBackground');
  });

  it('左に置く（右は使用量で埋まっている）', () => {
    const bar = new ApprovalStatusBar();
    // `vscode.StatusBarAlignment.Left`
    expect(itemOf(bar).alignment).toBe(1);
  });

  it('tooltipにどの会話が待っているかを出す', () => {
    const bar = new ApprovalStatusBar();
    bar.update([session('t1', 'ひとつめ'), session('t2', 'ふたつめ')]);
    const tooltip = itemOf(bar).tooltip;
    const value = typeof tooltip === 'string' ? tooltip : (tooltip?.value ?? '');
    expect(value).toContain('ひとつめ');
    expect(value).toContain('ふたつめ');
  });

  it('タイトルのMarkdownを打ち消す（CLI由来の未信頼な文字列のため）', () => {
    const bar = new ApprovalStatusBar();
    bar.update([session('t1', '**強調**されたくない')]);
    const tooltip = itemOf(bar).tooltip;
    const value = typeof tooltip === 'string' ? tooltip : (tooltip?.value ?? '');
    expect(value).toContain('\\*\\*強調\\*\\*');
    expect(value).not.toContain('- **強調**');
  });
});
