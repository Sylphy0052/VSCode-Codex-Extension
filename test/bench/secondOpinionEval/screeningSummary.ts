/* eslint-disable no-console -- 集計の内訳を出すのがこのファイルの目的 */
/**
 * screening の記録から集計を導く（Issue #1046 手順3）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/screeningSummary.ts \
 *   --order eval-results/screening-order-v2.json \
 *   --decisions eval-results/screening-decisions-v1.jsonl \
 *   --out eval-results/screening-summary-v1.json
 * ```
 *
 * **集計を手で書かない。** 読んだ件数・成立・不成立・未読は、判定の記録から機械的に出す。
 * 手で数えると、途中で止めたときに未読が不成立へ紛れ込む。
 *
 * 出力は凍結しない。screening が進むたびに作り直すファイルなので、`writeFrozen` は使わない。
 * 凍結してあるのは読む順（`screening-order-v2.json`）と、追記しかしない判定の記録
 * （`screening-decisions-v1.jsonl`）である。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { parseDecisionsJsonl, summarizeScreening, validateScreeningLog } from './screeningResult';

/** 手順3の前段で凍結した読む順のsha256。ずれたら止める。 */
const EXPECTED_ORDER_SHA256 = 'edcdfd12f49cedc1de65e35483e61e023e378c07420557d8a785c7da565e9583';

interface OrderFile {
  total: number;
  primaryTargetCases: number;
  order: { prNumber: number; shuffleKey: string }[];
}

interface Args {
  orderPath: string;
  decisionsPath: string;
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
  const orderPath = values.get('order');
  if (orderPath === undefined || orderPath === '') {
    throw new Error('--order（凍結した読む順）は必須です');
  }
  const decisionsPath = values.get('decisions');
  if (decisionsPath === undefined || decisionsPath === '') {
    throw new Error('--decisions（判定の記録のJSONL）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  return { orderPath, decisionsPath, outPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawOrder = await fs.readFile(args.orderPath, 'utf8');
  const orderSha256 = createHash('sha256').update(rawOrder).digest('hex');
  if (orderSha256 !== EXPECTED_ORDER_SHA256) {
    throw new Error(
      `読む順のsha256が想定と一致しません。想定: ${EXPECTED_ORDER_SHA256} / 実測: ${orderSha256}。` +
        '順序が変わっています。凍結済みの版を指定してください',
    );
  }
  const orderFile = JSON.parse(rawOrder) as OrderFile;

  const rawDecisions = await fs.readFile(args.decisionsPath, 'utf8');
  const entries = parseDecisionsJsonl(rawDecisions);
  const problems = validateScreeningLog(entries, orderFile.order);
  if (problems.length > 0) {
    throw new Error(`判定の記録に不整合があります:\n  ${problems.join('\n  ')}`);
  }

  const summary = summarizeScreening(entries, orderFile.total);
  const output = {
    orderFile: path.basename(args.orderPath),
    orderSha256,
    decisionsFile: path.basename(args.decisionsPath),
    decisionsSha256: createHash('sha256').update(rawDecisions).digest('hex'),
    primaryTargetCases: orderFile.primaryTargetCases,
    reachedTarget: summary.primaryCases >= orderFile.primaryTargetCases,
    ...summary,
  };
  await fs.writeFile(args.outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`読んだ案件: ${summary.screenedCases} 件 / 全 ${orderFile.total} 件`);
  console.log(`  primary が成立した案件: ${summary.primaryCases} 件（停止判定はこれ）`);
  console.log(`  成立しなかった案件: ${summary.nonPrimaryCases} 件`);
  console.log(`未読: ${summary.unreadCases} 件（不成立ではない）`);
  console.log(`成立した finding: ${summary.primaryFindings} 件（記録のみ）`);
  for (const row of summary.nonPrimaryBreakdown) {
    console.log(`  ${row.disposition}: ${row.count} 件`);
  }
  console.log(
    output.reachedTarget
      ? `停止条件に到達（primary ${summary.primaryCases} 件 >= ${orderFile.primaryTargetCases} 件）`
      : `停止条件まであと ${orderFile.primaryTargetCases - summary.primaryCases} 件`,
  );
  console.log(`書き出し: ${args.outPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
