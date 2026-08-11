import { describe, expect, it } from 'vitest';
import {
  aggregateProgress,
  computeRanks,
  layoutGraph,
  NODE_GAP_X,
  NODE_WIDTH,
  type GraphTaskInput,
} from '../../src/view/workflowGraph';

/** design.mdが繰り返し例示する形。T1完了後にT2・T3が並列で走り、両方の完了後にT4が走る。 */
const DIAMOND: GraphTaskInput[] = [
  { id: 'T1', dependsOn: [] },
  { id: 'T2', dependsOn: ['T1'] },
  { id: 'T3', dependsOn: ['T1'] },
  { id: 'T4', dependsOn: ['T2', 'T3'] },
];

describe('computeRanks（design.md §16.8「依存グラフ」）', () => {
  it('T1 → (T2 || T3) → T4 が0/1/1/2の3種類のrankになる', () => {
    const ranks = computeRanks(DIAMOND);
    expect(ranks.get('T1')).toBe(0);
    expect(ranks.get('T2')).toBe(1);
    expect(ranks.get('T3')).toBe(1);
    expect(ranks.get('T4')).toBe(2);
  });

  it('依存が無いタスクは全てrank0', () => {
    const ranks = computeRanks([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: [] },
    ]);
    expect(ranks.get('A')).toBe(0);
    expect(ranks.get('B')).toBe(0);
  });

  it('未定義のdependsOn参照は無視する（検証で弾かれる前提のデータでも壊れない）', () => {
    const ranks = computeRanks([{ id: 'A', dependsOn: ['存在しない'] }]);
    expect(ranks.get('A')).toBe(0);
  });

  it('循環があっても無限再帰せず終了する（値の正しさは前提としない）', () => {
    // 循環は読み込み時の検証（validateWorkflow）で弾かれる前提。ここでは
    // 「循環が無いこと前提の扱い」＝クラッシュしないことだけを確認する
    const ranks = computeRanks([
      { id: 'A', dependsOn: ['B'] },
      { id: 'B', dependsOn: ['A'] },
    ]);
    // 循環を検出した側（後から辿り着いた方）は必ず0に確定する
    expect(ranks.get('A')).toBe(0);
    expect(Number.isFinite(ranks.get('B'))).toBe(true);
  });
});

describe('layoutGraph（design.md §16.8「依存グラフ」の段レイアウト）', () => {
  it('T1 → (T2 || T3) → T4 が縦3段になる', () => {
    const layout = layoutGraph(DIAMOND);
    expect(layout.ranks).toEqual([['T1'], ['T2', 'T3'], ['T4']]);
  });

  it('同じ段の並び順は定義ファイルに書かれた順を保つ', () => {
    const layout = layoutGraph([
      { id: 'T1', dependsOn: [] },
      { id: 'T3', dependsOn: ['T1'] },
      { id: 'T2', dependsOn: ['T1'] },
    ]);
    expect(layout.ranks[1]).toEqual(['T3', 'T2']);
  });

  it('段が進むごとにy座標が増える（縦に積む）', () => {
    const layout = layoutGraph(DIAMOND);
    const yOf = (id: string): number => layout.nodes.find((n) => n.id === id)?.y ?? -1;
    expect(yOf('T1')).toBeLessThan(yOf('T2'));
    expect(yOf('T2')).toBeLessThan(yOf('T4'));
    // 同じ段のノードは同じy座標
    expect(yOf('T2')).toBe(yOf('T3'));
  });

  it('同じ段の複数ノードは異なるx座標に並ぶ', () => {
    const layout = layoutGraph(DIAMOND);
    const xOf = (id: string): number => layout.nodes.find((n) => n.id === id)?.x ?? -1;
    expect(xOf('T2')).not.toBe(xOf('T3'));
    expect(Math.abs(xOf('T2') - xOf('T3'))).toBe(NODE_WIDTH + NODE_GAP_X);
  });

  it('全てのノードが正の座標に収まる（SVGの左上原点で切れない）', () => {
    const layout = layoutGraph(DIAMOND);
    for (const node of layout.nodes) {
      expect(node.x - NODE_WIDTH / 2).toBeGreaterThanOrEqual(0);
      expect(node.x + NODE_WIDTH / 2).toBeLessThanOrEqual(layout.width);
      expect(node.y).toBeGreaterThan(0);
      expect(node.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it('エッジはdependsOnの依存元→依存先で作る', () => {
    const layout = layoutGraph(DIAMOND);
    expect(layout.edges).toEqual(
      expect.arrayContaining([
        { from: 'T1', to: 'T2' },
        { from: 'T1', to: 'T3' },
        { from: 'T2', to: 'T4' },
        { from: 'T3', to: 'T4' },
      ]),
    );
    expect(layout.edges).toHaveLength(4);
  });

  it('タスクが0件なら段もノードも空', () => {
    const layout = layoutGraph([]);
    expect(layout.ranks).toEqual([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
  });

  it('単独タスクは1段1ノード', () => {
    const layout = layoutGraph([{ id: 'T1', dependsOn: [] }]);
    expect(layout.ranks).toEqual([['T1']]);
    expect(layout.nodes).toHaveLength(1);
  });
});

describe('aggregateProgress（design.md §16.8「全体の進捗」）', () => {
  it('状態ごとの件数を数える', () => {
    const summary = aggregateProgress([
      { state: 'done' },
      { state: 'running' },
      { state: 'running' },
      { state: 'pending' },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.counts).toEqual({
      pending: 1,
      running: 2,
      waitingApproval: 0,
      done: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('進み具合（百分率）を四捨五入で出す', () => {
    // 1/3 = 33.33...% → 33%
    const summary = aggregateProgress([
      { state: 'done' },
      { state: 'running' },
      { state: 'pending' },
    ]);
    expect(summary.percentDone).toBe(33);
  });

  it('タスクが0件なら進み具合は0', () => {
    expect(aggregateProgress([]).percentDone).toBe(0);
  });

  it('承認待ちが1件でもあればhasWaitingApprovalが立つ', () => {
    const summary = aggregateProgress([{ state: 'waitingApproval' }, { state: 'done' }]);
    expect(summary.hasWaitingApproval).toBe(true);
    expect(summary.hasFailed).toBe(false);
  });

  it('失敗が1件でもあればhasFailedが立つ', () => {
    const summary = aggregateProgress([{ state: 'failed' }, { state: 'done' }]);
    expect(summary.hasFailed).toBe(true);
  });

  it('全て完了していれば進み具合は100', () => {
    const summary = aggregateProgress([{ state: 'done' }, { state: 'done' }]);
    expect(summary.percentDone).toBe(100);
  });
});

// `escapeHtml`はworkflowGraph.tsから削除した（レビュー指摘: info「未結線のデッドコード」）。
// XSS対策は「HTML文字列結合の経路を作らない」設計そのもの（`workflowScript.ts`の
// `textContent`/`createElementNS`のみでのDOM組み立て）で担保しており、
// `webviewScript.test.ts`の「innerHTML等を使わない」検査で機械的に固定している。
