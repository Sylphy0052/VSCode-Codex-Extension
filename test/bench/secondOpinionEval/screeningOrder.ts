/* eslint-disable no-console -- 読む順を決める過程を出すのがこのファイルの目的 */
/**
 * 証拠を読む順を、読み始める前に固定する（Issue #1046 手順3の前段）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/screeningOrder.ts \
 *   --candidates eval-results/evidence-candidates-v4.json \
 *   --out eval-results/screening-order-v3.json
 * ```
 *
 * **PR番号順では読まない。** 番号順は結果とは独立だが、ほぼ時間順でもある。この期間中に
 * Issueの運用・テストを足す割合・AIの使い方・PRの種類が変わっていれば、先頭から40件で
 * 止めたときに特定の時期だけを読んだことになる。固定のseedで並べ替えて、その順を凍結する。
 *
 * 並べ替えは `sha256(STRONG_SHUFFLE_SEED + prNumber)` の昇順で行う。乱数生成器を持たないので、
 * 実装も監査も同じ1行で済み、誰が何度実行しても同じ順になる。
 *
 * **停止条件は結果依存で、単位は案件（PR）である。** primary な `groundTruthBasis` の
 * finding を1つ以上持つPRを1件と数える。**同じPRで複数の finding が成立しても、停止の
 * カウントは1である。** finding の総数で数えると、少数のPRに集中したときに早く止まりすぎる。
 * 最終の抽出は案件単位なので、こちらへ揃える。止める判断そのものは primary の総数ではなく、
 * 最終24件を組めるか（層の充足性）で行う。{@link STOP_RULE} を参照。
 *
 * これは「強い証拠を持つ案件のうち何件が成立したか」という母集団の割合を出す手続きでは
 * ない。作りたいのは
 * 本測定に使えるpoolであって、成立率の推定ではない。したがって集計では、読んだ件数・成立
 * した件数・成立しなかった件数・**読んでいない件数**を分けて出し、未読を不成立に混ぜない。
 *
 * 後の工程で抽出の制約を満たせなかったときは、**この凍結した順序の、前回読み終えた位置の
 * 次から**読み足す。読む順を後から選び直さないので、どこまで読んだかが変わっても選択の
 * 恣意性は入らない。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { writeFrozen } from './frozenFile';
import { type EvidenceCandidates } from './evidenceChannels';
import { STRONG_SHUFFLE_SEED, screeningOrderOf } from './screeningPool';

/**
 * 手順2で凍結した証拠候補のsha256。
 *
 * 候補が変われば読む順も別物になる。ずれたら止める。
 */
const EXPECTED_CANDIDATES_SHA256 =
  '6ce8c84c6f2e08667ab71f32f7ad97ac3af137af0ee14dbd02f3b0a95fb05e98';

/**
 * 読む順の版。規則やseedを変えたら上げ、前の版のファイルは残す。
 *
 * v3 で規則もseedも変えていない。証拠候補が v3（frame v2 由来）から v4（frame v3 由来）へ
 * 変わり、強い証拠を持つ案件が 98件 → 102件 になったので上げた。
 */
const SCREENING_ORDER_VERSION = 3;

/**
 * primary な finding を1つ以上持つ**案件（PR）**の、暫定の停止点。finding の総数ではない。
 *
 * 2026-08-31 に 40件から 18件へ下げた。40件は必要量ではなく余裕値の見積もり違いで、最終24件に
 * 要る正例は15件（うち難しい正例が9件）である。18件はそこへ20%の予備を乗せた数に当たる。
 *
 * **これは目安であって、停止の判定そのものではない。** 実際の停止は {@link STOP_RULE} の
 * とおり層の充足性で決める。18件に届く前でも各層の供給が十分と分かれば止めてよく、逆に18件
 * あっても層が偏っていれば続ける。下げたのは必要量の見積もりだけで、primary と認める
 * `groundTruthBasis` の基準は変えていない。
 */
const PRIMARY_TARGET_CASES = 18;

/**
 * 停止の判定。**primary の総数ではなく、最終24件を組めるか（sampling feasibility）で見る。**
 *
 * どの条件の eligibility で数えるかは分析ごとに違う（prompt-placement は条件A、
 * context-coverage は条件C-repo）。詳細は `docs/second-opinion-eval.md` にある。
 */
const STOP_RULE =
  '最終24件を組めるかで判定する。難しい正例に充てられる eligible な案件 >= 9 + 予備、' +
  '普通の正例 >= 6 + 予備、問題の無い変更の負例 >= 6 + 予備、判断しきれない案件 >= 3 + 予備。' +
  `目安の停止点は eligible な primary ${PRIMARY_TARGET_CASES} 件だが、層が満ちていれば手前で止めてよく、` +
  '満ちていなければ続ける。同じPRで複数の finding が成立しても案件としてのカウントは1。' +
  '後の工程で抽出の制約を満たせなければ、この順序の、前回読み終えた位置の次から読み足す';

interface CandidatesFile {
  frameSha256: string;
  evidenceSourceSha256: string;
  candidates: EvidenceCandidates[];
}

interface Args {
  candidatesPath: string;
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
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  return { candidatesPath, outPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.candidatesPath, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== EXPECTED_CANDIDATES_SHA256) {
    throw new Error(
      `証拠候補のsha256が想定と一致しません。想定: ${EXPECTED_CANDIDATES_SHA256} / 実測: ${sha256}。` +
        '候補が変わっています。EXPECTED_CANDIDATES_SHA256 と SCREENING_ORDER_VERSION を上げ、前の版のファイルは残してください',
    );
  }
  const file = JSON.parse(raw) as CandidatesFile;
  const order = screeningOrderOf(file.candidates);

  const output = {
    candidatesFile: path.basename(args.candidatesPath),
    candidatesSha256: sha256,
    screeningOrderVersion: SCREENING_ORDER_VERSION,
    shuffleSeed: STRONG_SHUFFLE_SEED,
    /** 強い証拠の系統をどう定義したか。 */
    strongEvidenceRule: 'follow-up-test または openedAfterMerge な follow-up issue を持つ',
    /** 停止の単位は案件（PR）。finding の総数ではない。 */
    primaryTargetCases: PRIMARY_TARGET_CASES,
    /**
     * 停止条件は結果依存である。母集団の成立率の推定には使えない。集計では、読んだ件数・
     * 成立した件数・成立しなかった件数・読んでいない件数を分けて出す。
     */
    stopRule: STOP_RULE,
    /**
     * 集計に使う語。停止判定は `primaryCases` で行い、`primaryFindings` は記録に留める。
     * 未読を不成立に混ぜないため、4つを別々に出す。
     */
    reportingUnits: {
      screenedCases: '読んだ案件の数',
      primaryCases: 'primary な finding を1つ以上持つ案件の数（停止判定はこれ）',
      nonPrimaryCases: '読んだが primary が成立しなかった案件の数',
      unreadCases: 'まだ読んでいない案件の数',
      primaryFindings: '成立した finding の総数（記録のみ。停止判定には使わない）',
    },
    total: order.length,
    order,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);
  const outSha256 = createHash('sha256').update(json).digest('hex');

  console.log(`強い証拠を持つ案件: ${order.length} 件`);
  console.log(
    `読む順（先頭10件）: ${order
      .slice(0, 10)
      .map((entry) => `#${entry.prNumber}`)
      .join(' ')}`,
  );
  console.log(`停止条件: ${STOP_RULE}`);
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${outSha256}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
