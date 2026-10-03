import { checkIssueChecklistItems } from './roadmap';
import type { RoadmapChild } from './roadmapImport';
import { SerialQueue } from './serialQueue';
import type { TaskRunRoadmapPort } from './taskRunRoadmapForge';
import {
  appendRoadmapChild,
  buildRoadmapPlanNodes,
  buildRoadmapSnapshot,
  diffRoadmapSnapshots,
  taskIssueNumber,
  type RoadmapChangeDraft,
} from './taskRunRoadmap';
import {
  getTask,
  listTasks,
  MAX_ROADMAP_NOTICES,
  type TaskRun,
  type TaskRunRoadmapNotice,
  type TaskRunRoadmapSnapshot,
} from './taskRunState';
import type { IssueState } from './taskStageObservation';
import { sanitizeInlineText } from './untrustedText';

/**
 * 実行中のロードマップIssueの変化への追従と、ロードマップ本文への書き戻し（Issue #1623）。
 *
 * - 読み直し: 本文を取り直して`run.roadmap.snapshot`と比べ、差分を`run.roadmap.notices`へ足す
 *   （Orchestratorへは`diffTaskRunEvents`がイベントにして届ける）。計画は変えない。計画の変更は
 *   Orchestratorが`propose_plan`で出す
 * - 書き戻し: mergeが済んだ子Issueの行を`[x]`にする、Orchestratorが作ったIssueの行を足す、
 *   承認された計画を計画区画へ書く
 *
 * ロードマップの読み書きはすべて1本の列で直列にする（行を足してから計画区画を書く、の順を保つため）。
 */

const WARNING_TEXT_MAX_LENGTH = 300;

export type RoadmapFollowResult = { ok: true; message: string } | { ok: false; message: string };

export interface TaskRunRoadmapFollowerDeps {
  port: TaskRunRoadmapPort;
  find(runId: string): TaskRun | undefined;
  updateRun(runId: string, fn: (run: TaskRun) => TaskRun): Promise<TaskRun | undefined>;
  fetchIssueState(workspaceRoot: string, issueNumber: number): Promise<IssueState>;
  log(message: string): void;
  now(): Date;
  newId(): string;
}

export class TaskRunRoadmapFollower {
  private readonly queue = new SerialQueue();

  constructor(private readonly deps: TaskRunRoadmapFollowerDeps) {}

  /** ロードマップを読み直す（Kanbanの操作とOrchestratorの`sync_roadmap`）。 */
  sync(runId: string): Promise<RoadmapFollowResult> {
    return this.queue.enqueue(() => this.syncNow(runId));
  }

  /** タスクのmergeと後片付けが済んだ。該当行を`[x]`にしてから読み直す。 */
  handleTaskMerged(runId: string, taskId: string): void {
    this.enqueueInBackground(runId, async () => {
      const run = this.deps.find(runId);
      const task = run === undefined ? undefined : getTask(run, taskId);
      const issueNumber = task === undefined ? undefined : taskIssueNumber(task);
      if (run?.roadmap === undefined || issueNumber === undefined) {
        return;
      }
      await this.deps.updateRun(runId, (r) =>
        r.roadmap === undefined || r.roadmap.mergedIssueNumbers?.includes(issueNumber) === true
          ? r
          : {
              ...r,
              roadmap: {
                ...r.roadmap,
                mergedIssueNumbers: [...(r.roadmap.mergedIssueNumbers ?? []), issueNumber],
              },
            },
      );
      const edited = await this.deps.port.edit(
        run.workspaceRoot,
        run.roadmap.issueNumber,
        (body) => {
          const update = checkIssueChecklistItems(body, [issueNumber]);
          return update.checked.length > 0 ? update.body : undefined;
        },
      );
      if (edited.kind === 'failed') {
        await this.warn(
          runId,
          `ロードマップの#${String(issueNumber)}の行を[x]にできませんでした: ${edited.message}`,
        );
      }
      await this.syncNow(runId);
    });
  }

  /**
   * runの状態の変化を見て書き戻す。Orchestratorが作ったIssueはチェックリストへ足し、承認済みの
   * 計画が変わったら計画区画へ書く。
   */
  observe(prev: TaskRun | undefined, next: TaskRun): void {
    if (next.roadmap === undefined || prev === undefined || next.finishedAt !== undefined) {
      return;
    }
    for (const task of listTasks(next)) {
      const before = getTask(prev, task.taskId);
      if (
        task.existingIssueNumber === undefined &&
        task.issueNumber !== undefined &&
        before !== undefined &&
        before.issueNumber === undefined
      ) {
        const issueNumber = task.issueNumber;
        const title = task.issueDraft?.title ?? task.title;
        this.enqueueInBackground(next.runId, () =>
          this.appendChild(next.runId, issueNumber, title),
        );
      }
    }
    if (
      next.planStatus === 'approved' &&
      (prev.planStatus !== 'approved' || planKey(prev) !== planKey(next))
    ) {
      this.enqueueInBackground(next.runId, () => this.writePlan(next.runId));
    }
  }

