import { describe, expect, it } from 'vitest';
import {
  aggregateProgress,
  computeRanks,
  layoutGraph,
  NODE_GAP_X,
  NODE_HEIGHT,
  NODE_WIDTH,
  summarizeIntegration,
  type GraphTaskInput,
} from '../../src/view/workflowGraph';

/** design.mdが繰り返し例示する形。T1完了後にT2・T3が並列で走り、両方の完了後にT4が走る。 */
const DIAMOND: GraphTaskInput[] = [
  { id: 'T1', dependsOn: [] },
  { id: 'T2', dependsOn: ['T1'] },
  { id: 'T3', dependsOn: ['T1'] },
  { id: 'T4', dependsOn: ['T2', 'T3'] },
];

/** rank1に6タスクが並ぶ形。折り返さなければ 6*168 + 5*28 + 56 = 1252px 必要になる。 */
const WIDE_RANK: GraphTaskInput[] = [
  { id: 'T1', dependsOn: [] },
  ...Array.from({ length: 6 }, (_, i) => ({ id: 'W' + (i + 1), dependsOn: ['T1'] })),
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

  it('maxWidthを渡さなければ折り返さない（従来どおり1段=1行）', () => {
    const layout = layoutGraph(WIDE_RANK);
    expect(layout.wrapped).toBe(false);
    const ys = new Set(layout.nodes.filter((n) => n.rank === 1).map((n) => n.y));
    expect(ys.size).toBe(1);
  });
});

