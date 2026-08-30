/* eslint-disable no-console -- 集計表を出すのがこのファイルの目的 */
/**
 * 採点結果と実行記録を突き合わせ、条件ごとの集計を出す（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/summarize.ts \
 *   --results <結果ディレクトリ> --scores <採点ファイル> --key <対応表>
 * ```
 *
 * 採点ファイル（`scores.json`）は、採点者が `sheet.json` を見ながら書く配列である。形式は
 * {@link Score} を参照。
 *
 * ここでは**有意差の判定をしない**。案件20〜30件・条件2つの規模で統計的な検定を掛けても、
 * 差の有無を言い切れるだけの検出力は無い。出すのは条件ごとの実測値と件数までで、次にどの介入を
 * 実装するかは人がこの表を見て決める。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import type { EvalRunRecord } from './types';

/** 採点者が1回答ごとに付ける値。 */
interface Score {
  scoringId: string;
  /** 指摘の総数。 */
  totalFindings: number;
  /** そのうち、実際に採用できる重要な指摘の数。主指標 actionable precision の分子。 */
  actionableFindings: number;
  /** `knownImportantFindings` のうち、この回答が拾えた数。 */
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

interface Aggregate {
  conditionId: string;
  scored: number;
  totalFindings: number;
  actionableFindings: number;
  recalledImportant: number;
  constraintViolations: number;
  hallucinatedFindings: number;
  unnecessaryInvestigationRequests: number;
  latencyMsTotal: number;
  promptBytesTotal: number;
  /** トークン量が取れた実行の数。取れなかった分を平均へ混ぜないために数える。 */
  usageSamples: number;
  usageTotalTokens: number;
}

function parseArgs(argv: readonly string[]): { resultsDir: string; scores: string; key: string } {
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
  return { resultsDir, scores, key };
}

function emptyAggregate(conditionId: string): Aggregate {
  return {
    conditionId,
    scored: 0,
    totalFindings: 0,
    actionableFindings: 0,
    recalledImportant: 0,
    constraintViolations: 0,
    hallucinatedFindings: 0,
    unnecessaryInvestigationRequests: 0,
    latencyMsTotal: 0,
    promptBytesTotal: 0,
    usageSamples: 0,
    usageTotalTokens: 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scores = JSON.parse(await fs.readFile(args.scores, 'utf8')) as Score[];
  const key = JSON.parse(await fs.readFile(args.key, 'utf8')) as KeyEntry[];

  const byScoringId = new Map(key.map((entry) => [entry.scoringId, entry]));
  const records = new Map<string, EvalRunRecord>();
  for (const name of await fs.readdir(args.resultsDir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const record = JSON.parse(
      await fs.readFile(path.join(args.resultsDir, name), 'utf8'),
    ) as EvalRunRecord;
    records.set(`${record.caseId}__${record.conditionId}__${record.attempt}`, record);
  }

  const aggregates = new Map<string, Aggregate>();
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
    const aggregate = aggregates.get(entry.conditionId) ?? emptyAggregate(entry.conditionId);
    aggregate.scored += 1;
    aggregate.totalFindings += score.totalFindings;
    aggregate.actionableFindings += score.actionableFindings;
    aggregate.recalledImportant += score.recalledImportant;
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
    aggregates.set(entry.conditionId, aggregate);
  }

  if (unmatched > 0) {
    // 突き合わせに失敗した採点を黙って捨てると、集計の母数だけが静かに減る
    console.error(`[summarize] 対応する実行が見つからない採点が ${unmatched} 件ありました`);
  }

  const rows = [...aggregates.values()].sort((a, b) => a.conditionId.localeCompare(b.conditionId));
  for (const row of rows) {
    const ratio = (numerator: number, denominator: number): string =>
      denominator === 0 ? '-' : (numerator / denominator).toFixed(3);
    console.log(`条件 ${row.conditionId}（採点 ${row.scored} 件）`);
    console.log(
      `  actionable precision: ${ratio(row.actionableFindings, row.totalFindings)}` +
        `（${row.actionableFindings}/${row.totalFindings}）`,
    );
    console.log(`  重要問題の拾い上げ:   ${row.recalledImportant} 件`);
    console.log(`  制約・既決事項の誤認: ${row.constraintViolations} 件`);
    console.log(`  存在しない問題の指摘: ${row.hallucinatedFindings} 件`);
    console.log(`  不要な追加調査要求:   ${row.unnecessaryInvestigationRequests} 件`);
    console.log(`  平均latency:          ${ratio(row.latencyMsTotal, row.scored)} ms`);
    console.log(`  平均プロンプト:       ${ratio(row.promptBytesTotal, row.scored)} bytes`);
    console.log(
      `  平均トークン:         ${ratio(row.usageTotalTokens, row.usageSamples)}` +
        `（取得できた実行 ${row.usageSamples}/${row.scored} 件）`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(`[summarize] 失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
