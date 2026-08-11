import type { TaskState } from '../orchestrator/runState';

/**
 * ワークフローViewの純粋ロジック（design.md §16.8）。
 *
 * Webviewの描画そのものはテストしにくいため、テストで固めたいロジック
 * （段レイアウトの計算・進捗の集計・HTMLエスケープ）をここに寄せる。VSCode APIには
 * 依存しない。実際のSVG/DOM組み立ては `workflowScript.ts`（Webview内で動くスクリプト）が
 * この計算結果を使って行う。
 */

/** 依存を持つ最小限の形。`WorkflowTask` 全体を要求しないことでテストを書きやすくする。 */
export interface GraphTaskInput {
  id: string;
  dependsOn: readonly string[];
}

/** 1ノード分のレイアウト結果。座標はSVGの左上原点で正の値になるよう調整済み。 */
export interface GraphNodeLayout {
  id: string;
  /** 依存の深さ（0始まり）。同じ段のタスクは同時に走りうる集合に対応する。 */
  rank: number;
  /** 同じ段の中での並び順（0始まり）。定義ファイルに書かれた順を保つ。 */
  indexInRank: number;
  /** ノード中心のx座標。 */
  x: number;
  /** ノード中心のy座標。 */
  y: number;
}

export interface GraphEdgeLayout {
  from: string;
  to: string;
}

export interface GraphLayout {
  /** 段ごとのタスクid（定義順）。 */
  ranks: readonly (readonly string[])[];
  nodes: readonly GraphNodeLayout[];
  edges: readonly GraphEdgeLayout[];
  /** SVGの`viewBox`に使う全体サイズ。 */
  width: number;
  height: number;
}

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 60;
export const NODE_GAP_X = 28;
export const RANK_GAP_Y = 56;
/** 左右の余白。中心寄せしたノードがSVGの端で切れないようにする。 */
const MARGIN_X = NODE_GAP_X;

/**
 * 依存の深さ（rank）を求める。`rank(id) = 1 + max(rank(dep) for dep in dependsOn)`、
 * 依存が無ければ0。`T1 → (T2 || T3) → T4` は `{T1:0, T2:1, T3:1, T4:2}` になり、
 * 3種類のrank＝3段のグラフに対応する（design.md §16.8「同じ段のタスクを横に並べる」）。
 *
 * 循環は読み込み時の検証（`validateWorkflow`）で弾いてある前提だが、Viewは検証を経由しない
 * データ（テストや将来のバグ）を渡されても無限再帰しないよう、探索中のidを記録して防ぐ
 * （循環に含まれるノードのrankは便宜上0にする。「循環が無いこと前提の扱い」でよい）。
 * 未定義のdependsOn参照（検証で弾かれるはずの入力）も同様に無視する。
 */
export function computeRanks(tasks: readonly GraphTaskInput[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const rank = new Map<string, number>();
  const status = new Map<string, 'visiting' | 'done'>();
  // 循環に含まれると分かったid。探索中に検出した値をそのまま`rank`へ確定させると、
  // 検出元のフレームがその後finalize処理で上書きしてしまう（フレームは自分のidの
  // rankを最後に必ず書き込むため）。確定は全探索が終わってからまとめて行う
  const cyclic = new Set<string>();

  function resolve(id: string): number {
    if (status.get(id) === 'done') {
      return rank.get(id) ?? 0;
    }
    if (status.get(id) === 'visiting') {
      // 探索中のidへ戻ってきた＝循環。このエッジの寄与としては0として扱い、
      // 呼び出し元の計算を止めない（無限再帰の防止が目的で、値の正しさは保証しない）
      cyclic.add(id);
      return 0;
    }
    status.set(id, 'visiting');
    let r = 0;
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) {
        r = Math.max(r, resolve(dep) + 1);
      }
    }
    status.set(id, 'done');
    rank.set(id, r);
    return r;
  }

  for (const t of tasks) {
    resolve(t.id);
  }
  for (const id of cyclic) {
    rank.set(id, 0);
  }
  return rank;
}

