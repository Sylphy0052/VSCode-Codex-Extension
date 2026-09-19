/* eslint-disable no-console -- 実行の進捗を出すのがこのファイルの目的 */
/**
 * セカンドオピニオンの精度測定ハーネスの入口（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/run.ts --cases <cases.json> --out <出力ディレクトリ>
 *   [--eligibility <eligibility.json>]
 *   [--conditions A,B-pos] [--attempts 2] [--model gpt-5.6-sol] [--effort high]
 * ```
 *
 * **本測定では `--eligibility` を必ず渡す。** recall の分母は案件ファイルの正解ラベルと、条件
 * ごとの判定（`eligibility.json`）の両方で決まる。案件ファイルだけを固定しても、回答を読んで
 * から判定を書き換えれば分母は動く。両方のハッシュを `manifest.json` へ残し、集計時に突き合わ
 * せる。
 *
 * **実物の Codex CLI を呼ぶ。** 案件数 × 条件数 × 試行回数だけモデルへの往復が起き、そのぶんの
 * 時間と費用がかかる。24案件 × 3条件 × 2回で144往復になる。
 *
 * 結果は1実行1ファイル（`<出力先>/<案件id>__<条件id>__<試行番号>.json`）で書く。1つの巨大な
 * JSONへまとめないのは、途中で失敗しても既に終わった分が残るようにするためである。runの素性は
 * `manifest.json` へ別に置く。
 *
 * **`--out` に `manifest.json` があるときは、その run の続きとして実行する（Issue #1310）。**
 * `runId` を引き継ぎ、成功済みの往復を飛ばす。案件ファイル・判定ファイル・モデル・条件・試行回数
 * のどれかが食い違えば、1件も実行せずに止まる。別の run を始めたいときは別のディレクトリを渡す。
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { nodeGitCommandRunner } from '../../../src/orchestrator/worktree';
import { buildSecondOpinionPrompt } from '../../../src/secondOpinion/prompt';
import { CASE_KINDS, loadCases } from './caseSchema';
import { runCodexTurn } from './codexTurn';
import { EVAL_CONDITIONS, findCondition } from './conditions';
import { prepareCaseMaterial } from './materials';
import type {
  EvalCase,
  EvalCondition,
  EvalRunManifest,
  EvalRunRecord,
  KnownFinding,
} from './types';

/** 既定のモデルとeffort。Advisor本体の既定（`DEFAULT_SECOND_OPINION_CANDIDATES`）と同じ。 */
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT = 'high';

/**
 * 既定の試行回数。
 *
 * 1回では、条件の差なのか同じ条件内のばらつきなのかを区別できない。プロンプトの並べ替え程度の
 * 介入は効果も小さいと見込まれるので、既定を2回にしてある。
 */
const DEFAULT_ATTEMPTS = 2;

interface Options {
  casesPath: string;
  /** 条件ごとの判定ファイル。本測定では必須（省くと分母を後から動かせる）。 */
  eligibilityPath: string | undefined;
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

  const attemptsRaw = values.get('attempts') ?? String(DEFAULT_ATTEMPTS);
  const attempts = Number.parseInt(attemptsRaw, 10);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(`--attempts は1以上の整数である必要があります: ${attemptsRaw}`);
  }

  return {
    casesPath,
    eligibilityPath: values.get('eligibility'),
    outDir,
    conditions,
    attempts,
    model: values.get('model') ?? DEFAULT_MODEL,
    effort: values.get('effort') ?? DEFAULT_EFFORT,
  };
}

/**
 * 条件の実行順を案件ごとにずらす。
 *
 * 全案件で同じ順に流すと、モデル側の一時的な調子（混雑・時刻・バックエンドの入れ替え）が
 * 特定の条件へ偏って乗る。先頭が常に条件Aなら、Aだけが「毎回いちばん最初に聞かれる」条件に
 * なってしまう。案件と試行の番号で回転させ、順序の効果を条件間で均す。
 */
function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) {
    return [];
  }
  const shift = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

async function readHarnessCommit(): Promise<string> {
  const result = await nodeGitCommandRunner.run(['rev-parse', 'HEAD'], process.cwd());
  return result.code === 0 ? result.stdout.trim() : 'unknown';
}

/** 1往復を指す鍵。結果ファイル名と同じ組み合わせで作る。 */
function resultKey(caseId: string, conditionId: string, attempt: number): string {
  return `${caseId}__${conditionId}__${attempt}`;
}

