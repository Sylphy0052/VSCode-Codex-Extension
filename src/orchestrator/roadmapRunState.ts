/**
 * ロードマップIssueの子Issueを1ノードずつ実行する機能（Issue #1465）のController側の状態。
 *
 * 状態の正本はこのファイルの型で表すControllerの状態だけとする。Orchestratorの会話履歴や
 * Issueセッションの自己申告は正本にしない。Issueセッションからの報告は`checkReport`で
 * 現在の実行（`executionId`）と実行回（`attemptId`）に一致するものだけを受け付け、
 * 自動引き継ぎ前の古いセッションやリロード前のセッションから遅れて届いた報告で
 * 状態が変わらないようにする。
 *
 * 遷移関数はすべて純粋関数で、変化が無ければ同じ参照を返す（`programState.ts`と同じ方針）。
 * 永続化は`roadmapRunStore.ts`が担う。`workspaceState`は素の`JSON`を通るため、
 * `Map`ではなく`Record`で持つ。キーは`issueKey`で作る10進の番号だけに限る
 * （`__proto__`等の危険なキーが入らない）。
 */

/** Issueセッションの実行エンジン。runの開始時に1つ選び、全Issueで共通にする。 */
export type RoadmapRunEngine = 'codex' | 'claude';

/** 自動実行モードとユーザー選択モード。 */
export type RoadmapRunMode = 'auto' | 'manual';

/** 自動実行モードの並列上限として受け付ける最大値。 */
export const MAX_ROADMAP_PARALLEL = 8;

/** 進み具合: 未着手 / 実行中 / 止まっている / 終わった。 */
export const ISSUE_PROGRESSES = ['notStarted', 'running', 'halted', 'done'] as const;
export type IssueProgress = (typeof ISSUE_PROGRESSES)[number];

/**
 * 工程: 実装 / 実行（テスト・ビルド等） / レビュー / merge待ち / merge中 / merge修復 / cleanup。
 * `implement`・`execute`・`review`はIssueセッションの報告で表示を補うだけの値で、
 * `awaitingMerge`以降はControllerが観測した事実でだけ確定する。
 */
export const ISSUE_PHASES = [
  'implement',
  'execute',
  'review',
  'awaitingMerge',
  'merging',
  'mergeRepair',
  'cleanup',
] as const;
export type IssuePhase = (typeof ISSUE_PHASES)[number];

/** Issueセッションが自己申告してよい工程。 */
export const SESSION_REPORTABLE_PHASES: readonly IssuePhase[] = ['implement', 'execute', 'review'];

/**
 * 注意: なし / Orchestratorが質問を検討中 / ユーザー判断待ち / 承認待ち / 失敗 /
 * 停止処理中 / 一時停止。
 */
export const ISSUE_ATTENTIONS = [
  'none',
  'orchestratorConsidering',
  'awaitingUser',
  'awaitingApproval',
  'failed',
  'stopping',
  'paused',
] as const;
export type IssueAttention = (typeof ISSUE_ATTENTIONS)[number];

/** 結果: 成功 / 停止 / 失敗。終わっていなければ`undefined`。 */
export type IssueResult = 'succeeded' | 'stopped' | 'failed';

/**
 * 実行回の種類。最初の実装、中断からの再開、自動引き継ぎで替わったセッション、
 * merge失敗の修復、再試行をそれぞれ別の実行回にする。
 */
export type IssueAttemptKind = 'initial' | 'resume' | 'handoff' | 'mergeRepair' | 'retry';

export interface IssueAttempt {
  attemptId: string;
  kind: IssueAttemptKind;
  /** ISO8601。 */
  startedAt: string;
  /** ISO8601。現在の実行回なら`undefined`。 */
  endedAt: string | undefined;
  /** この実行回を担うセッションタブの識別子。まだ開いていなければ`undefined`。 */
  sessionRef: string | undefined;
}

