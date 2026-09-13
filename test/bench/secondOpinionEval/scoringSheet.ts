/* eslint-disable no-console -- 生成結果を出すのがこのファイルの目的 */
/**
 * 採点シートの生成（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/scoringSheet.ts \
 *   --results <結果ディレクトリ> --cases <cases.json> --out <採点用ディレクトリ> [--seed 12345]
 * ```
 *
 * 結果ファイルには条件名（`A` / `B-pos` / `B-repeat`）が入っている。そのまま採点すると、どちらが
 * 「新しい方」かが分かってしまう。ここでは条件名を伏せた採点用ファイルへ組み替え、提示順も
 * シャッフルする（Issue #1044 の実験条件「評価時は条件名を隠し、提示順をランダム化する」）。
 *
 * 採点者へは**回答だけでなく採点基準も渡す**。依頼文・重要問題の一覧・制約が手元に無いと、
 * recall と制約違反は採点しようがない。条件によって変わらない情報だけを渡すので、これで条件が
 * 割れることはない。**条件ごとのプロンプト全文は渡さない**（`B-repeat` は依頼が2回入っており、
 * 見ればどの条件か分かる）。
 *
 * 対応表（採点id → 案件・条件）は別ファイルへ書く。採点が済むまで**開かないこと。**
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

import type { EvalCase, EvalRunManifest, EvalRunRecord, KnownFinding } from './types';

/** 採点者へ見せる案件の基準。条件によって変わらないものだけを入れる。 */
interface ScoringRubricCase {
  /** 採点シート内での案件の呼び名。元のidは出さない（`advisor-summary-bug` のような名前は手がかりになる）。 */
  opaqueCaseId: string;
  caseKind: EvalCase['kind'];
  userRequest: string;
  knownImportantFindings: KnownFinding[];
  knownConstraints: string[];
}

/** 採点者へ見せる回答。条件名・モデル・latency・トークン量は入れない（先入観になる）。 */
interface ScoringItem {
  scoringId: string;
  opaqueCaseId: string;
  caseKind: EvalRunRecord['caseKind'];
  response: string;
}

/** 採点が済んでから開く対応表。 */
interface ScoringKeyEntry {
  scoringId: string;
  opaqueCaseId: string;
  caseId: string;
  conditionId: string;
  attempt: number;
}

interface Args {
  resultsDir: string;
  casesPath: string;
  outDir: string;
  seed: number;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error(`引数の形が正しくありません: ${argv.join(' ')}`);
    }
    values.set(key.slice(2), value);
  }
  const resultsDir = values.get('results');
  const casesPath = values.get('cases');
  const outDir = values.get('out');
  if (resultsDir === undefined || casesPath === undefined || outDir === undefined) {
    throw new Error('--results と --cases と --out は必須です');
  }
  const seedRaw = values.get('seed');
  // 既定のseedも記録して出す。`Math.random()` で混ぜると同じシートを二度と作れず、採点の
  // やり直しや監査ができない
  const seed = seedRaw === undefined ? Date.now() % 2 ** 31 : Number.parseInt(seedRaw, 10);
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`--seed は整数である必要があります: ${String(seedRaw)}`);
  }
  return { resultsDir, casesPath, outDir, seed };
}

/** seedから決まる疑似乱数（mulberry32）。同じseedなら同じ並びを再現できる。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates。
 *
 * ソート関数へ乱数を渡す書き方（`sort(() => Math.random() - 0.5)`）は分布が偏るため使わない。
 * 条件の並びに偏りが残ると、採点順そのものが条件の手がかりになる。
 */
function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = result[i];
    const b = result[j];
    if (a !== undefined && b !== undefined) {
      result[i] = b;
      result[j] = a;
    }
  }
  return result;
}

/** 採点idも案件の別名もseedから決める。再生成したときに同じシートへなるようにする。 */
function deriveId(seed: number, ...parts: string[]): string {
  return createHash('sha256')
    .update(`${seed} ${parts.join(' ')}`)
    .digest('hex')
    .slice(0, 16);
}

