import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { OptimizeDirection } from './optimizeSpec';
import { stripControlCharsPreservingNewlines } from './sanitize';
import { isValidTaskId } from './taskRunState';

/**
 * 最適化ハーネス（Issue #2106）の台帳。1試行を1行のJSONで、拡張のglobalStorageの
 * `optimize/<runId>/<taskId>.jsonl`へ追記する。書くのは拡張だけで、試行のセッションの
 * 書き込みが届かない場所（worktreeの外）に置く。
 *
 * `TaskRun`には要約（`OptimizeSummary`）だけを持たせ、状態の保存を重くしない。
 * LLMが書いた欄は`OptimizeLlmText`にまとめて区別し、1欄あたりの文字数を`LLM_TEXT_MAX_LENGTH`で切り詰める。
 */

/** `<globalStorage>`の下の置き場の名前。 */
export const OPTIMIZE_LEDGER_DIR_NAME = 'optimize';

/** LLMが書いた欄の1つあたりの上限（文字数）。 */
export const LLM_TEXT_MAX_LENGTH = 1000;

/** 試行への指示（#2107）へ入れる要約の件数。直近のこの件数だけにする。 */
export const RECENT_TRIALS_IN_PROMPT = 5;

/** 理由・詳細など、拡張が書く文章の上限。 */
const NOTE_MAX_LENGTH = 2000;

/** LLMが書いたデータ。仮説・予測・方式・変更の要約。外部由来のテキストとして扱う。 */
export interface OptimizeLlmText {
  hypothesis: string;
  prediction: string;
  approach: string;
  changeSummary: string;
}

/** 1つの指標の計測結果。 */
export interface OptimizeMeasurement {
  /** 計測した回数。 */
  samples: number;
  median: number;
  /** ばらつき（標準偏差）。 */
  spread: number;
  /** 基準値に対する有意判定。比べる相手が無い（基準値の計測）ときは省く。 */
  significant?: boolean;
}

export interface OptimizeSecondaryResult extends OptimizeMeasurement {
  name: string;
  /** 許容幅に収まっているか。 */
  withinTolerance: boolean;
}

/** 計測中の負荷。ばらつきの原因を後から読むため。 */
export interface OptimizeLoad {
  /** 1分間の平均負荷（loadavg）。 */
  loadAverage1m: number;
  /** 空きメモリ（MB）。 */
  freeMemoryMb: number;
}

export type OptimizeDecisionOutcome = 'adopted' | 'rejected' | 'invalid';

export interface OptimizeRefutation {
  verdict: 'holds' | 'refuted' | 'inconclusive';
  detail: string;
}

export interface OptimizeTrialRecord {
  /** 1から始まる試行の番号。 */
  trial: number;
  /** ISO8601。 */
  at: string;
  llm: OptimizeLlmText;
  correctness: { passed: boolean; detail: string };
  metric: OptimizeMeasurement;
  secondary: OptimizeSecondaryResult[];
  load: OptimizeLoad;
  decision: { outcome: OptimizeDecisionOutcome; reason: string };
  refutation?: OptimizeRefutation;
  /** 木を固定したcommitのhash。 */
  commit?: string;
}

/** `TaskRun`の側に持たせる要約。 */
export interface OptimizeSummary {
  trials: number;
  /** 基準値（指標の中央値）。まだ測っていなければ省く。 */
  baseline?: number;
  /** 最良値（採用した試行の指標の中央値）。 */
  best?: number;
  /** 最良の試行の木を固定したcommit。 */
  bestCommit?: string;
}

