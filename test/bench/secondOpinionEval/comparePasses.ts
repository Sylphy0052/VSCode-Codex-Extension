/* eslint-disable no-console -- 突合結果を出すのがこのファイルの目的 */
/**
 * 二重採点（pass2）の各回答を1巡目（pass1）の採点と突き合わせ、採点のズレを条件別に出す。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/comparePasses.ts \
 *   --pass1 <pass1ディレクトリ> --pass2 <pass2ディレクトリ> \
 *   --selection <pass2-selection.json> --key <key.json>
 * ```
 *
 * 指標は `docs/second-opinion-eval.md` の `run-2026-09-19-prompt-placement` の記録と揃える。
 * recall の添字の一致（完全一致とJaccard）、actionable precision の絶対差、
 * `hallucinatedFindings` / `totalFindings` / `indeterminateFindings` の一致を見る。
 *
 * `--selection` の `scoringIds` にあるのに pass1 か pass2 のどちらかが欠けていれば止まる。
 * 欠けたまま数えると、二重採点の件数が層別で決めた数からずれたことに気づけない。
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

interface Score {
  scoringId: string;
  totalFindings: number;
  actionableFindings: number;
  verifiedNonActionableFindings: number;
  indeterminateFindings: number;
  hallucinatedFindings: number;
  recalledFindingIndexes: number[];
}

interface KeyEntry {
  scoringId: string;
  conditionId: string;
}

interface Selection {
  scoringIds: string[];
}

interface Args {
  pass1Dir: string;
  pass2Dir: string;
  selectionPath: string;
  keyPath: string;
}

interface Pair {
  scoringId: string;
  conditionId: string;
  first: Score;
  second: Score;
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
  const required = ['pass1', 'pass2', 'selection', 'key'] as const;
  for (const key of required) {
    if (values.get(key) === undefined || values.get(key) === '') {
      throw new Error(`--${key} が必要です`);
    }
  }
  return {
    pass1Dir: path.resolve(values.get('pass1') as string),
    pass2Dir: path.resolve(values.get('pass2') as string),
    selectionPath: path.resolve(values.get('selection') as string),
    keyPath: path.resolve(values.get('key') as string),
  };
}

async function readScore(dir: string, scoringId: string): Promise<Score | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, `${scoringId}.json`), 'utf8')) as Score;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** 両方とも空集合なら一致とみなして1を返す。 */
function jaccard(a: readonly number[], b: readonly number[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) {
    return 1;
  }
  const intersection = [...setA].filter((value) => setB.has(value)).length;
  return intersection / union.size;
}

/** 判定できた指摘がない回答（全件が判定不能）は precision を持たない。summarize.ts と同じ扱い。 */
function precisionOf(score: Score): number | undefined {
  const judged =
    score.actionableFindings + score.verifiedNonActionableFindings + score.hallucinatedFindings;
  return judged > 0 ? score.actionableFindings / judged : undefined;
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function format(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(3);
}

function report(label: string, pairs: readonly Pair[]): void {
  const n = pairs.length;
  const count = (predicate: (pair: Pair) => boolean): string =>
    `${pairs.filter(predicate).length}/${n}`;

  const recallExact = count(
    (p) => jaccard(p.first.recalledFindingIndexes, p.second.recalledFindingIndexes) === 1,
  );
  const recallJaccard = mean(
    pairs.map((p) => jaccard(p.first.recalledFindingIndexes, p.second.recalledFindingIndexes)),
  );
  // 片方だけ precision を持たない回答は差を出せないので落とし、件数を併記する
  const precisionDiffs = pairs.flatMap((p) => {
    const a = precisionOf(p.first);
    const b = precisionOf(p.second);
    return a !== undefined && b !== undefined ? [Math.abs(a - b)] : [];
  });

  console.log(`[${label}] ${n}件`);
  console.log(
    `  recall の添字:          完全一致 ${recallExact}（Jaccard 平均 ${format(recallJaccard)}）`,
  );
  console.log(
    `  actionable precision:   平均絶対差 ${format(mean(precisionDiffs))}（precision を持つ ${precisionDiffs.length}件）`,
  );
  console.log(
    `  hallucinatedFindings:   一致 ${count((p) => p.first.hallucinatedFindings === p.second.hallucinatedFindings)}`,
  );
  console.log(
    `  totalFindings:          完全一致 ${count((p) => p.first.totalFindings === p.second.totalFindings)}` +
      ` / ±1以内 ${count((p) => Math.abs(p.first.totalFindings - p.second.totalFindings) <= 1)}`,
  );
  console.log(
    `  indeterminateFindings:  完全一致 ${count((p) => p.first.indeterminateFindings === p.second.indeterminateFindings)}`,
  );
}

async function main(): Promise<void> {
  const { pass1Dir, pass2Dir, selectionPath, keyPath } = parseArgs(process.argv.slice(2));

  const selection = JSON.parse(await fs.readFile(selectionPath, 'utf8')) as Selection;
  const keyEntries = JSON.parse(await fs.readFile(keyPath, 'utf8')) as KeyEntry[];
  const conditionOf = new Map(keyEntries.map((entry) => [entry.scoringId, entry.conditionId]));

  const pairs: Pair[] = [];
  const problems: string[] = [];
  for (const scoringId of selection.scoringIds) {
    const conditionId = conditionOf.get(scoringId);
    const first = await readScore(pass1Dir, scoringId);
    const second = await readScore(pass2Dir, scoringId);
    if (conditionId === undefined) {
      problems.push(`${scoringId}: key に無い`);
    }
    if (first === undefined) {
      problems.push(`${scoringId}: pass1 に無い`);
    }
    if (second === undefined) {
      problems.push(`${scoringId}: pass2 に無い`);
    }
    if (conditionId !== undefined && first !== undefined && second !== undefined) {
      pairs.push({ scoringId, conditionId, first, second });
    }
  }
  if (problems.length > 0) {
    throw new Error(`突き合わせられない回答があります:\n${problems.join('\n')}`);
  }

  report('全体', pairs);
  const conditions = [...new Set(pairs.map((p) => p.conditionId))].sort();
  for (const conditionId of conditions) {
    report(
      conditionId,
      pairs.filter((p) => p.conditionId === conditionId),
    );
  }

  // ズレの中身を読みに行けるよう、どれか1つでも食い違った回答を列挙する
  console.log('食い違いのある回答:');
  for (const { scoringId, conditionId, first, second } of pairs) {
    const diffs: string[] = [];
    if (jaccard(first.recalledFindingIndexes, second.recalledFindingIndexes) !== 1) {
      diffs.push(
        `recall [${first.recalledFindingIndexes.join(',')}]→[${second.recalledFindingIndexes.join(',')}]`,
      );
    }
    const fields = [
      'totalFindings',
      'actionableFindings',
      'verifiedNonActionableFindings',
      'indeterminateFindings',
      'hallucinatedFindings',
    ] as const;
    for (const field of fields) {
      if (first[field] !== second[field]) {
        diffs.push(`${field} ${first[field]}→${second[field]}`);
      }
    }
    if (diffs.length > 0) {
      console.log(`  ${scoringId}（${conditionId}）: ${diffs.join(' / ')}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
