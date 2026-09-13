/* eslint-disable no-console -- 抽出結果を出すのがこのファイルの目的 */
/**
 * eligible pool から本測定の24件を層化ランダム抽出して凍結する（Issue #1046 手順4）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/selectCases.ts \
 *   --pool eval-results/selection-pool-v1.json \
 *   --frame eval-results/sampling-frame-v2.json \
 *   --eligibility eval-results/eligibility-v1.json \
 *   --condition C-repo \
 *   --out eval-results/selected-cases-v1.json
 * ```
 *
 * **抽出の規則は入力より先に決まっている。** 層ごとの必要数・seed・変更規模のバランス制約は
 * `stratifiedSample.ts` の定数で、pool の中身では変わらない。抜いた結果を見てから内訳を
 * 決め直すことはしない。
 *
 * **属性は pool の自己申告を信じない。** `changeSizeStratum` と `tags` は凍結済みの sampling
 * frame と照合し、1つでも食い違えば止める。ここを緩めると、`extreme-tail` の目印を書き換えて
 * バランス制約を通せてしまう。
 *
 * **正例は条件ごとの eligibility を通っていることを要求する。** 判定が無い正例は通ったものと
 * 扱わず止める（判定漏れを分母へ入れると recall が判定漏れの分だけ下がる）。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { writeFrozen } from './frozenFile';
import {
  CHANGE_SIZE_STRATA,
  DIFFICULTY_STRATA,
  EXTREME_TAIL_TAG,
  MIN_EXTREME_TAIL,
  MIN_PER_CHANGE_SIZE_STRATUM,
  SELECTION_SHUFFLE_SEED,
  SELECTION_TARGET_SIZE,
  STRATUM_QUOTAS,
  selectStratifiedSample,
  verifyAgainstFrame,
  verifyPositivesEligible,
  type EligibilityEntry,
  type FramePullRequest,
  type SelectionCandidate,
} from './stratifiedSample';

/** 抽出の版。規則・seed・必要数を変えたら上げ、前の版のファイルは残す。 */
const SELECTION_VERSION = 1;

interface FrameFile {
  prs: FramePullRequest[];
}

interface PoolFile {
  candidates: SelectionCandidate[];
}

interface EligibilityFile {
  entries: EligibilityEntry[];
}

interface Args {
  poolPath: string;
  framePath: string;
  eligibilityPath: string;
  conditionId: string;
  outPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== undefined && token.startsWith('--')) {
      values.set(token.slice(2), argv[i + 1] ?? '');
      i += 1;
    }
  }
  const required = (name: string, what: string): string => {
    const value = values.get(name);
    if (value === undefined || value === '') {
      throw new Error(`--${name}（${what}）は必須です`);
    }
    return value;
  };
  return {
    poolPath: required('pool', '抽出の母集団'),
    framePath: required('frame', '凍結済みの sampling frame'),
    eligibilityPath: required('eligibility', '条件ごとの判定'),
    conditionId: required('condition', 'eligibility を照合する条件'),
    outPath: required('out', '書き出し先'),
  };
}

async function readWithSha(filePath: string): Promise<{ raw: string; sha256: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  return { raw, sha256: createHash('sha256').update(raw).digest('hex') };
}

/** 期待した配列が入っているかだけ確かめる。中身の検証は `stratifiedSample.ts` 側でする。 */
function arrayField<T>(value: unknown, field: string, what: string): T[] {
  const list = (value as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(list)) {
    throw new Error(`${what} に配列の ${field} がありません`);
  }
  return list as T[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = await readWithSha(args.poolPath);
  const frame = await readWithSha(args.framePath);
  const eligibility = await readWithSha(args.eligibilityPath);

  const candidates = arrayField<SelectionCandidate>(
    JSON.parse(pool.raw) as PoolFile,
    'candidates',
    args.poolPath,
  );
  verifyAgainstFrame(
    candidates,
    arrayField<FramePullRequest>(JSON.parse(frame.raw) as FrameFile, 'prs', args.framePath),
  );
  verifyPositivesEligible(
    candidates,
    arrayField<EligibilityEntry>(
      JSON.parse(eligibility.raw) as EligibilityFile,
      'entries',
      args.eligibilityPath,
    ),
    args.conditionId,
  );

  const result = selectStratifiedSample(candidates);

  const output = {
    selectionVersion: SELECTION_VERSION,
    conditionId: args.conditionId,
    /** 入力の正本はハッシュのほう。**絶対パスは入れない**（置き場所で出力が変わらないように）。 */
    poolFile: path.basename(args.poolPath),
    poolSha256: pool.sha256,
    frameFile: path.basename(args.framePath),
    frameSha256: frame.sha256,
    eligibilityFile: path.basename(args.eligibilityPath),
    eligibilitySha256: eligibility.sha256,
    shuffleSeed: SELECTION_SHUFFLE_SEED,
    targetSize: SELECTION_TARGET_SIZE,
    /** 層化の軸は難易度だけ。`kind` と変更規模は層化に使わない。 */
    stratificationAxis: 'difficulty',
    quotas: STRATUM_QUOTAS,
    balanceConstraints: {
      minPerChangeSizeStratum: MIN_PER_CHANGE_SIZE_STRATUM,
      minExtremeTail: MIN_EXTREME_TAIL,
      note: '層化の軸ではなく、選んだ24件が特定のサイズ帯へ寄っていないかの確認。満たすまで引き直すが、規則は変えない',
    },
    poolSize: candidates.length,
    poolByStratum: Object.fromEntries(
      DIFFICULTY_STRATA.map((stratum) => [
        stratum,
        candidates.filter((candidate) => candidate.stratum === stratum).length,
      ]),
    ),
    acceptedAttempt: result.acceptedAttempt,
    /** 落ちた試行も残す。何回引いたかを隠すと「制約を満たすまで回した」が見えなくなる。 */
    attempts: result.attempts,
    byStratum: result.byStratum,
    byChangeSize: result.byChangeSize,
    byKind: result.byKind,
    extremeTail: result.extremeTail,
    selected: result.selected,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);

  console.log('');
  console.log(`母集団: ${candidates.length} 件 → 抽出: ${result.selected.length} 件`);
  console.log('難易度の層:');
  for (const stratum of DIFFICULTY_STRATA) {
    console.log(`  - ${stratum}: ${result.byStratum[stratum]} / 必要 ${STRATUM_QUOTAS[stratum]}`);
  }
  console.log('変更規模（層化ではなくバランス確認）:');
  for (const stratum of CHANGE_SIZE_STRATA) {
    console.log(`  - ${stratum}: ${result.byChangeSize[stratum]} 件`);
  }
  console.log(`  - ${EXTREME_TAIL_TAG}: ${result.extremeTail} 件`);
  console.log('kind（参考。層化の軸ではない）:');
  for (const [kind, count] of Object.entries(result.byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${kind}: ${count} 件`);
  }
  console.log(
    `引き直し: ${result.acceptedAttempt} 回目で採用（試行 ${result.attempts.length} 回）`,
  );
  for (const attempt of result.attempts.filter((entry) => entry.shortfalls.length > 0)) {
    console.log(`  - attempt ${attempt.attempt}: ${attempt.shortfalls.join(' / ')}`);
  }
  console.log('');
  console.log(`選んだ案件: ${result.selected.map((entry) => `#${entry.prNumber}`).join(' ')}`);
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${createHash('sha256').update(json).digest('hex')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
