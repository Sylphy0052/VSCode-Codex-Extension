import { describe, expect, it } from 'vitest';
import {
  buildRewindSequence,
  describeForkFromTurnError,
  forkFromTurn,
  type SendRewindConversation,
} from '../../src/claude/forkFromTurn';
import type { RewindConversationResult } from '../../src/claude/control';

function success(uuid: string, prefillText = ''): RewindConversationResult {
  return {
    rewound: true,
    targetMessageUuid: uuid,
    prefillText,
    precedingAssistantUuid: 'assistant-uuid',
    error: undefined,
  };
}

function failure(error: string): RewindConversationResult {
  return {
    rewound: false,
    targetMessageUuid: undefined,
    prefillText: undefined,
    precedingAssistantUuid: undefined,
    error,
  };
}

describe('buildRewindSequence（issue #333、design.md §14.61）', () => {
  it('対象以降（対象を含む）を新しい順に並べる', () => {
    const uuids = ['u1', 'u2', 'u3', 'u4'];
    expect(buildRewindSequence(uuids, 'u2')).toEqual(['u4', 'u3', 'u2']);
  });

  it('対象が最後の発言なら1件だけになる', () => {
    const uuids = ['u1', 'u2', 'u3'];
    expect(buildRewindSequence(uuids, 'u3')).toEqual(['u3']);
  });

  it('対象が最初の発言なら全件が対象になる', () => {
    const uuids = ['u1', 'u2', 'u3'];
    expect(buildRewindSequence(uuids, 'u1')).toEqual(['u3', 'u2', 'u1']);
  });

  it('対象が一覧に無ければ空配列を返す', () => {
    expect(buildRewindSequence(['u1', 'u2'], 'missing')).toEqual([]);
  });

  it('一覧が空でも例外にならない', () => {
    expect(buildRewindSequence([], 'u1')).toEqual([]);
  });
});

describe('forkFromTurn（issue #333、design.md §14.61）', () => {
  it('逐次送信が新しい順（想定順）で呼ばれる', async () => {
    const uuids = ['u1', 'u2', 'u3'];
    const calls: string[] = [];
    const sendRewind: SendRewindConversation = async (uuid) => {
      calls.push(uuid);
      return success(uuid);
    };

    const result = await forkFromTurn(uuids, 'u1', sendRewind);

    expect(calls).toEqual(['u3', 'u2', 'u1']);
    expect(result.ok).toBe(true);
  });

  it('前の応答を待ってから次を送る（並列に投げない）', async () => {
    const uuids = ['u1', 'u2'];
    let inFlight = 0;
    let sawOverlap = false;
    const sendRewind: SendRewindConversation = async (uuid) => {
      inFlight++;
      if (inFlight > 1) sawOverlap = true;
      await Promise.resolve();
      inFlight--;
      return success(uuid);
    };

    await forkFromTurn(uuids, 'u1', sendRewind);

    expect(sawOverlap).toBe(false);
  });

  it('対象自身まで戻せると、その応答の prefillText を返す', async () => {
    const uuids = ['u1', 'u2', 'u3'];
    const sendRewind: SendRewindConversation = async (uuid) =>
      success(uuid, uuid === 'u1' ? '最初の発言の本文' : '');

    const result = await forkFromTurn(uuids, 'u1', sendRewind);

    expect(result).toEqual({
      ok: true,
      prefillText: '最初の発言の本文',
      error: undefined,
      succeededCount: 3,
    });
  });

  it('途中で rewound:false が返ったら即座に打ち切り、それ以降は送らない。成功件数も返す（issue #494のレビュー指摘）', async () => {
    const uuids = ['u1', 'u2', 'u3'];
    const calls: string[] = [];
    const sendRewind: SendRewindConversation = async (uuid) => {
      calls.push(uuid);
      if (uuid === 'u2') return failure('stale target');
      return success(uuid);
    };

    const result = await forkFromTurn(uuids, 'u1', sendRewind);

    // u3（1件目）は成功、u2（2件目）で失敗。u1（3件目）へは進まない
    expect(calls).toEqual(['u3', 'u2']);
    expect(result).toEqual({
      ok: false,
      prefillText: undefined,
      error: 'stale target',
      // u3の1件だけ成功済み。呼び出し側（claudeChatView.ts）はこれを見て
      // 「途中まで戻ってから失敗した」と判定する
      succeededCount: 1,
    });
  });

  it('1件も成功せずに失敗すると succeededCount:0 を返す（issue #494のレビュー指摘）', async () => {
    const uuids = ['u1', 'u2'];
    const sendRewind: SendRewindConversation = async () => failure('turn running');

    const result = await forkFromTurn(uuids, 'u1', sendRewind);

    expect(result).toEqual({
      ok: false,
      prefillText: undefined,
      error: 'turn running',
      succeededCount: 0,
    });
  });

  it('ok:trueだけの封筒（rewoundを持たない不正な応答）は失敗として扱う', async () => {
    // readRewindConversationResultを経由しない直呼び出しのテストのため、
    // rewound以外を信じていないことをここでも確かめる（'ok'だけでの誤判定防止）
    const uuids = ['u1'];
    const sendRewind: SendRewindConversation = async () =>
      ({
        rewound: false,
        targetMessageUuid: undefined,
        prefillText: '本来は無視されるべき値',
        precedingAssistantUuid: undefined,
        error: undefined,
      }) as RewindConversationResult;

    const result = await forkFromTurn(uuids, 'u1', sendRewind);

    expect(result.ok).toBe(false);
    expect(result.prefillText).toBeUndefined();
  });

  it('対象が一覧に無ければ何も送らずエラーを返す', async () => {
    const calls: string[] = [];
    const sendRewind: SendRewindConversation = async (uuid) => {
      calls.push(uuid);
      return success(uuid);
    };

    const result = await forkFromTurn(['u1', 'u2'], 'missing', sendRewind);

    expect(calls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.succeededCount).toBe(0);
  });
});

describe('describeForkFromTurnError（issue #494のレビュー指摘、vscode非依存の層でCLIの生文言を日本語へマッピングする）', () => {
  it.each([
    'turn running',
    'commands queued',
    'target not found',
    'stale target',
    'no preceding assistant',
    'failed to persist rewind anchor',
    'state changed',
  ])('既知のCLIエラー値 %s は日本語の説明を返し、生の英語文言を含まない', (error) => {
    const message = describeForkFromTurnError(error);
    expect(message).not.toBe(error);
    expect(message.length).toBeGreaterThan(0);
    // 英字だけの生文言（'turn running'等）がそのまま漏れていないことを確かめる
    expect(message).not.toMatch(/^[a-z ]+$/);
  });

  it('forkFromTurn自身が返す非CLI由来のエラー（既に日本語）はそのまま通す', () => {
    expect(describeForkFromTurnError('対象の発言が見つかりません')).toBe(
      '対象の発言が見つかりません',
    );
  });

  it('未知のエラー値は汎用文言へ丸める（CLIの内部文言をそのまま露出しない）', () => {
    const message = describeForkFromTurnError('some future internal reason from the CLI');
    expect(message).not.toContain('some future internal reason');
    expect(message.length).toBeGreaterThan(0);
  });

  it('undefinedも汎用文言へ丸める', () => {
    const message = describeForkFromTurnError(undefined);
    expect(message.length).toBeGreaterThan(0);
  });

  it('同じ既知の値は常に同じ文言を返す（安定した表示）', () => {
    expect(describeForkFromTurnError('stale target')).toBe(
      describeForkFromTurnError('stale target'),
    );
  });
});
