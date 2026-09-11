import type { SafeBoundaryGateInput } from './handoff';
import type { HandoffTrigger } from './handoff';
import type { SafeBoundaryProbe } from './handoffModelChoice';
import type { TaskAssessment } from './handoffRouter';

/**
 * 自動引き継ぎの判定過程を `Agent Sessions` の Output チャネルへ出す（Issue #1097）。
 *
 * 判定が落ちたときに、前段のゲートで止まったのか・分類器が時間切れだったのか・
 * `handoffSuggested` が立たなかったのかを外から切り分けられるようにする。実機で発火
 * しなかった事例の原因を特定できなかったのが動機で、ログが無いと「発火しなかった」しか
 * 判らない。
 *
 * 新しいチャネルは作らない。各viewが既に持っている `Logger` へそのまま流す。
 *
 * 行頭は全部 `autoHandoff:` で揃える。ターン完了のたびに出るため、Output側で絞り込める
 * ようにしておく。**同じ行が連続したときは出さない**（`HandoffTrace`）。前段で落ちる
 * ケースはターンのたびに同じ理由が並び、そのままではログが流れる。
 */

const PREFIX = 'autoHandoff:';

/** 判定の各段で出す1行を受け取る先。実体は各viewの `Logger`。 */
export interface HandoffTraceSink {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * 同じ理由の連続を抑えて記録する。
 *
 * 抑えるのは**直前に出した行と完全に同じとき**だけ。間に別の行が挟まれば同じ理由でも
 * また出す。件数を数えて「n回省略」と出すことはしない——判定の追跡に必要なのは理由が
 * 変わった瞬間であって、回数ではない。
 */
export class HandoffTrace {
  private last: string | undefined;

  constructor(private readonly sink: HandoffTraceSink) {}

  info(message: string): void {
    const line = `${PREFIX} ${message}`;
    if (line === this.last) {
      return;
    }
    this.last = line;
    this.sink.info(line);
  }

  /** 警告は抑制しない。分類器の失敗は毎回の事実として残す。 */
  warn(message: string): void {
    const line = `${PREFIX} ${message}`;
    this.last = line;
    this.sink.warn(line);
  }
}

/** 前段のゲートで落ちた理由。**全条件の値を並べる**（どれが原因かを後から絞れるように）。 */
export function describeGate(input: SafeBoundaryGateInput): string {
  return [
    `busy=${input.busy}`,
    `turnFailed=${input.turnFailed}`,
    `pendingApprovals=${input.pendingApprovals}`,
    `pendingPrompts=${input.pendingPrompts}`,
    `queued=${input.queued}`,
    `loopRunning=${input.loopRunning}`,
    `taskManaged=${input.taskManaged}`,
  ].join(' ');
}

/** 分類器が返した見立て。5軸と判定に効く2つのbooleanを1行へ。 */
export function describeAssessment(assessment: TaskAssessment): string {
  return [
    `taskType=${assessment.taskType}`,
    `difficulty=${assessment.difficulty}`,
    `scope=${assessment.scope}`,
    `ambiguity=${assessment.ambiguity}`,
    `risk=${assessment.risk}`,
    `autonomy=${assessment.autonomy}`,
    `confidence=${assessment.confidence.toFixed(2)}`,
    `switchSafe=${assessment.switchSafe}`,
    `handoffSuggested=${assessment.handoffSuggested}`,
    `switchReason=${assessment.switchReason || '(なし)'}`,
    `handoffSuggestReason=${assessment.handoffSuggestReason || '(なし)'}`,
  ].join(' ');
}

/** 解決したmodel/effortと `isProfileChange` の結果。 */
export function describeProfile(probe: SafeBoundaryProbe): string {
  return [
    `model=${probe.profile.model || '既定'}`,
    `effort=${probe.profile.effort || '既定'}`,
    `profileChanged=${probe.profileChanged}`,
  ].join(' ');
}

/** `decideAutoHandoff` の結論。発火しなかったときも1行残す。 */
export function describeDecision(trigger: HandoffTrigger | undefined): string {
  if (trigger === undefined) {
    return 'decision: 発火しない';
  }
  if (trigger.kind === 'threshold' || trigger.kind === 'softThreshold') {
    return `decision: ${trigger.kind} (remainingPercent=${trigger.remainingPercent})`;
  }
  if (trigger.kind === 'profileChanged') {
    return `decision: profileChanged (${trigger.model || '既定'} / ${trigger.effort || '既定'})`;
  }
  if (trigger.kind === 'assistantSuggested') {
    return `decision: assistantSuggested (${trigger.suggestReason || '根拠の記録なし'})`;
  }
  return `decision: ${trigger.kind}`;
}
