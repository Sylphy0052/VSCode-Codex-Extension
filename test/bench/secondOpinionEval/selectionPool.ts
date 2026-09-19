/* eslint-disable no-console -- 母集団の組み立て結果を出すのがこのファイルの目的 */
/**
 * 抽出の母集団（`selection-pool`）を凍結済みの判定から組み立てる（Issue #1046 手順4）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/selectionPool.ts \
 *   --difficulty eval-results/difficulty-v1.json \
 *   --negative eval-results/negative-order-v1.json \
 *   --negative-decisions eval-results/negative-decisions-v1.jsonl \
 *   --indeterminate eval-results/indeterminate-order-v1.json \
 *   --frame eval-results/sampling-frame-v3.json \
 *   --condition A \
 *   --out eval-results/selection-pool-v1.json \
 *   --out-explore eval-results/explore-only-v1.json
 * ```
 *
 * **4つの層をここで1つの母集団へ束ねるだけで、層の判断はしない。** 正例の難易度は
 * `difficulty-v1.json`、`no-problem` は `negative-order-v1.json`、`indeterminate` は
 * `indeterminate-order-v1.json` が既に凍結している。ここで層を付け替えられるようにすると、
 * 抽出の直前に供給の多い層へ寄せられてしまう。
 *
 * **正例は `--condition` の eligibility を通ったものだけを入れる。** primary benchmark の
 * 分母は条件A（現行bundle）で発見可能かで判定する、と決めてある
 * （`docs/second-opinion-eval.md` の「条件ごとに変わるもの」）。条件Aで証拠が無い案件を
 * 混ぜると、依頼文の位置効果ではなく材料不足を測ることになる。
 *
 * **条件Aでは発見できないが探索すれば発見できる案件は捨てず、別ファイルへ凍結する。**
 * context-coverage 分析の `A-undiscoverable / C-repo-discoverable` がこれで、探索の増分価値
 * そのものを測る材料になる。母集団へ混ぜないだけで、評価の対象からは外さない。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { writeFrozen } from './frozenFile';
import {
  DIFFICULTY_STRATA,
  POSITIVE_STRATA,
  STRATUM_QUOTAS,
  verifyAgainstFrame,
  type ChangeSizeStratum,
  type DifficultyStratum,
  type FramePullRequest,
  type SelectionCandidate,
} from './stratifiedSample';

/** 母集団の版。組み立ての規則か入力の版を変えたら上げ、前の版のファイルは残す。 */
const SELECTION_POOL_VERSION = 1;

/**
 * 全案件に付ける `kind`。
 *
 * 母集団はすべてPRの差分で、依頼文も差分のレビューに揃える。`rootCause` や
 * `designDecision` として振り直せる案件はあるが、それは依頼文の書き方の選択であって
 * 案件そのものの属性ではない。ここで振り分けると、実在しない `kind` の分布を作ることに
 * なる（`docs/second-opinion-eval.md` の「`kind` で層化しない」）。
 */
const UNIFORM_KIND = 'codeReview';

interface DifficultyCase {
  caseId: string;
  prNumber: number;
  stratum: DifficultyStratum;
  changeSizeStratum: ChangeSizeStratum;
  tags: string[];
  eligibleIn: string[];
}

interface DifficultyFile {
  difficultyVersion: number;
  decisionsFile: string;
  decisionsSha256: string;
  eligibilityFile: string;
  eligibilitySha256: string;
  screenedCases: number;
  cases: DifficultyCase[];
}

interface OrderEntry {
  prNumber: number;
  changeSizeStratum: ChangeSizeStratum;
  tags: string[];
}

interface OrderFile {
  poolId: string;
  difficultyStratum: DifficultyStratum;
  frameFile: string;
  frameSha256: string;
  order: OrderEntry[];
}

interface FrameFile {
  prs: FramePullRequest[];
}

/** `negative-decisions-*.jsonl` の1行。`supersede` 行は判定ではないので数えない。 */
interface NegativeDecision {
  type: string;
  prNumber: number;
  confirmed?: boolean;
}

interface Args {
  difficultyPath: string;
  negativePath: string;
  negativeDecisionsPath: string;
  indeterminatePath: string;
  framePath: string;
  conditionId: string;
  outPath: string;
  explorePath: string;
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
    difficultyPath: required('difficulty', '正例の難易度と条件ごとの通過'),
    negativePath: required('negative', '`no-problem` pool の読む順'),
    negativeDecisionsPath: required('negative-decisions', '`no-problem` の確認結果'),
    indeterminatePath: required('indeterminate', '`indeterminate` pool の読む順'),
    framePath: required('frame', '凍結済みの sampling frame'),
    conditionId: required('condition', '正例に要求する eligibility の条件'),
    outPath: required('out', '母集団の書き出し先'),
    explorePath: required('out-explore', '探索でしか届かない正例の書き出し先'),
  };
}

