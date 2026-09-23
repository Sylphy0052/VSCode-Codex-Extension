import { randomUUID } from 'node:crypto';
import { maskForLog } from '../orchestrator/sanitize';
import type { SourceIdentity } from './sourceIdentity';

/**
 * 検証結果の来歴（Issue #1377）。
 *
 * 「どのリポジトリの、どのソースの状態で、誰が、どう取得した実行結果か」を1件の記録に
 * まとめる。完了根拠の表示（G）の土台で、本モジュールは型と記録の組み立てだけを持つ。
 * 記録を作る取得口（`verify.commands` の実行・会話からの取り込み）は別Issue。
 */

/** 記録の形式の版。形を変えたら上げ、読出側は知らない版を捨てる */
export const VERIFICATION_RECORD_SCHEMA_VERSION = 1;

/**
 * 取得方法。
 *
 * - `observed`: 拡張機能がコマンドを自分で実行し、exit codeと出力を直接見たもの
 * - `agent-reported`: エージェント（AI）が「実行した」と報告したもの
 * - `imported`: 外部（PR/MRコメント・CIなど）から取り込んだもの
 */
export type VerificationAcquisition = 'observed' | 'agent-reported' | 'imported';

/** 信頼区分。取得方法だけで決まる（{@link trustForAcquisition}） */
export type VerificationTrust = 'trusted' | 'untrusted';

/** 実行者。`worker:<provider>` はワークフローのWorker（例 `worker:codex`） */
export type VerificationActor = 'extension' | `worker:${string}` | 'external';

export type VerificationOutcome = 'pass' | 'fail' | 'unknown';

/**
 * 検証したソース。HEADだけでは同一性を決めず、未コミット変更の内容（`dirtyStateId`）と
 * 組で見る。`sourceChanged` は実行の前後で同一性が変わったことを表す。
 */
export interface VerificationSubject extends SourceIdentity {
  readonly sourceChanged: boolean;
}

export interface VerificationOutputRef {
  /** 出力の末尾。{@link maskForLog} を通した後の文字列 */
  readonly tail: string;
  /** 全文を別に退避した場合の参照（現時点では誰も書かない） */
  readonly offloadId?: string;
}

/** タスク（runId / taskId / 試行番号）またはループ（セッションID / iteration）との紐付け */
export interface VerificationLink {
  readonly runId?: string;
  readonly taskId?: string;
  readonly attempt?: number;
  readonly sessionId?: string;
  readonly iteration?: number;
}

export interface VerificationRecord {
  readonly id: string;
  readonly schemaVersion: typeof VERIFICATION_RECORD_SCHEMA_VERSION;
  /** ソースの同一性。gitリポジトリの外で実行した・取り込み元が持たない場合は無い */
  readonly subject?: VerificationSubject;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | undefined;
  readonly outcome: VerificationOutcome;
  /** ISO 8601。会話の項目から作る記録（`agent-reported`）のように時刻が取れない場合は無い */
  readonly startedAt?: string;
  /** ISO 8601。取れない場合は無い（`startedAt` と同じ） */
  readonly endedAt?: string;
  /** 保存した時刻（ISO 8601）。保存期間・件数の上限はこの時刻の古い順に消す */
  readonly recordedAt: string;
  readonly actor: VerificationActor;
  readonly acquisition: VerificationAcquisition;
  readonly trust: VerificationTrust;
  readonly outputRef: VerificationOutputRef;
  readonly link: VerificationLink;
}

/**
 * 信頼区分は取得方法だけで決める。拡張機能が直接観測したもの以外は `trusted` にしない
 * （#962 の「AIを通過したデータをtrustedへ昇格させない」原則）。呼び出し側から
 * 信頼区分を渡す口は作らない。
 */
export function trustForAcquisition(acquisition: VerificationAcquisition): VerificationTrust {
  return acquisition === 'observed' ? 'trusted' : 'untrusted';
}

/** exit codeだけから判定する。exit codeの無い記録（報告文だけの記録など）は `unknown` */
export function outcomeForExitCode(exitCode: number | undefined): VerificationOutcome {
  if (exitCode === undefined) {
    return 'unknown';
  }
  return exitCode === 0 ? 'pass' : 'fail';
}

