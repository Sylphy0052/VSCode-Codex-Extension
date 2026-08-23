import { describe, expect, it } from 'vitest';
import {
  decoratePanelTitle,
  deriveSessionActivityState,
  sanitizeForNotification,
} from '../../src/view/sessionActivity';

describe('deriveSessionActivityState（issue #286）', () => {
  it('busyがfalse・approvalsが空なら待機中', () => {
    expect(deriveSessionActivityState({ busy: false, approvals: [] })).toBe('idle');
  });

  it('busyがtrueなら実行中', () => {
    expect(deriveSessionActivityState({ busy: true, approvals: [] })).toBe('running');
  });

  it('approvalsが1件以上あれば承認待ち（busyの値に関わらず優先する）', () => {
    const approval = {
      requestId: 1,
      kind: 'command' as const,
      title: 't',
      detail: 'd',
      itemId: undefined,
    };
    expect(deriveSessionActivityState({ busy: true, approvals: [approval] })).toBe(
      'approvalPending',
    );
    expect(deriveSessionActivityState({ busy: false, approvals: [approval] })).toBe(
      'approvalPending',
    );
  });
});

describe('decoratePanelTitle（issue #286）', () => {
  it('待機中はそのまま', () => {
    expect(decoratePanelTitle('Codex: 相談', 'idle')).toBe('Codex: 相談');
  });

  it('実行中は先頭に * を付ける', () => {
    expect(decoratePanelTitle('Codex: 相談', 'running')).toBe('* Codex: 相談');
  });

  it('承認待ちは先頭に ! を付ける', () => {
    expect(decoratePanelTitle('Codex: 相談', 'approvalPending')).toBe('! Codex: 相談');
  });
});

describe('sanitizeForNotification（issue #286）', () => {
  it('改行・連続空白を1つの半角空白へ畳む', () => {
    expect(sanitizeForNotification('コマンドを\n実行します\t\t今すぐ')).toBe(
      'コマンドを 実行します 今すぐ',
    );
  });

  it('前後の空白を取り除く', () => {
    expect(sanitizeForNotification('  タイトル  ')).toBe('タイトル');
  });

  it('上限以下の長さはそのまま', () => {
    expect(sanitizeForNotification('短い名前', 10)).toBe('短い名前');
  });

  it('上限を超えた分は省略記号で切り詰める', () => {
    const long = 'a'.repeat(100);
    const result = sanitizeForNotification(long, 10);
    expect(result).toBe(`${'a'.repeat(10)}…`);
    expect(result.length).toBe(11);
  });

  it('CLIから届く未信頼な長い改行混じりの文字列も通知向けの1行に収まる', () => {
    const malicious = `${'コマンド名'.repeat(30)}\n\n\nrm -rf /`;
    const result = sanitizeForNotification(malicious, 40);
    expect(result.includes('\n')).toBe(false);
    expect(result.length).toBeLessThanOrEqual(41);
  });
});