  private async syncNow(runId: string): Promise<RoadmapFollowResult> {
    const run = this.deps.find(runId);
    if (run?.roadmap === undefined) {
      return { ok: false, message: 'このrunはロードマップIssueから始めたrunではない' };
    }
    const before = run.roadmap.snapshot;
    const read = await this.deps.port.read(run.workspaceRoot, run.roadmap.issueNumber);
    if (read.kind === 'failed') {
      const message = `ロードマップを読み直せませんでした（状態は変えていません）: ${read.message}`;
      await this.warn(runId, message);
      return { ok: false, message: sanitizeInlineText(message, WARNING_TEXT_MAX_LENGTH) };
    }
    const closedIssueNumbers = await findClosedRoadmapChildren(
      (n) => this.deps.fetchIssueState(run.workspaceRoot, n),
      read.children,
    );
    const warnings: string[] = [];
    let planNodes: TaskRunRoadmapSnapshot['plan'];
    let planSectionHash: string | undefined;
    let planErrors: string | undefined;
    switch (read.plan.kind) {
      case 'absent':
        break;
      case 'valid':
        planNodes = read.plan.nodes;
        planSectionHash = read.plan.sectionHash;
        break;
      case 'invalid':
        // 読めない区画で計画の差分を作らない。人が直すまで前回の区画を基準にする
        planNodes = before.plan;
        planSectionHash = before.planSectionHash;
        planErrors = read.plan.errors.join(' / ');
        // 前回と同じ理由なら警告し直さない（差分が無ければ知らせない）
        if (planErrors !== before.planErrors) {
          warnings.push(`ロードマップの計画区画を読めません: ${planErrors}`);
        }
        break;
    }
    const after: TaskRunRoadmapSnapshot = {
      ...buildRoadmapSnapshot({
        children: read.children,
        planNodes: planNodes?.map((n) => ({ ...n, wave: undefined })),
        planSectionHash,
        closedIssueNumbers,
        now: this.deps.now(),
      }),
      ...(planErrors === undefined ? {} : { planErrors }),
    };
    const drafts = diffRoadmapSnapshots(before, after, ownRoadmapChanges(run));
    const snapshotChanged = snapshotKey(before) !== snapshotKey(after);
    if (snapshotChanged || drafts.length > 0 || warnings.length > 0) {
      await this.deps.updateRun(runId, (r) =>
        r.roadmap === undefined
          ? r
          : withRoadmapNotices(
              { ...r, roadmap: { ...r.roadmap, snapshot: after } },
              [...drafts, ...warnings.map((body) => ({ kind: 'warning' as const, body }))],
              this.deps.now(),
              () => this.deps.newId(),
            ),
      );
    }
    return {
      ok: true,
      message:
        drafts.length === 0
          ? 'ロードマップに差分はありません'
          : `ロードマップの差分${String(drafts.length)}種をイベントで知らせます`,
    };
  }

  private async appendChild(runId: string, issueNumber: number, title: string): Promise<void> {
    const run = this.deps.find(runId);
    if (run?.roadmap === undefined) {
      return;
    }
    const edited = await this.deps.port.edit(run.workspaceRoot, run.roadmap.issueNumber, (body) =>
      appendRoadmapChild(body, issueNumber, title),
    );
    if (edited.kind === 'failed') {
      await this.warn(
        runId,
        `作ったIssue #${String(issueNumber)}をロードマップのチェックリストへ足せませんでした: ${edited.message}`,
      );
    }
  }

  private async writePlan(runId: string): Promise<void> {
    const run = this.deps.find(runId);
    if (run?.roadmap === undefined || run.planStatus !== 'approved') {
      return;
    }
    const { snapshot } = run.roadmap;
    // 区画に書く内容が前回読んだ・書いた区画と同じなら書かない（開始時に人の区画を整形し直さない）
    const known = buildRoadmapPlanNodes(run, snapshot.children.map(toRoadmapChild));
    if (snapshot.plan !== undefined && planText(known) === planText(snapshot.plan)) {
      return;
    }
    const written = await this.deps.port.writePlan(
      run.workspaceRoot,
      run.roadmap.issueNumber,
      (children) => buildRoadmapPlanNodes(run, children),
      snapshot.planSectionHash,
    );
    switch (written.kind) {
      case 'written':
        await this.deps.updateRun(runId, (r) =>
          r.roadmap === undefined
            ? r
            : {
                ...r,
                roadmap: {
                  ...r.roadmap,
                  snapshot: {
                    ...r.roadmap.snapshot,
                    plan: written.nodes.map((n) => ({
                      issueNumber: n.issueNumber,
                      dependsOn: [...n.dependsOn],
                    })),
                    planSectionHash: written.sectionHash,
                  },
                },
              },
        );
        return;
      case 'sectionChanged':
        await this.warn(
          runId,
          '承認した計画をロードマップの計画区画へ書き戻しませんでした。前回読んだ後に区画が手で直されています。' +
            'sync_roadmapで読み直し、区画の変更を計画に反映してから提案し直してください',
        );
        return;
      case 'failed':
        await this.warn(
          runId,
          `承認した計画をロードマップの計画区画へ書き戻せませんでした: ${written.message}`,
        );
        return;
    }
  }

