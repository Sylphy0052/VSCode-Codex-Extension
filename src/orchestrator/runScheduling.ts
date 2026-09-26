/**
 * 並列にセッションを動かす実行（run）のスケジューリングの純粋ロジック。ノードの識別子を
 * 型パラメータにし、ロードマップ実行（Issue #1465、ノード＝Issue番号、`roadmapScheduler.ts`）と
 * オーケストレータモード（Issue #1505、ノード＝`taskId`の工程）が共通で使う。
 *
 * 状態の形はrunの種類ごとに違うので、ここでは状態を読まず、呼び出し側が判定関数と
 * 一覧を渡す。
 */

/** 依存先のうち、まだ満たされていないもの。`dependsOn`の並び順に返す。 */
export function unmetDependencies<Id>(
  dependsOn: readonly Id[],
  isSatisfied: (id: Id) => boolean,
): Id[] {
  return dependsOn.filter((dep) => !isSatisfied(dep));
}

export interface PickToStartInput<Id> {
  /** 実行できるノード。着手順に並べる。 */
  runnable: readonly Id[];
  maxParallel: number;
  /** 永続化した状態で、セッションが動いている（並列上限の対象の）ノードの数。 */
  activeCount: number;
  /**
   * まだ永続化した状態へ`running`として反映されていない（worktree作成・セッション起動が
   * 途中の）ノード。
   */
  starting: ReadonlySet<Id>;
  /** 永続化した状態で、セッションが動いているか。`starting`と二重に数えないために使う。 */
  isActive(id: Id): boolean;
}

/**
 * 今始めるノード。並列上限から動いているセッション数を引いた空き枠の分だけ、
 * 実行できるノードを着手順に返す。
 *
 * `activeCount`は永続化した状態しか見えないため、`starting`を渡さずに呼ぶと、短い間隔で
 * 複数回呼んだときに同じ空き枠を数え直してしまい、並列上限を超えて着手する余地がある
 * （Issue #1484）。開始処理の終わり際（`running`を永続化した後）のノードは`activeCount`に
 * 入っているので、`starting`の側では数えない。
 */
export function pickToStart<Id>(input: PickToStartInput<Id>): Id[] {
  const startingNotActive = [...input.starting].filter((id) => !input.isActive(id)).length;
  const slots = input.maxParallel - input.activeCount - startingNotActive;
  if (slots <= 0) {
    return [];
  }
  return input.runnable.filter((id) => !input.starting.has(id)).slice(0, slots);
}

export type RunAssessment<Id> =
  | { kind: 'finished' }
  | { kind: 'progressing' }
  /** 人がrun全体を止めていて、人の対応なしに進むノードも無い。人自身の操作なので通知しない。 */
  | { kind: 'haltedByUser' }
  /** 実行できるノードも、人の対応なしに進むノードも無い。`blockers`は人の対応を待つノード。 */
  | { kind: 'stalled'; blockers: readonly Id[] };

export interface AssessRunInput<Id> {
  allDone: boolean;
  /** 人の対応が無くても進むノードがある。 */
  anyProgressingWithoutUser: boolean;
  haltedByUser: boolean;
  hasRunnable: boolean;
  /** `stalled`のときだけ呼ぶ。人の対応を待つノード。 */
  blockers(): readonly Id[];
}

/**
 * runが進んでいるか、人の対応を待って止まっているかを判定する。
 *
 * 実行できるノードがあれば`progressing`とする（自動実行ならControllerが始め、
 * ユーザー選択なら人が選べる）。run全体を人が止めている間は、実行できるノードがあっても
 * 始まらないため`haltedByUser`とし、人の対応待ちの`stalled`と区別する。
 */
export function assessRunProgress<Id>(input: AssessRunInput<Id>): RunAssessment<Id> {
  if (input.allDone) {
    return { kind: 'finished' };
  }
  if (input.anyProgressingWithoutUser) {
    return { kind: 'progressing' };
  }
  if (input.haltedByUser) {
    return { kind: 'haltedByUser' };
  }
  if (input.hasRunnable) {
    return { kind: 'progressing' };
  }
  return { kind: 'stalled', blockers: input.blockers() };
}

/** 更新後の一覧で新たに現れたもの（更新後の並び順）。「実行可能になった」「終了した」の通知に使う。 */
export function newlyAppeared<Id>(before: readonly Id[], after: readonly Id[]): Id[] {
  const seen = new Set(before);
  return after.filter((id) => !seen.has(id));
}
