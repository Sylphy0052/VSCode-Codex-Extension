/* eslint-disable no-console -- 負例poolの決め方を出すのがこのファイルの目的 */
/**
 * `no-problem`（負例）の候補集合と読む順を凍結する（Issue #1295）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/negativeOrder.ts \
 *   --frame eval-results/sampling-frame-v3.json \
 *   --candidates eval-results/evidence-candidates-v4.json \
 *   --out eval-results/negative-order-v1.json
 * ```
 *
 * **なぜ別の工程が要るか。** 強い証拠のpool 102件と追加poolの先頭10件を読み終えた時点で、
 * `no-problem` は 0件のまま止まった。screening の `disposition` からは作れない
 * （`no-relevant-finding` は「正解ラベルにできる欠陥を作れなかった」であって「重要な問題が
 * 無い」ではない）。
 *
 * **「重要な実装欠陥が無い」の根拠は次の2つ**で、どちらも不在の証明ではない。
 *
 * 1. production のコードを1行も触らない（差分そのものが根拠）
 * 2. マージ後に、このPRを参照する後続PRも後続Issueも立っていない（事後の裏づけ）
 *
 * 1 だけでは「既存の検証を弱める変更」（期待値の緩和・テストの削除）を排除できない。
 * 削除行の有無だけでは切り分けられないので、**凍結した順に読んで、差分に実在する削除・
 * 書換が既存の検証を弱めていないかを確認する**（`negativeResult.ts`）。削除行が0なら
 * 自動的に満たす。
 *
 * **先にPRのrefを取ってから流す。** 変更ファイルの一覧を `git diff` で引くので、手順1と
 * 同じく PR のrefを fetch してある必要がある（コマンドは `docs/second-opinion-eval.md` の
 * 手順1にある）。取っていないcloneでは、squash / rebase でmergeされたPRの base / target が
 * ローカルに無く、`git diff` がそこで落ちる。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { type EvidenceCandidates } from './evidenceChannels';
import { writeFrozen } from './frozenFile';
import {
  NEEDED_WITH_RESERVE,
  NEGATIVE_SHUFFLE_SEED,
  type FrameEntry,
  hasNoFollowUp,
  nonDocsFilesOf,
  orderByShuffleKey,
  touchesTestsOnly,
  verifySubsetOfEligible,
} from './negativePool';

const run = promisify(execFile);
const REPO_DIR = process.cwd();

/** 手順1で凍結した sampling frame のsha256。ずれたら止める。 */
const EXPECTED_FRAME_SHA256 = '9fb0208257b4b6f79e5128bfcd578b2afa06132874f20fe7faf4ab8a03424854';

/** 手順2で凍結した証拠候補のsha256。ずれたら止める。 */
const EXPECTED_CANDIDATES_SHA256 =
  '6ce8c84c6f2e08667ab71f32f7ad97ac3af137af0ee14dbd02f3b0a95fb05e98';

/** 負例poolの版。規則やseedを変えたら上げ、前の版のファイルは残す。 */
const NEGATIVE_ORDER_VERSION = 1;

interface FrameFile {
  prs: (FrameEntry & { changedFiles?: number })[];
}

interface CandidatesFile {
  candidates: EvidenceCandidates[];
}

