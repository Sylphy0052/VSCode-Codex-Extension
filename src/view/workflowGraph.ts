import { roleLabel, type TeamRole } from '../orchestrator/rolePresets';
import { isActiveTaskState, type TaskState } from '../orchestrator/runState';

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
  /**
   * 縦方向の行番号（0始まり）。折り返しが起きなければ `rank` と一致する。
   * 段が幅に収まらず複数行へ折り返された場合だけ `rank` より大きくなる。
   */
  row: number;
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
  /** 段ごとのタスクid（定義順）。折り返しが起きても段の区切りはそのまま保つ。 */
  ranks: readonly (readonly string[])[];
  nodes: readonly GraphNodeLayout[];
  edges: readonly GraphEdgeLayout[];
  /** SVGの`viewBox`に使う全体サイズ。 */
  width: number;
  height: number;
  /** 折り返しが1箇所でも起きたか。View側で注記を出す判断に使う。 */
  wrapped: boolean;
}

/** `layoutGraph` の調整値。 */
export interface LayoutOptions {
  /**
   * 描画領域の幅（px）。これを超える段は複数行へ折り返す（design.md §16.8「同じ段のタスクを
   * 横に並べる」を保ちつつ、パネル幅に収まらない並列数でも全体が見えるようにする）。
   * 未指定なら折り返さない（従来どおり1段=1行）。
   */
  maxWidth?: number | undefined;
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
 * 描画幅 `maxWidth` に何ノードまで横並びできるかを求める。
 * `n` ノードの並びは `n * NODE_WIDTH + (n - 1) * NODE_GAP_X + MARGIN_X * 2` の幅を要する。
 * 1ノードすら入らない極端に狭い幅でも、行が空にならないよう最低1を返す（残りは
 * View側の縮小表示・横スクロールが受け持つ）。
 */
function nodesPerRow(maxWidth: number | undefined): number {
  if (maxWidth === undefined || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const usable = maxWidth - MARGIN_X * 2 + NODE_GAP_X;
  return Math.max(1, Math.floor(usable / (NODE_WIDTH + NODE_GAP_X)));
}

/**
 * 段レイアウトを計算する（design.md §16.8「依存グラフ」）。
 *
 * 同じ段のタスクは横に並べ、段全体を横方向の中心へ揃える。段が変われば縦に積む。
 * 同じ段内の並び順は定義ファイルに書かれた順（`tasks` 配列の順）をそのまま使う
 * （design.md §16.3「定義ファイルに書かれた順で埋める」とスケジューリングの見た目を揃える）。
 *
 * `options.maxWidth` を渡すと、その幅に収まらない段は同じ段のまま複数行へ折り返す。
 * 並列数が多いワークフローでもパネル幅の中に全体が入る（Viewは折り返し後の幅で更に
 * 縮小表示する）。折り返しても段の順序（rank）は保たれるので、依存元の行は依存先の行より
 * 必ず上に来る。
 */
export function layoutGraph(
  tasks: readonly GraphTaskInput[],
  options: LayoutOptions = {},
): GraphLayout {
  const rankOf = computeRanks(tasks);
  const maxRank = tasks.reduce((max, t) => Math.max(max, rankOf.get(t.id) ?? 0), 0);
  const ranks: string[][] = Array.from({ length: tasks.length === 0 ? 0 : maxRank + 1 }, () => []);
  for (const t of tasks) {
    ranks[rankOf.get(t.id) ?? 0]?.push(t.id);
  }

  // 段を「実際に描く行」へ割り付ける。折り返しが無ければ1段=1行で従来と同じ結果になる
  const perRow = nodesPerRow(options.maxWidth);
  const rows: { rank: number; entries: { id: string; indexInRank: number }[] }[] = [];
  ranks.forEach((ids, rankIndex) => {
    for (let offset = 0; offset < ids.length; offset += perRow) {
      const slice = ids.slice(offset, offset + perRow);
      rows.push({
        rank: rankIndex,
        entries: slice.map((id, i) => ({ id, indexInRank: offset + i })),
      });
    }
  });
  const wrapped = rows.length > ranks.length;

  const rowWidths = rows.map(
    (row) => row.entries.length * NODE_WIDTH + Math.max(0, row.entries.length - 1) * NODE_GAP_X,
  );
  const width = Math.max(0, ...rowWidths) + MARGIN_X * 2;
  const centerX = width / 2;

  const nodes: GraphNodeLayout[] = [];
  rows.forEach((row, rowIndex) => {
    const rowWidth = rowWidths[rowIndex] ?? 0;
    const startX = centerX - rowWidth / 2;
    row.entries.forEach((entry, indexInRow) => {
      const x = startX + indexInRow * (NODE_WIDTH + NODE_GAP_X) + NODE_WIDTH / 2;
      const y = rowIndex * (NODE_HEIGHT + RANK_GAP_Y) + NODE_HEIGHT / 2 + MARGIN_X;
      nodes.push({
        id: entry.id,
        rank: row.rank,
        indexInRank: entry.indexInRank,
        row: rowIndex,
        x,
        y,
      });
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

  const height = rows.length === 0 ? 0 : rows.length * (NODE_HEIGHT + RANK_GAP_Y) + MARGIN_X;
  return { ranks: ranks.map((ids) => [...ids]), nodes, edges, width, height, wrapped };
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
  /**
   * 返信待ち（`waitingReply`）が1件でもあるか（design.md §16.21・Issue #104）。
   * 承認待ち・失敗と同じく、並列実行では個々のノードを見落としやすいため最上段で目立たせる。
   */
  hasWaitingReply: boolean;
  /**
   * 統合できていない（`blocked`）タスクが1件でもあるか（design.md §16.17・Issue #104）。
   * `blocked`はタスク自体は終わっているが統合ブランチへ入っていない状態で、`failed`とは
   * 別に扱う必要があるため専用のフラグにする。
   */
  hasBlocked: boolean;
}

const EMPTY_COUNTS = (): Record<TaskState, number> => ({
  pending: 0,
  running: 0,
  waitingApproval: 0,
  waitingReply: 0,
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
    hasWaitingReply: counts.waitingReply > 0,
    hasBlocked: counts.blocked > 0,
  };
}

/** 全体進捗バーの1区画（issue #754）。 */
export interface ProgressSegment {
  /** 区画の種別。CSSのクラス名（`seg-<kind>`）と対応させる。 */
  kind: 'done' | 'active' | 'attention';
  /** その区画が表すタスク数。 */
  count: number;
  /** バーに占める幅（百分率）。小数を残す——四捨五入すると合計が100%を超えることがある。 */
  percent: number;
}

/**
 * 全体進捗バーを状態ごとの積み上げに分ける（issue #754）。
 *
 * 完了だけを1色で塗っていると、失敗しているタスクがあってもバーからは分からず、
 * 上の警告帯を読むまで気付けない。`done` / 進行中 / 要対応 の3区画に分け、
 * 残り（`pending`）はトラックの地色のままにする。
 *
 * 件数が0の区画は返さない。幅0の要素を残すと、区切り線（`border`）だけが積み上がる。
 */
export function progressSegments(progress: ProgressSummary): ProgressSegment[] {
  const c = progress.counts;
  // 分類はカンバンの3バケット（summarizeKanban）と揃える。同じ状態が画面の2箇所で
  // 別の枠に入っていると、どちらが正しいのか読み手には分からない
  const active = c.running + c.waitingApproval + c.waitingReply + c.merging;
  const attention = c.failed + c.blocked + c.skipped;
  const segments: ProgressSegment[] = [
    { kind: 'done', count: c.done, percent: 0 },
    { kind: 'active', count: active, percent: 0 },
    { kind: 'attention', count: attention, percent: 0 },
  ];
  const total = progress.total;
  return segments
    .filter((segment) => segment.count > 0)
    .map((segment) => ({
      ...segment,
      percent: total === 0 ? 0 : (segment.count / total) * 100,
    }));
}

/**
 * カンバン風の3バケット + 要対応枠への分類（design.md §16.44、Issue #693、チームモード）。
 *
 * `runState.ts`の`TaskState`（9値）をそのまま一覧・グラフへ出すと、並列実行中は状態の
 * 種類が多すぎて「進んでいるのか止まっているのか」がひと目で分からない。ここではカンバンの
 * 3列（todo/inProgress/done）に丸め、加えて人の対応が要る状態（failed/blocked/skipped）を
 * `attention`として別枠に出す（`done`と違い「タスクの作業は終わったが良い終わり方ではない」
 * ため同列にしない）。
 *
 * - `todo`: `pending`
 * - `inProgress`: `running` / `waitingApproval` / `waitingReply` / `merging`
 * - `done`: `done`
 * - `attention`: `failed` / `blocked` / `skipped`
 *
 * **`inProgress`の4状態は`isActiveTaskState`（runState.ts）が「並列枠を占める」と判定する
 * 集合と完全に一致する。** 意味も一致する（「進行中」という直感は「並列枠を占めている」と
 * ほぼ同じ）ため、ここで独立に4値を書き並べず`isActiveTaskState`をそのまま再利用する。
 * `TaskState`へ新しい状態が増えたとき両者がずれたまま気付かれない事故
 * （`isActiveTaskState`のJSDocが警告する「状態を1つ足すたびに揃えて直す」対象の1つ）を防ぐ。
 */
export type KanbanBucket = 'todo' | 'inProgress' | 'done' | 'attention';

export function kanbanBucket(state: TaskState): KanbanBucket {
  if (state === 'pending') {
    return 'todo';
  }
  if (state === 'done') {
    return 'done';
  }
  if (state === 'failed' || state === 'blocked' || state === 'skipped') {
    return 'attention';
  }
  // 残りは running/waitingApproval/waitingReply/merging の4状態のみ（`TaskState`の全9値から
  // 上で判定済みの5値を除いた残り）。`isActiveTaskState`と一致する前提だが、分類関数としては
  // 万一ずれても値を返し切る必要があるため、falseの場合も人の目に留まりやすい`attention`へ倒す
  return isActiveTaskState(state) ? 'inProgress' : 'attention';
}

/** `kanbanBucket`の件数集計。バッジ表示（ToDo: N / InProgress: N / Done: N、要対応: N）に使う。 */
export interface KanbanSummary {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
  /** failed/blocked/skippedの合計。1件以上のときだけ警告色のバッジを別途出す判断に使う。 */
  attention: number;
}

/** `aggregateProgress`と同じく、テストしやすいよう`state`だけを持つ最小限の形を受け取る。 */
export function summarizeKanban(tasks: readonly { state: TaskState }[]): KanbanSummary {
  const summary: KanbanSummary = {
    total: tasks.length,
    todo: 0,
    inProgress: 0,
    done: 0,
    attention: 0,
  };
  for (const t of tasks) {
    summary[kanbanBucket(t.state)] += 1;
  }
  return summary;
}

/**
 * タスクの役割表示ラベル（design.md §16.44、Issue #693）。`role`が`undefined`
 * （役割なし。従来どおりの振る舞い、`rolePresets.ts`参照）のタスクは何も表示しない、という
 * 判定をここへ集約する。ノード（`workflowScript.ts`の`buildNode`）とタスク一覧
 * （`renderTable`）の両方が同じ判定を使うため、二重に書かない。
 */
export function taskRoleLabel(role: TeamRole | undefined): string | undefined {
  return role === undefined ? undefined : roleLabel(role);
}

/** 統合の状況（design.md §16.8「そのほか」・§16.17・§16.18）。表示できる項目だけを持つ。 */
export interface IntegrationSummary {
  /** 統合ブランチ名（`PersistedRun.integrationBranch` 由来）。 */
  branch: string;
  /** 統合ブランチへ取り込み済み（`done`）のタスク数。 */
  mergedTaskCount: number;
  /**
   * 統合PR/MRの番号（design.md §16.8「そのほか」・§16.11・§16.18、Issue #118）。
   * 作られていなければ `undefined`（`url` も `undefined`のとき、Viewはリンクの欄を出さない）。
   */
  pullRequestNumber: number | undefined;
  /** 統合PR/MRのURL。 */
  pullRequestUrl: string | undefined;
  /**
   * 統合→mainの最終マージ（design.md §16.18「最終マージ」）の成否。試みていなければ
   * `undefined`。
   */
  finalMergeOutcome: 'merged' | 'failed' | 'held' | undefined;
  /**
   * mainへの最終マージの判断待ち（design.md §16.26）。判断待ちが無ければ`undefined`。
   * `mode: 'confirm'`のときだけ、Viewが人の判断ボタンを出す。
   */
  finalMergeDecision:
    { mode: 'orchestrator' | 'confirm'; pullRequestUrl: string | undefined } | undefined;
}

/** `summarizeIntegration` が集計対象とする最小限のタスク形。 */
export interface IntegrationTaskInput {
  state: TaskState;
  /** タスク専用ブランチ名。`shared` / 明示`cwd`のタスクは統合対象のブランチを持たないため空。 */
  branch: string | undefined;
}

/**
 * 統合ブランチ名・取り込み済みタスク数を集計する（design.md §16.8「そのほか」の
 * 「統合ブランチ名、取り込み済みのタスク数」・§16.17）。
 *
 * `branch` が空（gitリポジトリでない実行、または未取得）なら統合の概念が無いため
 * `undefined` を返す。「取り込み済み」は `done`（design.md §16.17「doneは統合ブランチへ
 * 入ったことを指す」）かつタスク専用ブランチを持つ（`branch` が非空 = `isolation: worktree`
 * 系で実際にマージ対象だった）タスクに限る。`shared` / 明示`cwd`のタスクは統合ブランチへの
 * マージを経ずに`done`になる（`runner.ts`の`markMergeSucceeded`直行コメント参照）ため、
 * 「取り込み済み」には数えない。
 */
export function summarizeIntegration(
  branch: string | undefined,
  tasks: readonly IntegrationTaskInput[],
  pullRequest?: {
    number: number | undefined;
    url: string | undefined;
    finalMergeOutcome: 'merged' | 'failed' | 'held' | undefined;
    finalMergeDecision:
      { mode: 'orchestrator' | 'confirm'; pullRequestUrl: string | undefined } | undefined;
  },
): IntegrationSummary | undefined {
  if (branch === undefined || branch === '') {
    return undefined;
  }
  const mergedTaskCount = tasks.filter(
    (t) => t.state === 'done' && t.branch !== undefined && t.branch !== '',
  ).length;
  return {
    branch,
    mergedTaskCount,
    pullRequestNumber: pullRequest?.number,
    pullRequestUrl: pullRequest?.url,
    finalMergeOutcome: pullRequest?.finalMergeOutcome,
    finalMergeDecision: pullRequest?.finalMergeDecision,
  };
}

// HTML文字列への埋め込みを前提にした`escapeHtml`はここに置かない（以前あったが未結線の
// まま残っていた。レビュー指摘: info「デッドコードのまま『対策済み』に見えるのが一番良くない」）。
// `workflowView.ts`は初期HTMLシェルへ動的な値を一切埋め込まず（`postMessage`のJSON経由のみ）、
// `workflowScript.ts`側も`textContent`/`createElementNS`のみでDOMを組み立てる
// （`innerHTML`系APIを使わないことは`webviewScript.test.ts`で機械的に固定している）。
// この設計自体が「HTML文字列結合の経路を作らない」対策であり、エスケープ関数は不要。
