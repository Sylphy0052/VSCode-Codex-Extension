import { describe, expect, it } from 'vitest';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

interface FakeProc {
  killed: boolean;
  stdin: { write: (line: string) => void; destroyed: boolean; writable: boolean };
}

/**
 * `start()` は実プロセスを起動するため、ここでは `proc` に書き込みを記録するだけの
 * フェイクを直接差し込む（`claudeStreamSessionApproval.test.ts` と同じ方針。
 * `proc` はTSの `private` で実行時には保護されないため、テストからは越えられる）。
 *
 * `killed` / `stdin.destroyed` / `stdin.writable` は`write()`が書き込み前に見る生存判定
 * （issue #155、`src/process/stdinSafety.ts`）が通るよう「生きているプロセス」を模す。
 */
function createSessionWithFakeProc(): {
  session: ClaudeStreamSession;
  written: string[];
} {
  const written: string[] = [];
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
  );
  const fakeProc: FakeProc = {
    killed: false,
    stdin: { write: (line) => written.push(line), destroyed: false, writable: true },
  };
  (session as unknown as { proc: FakeProc }).proc = fakeProc;
  return { session, written };
}

function controlResponseLine(requestId: string, response: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`;
}

function controlErrorLine(requestId: string, error: string): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  })}\n`;
}

describe('ClaudeStreamSession のファイル巻き戻し（rewind_files）', () => {
  it('previewRewindFiles は user_message_id と dry_run:true を書き込む', () => {
    const { session, written } = createSessionWithFakeProc();
    void session.previewRewindFiles('msg-1');

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'rewind_files', user_message_id: 'msg-1', dry_run: true },
    });
  });

  it('applyRewindFiles は dry_run:false で書き込む', () => {
    const { session, written } = createSessionWithFakeProc();
    void session.applyRewindFiles('msg-1');

    expect(JSON.parse(written[0]!.trim())).toMatchObject({
      request: { subtype: 'rewind_files', user_message_id: 'msg-1', dry_run: false },
    });
  });

  it('応答が届くとプレビューの結果で解決する', async () => {
    const { session, written } = createSessionWithFakeProc();
    const promise = session.previewRewindFiles('msg-1');
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(
      controlResponseLine(requestId, {
        canRewind: true,
        filesChanged: ['/w/a.txt'],
        insertions: 0,
        deletions: 1,
      }),
    );

    await expect(promise).resolves.toEqual({
      ok: true,
      filesChanged: ['/w/a.txt'],
      insertions: 0,
      deletions: 1,
      error: undefined,
    });
  });

  it('チェックポイントが無い場合はエラーとして解決する', async () => {
    const { session, written } = createSessionWithFakeProc();
    const promise = session.applyRewindFiles('msg-1');
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(controlErrorLine(requestId, 'No file checkpoint found for this message.'));

    await expect(promise).resolves.toEqual({
      ok: false,
      filesChanged: [],
      insertions: undefined,
      deletions: undefined,
      error: 'No file checkpoint found for this message.',
    });
  });

  it('セッションが起動していない場合は要求を送らず即座に失敗を返す', async () => {
    const session = new ClaudeStreamSession(
      () => 'claude',
      fakeLogger,
      () => undefined,
    );
    const result = await session.previewRewindFiles('msg-1');
    expect(result.ok).toBe(false);
  });

  it('複数の要求を並行して出しても取り違えない（requestIdで対応付ける）', async () => {
    const { session, written } = createSessionWithFakeProc();
    const first = session.previewRewindFiles('msg-1');
    const second = session.previewRewindFiles('msg-2');
    expect(written).toHaveLength(2);

    const firstId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;
    const secondId = (JSON.parse(written[1]!.trim()) as { request_id: string }).request_id;

    // 後から出した要求の応答を先に返す
    session.receive(
      controlResponseLine(secondId, { canRewind: true, filesChanged: ['/w/b.txt'] }),
    );
    session.receive(
      controlResponseLine(firstId, { canRewind: true, filesChanged: ['/w/a.txt'] }),
    );

    await expect(first).resolves.toMatchObject({ filesChanged: ['/w/a.txt'] });
    await expect(second).resolves.toMatchObject({ filesChanged: ['/w/b.txt'] });
  });
});
