/* eslint-disable no-console -- 確認結果を出すのがこのファイルの目的 */
/**
 * 凍結した `indeterminate` pool の各案件で、条件Aの材料が本当に打ち切られることを確かめる
 * （Issue #1295 の凍結後の確認）。
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/indeterminateTruncation.ts \
 *   --order eval-results/indeterminate-order-v1.json \
 *   --out eval-results/indeterminate-truncation-v1.json
 * ```
 *
 * **pool の規則が見ているのは生の `git diff` のバイト数で、これは打ち切りの proxy にすぎない。**
 * 実際の材料は `captureWorkspaceSnapshot()` が組み立て、未追跡ファイルの分も同じ
 * {@link MAX_DIFF_BYTES} の予算を食う。予算の割り当て方が変われば、生の差分が予算を超えていても
 * 打ち切りが立たない案件が出うる。この層は「材料の欠落がプロンプトに現れている案件」でなければ
 * 役目を果たさないので、pool を凍結したあとに1件ずつ組んで確かめる。
 *
 * **モデルは呼ばない。** 確かめるのは材料の側だけなので、結果変数（回答・採点）を覗くことには
 * ならない。
 *
 * 見るのは次の3つで、`truncated` だけでは足りない。
 *
 * - `snapshot.truncated` が立っているか（`applyDiffBudget()` が何かを落としたか）
 * - 落とした対象（`diffOmissions` / `diffPartials`）が1件以上あるか
 * - 条件Aの**プロンプト本文**に打ち切りの注意書きが出ているか（Advisor が留保する手がかり）
 *
 * 出力は凍結しない。`materials.ts` や予算の実装を直したら流し直して読み替えるファイルである。
 * 凍結してあるのは読む順（`indeterminate-order-v1.json`）の側である。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { buildSecondOpinionPrompt } from '../../../src/secondOpinion/prompt';
import { MAX_DIFF_BYTES } from '../../../src/secondOpinion/snapshot';

import { findCondition } from './conditions';
import { prepareCaseMaterial } from './materials';
import type { EvalCase } from './types';

/** 手順1で凍結した sampling frame のsha256。base / target をここから取る。 */
const EXPECTED_FRAME_SHA256 = '9fb0208257b4b6f79e5128bfcd578b2afa06132874f20fe7faf4ab8a03424854';

/** 凍結済みの `indeterminate` の読む順のsha256。pool を作り直したら版を上げる。 */
const EXPECTED_ORDER_SHA256 = '01dbbe1cc2f1e8a4c2aa54dfe8bb7dec9964c5a615291055884bf2a29b33fe68';

/**
 * プロンプトへ出る打ち切りの注意書き（`src/secondOpinion/prompt.ts` の `artifactSection`）。
 *
 * 文言を本体から import できないので、ここでは部分一致で見る。本体の文言を変えたらここも
 * 直す必要があり、直し忘れればこの確認が落ちる。黙って通るより落ちる方がよい。
 */
const TRUNCATION_NOTICE = '差分が大きいため一部を省略しています';

interface FrameEntry {
  prNumber: number;
  title?: string;
  baseSha?: string;
  targetSha?: string;
  excludedBy?: string;
}

interface OrderFile {
  poolId: string;
  maxDiffBytes: number;
  order: { prNumber: number; diffBytes: number; changeSizeStratum?: string }[];
}

interface Args {
  orderPath: string;
  framePath: string;
  outPath: string;
  repoPath: string;
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
    throw new Error('--order（凍結した indeterminate の読む順）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  return {
    orderPath,
    framePath: values.get('frame') ?? 'eval-results/sampling-frame-v3.json',
    outPath,
    repoPath: path.resolve(values.get('repo') ?? process.cwd()),
  };
}

async function readVerified(filePath: string, expected: string, what: string): Promise<string> {
  const raw = await fs.readFile(filePath, 'utf8');
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `${what} のsha256が想定と一致しません。想定: ${expected} / 実測: ${actual}。` +
        '版を上げて作り直したなら、このファイルの定数も更新してください',
    );
  }
  return raw;
}

interface CheckResult {
  prNumber: number;
  changeSizeStratum: string | undefined;
  /** pool の規則が見た、生の `git diff` のバイト数。 */
  rawDiffBytes: number;
  /** 実際に材料へ載った差分のバイト数。 */
  materialDiffBytes: number;
  truncated: boolean;
  diffOmissions: number;
  diffPartials: number;
  untrackedFiles: number;
  untrackedOmissions: number;
  /** 条件Aのプロンプト本文に打ち切りの注意書きが出たか。 */
  noticeInPrompt: boolean;
  /** この案件が層の前提を満たすか。3つすべてを満たしたときだけ真。 */
  ok: boolean;
  /** 満たさなかった場合の理由。 */
  reason?: string;
}

