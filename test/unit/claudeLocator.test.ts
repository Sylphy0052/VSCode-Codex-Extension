import { describe, expect, it } from 'vitest';
import type { LocatorDeps } from '../../src/codex/cliLocator';
import { claudePaths, resolveClaudeHome, resolveClaudePath } from '../../src/claude/cliLocator';

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
