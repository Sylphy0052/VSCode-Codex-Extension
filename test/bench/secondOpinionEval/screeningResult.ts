/**
 * screening の判定を記録する形と、そこから集計を導く規則（Issue #1046 手順3）。
 *
 * **読み始める前にこの形を固定する。** 10件読んでから項目を足すと、先に読んだ案件だけを
 * 後知恵で見直す余地ができる。
 *
 * 記録は append-only の JSONL（`eval-results/screening-decisions-v1.jsonl`）に置き、1件読み
 * 終えるたびに1行足す。既存の行は書き換えない。途中で止まっても、どこまで読んだかが行の
 * 並びで分かる。訂正するときも行を消さず、{@link ScreeningSupersede} を追記して、後の行が
 * 前の行を置き換えたことを残す。
 *
 * 集計は手で書かず、この記録から導く（{@link summarizeScreening}）。
 */

/** Issue #1046 の定義。上3つが primary で、recall の分母へ入れてよい。 */
export type GroundTruthBasis =
  | 'empirical'
  | 'independent-report'
  | 'independent-human'
  | 'model-derived'
  | 'retrospective'
  | 'mixed';

export const GROUND_TRUTH_BASES: readonly GroundTruthBasis[] = [
  'empirical',
  'independent-report',
  'independent-human',
  'model-derived',
  'retrospective',
  'mixed',
];

export const PRIMARY_BASES: readonly GroundTruthBasis[] = [
  'empirical',
  'independent-report',
  'independent-human',
];

export function isPrimaryBasis(basis: GroundTruthBasis): boolean {
  return PRIMARY_BASES.includes(basis);
}

export interface ScreeningFinding {
  /** 問題の内容。根本原因と観測できる症状で書く。 */
  finding: string;
  groundTruthBasis: GroundTruthBasis;
  /** その basis だと判断した具体的な根拠。「後続で直した」だけでは primary にしない。 */
  evidence: string;
  /** 後のラベル作成で参照する先（PR / Issue / テスト / コメント）。 */
  evidenceRefs: string[];
  /** `groundTruthBasis` が primary 3種かどうか。{@link isPrimaryBasis} と一致していること。 */
  primary: boolean;
}

/**
 * primary にならなかった理由。
 *
 * `primary / non-primary` の2値にすると、「AI由来しか無かった」「後続fixはあるが真だと確定
 * できなかった」「そもそも問題が見つからなかった」を後から区別できない。funnelを読むときに
 * 必要になるので分けて持つ。
 */
export type ScreeningDisposition =
  /** primary な finding が1つ以上ある。 */
  | 'primary'
  /** finding はあるが、根拠がAIレビューだけ。 */
  | 'model-derived-only'
  /** finding はあるが、後から自分でそう思っただけ。 */
  | 'retrospective-only'
  /** finding はあるが、根拠が複数種類にまたがる。 */
  | 'mixed-only'
  /**
   * 上のどれか1種類には収まらない非primary（`model-derived` と `retrospective` が混在する等）。
   *
   * `*-only` は「その種類だけ」の意味なので、種類が混ざる案件はどれにも当てはまらない。
   * 記録できない組み合わせを作らないために置く。
   */
  | 'other-non-primary'
  /** 問題の候補はあったが、真だと確定できる証拠が足りない。 */
  | 'insufficient-evidence'
  /** 読んだが、正解ラベルにできる問題そのものが無い。 */
  | 'no-relevant-finding';

export interface ScreeningCaseResult {
  /** `screening-order-v2.json` の `order` 上の位置（0始まり）。読んだ順の証跡になる。 */
  orderIndex: number;
  prNumber: number;
  /** primary な finding が1つ以上あるか。停止のカウントはこれを1件と数える。 */
  primaryCase: boolean;
  findings: ScreeningFinding[];
  disposition: ScreeningDisposition;
  /** その判定にした理由。`findings` が空でも理由を残す。 */
  rationale: string;
}

export interface ScreeningDecision extends ScreeningCaseResult {
  type: 'decision';
}

/**
 * 前の判定を置き換える。
 *
 * 既存の行を黙って書き換えると、いつ何を変えたかが残らない。行は消さずに追記する。
 */
