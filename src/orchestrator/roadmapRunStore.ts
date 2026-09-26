import { ROADMAP_RUN_SCHEMA_VERSION, type RoadmapRun } from './roadmapRunState';
import type { MementoLike } from '../util/memento';
import { SerialQueue } from './serialQueue';

/**
 * ロードマップ実行（Issue #1465）のController状態の永続化。
 *
 * `programStore.ts`の`ProgramStore`と同じく、`workspaceState`への読み書きを1本のキューに
 * 通して直列化する。`workspaceState`は暗号化されない平文ストレージのため、応答本文や
 * 会話履歴は持たない（`RoadmapRun`が持つのは状態と識別子、外部由来のIssueタイトルだけ）。
 *
 * リロード後の外部状態との突き合わせは、PRやworktreeの確認に時間がかかるため
 * キューの外で集め、`update`へ`reconcileRoadmapRunOnReload`を渡して書き戻す。
 */

export const ROADMAP_RUNS_KEY = 'codex.roadmapRuns';

/** 走り終えたrunも含めて残す最大件数。 */
export const MAX_STORED_ROADMAP_RUNS = 10;

function trimRuns(runs: readonly RoadmapRun[]): RoadmapRun[] {
  return [...runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_STORED_ROADMAP_RUNS);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 遷移関数が前提にする骨格（版、識別子、`issues`、`plan.nodes`）だけを確かめる。
 * 骨格の壊れた要素を読んで遷移関数が例外で落ちないようにする。
 */
function isStoredRoadmapRun(r: unknown): r is RoadmapRun {
  return (
    isPlainObject(r) &&
    r.schemaVersion === ROADMAP_RUN_SCHEMA_VERSION &&
    typeof r.runId === 'string' &&
    typeof r.startedAt === 'string' &&
    isPlainObject(r.issues) &&
    Object.values(r.issues).every(isPlainObject) &&
    isPlainObject(r.plan) &&
    Array.isArray(r.plan.nodes)
  );
}

export class RoadmapRunStore {
  private readonly queue = new SerialQueue();

  constructor(private readonly memento: MementoLike) {}

  /** 版の合わない（将来の形式や壊れた）要素は読み飛ばす。 */
  list(): readonly RoadmapRun[] {
    const raw = this.memento.get<unknown>(ROADMAP_RUNS_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(isStoredRoadmapRun);
  }

  find(runId: string): RoadmapRun | undefined {
    return this.list().find((r) => r.runId === runId);
  }

  /** 同じワークスペースで、指定のロードマップIssueを実行中のrun。 */
  findActive(workspaceRoot: string, roadmapIssueNumber: number): RoadmapRun | undefined {
    return this.list().find(
      (r) =>
        r.workspaceRoot === workspaceRoot &&
        r.roadmapIssueNumber === roadmapIssueNumber &&
        r.finishedAt === undefined,
    );
  }

  /**
   * このsessionIdがいずれかのrunのIssueセッション（過去の実行回を含む）かOrchestratorセッション（全世代。
   * Issue #1465 分割案8b）かどうか（Issue #1491）。
   * リロード後の汎用復元（`restorePanel`）から、入力を閉じるべきタブを外す判定に使う。
   * メモリ上の実行状態はリロード直後に空なので、`WorkflowRunner.isTaskManagedSessionId`と
   * 同じく永続化した側を見る。
   */
  hasSessionRef(sessionId: string): boolean {
    if (sessionId === '') {
      return false;
    }
    return this.list().some(
      (run) =>
        (Array.isArray(run.orchestratorSessionRefs) && run.orchestratorSessionRefs.includes(sessionId)) ||
        Object.values(run.issues).some(
          (issue) =>
            Array.isArray(issue.attempts) && issue.attempts.some((a) => a.sessionRef === sessionId),
        ),
    );
  }

  /**
   * 指定runIdの内容を関数で更新する。直列化されるため、読み・書きの間に別の更新が
   * 割り込まない。未登録なら新規追加する。更新後の値を返す。
   */
  update(
    runId: string,
    updater: (current: RoadmapRun | undefined) => RoadmapRun,
  ): Promise<RoadmapRun> {
    return this.queue.enqueue(async () => {
      const all = this.list();
      const index = all.findIndex((r) => r.runId === runId);
      const current = index === -1 ? undefined : all[index];
      const next = updater(current);
      if (next === current) {
        return next;
      }
      const merged = index === -1 ? [next, ...all] : all.map((r, i) => (i === index ? next : r));
      await this.memento.update(ROADMAP_RUNS_KEY, trimRuns(merged));
      return next;
    });
  }

  clearAll(): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.memento.update(ROADMAP_RUNS_KEY, []);
    });
  }
}
