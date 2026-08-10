import { describe, expect, it } from 'vitest';
import {
  addApproval,
  applyEvent,
  initialChatState,
  normalizeItem,
  removeApproval,
  type ChatState,
} from '../../src/appserver/chatState';

const TURN = '019fd88d-723d-73f2-9100-212a63eb6069';

const feed = (state: ChatState, events: Array<[string, Record<string, unknown>]>): ChatState =>
  events.reduce((s, [method, params]) => applyEvent(s, method, params), state);

describe('normalizeItem', () => {
  it('userMessage の content からテキストを取り出す', () => {
    const item = normalizeItem({
      type: 'userMessage',
      id: 'u1',
      content: [{ type: 'text', text: 'こんにちは' }],
    });
    expect(item).toMatchObject({ id: 'u1', kind: 'userMessage', text: 'こんにちは' });
  });

  it('agentMessage の text を読む', () => {
    expect(normalizeItem({ type: 'agentMessage', id: 'a1', text: 'OK' })?.text).toBe('OK');
  });

  it('commandExecution はコマンドと終了コードを出す', () => {
    const item = normalizeItem({
      type: 'commandExecution',
      id: 'c1',
      command: 'ls -la',
      aggregatedOutput: 'total 0',
      exitCode: 0,
      status: 'completed',
    });
    expect(item).toMatchObject({ detail: 'ls -la', text: 'total 0', status: 'exit 0' });
  });

  it('fileChange は変更したパスを並べる', () => {
    const item = normalizeItem({
      type: 'fileChange',
      id: 'f1',
      changes: [{ path: '/a.ts' }, { path: '/b.ts' }],
    });
    expect(item?.detail).toBe('/a.ts, /b.ts');
  });

  it('未知の種類でも捨てずに保持する（プロトコル追加で壊れないため）', () => {
    const item = normalizeItem({ type: 'somethingNew', id: 'x1' });
    expect(item).toMatchObject({ id: 'x1', kind: 'somethingNew' });
  });

  it('idや種類が無ければundefined', () => {
    expect(normalizeItem({ type: 'agentMessage' })).toBeUndefined();
    expect(normalizeItem({ id: 'x' })).toBeUndefined();
    expect(normalizeItem(null)).toBeUndefined();
  });
});

describe('applyEvent', () => {
  it('turn/started で応答中になり、turn/completed で戻る', () => {
    const busy = applyEvent(initialChatState, 'turn/started', {});
    expect(busy.busy).toBe(true);
    expect(applyEvent(busy, 'turn/completed', {}).busy).toBe(false);
  });

  it('turn/started の turn.id を保持し、終了で手放す', () => {
    // turnIdはトップレベルではなく turn オブジェクトの中にある
    const started = applyEvent(initialChatState, 'turn/started', {
      threadId: 'th-1',
      turn: { id: 't-1', status: 'inProgress' },
    });
    expect(started.turnId).toBe('t-1');
    expect(applyEvent(started, 'turn/completed', {}).turnId).toBeUndefined();
    expect(applyEvent(started, 'turn/failed', {}).turnId).toBeUndefined();
  });

  it('turn/failed だけを失敗として残し、次のターンで消す', () => {
    const started = applyEvent(initialChatState, 'turn/started', {});
    expect(applyEvent(started, 'turn/completed', {}).turnFailed).toBe(false);

    const failed = applyEvent(started, 'turn/failed', {});
    expect(failed.turnFailed).toBe(true);
    expect(applyEvent(failed, 'turn/started', {}).turnFailed).toBe(false);
  });

  it('turnが無い turn/started でも落ちない', () => {
    expect(applyEvent(initialChatState, 'turn/started', {}).turnId).toBeUndefined();
  });

  it('item通知の turnId でも補える', () => {
    // turn/started を取り逃しても中断できるようにする
    const state = applyEvent(initialChatState, 'item/started', {
      item: { type: 'userMessage', id: 'u1', content: [] },
      turnId: 't-2',
    });
    expect(state.turnId).toBe('t-2');
  });

  it('thread/status/changed の active を反映する', () => {
    const state = applyEvent(initialChatState, 'thread/status/changed', {
      status: { type: 'active' },
    });
    expect(state.busy).toBe(true);
    expect(applyEvent(state, 'thread/status/changed', { status: { type: 'idle' } }).busy).toBe(
      false,
    );
  });

  it('item/started と item/completed で同じidを二重に積まない', () => {
    const state = feed(initialChatState, [
      ['item/started', { item: { type: 'agentMessage', id: 'a1', text: '' }, turnId: TURN }],
      ['item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'OK' }, turnId: TURN }],
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe('OK');
  });

  it('デルタを積み上げる', () => {
    const state = feed(initialChatState, [
      ['item/started', { item: { type: 'agentMessage', id: 'a1', text: '' } }],
      ['item/agentMessage/delta', { itemId: 'a1', delta: 'こん' }],
      ['item/agentMessage/delta', { itemId: 'a1', delta: 'にちは' }],
    ]);
    expect(state.items[0]?.text).toBe('こんにちは');
  });

  it('本文が空のcompletedでデルタの内容を消さない', () => {
    const state = feed(initialChatState, [
      ['item/agentMessage/delta', { itemId: 'a1', delta: '積んだ本文' }],
      ['item/completed', { item: { type: 'agentMessage', id: 'a1', text: '' } }],
    ]);
    expect(state.items[0]?.text).toBe('積んだ本文');
  });

  it('turnIdを保持し、後から空で上書きされない', () => {
    const state = feed(initialChatState, [
      ['item/started', { item: { type: 'userMessage', id: 'u1', content: [] }, turnId: TURN }],
      ['item/completed', { item: { type: 'userMessage', id: 'u1', content: [] } }],
    ]);
    expect(state.items[0]?.turnId).toBe(TURN);
  });

  it('レート制限を取り込む', () => {
    const state = feed(initialChatState, [
      ['account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 91 } } }],
    ]);
    expect(state.usage).toEqual({ usedPercent: 91 });
  });

  it('Codexが付けた名前を取り込む', () => {
    const state = applyEvent(initialChatState, 'thread/name/updated', {
      threadId: 't1',
      threadName: '設計の相談',
    });
    expect(state.name).toBe('設計の相談');
  });

  it('名前がnullや空なら未設定に戻す', () => {
    const named = applyEvent(initialChatState, 'thread/name/updated', { threadName: 'x' });
    expect(applyEvent(named, 'thread/name/updated', { threadName: null }).name).toBeUndefined();
    expect(applyEvent(named, 'thread/name/updated', { threadName: '' }).name).toBeUndefined();
  });

  it('未知の通知では状態を変えない（同一参照を返す）', () => {
    const state = applyEvent(initialChatState, 'mcpServer/startupStatus/updated', {});
    expect(state).toBe(initialChatState);
  });

  it('元の状態を破壊しない', () => {
    const next = applyEvent(initialChatState, 'turn/started', {});
    expect(initialChatState.busy).toBe(false);
    expect(next).not.toBe(initialChatState);
  });
});

describe('承認の出し入れ', () => {
  const approval = {
    requestId: 7,
    kind: 'command' as const,
    title: 'コマンドの実行を許可しますか',
    detail: 'ls',
  };

  it('追加して取り除ける', () => {
    const added = addApproval(initialChatState, approval);
    expect(added.approvals).toHaveLength(1);
    expect(removeApproval(added, 7).approvals).toEqual([]);
  });

  it('該当しないidでは何も消えない', () => {
    const added = addApproval(initialChatState, approval);
    expect(removeApproval(added, 99).approvals).toHaveLength(1);
  });
});