  /** 呼び出し元が待たない処理を積む。失敗は呼び出し元へ届かないため、ここでログと警告に残す。 */
  private enqueueInBackground(runId: string, job: () => Promise<unknown>): void {
    void this.queue.enqueue(job).catch(async (error: unknown) => {
      const message = `ロードマップの追従に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
      await this.warn(runId, message).catch(() => {
        this.deps.log(`[task run] ${runId}: ${message}`);
      });
    });
  }

  private async warn(runId: string, message: string): Promise<void> {
    this.deps.log(`[task run] ${runId}: ${message}`);
    await this.deps.updateRun(runId, (r) =>
      withRoadmapNotices(r, [{ kind: 'warning', body: message }], this.deps.now(), () =>
        this.deps.newId(),
      ),
    );
  }
}

/** `- [ ]`のままcloseされている子Issue。状態を確かめられないIssueは含めない。 */
export async function findClosedRoadmapChildren(
  fetchIssueState: (issueNumber: number) => Promise<IssueState>,
  children: readonly RoadmapChild[],
): Promise<ReadonlySet<number>> {
  const open = children.filter((c) => !c.checked).map((c) => c.issueNumber);
  const states = await Promise.all(
    open.map((n) => fetchIssueState(n).catch((): IssueState => 'unknown')),
  );
  return new Set(open.filter((_, i) => states[i] === 'closed'));
}

/** ロードマップの記録を足す。ロードマップIssueから始めたrunでなければ何もしない。 */
export function withRoadmapNotices(
  run: TaskRun,
  drafts: readonly (RoadmapChangeDraft | { kind: 'warning'; body: string })[],
  now: Date,
  newId: () => string,
): TaskRun {
  if (run.roadmap === undefined || drafts.length === 0) {
    return run;
  }
  const at = now.toISOString();
  const added: TaskRunRoadmapNotice[] = drafts.map((d) => ({
    noticeId: newId(),
    kind: d.kind,
    body: d.kind === 'warning' ? sanitizeInlineText(d.body, WARNING_TEXT_MAX_LENGTH) : d.body,
    at,
  }));
  return {
    ...run,
    roadmap: {
      ...run.roadmap,
      notices: [...(run.roadmap.notices ?? []), ...added].slice(-MAX_ROADMAP_NOTICES),
    },
  };
}

function ownRoadmapChanges(run: TaskRun): {
  taskIssueNumbers: ReadonlySet<number>;
  mergedIssueNumbers: ReadonlySet<number>;
} {
  const tasks = Object.values(run.tasks);
  const numbered = (list: typeof tasks): Set<number> =>
    new Set(list.map((t) => taskIssueNumber(t)).filter((n): n is number => n !== undefined));
  return {
    taskIssueNumbers: numbered(tasks),
    mergedIssueNumbers: new Set([
      ...(run.roadmap?.mergedIssueNumbers ?? []),
      ...numbered(
        tasks.filter(
          (t) => t.completedInRoadmap !== true && t.stages.mergeCleanup.status === 'done',
        ),
      ),
    ]),
  };
}

function toRoadmapChild(child: TaskRunRoadmapSnapshot['children'][number]): RoadmapChild {
  return { issueNumber: child.issueNumber, title: child.title, checked: child.completed };
}

/** 計画区画へ書く内容に効くもの（Issueを持つタスクの並びと依存）。 */
function planKey(run: TaskRun): string {
  return listTasks(run)
    .map((t) => `${String(taskIssueNumber(t) ?? t.taskId)}<${t.dependsOn.join(',')}`)
    .join(' ');
}

function planText(plan: readonly { issueNumber: number; dependsOn: readonly number[] }[]): string {
  return plan.map((n) => `${String(n.issueNumber)}<${n.dependsOn.join(',')}`).join(' ');
}

function snapshotKey(snapshot: TaskRunRoadmapSnapshot): string {
  return JSON.stringify({ ...snapshot, readAt: undefined });
}
