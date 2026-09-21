/* eslint-disable no-console -- 検査結果を出すのがこのファイルの目的 */
/**
 * 採点者が1件ずつ書き出したJSONを集め、検査してから `scores.json` へまとめる（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/collectScores.ts \
 *   --dir <採点結果のディレクトリ> --index <prompts/index.json> --rubric <rubric.json> \
 *   [--out <scores.json>]
 * ```
 *
 * `--out` を省くと検査だけを行い、書き出さない。検査で1件でも落ちれば書き出さずに止める。
 * 採点の取りこぼし（ファイルが無い）と、規約違反（4区分の合計が `totalFindings` と合わない、
 * 正解ラベルの件数と `recallEvidence` の件数が合わない、範囲外の添字）をここで捕まえる。
 *
 * `scores.json` には `summarize.ts` が読む項目だけを入れ、`findingsBreakdown` と `recallEvidence`
 * は `scores-details.json` へ分けて残す。後から一致を検証できるのはこの記録だけである。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { validateScore, type Score } from './recall';

interface IndexEntry {
  scoringId: string;
  opaqueCaseId: string;
  promptPath: string;
  scorePath: string;
}

interface RubricEntry {
  opaqueCaseId: string;
  knownImportantFindings: { finding: string }[];
}

interface ScoreFile extends Score {
  findingsBreakdown?: { summary: string; category: string; reason: string }[];
  recallEvidence?: { findingIndex: number; matched: boolean; criteriaMatches: string[] }[];
}

interface Args {
  dir: string;
  indexPath: string;
  rubricPath: string;
  outPath?: string | undefined;
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
  for (const key of ['dir', 'index', 'rubric'] as const) {
    if (values.get(key) === undefined || values.get(key) === '') {
      throw new Error(`--${key} が必要です`);
    }
  }
  const out = values.get('out');
  return {
    dir: path.resolve(values.get('dir') as string),
    indexPath: path.resolve(values.get('index') as string),
    rubricPath: path.resolve(values.get('rubric') as string),
    outPath: out === undefined || out === '' ? undefined : path.resolve(out),
  };
}

const SCORE_FIELDS = [
  'scoringId',
  'totalFindings',
  'actionableFindings',
  'verifiedNonActionableFindings',
  'indeterminateFindings',
  'hallucinatedFindings',
  'recalledFindingIndexes',
  'constraintViolations',
  'unnecessaryInvestigationRequests',
] as const;

function checkOne(scoringId: string, score: ScoreFile, findingCount: number): string[] {
  const problems: string[] = [];
  if (score.scoringId !== scoringId) {
    problems.push(`scoringId がファイル名と一致しません: ${String(score.scoringId)}`);
  }
  for (const field of SCORE_FIELDS) {
    if (score[field] === undefined) {
      problems.push(`${field} がありません`);
    }
  }
  const invalid = validateScore(score, findingCount);
  if (invalid !== undefined) {
    problems.push(invalid);
  }
  const sum =
    score.actionableFindings +
    score.verifiedNonActionableFindings +
    score.indeterminateFindings +
    score.hallucinatedFindings;
  if (sum !== score.totalFindings) {
    problems.push(`4区分の合計(${sum})が totalFindings(${score.totalFindings})と一致しません`);
  }
  if (
    score.findingsBreakdown !== undefined &&
    score.findingsBreakdown.length !== score.totalFindings
  ) {
    problems.push(
      `findingsBreakdown(${score.findingsBreakdown.length}件)が totalFindings(${score.totalFindings})と一致しません`,
    );
  }
  if (score.recallEvidence !== undefined && score.recallEvidence.length !== findingCount) {
    problems.push(
      `recallEvidence(${score.recallEvidence.length}件)が正解ラベル(${findingCount}件)と一致しません`,
    );
  }
  if (score.recallEvidence !== undefined) {
    // `recalledFindingIndexes` と同じく、添字の範囲と重複をここで見る。壊れたまま
    // 通すと、後から一致を確かめる唯一の記録（`-details.json`）が壊れる。
    const seen = new Set<number>();
    for (const entry of score.recallEvidence) {
      if (!Number.isInteger(entry.findingIndex) || entry.findingIndex < 0) {
        problems.push(
          `recallEvidence の findingIndex(${entry.findingIndex})が整数の添字ではありません`,
        );
        continue;
      }
      if (entry.findingIndex >= findingCount) {
        problems.push(
          `recallEvidence の findingIndex(${entry.findingIndex})が正解ラベル(${findingCount}件)の範囲外です`,
        );
        continue;
      }
      if (seen.has(entry.findingIndex)) {
        problems.push(`recallEvidence の findingIndex(${entry.findingIndex})が重複しています`);
        continue;
      }
      seen.add(entry.findingIndex);
    }

    const matched = score.recallEvidence
      .filter((entry) => entry.matched)
      .map((entry) => entry.findingIndex)
      .sort((a, b) => a - b);
    const declared = [...score.recalledFindingIndexes].sort((a, b) => a - b);
    if (JSON.stringify(matched) !== JSON.stringify(declared)) {
      problems.push(
        `recallEvidence の matched(${JSON.stringify(matched)})が recalledFindingIndexes(${JSON.stringify(declared)})と一致しません`,
      );
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const index = JSON.parse(await fs.readFile(args.indexPath, 'utf8')) as IndexEntry[];
  const rubric = JSON.parse(await fs.readFile(args.rubricPath, 'utf8')) as RubricEntry[];
  const findingCounts = new Map(
    rubric.map((entry) => [entry.opaqueCaseId, entry.knownImportantFindings.length]),
  );

  const scores: Score[] = [];
  const details: Record<string, unknown>[] = [];
  const missing: string[] = [];
  const failed: string[] = [];

  for (const entry of index) {
    const filePath = path.join(args.dir, `${entry.scoringId}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      missing.push(entry.scoringId);
      continue;
    }
    let score: ScoreFile;
    try {
      score = JSON.parse(raw) as ScoreFile;
    } catch (error) {
      failed.push(`${entry.scoringId}: JSONとして読めません (${String(error)})`);
      continue;
    }
    const findingCount = findingCounts.get(entry.opaqueCaseId);
    if (findingCount === undefined) {
      failed.push(`${entry.scoringId}: rubricに案件がありません (${entry.opaqueCaseId})`);
      continue;
    }
    const problems = checkOne(entry.scoringId, score, findingCount);
    if (problems.length > 0) {
      failed.push(`${entry.scoringId}: ${problems.join(' / ')}`);
      continue;
    }
    scores.push({
      scoringId: score.scoringId,
      totalFindings: score.totalFindings,
      actionableFindings: score.actionableFindings,
      verifiedNonActionableFindings: score.verifiedNonActionableFindings,
      indeterminateFindings: score.indeterminateFindings,
      hallucinatedFindings: score.hallucinatedFindings,
      recalledFindingIndexes: score.recalledFindingIndexes,
      constraintViolations: score.constraintViolations,
      unnecessaryInvestigationRequests: score.unnecessaryInvestigationRequests,
    });
    details.push({
      scoringId: score.scoringId,
      opaqueCaseId: entry.opaqueCaseId,
      findingsBreakdown: score.findingsBreakdown ?? [],
      recallEvidence: score.recallEvidence ?? [],
    });
  }

  console.log(`対象 ${index.length} 件 / 取り込み ${scores.length} 件`);
  if (missing.length > 0) {
    console.log(`未採点 ${missing.length} 件: ${missing.join(' ')}`);
  }
  for (const line of failed) {
    console.log(`NG ${line}`);
  }

  if (args.outPath === undefined) {
    return;
  }
  if (missing.length > 0 || failed.length > 0) {
    console.log('未採点または規約違反があるため書き出しません');
    process.exitCode = 1;
    return;
  }
  await fs.mkdir(path.dirname(args.outPath), { recursive: true });
  await fs.writeFile(args.outPath, `${JSON.stringify(scores, null, 2)}\n`, 'utf8');
  const detailsPath = path.join(
    path.dirname(args.outPath),
    `${path.basename(args.outPath, '.json')}-details.json`,
  );
  await fs.writeFile(detailsPath, `${JSON.stringify(details, null, 2)}\n`, 'utf8');
  console.log(`書き出しました: ${args.outPath}`);
  console.log(`採点の根拠: ${detailsPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
