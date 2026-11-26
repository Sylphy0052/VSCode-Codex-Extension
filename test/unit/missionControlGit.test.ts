import { describe, expect, it, vi } from 'vitest';
import type { GitCommandRunner } from '../../src/orchestrator/worktree';
import { SAFE_GIT_CONFIG_ARGS, withSafeGitConfig } from '../../src/view/missionControlGit';

describe('withSafeGitConfig', () => {
  it('全呼び出しの先頭へcore.fsmonitor=falseとcore.hooksPathの上書きを付ける', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const git: GitCommandRunner = { run };
    await withSafeGitConfig(git).run(['rev-parse', '--show-toplevel'], '/r', { timeoutMs: 5 });
    expect(run).toHaveBeenCalledWith(
      [...SAFE_GIT_CONFIG_ARGS, 'rev-parse', '--show-toplevel'],
      '/r',
      { timeoutMs: 5 },
    );
    expect(SAFE_GIT_CONFIG_ARGS.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
    expect(SAFE_GIT_CONFIG_ARGS).toContain('core.hooksPath=/dev/null');
  });
});
