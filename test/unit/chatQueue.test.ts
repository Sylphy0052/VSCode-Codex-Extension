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

  it('レビュー中はターンが判っても割り込まず待ち行列へ積む', () => {
    // app-serverはレビュー中のターンへの turn/steer を受け付けない（スキーマ根拠）
    expect(routeSend({ ...busy, turnId: 'turn-1', reviewing: true })).toBe('queue');
  });
});

describe('enqueue', () => {
  it('末尾に積む', () => {
    const state = enqueue(enqueue(busy, '1つめ'), '2つめ');
    expect(state.queued.map((q) => q.text)).toEqual(['1つめ', '2つめ']);
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
    const { message, next } = takeQueued(state);
    expect(message?.text).toBe('1つめ');
    expect(next.queued.map((q) => q.text)).toEqual(['2つめ']);
  });

  it('空なら取り出せない', () => {
    const { message, next } = takeQueued(busy);
    expect(message).toBeUndefined();
    expect(next).toBe(busy);
  });
});

describe('removeQueued', () => {
  it('指定した位置だけ取り消す', () => {
    const state = enqueue(enqueue(enqueue(busy, 'a'), 'b'), 'c');
    expect(removeQueued(state, 1).queued.map((q) => q.text)).toEqual(['a', 'c']);
  });

  it('範囲外は何もしない', () => {
    const state = enqueue(busy, 'a');
    expect(removeQueued(state, 5).queued.map((q) => q.text)).toEqual(['a']);
    expect(removeQueued(state, -1).queued.map((q) => q.text)).toEqual(['a']);
  });
});

describe('clearQueue', () => {
  it('全部捨てる', () => {
    const state = enqueue(enqueue(busy, 'a'), 'b');
    expect(clearQueue(state).queued).toEqual([]);
  });
});

describe('待ち行列と添付画像', () => {
  const image = {
    id: 'a1',
    name: 'shot.png',
    mediaType: 'image/png',
    data: 'QUJD',
    bytes: 3,
  };

  it('添えた画像も一緒に積む', () => {
    // テキストだけ積むと、応答中に貼った画像が黙って消える
    const state = enqueue(busy, 'これ直して', [image]);
    expect(state.queued[0]?.attachments).toEqual([image]);
  });

  it('本文が空でも画像があれば積む', () => {
    expect(enqueue(busy, '   ', [image]).queued).toHaveLength(1);
  });

  it('本文も画像も無ければ積まない', () => {
    expect(enqueue(busy, '   ', []).queued).toEqual([]);
  });

  it('取り出すと画像も付いてくる', () => {
    const state = enqueue(busy, 'これ直して', [image]);
    expect(takeQueued(state).message?.attachments).toEqual([image]);
  });
});
