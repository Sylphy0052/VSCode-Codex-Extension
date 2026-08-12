import { describe, expect, it } from 'vitest';
import type { LocatorDeps } from '../../src/codex/cliLocator';
import {
  claudePaths,
  debugLogCandidates,
  resolveClaudeHome,
  resolveClaudePath,
} from '../../src/claude/cliLocator';

const deps = (overrides: Partial<LocatorDeps> = {}): LocatorDeps => ({
  isExecutable: (c) => c === '/usr/local/bin/claude',
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homedir: () => '/home/u',
  delimiter: ':',
  ...overrides,
});

describe('resolveClaudePath', () => {
  it('設定が空ならPATHから claude を探す', () => {
    expect(resolveClaudePath('', deps())).toEqual({
      ok: true,
      path: '/usr/local/bin/claude',
      source: 'path',
    });
  });

  it('パス指定はPATHへフォールバックしない', () => {
    expect(resolveClaudePath('/opt/claude', deps())).toEqual({
      ok: false,
      reason: 'setting-not-executable',
      attempted: '/opt/claude',
    });
  });

  it('見つからなければ not-found', () => {
    const result = resolveClaudePath('', deps({ isExecutable: () => false }));
    expect(result).toEqual({ ok: false, reason: 'not-found', attempted: 'claude' });
  });
});

describe('resolveClaudeHome', () => {
  it('設定 > CLAUDE_CONFIG_DIR > ~/.claude の順で解決する', () => {
    expect(resolveClaudeHome('/cfg', deps({ env: { CLAUDE_CONFIG_DIR: '/env' } }))).toBe('/cfg');
    expect(resolveClaudeHome('', deps({ env: { CLAUDE_CONFIG_DIR: '/env' } }))).toBe('/env');
    expect(resolveClaudeHome('', deps({ env: {} }))).toBe('/home/u/.claude');
  });
});

describe('claudePaths', () => {
  it('transcriptの置き場を組み立てる', () => {
    expect(claudePaths('/home/u/.claude')).toEqual({
      home: '/home/u/.claude',
      projects: '/home/u/.claude/projects',
    });
  });
});

describe('debugLogCandidates（issue #205）', () => {
  it('threadIdがあればセッション専用のログを最優先にし、latestを次点で含める', () => {
    expect(debugLogCandidates('/home/u/.claude', 'session-abc')).toEqual([
      '/home/u/.claude/debug/session-abc.txt',
      '/home/u/.claude/debug/latest',
    ]);
  });

  it('threadIdが無い（system/init未受信）場合はlatestだけを候補にする', () => {
    expect(debugLogCandidates('/home/u/.claude', undefined)).toEqual([
      '/home/u/.claude/debug/latest',
    ]);
  });

  it('threadIdが空白だけの場合もセッション専用の候補は作らない', () => {
    expect(debugLogCandidates('/home/u/.claude', '   ')).toEqual([
      '/home/u/.claude/debug/latest',
    ]);
  });
});