export interface ScreeningSupersede extends ScreeningCaseResult {
  type: 'supersede';
  /** 置き換える対象の行番号（JSONL の0始まり）。 */
  supersedes: number;
  /** 訂正の理由。 */
  reason: string;
}

export type ScreeningEntry = ScreeningDecision | ScreeningSupersede;

/**
 * 各案件について有効な判定を取り出す。
 *
 * 同じPRに複数の行があれば、**後の行が有効**である。読んだ順は最初に判定した位置で数える。
 */
export function effectiveResults(entries: readonly ScreeningEntry[]): ScreeningCaseResult[] {
  const byPr = new Map<number, ScreeningCaseResult>();
  for (const entry of entries) {
    byPr.set(entry.prNumber, entry);
  }
  return [...byPr.values()].sort((a, b) => a.orderIndex - b.orderIndex);
}

export interface ScreeningSummary {
  /** 読んだ案件の数。 */
  screenedCases: number;
  /** primary な finding を1つ以上持つ案件の数。**停止判定はこれ。** */
  primaryCases: number;
  /** 読んだが primary が成立しなかった案件の数。 */
  nonPrimaryCases: number;
  /** まだ読んでいない案件の数。**不成立と混ぜない。** */
  unreadCases: number;
  /** 成立した finding の総数。記録のみで、停止判定には使わない。 */
  primaryFindings: number;
  /** 非primary の内訳。 */
  nonPrimaryBreakdown: { disposition: ScreeningDisposition; count: number }[];
}

export const SCREENING_DISPOSITIONS: readonly ScreeningDisposition[] = [
  'primary',
  'model-derived-only',
  'retrospective-only',
  'mixed-only',
  'other-non-primary',
  'insufficient-evidence',
  'no-relevant-finding',
];

const NON_PRIMARY_DISPOSITIONS: readonly ScreeningDisposition[] = [
  'model-derived-only',
  'retrospective-only',
  'mixed-only',
  'other-non-primary',
  'insufficient-evidence',
  'no-relevant-finding',
];

/**
 * 集計を記録から導く。
 *
 * 手で書いた数を持たない。読んだ件数・成立・不成立・未読を別々に出し、**未読を不成立へ
 * 混ぜない**。
 */
export function summarizeScreening(
  entries: readonly ScreeningEntry[],
  totalCases: number,
): ScreeningSummary {
  const results = effectiveResults(entries);
  const primaryCases = results.filter((result) => result.primaryCase).length;
  return {
    screenedCases: results.length,
    primaryCases,
    nonPrimaryCases: results.length - primaryCases,
    unreadCases: totalCases - results.length,
    primaryFindings: results.reduce(
      (total, result) => total + result.findings.filter((finding) => finding.primary).length,
      0,
    ),
    nonPrimaryBreakdown: NON_PRIMARY_DISPOSITIONS.map((disposition) => ({
      disposition,
      count: results.filter((result) => result.disposition === disposition).length,
    })),
  };
}

/**
 * 判定が形として矛盾していないかを確かめる。
 *
 * 人が手で書く記録なので、`primaryCase` と `findings` がずれると停止の判定が静かに狂う。
 */
