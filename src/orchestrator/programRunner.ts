import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createInitialProgramState,
  markRunFinished,
  markRunStarted,
  reapplyLiveRunOutcome,
} from './programState';
import { isProgramSettled, nextProgramRunsToStart } from './programScheduler';
import {
  parseProgramYaml,
  validateProgram,
  type ProgramDefinition,
  type ProgramIssue,
} from './program';
import type { ProgramStore } from './programStore';
import { sanitizeForLog } from './sanitize';
import type { StartWorkflowResult, LiveRunSummary, WorkflowFilePort } from './runner';
import { MAX_WORKFLOW_FILE_BYTES } from './workflow';
import type { Logger } from '../log';

/**
 * プログラム（runの束）の実際の起動・進行（design.md §16.37.2、roadmap W12-2、
 * Issue #605）。`programScheduler.ts`（波の組み立て）・`programState.ts`（状態遷移）・
 * `programStore.ts`（永続化、W12-1）を束ね、`WorkflowRunner.start`を実際に呼んで
 * runを起動する層。
 *
 * **上位のオーケストレーターは置かない。** ここは「どのrunをいつ起動するか」だけを
 * 決めて`WorkflowRunner.start`を呼ぶだけで、起動した各runのオーケストレーターは
 * 引き続き自分のrunだけを見る（design.md §16.23。既存の単発run実行と同じ経路をそのまま
 * 通る）。
 *
 * `WorkflowRunner`本体には依存せず、必要な操作だけを`ProgramWorkflowPort`として
 * 注入で受け取る（`runner.ts`が`WorkflowRunnerDeps`で外部依存を注入で受け取るのと
 * 同じ方針。テストでは`WorkflowRunner`を起動せずにフェイクで差し替えられる）。
 */

/** `ProgramRunner`が`WorkflowRunner`へ要求する最小限の口。`WorkflowRunner`は構造的にこれを満たす。 */
export interface ProgramWorkflowPort {
  start(defPath: string, repoRoot: string): Promise<StartWorkflowResult>;
  listLive(): readonly LiveRunSummary[];
  onChanged(listener: (runId: string) => void): () => void;
}

export interface ProgramRunnerDeps {
  programStore: ProgramStore;
  filePort: WorkflowFilePort;
  workflow: ProgramWorkflowPort;
  log: Logger;
  now?: () => Date;
  randomId?: () => string;
}

export interface StartProgramResult {
  ok: boolean;
  programId?: string;
  errors?: readonly ProgramIssue[];
}

type ParsedProgram =
  | { ok: true; def: ProgramDefinition }
  | { ok: false; errors: readonly ProgramIssue[] };