async function checkCase(
  entry: OrderFile['order'][number],
  frameEntry: FrameEntry,
  repoPath: string,
): Promise<CheckResult> {
  if (frameEntry.baseSha === undefined || frameEntry.targetSha === undefined) {
    throw new Error(`#${entry.prNumber} に base / target がありません。frame を確かめてください`);
  }
  const conditionA = findCondition('A');
  if (conditionA === undefined) {
    throw new Error('条件Aが見つかりません。conditions.ts を確かめてください');
  }

  const evalCase: EvalCase = {
    id: `indeterminate-${entry.prNumber}`,
    kind: 'codeReview',
    repoPath,
    baseCommit: frameEntry.baseSha,
    targetCommit: frameEntry.targetSha,
    // 確認するのは材料の側だけなので、依頼文と背景は最小のものを置く。モデルは呼ばない
    userRequest: 'この変更をレビューしてください。',
    conversation: '',
    conversationKind: 'summary',
    knownImportantFindings: [],
    knownConstraints: [],
  };

  const prepared = await prepareCaseMaterial(evalCase, [conditionA]);
  if (!prepared.ok) {
    throw new Error(`#${entry.prNumber} の材料を作れませんでした: ${prepared.reason}`);
  }
  try {
    const input = conditionA.apply(prepared.material.input);
    const { artifact } = input;
    if (artifact.kind !== 'workspaceChanges') {
      throw new Error(
        `#${entry.prNumber} の追加資料が workspaceChanges ではありません: ${artifact.kind}`,
      );
    }
    const { snapshot } = artifact;
    const prompt = buildSecondOpinionPrompt(input);
    const noticeInPrompt = prompt.includes(TRUNCATION_NOTICE);
    const omissions = snapshot.diffOmissions.length;
    const partials = snapshot.diffPartials.length;

    const reasons: string[] = [];
    if (!snapshot.truncated) {
      reasons.push('snapshot.truncated が立たなかった');
    }
    if (omissions + partials === 0) {
      reasons.push('落とした対象（diffOmissions / diffPartials）が0件だった');
    }
    if (!noticeInPrompt) {
      reasons.push('条件Aのプロンプトに打ち切りの注意書きが出なかった');
    }

    const result: CheckResult = {
      prNumber: entry.prNumber,
      changeSizeStratum: entry.changeSizeStratum,
      rawDiffBytes: entry.diffBytes,
      materialDiffBytes: Buffer.byteLength(snapshot.diff, 'utf8'),
      truncated: snapshot.truncated,
      diffOmissions: omissions,
      diffPartials: partials,
      untrackedFiles: snapshot.untrackedFiles.length,
      untrackedOmissions: snapshot.untrackedOmissions.length,
      noticeInPrompt,
      ok: reasons.length === 0,
    };
    if (reasons.length > 0) {
      result.reason = reasons.join(' / ');
    }
    return result;
  } finally {
    await prepared.material.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawOrder = await readVerified(
    args.orderPath,
    EXPECTED_ORDER_SHA256,
    'indeterminate の読む順',
  );
  const orderFile = JSON.parse(rawOrder) as OrderFile;
  if (orderFile.poolId !== 'indeterminate') {
    throw new Error(`poolId が indeterminate ではありません: ${orderFile.poolId}`);
  }
  if (orderFile.maxDiffBytes !== MAX_DIFF_BYTES) {
    throw new Error(
      `pool を凍結したときの予算（${orderFile.maxDiffBytes}）と現在の MAX_DIFF_BYTES` +
        `（${MAX_DIFF_BYTES}）が違います。pool を作り直してください`,
    );
  }

  const rawFrame = await readVerified(args.framePath, EXPECTED_FRAME_SHA256, 'sampling frame');
  const frame = (JSON.parse(rawFrame) as { prs: FrameEntry[] }).prs;
  const byNumber = new Map(frame.map((entry) => [entry.prNumber, entry]));

  const results: CheckResult[] = [];
  for (const entry of orderFile.order) {
    const frameEntry = byNumber.get(entry.prNumber);
    if (frameEntry === undefined) {
      throw new Error(`#${entry.prNumber} が frame にありません`);
    }
    const result = await checkCase(entry, frameEntry, args.repoPath);
    results.push(result);
    console.log(
      `#${result.prNumber} ${result.ok ? 'OK' : 'NG'} ` +
        `truncated=${result.truncated} ` +
        `落とした対象=${result.diffOmissions + result.diffPartials}件 ` +
        `注意書き=${result.noticeInPrompt} ` +
        `材料の差分=${result.materialDiffBytes} byte（生 ${result.rawDiffBytes} byte）` +
        (result.reason === undefined ? '' : ` — ${result.reason}`),
    );
  }

  const failed = results.filter((result) => !result.ok);
  const output = {
    poolId: 'indeterminate',
    orderFile: path.basename(args.orderPath),
    orderSha256: EXPECTED_ORDER_SHA256,
    frameFile: path.basename(args.framePath),
    frameSha256: EXPECTED_FRAME_SHA256,
    maxDiffBytes: MAX_DIFF_BYTES,
    conditionId: 'A',
    verification:
      '条件Aの bundle を1件ずつ組み、snapshot.truncated・落とした対象の件数・プロンプトの' +
      '注意書きの3つを見る。生の git diff のバイト数は打ち切りの proxy でしかないため',
    total: results.length,
    okCases: results.length - failed.length,
    failedCases: failed.length,
    allTruncated: failed.length === 0,
    results,
  };
  await fs.writeFile(args.outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(
    `確認: ${results.length} 件中 ${results.length - failed.length} 件が層の前提を満たす`,
  );
  console.log(`出力: ${args.outPath}`);
  if (failed.length > 0) {
    // 満たさない案件が残ったまま pool を使うと、留保を測れない案件が層へ混ざる
    throw new Error(
      `打ち切りが立たない案件が ${failed.length} 件あります: ` +
        failed.map((result) => `#${result.prNumber}`).join(' '),
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