describe('layoutGraph の折り返し（グラフが描画幅に収まらない場合）', () => {
  const rowWidthFor = (count: number): number =>
    count * NODE_WIDTH + (count - 1) * NODE_GAP_X + NODE_GAP_X * 2;

  it('描画幅に収まらない段は複数行へ折り返す', () => {
    // 3ノード分の幅しか無い場合、6タスクの段は3+3の2行になる
    const layout = layoutGraph(WIDE_RANK, { maxWidth: rowWidthFor(3) });
    expect(layout.wrapped).toBe(true);
    const rows = new Set(layout.nodes.filter((n) => n.rank === 1).map((n) => n.row));
    expect(rows.size).toBe(2);
  });

  it('折り返しても全体の幅は描画幅に収まる', () => {
    const maxWidth = rowWidthFor(3);
    const layout = layoutGraph(WIDE_RANK, { maxWidth });
    expect(layout.width).toBeLessThanOrEqual(maxWidth);
    for (const node of layout.nodes) {
      expect(node.x - NODE_WIDTH / 2).toBeGreaterThanOrEqual(0);
      expect(node.x + NODE_WIDTH / 2).toBeLessThanOrEqual(layout.width);
    }
  });

  it('折り返した分だけ高さが伸びる（ノードが縦にはみ出さない）', () => {
    const layout = layoutGraph(WIDE_RANK, { maxWidth: rowWidthFor(3) });
    for (const node of layout.nodes) {
      expect(node.y + NODE_HEIGHT / 2).toBeLessThanOrEqual(layout.height);
    }
  });

  it('折り返しても段の区切り（ranks）と定義順は変わらない', () => {
    const layout = layoutGraph(WIDE_RANK, { maxWidth: rowWidthFor(2) });
    expect(layout.ranks).toEqual([['T1'], ['W1', 'W2', 'W3', 'W4', 'W5', 'W6']]);
    // indexInRankは段全体を通した並び順のまま（行内の位置ではない）
    const indexes = layout.nodes.filter((n) => n.rank === 1).map((n) => n.indexInRank);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('折り返しても依存元は依存先より上に来る', () => {
    const layout = layoutGraph(WIDE_RANK, { maxWidth: rowWidthFor(2) });
    const yOf = (id: string): number => layout.nodes.find((n) => n.id === id)?.y ?? -1;
    for (let i = 1; i <= 6; i += 1) {
      expect(yOf('T1')).toBeLessThan(yOf('W' + i));
    }
  });

  it('1ノードすら入らない幅でも1行1ノードで並べる（残りは縮小・スクロールに任せる）', () => {
    const layout = layoutGraph(WIDE_RANK, { maxWidth: 10 });
    const rows = new Set(layout.nodes.filter((n) => n.rank === 1).map((n) => n.row));
    expect(rows.size).toBe(6);
    expect(layout.width).toBe(NODE_WIDTH + NODE_GAP_X * 2);
  });

  it('十分な幅があれば折り返さない', () => {
    const layout = layoutGraph(WIDE_RANK, { maxWidth: rowWidthFor(6) });
    expect(layout.wrapped).toBe(false);
    const rows = new Set(layout.nodes.filter((n) => n.rank === 1).map((n) => n.row));
    expect(rows.size).toBe(1);
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
      waitingReply: 0,
      merging: 0,
      done: 1,
      failed: 0,
      blocked: 0,
      skipped: 0,
    });
  });

  it('waitingReply/merging/blockedも数える（Issue #104: 3状態への追随）', () => {
    const summary = aggregateProgress([
      { state: 'waitingReply' },
      { state: 'merging' },
      { state: 'blocked' },
      { state: 'done' },
    ]);
    expect(summary.counts.waitingReply).toBe(1);
    expect(summary.counts.merging).toBe(1);
    expect(summary.counts.blocked).toBe(1);
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

  it('返信待ちが1件でもあればhasWaitingReplyが立つ（Issue #104）', () => {
    const summary = aggregateProgress([{ state: 'waitingReply' }, { state: 'done' }]);
    expect(summary.hasWaitingReply).toBe(true);
    expect(summary.hasBlocked).toBe(false);
  });

  it('統合できていない(blocked)が1件でもあればhasBlockedが立つ（Issue #104）', () => {
    const summary = aggregateProgress([{ state: 'blocked' }, { state: 'done' }]);
    expect(summary.hasBlocked).toBe(true);
    expect(summary.hasWaitingReply).toBe(false);
  });

  it('全て完了していれば進み具合は100', () => {
    const summary = aggregateProgress([{ state: 'done' }, { state: 'done' }]);
    expect(summary.percentDone).toBe(100);
  });
});

describe('summarizeIntegration（design.md §16.8「そのほか」・§16.17。Issue #104）', () => {
  it('統合ブランチ名が無ければundefined（gitリポジトリでない実行など）', () => {
    expect(summarizeIntegration(undefined, [])).toBeUndefined();
    expect(summarizeIntegration('', [{ state: 'done', branch: 'wf/r1/T1' }])).toBeUndefined();
  });

  it('ブランチ名と、doneかつタスク専用ブランチを持つものの件数を返す', () => {
    const summary = summarizeIntegration('wf/r1/integration', [
      { state: 'done', branch: 'wf/r1/T1' },
      { state: 'done', branch: 'wf/r1/T2' },
      { state: 'running', branch: 'wf/r1/T3' },
      { state: 'blocked', branch: 'wf/r1/T4' },
    ]);
    expect(summary).toEqual({ branch: 'wf/r1/integration', mergedTaskCount: 2 });
  });

  it('doneでもタスク専用ブランチが無ければ取り込み済みに数えない（isolation: sharedの直行）', () => {
    const summary = summarizeIntegration('wf/r1/integration', [
      { state: 'done', branch: undefined },
      { state: 'done', branch: '' },
    ]);
    expect(summary).toEqual({ branch: 'wf/r1/integration', mergedTaskCount: 0 });
  });

  it(
    'PR/MRの番号・URL・最終マージの成否をそのまま持ち帰る' +
      '（design.md §16.8「そのほか」・§16.11・§16.18、Issue #118）',
    () => {
      const summary = summarizeIntegration(
        'wf/r1/integration',
        [{ state: 'done', branch: 'wf/r1/T1' }],
        {
          number: 7,
          url: 'https://github.com/acme/repo/pull/7',
          finalMergeOutcome: 'merged',
          finalMergeDecision: undefined,
        },
      );
      expect(summary).toEqual({
        branch: 'wf/r1/integration',
        mergedTaskCount: 1,
        pullRequestNumber: 7,
        pullRequestUrl: 'https://github.com/acme/repo/pull/7',
        finalMergeOutcome: 'merged',
        finalMergeDecision: undefined,
      });
    },
  );

  it('PR/MRが作られていなければ番号・URL・最終マージの成否はundefined（第3引数省略時も同じ）', () => {
    const withoutArg = summarizeIntegration('wf/r1/integration', []);
    expect(withoutArg?.pullRequestNumber).toBeUndefined();
    expect(withoutArg?.pullRequestUrl).toBeUndefined();
    expect(withoutArg?.finalMergeOutcome).toBeUndefined();

    const withUndefinedFields = summarizeIntegration('wf/r1/integration', [], {
      number: undefined,
      url: undefined,
      finalMergeOutcome: undefined,
      finalMergeDecision: undefined,
    });
    expect(withUndefinedFields?.pullRequestNumber).toBeUndefined();
    expect(withUndefinedFields?.pullRequestUrl).toBeUndefined();
    expect(withUndefinedFields?.finalMergeOutcome).toBeUndefined();
  });
});

// `escapeHtml`はworkflowGraph.tsから削除した（レビュー指摘: info「未結線のデッドコード」）。
// XSS対策は「HTML文字列結合の経路を作らない」設計そのもの（`workflowScript.ts`の
// `textContent`/`createElementNS`のみでのDOM組み立て）で担保しており、
// `webviewScript.test.ts`の「innerHTML等を使わない」検査で機械的に固定している。
