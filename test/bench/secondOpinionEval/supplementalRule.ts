/* eslint-disable no-console -- 追加poolの再評価規則を出すのがこのファイルの目的 */
/**
 * 追加pool（supplemental）を読み始める前に、再評価規則を現行の停止条件へ差し替えて凍結する
 * （Issue #1046 手順3）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/supplementalRule.ts \
 *   --order eval-results/supplemental-order-v2.json \
 *   --strong-summary eval-results/screening-summary-v2.json \
 *   --out eval-results/supplemental-rule-v3.json
 * ```
 *
 * **なぜ順序ファイルを直さず別ファイルにするか。** `supplemental-order-v2.json` が持つ
 * `reEvaluationRule` は版2の停止条件（「到達目標の40 primary」「2件以下なら強い証拠のpoolの
 * 続きを20件足す」）のまま書かれている。停止条件は 2026-08-31 に層の充足性へ変わり、強い証拠
 * のpoolは102件すべて読み終えて未読0になったので、後半は実行できない。
 *
 * ただし順序ファイルは sha256 で凍結してあり（`screeningSummary.ts` の `KNOWN_ORDERS`）、
 * 文言だけを直しても `order` の同一性が確かめられなくなる。**読む順は版2のまま凍結を保ち、
 * 規則の差し替えだけをこのファイルへ追記の形で残す。**
 *
 * **1件も読む前に固定する。** 10件読んでから規則を書くと、読んだ結果へ合わせて続行条件を
 * 選び直せてしまう。このファイルは `writeFrozen()` で書き、後から静かに置き換えられない。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { writeFrozen } from './frozenFile';

/** 差し替え対象の順序ファイルのsha256。ずれたら止める。 */
const EXPECTED_ORDER_SHA256 = '46f119631e658ad6927aca3e48e7cee235d72ee1a6927d9c8227391b36722962';

/** 規則の版。版1・版2は順序ファイルへ埋め込んであり、このファイルが版3にあたる。 */
const SUPPLEMENTAL_RULE_VERSION = 3;

/** 先頭何件で供給源を選び直すか。版2から変えない。 */
const FIRST_BATCH_CASES = 10;

interface OrderFile {
  poolId: string;
  total: number;
  reEvaluationRule: string;
  order: { prNumber: number }[];
}

interface StrongSummaryFile {
  poolId: string;
  screenedCases: number;
  primaryCases: number;
  unreadCases: number;
  decisionsFile: string;
  decisionsSha256: string;
}

