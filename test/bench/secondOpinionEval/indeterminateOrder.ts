/* eslint-disable no-console -- 判断保留poolの決め方を出すのがこのファイルの目的 */
/**
 * `indeterminate`（材料だけでは判断しきれない変更）の候補集合と読む順を凍結する（Issue #1295）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/indeterminateOrder.ts \
 *   --frame eval-results/sampling-frame-v3.json \
 *   --out eval-results/indeterminate-order-v1.json
 * ```
 *
 * **規則は「条件Aの差分予算を超える案件」**である。条件Aの材料は `applyDiffBudget()` で
 * {@link MAX_DIFF_BYTES} に収まるよう削られ、落としたことと落とした対象がプロンプトへ
 * 明記される（`src/secondOpinion/prompt.ts` の `truncated` と省略の行）。落とされた範囲に
 * ついて断定した指摘は、材料の中では真偽を決められないので `indeterminateFindings` へ入る。
 *
 * **条件Aで discoverable でない primary 案件（#330 / #405 / #1031 の型）は充てない。**
 * その型では、Advisor に材料が欠けているという手がかりが一切無く、留保する理由が生じない。
 * 出るのは「指摘しない」であって「留保する」ではないので `indeterminateFindings` を動かさず、
 * この層の役目を果たさない。測りたいのが留保できるかである以上、**材料の欠落がプロンプトに
 * 現れている案件**でなければならない。
 *
 * 生の `git diff` のバイト数は打ち切りの proxy である（実際の bundle は untracked 分も予算を
 * 食う）。pool を凍結したあと、条件Aの bundle を1件ずつ組んで `truncated` が立つことを
 * 確認する。これはモデルを呼ばずに決まるので、結果を覗くことにはならない。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { MAX_DIFF_BYTES } from '../../../src/secondOpinion/snapshot';
import { writeFrozen } from './frozenFile';
import {
  INDETERMINATE_SHUFFLE_SEED,
  NEEDED_WITH_RESERVE,
  type FrameEntry,
  orderByShuffleKey,
  verifySubsetOfEligible,
} from './negativePool';

const run = promisify(execFile);
const REPO_DIR = process.cwd();

/** 手順1で凍結した sampling frame のsha256。ずれたら止める。 */
const EXPECTED_FRAME_SHA256 = '9fb0208257b4b6f79e5128bfcd578b2afa06132874f20fe7faf4ab8a03424854';

/** 判断保留poolの版。規則・seed・予算の値を変えたら上げ、前の版のファイルは残す。 */
const INDETERMINATE_ORDER_VERSION = 1;

interface FrameFile {
  prs: FrameEntry[];
}