interface Args {
  framePath: string;
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
  const framePath = values.get('frame');
  if (framePath === undefined || framePath === '') {
    throw new Error('--frame（手順1で凍結した sampling frame）は必須です');
  }
  const candidatesPath = values.get('candidates');
  if (candidatesPath === undefined || candidatesPath === '') {
    throw new Error('--candidates（手順2で凍結した証拠候補）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  return { framePath, candidatesPath, outPath };
}

async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', REPO_DIR, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** 読むときに確認が要るかの目印。非docsの削除行が0なら、既存の検証を弱めようがない。 */
interface DiffShape {
  files: string[];
  additions: number;
  deletions: number;
}

async function diffShapeOf(baseSha: string, targetSha: string): Promise<DiffShape> {
  const range = `${baseSha}..${targetSha}`;
  const files = (await git(['diff', '--name-only', range])).split('\n').filter(Boolean);
  const nonDocs = nonDocsFilesOf(files);
  if (nonDocs.length === 0) {
    return { files, additions: 0, deletions: 0 };
  }
  const numstat = (await git(['diff', '--numstat', range, '--', ...nonDocs]))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  // バイナリは `-` で返る。行数としては数えられないので0として扱い、件数は files に残る
  const toCount = (value: string | undefined): number =>
    value === undefined || value === '-' ? 0 : Number(value);
  return {
    files,
    additions: numstat.reduce((total, row) => total + toCount(row[0]), 0),
    deletions: numstat.reduce((total, row) => total + toCount(row[1]), 0),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawFrame = await fs.readFile(args.framePath, 'utf8');
  const frameSha256 = createHash('sha256').update(rawFrame).digest('hex');
  if (frameSha256 !== EXPECTED_FRAME_SHA256) {
    throw new Error(
      `sampling frame のsha256が想定と一致しません。想定: ${EXPECTED_FRAME_SHA256} / 実測: ${frameSha256}。` +
        'EXPECTED_FRAME_SHA256 と NEGATIVE_ORDER_VERSION を上げ、前の版のファイルは残してください',
    );
  }
  const rawCandidates = await fs.readFile(args.candidatesPath, 'utf8');
  const candidatesSha256 = createHash('sha256').update(rawCandidates).digest('hex');
  if (candidatesSha256 !== EXPECTED_CANDIDATES_SHA256) {
    throw new Error(
      `証拠候補のsha256が想定と一致しません。想定: ${EXPECTED_CANDIDATES_SHA256} / 実測: ${candidatesSha256}`,
    );
  }

  const frame = (JSON.parse(rawFrame) as FrameFile).prs;
  const candidates = new Map(
    (JSON.parse(rawCandidates) as CandidatesFile).candidates.map((entry) => [
      entry.prNumber,
      entry,
    ]),
  );
  const eligible = frame.filter((entry) => entry.excludedBy === undefined);

  const selected: {
    prNumber: number;
    changeSizeStratum: string | undefined;
    tags: string[];
    nonDocsFiles: number;
    additions: number;
    deletions: number;
    /** 削除行があるものだけ、既存の検証を弱めていないかを読んで確かめる。 */
    needsDeletionReview: boolean;
  }[] = [];
  let testOnlyCount = 0;
  for (const entry of eligible) {
    if (entry.baseSha === undefined || entry.targetSha === undefined) {
      // frame の eligible は snapshot が解決済みのはずなので、欠けていたら黙って飛ばさない
      throw new Error(`#${entry.prNumber} に base / target がありません。frame を確かめてください`);
    }
    const shape = await diffShapeOf(entry.baseSha, entry.targetSha);
    if (!touchesTestsOnly(shape.files)) {
      continue;
    }
    testOnlyCount += 1;
    const candidate = candidates.get(entry.prNumber);
    if (candidate === undefined) {
      throw new Error(`#${entry.prNumber} が証拠候補にありません。frame と候補の版が違います`);
    }
    if (!hasNoFollowUp(candidate)) {
      continue;
    }
    selected.push({
      prNumber: entry.prNumber,
      changeSizeStratum: entry.changeSizeStratum,
      tags: entry.tags,
      nonDocsFiles: nonDocsFilesOf(shape.files).length,
      additions: shape.additions,
      deletions: shape.deletions,
      needsDeletionReview: shape.deletions > 0,
    });
  }

  const order = orderByShuffleKey(selected, NEGATIVE_SHUFFLE_SEED);
  verifySubsetOfEligible(order, frame);

  const byStratum: Record<string, number> = {};
  for (const entry of order) {
    const key = entry.changeSizeStratum ?? 'unknown';
    byStratum[key] = (byStratum[key] ?? 0) + 1;
  }

  const output = {
    poolId: 'negative',
    difficultyStratum: 'no-problem',
    frameFile: path.basename(args.framePath),
    frameSha256,
    candidatesFile: path.basename(args.candidatesPath),
    candidatesSha256,
    negativeOrderVersion: NEGATIVE_ORDER_VERSION,
    shuffleSeed: NEGATIVE_SHUFFLE_SEED,
    /** 集合の決め方。frame と手順2の機械的な属性だけで決まり、中身は読んでいない。 */
    negativeRule:
      'frame の eligible のうち、文書以外の変更ファイルが全て test/ 配下で、' +
      'followUpPrs が空、かつ openedAfterMerge な followUpIssues が空の案件。' +
      '固定seedの順に読み、削除行があるものだけ既存の検証を弱めていないかを確認する',
    /** 不在の証明ではない、と言える理由。ここを緩めると hallucinatedFindings の分母が壊れる。 */
    groundsForEmptyLabel: [
      'production のコードを1行も触らないので、production の振る舞いを壊す欠陥は構造上あり得ない',
      'マージ後に、このPRを参照する後続PRも後続Issueも立っていない',
    ],
    /** 結果へ必ず書く限界。 */
    knownLimitation:
      '整形のみのPRは母集団に0件で、「production のコードを触るが重要な欠陥が無い」と機械的に' +
      '主張できる案件はこの母集団に存在しない。したがってこの層は test-only に偏り、' +
      'hallucinatedFindings は「テストだけの変更に対して存在しない問題をどれだけ指摘するか」として読む。' +
      'また、knownImportantFindings が空であることは、採点者が材料から真と確かめた指摘を' +
      'hallucinatedFindings へ数える根拠にはならない',
    neededWithReserve: NEEDED_WITH_RESERVE['no-problem'],
    meetsNeed: order.length >= NEEDED_WITH_RESERVE['no-problem'],
    byChangeSizeStratum: byStratum,
    reportingUnits: {
      poolId: 'この順序ファイルから読んだ分の集計であることを示す',
      screenedCases: '読んだ案件の数',
      confirmedCases: '負例として確定した案件の数',
      rejectedCases: '読んだが確定しなかった案件の数',
      unreadCases: 'まだ読んでいない案件の数',
    },
    total: order.length,
    order,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);

  console.log(`文書以外の変更が test/ 配下のみ: ${testOnlyCount} 件`);
  console.log(`  うち後続PR・後続Issueが無い: ${order.length} 件`);
  console.log(`  変更規模の内訳: ${JSON.stringify(byStratum)}`);
  console.log(
    order.length >= NEEDED_WITH_RESERVE['no-problem']
      ? `必要数（予備込み ${NEEDED_WITH_RESERVE['no-problem']} 件）を満たしています`
      : `必要数（予備込み ${NEEDED_WITH_RESERVE['no-problem']} 件）に ${
          NEEDED_WITH_RESERVE['no-problem'] - order.length
        } 件足りません`,
  );
  console.log(
    `読む順（先頭10件）: ${order
      .slice(0, 10)
      .map((entry) => `#${entry.prNumber}`)
      .join(' ')}`,
  );
  console.log(
    `削除行があり確認が要る案件: ${order.filter((entry) => entry.needsDeletionReview).length} 件`,
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
