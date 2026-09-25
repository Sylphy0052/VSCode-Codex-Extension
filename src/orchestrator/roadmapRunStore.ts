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

export class RoadmapRunStore {
  private readonly queue = new SerialQueue();

  constructor(private readonly memento: MementoLike) {}

  /** 版の合わない（将来の形式や壊れた）要素は読み飛ばす。 */
  list(): readonly RoadmapRun[] {
    const raw = this.memento.get<unknown>(ROADMAP_RUNS_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(
      (r): r is RoadmapRun =>
        typeof r === 'object' &&
        r !== null &&
        (r as { schemaVersion?: unknown }).schemaVersion === ROADMAP_RUN_SCHEMA_VERSION,
    );
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