/** 1つの子Issueの実行。runの中でIssue1件につき1つだけ作る。 */
export interface RoadmapIssueExecution {
  issueNumber: number;
  /** 外部由来のテキスト。表示やプロンプトへ入れるときは`formatUntrusted`等を通す。 */
  title: string;
  /** runの開始時にロードマップ本文で`- [x] #N`だった（開始前に完了済み）。 */
  checkedAtStart: boolean;
  executionId: string;
  progress: IssueProgress;
  /** 未着手、または終わったときは`undefined`。 */
  phase: IssuePhase | undefined;
  attention: IssueAttention;
  result: IssueResult | undefined;
  attempts: readonly IssueAttempt[];
  /** 報告を受け付ける実行回。実行中のセッションが無ければ`undefined`（どの報告も受け付けない）。 */
  currentAttemptId: string | undefined;
  worktreePath: string | undefined;
  branch: string | undefined;
  pullRequest: { number: number; url: string } | undefined;
  /** `attention === 'failed'`のときの理由。 */
  failure: string | undefined;
  /** ISO8601。 */
  updatedAt: string;
}

/** 着手順（計画）の1ノード。波（`wave`）は表示のためだけに使う。 */
export interface RoadmapPlanNode {
  issueNumber: number;
  dependsOn: readonly number[];
  wave: number | undefined;
}

export interface RoadmapPlan {
  /** 着手順の早い順。 */
  nodes: readonly RoadmapPlanNode[];
  /** ロードマップ本文の計画区画をそのまま使ったか、このrunで生成して書き戻したか。 */
  source: 'existingSection' | 'generated';
}

export const ROADMAP_RUN_SCHEMA_VERSION = 1;

/** Controllerの実行（run）。1ロードマップにつき1つ。 */
export interface RoadmapRun {
  schemaVersion: typeof ROADMAP_RUN_SCHEMA_VERSION;
  runId: string;
  roadmapIssueNumber: number;
  /** ワークスペースフォルダの絶対パス。 */
  workspaceRoot: string;
  engine: RoadmapRunEngine;
  mode: RoadmapRunMode;
  /** 自動実行モードの並列上限。ユーザー選択モードでも値は保持する。 */
  maxParallel: number;
  /** ISO8601。 */
  startedAt: string;
  /** 実行中は`undefined`。 */
  finishedAt: string | undefined;
  plan: RoadmapPlan;
  /** キーは`issueKey(issueNumber)`。runの開始時の子Issueの集合を表す。 */
  issues: Record<string, RoadmapIssueExecution>;
  /** 人がrun全体を止めた。真の間は新しいノードを始めない。 */
  haltedByUser: boolean;
}

/** Issueセッションからの報告に必ず付ける識別子。 */
export interface IssueReportRef {
  issueNumber: number;
  executionId: string;
  attemptId: string;
}

export type ReportRejection =
  'unknownIssue' | 'executionMismatch' | 'noActiveAttempt' | 'attemptMismatch';

