import { randomUUID } from 'node:crypto';
import type { ForgeHost } from './forge';
import type { RoadmapImportTarget } from './roadmapImport';
import type { RoadmapIssueRunner, StartIssueOutcome } from './roadmapIssueRunner';
import type { ResolveRoadmapPlanOutcome, RoadmapPlanProposal } from './roadmapPlanProposal';
import {
  createRoadmapRun,
  finishRunIfDone,
  isValidIssueNumber,
  isValidMaxParallel,
  MAX_ROADMAP_PARALLEL,
  setRunHaltedByUser,
  setRunMode,
  type RoadmapRun,
  type RoadmapRunEngine,
  type RoadmapRunMode,
} from './roadmapRunState';
import type { RoadmapRunStore } from './roadmapRunStore';
import {
  assessRun,
  newlyFinishedIssues,
  newlyRunnableIssues,
  pickIssuesToStart,
} from './roadmapScheduler';
import { sanitizeInlineText } from './untrustedText';
import {
  buildRoadmapKanban,
  type RoadmapKanbanBoard,
  type RoadmapKanbanEvent,
} from '../view/roadmapKanbanModel';

/**
 * ロードマップ実行（Issue #1465）のController。runの開始（計画の決定と状態の作成）、
 * 自動実行の送り出し（`pump`）、Kanbanからの操作、通知をまとめる。
 *
 * Issueごとのセッションの操作は`RoadmapIssueRunner`が持ち、ここは次の判断だけをする。
 * - 状態が変わるたびに、自動実行なら空き枠を埋める。`pump`はrunごとに直列化し、実行中に
 *   来た要求は1回へまとめる（同時に走らせると並列上限を超えて始めうるため。#1484）
 * - 自動実行が人の対応待ちで止まったら、デスクトップ通知で知らせる（同じ待ちは1回だけ）
 * - Kanbanへ出す出来事（実行可能になった・終了した・警告）をrunごとに溜める
 *
 * - merge待ち・後片付け中のノードは、状態が変わるたびにmergeの列（`RoadmapMergeQueue`）へ渡す
 */

/** runごとに残す出来事の上限。 */
const MAX_EVENTS_PER_RUN = 30;
const EVENT_MESSAGE_MAX_LENGTH = 300;

export interface RoadmapRunControllerDeps {
  store: Pick<RoadmapRunStore, 'list' | 'find' | 'findActive' | 'update'>;
  runner: Pick<
    RoadmapIssueRunner,
    | 'startIssue'
    | 'pauseIssue'
    | 'stopIssue'
    | 'instructIssue'
    | 'pump'
    | 'restoreRuns'
    | 'revealIssueSession'
    | 'answerQuestion'
  >;
  detectHost(workspaceRoot: string): Promise<ForgeHost | undefined>;
  resolvePlan(target: RoadmapImportTarget, engine: RoadmapRunEngine): Promise<ResolveRoadmapPlanOutcome>;
  applyPlan(target: RoadmapImportTarget, proposal: RoadmapPlanProposal): Promise<ResolveRoadmapPlanOutcome>;
  /** Reflexが妥当と言い切らなかった提案を、利用者に承認してもらう（モーダル）。 */
  confirmPlan(proposal: RoadmapPlanProposal): Promise<boolean>;
  /** 自動実行が人の対応待ちで止まった（デスクトップ通知）。 */
  notifyStalled(run: RoadmapRun, blockers: readonly number[]): void;
  /** Kanbanの再描画。 */
  onDidChange(): void;
  /** merge待ち・後片付け中のノードを列へ並べる（分割案7）。 */
  mergeQueue?: { sync(run: RoadmapRun): void };
  /** runの状態が変わった（Orchestratorへのイベント通知用。分割案8b-1）。`prev`は初めて見たrunで`undefined`。 */
  onRunTransition?: (prev: RoadmapRun | undefined, next: RoadmapRun) => void;
  log(message: string): void;
  now?: () => Date;
  newId?: () => string;
}

export interface StartRoadmapRunInput {
  workspaceRoot: string;
  roadmapIssueNumber: number;
  engine: RoadmapRunEngine;
  mode: RoadmapRunMode;
  maxParallel: number;
}

