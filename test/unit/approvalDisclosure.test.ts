import { describe, expect, it } from 'vitest';
import { ApprovalDisclosureLog } from '../../src/view/approvalDisclosure';

/**
 * 「中身を取り寄せた相手にだけ決定を通す」記録（Issue #1259）。
 *
 * これは統括ページの画面側の作りを受信側でも確かめるための関門で、素通りすると
 * 取り寄せていない承認要求へ決定が飛ぶ。時間と要求元の扱いを直接なぞる。
 */

const target = { from: 'window-a', provider: 'codex' as const, threadId: 'thread-1' };

describe('ApprovalDisclosureLog', () => {
  it('取り寄せていない要求への決定は通さない', () => {
    const log = new ApprovalDisclosureLog();
    expect(log.consume(target, 'req_1')).toBe(false);
  });

  it('取り寄せた要求は通す', () => {
    const log = new ApprovalDisclosureLog();
    log.record(target, ['req_1', 'req_2']);
    expect(log.consume(target, 'req_2')).toBe(true);
  });

  it('1回の取り寄せで通すのは1回だけ', () => {
    const log = new ApprovalDisclosureLog();
    log.record(target, ['req_1']);
    expect(log.consume(target, 'req_1')).toBe(true);
    expect(log.consume(target, 'req_1')).toBe(false);
  });

  it('別のウィンドウが取り寄せた分は流用できない', () => {
    const log = new ApprovalDisclosureLog();
    log.record(target, ['req_1']);
    expect(log.consume({ ...target, from: 'window-b' }, 'req_1')).toBe(false);
  });

  it('別の会話・別のプロバイダの分も流用できない', () => {
    const log = new ApprovalDisclosureLog();
    log.record(target, ['req_1']);
    expect(log.consume({ ...target, threadId: 'thread-2' }, 'req_1')).toBe(false);
    expect(log.consume({ ...target, provider: 'claude' }, 'req_1')).toBe(false);
  });

  it('期限を過ぎた記録は通さない', () => {
    let now = 0;
    const log = new ApprovalDisclosureLog(() => now);
    log.record(target, ['req_1']);
    now = 31 * 60_000;
    expect(log.consume(target, 'req_1')).toBe(false);
  });
});
