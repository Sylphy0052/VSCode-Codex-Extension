import { homedir } from 'node:os';
import type { VerifyCommandResult } from '../verification/commandRunner';
import { maskOutputTail, type VerificationStage } from '../verification/record';
import type { Logger } from '../log';
import { withTemporaryRevert, type RevertScope } from './runnerRevert';
import type { ExecuteVerifyCommandsResult, ExecutedVerifyCommand } from './runnerVerifyCommands';
import type { GitCommandRunner } from './worktree';
import type { WorkflowTask } from './workflow';

/**
 * `verify.commands` がすべて通った後に、変更を一時的に戻して測り直す（Issue #1468）。
 *
 * - `verify.revertCheck`: テスト以外の変更を戻して `verify.commands` を再実行する。
 *   それでも全部通るなら、テストが変更を検出していないとして失敗にする
 * - `verify.baseline`: 変更全体を戻して（分岐元の状態で）指定のコマンドを実行する。
 *   成否は問わず、タスク側の結果と並べて意味レビューへ渡す
 *
 * 作業ツリーを元へ戻せなかったときは `restoreError` を返す。呼び出し側はタスクを
 * 再試行させずに `failed` にする（壊れた作業ツリーのまま担当に続けさせない）。
 */

/** 意味レビューへ渡す出力末尾の上限（文字数） */
const MEASUREMENT_OUTPUT_MAX_CHARS = 1_000;

export interface VerifyStagesResult {
  readonly failures: string[];
  /** 分岐元とタスク後の結果を並べた文字列（`verify.baseline` を実行したときだけ） */
  readonly measurements?: string;
  /** 作業ツリーを元へ戻せなかった理由 */
  readonly restoreError?: string;
  readonly aborted: boolean;
}

export async function runVerifyStages(input: {
  readonly task: WorkflowTask;
  readonly taskId: string;
  readonly cwd: string;
  readonly originCommit: string;
  readonly git: GitCommandRunner;
  /** タスクの状態で `verify.commands` を実行した結果 */
  readonly taskRun: readonly ExecutedVerifyCommand[];
  readonly execute: (
    commands: readonly string[],
    stage: VerificationStage,
  ) => Promise<ExecuteVerifyCommandsResult>;
  readonly log: Logger;
  readonly logPrefix: string;
}): Promise<VerifyStagesResult> {
  const verify = input.task.verify;
  const failures: string[] = [];
  const wantsRevert = verify?.revertCheck === true;
  const baseline = verify?.baseline ?? [];
  if (!wantsRevert && baseline.length === 0) {
    return { failures, aborted: false };
  }
  if (input.originCommit === '') {
    input.log.warn(
      `${input.logPrefix} 分岐元のコミットが分からないため、verify.revertCheck / verify.baseline を実行しませんでした`,
    );
    return { failures, aborted: false };
  }

  const runReverted = (scope: RevertScope, commands: readonly string[], stage: VerificationStage) =>
    withTemporaryRevert({
      git: input.git,
      cwd: input.cwd,
      originCommit: input.originCommit,
      scope,
      body: () => input.execute(commands, stage),
    });

  if (wantsRevert) {
    const reverted = await runReverted('production', verify?.commands ?? [], 'revert');
    if (
      reverted.kind === 'failed' ||
      (reverted.kind === 'ran' && reverted.restoreError !== undefined)
    ) {
      return fail(failures, reverted, input);
    }
    if (reverted.kind === 'noChanges') {
      input.log.info(
        `${input.logPrefix} テスト以外の変更が無いため、verify.revertCheck を見送りました`,
      );
    } else if (reverted.value.aborted) {
      return { failures, aborted: true };
    } else if (reverted.value.failures.length === 0) {
      failures.push(
        [
          'テスト以外の変更を戻しても verify.commands がすべて成功しました。テストが変更を検出していません。',
          '変更を戻すと失敗するテストを追加してください。',
          `戻したファイル: ${reverted.revertedPaths.slice(0, 20).join(', ')}${
            reverted.revertedPaths.length > 20 ? ` ほか${reverted.revertedPaths.length - 20}件` : ''
          }`,
        ].join('\n'),
      );
    }
  }

  if (baseline.length === 0) {
    return { failures, aborted: false };
  }
  const based = await runReverted('all', baseline, 'baseline');
  if (based.kind === 'failed' || (based.kind === 'ran' && based.restoreError !== undefined)) {
    return fail(failures, based, input);
  }
  if (based.kind === 'noChanges') {
    input.log.info(`${input.logPrefix} 分岐元からの変更が無いため、verify.baseline を見送りました`);
    return { failures, aborted: false };
  }
  if (based.value.aborted) {
    return { failures, aborted: true };
  }
  return {
    failures,
    measurements: formatMeasurements(baseline, based.value.executed, input.taskRun),
    aborted: false,
  };
}

function fail(
  failures: string[],
  result: { readonly kind: string; readonly error?: string; readonly restoreError?: string },
  input: { readonly log: Logger; readonly logPrefix: string },
): VerifyStagesResult {
  if (result.restoreError !== undefined) {
    input.log.error(
      `${input.logPrefix} 変更を戻して検証した後、作業ツリーを元へ戻せませんでした: ${result.restoreError}`,
    );
    return { failures, restoreError: result.restoreError, aborted: false };
  }
  // 戻す前に失敗し、作業ツリーは元のまま。検証の失敗として担当へ返す
  failures.push(`変更を戻した検証を実行できませんでした: ${result.error ?? '原因不明'}`);
  return { failures, aborted: false };
}

function formatMeasurements(
  commands: readonly string[],
  base: readonly ExecutedVerifyCommand[],
  task: readonly ExecutedVerifyCommand[],
): string {
  const describe = (label: string, result: VerifyCommandResult | undefined): string[] => {
    if (result === undefined) {
      return [`${label}: 結果なし`];
    }
    const status = result.timedOut
      ? '時間切れ'
      : result.exitCode === undefined
        ? `実行できず（${result.error ?? '原因不明'}）`
        : `exit ${result.exitCode}`;
    // 全体を受け取る側（意味レビューのプロンプト）がデータとして囲うので、ここでは囲わない
    const tail = maskOutputTail(result.output, homedir(), MEASUREMENT_OUTPUT_MAX_CHARS).trim();
    return tail === '' ? [`${label}: ${status}`] : [`${label}: ${status}`, tail];
  };
  return commands
    .flatMap((command) => [
      `### ${command}`,
      ...describe('分岐元', base.find((entry) => entry.command === command)?.result),
      ...describe('タスク後', task.find((entry) => entry.command === command)?.result),
      '',
    ])
    .join('\n')
    .trimEnd();
}
