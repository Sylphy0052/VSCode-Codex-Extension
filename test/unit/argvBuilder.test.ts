import { describe, expect, it } from 'vitest';
import {
  buildLaunchEnv,
  buildShellArgs,
  isSessionId,
  isUnsafeCombination,
} from '../../src/codex/argvBuilder';
import { emptyConfig, type CodexConfig } from '../../src/codex/types';

const ID = '019fd7a6-d25e-7bd2-b181-751e467277f3';
const CWD = '/home/user/project';

const config = (over: Partial<CodexConfig> = {}): CodexConfig => ({ ...emptyConfig, ...over });

describe('buildShellArgs', () => {
  it('新規セッションは -C だけを渡す（空設定はconfig.tomlへ委譲）', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config(),
    });
    expect(args).toEqual(['-C', CWD]);
    expect(warnings).toEqual([]);
  });

  it('resume はサブコマンドとidを先頭に置く', () => {
    const { args } = buildShellArgs({
      target: { kind: 'resume', sessionId: ID },
      cwd: CWD,
      config: config(),
    });
    expect(args).toEqual(['resume', ID, '-C', CWD]);
  });

  it('fork も同じ形になる', () => {
    const { args } = buildShellArgs({
      target: { kind: 'fork', sessionId: ID },
      cwd: CWD,
      config: config(),
    });
    expect(args.slice(0, 2)).toEqual(['fork', ID]);
  });

  it('設定された値をフラグに展開する', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'xhigh',
        profile: 'work',
        sandbox: 'workspace-write',
        approvalMode: 'on-request',
        additionalArgs: ['--search'],
      }),
    });
    expect(args).toEqual([
      '-C',
      CWD,
      '-m',
      'gpt-5.6-terra',
      '-c',
      'model_reasoning_effort=xhigh',
      '-p',
      'work',
      '-s',
      'workspace-write',
      '-a',
      'on-request',
      '--search',
    ]);
    expect(warnings).toEqual([]);
  });

  it('不正なsandbox値は無視して警告する', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config({ sandbox: 'yolo' }),
    });
    expect(args).not.toContain('-s');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('codex.sandbox');
  });

  it('不正なapprovalMode値は無視して警告する', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config({ approvalMode: 'always' }),
    });
    expect(args).not.toContain('-a');
    expect(warnings[0]).toContain('codex.approvalMode');
  });

  it('approvalsReviewer が auto_review のときだけ --approve-for-me を渡す', () => {
    const auto = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config({ approvalsReviewer: 'auto_review' }),
    });
    expect(auto.args).toEqual(['-C', CWD, '--approve-for-me']);
    expect(auto.warnings).toEqual([]);
  });

  it('approvalsReviewer が user ならフラグを渡さない（Codexの既定と同じ）', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config({ approvalsReviewer: 'user' }),
    });
    expect(args).toEqual(['-C', CWD]);
    expect(warnings).toEqual([]);
  });

  it('不正なapprovalsReviewer値は無視して警告する', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config({ approvalsReviewer: 'guardian_subagent' }),
    });
    expect(args).not.toContain('--approve-for-me');
    expect(warnings[0]).toContain('codex.approvalsReviewer');
  });

  it('session idがUUID形式でなければ例外を投げる（引数注入の防止）', () => {
    expect(() =>
      buildShellArgs({
        target: { kind: 'resume', sessionId: '--dangerously-bypass-approvals-and-sandbox' },
        cwd: CWD,
        config: config(),
      }),
    ).toThrow(/不正なsession id/);
  });

  it('相対パスのcwdは -C を渡さず警告する', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: 'relative/path',
      config: config(),
    });
    expect(args).toEqual([]);
    expect(warnings[0]).toContain('絶対パス');
  });

  it('cwd未指定なら -C を省く（Codex側の既定に委ねる）', () => {
    const { args } = buildShellArgs({ target: { kind: 'new' }, cwd: undefined, config: config() });
    expect(args).toEqual([]);
  });

  it('additionalArgs の空要素は捨てて警告する', () => {
    const { args, warnings } = buildShellArgs({
      target: { kind: 'new' },
      cwd: CWD,
      config: config({ additionalArgs: ['--search', ''] }),
    });
    expect(args).toEqual(['-C', CWD, '--search']);
    expect(warnings).toHaveLength(1);
  });
});

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
});

describe('buildLaunchEnv', () => {
  it('紐付け用の一意タグを originator 上書き変数として渡す', () => {
    expect(buildLaunchEnv('vscode-abc')).toEqual({
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'vscode-abc',
    });
  });
});
