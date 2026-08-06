import { describe, expect, it } from 'vitest';
import {
  SessionActions,
  buildActionArgs,
  type CommandResult,
  type CommandRunner,
} from '../../src/session/sessionActions';

const ID = '019fd7a6-d25e-7bd2-b181-751e467277f3';

describe('buildActionArgs', () => {
  it('archive と unarchive はidを渡すだけ', () => {
    expect(buildActionArgs('archive', ID)).toEqual(['archive', ID]);
    expect(buildActionArgs('unarchive', ID)).toEqual(['unarchive', ID]);
  });

  it('delete は --force が必須（TTYが無いと拒否されるため）', () => {
    expect(buildActionArgs('delete', ID)).toEqual(['delete', '--force', ID]);
  });

  it('UUID以外は例外にする（引数注入の防止）', () => {
    expect(() => buildActionArgs('delete', '--force')).toThrow(/不正なsession id/);
    expect(() => buildActionArgs('archive', '')).toThrow(/不正なsession id/);
  });
});

class FakeRunner implements CommandRunner {
  calls: Array<{ executable: string; args: string[] }> = [];

  constructor(private readonly result: CommandResult = { code: 0, stderr: '' }) {}

  async run(executable: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ executable, args });
    return this.result;
  }
}

describe('SessionActions', () => {
  it('解決済みのcodexパスで実行する', async () => {
    const runner = new FakeRunner();
    const result = await new SessionActions(runner, () => '/usr/bin/codex').run('archive', ID);

    expect(result.code).toBe(0);
    expect(runner.calls).toEqual([{ executable: '/usr/bin/codex', args: ['archive', ID] }]);
  });

  it('失敗時は終了コードとstderrをそのまま返す', async () => {
    const runner = new FakeRunner({ code: 1, stderr: 'Error: failed to archive session' });
    const result = await new SessionActions(runner, () => 'codex').run('archive', ID);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed to archive');
  });

  it('不正なidでは実行そのものを行わない', async () => {
    const runner = new FakeRunner();
    await expect(new SessionActions(runner, () => 'codex').run('delete', 'x')).rejects.toThrow();
    expect(runner.calls).toEqual([]);
  });
});
