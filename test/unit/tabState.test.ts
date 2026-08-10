import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_ORDER,
  assignPositions,
  collectTerminalTabPositions,
  normalizePersistedTabs,
  sortForRestore,
  type PersistedTab,
  type TabGroupLike,
} from '../../src/state/tabState';

const ID_A = '019fd79f-1e16-7b60-b9d2-0324b275ed81';
const ID_B = '019fd7a6-d25e-7bd2-b181-751e467277f3';

const term = (label: string) => ({ label, isTerminal: true });
const file = (label: string) => ({ label, isTerminal: false });

describe('collectTerminalTabPositions', () => {
  it('列の左から順に、ターミナルタブだけを集める', () => {
    const groups: TabGroupLike[] = [
      { viewColumn: 2, tabs: [term('Codex: B')] },
      { viewColumn: 1, tabs: [file('a.ts'), term('Codex: A')] },
    ];
    expect(collectTerminalTabPositions(groups)).toEqual([
      { label: 'Codex: A', viewColumn: 1, order: 1 },
      { label: 'Codex: B', viewColumn: 2, order: 0 },
    ]);
  });

  it('orderはグループ内の実際の位置（ファイルタブ込み）', () => {
    const groups: TabGroupLike[] = [
      { viewColumn: 1, tabs: [file('a.ts'), file('b.ts'), term('Codex: A')] },
    ];
    expect(collectTerminalTabPositions(groups)[0]?.order).toBe(2);
  });

  it('ターミナルが無ければ空', () => {
    expect(collectTerminalTabPositions([{ viewColumn: 1, tabs: [file('a.ts')] }])).toEqual([]);
  });
});

describe('assignPositions', () => {
  const positions = [
    { label: 'Codex: A', viewColumn: 1, order: 0 },
    { label: 'Codex: B', viewColumn: 2, order: 3 },
  ];

  it('名前で位置を割り当てる', () => {
    expect(assignPositions(['Codex: B', 'Codex: A'], positions)).toEqual([
      { viewColumn: 2, order: 3 },
      { viewColumn: 1, order: 0 },
    ]);
  });

  it('同名タブは見つかった順に1つずつ消費する', () => {
    const dup = [
      { label: 'Codex', viewColumn: 1, order: 0 },
      { label: 'Codex', viewColumn: 1, order: 1 },
    ];
    expect(assignPositions(['Codex', 'Codex'], dup)).toEqual([
      { viewColumn: 1, order: 0 },
      { viewColumn: 1, order: 1 },
    ]);
  });

  it('見つからない名前は末尾送りにする', () => {
    expect(assignPositions(['Codex: X'], positions)).toEqual([
      { viewColumn: 1, order: UNKNOWN_ORDER },
    ]);
  });
});

describe('sortForRestore', () => {
  it('列の順、次に列内の並び順で開く', () => {
    const tabs: PersistedTab[] = [
      {
        sessionId: 'c',
        provider: 'codex',
        viewColumn: 2,
        order: 0,
        cwd: undefined,
        threadName: undefined,
      },
      {
        sessionId: 'b',
        provider: 'codex',
        viewColumn: 1,
        order: 5,
        cwd: undefined,
        threadName: undefined,
      },
      {
        sessionId: 'a',
        provider: 'claude',
        viewColumn: 1,
        order: 1,
        cwd: undefined,
        threadName: undefined,
      },
    ];
    expect(sortForRestore(tabs).map((t) => t.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('元の配列を壊さない', () => {
    const tabs: PersistedTab[] = [
      {
        sessionId: 'b',
        provider: 'codex',
        viewColumn: 2,
        order: 0,
        cwd: undefined,
        threadName: undefined,
      },
      {
        sessionId: 'a',
        provider: 'codex',
        viewColumn: 1,
        order: 0,
        cwd: undefined,
        threadName: undefined,
      },
    ];
    sortForRestore(tabs);
    expect(tabs[0]?.sessionId).toBe('b');
  });
});

describe('normalizePersistedTabs', () => {
  it('保存した値を読み戻す', () => {
    const raw = [
      {
        sessionId: ID_A,
        provider: 'claude',
        viewColumn: 2,
        order: 3,
        cwd: '/w',
        threadName: '設計',
      },
    ];
    expect(normalizePersistedTabs(raw)).toEqual([
      {
        sessionId: ID_A,
        provider: 'claude',
        viewColumn: 2,
        order: 3,
        cwd: '/w',
        threadName: '設計',
      },
    ]);
  });

  it('プロバイダを持たない旧形式はCodexとして読む', () => {
    const raw = [{ sessionId: ID_A, viewColumn: 1, order: 0 }];
    expect(normalizePersistedTabs(raw)[0]?.provider).toBe('codex');
  });

  it('未知のプロバイダ名はCodexへ倒す', () => {
    const raw = [{ sessionId: ID_A, provider: 'gemini' }];
    expect(normalizePersistedTabs(raw)[0]?.provider).toBe('codex');
  });

  it('欠けた値に既定を入れる', () => {
    expect(normalizePersistedTabs([{ sessionId: ID_A }])).toEqual([
      {
        sessionId: ID_A,
        provider: 'codex',
        viewColumn: 1,
        order: UNKNOWN_ORDER,
        cwd: undefined,
        threadName: undefined,
      },
    ]);
  });

  it('idの無いエントリと重複を捨てる', () => {
    const raw = [
      { sessionId: ID_A },
      { sessionId: ID_A },
      { sessionId: '' },
      { viewColumn: 1 },
      null,
      'x',
    ];
    expect(normalizePersistedTabs(raw).map((t) => t.sessionId)).toEqual([ID_A]);
  });

  it('配列でない値や未保存でも空を返す', () => {
    expect(normalizePersistedTabs(undefined)).toEqual([]);
    expect(normalizePersistedTabs({ sessionId: ID_B })).toEqual([]);
  });

  it('不正なviewColumnを1に丸める', () => {
    expect(normalizePersistedTabs([{ sessionId: ID_A, viewColumn: 0 }])[0]?.viewColumn).toBe(1);
    expect(normalizePersistedTabs([{ sessionId: ID_A, viewColumn: 'x' }])[0]?.viewColumn).toBe(1);
  });
});