interface Args {
  orderPath: string;
  strongSummaryPath: string;
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
    throw new Error('--order（凍結済みの追加poolの読む順）は必須です');
  }
  const strongSummaryPath = values.get('strong-summary');
  if (strongSummaryPath === undefined || strongSummaryPath === '') {
    throw new Error('--strong-summary（強い証拠のpoolの集計）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  return { orderPath, strongSummaryPath, outPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawOrder = await fs.readFile(args.orderPath, 'utf8');
  const orderSha256 = createHash('sha256').update(rawOrder).digest('hex');
  if (orderSha256 !== EXPECTED_ORDER_SHA256) {
    throw new Error(
      `追加poolの順序のsha256が想定と一致しません。想定: ${EXPECTED_ORDER_SHA256} / 実測: ${orderSha256}`,
    );
  }
  const order = JSON.parse(rawOrder) as OrderFile;
  if (order.poolId !== 'supplemental') {
    throw new Error(`--order が追加poolではありません（poolId: ${order.poolId}）`);
  }

  const rawStrongSummary = await fs.readFile(args.strongSummaryPath, 'utf8');
  const strong = JSON.parse(rawStrongSummary) as StrongSummaryFile;
  if (strong.poolId !== 'strong-evidence') {
    throw new Error(`--strong-summary が強い証拠のpoolではありません（poolId: ${strong.poolId}）`);
  }
  if (strong.unreadCases !== 0) {
    throw new Error(
      `強い証拠のpoolに未読が ${strong.unreadCases} 件あります。版2の規則（強い証拠のpoolへ戻って20件足す）が` +
        'まだ実行できるので、この差し替えは要りません',
    );
  }

  const output = {
    ruleId: 'supplemental-reevaluation',
    supplementalRuleVersion: SUPPLEMENTAL_RULE_VERSION,
    poolId: order.poolId,
    orderFile: path.basename(args.orderPath),
    orderSha256,
    orderTotal: order.total,
    firstBatchCases: FIRST_BATCH_CASES,
    /** 差し替える対象。順序ファイル自体は凍結したまま触らない。 */
    supersedes: {
      field: 'reEvaluationRule',
      inFile: path.basename(args.orderPath),
      text: order.reEvaluationRule,
      reason:
        '停止条件が 2026-08-31 に「primary 40件」から層の充足性へ変わり、強い証拠のpoolも102件すべて読み終えて' +
        '未読0になったため、版2の規則は前提（到達目標40件・強い証拠のpoolの続き）を両方とも失っている',
    },
    /** 差し替え時点の強い証拠のpoolの状態。この規則が立つ前提を後から確かめられるように残す。 */
    strongPoolState: {
      summaryFile: path.basename(args.strongSummaryPath),
      screenedCases: strong.screenedCases,
      primaryCases: strong.primaryCases,
      unreadCases: strong.unreadCases,
      decisionsFile: strong.decisionsFile,
      decisionsSha256: strong.decisionsSha256,
    },
    /** この供給源から何が取れて何が取れないか。取れないものを取ろうとしないための線引き。 */
    suppliableStrata: {
      'hard-positive': 'supplied',
      'normal-positive': 'supplied',
      indeterminate: 'supplied-via-insufficient-evidence',
      'no-problem': 'not-suppliable',
    },
    suppliabilityRationale:
      'no-problem の負例は screening の disposition からは作れない。`no-relevant-finding` は「正解ラベルにできる' +
      '欠陥を作れなかった」であって「重要な問題が無い」ではなく、そのまま負例にすると hallucinatedFindings の' +
      '分母が壊れる（docs/second-opinion-eval.md の「問題の無い変更」は正例の余りではない）。負例は別工程で、' +
      '変更の性質が整形・文書・テスト整備に限られるといった根拠を持たせて作る',
    /** 現行の停止条件。層の充足性で見る（予備20%込みの必要数）。 */
    stopCondition: {
      basis: 'stratum-sufficiency',
      note: '案件（PR）単位で数える。primary の総数では止めない',
      requiredWithReserve: {
        'hard-positive': 11,
        'normal-positive': 8,
        'no-problem': 8,
        indeterminate: 4,
      },
      weakConstraint: '変更規模 S / M / L / XL は各3件以上。S と L は正例側だけでは満たせない',
      countedPerAnalysis:
        'prompt-placement は条件A、context-coverage は条件C-repo の eligibility で数える。分析ごとに分母が違う',
    },
    /** 先頭10件を読んだ時点で、どちらの供給源を続けるかを決める規則。 */
    reEvaluationRule:
      `この順の先頭 ${FIRST_BATCH_CASES} 件を読んだ時点で、この供給源を続けるかを決める。` +
      'primary が3件以上なら追加poolを続ける。' +
      'primary が2件以下でも insufficient-evidence が2件以上なら、indeterminate の供給源として追加poolを続ける。' +
      'primary が2件以下かつ insufficient-evidence が1件以下なら、追加poolの screening をいったん止め、' +
      'no-problem と indeterminate を作る別工程（証拠channelを持たない案件から機械的に抜く）の設計へ移る。' +
      '強い証拠のpoolは未読0なので、版2の規則にあった「強い証拠のpoolへ戻って20件足す」は選べない。' +
      'どの結果でも、primary と認める groundTruthBasis の基準は下げない',
    /** 以降の刻み。10件で終わりにせず、同じ判定を繰り返す。 */
    subsequentBatches:
      `先頭 ${FIRST_BATCH_CASES} 件で続けると決めたら、以降も10件ごとに同じ判定をする。` +
      '層の必要数（予備込み）を条件Aと条件C-repo の両方で満たし、変更規模の弱い制約も満たせた時点で止める',
  };

  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);

  console.log(
    `追加poolの再評価規則（版${SUPPLEMENTAL_RULE_VERSION}）: ${args.outPath}（${written}）`,
  );
  console.log(`対象の読む順: ${output.orderFile} sha256 ${orderSha256}（${output.orderTotal} 件）`);
  console.log(
    `強い証拠のpool: 読了 ${strong.screenedCases} 件 / primary ${strong.primaryCases} 件 / 未読 ${strong.unreadCases} 件`,
  );
  console.log(`このファイルのsha256: ${createHash('sha256').update(json).digest('hex')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
