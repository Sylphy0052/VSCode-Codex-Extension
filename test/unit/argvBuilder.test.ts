import { describe, expect, it } from 'vitest';
import {
  describeUnsafeCombination,
  isSessionId,
  isUnsafeCombination,
} from '../../src/codex/argvBuilder';
import { emptyConfig, type CodexConfig } from '../../src/codex/types';

const ID = '019fd7a6-d25e-7bd2-b181-751e467277f3';

const config = (over: Partial<CodexConfig> = {}): CodexConfig => ({ ...emptyConfig, ...over });

describe('isSessionId', () => {
  it('UUIDのみ受け付ける', () => {
    expect(isSessionId(ID)).toBe(true);
    expect(isSessionId('not-a-uuid')).toBe(false);
    expect(isSessionId('')).toBe(false);
    expect(isSessionId(`${ID} --search`)).toBe(false);
    expect(isSessionId('-C/etc')).toBe(false);
  });
});

describe('isUnsafeCombination', () => {
  it('サンドボックスと承認の両方を外した時だけ真', () => {
    expect(
      isUnsafeCombination(config({ sandbox: 'danger-full-access', approvalMode: 'never' })),
    ).toBe(true);
    expect(
      isUnsafeCombination(config({ sandbox: 'danger-full-access', approvalMode: 'on-request' })),
    ).toBe(false);
    expect(isUnsafeCombination(config())).toBe(false);
  });

  it('制限なしのサンドボックスを自動承認へ任せる組み合わせも真', () => {
    expect(
      isUnsafeCombination(
        config({ sandbox: 'danger-full-access', approvalsReviewer: 'auto_review' }),
      ),
    ).toBe(true);
  });

  it('自動承認でもサンドボックスが効いていれば真にしない', () => {
    expect(
      isUnsafeCombination(config({ sandbox: 'workspace-write', approvalsReviewer: 'auto_review' })),
    ).toBe(false);
  });

  it('bypassApprovalsAndSandbox は単独で真（issue #222）', () => {
    // 保護を両方外すという意味では danger-full-access + never と同じだが、
    // こちらはサンドボックス自体を張らない。sandbox の値によらず確認を出す
    expect(isUnsafeCombination(config({ bypassApprovalsAndSandbox: true }))).toBe(true);
    expect(
      isUnsafeCombination(config({ bypassApprovalsAndSandbox: true, sandbox: 'read-only' })),
    ).toBe(true);
  });
});

describe('describeUnsafeCombination', () => {
  it('安全な設定では何も返さない', () => {
    expect(describeUnsafeCombination(config())).toBeUndefined();
    expect(describeUnsafeCombination(config({ sandbox: 'workspace-write' }))).toBeUndefined();
  });

  it('何がどう危ないかを述べる（確認ダイアログの本文）', () => {
    expect(describeUnsafeCombination(config({ bypassApprovalsAndSandbox: true }))).toBe(
      'サンドボックスを張らず、確認も一切求めずに実行します。ファイルの書き換えもネットワークも制限されません。',
    );
    expect(
      describeUnsafeCombination(config({ sandbox: 'danger-full-access', approvalMode: 'never' })),
    ).toBe('制限なしのサンドボックスで、承認を一切求めずに実行します。');
    expect(
      describeUnsafeCombination(
        config({ sandbox: 'danger-full-access', approvalsReviewer: 'auto_review' }),
      ),
    ).toBe(
      '制限なしのサンドボックスで、承認をCodex内部のsubagentが自動で判定します。人には回りません。',
    );
  });

  it('bypassは他の組み合わせより先に説明する', () => {
    // 両方当てはまる場合、実際に効くのはbypass側（argvも app-server の指定もそちらが勝つ）
    expect(
      describeUnsafeCombination(
        config({
          bypassApprovalsAndSandbox: true,
          sandbox: 'danger-full-access',
          approvalMode: 'never',
        }),
      ),
    ).toContain('サンドボックスを張らず');
  });
});
