import { sanitizeInlineText } from '../orchestrator/untrustedText';
import {
  isSameSource,
  type VerificationAcquisition,
  type VerificationOutcome,
  type VerificationRecord,
  type VerificationStage,
  type VerificationTrust,
} from './record';
import { captureSourceIdentity, type SourceIdentity } from './sourceIdentity';
import type { VerificationRecordFilter, VerificationStore } from './store';

/**
 * 完了根拠の表示区分（Issue #1380）。
 *
 * 区分は保存しない。表示のたびに記録と「表示時点のソース同一性」から導く。完了後に
 * ファイルを変えれば、記録のソースと一致しなくなり、未確認へ戻る。
 *
 * AIの判定（Evaluatorの `achieved`、意味レビューの合格）はここへ入れない。区分は
 * 検証記録だけから決め、AIの判定は表示側で別の欄に示す。
 *
 * - `verified`: ソースが一致する `trusted` の記録があり、すべて成功
 * - `failed`: ソースが一致する `trusted` の記録に成功以外（失敗・結果不明）がある
 * - `selfReportedOnly`: `trusted` の記録が無く、ソースが一致する `agent-reported` の記録だけがある
 * - `notRequested`: `verify.commands` が指定されておらず、記録も無い（完了は自己申告だけで確定した。Issue #1468）
 * - `unverified`: 上のどれでもない（`trusted` の記録が無い、ソースが一致しない、ソースを取れない）
 *
 * 区分は段階が `task` の記録（`stage` 省略を含む）だけから導く。変更を戻した状態（`revert`）や
 * 分岐元（`baseline`）での実行は、失敗して当然の記録なので数えない（Issue #1468）。
 */
export type CompletionEvidenceCategory =
  'verified' | 'failed' | 'selfReportedOnly' | 'notRequested' | 'unverified';

/**
 * 記録のソースと表示時点のソースの関係。
 *
 * - `match`: 一致する
 * - `mismatch`: 一致しない（記録の後にソースが変わった）
 * - `changedDuringRun`: 実行の最中にソースが変わった記録（どの状態を検証したか決められない）
 * - `unknown`: 記録か表示時点のどちらかでソースを取れていない
 */
export type SourceMatch = 'match' | 'mismatch' | 'changedDuringRun' | 'unknown';

export interface CompletionEvidenceDerivation {
  readonly category: CompletionEvidenceCategory;
  /** 区分の理由（固定文言。記録由来の文字列は含めない） */
  readonly reason: string;
}

export function sourceMatchOf(
  record: VerificationRecord,
  current: SourceIdentity | undefined,
): SourceMatch {
  if (record.subject === undefined || current === undefined) {
    return 'unknown';
  }
  if (record.subject.sourceChanged) {
    return 'changedDuringRun';
  }
  return isSameSource(record.subject, current) ? 'match' : 'mismatch';
}

export interface DeriveCompletionEvidenceOptions {
  /**
   * 拡張機能が実行する検証（`verify.commands`）が指定されていたか。`false` のとき、記録が
   * 無ければ `notRequested` にする。省略は `true`（会話画面のループなど、指定の概念が無い経路）
   */
  readonly commandsRequested?: boolean;
}

const stageOf = (record: VerificationRecord): VerificationStage => record.link.stage ?? 'task';

/** 記録と表示時点のソース同一性から表示区分を導く（純粋関数） */
export function deriveCompletionEvidence(
  allRecords: readonly VerificationRecord[],
  current: SourceIdentity | undefined,
  options: DeriveCompletionEvidenceOptions = {},
): CompletionEvidenceDerivation {
  const records = allRecords.filter((record) => stageOf(record) === 'task');
  const matched = records.filter((record) => sourceMatchOf(record, current) === 'match');
  const matchedTrusted = matched.filter((record) => record.trust === 'trusted');
  if (matchedTrusted.length > 0) {
    // 時間切れ・起動失敗（exit codeが無く `unknown`）も成功とは数えない
    if (matchedTrusted.every((record) => record.outcome === 'pass')) {
      return { category: 'verified', reason: '拡張機能が実行した検証がすべて成功' };
    }
    return {
      category: 'failed',
      reason: matchedTrusted.some((record) => record.outcome === 'fail')
        ? '拡張機能が実行した検証に失敗がある'
        : '拡張機能が実行した検証に結果不明（時間切れ・起動失敗）がある',
    };
  }
  if (records.some((record) => record.trust === 'trusted')) {
    return {
      category: 'unverified',
      reason:
        current === undefined
          ? '現在のソースの状態を取得できない'
          : '拡張機能が実行した検証は現在のソースと一致しない',
    };
  }
  if (matched.some((record) => record.acquisition === 'agent-reported')) {
    return { category: 'selfReportedOnly', reason: 'AIが報告した実行記録だけがある' };
  }
  if (current === undefined && records.length > 0) {
    return { category: 'unverified', reason: '現在のソースの状態を取得できない' };
  }
  if (options.commandsRequested === false && records.length === 0) {
    return {
      category: 'notRequested',
      reason: 'verify.commands が指定されておらず、完了は自己申告だけで確定した',
    };
  }
  return { category: 'unverified', reason: '現在のソースと一致する検証記録が無い' };
}