export function validateScreeningEntry(
  entry: ScreeningEntry,
  order: readonly { prNumber: number }[],
): string[] {
  const problems: string[] = [];
  const expected = order[entry.orderIndex];
  if (expected === undefined) {
    problems.push(`orderIndex ${entry.orderIndex} は凍結した順序の範囲外です`);
  } else if (expected.prNumber !== entry.prNumber) {
    problems.push(
      `orderIndex ${entry.orderIndex} は #${expected.prNumber} ですが、#${entry.prNumber} と書かれています`,
    );
  }

  for (const [index, finding] of entry.findings.entries()) {
    if (finding.primary !== isPrimaryBasis(finding.groundTruthBasis)) {
      problems.push(
        `findings[${index}]: groundTruthBasis=${finding.groundTruthBasis} と primary=${String(finding.primary)} が食い違います`,
      );
    }
    if (finding.finding.trim() === '') {
      // 本文の無い finding を primary に数えると、後でラベルにできないものが停止条件を進める
      problems.push(`findings[${index}]: finding が空です`);
    }
    if (finding.evidenceRefs.some((ref) => ref.trim() === '')) {
      problems.push(`findings[${index}]: evidenceRefs に空の参照があります`);
    }
    if (finding.evidence.trim() === '') {
      // 根拠の無い finding を分母へ入れると、後から思いついた分だけ分母が動く
      problems.push(`findings[${index}]: evidence が空です`);
    }
    if (finding.primary && finding.evidenceRefs.length === 0) {
      problems.push(`findings[${index}]: primary なのに evidenceRefs が空です`);
    }
  }

  const hasPrimary = entry.findings.some((finding) => finding.primary);
  if (entry.primaryCase !== hasPrimary) {
    problems.push(
      `primaryCase=${String(entry.primaryCase)} ですが、primary な finding は ${hasPrimary ? 'あります' : 'ありません'}`,
    );
  }
  if ((entry.disposition === 'primary') !== hasPrimary) {
    problems.push(`disposition=${entry.disposition} と primary な finding の有無が食い違います`);
  }
  if (entry.rationale.trim() === '') {
    problems.push('rationale が空です');
  }

  problems.push(...dispositionProblems(entry, hasPrimary));
  return problems;
}

/** 非primary の `disposition` が、実際の finding の中身と合っているかを見る。 */
function dispositionProblems(entry: ScreeningEntry, hasPrimary: boolean): string[] {
  if (hasPrimary) {
    return [];
  }
  const bases = new Set(entry.findings.map((finding) => finding.groundTruthBasis));
  const emptyDispositions: ScreeningDisposition[] = [
    'insufficient-evidence',
    'no-relevant-finding',
  ];
  if (entry.findings.length === 0) {
    return emptyDispositions.includes(entry.disposition)
      ? []
      : [`finding が無いので disposition は ${emptyDispositions.join(' か ')} のはずです`];
  }
  if (emptyDispositions.includes(entry.disposition)) {
    return [
      `disposition=${entry.disposition} ですが、finding が ${entry.findings.length} 件あります`,
    ];
  }

  const onlyOf: Record<string, ScreeningDisposition> = {
    'model-derived': 'model-derived-only',
    retrospective: 'retrospective-only',
    mixed: 'mixed-only',
  };
  const soleBasis = bases.size === 1 ? [...bases][0] : undefined;
  const expected =
    soleBasis === undefined ? 'other-non-primary' : (onlyOf[soleBasis] ?? 'other-non-primary');
  return entry.disposition === expected
    ? []
    : [`disposition は ${expected} のはずです（実際の basis: ${[...bases].join(', ')}）`];
}

/**
 * 手で書いたJSONを、型どおりかどうか確かめてから受け取る。
 *
 * **TypeScriptの型をvalidationの代わりにしない。** `as ScreeningEntry` で受けると、
 * `"type": "decison"` のようなtypeoが静かに通り、集計には入るのに順序の確認からは外れる、
 * という食い違いが起きる。外から来たJSONは境界で全部見る。
 */
export function parseScreeningEntry(value: unknown): ScreeningEntry {
  const record = asRecord(value, '判定');
  const type = requireLiteral(record.type, ['decision', 'supersede'] as const, 'type');
  const base = {
    orderIndex: requireIndex(record.orderIndex, 'orderIndex'),
    prNumber: requirePositiveInteger(record.prNumber, 'prNumber'),
    primaryCase: requireBoolean(record.primaryCase, 'primaryCase'),
    findings: requireArray(record.findings, 'findings').map((finding, index) =>
      parseFinding(finding, index),
    ),
    disposition: requireLiteral(record.disposition, SCREENING_DISPOSITIONS, 'disposition'),
    rationale: requireString(record.rationale, 'rationale'),
  };
  if (type === 'decision') {
    return { type, ...base };
  }
  return {
    type,
    ...base,
    supersedes: requireIndex(record.supersedes, 'supersedes'),
    reason: requireString(record.reason, 'reason'),
  };
}

