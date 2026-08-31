/**
 * recall の分母をどう決めるかの中身（Issue #1046）。
 *
 * `summarize.ts` から切り出してある。あちらは import しただけで `main()` が走るので、テストから
 * 読めない。**分母を決める規則は測定結果を直接動かすので、テストで固定できる場所へ置く。**
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  hasIndependentGroundTruth,
  type EvalRunManifest,
  type FindingEligibility,
  type KnownFinding,
} from './types';

/** 採点者が1回答ごとに付ける値。 */
export interface Score {
  scoringId: string;
  /**
   * 指摘の総数。
   *
   * 同じ根本原因・同じ修正を指す記述は、箇条書きが何行に分かれていても1件と数える
   * （`docs/second-opinion-eval.md` の採点規約）。分割の仕方で分母が動くと、精度の比較が
   * 書き方の比較になってしまう。
   */
  totalFindings: number;
  /** そのうち、材料の中で真と確かめられ、実際に採用できる指摘の数。precision の分子。 */
  actionableFindings: number;
  /** 材料の中で確かめた結果、採用に値しないと判断した指摘の数（真だが影響が無い、など）。 */
  verifiedNonActionableFindings: number;
  /**
   * 材料の中では真偽を決められない指摘の数。
   *
   * **precision の分母へ入れない。** 入れると「材料に無いので確認できない」と正しく留保した
   * 回答が、存在しない問題を指摘した回答と同じように減点される。それは「不確かなことは黙る」
   * のが得だという採点になり、測りたいものと逆を測る。
   *
   * 代わりに {@link Aggregate.indeterminateFindings} を別の指標として出す。留保ばかり並べる
   * 回答はそちらで悪化し、黙る回答は recall と指摘数で悪化するので、逃げ道は残らない。
   */
  indeterminateFindings: number;
  /**
   * この回答が拾えた正解ラベルの**添字**（`knownImportantFindings` の位置）。
   *
   * 件数ではなく添字で受けるのは、**recall の分母が条件ごとに変わる**からである（Issue #1046）。
   * 採点者には案件の全ラベルを見せる（条件ごとに見せるラベルを変えると、採点シートから条件が
   * 割れる）。どのラベルを分母へ入れるかは条件ごとに違うので、絞り込みは集計側で掛ける。
   * 件数だけ受け取ると、分子が全ラベル基準・分母が条件基準というちぐはぐな比になる。
   */
  recalledFindingIndexes: number[];
  /** 制約・既決事項を誤認していた箇所の数。 */
  constraintViolations: number;
  /** 材料と矛盾する、存在しない問題を指摘していた数。 */
  hallucinatedFindings: number;
  /** 「まず調べてほしい」で終わり、判断材料になっていない要求の数。 */
  unnecessaryInvestigationRequests: number;
}

/** `FindingEligibility` を引くキー。案件id・添字・条件idの組。 */
export function eligibilityKey(caseId: string, findingIndex: number, conditionId: string): string {
  return JSON.stringify([caseId, findingIndex, conditionId]);
}

/**
 * ある条件で recall の分母へ入れる正解ラベルの添字を返す（Issue #1046）。
 *
 * 3つを掛ける。
 *
 * 1. 根拠が測定対象のモデルから独立しているか（条件に依らない）
 * 2. その条件の材料から発見できるか
 * 3. その条件の入力に答えが書かれていないか
 *
 * 2と3は条件ごとに変わるのでラベルには持たせず、`FindingEligibility` として別に持つ。判定が
 * 無いラベルは**分母へ入れない**。入れると「判定していないだけ」のラベルで recall が下がる。
 * 外した件数は集計へ出す。黙って分母から消すと、外れた件数が分からないまま recall だけが動く。
 */
