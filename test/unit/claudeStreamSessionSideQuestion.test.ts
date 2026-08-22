import { describe, expect, it } from 'vitest';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';
import type { ControlRequestProgress } from '../../src/claude/control';

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
 * `claudeStreamSessionRewind.test.ts` と同じ方針。`start()` は実プロセスを起動するため、
 * `proc` に書き込みを記録するだけのフェイクを直接差し込む。
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

function progressLine(requestId: string, fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: 'system',
    subtype: 'control_request_progress',
    request_id: requestId,
    ...fields,
  })}\n`;
}

describe('ClaudeStreamSession の脇道の質問（side_question。issue #334、design.md §14.62）', () => {
  it('askSideQuestion は side_question を書き込む（history省略時）', () => {
    const { session, written } = createSessionWithFakeProc();
    void session.askSideQuestion('今何時？', []);

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'side_question', question: '今何時？' },
    });
  });

  it('history を渡すとそのまま乗せて送る', () => {
    const { session, written } = createSessionWithFakeProc();
    void session.askSideQuestion('続きは？', [
      { question: '前の質問', response: '前の応答', fallbackNotice: undefined },
    ]);

    expect(JSON.parse(written[0]!.trim())).toMatchObject({
      request: {
        subtype: 'side_question',
        question: '続きは？',
        history: [{ question: '前の質問', response: '前の応答' }],
      },
    });
  });

  it('応答が届くと readSideQuestionResult 相当の形で解決する', async () => {
    const { session, written } = createSessionWithFakeProc();
    const promise = session.askSideQuestion('今何時？', []);
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(controlResponseLine(requestId, { response: '午後3時です', synthetic: false }));

    await expect(promise).resolves.toEqual({
      ok: true,
      response: '午後3時です',
      synthetic: false,
      refusalFallback: undefined,
      error: undefined,
    });
  });

  it('走行中のターンがあっても（busyでも）送れる（実測: side_questionに走行チェックは無い）', async () => {
    const { session, written } = createSessionWithFakeProc();
    // ターン走行中を模す（applyStreamEventを経由せず、テストの都合で直接立てる）
    (session as unknown as { state: { busy: boolean } }).state.busy = true;

    const promise = session.askSideQuestion('今何時？', []);
    expect(written).toHaveLength(1);

    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;
    session.receive(controlResponseLine(requestId, { response: '午後3時です', synthetic: false }));
    await expect(promise).resolves.toMatchObject({ ok: true, response: '午後3時です' });
  });

  it('control_request_progress は対応する要求の onProgress へだけ届く', () => {
    const { session, written } = createSessionWithFakeProc();
    const progressEvents: ControlRequestProgress[] = [];
    void session.askSideQuestion('質問1', [], (p) => progressEvents.push(p));
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(progressLine(requestId, { status: 'started' }));
    session.receive(
      progressLine(requestId, {
        status: 'api_retry',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 2000,
        error_status: 'overloaded',
      }),
    );
    // 別の要求idの進捗は届かない
    session.receive(progressLine('req_other', { status: 'api_retry' }));

    expect(progressEvents).toEqual([
      {
        requestId,
        status: 'started',
        attempt: undefined,
        maxRetries: undefined,
        retryDelayMs: undefined,
        errorStatus: undefined,
      },
      {
        requestId,
        status: 'api_retry',
        attempt: 1,
        maxRetries: 3,
        retryDelayMs: 2000,
        errorStatus: 'overloaded',
      },
    ]);
  });

  it('control protocol自体が失敗した場合はokがfalseになる（成功と誤判定しない）', async () => {
    const { session, written } = createSessionWithFakeProc();
    const promise = session.askSideQuestion('質問', []);
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(controlErrorLine(requestId, 'Unsupported control request subtype'));

    await expect(promise).resolves.toEqual({
      ok: false,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: 'Unsupported control request subtype',
    });
  });

  it('空文字・空白のみのquestionは送らず即座に失敗を返す（レビュー指摘: CLIは検証しない）', async () => {
    const { session, written } = createSessionWithFakeProc();

    const empty = await session.askSideQuestion('', []);
    const blank = await session.askSideQuestion('   ', []);

    expect(written).toHaveLength(0);
    expect(empty).toEqual({
      ok: false,
      response: undefined,
      synthetic: undefined,
      refusalFallback: undefined,
      error: '質問が空です',
    });
    expect(blank.ok).toBe(false);
  });

  it('セッションが起動していない場合は要求を送らず即座に失敗を返す', async () => {
    const session = new ClaudeStreamSession(
      () => 'claude',
      fakeLogger,
      () => undefined,
    );
    const result = await session.askSideQuestion('質問', []);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('セッションが起動していません');
  });

  it('複数の要求を並行して出しても取り違えない（requestIdで対応付ける）', async () => {
    const { session, written } = createSessionWithFakeProc();
    const first = session.askSideQuestion('質問1', []);
    const second = session.askSideQuestion('質問2', []);
    expect(written).toHaveLength(2);

    const firstId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;
    const secondId = (JSON.parse(written[1]!.trim()) as { request_id: string }).request_id;

    session.receive(controlResponseLine(secondId, { response: '2番目の応答', synthetic: false }));
    session.receive(controlResponseLine(firstId, { response: '1番目の応答', synthetic: false }));

    await expect(first).resolves.toMatchObject({ response: '1番目の応答' });
    await expect(second).resolves.toMatchObject({ response: '2番目の応答' });
  });
});
