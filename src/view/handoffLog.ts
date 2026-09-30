import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HandoffTrigger } from './handoff';

/**
 * 引き継ぎ1回につき1行を追記する記録（Issue #1752）。改善の効果を後から確かめるための最小限の
 * 材料で、本文そのものは残さない。保存領域（`globalStorageUri`）の `handoff/handoff-log.jsonl`。
 */
export interface HandoffLogRecord {
  /** 引き継ぎを始めた時刻（ISO 8601）。 */
  at: string;
  provider: 'codex' | 'claude';
  /** 契機の種別（`HandoffTrigger.kind`）。 */
  trigger: HandoffTrigger['kind'];
  /** 新セッションへ送る初回プロンプト（引き継ぎ本文）のUTF-8バイト数。 */
  bodyBytes: number;
  /** ポインタファイルのバイト数。読めなければ `null`。 */
  pointerBytes: number | null;
  /** 受領確認の成否。受領確認（Issue #1751）の実装後に埋める。それまでは `null`。 */
  ackOk: boolean | null;
  /** 受け取った側が聞き返したか。判定手段がまだ無いため `null`。 */
  clarified: boolean | null;
}

export const HANDOFF_LOG_FILE_NAME = 'handoff-log.jsonl';

/** 記録の失敗で引き継ぎを止めない。失敗は呼び出し側がwarnへ出す。 */
export async function appendHandoffLog(
  baseDir: string,
  input: {
    provider: HandoffLogRecord['provider'];
    trigger: HandoffTrigger;
    prompt: string;
    pointerPath: string;
    now?: Date;
  },
): Promise<void> {
  const pointerBytes = await stat(input.pointerPath).then(
    (s) => s.size,
    () => null,
  );
  const record: HandoffLogRecord = {
    at: (input.now ?? new Date()).toISOString(),
    provider: input.provider,
    trigger: input.trigger.kind,
    bodyBytes: Buffer.byteLength(input.prompt, 'utf8'),
    pointerBytes,
    ackOk: null,
    clarified: null,
  };
  const dir = join(baseDir, 'handoff');
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, HANDOFF_LOG_FILE_NAME), `${JSON.stringify(record)}\n`, 'utf8');
}
