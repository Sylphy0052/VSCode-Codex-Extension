import { isTaskRunActive, listTasks, type TaskRun } from '../orchestrator/taskRunState';
import { buildTaskRunPendingItem, MAX_PENDING_ITEMS, type PendingItem } from './pendingItem';

/**
 * task runの質問（ユーザーの判断待ち）をsession-hubへ公開する口（Issue #2135）。
 *
 * `taskRunSetup.ts`が実体を入れ、`extension.ts`が共有ファイルへ載せる・回答を流すのに使う。
 * task runの質問の待ち受けは専有権（lease）を持つウィンドウにしか無いため、公開するのも
 * 専有権を持つrunの分だけにする（複数のウィンドウが同じ質問を重ねて出さないように）。
 */
export interface TaskRunPendingPort {
  list(windowId: string): PendingItem[];
  /** 既存の回答経路（`TaskRunController.answerQuestion`）へ渡す。 */
  answer(
    runId: string,
    taskId: string,
    questionId: string,
    answer: string,
  ): Promise<{ ok: boolean; message: string }>;
  onDidChange(listener: () => void): { dispose(): void };
}

/** 専有権を持つ進行中のrunから、ユーザーの判断待ちの質問を集める。 */
export function listTaskRunPendingItems(
  runs: readonly TaskRun[],
  holds: (runId: string) => boolean,
  windowId: string,
): PendingItem[] {
  const items: PendingItem[] = [];
  for (const run of runs) {
    if (!isTaskRunActive(run) || !holds(run.runId)) {
      continue;
    }
    for (const task of listTasks(run)) {
      for (const q of task.questions ?? []) {
        if (q.status !== 'awaitingUser') {
          continue;
        }
        items.push(
          buildTaskRunPendingItem(windowId, {
            runId: run.runId,
            engine: run.engine,
            workspaceRoot: run.workspaceRoot,
            taskId: task.taskId,
            taskTitle: task.title,
            questionId: q.questionId,
            question: q.question,
            options: q.options,
            askedAt: q.askedAt,
          }),
        );
      }
    }
  }
  return items.slice(0, MAX_PENDING_ITEMS);
}
