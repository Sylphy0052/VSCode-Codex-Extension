import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../../src/claude/streamSession';
import { emptyClaudeConfig } from '../../src/claude/types';
import type { Logger } from '../../src/log';
import { createFakeChildProcess } from '../helpers/fakeChildProcess';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/** `start()` まで済ませたセッションと、フェイクプロセスを返す。 */
function createStartedSession(): {
  session: ClaudeStreamSession;
  proc: ChildProcessWithoutNullStreams;
} {
  const { proc } = createFakeChildProcess();
  const spawnProcess: ClaudeSpawnPort = () => proc;
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
    config: emptyClaudeConfig,
  });
  return { session, proc };
}

/** 実測の `background_tasks_changed` 通知（`src/claude/streamJson.ts` を参照）。 */
function backgroundTasksLine(): string {
  return `${JSON.stringify({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg_1', task_type: 'local_bash', description: 'npm run watch' }],
  })}\n`;
}

describe('ClaudeStreamSession: プロセス終了時のバックグラウンド一覧（issue #897）', () => {
  it('exit時にバックグラウンドの一覧を空にする（黄色い枠が残らない）', () => {
    const { session, proc } = createStartedSession();
    session.receive(backgroundTasksLine());
    expect(session.getState().backgroundTerminals).toHaveLength(1);

    proc.emit('exit', 1);

    // タスクはCLIプロセスの子なので、CLIが消えれば一緒に消える。
    // 「消えた」通知はもう届かないため、ここで落とさないと一覧が残り続ける
    expect(session.getState().backgroundTerminals).toEqual([]);
    expect(session.getState().busy).toBe(false);
  });

  it('error時（起動直後のクラッシュ）にも一覧を空にする', () => {
    const { session, proc } = createStartedSession();
    session.receive(backgroundTasksLine());
    expect(session.getState().backgroundTerminals).toHaveLength(1);

    proc.emit('error', new Error('spawn failed'));

    expect(session.getState().backgroundTerminals).toEqual([]);
  });
});
