/**
 * セカンドオピニオン（Issue #894）の実行。
 *
 * 親セッションとは別に、独立したCodexセッションを1つ開き、1ターンだけ送って
 * 最終回答を受け取り、閉じる。実体は `planner.ts` の `runSingleTurnTask`（分解セッションと
 * 共有する単発ターンの土台）で、ここが決めるのは「何を渡すか」「どの候補で走らせるか」
 * 「タブを開くか」だけ。
 *
 * `vscode` には依存しない。UI（依頼文の編集・結果の差し込み）は view 層の責務。
 */

import type { ApprovalMode } from '../codex/types';
import { SANDBOX_MODES } from '../codex/types';
import type { Logger } from '../log';
import { runSingleTurnTask } from '../orchestrator/planner';
import type { TaskSessionHost, TaskSessionInput } from '../orchestrator/taskSession';
import type { SecondOpinionCandidate } from './candidates';
import { buildSecondOpinionPrompt, type SecondOpinionContext } from './prompt';

/**
 * 承認要求を人へ回さず全て拒否するモード。`runSingleTurnTask` が起動直前に確かめる
 * 固定値（`planner.ts` の `assertSingleTurnSessionIsSafe`）と同じ値でなければならない。
 */
const SECOND_OPINION_APPROVAL_MODE: ApprovalMode = 'never';

/** 既定のタイムアウト（5分）。設定 `agent.secondOpinion.timeoutMs` の既定値でもある。 */
export const DEFAULT_SECOND_OPINION_TIMEOUT_MS = 5 * 60_000;

/** ログ・エラー文言の主語。`runSingleTurnTask` の `label` へ渡す。 */
const SECOND_OPINION_LABEL = 'セカンドオピニオン';

const SECOND_OPINION_LOG_PREFIX = '[secondOpinion]';

/**
 * セカンドオピニオン用の `TaskSessionInput` を組み立てる。
 *
 * 権限は「ワークスペースの読み取りだけ」で固定する（`sandbox: 'read-only'` /
 * `approvalMode: 'never'`）。レビューに書き込みは要らず、「ついでに直しておきました」を
 * 構造として不可能にする。`buildPlannerSessionInput` と同じく、設定由来のbaselineには
 * 一切依存しない（利用者の設定が緩くても、この経路の権限は動かない）。
 */
export function buildSecondOpinionSessionInput(
  cwd: string,
  candidate: SecondOpinionCandidate,
): TaskSessionInput {
  return {
    cwd,
    config: {
      model: candidate.model,
      effort: candidate.effort,
      approvalMode: SECOND_OPINION_APPROVAL_MODE,
    },
    sandbox: SANDBOX_MODES[0],
  };
}

export interface SecondOpinionRequest {
  /** 親セッションの作業ディレクトリ。 */
  cwd: string;
  candidate: SecondOpinionCandidate;
  /** 利用者が編集した依頼文。 */
  request: string;
  /** 押下時に固定したレビュー対象。 */
  context: SecondOpinionContext;
  /** タブを開かずに走らせるか（設定 `agent.secondOpinion.headless`）。 */
  headless: boolean;
  timeoutMs?: number | undefined;
}

export type SecondOpinionResult = { ok: true; response: string } | { ok: false; reason: string };

/**
 * 1回分のセカンドオピニオンを走らせる。
 *
 * 失敗・タイムアウトは例外にせず `ok: false` と理由で返す（headlessではタブが無く、
 * 例外が握り潰されると人には何も見えないため。呼び出し側は必ず会話へ理由を残す）。
 */
export async function runSecondOpinion(
  host: TaskSessionHost,
  request: SecondOpinionRequest,
  log?: Logger,
): Promise<SecondOpinionResult> {
  const prompt = buildSecondOpinionPrompt({
    request: request.request,
    context: request.context,
  });
  // 依頼文・差分の中身は出さない（credential・顧客情報・proprietary codeが入りうる。
  // 受入基準14）。出すのは実行条件と分量だけ
  log?.info(
    `${SECOND_OPINION_LOG_PREFIX} start provider=codex model=${request.candidate.model} ` +
      `effort=${request.candidate.effort} headless=${String(request.headless)} ` +
      `contextSource=${request.context.kind} promptChars=${prompt.length}`,
  );
  try {
    const response = await runSingleTurnTask(
      host,
      'codex',
      buildSecondOpinionSessionInput(request.cwd, request.candidate),
      prompt,
      {
        timeoutMs: request.timeoutMs ?? DEFAULT_SECOND_OPINION_TIMEOUT_MS,
        log,
        openPanel: !request.headless,
        label: SECOND_OPINION_LABEL,
        logPrefix: SECOND_OPINION_LOG_PREFIX,
      },
    );
    if (response.trim() === '') {
      return { ok: false, reason: 'セカンドオピニオンの応答が空でした' };
    }
    return { ok: true, response };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 親セッションごとの実行中管理（受入基準8）。
 *
 * 同じ親セッションからの重複起動だけを止める。別の親セッションからの同時実行は
 * 止めない（グローバルに1本へ絞る理由が無い）。
 */
export class SecondOpinionRegistry {
  private readonly running = new Set<string>();

  isRunning(parentSessionId: string): boolean {
    return this.running.has(parentSessionId);
  }

  /** 開始できたら `true`。既に走っていれば `false`（呼び出し側は起動しない）。 */
  begin(parentSessionId: string): boolean {
    if (this.running.has(parentSessionId)) {
      return false;
    }
    this.running.add(parentSessionId);
    return true;
  }

  end(parentSessionId: string): void {
    this.running.delete(parentSessionId);
  }
}
