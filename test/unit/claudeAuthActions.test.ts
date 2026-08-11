import { describe, expect, it } from 'vitest';
import { ClaudeAuthActions } from '../../src/claude/authActions';
import type { CommandResult, CommandRunner } from '../../src/process/commandRunner';

class FakeRunner implements CommandRunner {
  calls: Array<{ executable: string; args: string[]; stdin: string | undefined }> = [];

  constructor(private readonly result: CommandResult = { code: 0, stderr: '' }) {}

  async run(executable: string, args: string[], stdin?: string): Promise<CommandResult> {
    this.calls.push({ executable, args, stdin });
    return this.result;
  }
}

describe('ClaudeAuthActions', () => {
  it('logout は `claude auth logout` を実行する（`claude auth --help` で確認）', async () => {
    const runner = new FakeRunner();
    const result = await new ClaudeAuthActions(runner, () => '/usr/bin/claude').logout();

    expect(result.code).toBe(0);
    expect(runner.calls).toEqual([
      { executable: '/usr/bin/claude', args: ['auth', 'logout'], stdin: undefined },
    ]);
  });

  it('logout の失敗は終了コードとstderrをそのまま返す', async () => {
    const runner = new FakeRunner({ code: 1, stderr: 'Error: not logged in' });
    const result = await new ClaudeAuthActions(runner, () => 'claude').logout();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not logged in');
  });
});
