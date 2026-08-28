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

function canUseToolLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
  })}\n`;
}

describe('ClaudeStreamSession: exit/errorハンドラからの応答待ち解放（issue #355）', () => {
  it('exit時にrewindWaitingの待ち元が解決される（放置すると永久ハング）', async () => {
    const { session, proc } = createStartedSession();

    const pending = session.previewRewindFiles('msg-1');
    proc.emit('exit', 1);

    await expect(pending).resolves.toEqual({
      ok: false,
      filesChanged: [],
      insertions: undefined,
      deletions: undefined,
      error: 'セッションが終了しました',
    });
  });

  it('exit時にmcpStatusWaitingの待ち元が解決される', async () => {
    const { session, proc } = createStartedSession();

    const pending = session.checkMcpStatus();
    proc.emit('exit', 1);

    await expect(pending).resolves.toBeUndefined();
  });

  it('exit時にskillsWaitingの待ち元が解決される', async () => {
    const { session, proc } = createStartedSession();

    const pending = session.reloadSkills();
    proc.emit('exit', 1);

    await expect(pending).resolves.toBeUndefined();
  });

  it('exit時に承認待ち（waiting）が解放され、承認カードが消える', async () => {
    const { session, proc } = createStartedSession();
    session.receive(canUseToolLine('ask-1'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getState().approvals).toHaveLength(1);

    proc.emit('exit', 1);

    expect(session.getState().approvals).toHaveLength(0);
  });

  it('error時（起動直後のクラッシュ）にもrewindWaitingが解放される', async () => {
    const { session, proc } = createStartedSession();

    const pending = session.previewRewindFiles('msg-1');
    proc.emit('error', new Error('spawn failed'));

    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it('start()の再呼び出し前に、前回分の応答待ちがMapに積み上がらず解決される', async () => {
    // クラッシュしたがexit/errorが届く前に（何らかの理由で）同一インスタンスへ
    // 再度start()が呼ばれるケースを模す。プロセスは呼ぶたびに新しいものを返す
    // （実際の`spawn()`と同じ）。releasePendingWaiters()がstart()の冒頭で呼ばれるため、
    // 前回分の応答待ちはここで解決され、Mapへ積み上がらない
    const spawnProcess: ClaudeSpawnPort = () => createFakeChildProcess().proc;
    const session = new ClaudeStreamSession(
      () => 'claude',
      fakeLogger,
      () => undefined,
      () => undefined,
      () => undefined,
      undefined,
      spawnProcess,
    );
    const startOptions = {
      cwd: '/w',
      target: { kind: 'new' as const },
      sessionId: '11111111-1111-1111-1111-111111111111',
      config: emptyClaudeConfig,
    };
    session.start(startOptions);

    const pending = session.previewRewindFiles('msg-1');

    session.start({ ...startOptions, sessionId: '22222222-2222-2222-2222-222222222222' });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: 'セッションが終了しました',
    });
  });
});

describe('ClaudeStreamSession: ターンの結果が確定した回数（issue #939）', () => {
  /** そのターンの結果を返す `result` イベント。 */
  const resultLine = (text: string): string =>
    `${JSON.stringify({ type: 'result', subtype: 'success', result: text })}\n`;

  it('走行中のターンがある間にプロセスが落ちれば、失敗として確定させる', () => {
    const { session, proc } = createStartedSession();
    session.send('直して');
    const before = session.getState().turnCompletionSeq;

    proc.emit('exit', 1);

    const state = session.getState();
    expect(state.turnFailed).toBe(true);
    expect(state.turnCompletionSeq).toBe(before + 1);
  });

  it('resultを受け取った後にプロセスが落ちても、確定を重ねない', () => {
    const { session, proc } = createStartedSession();
    session.send('直して');
    session.receive(resultLine('直しました'));
    const before = session.getState().turnCompletionSeq;
    expect(session.getState().busy).toBe(false);

    proc.emit('exit', 1);

    // `result` で既に確定している。無かった完了をもう1つ作らない
    expect(session.getState().turnCompletionSeq).toBe(before);
  });

  it('1ターンも送らないまま起動に失敗しても、確定を作らない', () => {
    const { session, proc } = createStartedSession();
    const before = session.getState().turnCompletionSeq;

    proc.emit('error', new Error('spawn ENOENT'));

    expect(session.getState().turnCompletionSeq).toBe(before);
  });

  it('走行中の中断は確定させ、応答中でない中断は確定させない', () => {
    const { session } = createStartedSession();
    session.send('直して');
    const before = session.getState().turnCompletionSeq;

    session.interrupt();
    expect(session.getState().turnCompletionSeq).toBe(before + 1);

    // 応答が終わっている状態でもう一度押されても、無かった完了を作らない
    session.interrupt();
    expect(session.getState().turnCompletionSeq).toBe(before + 1);
  });
});
