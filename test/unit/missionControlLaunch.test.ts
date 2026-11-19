import { describe, expect, it, vi } from 'vitest';
import {
  buildLaunchRepos,
  launchMissionControlSession,
  parseLaunchRequest,
  pushRecentRepo,
  readRecentRepos,
  type McLaunchDeps,
} from '../../src/view/missionControlLaunch';
import type { McRepoResolver } from '../../src/view/missionControlModel';

const resolve: McRepoResolver = (cwd) => {
  const root = (cwd ?? '').startsWith('/w/app') ? '/w/app' : (cwd ?? '');
  return { key: root, label: root.split('/').pop() ?? root, full: root };
};

describe('parseLaunchRequest（Issue #2137）', () => {
  const ok = { cwd: '/w/app', provider: 'codex', prompt: 'hi', worktree: false };

  it('絶対パス・provider・指示・worktreeの形を確かめる', () => {
    expect(parseLaunchRequest(ok)).toEqual(ok);
    expect(parseLaunchRequest({ ...ok, cwd: 'rel/path' })).toBe(
      '作業ディレクトリは絶対パスで指定してください',
    );
    expect(parseLaunchRequest({ ...ok, cwd: '/w/a\nb' })).toBe('作業ディレクトリが不正です');
    expect(parseLaunchRequest({ ...ok, provider: 'gemini' })).toBe('CodexかClaudeを選んでください');
    expect(parseLaunchRequest({ ...ok, worktree: 'yes' })).toBe('worktreeの指定が不正です');
    expect(parseLaunchRequest({ ...ok, prompt: 'x'.repeat(100_001) })).toBe(
      '最初の指示が長すぎます',
    );
  });
});

function deps(overrides: Partial<McLaunchDeps>): McLaunchDeps {
  return {
    git: { run: vi.fn() },
    worktreeFs: {
      realpath: async (p) => p,
      readTextFile: async () => undefined,
      isSymbolicLink: async () => false,
      pathExists: async () => true,
    },
    worktrees: { create: vi.fn() } as never,
    isDirectory: async () => true,
    appendExclude: vi.fn(),
    open: vi.fn(async () => 'thread-1'),
    ...overrides,
  };
}

describe('launchMissionControlSession（Issue #2137）', () => {
  it('実在しないディレクトリでは起動しない', async () => {
    const d = deps({ isDirectory: async () => false });
    expect(
      await launchMissionControlSession(
        { cwd: '/nope', provider: 'claude', prompt: '', worktree: false },
        d,
      ),
    ).toEqual({ ok: false, error: '作業ディレクトリが見つかりません' });
    expect(d.open).not.toHaveBeenCalled();
  });

  it('worktreeがOFFなら選んだディレクトリで既存のopenを呼ぶ', async () => {
    const d = deps({});
    const result = await launchMissionControlSession(
      { cwd: '/w/app', provider: 'claude', prompt: 'go', worktree: false },
      d,
    );
    expect(result).toEqual({ ok: true, cwd: '/w/app', threadId: 'thread-1' });
    expect(d.open).toHaveBeenCalledWith('claude', '/w/app', 'go', undefined);
  });

  it('worktreeがONなら本体の.claude/worktrees/配下に作り、そこで起動する', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[1] === '--git-common-dir') return { code: 0, stdout: '/w/app/.git\n', stderr: '' };
      if (args[1] === 'HEAD') return { code: 0, stdout: 'abcdef1\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const create = vi.fn(async () => ({
      ok: true as const,
      cwd: '/w/app/.claude/worktrees/mc-1',
      branch: 'b',
    }));
    const d = deps({ git: { run }, worktrees: { create } as never });
    const result = await launchMissionControlSession(
      { cwd: '/w/app/src', provider: 'codex', prompt: '', worktree: true },
      d,
    );
    expect(result).toMatchObject({ ok: true, cwd: '/w/app/.claude/worktrees/mc-1' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/w/app', headCommit: 'abcdef1', location: 'claude' }),
      expect.anything(),
      expect.anything(),
    );
    expect(d.open).toHaveBeenCalledWith('codex', '/w/app/.claude/worktrees/mc-1', '', undefined);
  });
});

describe('起動先の候補（Issue #2137）', () => {
  it('同じrepoはまとめ、最近使った → セッション → 履歴の順。消えたものは出さない', async () => {
    const repos = await buildLaunchRepos(
      {
        recent: ['/w/app/sub'],
        sessionCwds: ['/w/app', '/w/other'],
        historyCwds: ['/w/gone', 'relative'],
      },
      resolve,
      async (p) => p !== '/w/gone',
    );
    expect(repos.map((r) => [r.path, r.source])).toEqual([
      ['/w/app', 'recent'],
      ['/w/other', 'session'],
    ]);
  });

  it('最近使ったrepoは先頭に足して重複を除き、壊れた値は捨てる', () => {
    expect(pushRecentRepo(['/a', '/b'], '/b')).toEqual(['/b', '/a']);
    expect(readRecentRepos(['/a', 3, 'rel'])).toEqual(['/a']);
    expect(readRecentRepos('x')).toEqual([]);
  });
});
