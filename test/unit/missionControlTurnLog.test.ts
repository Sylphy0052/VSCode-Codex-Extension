import { describe, expect, it } from 'vitest';
import type { McTurn } from '../../src/webview/missionControl/protocol';
import {
  findTurnMatches,
  groupMatchesByTurn,
  hasOlderTurns,
  logFromPage,
  mergeTurnPage,
  segmentField,
  stepMatch,
} from '../../src/webview/missionControl/turnLog';

/** Mission Controlの詳細ペインの会話ログ（Issue #2157）。 */

function turns(from: number, to: number, suffix = ''): McTurn[] {
  return Array.from({ length: to - from }, (_, i) => ({
    role: 'user' as const,
    text: `t${from + i}${suffix}`,
    truncated: false,
  }));
}

describe('mergeTurnPage', () => {
  it('古い範囲を先頭へ継ぎ足して先頭まで遡れる', () => {
    let log = logFromPage({ turns: turns(80, 130), start: 80, total: 130 });
    expect(hasOlderTurns(log)).toBe(true);
    log = mergeTurnPage(log, { turns: turns(30, 80), start: 30, total: 130 });
    log = mergeTurnPage(log, { turns: turns(0, 30), start: 0, total: 130 });
    expect(log.start).toBe(0);
    expect(hasOlderTurns(log)).toBe(false);
    expect(log.turns.map((t) => t.text)).toEqual(turns(0, 130).map((t) => t.text));
  });

  it('ライブtailは末尾の範囲だけを差し替え、読み足した古い分を残す', () => {
    let log = logFromPage({ turns: turns(0, 50), start: 0, total: 50 });
    // 末尾の1件が伸び、1件増えた
    log = mergeTurnPage(log, { turns: turns(45, 51, '+'), start: 45, total: 51 });
    expect(log.turns).toHaveLength(51);
    expect(log.turns[44]?.text).toBe('t44');
    expect(log.turns[45]?.text).toBe('t45+');
    expect(log.total).toBe(51);
  });

  it('範囲が離れている・範囲が無い応答では届いた分だけにする', () => {
    const log = logFromPage({ turns: turns(0, 10), start: 0, total: 10 });
    const apart = mergeTurnPage(log, { turns: turns(40, 46), start: 40, total: 46 });
    expect(apart.start).toBe(40);
    expect(apart.turns).toHaveLength(6);
    // 遅れて届いた古い範囲（読み込み済みより前で離れている）は捨て、末尾を残す
    const late = mergeTurnPage(apart, { turns: turns(0, 30), start: 0, total: 40 });
    expect(late).toBe(apart);
    const legacy = mergeTurnPage(log, { turns: turns(0, 3) });
    expect(legacy.start).toBeUndefined();
    expect(hasOlderTurns(legacy)).toBe(false);
  });

  it('壊れた範囲（件数が全体を超える）は範囲なしとして扱う', () => {
    const log = logFromPage({ turns: turns(0, 5), start: 3, total: 4 });
    expect(log.start).toBeUndefined();
  });

  it('取り寄せ中の印と失敗の理由を引き継ぐ', () => {
    const log = {
      ...logFromPage({ turns: turns(10, 20), start: 10, total: 20 }),
      olderLoading: true,
    };
    const merged = mergeTurnPage(log, { turns: turns(15, 21), start: 15, total: 21 });
    expect(merged.olderLoading).toBe(true);
  });
});

describe('会話内の検索', () => {
  const log: McTurn[] = [
    { role: 'user', text: 'Hello hello', truncated: false },
    { role: 'tool', text: 'no match', title: '$ echo HELLO', truncated: false },
    { role: 'agent', text: 'bye', truncated: false },
  ];

  it('大文字・小文字を区別せず、見出し → 本文の順で数える', () => {
    const matches = findTurnMatches(log, ' hello ');
    expect(matches).toEqual([
      { turn: 0, field: 'text', from: 0, to: 5 },
      { turn: 0, field: 'text', from: 6, to: 11 },
      { turn: 1, field: 'title', from: 7, to: 12 },
    ]);
    expect(findTurnMatches(log, '   ')).toEqual([]);
  });

  it('一致の印付きの断片に分ける', () => {
    const matches = findTurnMatches(log, 'hello');
    const byTurn = groupMatchesByTurn(matches);
    expect(segmentField('Hello hello', byTurn.get(0) ?? [], 'text')).toEqual([
      { text: 'Hello', match: 0 },
      { text: ' ' },
      { text: 'hello', match: 1 },
    ]);
    expect(segmentField('$ echo HELLO', byTurn.get(1) ?? [], 'title')).toEqual([
      { text: '$ echo ' },
      { text: 'HELLO', match: 2 },
    ]);
    expect(segmentField('bye', byTurn.get(2) ?? [], 'text')).toEqual([{ text: 'bye' }]);
  });

  it('一致の移動は端で反対側へ回る', () => {
    expect(stepMatch(undefined, 3, 1)).toBe(0);
    expect(stepMatch(undefined, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBeUndefined();
  });
});
