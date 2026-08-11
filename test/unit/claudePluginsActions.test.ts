import { describe, expect, it } from 'vitest';
import { ClaudePluginActions } from '../../src/claude/pluginsActions';
import type { CommandResult, CommandRunner } from '../../src/process/commandRunner';

function fakeRunner(result: CommandResult = { code: 0, stderr: '' }) {
  const calls: { executable: string; args: string[]; stdin: string | undefined }[] = [];
  const runner: CommandRunner = {
    run(executable, args, stdin) {
      calls.push({ executable, args, stdin });
      return Promise.resolve(result);
    },
  };
  return { runner, calls };
}

describe('ClaudePluginActions', () => {
  it('enableはplugin enable <id>を実行する', async () => {
    const { runner, calls } = fakeRunner();
    const actions = new ClaudePluginActions(runner, () => 'claude');
    await actions.enable('genshijin@genshijin', undefined);
    expect(calls[0]).toEqual({
      executable: 'claude',
      args: ['plugin', 'enable', 'genshijin@genshijin'],
      stdin: undefined,
    });
  });

  it('scopeを渡すと-sを付ける', async () => {
    const { runner, calls } = fakeRunner();
    const actions = new ClaudePluginActions(runner, () => 'claude');
    await actions.disable('genshijin@genshijin', 'project');
    expect(calls[0]?.args).toEqual(['plugin', 'disable', 'genshijin@genshijin', '-s', 'project']);
  });

  it('uninstallは-yを付ける', async () => {
    const { runner, calls } = fakeRunner();
    const actions = new ClaudePluginActions(runner, () => 'claude');
    await actions.uninstall('genshijin@genshijin', 'user');
    expect(calls[0]?.args).toEqual([
      'plugin',
      'uninstall',
      'genshijin@genshijin',
      '-y',
      '-s',
      'user',
    ]);
  });

  it('installはspecをそのまま渡す', async () => {
    const { runner, calls } = fakeRunner();
    const actions = new ClaudePluginActions(runner, () => 'claude');
    await actions.install('new-plugin@some-marketplace', undefined);
    expect(calls[0]?.args).toEqual(['plugin', 'install', 'new-plugin@some-marketplace']);
  });

  it('不正な名前は実行せずエラーを返す', async () => {
    const { runner, calls } = fakeRunner();
    const actions = new ClaudePluginActions(runner, () => 'claude');
    const result = await actions.enable('', undefined);
    expect(calls).toHaveLength(0);
    expect(result.code).not.toBe(0);
  });

  it('空白を含む名前は実行せずエラーを返す', async () => {
    const { runner, calls } = fakeRunner();
    const actions = new ClaudePluginActions(runner, () => 'claude');
    await actions.install('evil name; rm -rf', undefined);
    expect(calls).toHaveLength(0);
  });
});