async function readWithSha(filePath: string): Promise<{ raw: string; sha256: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  return { raw, sha256: createHash('sha256').update(raw).digest('hex') };
}

/** 読む順のファイルが、いま渡した frame と同じものを見て作られたかを確かめる。 */
function verifyFrameLineage(order: OrderFile, frameSha256: string, filePath: string): void {
  if (order.frameSha256 !== frameSha256) {
    throw new Error(
      `${filePath} は別の sampling frame から作られています（記録: ${order.frameSha256} / 実測: ${frameSha256}）。` +
        '同じ frame を指すか、pool を作り直してください',
    );
  }
}

/** 確認が済んで `confirmed` になったPRだけ。却下された案件は母集団へ入れない。 */
async function confirmedPrNumbers(filePath: string): Promise<Set<number>> {
  const raw = await fs.readFile(filePath, 'utf8');
  const confirmed = new Set<number>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const row = JSON.parse(line) as NegativeDecision;
    if (row.type === 'decision' && row.confirmed === true) {
      confirmed.add(row.prNumber);
    }
  }
  return confirmed;
}

function candidateOf(entry: OrderEntry, stratum: DifficultyStratum): SelectionCandidate {
  return {
    caseId: `pr-${entry.prNumber}`,
    prNumber: entry.prNumber,
    stratum,
    kind: UNIFORM_KIND,
    changeSizeStratum: entry.changeSizeStratum,
    tags: entry.tags,
  };
}

/** 同じPRが2つの層から入ると、抽出で二重に数えられる。1件でもあれば止める。 */
function verifyNoDuplicates(candidates: readonly SelectionCandidate[]): void {
  const seen = new Map<string, DifficultyStratum>();
  const duplicates: string[] = [];
  for (const candidate of candidates) {
    const previous = seen.get(candidate.caseId);
    if (previous !== undefined) {
      duplicates.push(`${candidate.caseId}（${previous} と ${candidate.stratum}）`);
      continue;
    }
    seen.set(candidate.caseId, candidate.stratum);
  }
  if (duplicates.length > 0) {
    throw new Error(`同じ案件が複数の層に入っています: ${duplicates.join(' / ')}`);
  }
}

/** 層ごとの候補数が必要数に届いているか。届かないまま抽出しても24件にならない。 */
function verifySupply(candidates: readonly SelectionCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const stratum of DIFFICULTY_STRATA) {
    counts[stratum] = candidates.filter((candidate) => candidate.stratum === stratum).length;
  }
  const shortfalls = DIFFICULTY_STRATA.filter(
    (stratum) => (counts[stratum] ?? 0) < STRATUM_QUOTAS[stratum],
  ).map((stratum) => `${stratum}: ${counts[stratum] ?? 0} / 必要 ${STRATUM_QUOTAS[stratum]}`);
  if (shortfalls.length > 0) {
    throw new Error(
      `層ごとの候補数が必要数に届いていません（${shortfalls.join(' / ')}）。` +
        '供給を増やしてから母集団を作り直してください',
    );
  }
  return counts;
}

