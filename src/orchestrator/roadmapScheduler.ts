/**
 * ロードマップ実行（Issue #1465）のスケジューラ。Controllerの状態（`roadmapRunState.ts`）から、
 * 実行できるノード、自動実行モードで今始めるノード、ユーザーの実行操作の可否、
 * runが止まって人の対応を要するかを決める。
 *
 * すべて純粋関数で、セッションの起動や通知は呼び出し側（Controller）が行う。
 * 並列上限は「動いているIssueセッションの数」に掛ける。merge待ち以降のノードは
 * セッションを持たないため数えない。上限を下げても実行中のセッションは止めず、
 * 動いている数が上限を下回るまで新しいノードを始めないだけにする。
 */

import {
  getIssue,
  type IssueAttemptKind,
  type RoadmapIssueExecution,
  type RoadmapPlanNode,
  type RoadmapRun,
} from './roadmapRunState';

/** Issueセッションが動いている（停止処理中を含む）。並列上限の対象。 */
export function hasActiveSession(issue: RoadmapIssueExecution): boolean {
  return issue.progress === 'running' && issue.currentAttemptId !== undefined;
}

/** 依存先として満たされている（mergeとcleanupまで済んで成功した）。 */
function isSatisfiedDependency(issue: RoadmapIssueExecution | undefined): boolean {
  return issue !== undefined && issue.progress === 'done' && issue.result === 'succeeded';
}

/** ノードの依存先のうち、まだ満たされていないIssue番号。`dependsOn`の並び順に返す。 */
export function unmetDependencies(run: RoadmapRun, node: RoadmapPlanNode): number[] {
  return node.dependsOn.filter((dep) => !isSatisfiedDependency(getIssue(run, dep)));
}

function planNodeFor(run: RoadmapRun, issueNumber: number): RoadmapPlanNode | undefined {
  return run.plan.nodes.find((node) => node.issueNumber === issueNumber);
}

/** 動いているIssueセッションの数。 */
export function countActiveSessions(run: RoadmapRun): number {
  return Object.values(run.issues).filter(hasActiveSession).length;
}

/**
 * 実行できるノード（Kanbanの「実行可能」列）。未着手で、依存先がすべて終わったノードを
 * 着手順（計画の並び）で返す。一時停止・停止・失敗したノードは人が再開・再実行を
 * 選ぶものなので含めない。
 */
export function listRunnableIssues(run: RoadmapRun): number[] {
  return run.plan.nodes
    .filter((node) => {
      const issue = getIssue(run, node.issueNumber);
      return (
        issue !== undefined &&
        issue.progress === 'notStarted' &&
        unmetDependencies(run, node).length === 0
      );
    })
    .map((node) => node.issueNumber);
}

/**
 * 自動実行モードで今始めるノード。並列上限から動いているセッション数を引いた空き枠の分だけ、
 * 実行できるノードを着手順に返す。ユーザー選択モード、run全体の停止中、終了後は空にする。
 *
 * `startingIssueNumbers`には、まだ`run.issues`へ`running`として反映されていない
 * （worktree作成・セッション起動が途中の）Issueを渡す。`countActiveSessions`は永続化した
 * 状態しか見えないため、これを渡さずに呼ぶと、`pump`を短い間隔で複数回呼んだときに
 * 同じ空き枠を数え直してしまい、並列上限を超えて着手する余地がある（Issue #1484）。
 */
export function pickIssuesToStart(
  run: RoadmapRun,
  startingIssueNumbers: ReadonlySet<number> = new Set(),
): number[] {
  if (run.mode !== 'auto' || run.haltedByUser || run.finishedAt !== undefined) {
    return [];
  }
  // 開始処理の終わり際（`running`を永続化した後）は`countActiveSessions`と二重に数えない
  const startingNotActive = [...startingIssueNumbers].filter((issueNumber) => {
    const issue = getIssue(run, issueNumber);
    return issue === undefined || !hasActiveSession(issue);
  }).length;
  const slots = run.maxParallel - countActiveSessions(run) - startingNotActive;
  if (slots <= 0) {
    return [];
  }
  return listRunnableIssues(run)
    .filter((issueNumber) => !startingIssueNumbers.has(issueNumber))
    .slice(0, slots);
}

export type StartIssueRejection =
  'unknownIssue' | 'notInPlan' | 'done' | 'alreadyRunning' | 'dependenciesUnmet';

export type StartIssueDecision =
  | {
      ok: true;
      attemptKind: Extract<IssueAttemptKind, 'initial' | 'resume' | 'retry'>;
      /** 再開のとき、優先して使う直前のセッション。無ければ新しいセッションを作る。 */
      resumeSessionRef: string | undefined;
      /** 依存が終わっていないのを上書きして始める。 */
      overridesDependencies: boolean;
    }
  | { ok: false; reason: StartIssueRejection; unmetDependencies: readonly number[] };

