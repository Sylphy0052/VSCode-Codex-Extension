/* eslint-disable no-console -- 集計表を出すのがこのファイルの目的 */
/**
 * 採点結果と実行記録を突き合わせ、条件ごとの集計を出す（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/summarize.ts \
 *   --results <結果ディレクトリ> --scores <採点ファイル> --key <対応表> [--baseline A]
 * ```
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

import type { EvalRunRecord } from './types';

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
  /** そのうち、実際に採用できる重要な指摘の数。主指標 actionable precision の分子。 */
  actionableFindings: number;
  /** `knownImportantFindings` のうち、この回答が拾えた数。分母は実行記録が持っている。 */
  recalledImportant: number;
  /** 制約・既決事項を誤認していた箇所の数。 */
  constraintViolations: number;
  /** 存在しない問題を指摘していた数。 */
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
}

interface Aggregate {
  conditionId: string;
  scored: number;
  /** 実行そのものが失敗した数（採点対象外）。成功率の分子・分母を作るために要る。 */
  attempted: number;
  failed: number;
  totalFindings: number;
  actionableFindings: number;
  recalledImportant: number;
  knownImportantTotal: number;
  constraintViolations: number;
  hallucinatedFindings: number;
  unnecessaryInvestigationRequests: number;
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
  if (resultsDir === undefined || scores === undefined || key === undefined) {
    throw new Error('--results と --scores と --key は必須です');
  }
  return { resultsDir, scores, key, baseline: values.get('baseline') ?? 'A' };
}

function emptyAggregate(conditionId: string): Aggregate {
  return {
    conditionId,
    scored: 0,
    attempted: 0,
    failed: 0,
    totalFindings: 0,
    actionableFindings: 0,
    recalledImportant: 0,
    knownImportantTotal: 0,
    constraintViolations: 0,
    hallucinatedFindings: 0,
    unnecessaryInvestigationRequests: 0,
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
    scoredItems.push({ caseId: entry.caseId, conditionId: entry.conditionId, score, record });

    const aggregate = take(entry.conditionId);
    aggregate.scored += 1;
    aggregate.totalFindings += score.totalFindings;
    aggregate.actionableFindings += score.actionableFindings;
    aggregate.recalledImportant += score.recalledImportant;
    aggregate.knownImportantTotal += record.knownImportantTotal;
    aggregate.constraintViolations += score.constraintViolations;
    aggregate.hallucinatedFindings += score.hallucinatedFindings;
    aggregate.unnecessaryInvestigationRequests += score.unnecessaryInvestigationRequests;
    aggregate.latencyMsTotal += record.latencyMs;
    aggregate.promptBytesTotal += record.promptBytes;
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
    console.log(
      `  actionable precision: ${ratio(row.actionableFindings, row.totalFindings)}` +
        `（${row.actionableFindings}/${row.totalFindings}、指摘数で重み付いた micro 平均）`,
    );
    console.log(
      `  重要問題のrecall:     ${ratio(row.recalledImportant, row.knownImportantTotal)}` +
        `（${row.recalledImportant}/${row.knownImportantTotal}）`,
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
  const grouped = new Map<string, Score[]>();
  const totals = new Map<string, number>();
  for (const item of items) {
    const compositeKey = `${item.caseId} ${item.conditionId}`;
    const list = grouped.get(compositeKey) ?? [];
    list.push(item.score);
    grouped.set(compositeKey, list);
    totals.set(compositeKey, item.record.knownImportantTotal);
  }
  for (const [compositeKey, list] of grouped) {
    const [caseId = '', conditionId = ''] = compositeKey.split(' ');
    const knownTotal = totals.get(compositeKey) ?? 0;
    const perCase = byCase.get(caseId) ?? new Map<string, CaseConditionValue>();
    perCase.set(conditionId, {
      precision: mean(
        list
          .filter((score) => score.totalFindings > 0)
          .map((score) => score.actionableFindings / score.totalFindings),
      ),
      recall:
        knownTotal === 0 ? undefined : mean(list.map((s) => s.recalledImportant / knownTotal)),
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
