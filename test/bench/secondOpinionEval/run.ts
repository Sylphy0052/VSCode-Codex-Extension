/* eslint-disable no-console -- 実行の進捗を出すのがこのファイルの目的 */
/**
 * セカンドオピニオンの精度測定ハーネスの入口（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/run.ts --cases <cases.json> --out <出力ディレクトリ>
 *   [--conditions A,B] [--attempts 1] [--model gpt-5.6-sol] [--effort high]
 * ```
 *
 * **実物の Codex CLI を呼ぶ。** 案件数 × 条件数 × 試行回数だけモデルへの往復が起き、そのぶんの
 * 時間と費用がかかる。20案件 × 2条件 × 1回で40往復になる。
 *
 * 結果は1実行1ファイル（`<出力先>/<案件id>__<条件id>__<試行番号>.json`）で書く。1つの巨大な
 * JSONへまとめないのは、途中で失敗しても既に終わった分が残るようにするためである。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { buildSecondOpinionPrompt } from '../../../src/secondOpinion/prompt';
import { runCodexTurn } from './codexTurn';
import { EVAL_CONDITIONS, findCondition } from './conditions';
import { prepareCaseMaterial } from './materials';
import type { EvalCase, EvalCondition, EvalRunRecord } from './types';

/** 既定のモデルとeffort。Advisor本体の既定（`DEFAULT_SECOND_OPINION_CANDIDATES`）と同じ。 */
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT = 'high';

interface Options {
  casesPath: string;
  outDir: string;
  conditions: EvalCondition[];
  attempts: number;
  model: string;
  effort: string;
}

function parseArgs(argv: readonly string[]): Options {
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
  const outDir = values.get('out');
  if (casesPath === undefined || outDir === undefined) {
    throw new Error('--cases と --out は必須です');
  }

  const requested = values.get('conditions');
  const conditions =
    requested === undefined
      ? [...EVAL_CONDITIONS]
      : requested.split(',').map((id) => {
          const condition = findCondition(id.trim());
          if (condition === undefined) {
            throw new Error(
              `未知の条件です: ${id}（実装済み: ${EVAL_CONDITIONS.map((c) => c.id).join(', ')}）`,
            );
          }
          return condition;
        });

  const attemptsRaw = values.get('attempts') ?? '1';
  const attempts = Number.parseInt(attemptsRaw, 10);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(`--attempts は1以上の整数である必要があります: ${attemptsRaw}`);
  }

  return {
    casesPath,
    outDir,
    conditions,
    attempts,
    model: values.get('model') ?? DEFAULT_MODEL,
    effort: values.get('effort') ?? DEFAULT_EFFORT,
  };
}

/**
 * 案件ファイルを読む。
 *
 * 形が違うものは黙って飛ばさず、その場で落とす。1件でも欠けたまま走ると、集計時に
 * 「その案件だけ条件Bが無い」という穴の開いた結果になり、原因の切り分けができない。
 */
async function loadCases(casesPath: string): Promise<EvalCase[]> {
  const raw = await fs.readFile(casesPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${casesPath} は案件の配列である必要があります`);
  }
  return parsed.map((entry, index) => validateCase(entry, index));
}

const CASE_KINDS: readonly EvalCase['kind'][] = [
  'codeReview',
  'designDecision',
  'rootCause',
  'choice',
];

function validateCase(entry: unknown, index: number): EvalCase {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${index}件目の案件がオブジェクトではありません`);
  }
  const record = entry as Record<string, unknown>;
  const requireString = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${index}件目の案件の ${key} が空でない文字列ではありません`);
    }
    return value;
  };
  const stringArray = (key: string): string[] => {
    const value = record[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`${index}件目の案件の ${key} が文字列の配列ではありません`);
    }
    return value as string[];
  };

  const kind = record['kind'];
  if (typeof kind !== 'string' || !CASE_KINDS.includes(kind as EvalCase['kind'])) {
    throw new Error(
      `${index}件目の案件の kind が ${CASE_KINDS.join(' / ')} のいずれでもありません: ${String(kind)}`,
    );
  }

  const conversation = record['conversation'];
  return {
    id: requireString('id'),
    kind: kind as EvalCase['kind'],
    repoPath: requireString('repoPath'),
    baseCommit: requireString('baseCommit'),
    userRequest: requireString('userRequest'),
    conversation: typeof conversation === 'string' ? conversation : '',
    ...(record['summarize'] === true ? { summarize: true } : {}),
    knownImportantFindings: stringArray('knownImportantFindings'),
    knownConstraints: stringArray('knownConstraints'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = await loadCases(options.casesPath);
  await fs.mkdir(options.outDir, { recursive: true });

  console.log(
    `[eval] 案件${cases.length}件 × 条件${options.conditions.length}件 × ${options.attempts}回 = ` +
      `${cases.length * options.conditions.length * options.attempts}往復`,
  );
  console.log(`[eval] model=${options.model} effort=${options.effort}`);
  console.log(`[eval] 案件の内訳: ${summarizeKinds(cases)}`);

  let failures = 0;
  for (const evalCase of cases) {
    const prepared = await prepareCaseMaterial(evalCase);
    if (!prepared.ok) {
      console.error(`[eval] ${evalCase.id}: 材料を作れませんでした: ${prepared.reason}`);
      failures += 1;
      continue;
    }
    const material = prepared.material;
    try {
      for (const condition of options.conditions) {
        for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
          const prompt = buildSecondOpinionPrompt(condition.apply(material.input));
          const label = `${evalCase.id} / ${condition.id} / ${attempt}`;
          console.log(`[eval] ${label}: 送信（${Buffer.byteLength(prompt, 'utf8')} bytes）`);
          const turn = await runCodexTurn({
            cwd: material.cwd,
            prompt,
            model: options.model,
            effort: options.effort,
          });
          const record: EvalRunRecord = {
            caseId: evalCase.id,
            caseKind: evalCase.kind,
            conditionId: condition.id,
            attempt,
            prompt,
            response: turn.response,
            latencyMs: turn.latencyMs,
            sessionTokens: turn.sessionTokens,
            contextUsage: turn.contextUsage,
            promptBytes: Buffer.byteLength(prompt, 'utf8'),
            model: options.model,
            effort: options.effort,
            baseCommit: material.baseCommit,
            ...(turn.error === undefined ? {} : { error: turn.error }),
          };
          const file = path.join(
            options.outDir,
            `${evalCase.id}__${condition.id}__${attempt}.json`,
          );
          await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
          if (turn.error === undefined) {
            console.log(`[eval] ${label}: ${turn.latencyMs}ms → ${path.basename(file)}`);
          } else {
            console.error(`[eval] ${label}: ${turn.error} → ${path.basename(file)}`);
            failures += 1;
          }
        }
      }
    } finally {
      await material.dispose();
    }
  }

  console.log(`[eval] 完了。失敗 ${failures} 件`);
  if (failures > 0) {
    // 失敗を含む結果を「走り切った」と読ませない。集計前に気づけるようにする
    process.exitCode = 1;
  }
}

function summarizeKinds(cases: readonly EvalCase[]): string {
  return CASE_KINDS.map((kind) => `${kind}=${cases.filter((c) => c.kind === kind).length}`).join(
    ' ',
  );
}

main().catch((e: unknown) => {
  console.error(`[eval] 実行に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
