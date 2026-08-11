import { describe, expect, it } from 'vitest';
import {
  CLAUDE_APPROVAL_CYCLE,
  CODEX_APPROVAL_CYCLE,
  nextApprovalMode,
} from '../../src/provider/approvalCycle';

describe('CODEX_APPROVAL_CYCLE', () => {
  it('厳しい順に並べる', () => {
    // TUIのShift+Tabは「制限が強い側から緩い側へ」進む
    expect(CODEX_APPROVAL_CYCLE).toEqual(['untrusted', 'on-request', 'never']);
  });
});

describe('CLAUDE_APPROVAL_CYCLE', () => {
  it('危険な値を循環に含めない', () => {
    // bypassPermissions は確認なしでツールが動く。順に押していて到達させない
    expect(CLAUDE_APPROVAL_CYCLE).not.toContain('bypassPermissions');
  });

  it('厳しい順に並べる', () => {
    expect(CLAUDE_APPROVAL_CYCLE).toEqual([
      'plan',
      'manual',
      'acceptEdits',
      'auto',
      'dontAsk',
    ]);
  });
});

describe('nextApprovalMode', () => {
  it('順に進む', () => {
    expect(nextApprovalMode(CODEX_APPROVAL_CYCLE, 'untrusted')).toBe('on-request');
    expect(nextApprovalMode(CODEX_APPROVAL_CYCLE, 'on-request')).toBe('never');
  });

  it('末尾まで行ったら先頭へ戻る', () => {
    expect(nextApprovalMode(CODEX_APPROVAL_CYCLE, 'never')).toBe('untrusted');
  });

  it('空（CLIへ委譲）からは先頭へ進む', () => {
    // いま何が効いているか画面からは判らないため、いちばん厳しいところから始める
    expect(nextApprovalMode(CODEX_APPROVAL_CYCLE, '')).toBe('untrusted');
  });

  it('循環に無い値からは先頭へ進む', () => {
    // 設定で bypassPermissions を選んでいる場合もここに来る。循環では緩めない
    expect(nextApprovalMode(CLAUDE_APPROVAL_CYCLE, 'bypassPermissions')).toBe('plan');
    expect(nextApprovalMode(CODEX_APPROVAL_CYCLE, 'yolo')).toBe('untrusted');
  });

  it('空の循環では何も返さない', () => {
    expect(nextApprovalMode([], 'never')).toBeUndefined();
  });
});
