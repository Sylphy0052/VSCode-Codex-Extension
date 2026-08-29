import * as fs from 'node:fs/promises';
import { parseSessionMeta } from '../codex/sessionMeta';
import type { Logger } from '../log';

/**
 * 要約セッション（Issue #903）のrolloutを、要約が終わったあとに消す（Issue #942）。
 *
 * 要約セッションは親会話をまるごとプロンプトへ載せて1ターンだけ送る。そのプロンプトは
 * CLIがrolloutとしてディスクへ書くため、**親会話の複製がもう1つできる**。しかもこの
 * rolloutは拡張の履歴一覧に出ない——要約セッションのcwdは一時ディレクトリ（Issue #926 E）
 * で、一覧はワークスペースのパスで絞り込むため常に対象外になる。結果として、利用者からは
 * 見えず、拡張のUIからは開くことも消すこともできない複製が増え続ける。
 *
 * 消す側の判断で他人のセッションを巻き込まないよう、**セッションIDが二重に一致した1件**
 * だけを消す（ファイル名に含まれるIDと、先頭行の`session_meta.session_id`）。候補が0件・
 * 複数件のときは何もしない。CLIの更新でファイル名やメタデータの形が変われば、
 * 「消せなかった」側へ倒れる——**消しすぎるより、残す方へ倒す**。
 *
 * `vscode`には依存しない。実際のファイル操作は呼び出し側が渡す（`SummaryRolloutDeps`）。
 */

/** 削除の結果。呼び出し側はこれをログへ残す。 */
export type RolloutRemoval =
  /** 消した。 */
  | 'removed'
  /** 対象が見つからなかった（CLIがまだ書いていない・置き場が変わった）。 */
  | 'not-found'
  /** 候補はあったが、セッションIDが一致しない・複数一致した。安全側に倒して消していない。 */
  | 'mismatched'
  /** 削除そのものに失敗した（権限・I/Oエラー）。 */
  | 'failed';

export interface SummaryRolloutDeps {
  /** `CodexPaths.sessions`。日付のディレクトリ構成は組み立てず、ここを走査する。 */
  sessionsDir: string;
  /** ディレクトリを再帰的に走査して `rollout-*.jsonl` の絶対パスを返す。 */
  listRollouts(dir: string): Promise<string[]>;
  /** 1行目だけを読む。`session_meta`の照合に使う。 */
  readFirstLine(filePath: string): Promise<string | undefined>;
  /** ファイルを消す。 */
  removeFile(filePath: string): Promise<void>;
  log?: Logger;
}

/**
 * rolloutが書かれるのを待つ回数と間隔。
 *
 * `dispose()`の直後はCLIがまだ書き終えていないことがある。数回だけ待って、それでも
 * 見つからなければ諦める（`not-found`）。長く待つとセカンドオピニオン本体の開始が遅れる。
 */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_INTERVAL_MS = 300;

export interface SummaryRolloutOptions {
  attempts?: number;
  intervalMs?: number;
  /** 待ち。テストから同期的な実装を渡せるようにしてある。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 要約セッションのrolloutを消す。**例外は投げない。**
 *
 * 消せなかったこと自体はセカンドオピニオンの失敗ではない（要約はもう手元にある）。
 * 呼び出し側は結果をログへ残すだけで、本体は続ける。
 */
export async function removeSummaryRollout(
  sessionId: string,
  deps: SummaryRolloutDeps,
  options: SummaryRolloutOptions = {},
): Promise<RolloutRemoval> {
  if (sessionId.trim() === '') {
    return 'not-found';
  }
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;

  let last: RolloutRemoval = 'not-found';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await removeOnce(sessionId, deps);
    // 見つからないときだけ待って試し直す。不一致・削除失敗は待っても変わらない
    if (last !== 'not-found') {
      return last;
    }
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }
  return last;
}

async function removeOnce(sessionId: string, deps: SummaryRolloutDeps): Promise<RolloutRemoval> {
  const files = await deps.listRollouts(deps.sessionsDir).catch((e: unknown) => {
    deps.log?.warn(`[secondOpinion.summary] rolloutの走査に失敗しました: ${message(e)}`);
    return [] as string[];
  });
  // ファイル名は `rollout-<日時>-<sessionId>.jsonl`。ここで候補を絞ってから中身を読む
  const candidates = files.filter((file) => file.includes(sessionId));
  if (candidates.length === 0) {
    return 'not-found';
  }
  if (candidates.length > 1) {
    deps.log?.warn(
      `[secondOpinion.summary] rolloutの候補が${candidates.length}件あったため消しませんでした`,
    );
    return 'mismatched';
  }
  const target = candidates[0] as string;
  const firstLine = await deps.readFirstLine(target).catch(() => undefined);
  const meta = firstLine === undefined ? undefined : parseSessionMeta(firstLine);
  // ファイル名の一致だけでは消さない。中身のsession_idまで一致した1件に限る
  if (meta?.sessionId !== sessionId) {
    deps.log?.warn('[secondOpinion.summary] rolloutのsession_idが一致しないため消しませんでした');
    return 'mismatched';
  }
  try {
    await deps.removeFile(target);
    return 'removed';
  } catch (e) {
    deps.log?.warn(`[secondOpinion.summary] rolloutを消せませんでした: ${message(e)}`);
    return 'failed';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 実ファイルを触る`SummaryRolloutDeps`を組み立てる。
 *
 * 走査は既存の`FileSystemPort.listRollouts`（`sessions/`配下の再帰走査）をそのまま使う。
 * 削除だけはポートに口が無いため`node:fs`を直に呼ぶ——`FileSystemPort`は読み取り専用の
 * 抽象で、ここへ削除を足すと一覧・使用量・履歴の全実装が書き込み能力を持つことになる。
 */
export function createNodeSummaryRolloutDeps(
  sessionsDir: string,
  port: Pick<SummaryRolloutDeps, 'listRollouts' | 'readFirstLine'>,
  log?: Logger,
): SummaryRolloutDeps {
  return {
    sessionsDir,
    listRollouts: (dir) => port.listRollouts(dir),
    readFirstLine: (filePath) => port.readFirstLine(filePath),
    removeFile: (filePath) => fs.rm(filePath, { force: true }),
    ...(log === undefined ? {} : { log }),
  };
}
