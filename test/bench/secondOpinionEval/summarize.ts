/* eslint-disable no-console -- 集計表を出すのがこのファイルの目的 */
/**
 * 採点結果と実行記録を突き合わせ、条件ごとの集計を出す（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/summarize.ts \
 *   --results <結果ディレクトリ> --scores <採点ファイル> --key <対応表> --cases <案件ファイル> \
 *   [--eligibility <条件ごとの判定>] [--baseline A]
 * ```
 *
 * recall の分母は条件ごとに変わる（Issue #1046）。案件ファイルの正解ラベルへ、条件ごとの
 * `FindingEligibility`（その条件の材料から発見できるか / 入力に答えが書かれていないか）を
 * 掛けて確定する。`--eligibility` を省くと分母は0になる。
 *
 * 採点ファイル（`scores.json`）は、採点者が `sheet.json` と `rubric.json` を見ながら書く配列で
 * ある。形式は {@link Score} を参照。
 *
 * ここでは**有意差の判定をしない**。案件20〜30件の規模で検定を掛けても、差の有無を言い切れる
 * だけの検出力は無い。出すのは実測値と件数、そして案件ごとに対にした差（勝ち負けの数）までで、
 * 次にどの介入を実装するかは人がこの表を見て決める。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import {
  hasIndependentGroundTruth,
  type EvalCase,
  type EvalRunRecord,
  type FindingEligibility,
  type KnownFinding,
} from './types';

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
/** `FindingEligibility` を引くキー。案件id・添字・条件idの組。 */
function eligibilityKey(caseId: string, findingIndex: number, conditionId: string): string {
  return JSON.stringify([caseId, findingIndex, conditionId]);
}

function selectPrimaryFindingIndexes(
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

/** 採点者が1回答ごとに付ける値。 */
interface Score {
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

interface KeyEntry {
  scoringId: string;
  caseId: string;
  conditionId: string;
  attempt: number;
}

/** 1回答ぶんの、案件単位でまとめる前の値。 */
interface Scored {
  caseId: string;
  conditionId: string;
  score: Score;
  record: EvalRunRecord;
  /** その条件で分母に入る正解ラベルの件数と、拾えた件数（severity 別を含む）。 */
  recall: RecallCounts;
}

interface RecallCounts {
  recalled: number;
  total: number;
  recalledCritical: number;
  totalCritical: number;
  recalledWarning: number;
  totalWarning: number;
}

interface Aggregate {
  conditionId: string;
  scored: number;
  /** 実行そのものが失敗した数（採点対象外）。成功率の分子・分母を作るために要る。 */
  attempted: number;
  failed: number;
  totalFindings: number;
  actionableFindings: number;
  verifiedNonActionableFindings: number;
  indeterminateFindings: number;
  recalledImportant: number;
  knownImportantTotal: number;
  recalledCritical: number;
  knownCriticalTotal: number;
  recalledWarning: number;
  knownWarningTotal: number;
  constraintViolations: number;
  hallucinatedFindings: number;
  unnecessaryInvestigationRequests: number;
  /** 依頼の末尾からプロンプト末尾までのバイト数。取れた実行の数と合計。 */
  bytesAfterRequestSamples: number;
  bytesAfterRequestTotal: number;
  /** 条件ごとの判定（`FindingEligibility`）が無く、分母から外したラベルの延べ数。 */
  eligibilityUnjudged: number;
  /** 判定はあるが分母から外したラベルの延べ数（循環・発見不能・答えが入力にある）。 */
  eligibilityExcluded: number;
  latencyMsTotal: number;
  promptBytesTotal: number;
  /** トークン量が取れた実行の数。取れなかった分を平均へ混ぜないために数える。 */
  usageSamples: number;
  usageTotalTokens: number;
}

interface Args {
  resultsDir: string;
  scores: string;
  key: string;
  cases: string;
  eligibility: string | undefined;
  baseline: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === undefined || !k.startsWith('--') || v === undefined) {
      throw new Error(`引数の形が正しくありません: ${argv.join(' ')}`);
    }
    values.set(k.slice(2), v);
  }
  const resultsDir = values.get('results');
  const scores = values.get('scores');
  const key = values.get('key');
  const cases = values.get('cases');
  if (
    resultsDir === undefined ||
    scores === undefined ||
    key === undefined ||
    cases === undefined
  ) {
    throw new Error('--results と --scores と --key と --cases は必須です');
  }
  return {
    resultsDir,
    scores,
    key,
    cases,
    eligibility: values.get('eligibility'),
    baseline: values.get('baseline') ?? 'A',
  };
}