function parseFinding(value: unknown, index: number): ScreeningFinding {
  const record = asRecord(value, `findings[${index}]`);
  return {
    finding: requireString(record.finding, `findings[${index}].finding`),
    groundTruthBasis: requireLiteral(
      record.groundTruthBasis,
      GROUND_TRUTH_BASES,
      `findings[${index}].groundTruthBasis`,
    ),
    evidence: requireString(record.evidence, `findings[${index}].evidence`),
    evidenceRefs: requireArray(record.evidenceRefs, `findings[${index}].evidenceRefs`).map(
      (ref, refIndex) => requireString(ref, `findings[${index}].evidenceRefs[${refIndex}]`),
    ),
    primary: requireBoolean(record.primary, `findings[${index}].primary`),
  };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} がオブジェクトではありません`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${what} が文字列ではありません`);
  }
  return value;
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${what} が真偽値ではありません`);
  }
  return value;
}

function requireIndex(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} が0以上の整数ではありません`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what} が正の整数ではありません`);
  }
  return value;
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} が配列ではありません`);
  }
  return value;
}

function requireLiteral<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${what} は ${allowed.join(' / ')} のいずれかである必要があります`);
  }
  return value as T;
}

export function parseDecisionsJsonl(text: string): ScreeningEntry[] {
  return text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line !== '')
    .map((entry) => {
      try {
        return parseScreeningEntry(JSON.parse(entry.line));
      } catch (error) {
        throw new Error(
          `${entry.index + 1} 行目が読めません: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

/**
 * 記録全体の整合を確かめる。
 *
 * 1件ずつの整合（{@link validateScreeningEntry}）に加えて、**凍結した順の先頭から抜けなく
 * 読んでいるか**を見る。読みやすい案件だけ先に判定していれば、ここで落ちる。
 */
export function validateScreeningLog(
  entries: readonly ScreeningEntry[],
  order: readonly { prNumber: number }[],
): string[] {
  const problems: string[] = [];
  for (const [index, entry] of entries.entries()) {
    for (const problem of validateScreeningEntry(entry, order)) {
      problems.push(`${index + 1} 行目: ${problem}`);
    }
    if (entry.type === 'supersede') {
      problems.push(...supersedeProblems(entry, index, entries));
    }
  }

  const readIndexes = entries
    .filter((entry) => entry.type === 'decision')
    .map((entry) => entry.orderIndex);
  for (const [position, orderIndex] of readIndexes.entries()) {
    if (orderIndex !== position) {
      problems.push(
        `${position + 1} 件目の判定が凍結した順の ${orderIndex} 番目です。順を飛ばさずに読んでください`,
      );
      break;
    }
  }
  return problems;
}

/**
 * 訂正が、その案件の**直前の有効な判定**を指しているかを見る。
 *
 * 自分自身や未来の行を指せると、訂正の履歴が一本につながらず、いつ何をなぜ変えたかを
 * 追えなくなる。append-onlyにする意味が消えるので、ここで落とす。
 */
function supersedeProblems(
  entry: ScreeningSupersede,
  index: number,
  entries: readonly ScreeningEntry[],
): string[] {
  const where = `${index + 1} 行目`;
  if (entry.supersedes >= index) {
    return [`${where}: supersedes ${entry.supersedes} が自分自身か後の行を指しています`];
  }
  const problems: string[] = [];
  const target = entries[entry.supersedes];
  if (target === undefined) {
    problems.push(`${where}: supersedes ${entry.supersedes} は範囲外です`);
  } else if (target.prNumber !== entry.prNumber) {
    problems.push(
      `${where}: supersedes の指す行は #${target.prNumber} で、#${entry.prNumber} と違います`,
    );
  } else {
    const latest = entries
      .slice(0, index)
      .reduce<number | undefined>(
        (found, candidate, candidateIndex) =>
          candidate.prNumber === entry.prNumber ? candidateIndex : found,
        undefined,
      );
    if (latest !== entry.supersedes) {
      problems.push(
        `${where}: #${entry.prNumber} の直前の判定は ${(latest ?? 0) + 1} 行目です。訂正は直前の判定を置き換えてください`,
      );
    }
  }
  if (entry.reason.trim() === '') {
    problems.push(`${where}: reason が空です`);
  }
  return problems;
}