function countBy<T extends string>(
  candidates: readonly SelectionCandidate[],
  keys: readonly T[],
  pick: (candidate: SelectionCandidate) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) {
    counts[key] = candidates.filter((candidate) => pick(candidate) === key).length;
  }
  return counts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const frame = await readWithSha(args.framePath);
  const difficulty = await readWithSha(args.difficultyPath);
  const negative = await readWithSha(args.negativePath);
  const indeterminate = await readWithSha(args.indeterminatePath);

  const framePrs = (JSON.parse(frame.raw) as FrameFile).prs;
  const difficultyFile = JSON.parse(difficulty.raw) as DifficultyFile;
  const negativeFile = JSON.parse(negative.raw) as OrderFile;
  const indeterminateFile = JSON.parse(indeterminate.raw) as OrderFile;

  verifyFrameLineage(negativeFile, frame.sha256, args.negativePath);
  verifyFrameLineage(indeterminateFile, frame.sha256, args.indeterminatePath);

  const positives = difficultyFile.cases.filter((entry) => POSITIVE_STRATA.has(entry.stratum));
  const eligibleHere = positives.filter((entry) => entry.eligibleIn.includes(args.conditionId));
  const exploreOnly = positives.filter((entry) => !entry.eligibleIn.includes(args.conditionId));

  const confirmed = await confirmedPrNumbers(args.negativeDecisionsPath);
  const negativeEntries = negativeFile.order.filter((entry) => confirmed.has(entry.prNumber));

  const candidates: SelectionCandidate[] = [
    ...eligibleHere.map((entry) => ({
      caseId: entry.caseId,
      prNumber: entry.prNumber,
      stratum: entry.stratum,
      kind: UNIFORM_KIND,
      changeSizeStratum: entry.changeSizeStratum,
      tags: entry.tags,
    })),
    ...negativeEntries.map((entry) => candidateOf(entry, negativeFile.difficultyStratum)),
    ...indeterminateFile.order.map((entry) =>
      candidateOf(entry, indeterminateFile.difficultyStratum),
    ),
  ];

  verifyNoDuplicates(candidates);
  verifyAgainstFrame(candidates, framePrs);
  const byStratum = verifySupply(candidates);

  const output = {
    selectionPoolVersion: SELECTION_POOL_VERSION,
    /** 正例に要求した eligibility の条件。`selectCases.ts` へ同じ値を渡す。 */
    conditionId: args.conditionId,
    /** 入力の正本はハッシュのほう。**絶対パスは入れない**（置き場所で出力が変わらないように）。 */
    difficultyFile: path.basename(args.difficultyPath),
    difficultySha256: difficulty.sha256,
    negativeFile: path.basename(args.negativePath),
    negativeSha256: negative.sha256,
    negativeDecisionsFile: path.basename(args.negativeDecisionsPath),
    indeterminateFile: path.basename(args.indeterminatePath),
    indeterminateSha256: indeterminate.sha256,
    frameFile: path.basename(args.framePath),
    frameSha256: frame.sha256,
    /** 難易度の判断がどの screening の読了時点に基づくか。 */
    decisionsFile: difficultyFile.decisionsFile,
    decisionsSha256: difficultyFile.decisionsSha256,
    eligibilityFile: difficultyFile.eligibilityFile,
    eligibilitySha256: difficultyFile.eligibilitySha256,
    screenedCases: difficultyFile.screenedCases,
    kindRule:
      `全案件に ${UNIFORM_KIND} を付ける。母集団はすべてPRの差分で、依頼文も差分のレビューに揃えるため。` +
      'kind は層化の軸ではなく、結果に内訳を出すための属性として持つ',
    poolRule:
      '正例は difficulty ファイルの eligibleIn が conditionId を含むものだけ。no-problem は確認が済んだ案件だけ。' +
      'indeterminate は pool 全件。層の判断はここではせず、凍結済みの判定をそのまま使う',
    quotas: STRATUM_QUOTAS,
    byStratum,
    byChangeSizeStratum: countBy(
      candidates,
      ['S', 'M', 'L', 'XL'],
      (candidate) => candidate.changeSizeStratum,
    ),
    total: candidates.length,
    candidates,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);

  const exploreOutput = {
    selectionPoolVersion: SELECTION_POOL_VERSION,
    /** 母集団から外した条件。この条件で発見できない正例がここへ来る。 */
    excludedFromConditionId: args.conditionId,
    difficultyFile: path.basename(args.difficultyPath),
    difficultySha256: difficulty.sha256,
    purpose:
      'context-coverage 分析の A-undiscoverable / C-repo-discoverable。' +
      '条件Aの材料では発見できないが、探索すれば発見できる正例で、探索の増分価値そのものを測る',
    note: '母集団へ混ぜないだけで評価の対象からは外さない。ラベルは共通なので再ラベルは要らない',
    total: exploreOnly.length,
    cases: exploreOnly.map((entry) => ({
      caseId: entry.caseId,
      prNumber: entry.prNumber,
      stratum: entry.stratum,
      kind: UNIFORM_KIND,
      changeSizeStratum: entry.changeSizeStratum,
      tags: entry.tags,
      eligibleIn: entry.eligibleIn,
    })),
  };
  const exploreJson = `${JSON.stringify(exploreOutput, null, 2)}\n`;
  const exploreWritten = await writeFrozen(args.explorePath, exploreJson);

  console.log(
    `母集団: ${candidates.length} 件（条件 ${args.conditionId} の eligibility で絞った）`,
  );
  for (const stratum of DIFFICULTY_STRATA) {
    console.log(`  - ${stratum}: ${byStratum[stratum] ?? 0} / 必要 ${STRATUM_QUOTAS[stratum]}`);
  }
  console.log(`  変更規模の内訳: ${JSON.stringify(output.byChangeSizeStratum)}`);
  console.log(
    `条件 ${args.conditionId} で発見できない正例: ${exploreOnly.length} 件` +
      (exploreOnly.length > 0
        ? `（${exploreOnly.map((entry) => `#${entry.prNumber}`).join(' ')}）`
        : ''),
  );
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${createHash('sha256').update(json).digest('hex')}`);
  console.log(
    `書き出し: ${args.explorePath}${exploreWritten === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${createHash('sha256').update(exploreJson).digest('hex')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
