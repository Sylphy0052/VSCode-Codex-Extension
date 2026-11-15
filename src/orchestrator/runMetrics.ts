import type {
  OrchestratedTask,
  StageDecider,
  StageGate,
  StageQuestion,
  TaskRun,
} from './taskRunState';

/**
 * runごとの指標（Issue #2081）。runの終了時に拡張が計算して記録する。LLMには書かせない。
 * 版はPRごとに上がり、1つの版で走るrunは1本前後なので、版の前後では比べられない。
 * 群分けの鍵（`RunMetricsKeys`）を添えて、同じ条件のrun同士を比べられるようにする。
 *
 * ここは純関数だけ。ファイルへの書き込みと鍵の収集は`runMetricsStore.ts`。
 */

/**
 * 件数のうち、関門・質問が上限で刈られて数えられなくなった分（`MAX_GATES_PER_TASK`など）。
 * 刈る前に足しておき、終了時に今残っている分と合わせて数える。
 */
export interface TaskMetricsTally {
  /** 刈られた決着済みの関門の件数（決着者別）。 */
  prunedGatesResolved?: Partial<Record<StageDecider, number>>;
  /** 刈られた関門のうち、Reflexかオーケストレーターが「やり直す」で決着した件数。 */
  prunedAutoRetries?: number;
  /** これまでに受け付けた質問の総数（質問が刈られても減らない）。 */
  questionsAsked?: number;
  /** 工程の送信回数を使い切って止まった（`maxReached`）回数。 */
  maxReached?: number;
}

/** 群分けの鍵。比べるのは鍵が同じrun同士だけ。 */
export interface RunMetricsKeys {
  extensionVersion: string;
  /** 工程プロンプトの雛形のハッシュ。 */
  promptHash: string;
  /** 工程の上限値（送信回数など）のハッシュ。 */
  limitsHash: string;
  /** `~/.claude`のplugin由来ファイルのハッシュ。取れなければ`undefined`。 */
  pluginHash: string | undefined;
  /** pluginごとの同期元のcommit SHA。取れた分だけ。 */
  pluginCommits: Readonly<Record<string, string>>;
}

export interface RunMetrics {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** 子Issue（タスク）の数。 */
  childIssues: number;
  /** レビュー後に実装へ差し戻した回数の合計。 */
  sendBacks: number;
  /** 工程の自動やり直し（Reflexかオーケストレーターが決めた）の回数。 */
  autoRetries: number;
  maxReached: number;
  questions: number;
  /**
   * 最適化のループ（Issue #2111）が回した試行の回数の合計（中断を含む）。試行のセッションは
   * 通常の工程セッションとは別に数える。
   */
  optimizeTrials: number;
  /** 決着した関門の件数（決着者別）。刈られた分を含む。 */
  gatesResolved: Record<StageDecider, number>;
  /** 子Issueあたりの所要時間（ミリ秒）。子Issueが0件なら`undefined`。 */
  msPerChildIssue: number | undefined;
  keys: RunMetricsKeys;
}

const DECIDERS: readonly StageDecider[] = ['reflex', 'orchestrator', 'user'];

/** Reflexまたはオーケストレーターの判断で工程をやり直した関門か（ユーザーの判断は数えない）。 */
export function isAutoRetryGate(gate: StageGate): boolean {
  return (
    gate.kind === 'stageFailed' &&
    gate.resolution !== undefined &&
    gate.resolution.by !== 'user' &&
    gate.resolution.choice === 'retry'
  );
}

/** 関門を刈る前に呼び、刈る分の件数を`metricsTally`へ足したタスクを返す。 */
export function tallyPrunedGates(
  task: OrchestratedTask,
  pruned: readonly StageGate[],
): TaskMetricsTally {
  const tally = task.metricsTally ?? {};
  const resolved: Partial<Record<StageDecider, number>> = { ...tally.prunedGatesResolved };
  let autoRetries = tally.prunedAutoRetries ?? 0;
  for (const gate of pruned) {
    if (gate.resolution !== undefined) {
      resolved[gate.resolution.by] = (resolved[gate.resolution.by] ?? 0) + 1;
    }
    if (isAutoRetryGate(gate)) {
      autoRetries += 1;
    }
  }
  return { ...tally, prunedGatesResolved: resolved, prunedAutoRetries: autoRetries };
}

/** 質問を1件受け付けたあとの`metricsTally`。`existing`は受け付ける前に残っていた質問。 */
export function tallyQuestionAsked(
  task: OrchestratedTask,
  existing: readonly StageQuestion[],
): TaskMetricsTally {
  const tally = task.metricsTally ?? {};
  // 追加前に保存したrunは総数を持たないので、残っている件数から数え始める
  const before = Math.max(tally.questionsAsked ?? 0, existing.length);
  return { ...tally, questionsAsked: before + 1 };
}

/** `maxReached`で止まった回数を1つ増やす。 */
export function tallyMaxReached(task: OrchestratedTask): TaskMetricsTally {
  const tally = task.metricsTally ?? {};
  return { ...tally, maxReached: (tally.maxReached ?? 0) + 1 };
}

/** タスクの`maxReached`回数を1つ増やしたrunを返す。タスクが無ければそのまま。 */
export function recordMaxReached(run: TaskRun, taskId: string): TaskRun {
  const task = run.tasks[taskId];
  if (task === undefined) {
    return run;
  }
  return {
    ...run,
    tasks: { ...run.tasks, [taskId]: { ...task, metricsTally: tallyMaxReached(task) } },
  };
}

/** runの指標を計算する。純関数。`run.finishedAt`が無ければ`undefined`。 */
export function computeRunMetrics(run: TaskRun, keys: RunMetricsKeys): RunMetrics | undefined {
  if (run.finishedAt === undefined) {
    return undefined;
  }
  const tasks = Object.values(run.tasks);
  const gatesResolved: Record<StageDecider, number> = { reflex: 0, orchestrator: 0, user: 0 };
  let sendBacks = 0;
  let autoRetries = 0;
  let maxReached = 0;
  let questions = 0;
  let optimizeTrials = 0;
  for (const task of tasks) {
    const tally = task.metricsTally;
    sendBacks += task.reviewRounds ?? 0;
    optimizeTrials += task.optimizeLoop?.trials ?? 0;
    maxReached += tally?.maxReached ?? 0;
    questions += Math.max(tally?.questionsAsked ?? 0, task.questions?.length ?? 0);
    autoRetries += tally?.prunedAutoRetries ?? 0;
    for (const decider of DECIDERS) {
      gatesResolved[decider] += tally?.prunedGatesResolved?.[decider] ?? 0;
    }
    for (const gate of task.gates ?? []) {
      if (gate.resolution !== undefined) {
        gatesResolved[gate.resolution.by] += 1;
      }
      if (isAutoRetryGate(gate)) {
        autoRetries += 1;
      }
    }
  }
  const elapsed = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return {
    schemaVersion: 1,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    childIssues: tasks.length,
    sendBacks,
    autoRetries,
    maxReached,
    questions,
    optimizeTrials,
    gatesResolved,
    msPerChildIssue:
      tasks.length === 0 || !Number.isFinite(elapsed)
        ? undefined
        : Math.round(Math.max(0, elapsed) / tasks.length),
    keys,
  };
}