function clip(text: string, max: number): string {
  const cleaned = stripControlCharsPreservingNewlines(text);
  const chars = Array.from(cleaned);
  // 親文字列を掴まないよう、切り詰めた結果は配列から組み直した新しい文字列にする
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/** LLMが書いた欄を、1欄ごとに上限へ切り詰める。 */
export function clipLlmText(text: OptimizeLlmText): OptimizeLlmText {
  return {
    hypothesis: clip(text.hypothesis, LLM_TEXT_MAX_LENGTH),
    prediction: clip(text.prediction, LLM_TEXT_MAX_LENGTH),
    approach: clip(text.approach, LLM_TEXT_MAX_LENGTH),
    changeSummary: clip(text.changeSummary, LLM_TEXT_MAX_LENGTH),
  };
}

/** 台帳へ書く前に、LLMが書いた欄と拡張が書く文章を切り詰める。 */
export function normalizeTrialRecord(record: OptimizeTrialRecord): OptimizeTrialRecord {
  return {
    ...record,
    llm: clipLlmText(record.llm),
    correctness: {
      ...record.correctness,
      detail: clip(record.correctness.detail, NOTE_MAX_LENGTH),
    },
    decision: { ...record.decision, reason: clip(record.decision.reason, NOTE_MAX_LENGTH) },
    ...(record.refutation === undefined
      ? {}
      : {
          refutation: {
            ...record.refutation,
            detail: clip(record.refutation.detail, NOTE_MAX_LENGTH),
          },
        }),
  };
}

/** 台帳から要約を作る。最良は、採用した試行のうち指標が最も良いもの。 */
export function summarizeTrials(
  records: readonly OptimizeTrialRecord[],
  direction: OptimizeDirection,
  baseline: number | undefined,
): OptimizeSummary {
  let best: OptimizeTrialRecord | undefined;
  for (const record of records) {
    if (record.decision.outcome !== 'adopted') {
      continue;
    }
    if (
      best === undefined ||
      (direction === 'minimize'
        ? record.metric.median < best.metric.median
        : record.metric.median > best.metric.median)
    ) {
      best = record;
    }
  }
  return {
    trials: records.length,
    ...(baseline === undefined ? {} : { baseline }),
    ...(best === undefined ? {} : { best: best.metric.median }),
    ...(best?.commit === undefined ? {} : { bestCommit: best.commit }),
  };
}

/** 試行への指示へ入れる、直近の試行の要約。LLMが書いた欄は呼び出し側が外部由来として囲む。 */
export function recentTrials(
  records: readonly OptimizeTrialRecord[],
  count: number = RECENT_TRIALS_IN_PROMPT,
): OptimizeTrialRecord[] {
  return count <= 0 ? [] : records.slice(-count);
}

const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 台帳のファイルの場所。runIdとtaskIdが不正ならパスを作らず例外にする（パスの横断を防ぐ）。 */
export function ledgerFilePath(baseDir: string, runId: string, taskId: string): string {
  if (!SAFE_RUN_ID.test(runId) || !isValidTaskId(taskId)) {
    throw new Error(`台帳のIDが不正: ${runId}/${taskId}`);
  }
  return path.join(baseDir, OPTIMIZE_LEDGER_DIR_NAME, runId, `${taskId}.jsonl`);
}

/**
 * 台帳のファイルの読み書き。`baseDir`には`ExtensionContext.globalStorageUri`配下を渡す。
 * 追記は1試行1行。読むときは壊れた行を飛ばす。
 */
export class OptimizeLedgerStore {
  constructor(private readonly baseDir: string) {}

  async append(runId: string, taskId: string, record: OptimizeTrialRecord): Promise<void> {
    const file = ledgerFilePath(this.baseDir, runId, taskId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // JSON.stringifyは改行を\nへ逃がすので、1レコードは必ず1行になる
    await fs.appendFile(file, `${JSON.stringify(normalizeTrialRecord(record))}\n`, 'utf8');
  }

  async read(runId: string, taskId: string): Promise<OptimizeTrialRecord[]> {
    const file = ledgerFilePath(this.baseDir, runId, taskId);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw e;
    }
    const records: OptimizeTrialRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        records.push(JSON.parse(line) as OptimizeTrialRecord);
      } catch {
        // 書き込み途中で切れた行は飛ばす
      }
    }
    return records;
  }
}
