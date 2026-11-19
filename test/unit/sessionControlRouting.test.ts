import { describe, expect, it } from 'vitest';
import type { SessionControlAction } from '../../src/view/chatManagerBase';
import { LONG_REPLY_TIMEOUT_MS } from '../../src/view/sessionHub';
import { toSessionControlAction } from '../../src/view/sessionControlMessage';
import {
  fromRemoteReply,
  remoteReplyTimeoutMs,
  routeSessionControl,
  toRemoteControlInput,
} from '../../src/view/sessionControlRouting';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const selfTarget = { windowId: SELF, provider: 'claude', threadId: 't1' } as const;
const otherTarget = { windowId: OTHER, provider: 'codex', threadId: 't2' } as const;

describe('routeSessionControl', () => {
  it('このウィンドウ宛ての操作はこのウィンドウで行う', () => {
    expect(routeSessionControl(selfTarget, { kind: 'rename', name: 'x' }, SELF)).toBe('local');
    expect(routeSessionControl(selfTarget, { kind: 'handoff' }, SELF)).toBe('local');
  });

  it('別ウィンドウ宛てのrename・fork・clear・引き継ぎ・巻き戻しは宛先へ回す', () => {
    const actions: SessionControlAction[] = [
      { kind: 'rename', name: 'x' },
      { kind: 'fork' },
      { kind: 'clear' },
      { kind: 'handoff' },
      { kind: 'rewindPreview', messageId: 'm1' },
      { kind: 'rewind', messageId: 'm1' },
    ];
    for (const action of actions) {
      expect(routeSessionControl(otherTarget, action, SELF)).toBe('remote');
    }
  });

  it('ピン留めは宛先が別ウィンドウでも要求元で行う', () => {
    expect(routeSessionControl(otherTarget, { kind: 'pin' }, SELF)).toBe('local');
    expect(routeSessionControl(otherTarget, { kind: 'unpin' }, SELF)).toBe('local');
    expect(routeSessionControl(selfTarget, { kind: 'pin' }, SELF)).toBe('local');
  });

  it('task runの質問への回答は、このウィンドウ宛てなら会話の操作を通さない', () => {
    const action = { kind: 'answerTaskRunQuestion', pendingId: 'p1', text: 'a' } as const;
    expect(routeSessionControl(selfTarget, action, SELF)).toBe('taskRunQuestion');
    expect(routeSessionControl(otherTarget, action, SELF)).toBe('remote');
  });
});

describe('toRemoteControlInput', () => {
  it('操作の種類に合う欄だけ埋める', () => {
    const input = toRemoteControlInput(otherTarget, { kind: 'rename', name: '新しい名前' });
    expect(input.kind).toBe('rename');
    expect(input.provider).toBe('codex');
    expect(input.threadId).toBe('t2');
    expect(input.name).toBe('新しい名前');
    const filled = Object.entries(input).filter(([, value]) => value !== undefined);
    expect(filled.map(([key]) => key).sort()).toEqual(['kind', 'name', 'provider', 'threadId']);
  });

  it.each<SessionControlAction>([
    { kind: 'rename', name: '新しい名前' },
    { kind: 'fork' },
    { kind: 'clear' },
    { kind: 'handoff' },
    { kind: 'rewindPreview', messageId: 'm1' },
    { kind: 'rewind', messageId: 'm1' },
    { kind: 'send', text: 'hello' },
    { kind: 'cancelQueued', index: 2, queuedId: 'q1' },
    { kind: 'changeSetting', change: { setting: 'planMode', value: true } },
    { kind: 'recentTurns', limit: 5, before: 10 },
  ])('宛先のウィンドウで同じ操作に戻る（$kind）', (action) => {
    expect(toSessionControlAction(toRemoteControlInput(otherTarget, action))).toEqual(action);
  });
});

describe('remoteReplyTimeoutMs', () => {
  it('名前の保存・分岐・作り直し・巻き戻しは長く待つ', () => {
    for (const kind of ['rename', 'fork', 'clear', 'rewindPreview', 'rewind'] as const) {
      expect(remoteReplyTimeoutMs(kind)).toBe(LONG_REPLY_TIMEOUT_MS);
    }
  });

  it('引き継ぎの開始と表示の取り寄せは既定の上限で待つ', () => {
    expect(remoteReplyTimeoutMs('handoff')).toBeUndefined();
    expect(remoteReplyTimeoutMs('recentTurns')).toBeUndefined();
  });
});

describe('fromRemoteReply', () => {
  it('応答の成否と中身を結果へ移す', () => {
    const result = fromRemoteReply({
      requestId: 'r1',
      ok: true,
      payload: { rewindFiles: { files: [] } } as never,
    });
    expect(result.ok).toBe(true);
    expect(result.rewindFiles).toEqual({ files: [] });
  });

  it('失敗の理由を残す', () => {
    const result = fromRemoteReply({ requestId: 'r1', ok: false, error: '宛先が応答しません' });
    expect(result).toMatchObject({ ok: false, error: '宛先が応答しません' });
    expect(result.turns).toBeUndefined();
  });
});