/** 保存する出力末尾の上限（文字数） */
export const OUTPUT_TAIL_MAX_CHARS = 4_000;

/**
 * マスクを掛ける前に切り出す窓の倍率。`maskForLog` は入力長に比例して重くなる
 * （10MB級で秒単位）ので全文には掛けず、末尾の広めの窓だけに掛ける。
 */
const MASK_WINDOW_FACTOR = 4;

/**
 * 出力の末尾を、機密情報のマスクを通して取り出す。
 *
 * 切り出してからマスクするとトークンが窓の境界で切れ、形が崩れてマスクに当たらない。
 * そこで広めの窓を取り、窓で切れた先頭行は捨ててからマスクし、最後に上限まで詰める。
 * 窓に改行が無い場合も、境界で切れた断片は最後の詰めで落ちる（窓は上限の4倍あり、
 * マスクで縮むのは置換した箇所だけ）。
 */
export function maskOutputTail(
  output: string,
  homeDir?: string,
  maxChars = OUTPUT_TAIL_MAX_CHARS,
): string {
  const windowChars = maxChars * MASK_WINDOW_FACTOR;
  let window = output;
  if (output.length > windowChars) {
    window = output.slice(-windowChars);
    const firstNewline = window.indexOf('\n');
    if (firstNewline !== -1) {
      window = window.slice(firstNewline + 1);
    }
  }
  const masked = maskForLog(window, homeDir);
  // `slice` は親文字列を掴んだままにするので、長い出力の全体がメモリに残らないようコピーする
  return Buffer.from(masked.slice(-maxChars), 'utf8').toString('utf8');
}

export interface VerificationRecordInput {
  /** 実行前のソース同一性。取れなかった場合は `undefined` */
  readonly before?: SourceIdentity | undefined;
  /** 実行後のソース同一性。取れなかった場合は `undefined` */
  readonly after?: SourceIdentity | undefined;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | undefined;
  /** 取れない場合は `undefined`。推測した時刻（保存時刻など）で埋めない */
  readonly startedAt: Date | undefined;
  readonly endedAt: Date | undefined;
  readonly actor: VerificationActor;
  readonly acquisition: VerificationAcquisition;
  /** 生の出力。末尾だけをマスクして保存する */
  readonly output: string;
  readonly offloadId?: string;
  readonly link?: VerificationLink;
}

/**
 * 実行前後の同一性から `subject` を作る。記録するのは実行前の状態（検証を始めた対象）で、
 * 後が違う・後を取れなかった場合は `sourceChanged` を真にする。
 */
export function buildSubject(
  before: SourceIdentity | undefined,
  after: SourceIdentity | undefined,
): VerificationSubject | undefined {
  if (before === undefined) {
    return undefined;
  }
  return { ...before, sourceChanged: after === undefined || !isSameSource(before, after) };
}

export function isSameSource(a: SourceIdentity, b: SourceIdentity): boolean {
  return (
    a.repoId === b.repoId &&
    a.worktreeId === b.worktreeId &&
    a.head === b.head &&
    a.dirtyStateId === b.dirtyStateId
  );
}

export interface BuildRecordOptions {
  readonly now?: Date;
  readonly homeDir?: string | undefined;
  readonly newId?: () => string;
}

/**
 * 記録を組み立てる。信頼区分・結果・出力のマスクはここで決め、呼び出し側からは渡させない。
 * 返す記録は凍結する（保存後に書き換えさせない）。
 *
 * 読出時の検査（{@link parseVerificationRecord}）を通らない記録は作らず、例外を投げる
 * （`worker:` の後が空・exit codeが整数でない等）。保存できても読み出せない記録を残さないため。
 */
export function buildVerificationRecord(
  input: VerificationRecordInput,
  options: BuildRecordOptions = {},
): VerificationRecord {
  const record = assembleRecord(input, options);
  if (parseVerificationRecord(JSON.parse(JSON.stringify(record))) === undefined) {
    throw new TypeError('検証記録の入力が不正（actor・exit code・紐付けの形を確認する）');
  }
  return deepFreeze(record);
}