interface Args {
  framePath: string;
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
  const framePath = values.get('frame');
  if (framePath === undefined || framePath === '') {
    throw new Error('--frame（手順1で凍結した sampling frame）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  return { framePath, outPath };
}

async function diffBytesOf(baseSha: string, targetSha: string): Promise<number> {
  const { stdout } = await run(
    'git',
    ['-C', REPO_DIR, 'diff', `${baseSha}..${targetSha}`],
    // 文字列へ起こすと UTF-8 のバイト数が分からなくなるので、Buffer のまま長さを測る
    { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
  );
  return stdout.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawFrame = await fs.readFile(args.framePath, 'utf8');
  const frameSha256 = createHash('sha256').update(rawFrame).digest('hex');
  if (frameSha256 !== EXPECTED_FRAME_SHA256) {
    throw new Error(
      `sampling frame のsha256が想定と一致しません。想定: ${EXPECTED_FRAME_SHA256} / 実測: ${frameSha256}。` +
        'EXPECTED_FRAME_SHA256 と INDETERMINATE_ORDER_VERSION を上げ、前の版のファイルは残してください',
    );
  }

  const frame = (JSON.parse(rawFrame) as FrameFile).prs;
  const eligible = frame.filter((entry) => entry.excludedBy === undefined);

  const selected: {
    prNumber: number;
    changeSizeStratum: string | undefined;
    tags: string[];
    diffBytes: number;
    /** 予算をどれだけ超えているか。打ち切りの確からしさを後から読むために残す。 */
    overBudgetBytes: number;
  }[] = [];
  for (const entry of eligible) {
    if (entry.baseSha === undefined || entry.targetSha === undefined) {
      throw new Error(`#${entry.prNumber} に base / target がありません。frame を確かめてください`);
    }
    const diffBytes = await diffBytesOf(entry.baseSha, entry.targetSha);
    if (diffBytes <= MAX_DIFF_BYTES) {
      continue;
    }
    selected.push({
      prNumber: entry.prNumber,
      changeSizeStratum: entry.changeSizeStratum,
      tags: entry.tags,
      diffBytes,
      overBudgetBytes: diffBytes - MAX_DIFF_BYTES,
    });
  }

  const order = orderByShuffleKey(selected, INDETERMINATE_SHUFFLE_SEED);
  verifySubsetOfEligible(order, frame);

  const byStratum: Record<string, number> = {};
  for (const entry of order) {
    const key = entry.changeSizeStratum ?? 'unknown';
    byStratum[key] = (byStratum[key] ?? 0) + 1;
  }

  const output = {
    poolId: 'indeterminate',
    difficultyStratum: 'indeterminate',
    frameFile: path.basename(args.framePath),
    frameSha256,
    indeterminateOrderVersion: INDETERMINATE_ORDER_VERSION,
    shuffleSeed: INDETERMINATE_SHUFFLE_SEED,
    /** 判定に実際に使った予算。production の定数なので、値が変われば pool も変わる。 */
    maxDiffBytes: MAX_DIFF_BYTES,
    indeterminateRule:
      `frame の eligible のうち、git diff <base>..<target> のバイト数が ${MAX_DIFF_BYTES} を超える案件。` +
      '条件Aの材料は applyDiffBudget() でこの予算まで削られ、落としたことがプロンプトへ明記される',
    /** ラベルの扱い。層の定義が先にあるので、案件ごとに付けるかどうかは選ばない。 */
    labelPolicy:
      'knownImportantFindings は常に空にする。recall はこの層では算出しない。' +
      '層の定義が先にあり、案件ごとにラベルを付けるかどうかを選ばないので、後知恵は入らない',
    /** 採らなかった案。理由を残さないと、後から同じ議論をやり直すことになる。 */
    rejectedAlternative:
      '条件Aで discoverable でない primary 案件（#330 / #405 / #1031 の型）は充てない。' +
      'Advisor に材料が欠けているという手がかりが無く、出るのは「指摘しない」であって「留保する」ではないため、' +
      'indeterminateFindings を動かさず層の役目を果たさない',
    /** 凍結のあとに要る確認。モデルは呼ばない。 */
    postFreezeVerification:
      '生の git diff のバイト数は打ち切りの proxy なので、pool を凍結したあと条件Aの bundle を' +
      '1件ずつ組んで truncated が立つことを確認する',
    neededWithReserve: NEEDED_WITH_RESERVE.indeterminate,
    meetsNeed: order.length >= NEEDED_WITH_RESERVE.indeterminate,
    byChangeSizeStratum: byStratum,
    total: order.length,
    order,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);

  console.log(`差分が ${MAX_DIFF_BYTES} byte を超える案件: ${order.length} 件`);
  console.log(`  変更規模の内訳: ${JSON.stringify(byStratum)}`);
  console.log(
    order.length >= NEEDED_WITH_RESERVE.indeterminate
      ? `必要数（予備込み ${NEEDED_WITH_RESERVE.indeterminate} 件）を満たしています`
      : `必要数（予備込み ${NEEDED_WITH_RESERVE.indeterminate} 件）に ${
          NEEDED_WITH_RESERVE.indeterminate - order.length
        } 件足りません`,
  );
  console.log(`読む順: ${order.map((entry) => `#${entry.prNumber}`).join(' ')}`);
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${createHash('sha256').update(json).digest('hex')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
