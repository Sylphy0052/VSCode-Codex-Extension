import { describe, expect, it } from 'vitest';
import {
  clearQueue,
  enqueue,
  initialChatState,
  removeQueued,
  routeSend,
  takeQueued,
} from '../../src/appserver/chatState';

const busy = { ...initialChatState, busy: true };

describe('routeSend', () => {
  it('応答していなければ普通に送る', () => {
    expect(routeSend(initialChatState)).toBe('start');
  });

  it('応答中でターンが判れば割り込んで送る', () => {
    expect(routeSend({ ...busy, turnId: 'turn-1' })).toBe('steer');
  });

  it('応答中でもターンが判らなければ待ち行列へ積む', () => {
    // turn/steer は expectedTurnId を要求するため、idが無いと送れない
    expect(routeSend(busy)).toBe('queue');
  });
});

describe('enqueue', () => {
  it('末尾に積む', () => {
    const state = enqueue(enqueue(busy, '1つめ'), '2つめ');
    expect(state.queued).toEqual(['1つめ', '2つめ']);
  });

  it('空白だけの指示は積まない', () => {
    expect(enqueue(busy, '   ').queued).toEqual([]);
  });

  it('元の状態を壊さない', () => {
    const next = enqueue(busy, 'あとで');
    expect(busy.queued).toEqual([]);
    expect(next).not.toBe(busy);
  });
});

describe('takeQueued', () => {
  it('先頭を取り出し、残りを返す', () => {
    const state = enqueue(enqueue(busy, '1つめ'), '2つめ');
    const { text, next } = takeQueued(state);
    expect(text).toBe('1つめ');
    expect(next.queued).toEqual(['2つめ']);
  });

  it('空なら取り出せない', () => {
    const { text, next } = takeQueued(busy);
    expect(text).toBeUndefined();
    expect(next).toBe(busy);
  });
});

describe('removeQueued', () => {
  it('指定した位置だけ取り消す', () => {
    const state = enqueue(enqueue(enqueue(busy, 'a'), 'b'), 'c');
    expect(removeQueued(state, 1).queued).toEqual(['a', 'c']);
  });

  it('範囲外は何もしない', () => {
    const state = enqueue(busy, 'a');
    expect(removeQueued(state, 5).queued).toEqual(['a']);
    expect(removeQueued(state, -1).queued).toEqual(['a']);
  });
});

describe('clearQueue', () => {
  it('全部捨てる', () => {
    const state = enqueue(enqueue(busy, 'a'), 'b');
    expect(clearQueue(state).queued).toEqual([]);
  });
});