function emptyAggregate(conditionId: string): Aggregate {
  return {
    conditionId,
    scored: 0,
    attempted: 0,
    failed: 0,
    totalFindings: 0,
    actionableFindings: 0,
    verifiedNonActionableFindings: 0,
    indeterminateFindings: 0,
    recalledImportant: 0,
    knownImportantTotal: 0,
    recalledCritical: 0,
    knownCriticalTotal: 0,
    recalledWarning: 0,
    knownWarningTotal: 0,
    constraintViolations: 0,
    hallucinatedFindings: 0,
    unnecessaryInvestigationRequests: 0,
    bytesAfterRequestSamples: 0,
    bytesAfterRequestTotal: 0,
    eligibilityUnjudged: 0,
    eligibilityExcluded: 0,
    latencyMsTotal: 0,
    promptBytesTotal: 0,
    usageSamples: 0,
    usageTotalTokens: 0,
  };
}

function ratio(numerator: number, denominator: number): string {
  return denominator === 0 ? '-' : (numerator / denominator).toFixed(3);
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function format(value: number | undefined): string {
  return value === undefined ? '-' : value.toFixed(3);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scores = JSON.parse(await fs.readFile(args.scores, 'utf8')) as Score[];
  const key = JSON.parse(await fs.readFile(args.key, 'utf8')) as KeyEntry[];
  const cases = JSON.parse(await fs.readFile(args.cases, 'utf8')) as EvalCase[];
  const findingsByCase = new Map(cases.map((c) => [c.id, c.knownImportantFindings]));
  const eligibility = new Map<string, FindingEligibility>();
  if (args.eligibility !== undefined) {
    const entries = JSON.parse(await fs.readFile(args.eligibility, 'utf8')) as FindingEligibility[];
    for (const entry of entries) {
      eligibility.set(eligibilityKey(entry.caseId, entry.findingIndex, entry.conditionId), entry);
    }
  } else {
    // 判定が無いと分母が空になる。黙って recall を `-` にすると、測れていないことに気づけない
    console.error(
      '[summarize] --eligibility が指定されていません。条件ごとの発見可能性の判定が無いため、recall の分母は0になります',
    );
  }

  const byScoringId = new Map(key.map((entry) => [entry.scoringId, entry]));
  const records = new Map<string, EvalRunRecord>();
  for (const name of await fs.readdir(args.resultsDir)) {
    if (!name.endsWith('.json') || name === 'manifest.json') {
      continue;
    }
    const record = JSON.parse(
      await fs.readFile(path.join(args.resultsDir, name), 'utf8'),
    ) as EvalRunRecord;
    records.set(`${record.caseId}__${record.conditionId}__${record.attempt}`, record);
  }

  const aggregates = new Map<string, Aggregate>();
  const take = (conditionId: string): Aggregate => {
    const existing = aggregates.get(conditionId) ?? emptyAggregate(conditionId);
    aggregates.set(conditionId, existing);
    return existing;
  };

  // 実行の成否は採点結果ではなく実行記録から数える。採点シートには成功した回答しか載らないので、
  // 採点だけを見ていると「片方の条件だけ多く落ちていた」ことに気づけない
  for (const record of records.values()) {
    const aggregate = take(record.conditionId);
    aggregate.attempted += 1;
    if (record.error !== undefined || record.response.trim() === '') {
      aggregate.failed += 1;
    }
  }

  const scoredItems: Scored[] = [];
  const brokenScores: string[] = [];
  let outsidePrimary = 0;
  let unmatched = 0;
  for (const score of scores) {
    const entry = byScoringId.get(score.scoringId);
    if (entry === undefined) {
      unmatched += 1;
      continue;
    }
    const record = records.get(`${entry.caseId}__${entry.conditionId}__${entry.attempt}`);
    if (record === undefined) {
      unmatched += 1;
      continue;
    }
    const classified =
      score.actionableFindings +
      score.verifiedNonActionableFindings +
      score.hallucinatedFindings +
      score.indeterminateFindings;
    if (classified !== score.totalFindings) {
      // 4区分の合計が総数と合わない採点は、区分の付け漏れか二重計上である。そのまま
      // 入れると precision の分母が黙ってずれるので、落として場所を告げる
      brokenScores.push(`${score.scoringId}: ${classified} !== ${score.totalFindings}`);
      continue;
    }
    const findings = findingsByCase.get(entry.caseId) ?? [];
    const selected = selectPrimaryFindingIndexes(
      findings,
      eligibility,
      entry.caseId,
      entry.conditionId,
    );
    const primary = new Set(selected.primary);
    const recalledPrimary = score.recalledFindingIndexes.filter((i) => primary.has(i));
    const severityOf = (i: number): KnownFinding['severity'] | undefined => findings[i]?.severity;
    const recall: RecallCounts = {
      recalled: recalledPrimary.length,
      total: primary.size,
      recalledCritical: recalledPrimary.filter((i) => severityOf(i) === 'critical').length,
      totalCritical: selected.primary.filter((i) => severityOf(i) === 'critical').length,
      recalledWarning: recalledPrimary.filter((i) => severityOf(i) === 'warning').length,
      totalWarning: selected.primary.filter((i) => severityOf(i) === 'warning').length,
    };
    const outside = score.recalledFindingIndexes.length - recalledPrimary.length;
    if (outside > 0) {
      // 分母の外のラベルを拾ったこと自体は悪くない。ただし分子へ入れると比が壊れるので落とす
      outsidePrimary += outside;
    }
    scoredItems.push({
      caseId: entry.caseId,
      conditionId: entry.conditionId,
      score,
      record,
      recall,
    });

    const aggregate = take(entry.conditionId);
    aggregate.eligibilityUnjudged += selected.unjudged;
    aggregate.eligibilityExcluded += selected.excluded;
    aggregate.scored += 1;
    aggregate.totalFindings += score.totalFindings;
    aggregate.actionableFindings += score.actionableFindings;
    aggregate.verifiedNonActionableFindings += score.verifiedNonActionableFindings;
    aggregate.indeterminateFindings += score.indeterminateFindings;
    aggregate.recalledImportant += recall.recalled;
    aggregate.knownImportantTotal += recall.total;
    aggregate.recalledCritical += recall.recalledCritical;
    aggregate.knownCriticalTotal += recall.totalCritical;
    aggregate.recalledWarning += recall.recalledWarning;
    aggregate.knownWarningTotal += recall.totalWarning;
    aggregate.constraintViolations += score.constraintViolations;
    aggregate.hallucinatedFindings += score.hallucinatedFindings;
    aggregate.unnecessaryInvestigationRequests += score.unnecessaryInvestigationRequests;
    aggregate.latencyMsTotal += record.latencyMs;
    aggregate.promptBytesTotal += record.promptBytes;
    if (typeof record.bytesAfterRequest === 'number') {
      aggregate.bytesAfterRequestSamples += 1;
      aggregate.bytesAfterRequestTotal += record.bytesAfterRequest;
    }
    const totalTokens = record.sessionTokens;
    if (typeof totalTokens === 'number') {
      aggregate.usageSamples += 1;
      aggregate.usageTotalTokens += totalTokens;
    }
  }

  if (unmatched > 0) {
    // 突き合わせに失敗した採点を黙って捨てると、集計の母数だけが静かに減る
    console.error(`[summarize] 対応する実行が見つからない採点が ${unmatched} 件ありました`);
  }
  if (brokenScores.length > 0) {
    console.error(
      `[summarize] 4区分の合計が totalFindings と合わない採点を ${brokenScores.length} 件除外しました: ` +
        brokenScores.join(', '),
    );
  }

  if (outsidePrimary > 0) {
    // 分母の外のラベルを拾った分。分子へ入れると比が壊れるので落としているが、件数は出す
    console.error(
      `[summarize] 分母に入らない正解ラベルを拾った採点が延べ ${outsidePrimary} 件ありました（分子には数えていません）`,
    );
  }

  printConditionTable(aggregates);
  printPaired(scoredItems, args.baseline);
}

function printConditionTable(aggregates: ReadonlyMap<string, Aggregate>): void {
  const rows = [...aggregates.values()].sort((a, b) => a.conditionId.localeCompare(b.conditionId));
  for (const row of rows) {
    console.log(`条件 ${row.conditionId}（採点 ${row.scored} 件 / 実行 ${row.attempted} 件）`);
    console.log(
      `  実行成功率:           ${ratio(row.attempted - row.failed, row.attempted)}` +
        `（失敗 ${row.failed} 件）`,
    );
    const judged =
      row.actionableFindings + row.verifiedNonActionableFindings + row.hallucinatedFindings;
    console.log(
      `  actionable precision: ${ratio(row.actionableFindings, judged)}` +
        `（${row.actionableFindings}/${judged}、真偽を決められた指摘のみが分母。` +
        `指摘数で重み付いた micro 平均）`,
    );
    console.log(
      `  actionable yield:     ${ratio(row.actionableFindings, row.totalFindings)}` +
        `（${row.actionableFindings}/${row.totalFindings}、留保も分母へ入れた副指標）`,
    );
    console.log(
      `  判定不能の割合:       ${ratio(row.indeterminateFindings, row.totalFindings)}` +
        `（${row.indeterminateFindings}/${row.totalFindings}）`,
    );
    console.log(
      `  重要問題のrecall:     ${ratio(row.recalledImportant, row.knownImportantTotal)}` +
        `（${row.recalledImportant}/${row.knownImportantTotal}）`,
    );
    console.log(
      `    うち critical:      ${ratio(row.recalledCritical, row.knownCriticalTotal)}` +
        `（${row.recalledCritical}/${row.knownCriticalTotal}）`,
    );
    console.log(
      `    うち warning:       ${ratio(row.recalledWarning, row.knownWarningTotal)}` +
        `（${row.recalledWarning}/${row.knownWarningTotal}）`,
    );
    console.log(
      `  分母から外した正解:   ${row.eligibilityExcluded} 件（循環・発見不能・答えが入力にある）` +
        ` / 未判定 ${row.eligibilityUnjudged} 件`,
    );
    console.log(`  1回答あたりの指摘数:  ${ratio(row.totalFindings, row.scored)}`);
    console.log(
      `  存在しない問題の指摘: ${ratio(row.hallucinatedFindings, row.scored)} 件/回答` +
        `（計 ${row.hallucinatedFindings} 件）`,
    );
    console.log(
      `  制約・既決事項の誤認: ${ratio(row.constraintViolations, row.scored)} 件/回答` +
        `（計 ${row.constraintViolations} 件）`,
    );
    console.log(
      `  不要な追加調査要求:   ${ratio(row.unnecessaryInvestigationRequests, row.scored)} 件/回答`,
    );
    console.log(`  平均latency:          ${ratio(row.latencyMsTotal, row.scored)} ms`);
    console.log(`  平均プロンプト:       ${ratio(row.promptBytesTotal, row.scored)} bytes`);
    console.log(
      `  依頼より後ろの量:     ${ratio(row.bytesAfterRequestTotal, row.bytesAfterRequestSamples)} bytes` +
        `（取得できた実行 ${row.bytesAfterRequestSamples}/${row.scored} 件）`,
    );
    console.log(
      `  平均トークン:         ${ratio(row.usageTotalTokens, row.usageSamples)}` +
        `（取得できた実行 ${row.usageSamples}/${row.scored} 件）`,
    );
  }
}

/** 案件・条件ごとの平均。同じ条件を複数回流した分はここで畳む。 */
interface CaseConditionValue {
  precision: number | undefined;
  recall: number | undefined;
}

/**
 * 案件ごとに対にして比べる。
 *
 * 全体を合算した micro 平均は、指摘を多く並べた回答ほど重みが大きい。10件指摘する案件は2件しか
 * 指摘しない案件の5倍効く。条件の比較はもともと同じ案件を両条件へ流す対照実験なので、案件ごとに
 * 差を取り、その分布を見るほうが素直である。
 */
function printPaired(items: readonly Scored[], baselineId: string): void {
  const byCase = new Map<string, Map<string, CaseConditionValue>>();
  const grouped = new Map<string, Scored[]>();
  for (const item of items) {
    const compositeKey = `${item.caseId}\u0000${item.conditionId}`;
    const group = grouped.get(compositeKey) ?? [];
    group.push(item);
    grouped.set(compositeKey, group);
  }
  for (const [compositeKey, group] of grouped) {
    const [caseId = '', conditionId = ''] = compositeKey.split('\u0000');
    const list = group.map((item) => item.score);
    const perCase = byCase.get(caseId) ?? new Map<string, CaseConditionValue>();
    perCase.set(conditionId, {
      precision: mean(
        list
          .map((score) => ({
            actionable: score.actionableFindings,
            judged:
              score.actionableFindings +
              score.verifiedNonActionableFindings +
              score.hallucinatedFindings,
          }))
          // 全指摘が「材料の中では決められない」だった回答は precision を持たない。
          // 0/0 を 0 と数えると、留保しただけで負けたことになる
          .filter((v) => v.judged > 0)
          .map((v) => v.actionable / v.judged),
      ),
      // 分母は条件ごとに違う。案件と条件の組で確定した件数を使い、0件なら recall を出さない
      recall: mean(
        group
          .filter((item) => item.recall.total > 0)
          .map((i) => i.recall.recalled / i.recall.total),
      ),
    });
    byCase.set(caseId, perCase);
  }

  const conditionIds = [...new Set(items.map((item) => item.conditionId))].sort();
  const others = conditionIds.filter((id) => id !== baselineId);
  if (others.length === 0) {
    return;
  }

  console.log('');
  console.log(`案件ごとの対比（基準: ${baselineId}）`);
  for (const conditionId of others) {
    const precisionDeltas: number[] = [];
    const recallDeltas: number[] = [];
    let win = 0;
    let tie = 0;
    let loss = 0;
    for (const perCase of byCase.values()) {
      const base = perCase.get(baselineId);
      const other = perCase.get(conditionId);
      if (base === undefined || other === undefined) {
        // 片方の条件が失敗した案件は対にならない。落として件数を出す（下の「対になった案件」）
        continue;
      }
      if (base.precision !== undefined && other.precision !== undefined) {
        const delta = other.precision - base.precision;
        precisionDeltas.push(delta);
        if (delta > 0) {
          win += 1;
        } else if (delta < 0) {
          loss += 1;
        } else {
          tie += 1;
        }
      }
      if (base.recall !== undefined && other.recall !== undefined) {
        recallDeltas.push(other.recall - base.recall);
      }
    }
    console.log(`  ${conditionId} - ${baselineId}`);
    console.log(`    対になった案件:       ${precisionDeltas.length} 件`);
    console.log(`    precision の平均差:   ${format(mean(precisionDeltas))}`);
    console.log(`    recall の平均差:      ${format(mean(recallDeltas))}`);
    console.log(`    precision 勝敗:       ${win}勝 ${tie}分 ${loss}敗`);
  }
}

main().catch((e: unknown) => {
  console.error(`[summarize] 失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