/**
 * 既にある `manifest.json` を読む。無ければ `undefined`。
 *
 * 読めない・壊れているときは投げる。「無い」と同じ扱いにして新しい run を始めると、既にある
 * 結果の上に別の `runId` の結果が積まれ、採点シート生成まで気づけない。
 */
async function readExistingManifest(outDir: string): Promise<EvalRunManifest | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
  return JSON.parse(raw) as EvalRunManifest;
}

/**
 * 再開してよい組み合わせかを確かめる。1つでも違えば投げる。
 *
 * 警告にして続けると、条件や正解ラベルが違う結果が同じ `runId` で1つのディレクトリへ混ざる。
 * 採点シートは `runId` だけを見るので、混ざったことは件数にも現れない。
 */
function assertResumable(existing: EvalRunManifest, current: EvalRunManifest): void {
  const mismatches: string[] = [];
  const compare = (label: string, before: unknown, after: unknown): void => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      mismatches.push(`${label}: 既存 ${JSON.stringify(before)} / 指定 ${JSON.stringify(after)}`);
    }
  };
  compare('casesSha256', existing.casesSha256, current.casesSha256);
  compare('eligibilitySha256', existing.eligibilitySha256, current.eligibilitySha256);
  compare('model', existing.model, current.model);
  compare('effort', existing.effort, current.effort);
  compare('conditionIds', [...existing.conditionIds].sort(), [...current.conditionIds].sort());
  compare('attempts', existing.attempts, current.attempts);
  compare('caseCount', existing.caseCount, current.caseCount);
  if (mismatches.length > 0) {
    throw new Error(
      `既にある manifest.json と指定が食い違うので再開できません（別の run なら別のディレクトリを使ってください）:\n  ${mismatches.join('\n  ')}`,
    );
  }
}

