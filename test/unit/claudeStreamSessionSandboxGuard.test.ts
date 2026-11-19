import { describe, expect, it } from 'vitest';
import { SANDBOX_BASH_GUARD_CALLBACK_ID } from '../../src/claude/sandboxBashGuard';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../../src/claude/streamSession';
import { emptyClaudeConfig, type ClaudeConfig } from '../../src/claude/types';
import type { Logger } from '../../src/log';
import { createFakeChildProcess } from '../helpers/fakeChildProcess';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const CS_PY = 'python3 /home/u/.claude/skills/compute-server/scripts/cs.py';

/** sandboxのhookを登録した設定で`start()`し、hook_callbackへの応答を集める。 */
function startSession(config: ClaudeConfig): {
  hookAnswer: (requestId: string, command: string) => Promise<unknown>;
} {
  const fake = createFakeChildProcess();
  const spawnProcess: ClaudeSpawnPort = () => fake.proc;
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
    () => undefined,
    () => undefined,
    undefined,
    spawnProcess,
  );
  session.start({
    cwd: '/w',
    target: { kind: 'new' },
    sessionId: '11111111-1111-1111-1111-111111111111',
    config,
  });
  return {
    hookAnswer: async (requestId, command) => {
      fake.emitStdout(
        `${JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'hook_callback',
            callback_id: SANDBOX_BASH_GUARD_CALLBACK_ID,
            input: { tool_name: 'Bash', tool_input: { command } },
          },
        })}\n`,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const line = fake.writes.find((w) => w.includes(`"request_id":"${requestId}"`));
      return line === undefined ? undefined : JSON.parse(line);
    },
  };
}

describe('ClaudeStreamSession: sandboxのhookへ設定の除外パターンを渡す（Issue #2133）', () => {
  it('設定で足したパターンを連結した形はhookで拒否し、単独の形は通す', async () => {
    const { hookAnswer } = startSession({
      ...emptyClaudeConfig,
      sandboxBashGuard: true,
      sandboxExtraExcludedCommands: [`${CS_PY} *`],
    });

    expect(JSON.stringify(await hookAnswer('h1', `cd a && ${CS_PY} pick`))).toContain(
      '"permissionDecision":"deny"',
    );
    expect(JSON.stringify(await hookAnswer('h2', `${CS_PY} pick`))).not.toContain('deny');
  });

  it('設定が無ければ従来どおり固定の一覧だけで判定する', async () => {
    const { hookAnswer } = startSession({ ...emptyClaudeConfig, sandboxBashGuard: true });

    expect(JSON.stringify(await hookAnswer('h1', `cd a && ${CS_PY} pick`))).not.toContain('deny');
    expect(JSON.stringify(await hookAnswer('h2', 'cd a && ssh host true'))).toContain(
      '"permissionDecision":"deny"',
    );
  });
});
