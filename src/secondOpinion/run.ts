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
import {
  runSingleTurnTask,
  SingleTurnCancelledError,
  SingleTurnTimeoutError,
} from '../orchestrator/planner';
import type { TaskSessionHost, TaskSessionInput } from '../orchestrator/taskSession';
import type { SecondOpinionCandidate } from './candidates';
import {
  buildSecondOpinionPrompt,
  type ConversationBackgroundKind,
  type SecondOpinionArtifact,
} from './prompt';

/**
 * 承認要求を人へ回さず全て拒否するモード。`runSingleTurnTask` が起動直前に確かめる
 * 固定値（`planner.ts` の `assertSingleTurnSessionIsSafe`）と同じ値でなければならない。
 */
const SECOND_OPINION_APPROVAL_MODE: ApprovalMode = 'never';

/**
 * 既定のタイムアウト（15分）。設定 `agent.secondOpinion.timeoutMs` の既定値でもある。
 *
 * 当初は5分だったが、`gpt-5.6-sol` / `high` はそれを超えることがある（Issue #907）。
 * この機能はタブを開かず手も塞がないため、上限を短く保つ動機が弱い。
 */
export const DEFAULT_SECOND_OPINION_TIMEOUT_MS = 15 * 60_000;

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
    // 材料を読んで答えるだけのターンでMCPのツールは要らない。既定のまま開くと
    // 利用者のサーバと組み込みの `codex_apps` が接続され、その分だけ遅くなる（Issue #944）
    disableMcpServers: true,
  };
}

export interface SecondOpinionRequest {
  /** 親セッションの作業ディレクトリ。 */
  cwd: string;
  candidate: SecondOpinionCandidate;
  /** 利用者が編集した依頼文。 */
  request: string;
  /** 押下時に固定した追加資料（Issue #926 P0）。 */
  artifact: SecondOpinionArtifact;
  /**
   * 別セッションが作った会話の背景要約（Issue #903）。要約を切っている・作れなかった場合は
   * 渡さない（渡さなければ、元の会話に由来する材料は一切渡らない）。
   */
  conversationSummary?: string | undefined;
  /**
   * {@link conversationSummary} が要約か、会話の記録そのものか（Issue #944）。
   * 省略時は `'summary'`。
   */
  conversationBackgroundKind?: ConversationBackgroundKind | undefined;
  /** タブを開かずに走らせるか（設定 `agent.secondOpinion.headless`）。 */
  headless: boolean;
  timeoutMs?: number | undefined;
  /**
   * 利用者による停止（Issue #940）。`SecondOpinionRegistry` が持つ、この実行1回分の
   * キャンセルハンドルから渡る。
   */
  signal?: AbortSignal | undefined;
}

export type SecondOpinionResult =
  | {
      ok: true;
      response: string;
      /**
       * 打ち切られ、そこまでに出ていた分だけを返した場合の理由（Issue #907）。
       * 最後まで返ってきた場合は `undefined`。
       */
      partialReason?: string | undefined;
      /**
       * 打ち切りが利用者の停止操作によるものか（Issue #940）。タイムアウトによる
       * 打ち切りと文言で区別するために使う。`partialReason` が `undefined` のときは
       * 参照しない（最後まで返ってきている）。
       */
      cancelledByUser?: boolean | undefined;
    }
  | {
      ok: false;
      reason: string;
      /**
       * 利用者が停止した結果の終了か（Issue #940）。回答が1件も出ないまま止めた場合が
       * これにあたる。失敗と同じ見た目にしないために、呼び出し側がここで見分ける。
       */
      cancelledByUser?: boolean | undefined;
    };

/**
 * ログに出す背景の状態（Issue #944）。
 *
 * 要約を作ったのか、短いので記録をそのまま渡したのか、そもそも渡していないのかは、
 * 後から所要時間を読むときに要る（要約セッションを開いたかどうかで待ち時間が変わる）。
 * 本文は出さない（受入基準14）。
 */