export class ProgramRunner {
  /**
   * 開始済みでまだ終了を確認していない`WorkflowRunner`側の`runId` ->
   * `{ programId, runRefId }`の逆引き。このウィンドウで`ProgramRunner`自身が起動した
   * runだけを持つ（`WorkflowRunner.restoreRunsForView`が復元した単発runの`runId`は
   * ここには入らない。単発run側は`ProgramState`と紐づく理由が無いため）。
   *
   * **メモリ上のみで、リロードそのものをまたいでは保持しない。** リロード直後は
   * `reconcileAfterReload()`（このクラス）が、`WorkflowRunner.listLive()`を見て
   * まだ生きている（＝W10で再開された）`runId`ぶんだけをここへ組み直す
   * （design.md §16.37.2「リロードとW10の自動再開の整合」、Issue #605のレビュー
   * 指摘F1）。`ProgramStore`側の永続化（`runId`は`ProgramRunEntry.runId`として残る）を
   * 種にして復元する形は、`WorkflowRunner`本体の`runs`（メモリ上のLiveRunのMap）を
   * `restoreRunsForView()`が明示的に復元する設計（design.md §16.11）と同じ考え方。
   */
  private readonly trackedRuns = new Map<string, { programId: string; runRefId: string }>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: ProgramRunnerDeps) {}

  /** `extension.ts`から1回だけ呼ぶ。`workflow.onChanged`を購読し、runの終了を検知する。 */
  attach(): void {
    this.unsubscribe = this.deps.workflow.onChanged((runId) => {
      void this.onRunChanged(runId).catch((e: unknown) => {
        this.deps.log.error(
          `[program] runId=${runId}の完了処理に失敗しました: ${sanitizeForLog(
            e instanceof Error ? e.message : String(e),
          )}`,
        );
      });
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * プログラム定義ファイルを読み込み、検証し、通れば実行を開始する。
   * `runner.ts`の`WorkflowRunner.start`と同じ形の戻り値にしてある。
   */
  async startProgram(defPath: string, workspaceRoot: string): Promise<StartProgramResult> {
    const parsed = await this.parseAndValidateProgram(defPath);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors };
    }
    const { def } = parsed;
    const programId = this.deps.randomId?.() ?? randomUUID();
    const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
    await this.deps.programStore.update(programId, () => ({
      programId,
      defPath,
      workspaceRoot,
      startedAt,
      finishedAt: undefined,
      state: createInitialProgramState(def),
    }));
    await this.pumpProgram(programId);
    return { ok: true, programId };
  }

  /**
   * 次の波を計算し、開始できるrunを実際に起動する。リロード直後の再開（`reconcileAfterReload`
   * が全プログラムぶん呼ぶ）と、run完了検知（`onRunChanged`）の両方から呼ばれる冪等な操作。
   * 開始できるrunが無ければ何もしない。
   */
  async pumpProgram(programId: string): Promise<void> {
    const persisted = this.deps.programStore.find(programId);
    if (persisted === undefined) {
      return;
    }
    const parsed = await this.parseAndValidateProgram(persisted.defPath);
    if (!parsed.ok) {
      this.deps.log.error(
        `[program ${programId}] 定義ファイルの再読込に失敗したため、波を進められません:\n` +
          parsed.errors.map((e) => e.message).join('\n'),
      );
      return;
    }
    const { def } = parsed;
    const toStart = nextProgramRunsToStart(def, persisted.state);
    for (const runRefId of toStart) {
      await this.startOneRun(programId, persisted.workspaceRoot, def, runRefId);
    }
    await this.maybeMarkFinished(programId);
  }

  /**
   * リロード（あるいはWSLの停止・再起動）直後に1回呼ぶ。`ProgramStore.reconcileAfterReload()`
   * と`WorkflowRunner.restoreRunsForView()`の両方が完了した後に呼ぶ前提（`extension.ts`が
   * 順序を保証する）。
   *
   * **`reconcileProgramStateOnReload`が`running`を`failed`へ倒すのは暫定値でしかない。**
   * `runId`が`WorkflowRunner.listLive()`にまだ現れる場合、それはW10
   * （`autoResumeIfEligible`）が同じ`runId`のまま再開した（または元から中断していな
   * かった）ことを意味する。その最新の`outcome`へ`reapplyLiveRunOutcome`で合わせ直し、
   * まだ`running`なら`trackedRuns`へ再登録して以後の`onRunChanged`で追跡を再開する
   * （design.md §16.37.2「リロードとW10の自動再開の整合」、Issue #605のレビュー指摘F1）。
   * `listLive()`に現れない（定義ファイルが読めない等で復元自体に失敗した）runIdは、
   * `reconcileProgramStateOnReload`が付けた`failed`のまま変えない。
   *
   * 最後に全プログラムぶん`pumpProgram`を呼び、続きの波を進める。
   */
  async reconcileAfterReload(): Promise<void> {
    for (const persisted of this.deps.programStore.list()) {
      let nextState = persisted.state;
      for (const [runRefId, entry] of Object.entries(persisted.state.runs)) {
        if (entry.state !== 'failed' || entry.runId === undefined) {
          continue;
        }
        const runId = entry.runId;
        const live = this.deps.workflow.listLive().find((r) => r.runId === runId);
        if (live === undefined) {
          // 復元自体に失敗した（定義ファイルが読めない等）。reconcileProgramStateOnReload
          // が付けたfailedのまま変えない
          continue;
        }
        nextState = reapplyLiveRunOutcome(nextState, runRefId, runId, live.outcome);
        if (live.outcome === 'running') {
          this.trackedRuns.set(runId, { programId: persisted.programId, runRefId });
        }
      }
      if (nextState === persisted.state) {
        continue;
      }
      const programId = persisted.programId;
      await this.deps.programStore.update(programId, (current) => {
        if (current === undefined) {
          throw new Error(`[program ${programId}] リロード後の整合中にプログラムが消えました`);
        }
        return { ...current, state: nextState };
      });
    }
    for (const persisted of this.deps.programStore.list()) {
      await this.pumpProgram(persisted.programId);
    }
  }

  private async startOneRun(
    programId: string,
    workspaceRoot: string,
    def: ProgramDefinition,
    runRefId: string,
  ): Promise<void> {
    const runRef = def.runs.find((r) => r.id === runRefId);
    if (runRef === undefined) {
      return;
    }
    if (path.isAbsolute(runRef.defPath)) {
      // `validateProgram`の`isSafeDefPath`が絶対パスを拒否するため、検証を通った定義
      // からは本来ここへ到達しない。到達した場合に`workspaceRoot`外を指す経路を
      // 開いてしまわないよう、素通しせず明示的に拒否する（Issue #605のレビュー
      // 指摘F3。到達しないことと、到達した場合の向きの安全性は別の話）
      this.deps.log.error(
        `[program ${programId}] run"${runRefId}"のdefPathが絶対パスです（検証済みの定義には` +
          `本来含まれません）: ${runRef.defPath}`,
      );
      await this.deps.programStore.update(programId, (current) => {
        if (current === undefined) {
          throw new Error(`[program ${programId}] run"${runRefId}"の起動拒否の記録中にプログラムが消えました`);
        }
        return { ...current, state: markRunFinished(current.state, runRefId, 'failed') };
      });
      return;
    }
    const absoluteDefPath = path.join(workspaceRoot, runRef.defPath);
    const result = await this.deps.workflow.start(absoluteDefPath, workspaceRoot);
    if (result.ok && result.runId !== undefined) {
      const runId = result.runId;
      this.trackedRuns.set(runId, { programId, runRefId });
      await this.deps.programStore.update(programId, (current) => {
        if (current === undefined) {
          throw new Error(`[program ${programId}] run"${runRefId}"の起動中にプログラムが消えました`);
        }
        return { ...current, state: markRunStarted(current.state, runRefId, runId) };
      });
      return;
    }
    // 開始そのものに失敗した（allow確認待ち・検証エラー・git前提の不足等）。
    // 確認待ち（needsAllowConfirmation）は人の判断を要するため、この段では対応せず
    // failedとして記録する（プログラムからの自動起動はallow確認を持たない。allowを
    // 含むワークフローをプログラムのrunに使う場合の扱いはIssue #606以降で検討）
    const detail = (result.errors ?? []).map((e) => e.message).join('; ');
    this.deps.log.error(
      `[program ${programId}] run"${runRefId}"を開始できませんでした` +
        (detail === '' ? '' : `: ${detail}`),
    );
    await this.deps.programStore.update(programId, (current) => {
      if (current === undefined) {
        throw new Error(`[program ${programId}] run"${runRefId}"の起動失敗の記録中にプログラムが消えました`);
      }
      return { ...current, state: markRunFinished(current.state, runRefId, 'failed') };
    });
  }

  private async maybeMarkFinished(programId: string): Promise<void> {
    const persisted = this.deps.programStore.find(programId);
    if (persisted === undefined || persisted.finishedAt !== undefined) {
      return;
    }
    const parsed = await this.parseAndValidateProgram(persisted.defPath);
    if (!parsed.ok || !isProgramSettled(parsed.def, persisted.state)) {
      return;
    }
    const finishedAt = (this.deps.now?.() ?? new Date()).toISOString();
    await this.deps.programStore.update(programId, (current) =>
      current === undefined || current.finishedAt !== undefined
        ? (current ?? persisted)
        : { ...current, finishedAt },
    );
  }

  private async onRunChanged(runId: string): Promise<void> {
    const tracked = this.trackedRuns.get(runId);
    if (tracked === undefined) {
      return;
    }
    const live = this.deps.workflow.listLive().find((r) => r.runId === runId);
    if (live === undefined || live.outcome === 'running') {
      // まだ終わっていない（あるいはWorkflowRunnerの一覧から既に消えている）。
      // 後者は起きない想定だが、起きても何もしないのが安全（次のonChangedを待つ）
      return;
    }
    this.trackedRuns.delete(runId);
    const { programId, runRefId } = tracked;
    // クロージャ内では`live.outcome`の絞り込み（'running'除外）が保持されないため、
    // 確定した値を変数へ取り出してから渡す
    const outcome = live.outcome;
    await this.deps.programStore.update(programId, (current) => {
      if (current === undefined) {
        // 理論上到達しない（このrunIdを追跡していた時点でprogramは存在したはず）。
        // それでも型上は戻り値が要るため、更新をスキップする形の値を返す
        throw new Error(`[program ${programId}] runId=${runId}の追跡中にプログラムが消えました`);
      }
      return { ...current, state: markRunFinished(current.state, runRefId, outcome) };
    });
    await this.pumpProgram(programId);
  }

  private async parseAndValidateProgram(defPath: string): Promise<ParsedProgram> {
    const size = await this.deps.filePort.fileSize(defPath);
    if (size === undefined) {
      return { ok: false, errors: [{ runIds: [], message: `定義ファイルを読み込めません: ${defPath}` }] };
    }
    if (size > MAX_WORKFLOW_FILE_BYTES) {
      return {
        ok: false,
        errors: [
          {
            runIds: [],
            message: `定義ファイルが大きすぎます（上限${MAX_WORKFLOW_FILE_BYTES}バイト）: ${size}バイト`,
          },
        ],
      };
    }
    const text = await this.deps.filePort.readTextFile(defPath);
    if (text === undefined) {
      return { ok: false, errors: [{ runIds: [], message: `定義ファイルを読み込めません: ${defPath}` }] };
    }
    let def: ProgramDefinition;
    try {
      def = parseProgramYaml(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, errors: [{ runIds: [], message: `YAMLの解析に失敗しました: ${message}` }] };
    }
    const validation = validateProgram(def);
    for (const w of validation.warnings) {
      this.deps.log.warn(`[program] ${w.message}`);
    }
    if (validation.errors.length > 0) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, def };
  }
}
