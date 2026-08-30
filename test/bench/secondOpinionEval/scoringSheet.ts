/* eslint-disable no-console -- 生成結果を出すのがこのファイルの目的 */
/**
 * 採点シートの生成（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/scoringSheet.ts --results <結果ディレクトリ> --out <採点用ディレクトリ>
 * ```
 *
 * 結果ファイルには条件名（`A` / `B`）が入っている。そのまま採点すると、どちらが「新しい方」かが
 * 分かってしまう。ここでは条件名を伏せた採点用ファイルへ組み替え、提示順もシャッフルする
 * （Issue #1044 の実験条件「評価時は条件名を隠し、提示順をランダム化する」）。
 *
 * 対応表（採点id → 案件・条件）は別ファイルへ書く。採点が済むまで**開かないこと。**
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import type { EvalRunRecord } from './types';

/** 採点者へ見せるもの。条件名・モデル・latency・トークン量は入れない（先入観になる）。 */
interface ScoringItem {
  scoringId: string;
  caseId: string;
  caseKind: EvalRunRecord['caseKind'];
  response: string;
}

/** 採点が済んでから開く対応表。 */
interface ScoringKeyEntry {
  scoringId: string;
  caseId: string;
  conditionId: string;
  attempt: number;
}

function parseArgs(argv: readonly string[]): { resultsDir: string; outDir: string } {
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
  const outDir = values.get('out');
  if (resultsDir === undefined || outDir === undefined) {
    throw new Error('--results と --out は必須です');
  }
  return { resultsDir, outDir };
}

/**
 * Fisher-Yates。
 *
 * ソート関数へ乱数を渡す書き方（`sort(() => Math.random() - 0.5)`）は分布が偏るため使わない。
 * 条件の並びに偏りが残ると、採点順そのものが条件の手がかりになる。
 */
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = result[i];
    const b = result[j];
    if (a !== undefined && b !== undefined) {
      result[i] = b;
      result[j] = a;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const { resultsDir, outDir } = parseArgs(process.argv.slice(2));
  const names = (await fs.readdir(resultsDir)).filter((name) => name.endsWith('.json')).sort();
  if (names.length === 0) {
    throw new Error(`${resultsDir} に結果ファイル（*.json）がありません`);
  }

  const items: ScoringItem[] = [];
  const key: ScoringKeyEntry[] = [];
  let skipped = 0;
  for (const name of names) {
    const raw = await fs.readFile(path.join(resultsDir, name), 'utf8');
    const record = JSON.parse(raw) as EvalRunRecord;
    if (record.error !== undefined || record.response.trim() === '') {
      // 失敗した実行は採点しない。**黙って落とさず件数を出す**（採点対象が減っていることに
      // 気づかないまま「条件Bのほうが良い」と結論するのを防ぐ）
      skipped += 1;
      continue;
    }
    const scoringId = randomUUID();
    items.push({
      scoringId,
      caseId: record.caseId,
      caseKind: record.caseKind,
      response: record.response,
    });
    key.push({
      scoringId,
      caseId: record.caseId,
      conditionId: record.conditionId,
      attempt: record.attempt,
    });
  }

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'sheet.json'),
    `${JSON.stringify(shuffle(items), null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(outDir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, 'utf8');
  console.log(`[sheet] 採点対象 ${items.length} 件 / 失敗のため除外 ${skipped} 件`);
  console.log(`[sheet] ${path.join(outDir, 'sheet.json')} を採点する。`);
  console.log(`[sheet] ${path.join(outDir, 'key.json')} は採点が済むまで開かないこと。`);
}

main().catch((e: unknown) => {
  console.error(`[sheet] 失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
