/**
 * 案件ファイルの読み込みと検査（Issue #1044 / #1046）。
 *
 * `run.ts` から切り出してある。案件ファイルを組み立てる `caseFile.ts` が、書き出す前に
 * **実行するのと同じ検査**を通せるようにするためである。片方だけが通る形を作ると、組み立て
 * のときは緑で、実行しようとして初めて落ちることになる。`run.ts` は実行の入口として読み込む
 * だけで走り出すので、検査だけを使いたい側からは読み込めない。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

import type { EvalCase, KnownFinding } from './types';

/**
 * 案件ファイルを読む。
 *
 * 形が違うものは黙って飛ばさず、その場で落とす。1件でも欠けたまま走ると、集計時に
 * 「その案件だけ条件Bが無い」という穴の開いた結果になり、原因の切り分けができない。
 */
export async function loadCases(casesPath: string): Promise<{ cases: EvalCase[]; sha256: string }> {
  const raw = await fs.readFile(casesPath, 'utf8');
  return {
    cases: parseCases(raw, casesPath),
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

/**
 * 案件ファイルの中身を検査する。
 *
 * ファイルを読む前に呼べるようにしてあるのは、`caseFile.ts` が**書き出す前に**同じ検査を
 * 通せるようにするためである。書いてから検査すると、凍結したファイルが壊れた状態で残る。
 */
export function parseCases(raw: string, label: string): EvalCase[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} は案件の配列である必要があります`);
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

  return cases;
}

export const CASE_KINDS: readonly EvalCase['kind'][] = [
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
export const MAX_RECALL_CRITERIA = 4;

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
