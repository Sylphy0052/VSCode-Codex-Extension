import type { Logger } from '../log';

/**
 * 複数runを束ねる「プログラム」機能（design.md §16.37、Issue #604）が使っていた
 * `workspaceState`のキー（廃止: Issue #1679）。`ProgramStore.PROGRAM_RUNS_KEY`と同じ値。
 * モジュールごと削除するため、値だけここへ複製して持つ。
 */
const LEGACY_PROGRAM_WORKSPACE_STATE_KEY = 'codex.workflow.programs';

/** `workspaceState`から値を読み書きするのに必要な最小の形。 */
export interface ProgramStatePurgeWorkspaceState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * プログラム機能の廃止（Issue #1679）に伴い、残っている保存データを消す。
 *
 * 対象は`workspaceState`の1キー（プログラム一覧）だけ。中身は読まず、値ごと捨てる
 * （`roadmapRunPurge.ts`の`purgeRoadmapRunSavedData`と同じ方針）。消せなくても起動は
 * 止めない（ベストエフォート）。
 */
export async function purgeLegacyProgramState(
  workspaceState: ProgramStatePurgeWorkspaceState,
  log: Pick<Logger, 'info'>,
): Promise<void> {
  if (workspaceState.get(LEGACY_PROGRAM_WORKSPACE_STATE_KEY) === undefined) {
    return;
  }
  await workspaceState.update(LEGACY_PROGRAM_WORKSPACE_STATE_KEY, undefined);
  log.info('プログラム機能の保存データを削除した（プログラム機能は廃止）');
}