export function isValidIssueNumber(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** `RoadmapRun.issues`のキー。不正な番号は例外にする（キーへ任意の文字列を入れない）。 */
export function issueKey(issueNumber: number): string {
  if (!isValidIssueNumber(issueNumber)) {
    throw new Error(`不正なIssue番号: ${String(issueNumber)}`);
  }
  return String(issueNumber);
}

export function isValidMaxParallel(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_ROADMAP_PARALLEL;
}

export interface CreateRoadmapRunInput {
  runId: string;
  roadmapIssueNumber: number;
  workspaceRoot: string;
  engine: RoadmapRunEngine;
  mode: RoadmapRunMode;
  maxParallel: number;
  plan: RoadmapPlan;
  /** ロードマップ本文の行頭`- [ ] #N`/`- [x] #N`から取り出した子Issue。 */
  children: readonly { issueNumber: number; title: string; checked: boolean }[];
  newExecutionId: (issueNumber: number) => string;
  now: Date;
}

/**
 * runの初期状態を作る。`[x]`の子Issueは「終了（成功）」として置き、グラフから消さない
 * （依存先として残すため）。番号の重複・不正、並列上限の範囲外は例外にする
 * （呼び出し側が先に検証する前提）。
 */
export function createRoadmapRun(input: CreateRoadmapRunInput): RoadmapRun {
  if (!isValidMaxParallel(input.maxParallel)) {
    throw new Error(`並列上限は1〜${MAX_ROADMAP_PARALLEL}の整数: ${String(input.maxParallel)}`);
  }
  const at = input.now.toISOString();
  const issues: Record<string, RoadmapIssueExecution> = {};
  for (const child of input.children) {
    const key = issueKey(child.issueNumber);
    if (Object.hasOwn(issues, key)) {
      throw new Error(`子Issueが重複: #${key}`);
    }
    issues[key] = {
      issueNumber: child.issueNumber,
      title: child.title,
      checkedAtStart: child.checked,
      executionId: input.newExecutionId(child.issueNumber),
      progress: child.checked ? 'done' : 'notStarted',
      phase: undefined,
      attention: 'none',
      result: child.checked ? 'succeeded' : undefined,
      attempts: [],
      currentAttemptId: undefined,
      worktreePath: undefined,
      branch: undefined,
      pullRequest: undefined,
      failure: undefined,
      updatedAt: at,
    };
  }
  return {
    schemaVersion: ROADMAP_RUN_SCHEMA_VERSION,
    runId: input.runId,
    roadmapIssueNumber: input.roadmapIssueNumber,
    workspaceRoot: input.workspaceRoot,
    engine: input.engine,
    mode: input.mode,
    maxParallel: input.maxParallel,
    startedAt: at,
    finishedAt: undefined,
    plan: input.plan,
    issues,
    haltedByUser: false,
  };
}

export function getIssue(run: RoadmapRun, issueNumber: number): RoadmapIssueExecution | undefined {
  if (!isValidIssueNumber(issueNumber)) {
    return undefined;
  }
  const key = String(issueNumber);
  return Object.hasOwn(run.issues, key) ? run.issues[key] : undefined;
}

function withIssue(run: RoadmapRun, next: RoadmapIssueExecution): RoadmapRun {
  return { ...run, issues: { ...run.issues, [issueKey(next.issueNumber)]: next } };
}

/** 現在の実行回を閉じる。実行回が無ければそのまま返す。 */
function endCurrentAttempt(issue: RoadmapIssueExecution, at: string): RoadmapIssueExecution {
  if (issue.currentAttemptId === undefined) {
    return issue;
  }
  const id = issue.currentAttemptId;
  return {
    ...issue,
    attempts: issue.attempts.map((a) =>
      a.attemptId === id && a.endedAt === undefined ? { ...a, endedAt: at } : a,
    ),
    currentAttemptId: undefined,
  };
}

/**
 * Issueセッションからの報告を受け付けてよいかを判定する。現在の実行と実行回に一致する
 * ものだけを受け付ける。自動引き継ぎで新しい実行回へ替わった後に古いセッションから
 * 届いた報告や、リロードで実行回が閉じた後に届いた報告は拒否する。
 */
export function checkReport(
  run: RoadmapRun,
  ref: IssueReportRef,
): { ok: true; issue: RoadmapIssueExecution } | { ok: false; reason: ReportRejection } {
  const issue = getIssue(run, ref.issueNumber);
  if (issue === undefined) {
    return { ok: false, reason: 'unknownIssue' };
  }
  if (issue.executionId !== ref.executionId) {
    return { ok: false, reason: 'executionMismatch' };
  }
  if (issue.currentAttemptId === undefined) {
    return { ok: false, reason: 'noActiveAttempt' };
  }
  if (issue.currentAttemptId !== ref.attemptId) {
    return { ok: false, reason: 'attemptMismatch' };
  }
  return { ok: true, issue };
}

/**
 * 新しい実行回を始める。前の実行回は閉じ、以後は新しい`attemptId`の報告だけを受け付ける。
 * 終わったノードでは何もしない。`mergeRepair`の実行回は工程を`mergeRepair`にし、
 * それ以外は直前の工程（未着手なら`implement`）を引き継ぐ。
 */
export function startAttempt(
  run: RoadmapRun,
  issueNumber: number,
  attempt: { attemptId: string; kind: IssueAttemptKind; sessionRef: string | undefined },
  now: Date,
): RoadmapRun {
  const issue = getIssue(run, issueNumber);
  if (issue === undefined || issue.progress === 'done') {
    return run;
  }
  const at = now.toISOString();
  const closed = endCurrentAttempt(issue, at);
  const phase: IssuePhase =
    attempt.kind === 'mergeRepair' ? 'mergeRepair' : (issue.phase ?? 'implement');
  return withIssue(run, {
    ...closed,
    progress: 'running',
    phase,
    attention: 'none',
    result: undefined,
    failure: undefined,
    attempts: [
      ...closed.attempts,
      {
        attemptId: attempt.attemptId,
        kind: attempt.kind,
        startedAt: at,
        endedAt: undefined,
        sessionRef: attempt.sessionRef,
      },
    ],
    currentAttemptId: attempt.attemptId,
    updatedAt: at,
  });
}

/**
 * Issueセッションが報告した工程を表示へ反映する。受け付けない報告と、
 * セッションが自己申告してよい工程（`SESSION_REPORTABLE_PHASES`）以外は無視する。
 * merge以降の工程はControllerが観測した事実でだけ進める。
 *
 * 同じ実行回の中での報告の順序は保証しない（遅れて届いた報告で表示が一時的に戻りうる）。
 * 表示を補うだけの値のため、順序番号は持たせない。
 */
export function applySessionPhase(
  run: RoadmapRun,
  ref: IssueReportRef,
  phase: IssuePhase,
  now: Date,
): RoadmapRun {
  const checked = checkReport(run, ref);
  if (!checked.ok || !SESSION_REPORTABLE_PHASES.includes(phase)) {
    return run;
  }
  const { issue } = checked;
  if (issue.phase === phase || issue.progress !== 'running') {
    return run;
  }
  return withIssue(run, { ...issue, phase, updatedAt: now.toISOString() });
}

/**
 * Issueセッションが`ready_for_merge`を報告した。実行回を閉じてmerge待ちにする。
 * `ready_for_merge`はIssueの終了ではなく、ノードはmergeとcleanupが済むまで終わらない。
 * PRの存在はControllerが確かめてから呼ぶ前提。
 */
export function markReadyForMerge(
  run: RoadmapRun,
  ref: IssueReportRef,
  pullRequest: { number: number; url: string },
  now: Date,
): RoadmapRun {
  const checked = checkReport(run, ref);
  if (!checked.ok) {
    return run;
  }
  const at = now.toISOString();
  return withIssue(run, {
    ...endCurrentAttempt(checked.issue, at),
    progress: 'running',
    phase: 'awaitingMerge',
    attention: 'none',
    pullRequest,
    updatedAt: at,
  });
}

/** mergeとcleanupが済んだ。ノードを終了（成功）にする。 */
export function markIssueDone(run: RoadmapRun, issueNumber: number, now: Date): RoadmapRun {
  const issue = getIssue(run, issueNumber);
  if (issue === undefined || issue.progress === 'done') {
    return run;
  }
  const at = now.toISOString();
  return withIssue(run, {
    ...endCurrentAttempt(issue, at),
    progress: 'done',
    phase: undefined,
    attention: 'none',
    result: 'succeeded',
    failure: undefined,
    updatedAt: at,
  });
}

/**
 * ユーザーがノードを停止した。セッションの終了はControllerが確かめてから呼ぶ前提。
 * worktreeとブランチは残し、再実行（`retry`の実行回）で引き継げるようにする。
 */
export function markIssueStopped(run: RoadmapRun, issueNumber: number, now: Date): RoadmapRun {
  const issue = getIssue(run, issueNumber);
  if (issue === undefined || issue.progress === 'done' || issue.result === 'stopped') {
    return run;
  }
  const at = now.toISOString();
  return withIssue(run, {
    ...endCurrentAttempt(issue, at),
    progress: 'halted',
    attention: 'none',
    result: 'stopped',
    failure: undefined,
    updatedAt: at,
  });
}

/**
 * 一時停止か停止の要求を出した。ターンの中断と子プロセスの停止を確かめるまでは
 * 「停止処理中」とし、中断の要求を送っただけで一時停止・停止とは表示しない。
 * セッションが動いていないノード（未着手、merge待ち以降、止まっているノード）では何もしない。
 */
export function markIssueStopping(run: RoadmapRun, issueNumber: number, now: Date): RoadmapRun {
  const issue = getIssue(run, issueNumber);
  if (
    issue === undefined ||
    issue.progress !== 'running' ||
    issue.currentAttemptId === undefined ||
    issue.attention === 'stopping'
  ) {
    return run;
  }
  return withIssue(run, { ...issue, attention: 'stopping', updatedAt: now.toISOString() });
}

/**
 * ターンの中断と子プロセスの停止を確かめた。実行回を閉じて一時停止にする。
 * 以後、中断したセッションからの報告は`noActiveAttempt`で拒否される。再開は
 * `resume`の実行回で行い、閉じた実行回の`sessionRef`から同じセッションを優先して使う。
 */
export function markIssuePaused(run: RoadmapRun, issueNumber: number, now: Date): RoadmapRun {
  const issue = getIssue(run, issueNumber);
  if (issue === undefined || issue.progress !== 'running' || issue.currentAttemptId === undefined) {
    return run;
  }
  const at = now.toISOString();
  return withIssue(run, {
    ...endCurrentAttempt(issue, at),
    progress: 'halted',
    attention: 'paused',
    updatedAt: at,
  });
}

/** run全体を止める・止めを解く。止めている間、スケジューラは新しいノードを始めない。 */
export function setRunHaltedByUser(run: RoadmapRun, halted: boolean): RoadmapRun {
  return run.haltedByUser === halted ? run : { ...run, haltedByUser: halted };
}

/** すべてのノードが終わっていれば、runの終了時刻を記録する。 */
export function finishRunIfDone(run: RoadmapRun, now: Date): RoadmapRun {
  if (run.finishedAt !== undefined) {
    return run;
  }
  const allDone = Object.values(run.issues).every((issue) => issue.progress === 'done');
  return allDone ? { ...run, finishedAt: now.toISOString() } : run;
}

/** モードと並列上限を変える。実行中のセッションには影響しない（止めるかどうかはスケジューラが決める）。 */
export function setRunMode(run: RoadmapRun, mode: RoadmapRunMode, maxParallel: number): RoadmapRun {
  if (!isValidMaxParallel(maxParallel)) {
    throw new Error(`並列上限は1〜${MAX_ROADMAP_PARALLEL}の整数: ${String(maxParallel)}`);
  }
  if (run.mode === mode && run.maxParallel === maxParallel) {
    return run;
  }
  return { ...run, mode, maxParallel };
}

/** リロード時に突き合わせる外部の状態。確かめられなかった項目は`undefined`にする。 */
export interface IssueExternalFacts {
  pullRequestMerged: boolean | undefined;
  worktreeExists: boolean | undefined;
}

/**
 * ウィンドウの再読み込みや拡張ホストの再起動の後、永続化した状態を外部の状態と突き合わせる。
 *
 * - PRがmerge済み: worktreeが残っていればcleanupの工程へ、無ければ終了（成功）にする
 * - 実行中だったセッションはリロードで失われているため、実行回を閉じて一時停止にする
 *   （以後、旧セッションからの報告は`noActiveAttempt`で拒否される）
 * - merge中だったノードはmergeの鍵が失われているため、merge待ちへ戻して並び直させる
 * - 着手済みでworktreeが無くなっていたら、失敗（要対応）にする
 * - ユーザーが停止したノードは、PRがmerge済みのときだけ上の通り進め、それ以外は触らない
 *
 * merge待ち・cleanupのノードはセッションを持たないので、そのまま残す（Controllerが再開する）。
 */
export function reconcileRoadmapRunOnReload(
  run: RoadmapRun,
  factsFor: (issueNumber: number) => IssueExternalFacts,
  now: Date,
): RoadmapRun {
  const at = now.toISOString();
  let next = run;
  for (const issue of Object.values(run.issues)) {
    if (issue.progress === 'done' || issue.progress === 'notStarted') {
      continue;
    }
    const facts = factsFor(issue.issueNumber);
    let updated: RoadmapIssueExecution = issue;
    if (facts.pullRequestMerged === true) {
      updated =
        facts.worktreeExists === false
          ? {
              ...endCurrentAttempt(issue, at),
              progress: 'done',
              phase: undefined,
              attention: 'none',
              result: 'succeeded',
              failure: undefined,
            }
          : {
              ...endCurrentAttempt(issue, at),
              progress: 'running',
              phase: 'cleanup',
              attention: 'none',
              result: undefined,
              failure: undefined,
            };
    } else if (issue.result === 'stopped') {
      // ユーザーが止めたノード。停止後にworktreeを片付けても失敗へすり替えない
      continue;
    } else if (
      issue.worktreePath !== undefined &&
      facts.worktreeExists === false &&
      issue.attention !== 'failed'
    ) {
      updated = {
        ...endCurrentAttempt(issue, at),
        progress: 'halted',
        attention: 'failed',
        failure: `worktreeが見つかりません: ${issue.worktreePath}`,
      };
    } else if (issue.phase === 'merging') {
      updated = { ...endCurrentAttempt(issue, at), phase: 'awaitingMerge', attention: 'none' };
    } else if (issue.currentAttemptId !== undefined) {
      updated = { ...endCurrentAttempt(issue, at), progress: 'halted', attention: 'paused' };
    }
    if (updated !== issue) {
      next = withIssue(next, { ...updated, updatedAt: at });
    }
  }
  return next;
}
