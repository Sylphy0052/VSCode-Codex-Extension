import { fetchReviewComments, type ForgeHost, type ReviewComment } from './forge';
import { truncateByCodePoint } from './untrustedText';
import { MAX_MESSAGE_BODY_LENGTH } from './messaging';
import { notifyOrchestrator } from './runnerOrchestrator';
import type { WorkflowRunnerInternals } from './runnerInternals';
import type { LiveRun } from './runner';

/**
 * PR/MRのレビュー結果をタスクへ反映する（design.md §16.30、roadmap W5、Issue #339）。
 *
 * `finalizeForge`（`runner.ts`）が統合PR/MRの作成に成功した直後に`startReviewCommentPoll`を
 * 呼び、`agent.workflows.reviewCommentPollIntervalSec`の間隔でレビューコメントを取得する。
 * 新しく見つかったコメントは`notifyOrchestrator`（`taskMessage`/`taskQuestion`と同じ配送
 * 経路）で1件ずつ届け、ワークフローViewの警告欄（`reviewCommentImported`）へも全文で残す
 * （Issue #339「人の承認を挟まない代わりに、取り込んだ内容と適用した変更を警告欄へ全文で
 * 残す」）。オーケストレーターはこの通知を受けて`add_task`/`update_task_prompt`等
 * （design.md §16.29）で対応するタスクを組む。
 *
 * `messaging.ts`のタスク間メッセージングと同じ「無くても実行は止めない」設計。CLIや認証が
 * 無い環境では`fetchReviewComments`が`ok: false`を返すだけで、runは止めない
 * （design.md §16.18「前提が欠けている場合」と同じ方針。前提チェック自体は統合PR/MRを
 * 作れた時点で通っているはずだが、認証切れ・CLIの更新等で後から失われる場合もあるため、
 * 個別の取得の失敗もログに残すだけで無視する）。
 */

/** 1件のレビューコメントをオーケストレーターへ届ける本文を組み立てる（無害化前のプレーンテキスト）。
 *
 * `runnerMessaging.ts`の`buildTaskMessageEventBody`と同じ規約: ここでは`stripControlChars`等の
 * サニタイズを行わない。無害化は`orchestratorSession.ts`の`wrapEvent`が
 * `<workflow-event kind="reviewComment">`で囲むときに一度だけ行う（design.md §16.24・§16.34。
 * 二重サニタイズを避ける）。
 *
 * 本文は`MAX_MESSAGE_BODY_LENGTH`（send_message等と同じ上限）でコードポイント単位に
 * 切り詰める。外部のレビューコメントは長さに制限が無いため、切り詰め無しに`live.warnings`・
 * オーケストレーターへの通知本文へそのまま載せると、run全体のメモリ・表示量が
 * コメント1件の長さに引きずられて際限なく増えうる。
 */
function buildReviewCommentBody(comment: ReviewComment): string {
  const author = comment.author.trim() !== '' ? comment.author : '(不明)';
  const truncated = truncateByCodePoint(comment.body, MAX_MESSAGE_BODY_LENGTH);
  const bodyText = truncated.truncated
    ? `${truncated.text}…（長さの上限のため切り詰めました）`
    : truncated.text;
  return [`統合PR/MRにレビューコメントが付きました（投稿者: ${author}）。`, '本文:', bodyText].join(
    '\n',
  );
}

/**
 * レビューコメントを1回取得し、前回まで通知していない分だけオーケストレーターへ届ける。
 *
 * ポーリングタイマー（`startReviewCommentPoll`）から定期的に呼ばれるほか、テストからも
 * 直接呼べる（本番の呼び出し経路そのものであり、タイマーは単にこの関数を定期実行する
 * だけの薄い配線のため、直接呼んでも本番の呼び出し経路を迂回したことにはならない）。
 */
export async function pollReviewComments(
  self: WorkflowRunnerInternals,
  runId: string,
): Promise<void> {
  const live = self.runs.get(runId);
  const poll = live?.reviewCommentPoll;
  const forgeDeps = self.deps.forge;
  if (live === undefined || poll === undefined || forgeDeps === undefined) {
    return;
  }
  const result = await fetchReviewComments(forgeDeps.cli, poll.host, poll.cwd, poll.number);
  if (!result.ok) {
    self.deps.log.warn(
      `[workflow ${runId}] レビューコメントの取得に失敗しました: ${result.message ?? '(不明なエラー)'}`,
    );
    return;
  }
  // runそのものが破棄されていないかだけ再確認する（awaitの間にdispose()等でrunが
  // `self.runs`から取り除かれた可能性がある。`prepareTaskLaunch`等、他の非同期処理と
  // 同じ多層防御）。`poll`（awaitの前に取り出した参照）は使い続けてよい: 統合PR/MRの
  // 最終マージが`fetchReviewComments`のawait中に確定して`closeReviewCommentPoll`が
  // `live.reviewCommentPoll`を先にundefinedへ戻すことがあるが（design.md §16.18の
  // 最終マージ確定パスと本ポーリングは非同期に競合しうる）、そのタイミングで届いた
  // コメントも「取り込んだ内容は全文で警告欄へ残す」（Issue #339）対象であり、
  // ポーリングを閉じたことを理由に握りつぶさない。`seenCommentIds`は`poll`が持つ
  // 同一のSetインスタンスのため、`live.reviewCommentPoll`が閉じられた後でも
  // 重複排除の状態は正しく引き継がれる
  const current = self.runs.get(runId);
  if (current === undefined) {
    return;
  }
  let changed = false;
  for (const comment of result.comments) {
    if (poll.seenCommentIds.has(comment.id)) {
      continue;
    }
    poll.seenCommentIds.add(comment.id);
    const body = buildReviewCommentBody(comment);
    notifyOrchestrator(self, runId, { kind: 'reviewComment', body });
    current.warnings.push({
      kind: 'reviewCommentImported',
      taskId: undefined,
      message: body,
    });
    changed = true;
  }
  if (changed) {
    self.notify(runId);
    void self.persist(runId);
  }
}

/**
 * レビューコメントのポーリングタイマーを立てる（design.md §16.30）。統合PR/MRの作成に
 * 成功した直後、`finalizeForge`から1度だけ呼ぶ。`intervalSec`が0以下なら何もしない
 * （設定で明示的に無効化できるようにする。Issue #339「取得のタイミングと頻度は設定で
 * 決める」）。既に立っている場合は二重に立てない（冪等）。
 */
export function startReviewCommentPoll(
  self: WorkflowRunnerInternals,
  runId: string,
  host: ForgeHost,
  cwd: string,
  number: number,
  intervalSec: number,
): void {
  const live = self.runs.get(runId);
  if (live === undefined || live.reviewCommentPoll !== undefined) {
    return;
  }
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    return;
  }
  const timer = setInterval(() => void pollReviewComments(self, runId), intervalSec * 1000);
  timer.unref?.();
  live.reviewCommentPoll = { timer, seenCommentIds: new Set(), host, cwd, number };
  // 起動直後にも1度取得する（次のポーリング周期まで待たせない）
  void pollReviewComments(self, runId);
}

/**
 * レビューコメントのポーリングタイマーを閉じる（`closeMessaging`と同じ「run終了時・
 * 拡張機能の終了時の両方から呼ぶ共通の後始末」方針、Issue #339）。**冪等**。
 */
export function closeReviewCommentPoll(live: LiveRun): void {
  const poll = live.reviewCommentPoll;
  if (poll === undefined) {
    return;
  }
  live.reviewCommentPoll = undefined;
  clearInterval(poll.timer);
}
