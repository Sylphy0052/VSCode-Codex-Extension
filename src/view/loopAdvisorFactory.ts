import { readClaudeConfig, readConfig, readLoopAdvisorConfig } from '../config';
import {
  ADVISOR_FAILURE_ALERT_THRESHOLD,
  type LoopAdvice,
  type LoopAdvisorConfig,
  type LoopAdvisorFailureReason,
  type LoopAdvisorNote,
  resolveAdvisorModel,
} from '../loop/loopAdvisor';
import { resolveHeadlessProvider, type HeadlessProvider } from '../loop/headlessCli';
import { createLoopAdvisor } from '../loop/loopAdvisorProcess';
import type { Logger } from '../log';

/**
 * ループのAdvisor（issue #957）を設定から組み立てる。
 *
 * `goalEvaluatorFactory.ts`と同じ流儀で、設定の読み出しと実行ファイルの解決はview層が
 * 受け持つ（`LoopController`も`loopAdvisorProcess`も`vscode`に依存しない）。
 *
 * 無効なとき、または会話へ差し込む手段が無いときも`undefined`ではなく設定を返さない
 * ことで、**`LoopPlan.advisor`が付かない＝既存の挙動そのまま**になる。
 */
export function createLoopAdvisorConfig(
  host: HeadlessProvider,
  log: Logger,
  note: (note: LoopAdvisorNote, iteration: number, runId: number) => void,
): LoopAdvisorConfig | undefined {
  const settings = readLoopAdvisorConfig();
  if (!settings.enabled) {
    return undefined;
  }
  const provider = resolveHeadlessProvider(settings.provider, host);
  // 会話しているのと別のCLIを指定されることがあるため、実行ファイルは呼ぶ先に合わせて読む
  const executable =
    provider === 'claude' ? readClaudeConfig().executablePath : readConfig().executablePath;
  return {
    advise: createLoopAdvisor({
      provider,
      executable,
      // 設定が`auto`のときのモデル名は、呼ぶ先が決まってからでないと選べない（issue #994）
      model: resolveAdvisorModel(settings.model, provider),
      timeoutMs: settings.timeoutSeconds * 1000,
      logWarn: (message) => log.warn(message),
      logInfo: (message) => log.info(message),
    }),
    everyNTurns: settings.everyNTurns,
    note,
  };
}

/** 深刻度の表示名。会話に残す見出しへ使う。 */
const SEVERITY_LABEL: Record<LoopAdvice['severity'], string> = {
  blocker: '重大な指摘',
  concern: '指摘',
  note: '参考',
};

/** Advisorが動けなかった理由の表示名。 */
const FAILURE_LABEL: Record<LoopAdvisorFailureReason, string> = {
  timeout: '時間内に応答しませんでした',
  'invalid-response': '応答を読み取れませんでした',
  'process-error': '起動できないか、途中で終了しました',
};

/**
 * Advisorの結果を会話へ差し込む表示を組み立てる。
 *
 * **Advisorへ送った材料の全文は残さない。** 証拠と応答本文の再掲になり、ターンごとに
 * 会話が埋まる。残すのは深刻度・指摘の全文・Advisorが挙げた根拠だけにする。
 *
 * 動けなかった周は「指摘はありませんでした」と書かない（issue #964）。**評価できなかった
 * ことをそのまま出す。** 続けて失敗しているときは、Advisorが実質無効になっていることが
 * 分かる書き方にする。
 */
export function advisorDisplay(
  note: LoopAdvisorNote,
  iteration: number,
): { status: string; text: string; detail: string } {
  if (note.status === 'failed') {
    return failureDisplay(note, iteration);
  }
  if (note.status === 'disabled') {
    return disabledDisplay(note, iteration);
  }
  const advice = note.advice;
  const heading = `Advisor（${iteration}ターン目）: ${SEVERITY_LABEL[advice.severity]}`;
  const body =
    advice.findings.length === 0
      ? '指摘はありませんでした。'
      : advice.findings.map((finding) => `- ${finding}`).join('\n');
  const focus =
    advice.severity !== 'note' && advice.nextFocus !== ''
      ? `\n\n次に見直すこと: ${advice.nextFocus}`
      : '';
  return {
    status: advice.severity,
    text: `${heading}\n\n${body}${focus}`,
    detail: advice.evidence.length === 0 ? '' : advice.evidence.map((e) => `- ${e}`).join('\n'),
  };
}

