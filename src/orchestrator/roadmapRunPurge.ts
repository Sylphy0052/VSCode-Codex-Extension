import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import type { Logger } from '../log';
import { sessionHubRoot } from '../view/sessionHub';

/**
 * ロードマップ実行（Issue #1465）が使っていた`workspaceState`のキー（廃止: Issue #1623）。
 * `RoadmapRunStore.ROADMAP_RUNS_KEY` / `RoadmapRunEventStore.ROADMAP_RUN_EVENTS_KEY`と
 * 同じ値。両モジュールごと削除するため、値だけここへ複製して持つ。
 */
const LEGACY_ROADMAP_RUN_WORKSPACE_STATE_KEYS = ['codex.roadmapRuns', 'codex.roadmapRunEvents'] as const;

/** ロードマップ実行の専有権ファイルの置き場（`sessionHubRoot`の下）。 */
const LEGACY_ROADMAP_LEASE_DIR_NAME = 'roadmap-leases';

/** `workspaceState`から値を読み書きするのに必要な最小の形。 */
export interface RoadmapRunPurgeWorkspaceState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * ロードマップ実行（Issue #1465）の廃止（Issue #1623）に伴い、残っている保存データを消す。
 *
 * 対象は`workspaceState`の2キー（run本体・イベントログ）と、専有権ファイルの置き場
 * （`globalStorage`配下の`session-hub/roadmap-leases`）。中身は読まず（形式が変わっていても
 * 構造化されたJSONとして扱わず）値ごと捨てるか、ディレクトリごと消すだけにする。
 * どちらも消せなくても起動は止めない（ベストエフォート）。1回の呼び出しで何か1つでも
 * 消せたときだけ、まとめて1行だけ記録する。
 */
export async function purgeRoadmapRunSavedData(
  workspaceState: RoadmapRunPurgeWorkspaceState,
  globalStorageDir: string,
  log: Pick<Logger, 'info'>,
): Promise<void> {
  let removedAny = false;

  for (const key of LEGACY_ROADMAP_RUN_WORKSPACE_STATE_KEYS) {
    if (workspaceState.get(key) !== undefined) {
      await workspaceState.update(key, undefined);
      removedAny = true;
    }
  }

  const leaseDir = path.join(sessionHubRoot(globalStorageDir), LEGACY_ROADMAP_LEASE_DIR_NAME);
  try {
    await fsPromises.access(leaseDir);
    await fsPromises.rm(leaseDir, { recursive: true, force: true });
    removedAny = true;
  } catch {
    // 元から無ければ何もしない
  }

  if (removedAny) {
    log.info('ロードマップ実行の保存データを削除した（ロードマップ実行は廃止）');
  }
}