/** ある案件について、成功済みとして飛ばせる往復の件数を数える。 */
function countCompletedFor(
  completed: ReadonlySet<string>,
  caseId: string,
  conditions: readonly EvalCondition[],
  attempts: number,
): number {
  let count = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const condition of conditions) {
      if (completed.has(resultKey(caseId, condition.id, attempt))) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * 結果ディレクトリを走査し、**成功している**往復の鍵を集める。
 *
 * 失敗として残っている結果（`error` を持つ、または本文が空）は集めない。前回の失敗をそのまま
 * 成果へ持ち越すと、失敗した条件だけ件数が減ったまま採点へ進むことになる。
 */
async function collectCompleted(outDir: string, runId: string): Promise<Set<string>> {
  const completed = new Set<string>();
  let entries: string[];
  try {
    entries = await fs.readdir(outDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return completed;
    }
    throw e;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === 'manifest.json') {
      continue;
    }
    let record: EvalRunRecord;
    try {
      record = JSON.parse(await fs.readFile(path.join(outDir, entry), 'utf8')) as EvalRunRecord;
    } catch {
      // 壊れた結果は無かったことにして作り直す（上書きされるので残りもしない）
      continue;
    }
    if (record.runId !== runId || record.error !== undefined || record.response.trim() === '') {
      continue;
    }
    completed.add(resultKey(record.caseId, record.conditionId, record.attempt));
  }
  return completed;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { cases, sha256 } = await loadCases(options.casesPath);
  // 判定ファイルの中身はここでは使わない。実行前に確定していたことを示すハッシュだけ取る
  const eligibilitySha256 =
    options.eligibilityPath === undefined
      ? undefined
      : createHash('sha256')
          .update(await fs.readFile(options.eligibilityPath, 'utf8'))
          .digest('hex');
  if (eligibilitySha256 === undefined) {
    console.error(
      '[eval] --eligibility が指定されていません。recall の分母を後から動かせる状態なので、この run は本測定には使えません',
    );
  }
  await fs.mkdir(options.outDir, { recursive: true });

  const harnessCommit = await readHarnessCommit();
  const startedAt = new Date().toISOString();
  const fresh: EvalRunManifest = {
    runId: randomUUID(),
    harnessCommit,
    casesSha256: sha256,
    casesPath: path.resolve(options.casesPath),
    eligibilitySha256,
    eligibilityPath:
      options.eligibilityPath === undefined ? undefined : path.resolve(options.eligibilityPath),
    model: options.model,
    effort: options.effort,
    conditionIds: options.conditions.map((condition) => condition.id),
    attempts: options.attempts,
    caseCount: cases.length,
    startedAt,
  };
  const existing = await readExistingManifest(options.outDir);
  if (existing !== undefined) {
    assertResumable(existing, fresh);
  }
  const runId = existing?.runId ?? fresh.runId;

  // 成功済みの往復を先に数える。飛ばした件数を `manifest.json` へ残すため、実行前に確定させる
  const completed =
    existing === undefined ? new Set<string>() : await collectCompleted(options.outDir, runId);
  let skipped = 0;
  for (const evalCase of cases) {
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      for (const condition of options.conditions) {
        if (completed.has(resultKey(evalCase.id, condition.id, attempt))) {
          skipped += 1;
        }
      }
    }
  }

  const manifest: EvalRunManifest =
    existing === undefined
      ? fresh
      : {
          ...existing,
          resumes: [...(existing.resumes ?? []), { harnessCommit, startedAt, skipped }],
        };
  await fs.writeFile(
    path.join(options.outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const planned = cases.length * options.conditions.length * options.attempts;
  console.log(
    `[eval] 案件${cases.length}件 × 条件${options.conditions.length}件 × ${options.attempts}回 = ` +
      `${planned}往復`,
  );
  if (existing !== undefined) {
    console.log(
      `[eval] 再開。成功済み ${skipped} 件を飛ばし、残り ${planned - skipped} 件を実行する` +
        `（初回のハーネス: ${existing.harnessCommit} / 今回: ${harnessCommit}）`,
    );
  }
  console.log(`[eval] runId=${runId} model=${options.model} effort=${options.effort}`);
  console.log(`[eval] 案件の内訳: ${summarizeKinds(cases)}`);

  let failures = 0;
  for (const [caseIndex, evalCase] of cases.entries()) {
    // 全ての往復が成功済みなら材料も作らない。材料の準備は案件ごとにワークツリーを切るので、
    // 飛ばす案件のぶんだけ再開が遅くなる
    const remaining =
      options.conditions.length * options.attempts -
      countCompletedFor(completed, evalCase.id, options.conditions, options.attempts);
    if (remaining === 0) {
      console.log(
        `[eval] ${evalCase.id}: 全 ${options.conditions.length * options.attempts} 件が成功済み → 飛ばす`,
      );
      continue;
    }
    const prepared = await prepareCaseMaterial(evalCase, options.conditions);
    if (!prepared.ok) {
      console.error(`[eval] ${evalCase.id}: 材料を作れませんでした: ${prepared.reason}`);
      failures += 1;
      continue;
    }
    const material = prepared.material;
    try {
      // 材料は条件によって別のディレクトリになりうる（`after/` を持つのは条件C-repoだけ）。
      // 同じ内容を何度も報告しないよう、実際に使うディレクトリの重複を除いてから見る。
      // `cwdFor` は条件と材料が食い違えば投げるので、`finally` で片付く位置に置く
      const coverageSeen = new Set<string>();
      for (const condition of options.conditions) {
        const dir = material.cwdFor(condition);
        if (coverageSeen.has(dir)) {
          continue;
        }
        coverageSeen.add(dir);
        await reportEvidencePathCoverage(evalCase, dir, condition.id);
      }
      for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
        const ordered = rotate(options.conditions, caseIndex + attempt - 1);
        for (const [orderIndex, condition] of ordered.entries()) {
          const label = `${evalCase.id} / ${condition.id} / ${attempt}`;
          if (completed.has(resultKey(evalCase.id, condition.id, attempt))) {
            console.log(`[eval] ${label}: 成功済み → 飛ばす`);
            continue;
          }
          const prompt = buildSecondOpinionPrompt(condition.apply(material.input));
          console.log(`[eval] ${label}: 送信（${Buffer.byteLength(prompt, 'utf8')} bytes）`);
          const turn = await runCodexTurn({
            // 条件C-repoだけ `after/` を持つ別のbundleで開く（Issue #1047）
            cwd: material.cwdFor(condition),
            prompt,
            model: options.model,
            effort: options.effort,
          });
          const record: EvalRunRecord = {
            runId,
            caseId: evalCase.id,
            caseKind: evalCase.kind,
            conditionId: condition.id,
            attempt,
            conditionOrder: orderIndex + 1,
            prompt,
            response: turn.response,
            latencyMs: turn.latencyMs,
            sessionTokens: turn.sessionTokens,
            contextUsage: turn.contextUsage,
            promptBytes: Buffer.byteLength(prompt, 'utf8'),
            model: options.model,
            effort: options.effort,
            baseCommit: material.baseCommit,
            targetCommit: evalCase.targetCommit,
            knownImportantTotal: evalCase.knownImportantFindings.length,
            knownCriticalTotal: countSeverity(evalCase, 'critical'),
            knownWarningTotal: countSeverity(evalCase, 'warning'),
            bytesAfterRequest: measureBytesAfterRequest(prompt, evalCase.userRequest),
            toolCalls: turn.toolCalls,
            ...(turn.error === undefined ? {} : { error: turn.error }),
          };
          const file = path.join(
            options.outDir,
            `${evalCase.id}__${condition.id}__${attempt}.json`,
          );
          await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
          if (turn.error === undefined && turn.response.trim() === '') {
            // エラーは無いのに本文が空。プロトコルの読み方がずれている可能性があるので、
            // 成功として数えない（採点シートも空の回答は除外するが、そこまで気づかないと
            // 「なぜか件数が減った」だけが残る）
            console.error(`[eval] ${label}: 回答が空でした → ${path.basename(file)}`);
            failures += 1;
          } else if (turn.error === undefined) {
            console.log(
              `[eval] ${label}: ${turn.latencyMs}ms / ツール${turn.toolCalls.length}回 → ` +
                `${path.basename(file)}`,
            );
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

/**
 * `evidencePaths` のうち、bundle に見当たらないものを報告する（Issue #1046）。
 *
 * **これは判定ではない。実行も止めない。** 「パスが材料に入っている＝発見できる」ではないし、
 * その逆も成り立たない。条件Aでは after 側の内容が `base/` に無くても `changes.diff` の全量から
 * 再構成できることがあり、パスが入っていても必要な hunk がプロンプトから省かれていることもある。
 *
 * 発見可能性の判定は条件ごとに人が下し、`FindingEligibility` へ残す。ここが出すのはその判定の
 * 材料であって、代わりではない。自動で弾くと、再構成できる案件まで黙って落ちる。
 */
async function reportEvidencePathCoverage(
  evalCase: EvalCase,
  bundleDir: string,
  conditionId: string,
): Promise<void> {
  const wanted = new Set(evalCase.knownImportantFindings.flatMap((f) => f.evidencePaths));
  if (wanted.size === 0) {
    return;
  }
  const present = new Set(await listFilesRecursively(bundleDir, ''));
  // `base/<パス>` `after/<パス>` として置かれるので、bundle 内の相対パスからその接頭辞を
  // 外して突き合わせる
  const normalized = new Set([...present].map((p) => p.replace(/^(?:base|after)\//u, '')));
  const missing = [...wanted].filter((p) => !normalized.has(p));
  if (missing.length > 0) {
    console.log(
      `[eval] ${evalCase.id} / ${conditionId}: evidencePaths のうち bundle に見当たらないもの ` +
        `${missing.length} 件（発見可能性の判定材料。実行は止めない）: ${missing.join(', ')}`,
    );
  }
}

async function listFilesRecursively(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursively(root, relative)));
    } else {
      out.push(relative);
    }
  }
  return out;
}

function countSeverity(evalCase: EvalCase, severity: KnownFinding['severity']): number {
  return evalCase.knownImportantFindings.filter((finding) => finding.severity === severity).length;
}

/**
 * 依頼文が最後に現れた位置から、プロンプト末尾までのバイト数を測る。
 *
 * 条件 `B-pos` が効くとすれば、それは依頼から読み終わりまでの距離が縮むからである。その距離を
 * 実行記録へ残しておかないと、「効かなかった」のか「そもそも埋もれる距離ではなかった」のかを
 * 後から区別できない。
 *
 * 最後の出現を見るのは `B-repeat` のためである。この条件は依頼を冒頭に残したまま末尾へも
 * 再掲するので、最初の出現から測ると位置を変えていない条件Aと同じ値になってしまう。
 */
function measureBytesAfterRequest(prompt: string, userRequest: string): number | undefined {
  const needle = userRequest.trim();
  if (needle === '') {
    return undefined;
  }
  const at = prompt.lastIndexOf(needle);
  if (at < 0) {
    return undefined;
  }
  return Buffer.byteLength(prompt.slice(at + needle.length), 'utf8');
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