/** webviewへ渡す1記録分の表示。記録由来の文字列は長さを制限し、1行化してある */
export interface CompletionEvidenceEntryView {
  readonly command: string;
  readonly exitCode: number | null;
  readonly outcome: VerificationOutcome;
  readonly acquisition: VerificationAcquisition;
  readonly trust: VerificationTrust;
  /** 実行の終了時刻、無ければ開始時刻、どちらも無ければ保存時刻（ISO 8601） */
  readonly time: string;
  readonly timeKind: 'ended' | 'started' | 'recorded';
  readonly sourceMatch: SourceMatch;
  readonly outputTail: string;
  readonly stage: VerificationStage;
}

export interface CompletionEvidenceView extends CompletionEvidenceDerivation {
  readonly entries: readonly CompletionEvidenceEntryView[];
  /** 表示から省いた古い記録の件数 */
  readonly omitted: number;
}

/** webviewへ渡すコマンドの上限（文字数） */
export const EVIDENCE_COMMAND_MAX_CHARS = 300;
/** webviewへ渡す出力末尾の上限（文字数） */
export const EVIDENCE_OUTPUT_TAIL_MAX_CHARS = 800;
/** webviewへ渡す記録の件数の上限（新しい順） */
export const EVIDENCE_MAX_ENTRIES = 20;

/**
 * 表示区分と各記録の表示を組み立てる（純粋関数）。コマンドと出力はAIやコマンドが
 * 書いた信頼できない本文なので、1行化と長さの制限だけを掛けて渡す（HTMLとしての
 * エスケープはwebview側で `textContent` に入れることで行う）。
 */
export function buildCompletionEvidenceView(
  records: readonly VerificationRecord[],
  current: SourceIdentity | undefined,
  options: DeriveCompletionEvidenceOptions = {},
): CompletionEvidenceView {
  const derivation = deriveCompletionEvidence(records, current, options);
  const newestFirst = [...records].reverse();
  const shown = newestFirst.slice(0, EVIDENCE_MAX_ENTRIES);
  return {
    ...derivation,
    entries: shown.map((record) => toEntryView(record, current)),
    omitted: newestFirst.length - shown.length,
  };
}

function toEntryView(
  record: VerificationRecord,
  current: SourceIdentity | undefined,
): CompletionEvidenceEntryView {
  const [time, timeKind] =
    record.endedAt !== undefined
      ? [record.endedAt, 'ended' as const]
      : record.startedAt !== undefined
        ? [record.startedAt, 'started' as const]
        : [record.recordedAt, 'recorded' as const];
  return {
    command: sanitizeInlineText(record.command, EVIDENCE_COMMAND_MAX_CHARS),
    exitCode: record.exitCode ?? null,
    outcome: record.outcome,
    acquisition: record.acquisition,
    trust: record.trust,
    time,
    timeKind,
    sourceMatch: sourceMatchOf(record, current),
    // 末尾を見せたいので、先に後ろから切り出してから1行化する
    outputTail: sanitizeInlineText(
      record.outputRef.tail.slice(-EVIDENCE_OUTPUT_TAIL_MAX_CHARS),
      EVIDENCE_OUTPUT_TAIL_MAX_CHARS,
    ),
    stage: stageOf(record),
  };
}

export interface LoadCompletionEvidenceOptions {
  /** この時刻（ISO 8601）より前に保存された記録を除く。同じ会話の前のループの記録を混ぜないため */
  readonly since?: string;
  /** テスト用。既定は {@link captureSourceIdentity} */
  readonly capture?: (cwd: string) => Promise<SourceIdentity | undefined>;
}

/**
 * 保存済みの記録を読み、表示時点のソース同一性を取って表示を組み立てる。
 * ソースを取れない（worktreeが撤去された等）場合は、一致しないものとして扱う。
 */
export async function loadCompletionEvidence(
  store: Pick<VerificationStore, 'list'>,
  filter: VerificationRecordFilter,
  cwd: string | undefined,
  options: LoadCompletionEvidenceOptions = {},
): Promise<CompletionEvidenceView> {
  const capture = options.capture ?? captureSourceIdentity;
  const [records, current] = await Promise.all([
    store.list(filter),
    cwd === undefined ? Promise.resolve(undefined) : capture(cwd).catch(() => undefined),
  ]);
  const since = options.since === undefined ? undefined : Date.parse(options.since);
  const scoped =
    since === undefined
      ? records
      : records.filter((record) => Date.parse(record.recordedAt) >= since);
  return buildCompletionEvidenceView(scoped, current);
}

/**
 * ワークフローのrunの各タスクについて表示を組み立てる。記録の読出はrun単位で1回だけ行い、
 * タスクごとに分ける（`list` は保存先の全ファイルを読むため）。
 */
export async function loadTaskCompletionEvidence(
  store: Pick<VerificationStore, 'list'>,
  runId: string,
  tasks: readonly {
    readonly id: string;
    readonly cwd: string | undefined;
    /** `verify.commands` が指定されていたか（{@link DeriveCompletionEvidenceOptions}） */
    readonly commandsRequested?: boolean;
  }[],
  options: Pick<LoadCompletionEvidenceOptions, 'capture'> = {},
): Promise<Record<string, CompletionEvidenceView>> {
  const capture = options.capture ?? captureSourceIdentity;
  const records = await store.list({ runId });
  const entries = await Promise.all(
    tasks.map(async (task): Promise<[string, CompletionEvidenceView]> => {
      const current =
        task.cwd === undefined ? undefined : await capture(task.cwd).catch(() => undefined);
      const own = records.filter((record) => record.link.taskId === task.id);
      return [
        task.id,
        buildCompletionEvidenceView(own, current, {
          ...(task.commandsRequested === undefined
            ? {}
            : { commandsRequested: task.commandsRequested }),
        }),
      ];
    }),
  );
  return Object.fromEntries(entries);
}
