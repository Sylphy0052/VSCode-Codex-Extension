/* eslint-disable no-console -- 生成結果を出すのがこのファイルの目的 */
/**
 * 採点者へ渡す材料（bundle）を、匿名化したディレクトリ名で永続化する（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/buildScoringMaterials.ts \
 *   --cases <cases.json> --key <key.json> --out <出力ディレクトリ>
 * ```
 *
 * `run.ts` が案件ごとに作る bundle（`changes.diff` 等）は、実行後 `dispose()` で消える。
 * 採点は実行から時間が空くことがあり、そのときにはもう bundle が無い。ここでは本体と同じ
 * `prepareCaseMaterial()` で bundle を作り直し、`dispose()` する前に永続先へコピーする。
 *
 * 出力先のディレクトリ名は `opaqueCaseId`（`scoringSheet.ts` が振った匿名id）にする。
 * 元の `caseId`（PR番号のような手がかりになる名前）はここでも採点者へ見せない。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { loadCases } from './caseSchema';
import { prepareCaseMaterial } from './materials';
import type { EvalCase } from './types';

interface ScoringKeyEntry {
  scoringId: string;
  opaqueCaseId: string;
  caseId: string;
  conditionId: string;
  attempt: number;
}

interface Args {
  casesPath: string;
  keyPath: string;
  outDir: string;
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
  const casesPath = values.get('cases');
  const keyPath = values.get('key');
  const outDir = values.get('out');
  if (casesPath === undefined || keyPath === undefined || outDir === undefined) {
    throw new Error('--cases と --key と --out は必須です');
  }
  return { casesPath, keyPath, outDir };
}

/** `key.json` から `caseId → opaqueCaseId` の対応を1つずつに畳む（条件×試行ぶん重複している）。 */
function collectOpaqueIdByCaseId(entries: readonly ScoringKeyEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  const caseIdByOpaqueId = new Map<string, string>();
  for (const entry of entries) {
    const existing = map.get(entry.caseId);
    if (existing !== undefined && existing !== entry.opaqueCaseId) {
      throw new Error(`caseId ${entry.caseId} に複数の opaqueCaseId が対応しています`);
    }
    // 逆向きも見る。別の案件へ同じ opaqueCaseId が振られていると、出力先が衝突して
    // 2案件の材料が1つのディレクトリへ混ざる。
    const owner = caseIdByOpaqueId.get(entry.opaqueCaseId);
    if (owner !== undefined && owner !== entry.caseId) {
      throw new Error(
        `opaqueCaseId ${entry.opaqueCaseId} が複数の caseId (${owner}, ${entry.caseId}) に対応しています`,
      );
    }
    map.set(entry.caseId, entry.opaqueCaseId);
    caseIdByOpaqueId.set(entry.opaqueCaseId, entry.caseId);
  }
  return map;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { cases } = await loadCases(options.casesPath);
  const keyEntries = JSON.parse(await fs.readFile(options.keyPath, 'utf8')) as ScoringKeyEntry[];
  const opaqueIdByCaseId = collectOpaqueIdByCaseId(keyEntries);

  await fs.mkdir(options.outDir, { recursive: true });

  const targets: { evalCase: EvalCase; opaqueCaseId: string }[] = [];
  for (const evalCase of cases) {
    const opaqueCaseId = opaqueIdByCaseId.get(evalCase.id);
    if (opaqueCaseId === undefined) {
      console.log(`[materials] ${evalCase.id}: 採点対象に無いためスキップ`);
      continue;
    }
    targets.push({ evalCase, opaqueCaseId });
  }

  let failed = 0;
  for (const { evalCase, opaqueCaseId } of targets) {
    const dest = path.join(options.outDir, opaqueCaseId);
    const prepared = await prepareCaseMaterial(evalCase, []);
    if (!prepared.ok) {
      console.error(
        `[materials] ${evalCase.id} (${opaqueCaseId}): 材料を用意できません: ${prepared.reason}`,
      );
      failed += 1;
      continue;
    }
    try {
      // 作り直しのとき、前回あって今回は無いファイルが残ると、古い材料が混ざったまま
      // 採点者へ渡る。コピーの前に出力先ごと消す。
      await fs.rm(dest, { recursive: true, force: true });
      await fs.cp(prepared.material.cwd, dest, { recursive: true });
      console.log(`[materials] ${evalCase.id} → ${opaqueCaseId}`);
    } finally {
      await prepared.material.dispose();
    }
  }

  console.log(`[materials] 完了。${targets.length - failed}/${targets.length} 件を書き出した`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
