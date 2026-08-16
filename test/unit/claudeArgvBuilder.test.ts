import { describe, expect, it } from 'vitest';
import {
  buildClaudeShellArgs,
  buildClaudeStreamArgs,
  isUnsafeClaudeCombination,
} from '../../src/claude/argvBuilder';
import { emptyClaudeConfig, type ClaudeConfig } from '../../src/claude/types';

const ID = '019fd79f-1e16-7b60-b9d2-0324b275ed81';
const NEW_ID = '019fd7a6-d25e-7bd2-b181-751e467277f3';

const config = (overrides: Partial<ClaudeConfig> = {}): ClaudeConfig => ({
  ...emptyClaudeConfig,
  ...overrides,
});

describe('buildClaudeShellArgs', () => {
  it('新規セッションは起動前に決めたidを渡す', () => {
    const { args } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config(),
    });
    expect(args).toEqual(['--session-id', NEW_ID]);
  });

  it('resumeは -r を渡す', () => {
    const { args } = buildClaudeShellArgs({
      target: { kind: 'resume', sessionId: ID },
      sessionId: undefined,
      cwd: '/w/repo',
      config: config(),
    });
    expect(args).toEqual(['-r', ID]);
  });

  it('forkは --fork-session を添える', () => {
    const { args } = buildClaudeShellArgs({
      target: { kind: 'fork', sessionId: ID },
      sessionId: undefined,
      cwd: '/w/repo',
      config: config(),
    });
    expect(args).toEqual(['-r', ID, '--fork-session']);
  });

  it('UUID以外のidを拒否する（引数注入の防止）', () => {
    expect(() =>
      buildClaudeShellArgs({
        target: { kind: 'resume', sessionId: '--dangerously-skip-permissions' },
        sessionId: undefined,
        cwd: '/w/repo',
        config: config(),
      }),
    ).toThrow();

    expect(() =>
      buildClaudeShellArgs({
        target: { kind: 'new' },
        sessionId: 'not-a-uuid',
        cwd: '/w/repo',
        config: config(),
      }),
    ).toThrow();
  });

  it('モデル・effort・権限モード・エージェントを渡す', () => {
    const { args, warnings } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({
        model: 'opus',
        effort: 'high',
        permissionMode: 'acceptEdits',
        agent: 'code-reviewer',
      }),
    });
    expect(args).toEqual([
      '--session-id',
      NEW_ID,
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
      '--agent',
      'code-reviewer',
    ]);
    expect(warnings).toEqual([]);
  });

  it('未知のeffort/権限モードは無視して警告する', () => {
    const { args, warnings } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({ effort: 'ultra', permissionMode: 'yolo' }),
    });
    expect(args).toEqual(['--session-id', NEW_ID]);
    expect(warnings).toHaveLength(2);
  });

  it('エージェント名は空なら渡さない', () => {
    const { args, warnings } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({ agent: '' }),
    });
    expect(args).toEqual(['--session-id', NEW_ID]);
    expect(warnings).toEqual([]);
  });

  it('プラグイン由来のエージェント名（コロン区切り）も渡せる', () => {
    const { args } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({ agent: 'genshijin:genshijin-builder' }),
    });
    expect(args).toEqual(['--session-id', NEW_ID, '--agent', 'genshijin:genshijin-builder']);
  });

  it('引数注入になりうるエージェント名は無視して警告する（先頭がハイフン等）', () => {
    const { args, warnings } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({ agent: '--dangerously-skip-permissions' }),
    });
    expect(args).toEqual(['--session-id', NEW_ID]);
    expect(warnings).toHaveLength(1);
  });

  it('追加引数の空要素を捨てる', () => {
    const { args, warnings } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({ additionalArgs: ['--verbose', ''] }),
    });
    expect(args).toEqual(['--session-id', NEW_ID, '--verbose']);
    expect(warnings).toHaveLength(1);
  });
});

describe('buildClaudeStreamArgs', () => {
  it('常駐チャット用のstream-json引数を組み立てる', () => {
    const { args } = buildClaudeStreamArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({ model: 'sonnet' }),
    });
    expect(args.slice(0, 10)).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool',
      'stdio',
    ]);
    expect(args).toContain('--session-id');
    expect(args).toContain(NEW_ID);
    expect(args).toContain('sonnet');
  });

  // issue #276: これが無いとCLIは承認要求を出さずにツール呼び出しを自動拒否する
  it('承認要求をcontrol protocolへ流す指定を必ず含む', () => {
    for (const permissionMode of ['', 'manual', 'acceptEdits', 'plan', 'bypassPermissions']) {
      const { args } = buildClaudeStreamArgs({
        target: { kind: 'new' },
        sessionId: NEW_ID,
        cwd: '/w/repo',
        config: config({ permissionMode }),
      });
      const at = args.indexOf('--permission-prompt-tool');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(args[at + 1]).toBe('stdio');
    }
  });

  it('TUIタブ用の引数には付けない（CLI自身が対話で承認を聞くため）', () => {
    const { args } = buildClaudeShellArgs({
      target: { kind: 'new' },
      sessionId: NEW_ID,
      cwd: '/w/repo',
      config: config({ permissionMode: 'acceptEdits' }),
    });
    expect(args).not.toContain('--permission-prompt-tool');
  });

  it('resumeでは -r を使い --session-id を渡さない', () => {
    const { args } = buildClaudeStreamArgs({
      target: { kind: 'resume', sessionId: ID },
      sessionId: undefined,
      cwd: '/w/repo',
      config: config(),
    });
    expect(args).toContain('-r');
    expect(args).not.toContain('--session-id');
  });
});

describe('isUnsafeClaudeCombination', () => {
  it('全承認スキップだけを危険とみなす', () => {
    expect(isUnsafeClaudeCombination(config({ permissionMode: 'bypassPermissions' }))).toBe(true);
    expect(isUnsafeClaudeCombination(config({ permissionMode: 'acceptEdits' }))).toBe(false);
    expect(isUnsafeClaudeCombination(config())).toBe(false);
  });

  it('追加引数での迂回も検出する', () => {
    expect(
      isUnsafeClaudeCombination(config({ additionalArgs: ['--dangerously-skip-permissions'] })),
    ).toBe(true);
  });
});