/**
 * Advisorが動けなかった周の表示。
 *
 * 1回目は事実だけを書き、`ADVISOR_FAILURE_ALERT_THRESHOLD`回続いた時点から「連続して
 * 動けていない」と明示する。ここで初めて、Advisorが実質無効のまま回っていることが
 * 利用者に伝わる。
 *
 * 同じ回数で`LoopController`はこの実行のAdvisorを止める（issue #1009）。**止めたことは
 * この文面で伝える。** 呼ぶのをやめたことを別の項目で出すと、失敗の記録と止めた記録が
 * 会話に2行並び、同じことを2回言うことになる。
 */
function failureDisplay(
  note: Extract<LoopAdvisorNote, { status: 'failed' }>,
  iteration: number,
): { status: string; text: string; detail: string } {
  const alerting = note.consecutiveFailures >= ADVISOR_FAILURE_ALERT_THRESHOLD;
  const heading = `Advisor（${iteration}ターン目）: 評価できませんでした`;
  const body = `今回はAdvisorを実行できませんでした（${FAILURE_LABEL[note.reason]}）。ループは続行しています。`;
  const alert = alerting
    ? `\n\nAdvisorが${note.consecutiveFailures}回続けて動けていません。設定（実行ファイル・モデル・タイムアウト）を確認してください。この状態では進め方の点検が行われていません。`
    : '';
  return {
    status: alerting ? 'concern' : 'note',
    text: `${heading}\n\n${body}${alert}`,
    detail: '',
  };
}

/**
 * 連続失敗が続いたため、この実行ではもうAdvisorを呼ばないことの表示（issue #1009）。
 *
 * `failureDisplay`の警告と違い、**この先は呼ばれない**ことを伝える。1回の呼び出しは
 * 最大でタイムアウトぶん待つため、失敗が続く状態を放っておくと待ち時間だけが積み上がる。
 * 止めたことを黙っていると、Advisorが動いていないことに気づけないまま回ることになる。
 */
function disabledDisplay(
  note: Extract<LoopAdvisorNote, { status: 'disabled' }>,
  iteration: number,
): { status: string; text: string; detail: string } {
  return {
    status: 'concern',
    text:
      `Advisor（${iteration}ターン目）: このループでは呼ぶのをやめました\n\n` +
      `Advisorが${note.consecutiveFailures}回続けて動けなかったため（${FAILURE_LABEL[note.reason]}）、` +
      'このループの残りでは呼びません。1回あたり最大でタイムアウトぶん待つため、' +
      '指摘が得られないまま待ち時間だけが増えるのを避けます。' +
      '設定（実行ファイル・モデル・タイムアウト）を確認してください。' +
      '次にループを始めたときは、またAdvisorを呼びます。',
    detail: '',
  };
}

/**
 * ゴールの無いループをAdvisor有効のまま始めたときの注記（issue #1009）。
 *
 * Advisorはゴール駆動ループでしか動かない（`LoopPlan.advisor`のコメント）。設定と
 * トグルはONのままなので、**黙って何も起きない**と「効いているつもり」で回せてしまう。
 * ループの開始時に1回だけ出し、毎ターンは繰り返さない（毎周出すと本編が埋まる）。
 */
export function advisorSkippedDisplay(): { status: string; text: string; detail: string } {
  return {
    status: 'note',
    text:
      'Advisor: このループでは動きません\n\n' +
      'Advisorはゴール（目的と受入基準）を入力したループでのみ動きます。' +
      '目的を入れずに始めたため、このループの進め方は点検されません。',
    detail: '',
  };
}
