import { isTaskRunActive, TASK_RUN_SCHEMA_VERSION, type TaskRun } from './taskRunState';
import type { MementoLike } from '../util/memento';
import { isPlainObject, MementoRunStore } from './mementoRunStore';

/**
 * オーケストレータモード（Issue #1505）のController状態の永続化。直列化と保存の骨組みは
 * `mementoRunStore.ts`で、ロードマップ実行（`roadmapRunStore.ts`）とはキーを分ける。
 * `workspaceState`は暗号化されない平文ストレージのため、応答本文や会話履歴は持たない
 * （`TaskRun`が持つのは状態と識別子、計画とIssue下書き等の工程の成果だけ）。
 */

export const TASK_RUNS_KEY = 'codex.taskRuns';

/** 走り終えたrunも含めて残す最大件数。 */
export const MAX_STORED_TASK_RUNS = 10;

/**
 * 遷移関数が前提にする骨格（版、識別子、`tasks`と各タスクの`stages`、`taskOrder`）だけを
 * 確かめる。骨格の壊れた要素を読んで遷移関数が例外で落ちないようにする。
 */
function isStoredTaskRun(r: unknown): r is TaskRun {
  return (
    isPlainObject(r) &&
    r.schemaVersion === TASK_RUN_SCHEMA_VERSION &&
    typeof r.runId === 'string' &&
    typeof r.startedAt === 'string' &&
    typeof r.workspaceRoot === 'string' &&
    Array.isArray(r.taskOrder) &&
    Array.isArray(r.orchestratorSessionRefs) &&
    isPlainObject(r.tasks) &&
    Object.values(r.tasks).every(
      (task) =>
        isPlainObject(task) &&
        isPlainObject(task.stages) &&
        Object.values(task.stages).every(
          (stage) => isPlainObject(stage) && Array.isArray(stage.attempts),
        ),
    )
  );
}

export class TaskRunStore extends MementoRunStore<TaskRun> {
  constructor(memento: MementoLike) {
    super(memento, {
      key: TASK_RUNS_KEY,
      maxStored: MAX_STORED_TASK_RUNS,
      isValid: isStoredTaskRun,
      // 中断中のrunを、新しいrunを重ねたときに捨てない（Issue #1560）
      isFinished: (run) => run.finishedAt !== undefined,
    });
  }

  /** 同じワークスペースで動いているrun（中断中を除く）。あれば新しいrunを作らずにこれを開く。 */
  findActive(workspaceRoot: string): TaskRun | undefined {
    return this.list().find((r) => r.workspaceRoot === workspaceRoot && isTaskRunActive(r));
  }

  /**
   * このsessionIdがいずれかのrunの工程セッション（過去の実行回を含む）かOrchestratorセッション
   * （全世代）かどうか。リロード後の汎用復元から、入力を閉じるべきタブを外す判定に使う。
   */
  hasSessionRef(sessionId: string): boolean {
    if (sessionId === '') {
      return false;
    }
    return this.list().some(
      (run) =>
        run.orchestratorSessionRefs.includes(sessionId) ||
        Object.values(run.tasks).some((task) =>
          Object.values(task.stages).some((stage) =>
            stage.attempts.some((a) => a.sessionRef === sessionId),
          ),
        ),
    );
  }
}