export function selectPrimaryFindingIndexes(
  findings: readonly KnownFinding[],
  eligibility: ReadonlyMap<string, FindingEligibility>,
  caseId: string,
  conditionId: string,
): { primary: number[]; unjudged: number; excluded: number } {
  const primary: number[] = [];
  let unjudged = 0;
  let excluded = 0;
  for (const [index, finding] of findings.entries()) {
    if (!hasIndependentGroundTruth(finding)) {
      excluded += 1;
      continue;
    }
    const judged = eligibility.get(eligibilityKey(caseId, index, conditionId));
    if (judged === undefined) {
      unjudged += 1;
      continue;
    }
    if (!judged.discoverable || judged.explicitlyExposed) {
      excluded += 1;
      continue;
    }
    primary.push(index);
  }
  return { primary, unjudged, excluded };
}

/**
 * 採点1件の形を確かめる（Issue #1046）。
 *
 * JSON を型でcastしているだけなので、値の正しさは何も保証されていない。とくに
 * `recalledFindingIndexes` は**重複していても長さで数えてしまう**（`[0, 0]` で2件拾ったことに
 * なる）。範囲外の添字も、存在しない正解ラベルを拾ったことにできる。分子を直接動かせる場所
 * なので、集計の前に弾く。
 */
export function validateScore(score: Score, findingCount: number): string | undefined {
  const counts: [string, number][] = [
    ['totalFindings', score.totalFindings],
    ['actionableFindings', score.actionableFindings],
    ['verifiedNonActionableFindings', score.verifiedNonActionableFindings],
    ['indeterminateFindings', score.indeterminateFindings],
    ['hallucinatedFindings', score.hallucinatedFindings],
    ['constraintViolations', score.constraintViolations],
    ['unnecessaryInvestigationRequests', score.unnecessaryInvestigationRequests],
  ];
  for (const [name, value] of counts) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return `${name} が0以上の整数ではありません: ${String(value)}`;
    }
  }
  const indexes = score.recalledFindingIndexes;
  if (!Array.isArray(indexes)) {
    return 'recalledFindingIndexes が配列ではありません';
  }
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= findingCount) {
      return `recalledFindingIndexes に範囲外の添字があります: ${String(index)}（正解ラベルは${findingCount}件）`;
    }
  }
  if (new Set(indexes).size !== indexes.length) {
    return `recalledFindingIndexes に重複があります: ${JSON.stringify(indexes)}`;
  }
  return undefined;
}

/**
 * 案件ファイルと判定ファイルが、実行時のものと同一であることを確かめる（Issue #1046）。
 *
 * ここを見ないと、**回答を読んでから分母を書き換えられる**。`discoverable` を1つ落とすだけで
 * recall の分母が減り、ラベルは1文字も変わらないので差分にも出ない。実験の前に凍結したという
 * 前提が、集計の側から静かに破れる。
 *
 * 一致しなければ集計を止める。警告にして続けると、**歪んだ数値が出てしまってから気づく**こと
 * になり、そのときには何を基準に採点したのかがもう分からない。
 */
export async function verifyFrozenInputs(
  resultsDir: string,
  casesPath: string,
  eligibilityPath: string,
): Promise<void> {
  const manifestPath = path.join(resultsDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as EvalRunManifest;

  const casesSha = await sha256OfFile(casesPath);
  if (casesSha !== manifest.casesSha256) {
    throw new Error(
      `案件ファイルが実行時から変わっています（${manifestPath} の casesSha256 と不一致）。実行時: ${manifest.casesSha256} / 今: ${casesSha}`,
    );
  }

  if (manifest.eligibilitySha256 === undefined) {
    throw new Error(
      `この run は --eligibility 無しで実行されています（${manifestPath}）。recall の分母を後から決められる状態なので集計しません`,
    );
  }
  const eligibilitySha = await sha256OfFile(eligibilityPath);
  if (eligibilitySha !== manifest.eligibilitySha256) {
    throw new Error(
      `判定ファイルが実行時から変わっています（${manifestPath} の eligibilitySha256 と不一致）。実行時: ${manifest.eligibilitySha256} / 今: ${eligibilitySha}`,
    );
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath, 'utf8'))
    .digest('hex');
}
