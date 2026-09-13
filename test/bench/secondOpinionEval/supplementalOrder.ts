/* eslint-disable no-console -- 追加poolの決め方を出すのがこのファイルの目的 */
/**
 * 強い証拠の系統を持たない案件から、追加の探索対象と読む順を凍結する（Issue #1046 手順3）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/supplementalOrder.ts \
 *   --candidates eval-results/evidence-candidates-v3.json \
 *   --strong-order eval-results/screening-order-v2.json \
 *   --out eval-results/supplemental-order-v1.json
 * ```
 *
 * **なぜ足すか。** 強い証拠の98件を20件読んだ時点で、primary が成立したのは2件だった。
 * 残り78件だけで40件そろえるには収率が48%要る。20件時点の実測（10%）とはかけ離れている
 * ので、別の供給源を探す。
 *
 * **読んだ内容から選び方を作らない。** 20件を読んで分かった「別Issueを拾いやすい」等の
 * 失敗の形へ合わせて候補を絞ると、screening の結果で候補の規則を学習したことになる。
 * ここで使うのは手順2で凍結済みの `evidence-candidates-v3.json` の機械的な属性だけで、
 * 中身を読んで入れる・外すは決めない。20件の結果から使ったのは「追加探索を始めるかどうか」
 * の引き金だけである。
 *
 * **tierを付けない。** channel ごとに成立しやすさの見当は付くが、それは主観であり、
 * 強い証拠の98件を先に読んでいる時点で既に「期待の高い順」の優先はしている。この上さらに
 * 順位を付けると説明が立たないので、集合全体を固定seedで並べ替えた順に読む。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { writeFrozen } from './frozenFile';
import { type EvidenceCandidates } from './evidenceChannels';
import {
  SUPPLEMENTAL_CHANNELS,
  SUPPLEMENTAL_SHUFFLE_SEED,
  supplementalOrderOf,
  verifyDisjoint,
} from './screeningPool';

/** 手順2で凍結した証拠候補のsha256。ずれたら止める。 */
const EXPECTED_CANDIDATES_SHA256 =
  '2ece68beb18979f56828548241444a014c6bcd21c0439b42e91ebfd67ce1a235';

/** 先に読んでいる強い証拠の順序ファイルのsha256。重複ゼロの検証に使う。 */
const EXPECTED_STRONG_ORDER_SHA256 =
  'edcdfd12f49cedc1de65e35483e61e023e378c07420557d8a785c7da565e9583';

/** 追加poolの版。規則やseedを変えたら上げ、前の版のファイルは残す。 */
const SUPPLEMENTAL_ORDER_VERSION = 1;

const FIRST_BATCH_CASES = 10;

interface CandidatesFile {
  candidates: EvidenceCandidates[];
}

interface StrongOrderFile {
  order: { prNumber: number }[];
}

interface Args {
  candidatesPath: string;
  strongOrderPath: string;
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
  const candidatesPath = values.get('candidates');
  if (candidatesPath === undefined || candidatesPath === '') {
    throw new Error('--candidates（手順2で凍結した証拠候補）は必須です');
  }
  const strongOrderPath = values.get('strong-order');
  if (strongOrderPath === undefined || strongOrderPath === '') {
    throw new Error('--strong-order（先に読んでいる強い証拠の順序）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  return { candidatesPath, strongOrderPath, outPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawCandidates = await fs.readFile(args.candidatesPath, 'utf8');
  const candidatesSha256 = createHash('sha256').update(rawCandidates).digest('hex');
  if (candidatesSha256 !== EXPECTED_CANDIDATES_SHA256) {
    throw new Error(
      `証拠候補のsha256が想定と一致しません。想定: ${EXPECTED_CANDIDATES_SHA256} / 実測: ${candidatesSha256}。` +
        '候補が変わっています。EXPECTED_CANDIDATES_SHA256 と SUPPLEMENTAL_ORDER_VERSION を上げ、前の版のファイルは残してください',
    );
  }
  const rawStrong = await fs.readFile(args.strongOrderPath, 'utf8');
  const strongSha256 = createHash('sha256').update(rawStrong).digest('hex');
  if (strongSha256 !== EXPECTED_STRONG_ORDER_SHA256) {
    throw new Error(
      `強い証拠の順序のsha256が想定と一致しません。想定: ${EXPECTED_STRONG_ORDER_SHA256} / 実測: ${strongSha256}`,
    );
  }

  const file = JSON.parse(rawCandidates) as CandidatesFile;
  const strong = (JSON.parse(rawStrong) as StrongOrderFile).order;
  const order = supplementalOrderOf(file.candidates);
  verifyDisjoint(order, strong);

  const output = {
    poolId: 'supplemental',
    candidatesFile: path.basename(args.candidatesPath),
    candidatesSha256,
    strongOrderFile: path.basename(args.strongOrderPath),
    strongOrderSha256: strongSha256,
    supplementalOrderVersion: SUPPLEMENTAL_ORDER_VERSION,
    shuffleSeed: SUPPLEMENTAL_SHUFFLE_SEED,
    /** 集合の決め方。手順2の channel だけで決まり、中身は読んでいない。 */
    supplementalRule:
      '手順2の証拠候補のうち、強い証拠（follow-up-test または openedAfterMerge な follow-up issue）を持たず、' +
      `${SUPPLEMENTAL_CHANNELS.join(' / ')} のいずれかの channel を持つ案件。tierは付けず、固定seedの順に読む`,
    /** どこまで読んだら供給源を選び直すか。40件の目標は下げない。 */
    firstBatchCases: FIRST_BATCH_CASES,
    reEvaluationRule:
      `この順の先頭 ${FIRST_BATCH_CASES} 件を読んだ時点で、どちらの供給源を続けるかを決める。` +
      `primary が3件以上ならこのpoolを続け、2件以下なら強い証拠のpoolの前回読み終えた位置の次へ戻って20件足し、再度判断する。` +
      '到達目標の40 primary cases は、どちらの結果でも下げない',
    /** funnelは供給源ごとに分ける。最終のpoolは和集合でよいが、出所は残す。 */
    reportingUnits: {
      poolId: 'この順序ファイルから読んだ分の集計であることを示す',
      screenedCases: '読んだ案件の数',
      primaryCases: 'primary な finding を1つ以上持つ案件の数',
      nonPrimaryCases: '読んだが primary が成立しなかった案件の数',
      unreadCases: 'まだ読んでいない案件の数',
      primaryFindings: '成立した finding の総数（記録のみ）',
    },
    total: order.length,
    order,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);

  console.log(`追加poolの案件: ${order.length} 件（強い証拠の ${strong.length} 件とは重複なし）`);
  console.log(
    `読む順（先頭10件）: ${order
      .slice(0, 10)
      .map((entry) => `#${entry.prNumber}`)
      .join(' ')}`,
  );
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${createHash('sha256').update(json).digest('hex')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
