/* eslint-disable no-console -- 生成結果を出すのがこのファイルの目的 */
/**
 * pass1（1巡目採点）が終わったあと、条件×難易度層で層別して二重採点（pass2）へ回す
 * 回答（scoringId）を抽出する。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/selectPass2.ts \
 *   --key <key.json> --strata <selected-cases-v2.jsonなど> --out <出力先.json>
 * ```
 *
 * `--key` は `caseId` / `conditionId` / `scoringId` を持つ採点キー（`buildScoringPrompts.ts`
 * が書き出す `key.json`）。`--strata` は `selected-cases-v2.ts`（`selectCases.ts`の出力）で、
 * `.selected[].caseId` と `.selected[].stratum` から難易度層を引く。
 *
 * 層ごとの必要数は {@link QUOTAS} に固定する。`stratifiedSample.ts` と同じく、抽出前に
 * 固定して満たせなければ止める。
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { shuffleKeyOf } from './stratifiedSample';

interface KeyEntry {
  scoringId: string;
  opaqueCaseId: string;
  caseId: string;
  conditionId: string;
  attempt: number;
}

interface SelectedCase {
  caseId: string;
  stratum: string;
}

interface SelectedCasesFile {
  selected: SelectedCase[];
}

/**
 * 条件×難易度層ごとの抽出件数。セル件数（対象caseIdの母集団×試行数）に比例させ、
 * `run-2026-09-19-prompt-placement`の二重採点比率（144件中39件、27.1%）に合わせて丸めた。
 * `run-2026-09-20-placement-v2`はpositive層（hard-positive/normal-positive）しか
 * 含まないため、no-problem/indeterminateのセルは無い。
 */
const QUOTAS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  A: { 'hard-positive': 7, 'normal-positive': 6 },
  'B-pos': { 'hard-positive': 7, 'normal-positive': 6 },
};

const SELECTION_SEED = 'pass2-selection-v1:';

interface Args {
  keyPath: string;
  strataPath: string;
  outPath: string;
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
  const required = ['key', 'strata', 'out'] as const;
  for (const key of required) {
    if (values.get(key) === undefined || values.get(key) === '') {
      throw new Error(`--${key} が必要です`);
    }
  }
  return {
    keyPath: path.resolve(values.get('key') as string),
    strataPath: path.resolve(values.get('strata') as string),
    outPath: path.resolve(values.get('out') as string),
  };
}

async function main(): Promise<void> {
  const { keyPath, strataPath, outPath } = parseArgs(process.argv.slice(2));

  const keyEntries = JSON.parse(await fs.readFile(keyPath, 'utf8')) as KeyEntry[];
  const strataFile = JSON.parse(await fs.readFile(strataPath, 'utf8')) as SelectedCasesFile;
  const strataOf = new Map(strataFile.selected.map((entry) => [entry.caseId, entry.stratum]));

  const missing = [
    ...new Set(
      keyEntries.filter((entry) => !strataOf.has(entry.caseId)).map((entry) => entry.caseId),
    ),
  ];
  if (missing.length > 0) {
    throw new Error(`難易度層が見つからないcaseIdがあります: ${missing.join(' ')}`);
  }

  const selected: KeyEntry[] = [];
  const shortfalls: string[] = [];
  for (const [conditionId, strataQuotas] of Object.entries(QUOTAS)) {
    for (const [stratum, quota] of Object.entries(strataQuotas)) {
      const cell = keyEntries.filter(
        (entry) => entry.conditionId === conditionId && strataOf.get(entry.caseId) === stratum,
      );
      if (cell.length < quota) {
        shortfalls.push(`${conditionId}/${stratum}: ${cell.length}件（必要${quota}）`);
        continue;
      }
      const ordered = [...cell].sort((a, b) => {
        const keyA = shuffleKeyOf(a.scoringId, SELECTION_SEED);
        const keyB = shuffleKeyOf(b.scoringId, SELECTION_SEED);
        return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
      });
      selected.push(...ordered.slice(0, quota));
    }
  }
  if (shortfalls.length > 0) {
    throw new Error(`層の候補が足りません: ${shortfalls.join(' / ')}`);
  }

  const byCondition: Record<string, number> = {};
  const byStratum: Record<string, number> = {};
  for (const entry of selected) {
    byCondition[entry.conditionId] = (byCondition[entry.conditionId] ?? 0) + 1;
    const stratum = strataOf.get(entry.caseId) as string;
    byStratum[stratum] = (byStratum[stratum] ?? 0) + 1;
  }

  const output = {
    seed: SELECTION_SEED,
    quotas: QUOTAS,
    totalSelected: selected.length,
    totalPopulation: keyEntries.length,
    ratio: selected.length / keyEntries.length,
    byCondition,
    byStratum,
    scoringIds: selected.map((entry) => entry.scoringId).sort(),
  };

  await fs.writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(
    `選定 ${selected.length} / ${keyEntries.length} 件（${(output.ratio * 100).toFixed(1)}%）`,
  );
  console.log(`書き出し: ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
