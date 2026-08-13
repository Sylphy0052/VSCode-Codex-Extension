import { describe, expect, it } from 'vitest';
import {
  describeReviewAction,
  describeReviewOutcome,
  readAutoApprovalReview,
} from '../../src/appserver/autoApprovalReview';

describe('describeReviewAction', () => {
  it('コマンドは作業ディレクトリを添えて出す', () => {
    expect(
      describeReviewAction({
        type: 'command',
        command: 'rm -rf build',
        cwd: '/w',
        source: 'shell',
      }),
    ).toBe('rm -rf build（/w）');
  });

  it('execve は program と argv を1行に繋ぐ', () => {
    expect(
      describeReviewAction({
        type: 'execve',
        program: '/bin/ls',
        argv: ['ls', '-la'],
        cwd: '/w',
        source: 'shell',
      }),
    ).toBe('ls -la（/w）');
  });

  it('ファイル変更は対象のパスを並べる', () => {
    expect(describeReviewAction({ type: 'applyPatch', cwd: '/w', files: ['a.ts', 'b.ts'] })).toBe(
      'ファイルの変更: a.ts, b.ts',
    );
  });

  it('ネットワークは宛先を出す', () => {
    expect(
      describeReviewAction({
        type: 'networkAccess',
        host: 'example.com',
        port: 443,
        protocol: 'https',
        target: 'https://example.com/x',
      }),
    ).toBe('ネットワーク接続: https://example.com/x');
  });

  it('MCPのツール呼び出しはサーバ名とツール名を出す', () => {
    expect(describeReviewAction({ type: 'mcpToolCall', server: 'files', toolName: 'write' })).toBe(
      'MCPツール: files / write',
    );
  });

  it('権限の昇格は理由があれば添える', () => {
    expect(
      describeReviewAction({
        type: 'requestPermissions',
        permissions: ['network'],
        reason: '外部APIを叩くため',
      }),
    ).toBe('権限の昇格: network（外部APIを叩くため）');
  });

  it('未知の種類でも捨てずに種類名だけ出す', () => {
    expect(describeReviewAction({ type: 'somethingNew' })).toBe('somethingNew');
    expect(describeReviewAction(undefined)).toBe('');
  });
});

describe('describeReviewOutcome', () => {
  it('判定とリスクと理由を1行にまとめる', () => {
    expect(
      describeReviewOutcome({
        status: 'approved',
        riskLevel: 'low',
        rationale: '読み取りのみ',
      }),
    ).toBe('自動レビュー: 承認（リスク low） — 読み取りのみ');
  });

  it('理由が無ければ省く', () => {
    expect(describeReviewOutcome({ status: 'denied', riskLevel: 'critical' })).toBe(
      '自動レビュー: 拒否（リスク critical）',
    );
  });

  it('リスクが無ければ省く', () => {
    expect(describeReviewOutcome({ status: 'inProgress' })).toBe('自動レビュー: 判定中');
  });

  it('未知の状態はそのまま出す（勝手に承認扱いにしない）', () => {
    expect(describeReviewOutcome({ status: 'somethingNew' })).toBe('自動レビュー: somethingNew');
  });
});

describe('readAutoApprovalReview', () => {
  it('通知から表示に必要な値を取り出す', () => {
    const review = readAutoApprovalReview({
      reviewId: 'r-1',
      threadId: 'th-1',
      turnId: 't-1',
      targetItemId: 'i-1',
      action: { type: 'command', command: 'ls', cwd: '/w', source: 'shell' },
      review: { status: 'approved', riskLevel: 'low', rationale: 'ok' },
    });
    expect(review).toEqual({
      reviewId: 'r-1',
      turnId: 't-1',
      action: 'ls（/w）',
      outcome: '自動レビュー: 承認（リスク low） — ok',
      status: 'approved',
    });
  });

  it('reviewId が無ければ扱わない（項目のidを作れない）', () => {
    expect(readAutoApprovalReview({ action: { type: 'command' } })).toBeUndefined();
  });

  it('targetItemId が null のネットワーク審査でも読める', () => {
    const review = readAutoApprovalReview({
      reviewId: 'r-2',
      targetItemId: null,
      action: {
        type: 'networkAccess',
        host: 'h',
        port: 1,
        protocol: 'https',
        target: 'https://h/',
      },
      review: { status: 'denied' },
    });
    expect(review?.status).toBe('denied');
    expect(review?.action).toBe('ネットワーク接続: https://h/');
  });
});