/**
 * 段レイアウトを計算する（design.md §16.8「依存グラフ」）。
 *
 * 同じ段のタスクは横に並べ、段全体を横方向の中心へ揃える。段が変われば縦に積む。
 * 同じ段内の並び順は定義ファイルに書かれた順（`tasks` 配列の順）をそのまま使う
 * （design.md §16.3「定義ファイルに書かれた順で埋める」とスケジューリングの見た目を揃える）。
 */
export function layoutGraph(tasks: readonly GraphTaskInput[]): GraphLayout {
  const rankOf = computeRanks(tasks);
  const maxRank = tasks.reduce((max, t) => Math.max(max, rankOf.get(t.id) ?? 0), 0);
  const ranks: string[][] = Array.from({ length: tasks.length === 0 ? 0 : maxRank + 1 }, () => []);
  for (const t of tasks) {
    ranks[rankOf.get(t.id) ?? 0]?.push(t.id);
  }

  const rowWidths = ranks.map(
    (ids) => ids.length * NODE_WIDTH + Math.max(0, ids.length - 1) * NODE_GAP_X,
  );
  const width = Math.max(0, ...rowWidths) + MARGIN_X * 2;
  const centerX = width / 2;

  const nodes: GraphNodeLayout[] = [];
  ranks.forEach((ids, rankIndex) => {
    const rowWidth = rowWidths[rankIndex] ?? 0;
    const startX = centerX - rowWidth / 2;
    ids.forEach((id, indexInRank) => {
      const x = startX + indexInRank * (NODE_WIDTH + NODE_GAP_X) + NODE_WIDTH / 2;
      const y = rankIndex * (NODE_HEIGHT + RANK_GAP_Y) + NODE_HEIGHT / 2 + MARGIN_X;
      nodes.push({ id, rank: rankIndex, indexInRank, x, y });
    });
  });

  const edges: GraphEdgeLayout[] = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (rankOf.has(dep)) {
        edges.push({ from: dep, to: t.id });
      }
    }
  }

  const height = ranks.length === 0 ? 0 : ranks.length * (NODE_HEIGHT + RANK_GAP_Y) + MARGIN_X;
  return { ranks: ranks.map((ids) => [...ids]), nodes, edges, width, height };
}

/** 全体の進捗集計（design.md §16.8「全体の進捗」）。 */
export interface ProgressSummary {
  total: number;
  counts: Record<TaskState, number>;
  /** `done / total` を百分率で四捨五入した値。`total` が0なら0。 */
  percentDone: number;
  /** 承認待ちが1件でもあるか。最上段で目立たせる判断に使う。 */
  hasWaitingApproval: boolean;
  /** 失敗が1件でもあるか。最上段で目立たせる判断に使う。 */
  hasFailed: boolean;
}

const EMPTY_COUNTS = (): Record<TaskState, number> => ({
  pending: 0,
  running: 0,
  waitingApproval: 0,
  merging: 0,
  done: 0,
  failed: 0,
  blocked: 0,
  skipped: 0,
});

export function aggregateProgress(tasks: readonly { state: TaskState }[]): ProgressSummary {
  const counts = EMPTY_COUNTS();
  for (const t of tasks) {
    counts[t.state] += 1;
  }
  const total = tasks.length;
  return {
    total,
    counts,
    percentDone: total === 0 ? 0 : Math.round((counts.done / total) * 100),
    hasWaitingApproval: counts.waitingApproval > 0,
    hasFailed: counts.failed > 0,
  };
}

// HTML文字列への埋め込みを前提にした`escapeHtml`はここに置かない（以前あったが未結線の
// まま残っていた。レビュー指摘: info「デッドコードのまま『対策済み』に見えるのが一番良くない」）。
// `workflowView.ts`は初期HTMLシェルへ動的な値を一切埋め込まず（`postMessage`のJSON経由のみ）、
// `workflowScript.ts`側も`textContent`/`createElementNS`のみでDOMを組み立てる
// （`innerHTML`系APIを使わないことは`webviewScript.test.ts`で機械的に固定している）。
// この設計自体が「HTML文字列結合の経路を作らない」対策であり、エスケープ関数は不要。
