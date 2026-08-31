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
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

import { nodeGitCommandRunner } from '../../../src/orchestrator/worktree';
import { buildSecondOpinionPrompt } from '../../../src/secondOpinion/prompt';
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
 * 案件ファイルを読む。
 *
 * 形が違うものは黙って飛ばさず、その場で落とす。1件でも欠けたまま走ると、集計時に
 * 「その案件だけ条件Bが無い」という穴の開いた結果になり、原因の切り分けができない。
 */
async function loadCases(casesPath: string): Promise<{ cases: EvalCase[]; sha256: string }> {
  const raw = await fs.readFile(casesPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${casesPath} は案件の配列である必要があります`);
  }
  const cases = parsed.map((entry, index) => validateCase(entry, index));

  // idが重複していると結果ファイル名が衝突し、後から書いた方が前を上書きする。件数だけが
  // 静かに減るので、読み込みの時点で落とす
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) {
      throw new Error(`案件idが重複しています: ${evalCase.id}`);
    }
    seen.add(evalCase.id);
  }

  return { cases, sha256: createHash('sha256').update(raw).digest('hex') };
}

const CASE_KINDS: readonly EvalCase['kind'][] = [
  'codeReview',
  'designDecision',
  'rootCause',
  'choice',
];

/**
 * 1つの正解ラベルに書ける判定条件の上限。
 *
 * 割りすぎると「全部言い当てろ」になり、同じ問題を別の言葉で指摘した回答を落とす。最小の
 * 因果鎖（発生条件・破れる性質・影響範囲）を書けば足りるので、その分だけに制限する。
 */
const MAX_RECALL_CRITERIA = 4;

const PROVENANCES: readonly KnownFinding['provenance'][] = [
  'test',
  'measured',
  'issue',
  'review',
  'retrospective',
];

const GROUND_TRUTH_BASES: readonly KnownFinding['groundTruthBasis'][] = [
  'empirical',
  'independent-report',
  'independent-human',
  'model-derived',
  'retrospective',
  'mixed',
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

  const conversationKind = record['conversationKind'];
  if (conversationKind !== 'summary' && conversationKind !== 'transcript') {
    throw new Error(
      `${index}件目の案件の conversationKind が summary / transcript のいずれでもありません: ${String(conversationKind)}`,
    );
  }

  const conversation = record['conversation'];
  return {
    id: requireString('id'),
    kind: kind as EvalCase['kind'],
    repoPath: requireString('repoPath'),
    baseCommit: requireString('baseCommit'),
    targetCommit: requireString('targetCommit'),
    userRequest: requireString('userRequest'),
    conversation: typeof conversation === 'string' ? conversation : '',
    conversationKind,
    knownImportantFindings: validateKnownFindings(record['knownImportantFindings'], index),
    knownConstraints: stringArray('knownConstraints'),
  };
}

/**
 * 正解ラベルを検査する。
 *
 * 文字列の配列を受け付けない。根拠のない項目をrecallの分母へ入れると、後から思いついた分だけ
 * 分母が動き、条件間の比較が成立しなくなる（Issue #1044）。
 */
function validateKnownFindings(value: unknown, index: number): KnownFinding[] {
  if (!Array.isArray(value)) {
    throw new Error(`${index}件目の案件の knownImportantFindings が配列ではありません`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `${index}件目の案件の knownImportantFindings[${i}] がオブジェクトではありません`,
      );
    }
    const record = entry as Record<string, unknown>;
    const finding = record['finding'];
    const recallCriteria = record['recallCriteria'];
    const evidence = record['evidence'];
    const severity = record['severity'];
    const provenance = record['provenance'];
    const groundTruthBasis = record['groundTruthBasis'];
    const evidencePaths = record['evidencePaths'];
    if (typeof finding !== 'string' || finding.trim() === '') {
      throw new Error(`${index}件目の knownImportantFindings[${i}].finding が空です`);
    }
    if (
      !Array.isArray(recallCriteria) ||
      recallCriteria.length === 0 ||
      recallCriteria.some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new Error(
        `${index}件目の knownImportantFindings[${i}].recallCriteria が空でない文字列の配列ではありません（拾ったと数える条件を実験の前に固定する）`,
      );
    }
    if (recallCriteria.length > MAX_RECALL_CRITERIA) {
      // 条件を細かく割りすぎると、1つの正解ラベルが実質「全部言い当てろ」になり、言い換えを
      // 落とす方向へ倒れる。割るのは最小の因果鎖の分だけにする
      throw new Error(
        `${index}件目の knownImportantFindings[${i}].recallCriteria が ${MAX_RECALL_CRITERIA} 件を超えています（最小の因果鎖の分だけに割る）`,
      );
    }
    if (typeof evidence !== 'string' || evidence.trim() === '') {
      throw new Error(
        `${index}件目の knownImportantFindings[${i}].evidence が空です（根拠のない項目はrecallの分母へ入れない）`,
      );
    }
    if (severity !== 'critical' && severity !== 'warning') {
      throw new Error(`${index}件目の knownImportantFindings[${i}].severity が不正です`);
    }
    if (
      typeof provenance !== 'string' ||
      !PROVENANCES.includes(provenance as KnownFinding['provenance'])
    ) {
      throw new Error(
        `${index}件目の knownImportantFindings[${i}].provenance が ${PROVENANCES.join(' / ')} のいずれでもありません`,
      );
    }
    if (
      typeof groundTruthBasis !== 'string' ||
      !GROUND_TRUTH_BASES.includes(groundTruthBasis as KnownFinding['groundTruthBasis'])
    ) {
      // 記録場所（provenance）ではなく「何で真だと確定したか」で recall の分母を決める。
      // ここを省けるようにすると、モデル自身のレビューを正解にした案件が黙って混ざる
      throw new Error(
        `${index}件目の knownImportantFindings[${i}].groundTruthBasis が ${GROUND_TRUTH_BASES.join(' / ')} のいずれでもありません`,
      );
    }
    if (
      !Array.isArray(evidencePaths) ||
      evidencePaths.some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new Error(
        `${index}件目の knownImportantFindings[${i}].evidencePaths が文字列の配列ではありません（発見に何が要るかを実験の前に書く）`,
      );
    }
    return {
      finding,
      recallCriteria: recallCriteria as string[],
      evidence,
      severity,
      provenance: provenance as KnownFinding['provenance'],
      groundTruthBasis: groundTruthBasis as KnownFinding['groundTruthBasis'],
      evidencePaths: evidencePaths as string[],
    };
  });
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

  const runId = randomUUID();
  const manifest: EvalRunManifest = {
    runId,
    harnessCommit: await readHarnessCommit(),
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
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(options.outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  console.log(
    `[eval] 案件${cases.length}件 × 条件${options.conditions.length}件 × ${options.attempts}回 = ` +
      `${cases.length * options.conditions.length * options.attempts}往復`,
  );
  console.log(`[eval] runId=${runId} model=${options.model} effort=${options.effort}`);
  console.log(`[eval] 案件の内訳: ${summarizeKinds(cases)}`);

  let failures = 0;
  for (const [caseIndex, evalCase] of cases.entries()) {
    const prepared = await prepareCaseMaterial(evalCase, options.conditions);
    if (!prepared.ok) {
      console.error(`[eval] ${evalCase.id}: 材料を作れませんでした: ${prepared.reason}`);
      failures += 1;
      continue;
    }
    const material = prepared.material;
    // 材料は条件によって別のディレクトリになりうる（`after/` を持つのは条件C-repoだけ）。
    // 同じ内容を何度も報告しないよう、実際に使うディレクトリの重複を除いてから見る
    const coverageSeen = new Set<string>();
    for (const condition of options.conditions) {
      const dir = material.cwdFor(condition);
      if (coverageSeen.has(dir)) {
        continue;
      }
      coverageSeen.add(dir);
      await reportEvidencePathCoverage(evalCase, dir, condition.id);
    }
    try {
      for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
        const ordered = rotate(options.conditions, caseIndex + attempt - 1);
        for (const [orderIndex, condition] of ordered.entries()) {
          const prompt = buildSecondOpinionPrompt(condition.apply(material.input));
          const label = `${evalCase.id} / ${condition.id} / ${attempt}`;
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
