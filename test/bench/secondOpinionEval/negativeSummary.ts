/* eslint-disable no-console -- 集計の内訳を出すのがこのファイルの目的 */
/**
 * `no-problem` / `indeterminate` の供給状況を、凍結した pool と判定の記録から導く（Issue #1295）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/negativeSummary.ts \
 *   --order eval-results/negative-order-v1.json \
 *   --decisions eval-results/negative-decisions-v1.jsonl \
 *   --out eval-results/negative-summary-v1.json
 * ```
 *
 * `indeterminate` は読んで確定させる工程が無い（規則が機械的に閉じている）ので、`--decisions`
 * を省ける。その場合は pool の件数と必要数の充足だけを出す。
 *
 * **`screeningSummary.ts` とは別のCLIにしてある。** screening の記録は「primary な finding が
 * 成立したか」を持ち、こちらは「機械的に決まった候補が、読んでも負例のままか」を持つ。
 * 語彙が違うものを1つのCLIへ入れると、`no-relevant-finding` と `no-problem` を同じ表で
 * 並べることになり、この工程を別に作った理由そのものが消える。
 *
 * 出力は凍結しない。読み進めるたびに作り直すファイルである。凍結してあるのは読む順
 * （`negative-order-v1.json` / `indeterminate-order-v1.json`）と、追記しかしない判定の記録
 * （`negative-decisions-v1.jsonl`）である。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { exists } from './frozenFile';
import {
  parseNegativeDecisionsJsonl,
  summarizeNegative,
  validateNegativeLog,
} from './negativeResult';

/**
 * 凍結済みの読む順と、その供給源の名前。
 *
 * **供給源ごとに別々に集計する。** 混ぜると、どの規則でそろえた案件なのかが後から読めない。
 * pool を作り直したら（版を上げたら）ここへ新しいsha256を足し、前の版の行は残す。
 */
const KNOWN_ORDERS: readonly { sha256: string; poolId: string; needsDecisions: boolean }[] = [
  {
    sha256: '04777c56c6a5d0159d414c5a39796059bbdf1a425a44f2cc9ba4e46f3c369f0b',
    poolId: 'negative',
    needsDecisions: true,
  },
  {
    sha256: '01dbbe1cc2f1e8a4c2aa54dfe8bb7dec9964c5a615291055884bf2a29b33fe68',
    poolId: 'indeterminate',
    // 規則が機械的に閉じているので、読んで確定させる工程が無い
    needsDecisions: false,
  },
];

interface OrderFile {
  poolId: string;
  difficultyStratum: string;
  total: number;
  neededWithReserve?: number;
  byChangeSizeStratum?: Record<string, number>;
  order: { prNumber: number; shuffleKey: string }[];
}

interface Args {
  orderPath: string;
  decisionsPath: string | undefined;
  outPath: string;
  /** `KNOWN_ORDERS` へ登録する前の pool を集計する。登録を省く言い訳にはしない。 */
  allowUnregistered: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== undefined && token.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        values.set(token.slice(2), next);
        i += 1;
      } else {
        values.set(token.slice(2), '');
      }
    }
  }
  const orderPath = values.get('order');
  if (orderPath === undefined || orderPath === '') {
    throw new Error('--order（凍結した読む順）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  const decisionsPath = values.get('decisions');
  return {
    orderPath,
    decisionsPath: decisionsPath === '' ? undefined : decisionsPath,
    outPath,
    allowUnregistered: values.has('allow-unregistered'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawOrder = await fs.readFile(args.orderPath, 'utf8');
  const orderSha256 = createHash('sha256').update(rawOrder).digest('hex');
  const known = KNOWN_ORDERS.find((entry) => entry.sha256 === orderSha256);
  if (known === undefined && !args.allowUnregistered) {
    throw new Error(
      `読む順のsha256が凍結済みのどれとも一致しません。実測: ${orderSha256}。` +
        'pool を作ったら KNOWN_ORDERS へ登録してください（登録前に集計するなら --allow-unregistered）',
    );
  }
  const orderFile = JSON.parse(rawOrder) as OrderFile;
  if (known?.needsDecisions === true && args.decisionsPath === undefined) {
    // 読んで確定させる工程がある pool で記録を省くと、pool の件数がそのまま確定数に見える
    throw new Error(
      `${known.poolId} は読んで確定させる工程がある pool です。--decisions を指定してください`,
    );
  }

  const summary =
    args.decisionsPath === undefined
      ? undefined
      : await summarizeFrom(args.decisionsPath, orderFile);

  const needed = orderFile.neededWithReserve;
  // 読んで確定させる工程がある pool では確定数、無い pool では pool の件数を必要数と比べる。
  // 2つの数を別々に持つと、JSON と標準出力で違う判定が出る
  const supplied = summary === undefined ? orderFile.total : summary.summary.confirmedCases;
  const output = {
    poolId: known?.poolId ?? orderFile.poolId,
    registered: known !== undefined,
    difficultyStratum: orderFile.difficultyStratum,
    orderFile: path.basename(args.orderPath),
    orderSha256,
    decisionsFile: args.decisionsPath === undefined ? undefined : path.basename(args.decisionsPath),
    decisionsSha256: summary?.decisionsSha256,
    poolSize: orderFile.total,
    neededWithReserve: needed,
    byChangeSizeStratum: orderFile.byChangeSizeStratum,
    ...(summary?.summary ?? {}),
    /** 必要数と比べた数。読んで確定させる工程が無い pool では pool の件数そのもの。 */
    suppliedCases: supplied,
    meetsNeed: needed === undefined ? undefined : supplied >= needed,
  };
  await fs.writeFile(args.outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`供給源: ${output.poolId}（層: ${orderFile.difficultyStratum}）`);
  console.log(`pool の案件: ${orderFile.total} 件`);
  if (summary === undefined) {
    console.log('判定の記録は指定されていません（読んで確定させる工程が無い pool）');
  } else {
    console.log(`読んだ案件: ${summary.summary.screenedCases} 件`);
    console.log(`  確定した案件: ${summary.summary.confirmedCases} 件（必要数の判定はこれ）`);
    console.log(`  確定しなかった案件: ${summary.summary.rejectedCases} 件`);
    console.log(`未読: ${summary.summary.unreadCases} 件（確定しなかった分ではない）`);
    for (const row of summary.summary.rejectedBreakdown) {
      console.log(`  ${row.disposition}: ${row.count} 件`);
    }
  }
  if (needed !== undefined) {
    console.log(
      supplied >= needed
        ? `必要数（予備込み ${needed} 件）を満たしています`
        : `必要数（予備込み ${needed} 件）まであと ${needed - supplied} 件`,
    );
  }
  console.log(`書き出し: ${args.outPath}`);
}

async function summarizeFrom(decisionsPath: string, orderFile: OrderFile) {
  if (!(await exists(decisionsPath))) {
    // 「まだ1件も読んでいない」を空ファイルで表せるようにする。存在しないパスは打ち間違い
    throw new Error(
      `${decisionsPath} がありません。まだ読んでいないなら空のファイルを置いてください`,
    );
  }
  const rawDecisions = await fs.readFile(decisionsPath, 'utf8');
  const entries = parseNegativeDecisionsJsonl(rawDecisions);
  const problems = validateNegativeLog(entries, orderFile.order);
  if (problems.length > 0) {
    throw new Error(`判定の記録に不整合があります:\n  ${problems.join('\n  ')}`);
  }
  return {
    summary: summarizeNegative(entries, orderFile.total),
    decisionsSha256: createHash('sha256').update(rawDecisions).digest('hex'),
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