function describeBackgroundForLog(request: SecondOpinionRequest): string {
  if (request.conversationSummary === undefined) {
    return 'off';
  }
  return request.conversationBackgroundKind === 'transcript' ? 'transcript' : 'on';
}

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
    userRequest: request.request,
    artifact: request.artifact,
    conversationSummary: request.conversationSummary,
    conversationBackgroundKind: request.conversationBackgroundKind,
  });
  // 依頼文・差分の中身は出さない（credential・顧客情報・proprietary codeが入りうる。
  // 受入基準14）。出すのは実行条件と分量だけ
  log?.info(
    `${SECOND_OPINION_LOG_PREFIX} start provider=codex model=${request.candidate.model} ` +
      `effort=${request.candidate.effort} headless=${String(request.headless)} ` +
      `artifact=${request.artifact.kind} ` +
      `summary=${describeBackgroundForLog(request)} ` +
      `promptChars=${prompt.length}`,
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
        // 打ち切られても、そこまでの回答は捨てない（Issue #907）
        partialOnTimeout: true,
        // 利用者による停止（Issue #940）。渡さなければ内部タイマーだけが打ち切りを起こす
        signal: request.signal,
      },
    );
    if (response.trim() === '') {
      return { ok: false, reason: 'セカンドオピニオンの応答が空でした' };
    }
    return { ok: true, response };
  } catch (e) {
    // 打ち切りでも途中まで出ていれば「失敗」にはしない。長考するモデルほど、
    // ここで捨てると成果が丸ごと消える（Issue #907）。本文はログへ出さず、分量だけ残す
    if (e instanceof SingleTurnTimeoutError && e.partialText !== undefined) {
      log?.info(
        `${SECOND_OPINION_LOG_PREFIX} timeout partial=yes responseChars=${e.partialText.length}`,
      );
      return { ok: true, response: e.partialText, partialReason: e.message };
    }
    // 利用者が止めた場合も同じ扱い（Issue #940）。ただし理由は型で見分け、表示では
    // タイムアウトと区別する（止めた本人にタイムアウトと読ませない）
    if (e instanceof SingleTurnCancelledError) {
      if (e.partialText !== undefined) {
        log?.info(
          `${SECOND_OPINION_LOG_PREFIX} cancelled partial=yes responseChars=${e.partialText.length}`,
        );
        return {
          ok: true,
          response: e.partialText,
          partialReason: e.message,
          cancelledByUser: true,
        };
      }
      log?.info(`${SECOND_OPINION_LOG_PREFIX} cancelled partial=no`);
      return { ok: false, reason: e.message, cancelledByUser: true };
    }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 走っている実行1回分。`SecondOpinionRegistry` が親セッションごとに1つだけ持つ。 */
interface RunningSecondOpinion {
  /** この実行の識別子（Issue #940）。会話へ残す項目のidと同じ値を使う。 */
  runId: string;
  /** 実行全体（会話の要約＋本体）を打ち切る。何度呼んでも安全であること。 */
  cancel: () => void;
}

/**
 * 親セッションごとの実行中管理（Issue #894 受入基準8）と、実行の停止（Issue #940）。
 *
 * 同じ親セッションからの重複起動だけを止める。別の親セッションからの同時実行は
 * 止めない（グローバルに1本へ絞る理由が無い）。ある会話の停止操作が、別の会話で走って
 * いる実行に触れることも無い。
 *
 * 持つのは `TaskSession` ではなく**実行1回分のキャンセルハンドル**である（Issue #940）。
 * 1回のセカンドオピニオンは「会話の要約セッション → 本体のセッション」の順に最大2つの
 * セッションを開くため、`TaskSession` を持たせる形にすると、要約中（本体がまだ無い区間）を
 * 止められない。止める単位はセッションではなく実行そのものとする。
 *
 * 登録は `(parentSessionId, runId)` の組で行う。`runId` を持たないと、
 * 「止める → すぐ次を始める → 前の実行の後始末が走る」の順で、**後から始めた実行の登録を
 * 前の実行が消してしまう**（同じ `parentSessionId` を消すため）。会話に残った古い項目から
 * 遅れて届いた停止操作が、後から始めた実行を止めてしまう問題も同じ根による。
 */
export class SecondOpinionRegistry {
  private readonly running = new Map<string, RunningSecondOpinion>();

  isRunning(parentSessionId: string): boolean {
    return this.running.has(parentSessionId);
  }

  /**
   * 開始できたら `true`。既に走っていれば `false`（呼び出し側は起動しない）。
   *
   * `cancel` は実行全体を打ち切るハンドル。`AbortController.abort()` のように、
   * 複数回呼ばれても安全なものを渡すこと（停止操作の多重押下・停止と後始末の競合で
   * 実際に複数回呼ばれうる）。
   */
  begin(parentSessionId: string, runId: string, cancel: () => void): boolean {
    if (this.running.has(parentSessionId)) {
      return false;
    }
    this.running.set(parentSessionId, { runId, cancel });
    return true;
  }

  /**
   * 走っている実行を止める。止める対象を指定できたら `true`。
   *
   * `runId` が現在走っている実行と一致するときだけ止める。会話に残った古い項目の
   * 停止操作が、後から始めた別の実行を止めてはならない。
   *
   * **ここでは登録を消さない。** 消すのは実行側の後始末（`end`）である。停止を要求しても
   * 実行はまだ決着していない（`runSingleTurnTask` の `settle()` を通り、`finally` で
   * セッションを閉じるまで走る）。ここで消すと、その短い間に次の実行を始められてしまい、
   * 前の実行の後始末が後から効いて状態が食い違う。
   */
  cancel(parentSessionId: string, runId: string): boolean {
    const entry = this.running.get(parentSessionId);
    if (entry === undefined || entry.runId !== runId) {
      return false;
    }
    entry.cancel();
    return true;
  }

  /**
   * 実行の後始末。`runId` が一致するときだけ消す。
   *
   * 古い実行の `finally` が、後から始まった実行の登録を消さないようにする（Issue #940）。
   */
  end(parentSessionId: string, runId: string): void {
    const entry = this.running.get(parentSessionId);
    if (entry !== undefined && entry.runId === runId) {
      this.running.delete(parentSessionId);
    }
  }
}