function assembleRecord(
  input: VerificationRecordInput,
  options: BuildRecordOptions,
): VerificationRecord {
  const subject = buildSubject(input.before, input.after);
  const outputRef: VerificationOutputRef =
    input.offloadId === undefined
      ? { tail: maskOutputTail(input.output, options.homeDir) }
      : { tail: maskOutputTail(input.output, options.homeDir), offloadId: input.offloadId };
  return {
    id: (options.newId ?? randomUUID)(),
    schemaVersion: VERIFICATION_RECORD_SCHEMA_VERSION,
    ...(subject === undefined ? {} : { subject }),
    command: maskForLog(input.command, options.homeDir),
    cwd: input.cwd,
    exitCode: input.exitCode,
    outcome: outcomeForExitCode(input.exitCode),
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt.toISOString() }),
    ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt.toISOString() }),
    recordedAt: (options.now ?? new Date()).toISOString(),
    actor: input.actor,
    acquisition: input.acquisition,
    trust: trustForAcquisition(input.acquisition),
    outputRef,
    link: { ...input.link },
  };
}

const ACQUISITIONS: readonly string[] = ['observed', 'agent-reported', 'imported'];
const OUTCOMES: readonly string[] = ['pass', 'fail', 'unknown'];

const isOptionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';
const isOptionalInt = (v: unknown): boolean => v === undefined || Number.isInteger(v);
const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v));

function isActor(v: unknown): v is VerificationActor {
  return (
    typeof v === 'string' && (v === 'extension' || v === 'external' || /^worker:[\w.-]+$/u.test(v))
  );
}

function isSubject(v: unknown): v is VerificationSubject {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const s = v as Record<string, unknown>;
  return (
    typeof s.repoId === 'string' &&
    typeof s.worktreeId === 'string' &&
    (s.head === undefined || typeof s.head === 'string') &&
    typeof s.dirtyStateId === 'string' &&
    typeof s.sourceChanged === 'boolean'
  );
}

/**
 * 保存先から読んだ値を検査して記録に戻す。形が合わない・知らない版・信頼区分が取得方法と
 * 食い違う（ファイルを外から書き換えて `trusted` に見せかけた）ものは `undefined` を返す。
 */
export function parseVerificationRecord(value: unknown): VerificationRecord | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== VERIFICATION_RECORD_SCHEMA_VERSION) {
    return undefined;
  }
  if (
    typeof r.id !== 'string' ||
    typeof r.command !== 'string' ||
    typeof r.cwd !== 'string' ||
    !isOptionalInt(r.exitCode) ||
    typeof r.outcome !== 'string' ||
    !OUTCOMES.includes(r.outcome) ||
    (r.startedAt !== undefined && !isIsoDate(r.startedAt)) ||
    (r.endedAt !== undefined && !isIsoDate(r.endedAt)) ||
    !isIsoDate(r.recordedAt) ||
    !isActor(r.actor) ||
    typeof r.acquisition !== 'string' ||
    !ACQUISITIONS.includes(r.acquisition) ||
    (r.subject !== undefined && !isSubject(r.subject))
  ) {
    return undefined;
  }
  const acquisition = r.acquisition as VerificationAcquisition;
  if (r.trust !== trustForAcquisition(acquisition)) {
    return undefined;
  }
  if (r.outcome !== outcomeForExitCode(r.exitCode as number | undefined)) {
    return undefined;
  }
  const outputRef = r.outputRef as Record<string, unknown> | undefined;
  if (typeof outputRef !== 'object' || outputRef === null || typeof outputRef.tail !== 'string') {
    return undefined;
  }
  if (!isOptionalString(outputRef.offloadId)) {
    return undefined;
  }
  const link = r.link as Record<string, unknown> | undefined;
  if (
    typeof link !== 'object' ||
    link === null ||
    !isOptionalString(link.runId) ||
    !isOptionalString(link.taskId) ||
    !isOptionalInt(link.attempt) ||
    !isOptionalString(link.sessionId) ||
    !isOptionalInt(link.iteration)
  ) {
    return undefined;
  }
  return deepFreeze(value as VerificationRecord);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