async function main(): Promise<void> {
  const { resultsDir, casesPath, outDir, seed } = parseArgs(process.argv.slice(2));
  const cases = JSON.parse(await fs.readFile(casesPath, 'utf8')) as EvalCase[];
  const caseById = new Map(cases.map((entry) => [entry.id, entry]));

  const manifestRaw = await fs.readFile(path.join(resultsDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as EvalRunManifest;

  const names = (await fs.readdir(resultsDir))
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
  if (names.length === 0) {
    throw new Error(`${resultsDir} に結果ファイル（*.json）がありません`);
  }

  const items: ScoringItem[] = [];
  const key: ScoringKeyEntry[] = [];
  const rubric = new Map<string, ScoringRubricCase>();
  /** 採点できなかった実行の内訳。条件ごとに数える。 */
  const skippedByCondition = new Map<string, number>();
  const scoredByCondition = new Map<string, number>();
  let foreign = 0;

  for (const name of names) {
    const raw = await fs.readFile(path.join(resultsDir, name), 'utf8');
    const record = JSON.parse(raw) as EvalRunRecord;
    if (record.runId !== manifest.runId) {
      // 前のrunの結果が同じディレクトリに残っている。混ぜると条件間の件数が合わなくなる
      foreign += 1;
      continue;
    }
    const evalCase = caseById.get(record.caseId);
    if (evalCase === undefined) {
      throw new Error(`結果 ${name} の案件 ${record.caseId} が ${casesPath} にありません`);
    }

    const bump = (map: Map<string, number>): void => {
      map.set(record.conditionId, (map.get(record.conditionId) ?? 0) + 1);
    };
    if (record.error !== undefined || record.response.trim() === '') {
      // 失敗した実行は採点しない。**黙って落とさず条件ごとの件数を出す**（片方の条件だけ多く
      // 落ちていると、生き残った回答だけで比べることになり、良い方へ偏った結論になる）
      bump(skippedByCondition);
      continue;
    }
    bump(scoredByCondition);

    const opaqueCaseId = deriveId(seed, 'case', record.caseId);
    if (!rubric.has(opaqueCaseId)) {
      rubric.set(opaqueCaseId, {
        opaqueCaseId,
        caseKind: evalCase.kind,
        userRequest: evalCase.userRequest,
        knownImportantFindings: evalCase.knownImportantFindings,
        knownConstraints: evalCase.knownConstraints,
      });
    }

    const scoringId = deriveId(seed, record.caseId, record.conditionId, String(record.attempt));
    items.push({
      scoringId,
      opaqueCaseId,
      caseKind: record.caseKind,
      response: record.response,
    });
    key.push({
      scoringId,
      opaqueCaseId,
      caseId: record.caseId,
      conditionId: record.conditionId,
      attempt: record.attempt,
    });
  }

  const random = createRandom(seed);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'sheet.json'),
    `${JSON.stringify({ seed, runId: manifest.runId, items: shuffle(items, random) }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'rubric.json'),
    `${JSON.stringify([...rubric.values()], null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(outDir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, 'utf8');

  console.log(`[sheet] seed=${seed}（同じseedなら同じシートを再生成できる）`);
  console.log(`[sheet] 採点対象 ${items.length} 件`);
  console.log(`[sheet] 条件別の採点対象: ${formatCounts(scoredByCondition)}`);
  console.log(`[sheet] 条件別の除外（失敗・空回答）: ${formatCounts(skippedByCondition)}`);
  if (foreign > 0) {
    console.error(`[sheet] 別runの結果を ${foreign} 件無視しました（runId不一致）`);
  }
  console.log(
    `[sheet] ${path.join(outDir, 'sheet.json')} を ${path.join(outDir, 'rubric.json')} と突き合わせて採点する。`,
  );
  console.log(`[sheet] ${path.join(outDir, 'key.json')} は採点が済むまで開かないこと。`);
}

function formatCounts(counts: ReadonlyMap<string, number>): string {
  if (counts.size === 0) {
    return 'なし';
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, count]) => `${id}=${count}`)
    .join(' ');
}

main().catch((e: unknown) => {
  console.error(`[sheet] 失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
