import { describe, expect, it } from 'vitest';
import { CodexAccountActions } from '../../src/codex/accountActions';
import type { CommandResult, CommandRunner } from '../../src/process/commandRunner';

class FakeRunner implements CommandRunner {
  calls: Array<{ executable: string; args: string[]; stdin: string | undefined }> = [];

  constructor(private readonly result: CommandResult = { code: 0, stderr: '' }) {}

  async run(executable: string, args: string[], stdin?: string): Promise<CommandResult> {
    this.calls.push({ executable, args, stdin });
    return this.result;
  }
}

describe('CodexAccountActions', () => {
  it('logout は `codex logout` を引数無しで実行する（--help で確認: 対話なしで完結）', async () => {
    const runner = new FakeRunner();
    const result = await new CodexAccountActions(runner, () => '/usr/bin/codex').logout();

    expect(result.code).toBe(0);
    expect(runner.calls).toEqual([{ executable: '/usr/bin/codex', args: ['logout'], stdin: undefined }]);
  });

  it('logout の失敗は終了コードとstderrをそのまま返す', async () => {
    const runner = new FakeRunner({ code: 1, stderr: 'Error: not logged in' });
    const result = await new CodexAccountActions(runner, () => 'codex').logout();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not logged in');
  });

  it('loginWithApiKey は `codex login --with-api-key` を実行し、キーを標準入力に渡す（引数には載せない）', async () => {
    const runner = new FakeRunner();
    const result = await new CodexAccountActions(runner, () => 'codex').loginWithApiKey('sk-test-key');

    expect(result.code).toBe(0);
    expect(runner.calls).toEqual([
      { executable: 'codex', args: ['login', '--with-api-key'], stdin: 'sk-test-key' },
    ]);
    // 呼び出し引数のどこにもキーの値が生で載らないこと（プロセス一覧に残さないため）
    expect(runner.calls[0]?.args.join(' ')).not.toContain('sk-test-key');
  });

  it('loginWithApiKey の失敗は終了コードとstderrをそのまま返す', async () => {
    const runner = new FakeRunner({ code: 1, stderr: 'Error: invalid API key' });
    const result = await new CodexAccountActions(runner, () => 'codex').loginWithApiKey('bad-key');

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('invalid API key');
  });
});
