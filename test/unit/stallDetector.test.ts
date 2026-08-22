import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import {
  detectStalledLoop,
  extractTurnSignature,
  pushTurnSignature,
} from '../../src/loop/stallDetector';

const state = (overrides: Partial<ChatState> = {}): ChatState => ({
  ...initialChatState,
  ...overrides,
});

const agentMessage = (text: string): ChatItem => ({
  id: 'a1',
  kind: 'agentMessage',
  text,
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
});

describe('extractTurnSignature', () => {
  it('turnResultTextがあればそれを使う', () => {
    expect(extractTurnSignature(state({ turnResultText: '完了しました' }))).toBe('完了しました');
  });

  it('turnResultTextが空なら直近の空でないagentMessageを使う', () => {
    expect(
      extractTurnSignature(
        state({ items: [agentMessage(''), agentMessage('調査中です')] }),
      ),
    ).toBe('調査中です');
  });

  it('どちらも無ければ空文字', () => {
    expect(extractTurnSignature(state())).toBe('');
  });
});

describe('pushTurnSignature', () => {
  it('しきい値を超えた古い履歴を捨てる', () => {
    const history = pushTurnSignature(['a', 'b', 'c'], 'd', 3);
    expect(history).toEqual(['b', 'c', 'd']);
  });

  it('しきい値以下ならそのまま足す', () => {
    expect(pushTurnSignature(['a'], 'b', 3)).toEqual(['a', 'b']);
  });
});

describe('detectStalledLoop', () => {
  it('直近N件が全て同一の非空文字列なら停滞と判定する', () => {
    expect(detectStalledLoop(['同じ応答', '同じ応答', '同じ応答'], 3)).toBe(true);
  });

  it('1件でも異なれば停滞ではない', () => {
    expect(detectStalledLoop(['同じ応答', '同じ応答', '違う応答'], 3)).toBe(false);
  });

  it('履歴がしきい値未満なら判定しない', () => {
    expect(detectStalledLoop(['同じ応答', '同じ応答'], 3)).toBe(false);
  });

  it('空文字の反復は停滞と判定しない（まだ応答が無いだけの状態を誤検知しない）', () => {
    expect(detectStalledLoop(['', '', ''], 3)).toBe(false);
  });

  it('履歴がしきい値より長くても直近N件だけを見る', () => {
    expect(detectStalledLoop(['違う', '同じ応答', '同じ応答', '同じ応答'], 3)).toBe(true);
  });
});