/**
 * ユーザーがノードの「実行」を押したときの可否と実行回の種類を決める。どちらのモードでも使う。
 *
 * - 未着手は`initial`、一時停止は`resume`、停止・失敗は`retry`で始める
 * - 依存が終わっていないノードは、確認つきの上書き（`overrideDependencies`）でだけ始められる
 * - ユーザーの明示の操作なので、並列上限とrun全体の停止には掛けない
 */
export function decideStartIssue(
  run: RoadmapRun,
  issueNumber: number,
  options: { overrideDependencies: boolean },
): StartIssueDecision {
  const reject = (
    reason: StartIssueRejection,
    unmet: readonly number[] = [],
  ): StartIssueDecision => ({ ok: false, reason, unmetDependencies: unmet });
  const issue = getIssue(run, issueNumber);
  if (issue === undefined) {
    return reject('unknownIssue');
  }
  const node = planNodeFor(run, issueNumber);
  if (node === undefined) {
    return reject('notInPlan');
  }
  if (issue.progress === 'done') {
    return reject('done');
  }
  if (issue.progress === 'running') {
    return reject('alreadyRunning');
  }
  const unmet = unmetDependencies(run, node);
  if (unmet.length > 0 && !options.overrideDependencies) {
    return reject('dependenciesUnmet', unmet);
  }
  const isPaused = issue.progress === 'halted' && issue.attention === 'paused';
  const attemptKind = issue.progress === 'notStarted' ? 'initial' : isPaused ? 'resume' : 'retry';
  return {
    ok: true,
    attemptKind,
    resumeSessionRef: attemptKind === 'resume' ? issue.attempts.at(-1)?.sessionRef : undefined,
    overridesDependencies: unmet.length > 0,
  };
}

/**
 * 人の対応が無くても進むノードか。セッションが動いていて質問・承認で止まっていない、
 * またはmerge待ち以降（Controllerが進める）にある。
 */
function isProgressingWithoutUser(issue: RoadmapIssueExecution): boolean {
  if (issue.progress !== 'running') {
    return false;
  }
  return (
    issue.attention === 'none' ||
    issue.attention === 'orchestratorConsidering' ||
    issue.attention === 'stopping'
  );
}

export type RunAssessment =
  | { kind: 'finished' }
  | { kind: 'progressing' }
  /** 人がrun全体を止めていて、人の対応なしに進むノードも無い。人自身の操作なので通知しない。 */
  | { kind: 'haltedByUser' }
  /** 実行できるノードも、人の対応なしに進むノードも無い。`blockers`は人の対応を待つノード。 */
  | { kind: 'stalled'; blockers: readonly number[] };

/**
 * runが進んでいるか、人の対応を待って止まっているかを判定する。自動実行モードで
 * `stalled`になったら、Controllerは自動実行を止めてKanbanとデスクトップ通知で知らせる。
 *
 * 実行できるノードがあれば`progressing`とする（自動実行ならControllerが始め、
 * ユーザー選択なら人が選べる）。run全体を人が止めている間は、実行できるノードがあっても
 * 始まらないため`haltedByUser`とし、人の対応待ちの`stalled`と区別する。
 */
export function assessRun(run: RoadmapRun): RunAssessment {
  const issues = Object.values(run.issues);
  if (issues.every((issue) => issue.progress === 'done')) {
    return { kind: 'finished' };
  }
  if (issues.some(isProgressingWithoutUser)) {
    return { kind: 'progressing' };
  }
  if (run.haltedByUser) {
    return { kind: 'haltedByUser' };
  }
  if (listRunnableIssues(run).length > 0) {
    return { kind: 'progressing' };
  }
  const blockers = run.plan.nodes
    .map((node) => getIssue(run, node.issueNumber))
    .filter(
      (issue): issue is RoadmapIssueExecution =>
        issue !== undefined && issue.progress !== 'done' && issue.progress !== 'notStarted',
    )
    .map((issue) => issue.issueNumber);
  return { kind: 'stalled', blockers };
}

/**
 * 状態の更新で新たに実行できるようになったノード。ユーザー選択モードで
 * 「ノードが実行可能になった」とKanbanで知らせるために使う。
 */
export function newlyRunnableIssues(prev: RoadmapRun, next: RoadmapRun): number[] {
  const before = new Set(listRunnableIssues(prev));
  return listRunnableIssues(next).filter((n) => !before.has(n));
}

/** 状態の更新で終了したノード。Issueの終了をKanbanで知らせるために使う。 */
export function newlyFinishedIssues(prev: RoadmapRun, next: RoadmapRun): number[] {
  return Object.values(next.issues)
    .filter(
      (issue) =>
        issue.progress === 'done' && getIssue(prev, issue.issueNumber)?.progress !== 'done',
    )
    .map((issue) => issue.issueNumber);
}
