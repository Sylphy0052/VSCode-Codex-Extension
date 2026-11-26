import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../../src/claude/streamSession';
import { emptyClaudeConfig } from '../../src/claude/types';
import type { Logger } from '../../src/log';
import { configureExtensionSkillRoots } from '../../src/provider/extensionSkills';
import { createFakeChildProcess } from '../helpers/fakeChildProcess';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

let work: string;
let bundled: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'stream-plugin-dirs-'));
  bundled = join(work, 'bundled');
  await mkdir(join(bundled, '.claude-plugin'), { recursive: true });
  await writeFile(join(bundled, '.claude-plugin', 'plugin.json'), '{"name":"codex-ext"}');
  await mkdir(join(bundled, 'skills', 'sk1'), { recursive: true });
  await writeFile(join(bundled, 'skills', 'sk1', 'SKILL.md'), 'x');
  configureExtensionSkillRoots(() => [bundled]);
});

afterEach(async () => {
  configureExtensionSkillRoots(() => []);
  await rm(work, { recursive: true, force: true });
});

/** `configDir`を渡したセッションを起動し、spawnへ渡った引数と環境変数を返す。 */
function launch(configDir: string): { args: readonly string[]; env: NodeJS.ProcessEnv } {
  let captured: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  const spawnProcess: ClaudeSpawnPort = (_command, args, options) => {
    captured = { args, env: options.env };
    return createFakeChildProcess().proc;
  };
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
    () => undefined,
    () => undefined,
    undefined,
    spawnProcess,
    undefined,
    undefined,
    undefined,
    undefined,
    configDir,
  );
  session.start({
    cwd: '/w',
    target: { kind: 'new' },
    sessionId: '11111111-1111-1111-1111-111111111111',
    config: emptyClaudeConfig,
  });
  if (captured === undefined) {
    throw new Error('spawnが呼ばれなかった');
  }
  return captured;
}

describe('ClaudeStreamSession: configDirで同梱pluginを省くか決める（Issue #1935）', () => {
  it('configDirに同名のskillがあれば--plugin-dirへ同梱rootを渡さない', async () => {
    const home = join(work, 'claude-home');
    await mkdir(join(home, 'skills', 'sk1'), { recursive: true });
    await writeFile(join(home, 'skills', 'sk1', 'SKILL.md'), 'x');

    const { args, env } = launch(home);

    expect(args).not.toContain(bundled);
    expect(env['CLAUDE_CONFIG_DIR']).toBe(home);
  });

  it('configDirに無ければ--plugin-dirへ同梱rootを渡す', () => {
    const home = join(work, 'empty-home');

    const { args } = launch(home);

    const index = args.indexOf(bundled);
    expect(index).toBeGreaterThan(0);
    expect(args[index - 1]).toBe('--plugin-dir');
  });
});