export type StartRoadmapRunOutcome =
  | { ok: true; runId: string; /** 同じロードマップの実行中のrunを使った。 */ reused: boolean }
  | { ok: false; message: string };

export class RoadmapRunController {
  /** 最後に見たrunの状態。差分から「実行可能になった」「終了した」を出す。 */
  private readonly lastSeen = new Map<string, RoadmapRun>();
  private readonly events = new Map<string, RoadmapKanbanEvent[]>();
  private readonly pumping = new Map<string, Promise<void>>();
  private readonly pumpAgain = new Set<string>();
  /** 通知済みの待ち（runId → blockersの並び）。同じ待ちで通知を繰り返さない。 */
  private readonly notifiedStalls = new Map<string, string>();
  private readonly startingRuns = new Set<string>();

  constructor(private readonly deps: RoadmapRunControllerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  /* ------------------------------------------------------------------------------------------ */
  /* runの開始                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  async startRun(input: StartRoadmapRunInput): Promise<StartRoadmapRunOutcome> {
    if (!isValidIssueNumber(input.roadmapIssueNumber)) {
      return { ok: false, message: `ロードマップIssueの番号が不正です: ${String(input.roadmapIssueNumber)}` };
    }
    if (!isValidMaxParallel(input.maxParallel)) {
      return { ok: false, message: `並列上限は1〜${MAX_ROADMAP_PARALLEL}の整数で指定してください` };
    }
    const active = this.deps.store.findActive(input.workspaceRoot, input.roadmapIssueNumber);
    if (active !== undefined) {
      return { ok: true, runId: active.runId, reused: true };
    }
    const key = `${input.workspaceRoot}\n${String(input.roadmapIssueNumber)}`;
    if (this.startingRuns.has(key)) {
      return { ok: false, message: `#${String(input.roadmapIssueNumber)}の実行を準備中です` };
    }
    this.startingRuns.add(key);
    try {
      return await this.prepareRun(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`roadmap run: 開始に失敗: ${message}`);
      return { ok: false, message };
    } finally {
      this.startingRuns.delete(key);
    }
  }

  private async prepareRun(input: StartRoadmapRunInput): Promise<StartRoadmapRunOutcome> {
    const host = await this.deps.detectHost(input.workspaceRoot);
    if (host === undefined) {
      return { ok: false, message: 'originのURLからGitHub / GitLabを判定できませんでした' };
    }
    const target: RoadmapImportTarget = {
      host,
      cwd: input.workspaceRoot,
      roadmapIssueNumber: input.roadmapIssueNumber,
    };
    let outcome = await this.deps.resolvePlan(target, input.engine);
    if (outcome.kind === 'awaitingApproval') {
      if (!(await this.deps.confirmPlan(outcome.proposal))) {
        return { ok: false, message: '計画の提案を承認しなかったため、実行を始めませんでした' };
      }
      outcome = await this.deps.applyPlan(target, outcome.proposal);
    }
    switch (outcome.kind) {
      case 'failed':
        return { ok: false, message: outcome.message };
      case 'invalidPlan':
        return { ok: false, message: `計画区画が不正です: ${outcome.errors.join(' / ')}` };
      case 'proposalRejected':
        return { ok: false, message: `計画の提案が検証に通りませんでした: ${outcome.errors.join(' / ')}` };
      case 'awaitingApproval':
        return { ok: false, message: '計画を書き戻せませんでした' };
      case 'ready':
        break;
    }
    // 準備の間に同じロードマップのrunが始まっていたら、そちらを使う
    const raced = this.deps.store.findActive(input.workspaceRoot, input.roadmapIssueNumber);
    if (raced !== undefined) {
      return { ok: true, runId: raced.runId, reused: true };
    }
    const runId = this.newId();
    const run = createRoadmapRun({
      runId,
      roadmapIssueNumber: input.roadmapIssueNumber,
      workspaceRoot: input.workspaceRoot,
      engine: input.engine,
      mode: input.mode,
      maxParallel: input.maxParallel,
      plan: outcome.plan,
      children: outcome.children,
      newExecutionId: () => this.newId(),
      now: this.now(),
    });
    const stored = await this.deps.store.update(runId, () => run);
    if (outcome.duplicates.length > 0) {
      this.addEvent(
        runId,
        `ロードマップ本文で重複した子Issueの行を読み飛ばしました: ${outcome.duplicates.map((n) => `#${String(n)}`).join(', ')}`,
        'warn',
      );
    }
    this.handleRunChanged(stored);
    return { ok: true, runId, reused: false };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* 状態の変化                                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  /** runの状態が変わった（Runnerの`onRunChanged`とControllerの更新から呼ぶ）。 */
  handleRunChanged(next: RoadmapRun): void {
    const prev = this.lastSeen.get(next.runId);
    this.lastSeen.set(next.runId, next);
    if (prev !== undefined) {
      for (const n of newlyFinishedIssues(prev, next)) {
        this.addEvent(next.runId, `#${String(n)}が終了しました`, 'info');
      }
      if (next.mode === 'manual') {
        for (const n of newlyRunnableIssues(prev, next)) {
          this.addEvent(next.runId, `#${String(n)}が実行可能になりました`, 'info');
        }
      }
    }
    if (next.finishedAt === undefined && finishRunIfDone(next, this.now()) !== next) {
      void this.updateRun(next.runId, (r) => finishRunIfDone(r, this.now())).catch((e: unknown) => {
        this.deps.log(`[roadmap run] runの終了を保存できませんでした: ${String(e)}`);
      });
    }
    this.checkStalled(next);
    this.deps.mergeQueue?.sync(next);
    this.deps.onRunTransition?.(prev, next);
    if (pickIssuesToStart(next).length > 0) {
      this.schedulePump(next.runId);
    }
    this.deps.onDidChange();
  }

  /** Runnerの警告（実行を止めずに人へ知らせる事象）。 */
  recordWarning(runId: string, issueNumber: number, message: string): void {
    this.addEvent(runId, `#${String(issueNumber)}: ${message}`, 'warn');
    this.deps.onDidChange();
  }

  private checkStalled(run: RoadmapRun): void {
    const assessment = assessRun(run);
    if (run.mode !== 'auto' || assessment.kind !== 'stalled') {
      this.notifiedStalls.delete(run.runId);
      return;
    }
    const key = assessment.blockers.join(',');
    if (this.notifiedStalls.get(run.runId) === key) {
      return;
    }
    this.notifiedStalls.set(run.runId, key);
    this.addEvent(
      run.runId,
      `自動実行が人の対応待ちで止まっています: ${assessment.blockers.map((n) => `#${String(n)}`).join(', ')}`,
      'warn',
    );
    this.deps.notifyStalled(run, assessment.blockers);
  }

  /** `pump`をrunごとに直列化し、実行中に来た要求は終わった後の1回へまとめる。 */
  private schedulePump(runId: string): void {
    if (this.pumping.has(runId)) {
      this.pumpAgain.add(runId);
      return;
    }
    const task = (async () => {
      try {
        do {
          this.pumpAgain.delete(runId);
          await this.deps.runner.pump(runId);
        } while (this.pumpAgain.has(runId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log(`roadmap run: 自動実行の送り出しに失敗: ${message}`);
        this.addEvent(runId, `自動実行の送り出しに失敗しました: ${message}`, 'warn');
        this.deps.onDidChange();
      } finally {
        this.pumping.delete(runId);
      }
    })();
    this.pumping.set(runId, task);
  }

  /** 状態を純粋関数で進めて永続化し、変わったら`handleRunChanged`へ通す。 */
  async updateRun(
    runId: string,
    updater: (run: RoadmapRun) => RoadmapRun,
  ): Promise<RoadmapRun | undefined> {
    const snapshot = this.deps.store.find(runId);
    if (snapshot === undefined) {
      return undefined;
    }
    let changed = false;
    const next = await this.deps.store.update(runId, (current) => {
      const base = current ?? snapshot;
      const updated = updater(base);
      changed = updated !== base;
      return updated;
    });
    if (changed) {
      this.handleRunChanged(next);
    }
    return next;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Kanbanからの操作                                                                            */
  /* ------------------------------------------------------------------------------------------ */

  async setMode(
    runId: string,
    mode: RoadmapRunMode,
    maxParallel: number,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!isValidMaxParallel(maxParallel)) {
      return { ok: false, message: `並列上限は1〜${MAX_ROADMAP_PARALLEL}の整数で指定してください` };
    }
    const next = await this.updateRun(runId, (r) => setRunMode(r, mode, maxParallel));
    return next === undefined ? { ok: false, message: 'runが見つかりません' } : { ok: true };
  }

  /** run全体を止める・再開する。止めても動いているセッションは止めない（新しく始めないだけ）。 */
  async setHalted(runId: string, halted: boolean): Promise<void> {
    await this.updateRun(runId, (r) => setRunHaltedByUser(r, halted));
  }

  async startIssue(
    runId: string,
    issueNumber: number,
    overrideDependencies: boolean,
  ): Promise<StartIssueOutcome> {
    const outcome = await this.deps.runner.startIssue(runId, issueNumber, { overrideDependencies });
    if (!outcome.ok) {
      this.addEvent(runId, `#${String(issueNumber)}を始められませんでした: ${outcome.message}`, 'warn');
      this.deps.onDidChange();
    }
    return outcome;
  }

  pauseIssue(runId: string, issueNumber: number): Promise<boolean> {
    return this.deps.runner.pauseIssue(runId, issueNumber);
  }

  stopIssue(runId: string, issueNumber: number): Promise<boolean> {
    return this.deps.runner.stopIssue(runId, issueNumber);
  }

  /** Kanbanで入力された、Issueセッションへの指示（Orchestrator経由）。 */
  instructIssue(runId: string, issueNumber: number, instruction: string): Promise<boolean> {
    return this.deps.runner.instructIssue(runId, issueNumber, instruction);
  }

  /** Kanbanで入力された、ユーザー判断待ちの質問への回答。 */
  answerQuestion(
    runId: string,
    issueNumber: number,
    questionId: string,
    answer: string,
  ): Promise<boolean> {
    return this.deps.runner.answerQuestion(runId, issueNumber, questionId, answer);
  }

  revealIssue(runId: string, issueNumber: number): boolean {
    return this.deps.runner.revealIssueSession(runId, issueNumber);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* 復元と表示                                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * ウィンドウの再読み込みの後に呼ぶ。自動実行のrunは止めた状態で戻し、再開は人が選ぶ
   * （リロードのたびに黙ってセッションを始めないため）。
   */
  async restore(): Promise<void> {
    for (const run of this.deps.store.list()) {
      if (run.finishedAt !== undefined || run.mode !== 'auto' || run.haltedByUser) {
        continue;
      }
      try {
        await this.deps.store.update(run.runId, (current) =>
          setRunHaltedByUser(current ?? run, true),
        );
      } catch (e: unknown) {
        // 1件の保存失敗で残りのrunの停止とセッションの突き合わせを止めない
        this.deps.log(`[roadmap run] ${run.runId}の自動実行を止められませんでした: ${String(e)}`);
        continue;
      }
      this.addEvent(
        run.runId,
        '再読み込みのため自動実行を止めました。続けるには「再開」を押してください',
        'info',
      );
    }
    await this.deps.runner.restoreRuns();
    for (const run of this.deps.store.list()) {
      if (!this.lastSeen.has(run.runId)) {
        this.lastSeen.set(run.runId, run);
      }
      this.deps.mergeQueue?.sync(run);
    }
    this.deps.onDidChange();
  }

  board(selectedRunId: string | undefined): RoadmapKanbanBoard {
    return buildRoadmapKanban(this.deps.store.list(), selectedRunId, (runId) =>
      this.events.get(runId) ?? [],
    );
  }

  hasRuns(): boolean {
    return this.deps.store.list().length > 0;
  }

  private addEvent(runId: string, message: string, tone: RoadmapKanbanEvent['tone']): void {
    const list = this.events.get(runId) ?? [];
    const event: RoadmapKanbanEvent = {
      at: this.now().toISOString(),
      message: sanitizeInlineText(message, EVENT_MESSAGE_MAX_LENGTH),
      tone,
    };
    this.events.set(runId, [event, ...list].slice(0, MAX_EVENTS_PER_RUN));
  }
}
