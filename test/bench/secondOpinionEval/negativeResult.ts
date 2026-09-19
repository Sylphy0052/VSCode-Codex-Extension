/**
 * `no-problem`（負例）の判定を記録する形と、そこから集計を導く規則（Issue #1295）。
 *
 * **読み始める前にこの形を固定する。** `screeningResult.ts` と同じ理由で、10件読んでから
 * 項目を足すと、先に読んだ案件だけを後知恵で見直す余地ができる。
 *
 * screening の記録とは別の形にしてある。screening は「primary な finding が成立したか」を
 * 記録するが、こちらが記録するのは「**機械的に決まった候補が、読んでも負例のままか**」で
 * ある。同じ `disposition` の語彙へ混ぜると、`no-relevant-finding`（正解ラベルにできる欠陥を
 * 作れなかった）と `no-problem`（重要な実装欠陥が無い）が区別できなくなる。この2つを混ぜる
 * ことこそ、この工程を別に作った理由そのものである。
 *
 * 記録は append-only の JSONL（`eval-results/negative-decisions-v1.jsonl`）に置く。
 */

/**
 * 読んだ結果、負例として確定したか。
 *
 * **読んで「問題が見つからなかった」は確定の理由にならない。** 確定の根拠は
 * `negativeOrder.ts` が機械的に確かめた2点（production を触らない / 後続が立っていない）で
 * あり、ここで見るのは「差分に実在する削除・書換が既存の検証を弱めていないか」だけである。
 */
export type NegativeDisposition =
  /** 負例として確定。削除行が無いか、あっても既存の検証を弱めていない。 */
  | 'no-problem'
  /** 既存の検証を弱める削除・書換があった。負例にはできない。 */
  | 'weakens-existing-check'
  /**
   * 機械的な前提が崩れていた（production のファイルを触っていた等）。
   *
   * 起きないはずだが、起きたときに黙って `weakens-existing-check` へ丸めると、規則の
   * 取りこぼしが「読んだ結果」として記録されてしまう。
   */
  | 'rule-mismatch';

export const NEGATIVE_DISPOSITIONS: readonly NegativeDisposition[] = [
  'no-problem',
  'weakens-existing-check',
  'rule-mismatch',
];

export interface NegativeCaseResult {
  /** `negative-order-v1.json` の `order` 上の位置（0始まり）。読んだ順の証跡になる。 */
  orderIndex: number;
  prNumber: number;
  /** 負例として確定したか。`disposition === 'no-problem'` と一致していること。 */
  confirmed: boolean;
  disposition: NegativeDisposition;
  /**
   * 差分に実在した削除・書換について、何を見て弱めていないと判断したか。
   *
   * 削除行が0の案件では「削除行が無い」と書く。**空文字は許さない。**
   */
  deletionReview: string;
  /** その判定にした理由。 */
  rationale: string;
}

export interface NegativeDecision extends NegativeCaseResult {
  type: 'decision';
}

/** 前の判定を置き換える。既存の行は消さずに追記する（`screeningResult.ts` と同じ契約）。 */
export interface NegativeSupersede extends NegativeCaseResult {
  type: 'supersede';
  /** 置き換える対象の行番号（JSONL の0始まり）。 */
  supersedes: number;
  /** 訂正の理由。 */
  reason: string;
}

export type NegativeEntry = NegativeDecision | NegativeSupersede;

/** 各案件について有効な判定を取り出す。同じPRに複数の行があれば**後の行が有効**。 */
export function effectiveNegativeResults(entries: readonly NegativeEntry[]): NegativeCaseResult[] {
  const byPr = new Map<number, NegativeCaseResult>();
  for (const entry of entries) {
    byPr.set(entry.prNumber, entry);
  }
  return [...byPr.values()].sort((a, b) => a.orderIndex - b.orderIndex);
}

export interface NegativeSummary {
  /** 読んだ案件の数。 */
  screenedCases: number;
  /** 負例として確定した案件の数。**必要数の判定はこれ。** */
  confirmedCases: number;
  /** 読んだが確定しなかった案件の数。 */
  rejectedCases: number;
  /** まだ読んでいない案件の数。**確定しなかった分と混ぜない。** */
  unreadCases: number;
  /** 確定しなかった理由の内訳（0件の種別も落とさない）。 */
  rejectedBreakdown: { disposition: NegativeDisposition; count: number }[];
}

const REJECTED_DISPOSITIONS: readonly NegativeDisposition[] = [
  'weakens-existing-check',
  'rule-mismatch',
];

/** 集計を記録から導く。手で数えると、途中で止めたときに未読が不確定へ紛れ込む。 */
export function summarizeNegative(
  entries: readonly NegativeEntry[],
  totalCases: number,
): NegativeSummary {
  const results = effectiveNegativeResults(entries);
  const confirmedCases = results.filter((result) => result.confirmed).length;
  return {
    screenedCases: results.length,
    confirmedCases,
    rejectedCases: results.length - confirmedCases,
    unreadCases: totalCases - results.length,
    rejectedBreakdown: REJECTED_DISPOSITIONS.map((disposition) => ({
      disposition,
      count: results.filter((result) => result.disposition === disposition).length,
    })),
  };
}

/** 判定が形として矛盾していないかを確かめる。 */
export function validateNegativeEntry(
  entry: NegativeEntry,
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
  if (entry.confirmed !== (entry.disposition === 'no-problem')) {
    problems.push(
      `confirmed=${String(entry.confirmed)} と disposition=${entry.disposition} が食い違います`,
    );
  }
  if (entry.deletionReview.trim() === '') {
    // 「読んだが何も書かなかった」を確定の根拠にできてしまうと、この層の意味が消える
    problems.push('deletionReview が空です');
  }
  if (entry.rationale.trim() === '') {
    problems.push('rationale が空です');
  }
  return problems;
}

/**
 * 手で書いたJSONを、型どおりかどうか確かめてから受け取る。
 *
 * `screeningResult.ts` と同じく、`as NegativeEntry` で受けない。typoが静かに通ると、集計には
 * 入るのに順序の確認からは外れる、という食い違いが起きる。
 */
export function parseNegativeEntry(value: unknown): NegativeEntry {
  const record = asRecord(value, '判定');
  const type = requireLiteral(record.type, ['decision', 'supersede'] as const, 'type');
  const base = {
    orderIndex: requireIndex(record.orderIndex, 'orderIndex'),
    prNumber: requirePositiveInteger(record.prNumber, 'prNumber'),
    confirmed: requireBoolean(record.confirmed, 'confirmed'),
    disposition: requireLiteral(record.disposition, NEGATIVE_DISPOSITIONS, 'disposition'),
    deletionReview: requireString(record.deletionReview, 'deletionReview'),
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

function requireLiteral<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${what} は ${allowed.join(' / ')} のいずれかである必要があります`);
  }
  return value as T;
}

export function parseNegativeDecisionsJsonl(text: string): NegativeEntry[] {
  return text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line !== '')
    .map((entry) => {
      try {
        return parseNegativeEntry(JSON.parse(entry.line));
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
 * 1件ずつの整合に加えて、**凍結した順の先頭から抜けなく読んでいるか**を見る。読みやすい
 * 案件だけ先に判定していれば、ここで落ちる。
 */
export function validateNegativeLog(
  entries: readonly NegativeEntry[],
  order: readonly { prNumber: number }[],
): string[] {
  const problems: string[] = [];
  for (const [index, entry] of entries.entries()) {
    for (const problem of validateNegativeEntry(entry, order)) {
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

/** 訂正が、その案件の**直前の有効な判定**を指しているかを見る。 */
function supersedeProblems(
  entry: NegativeSupersede,
  index: number,
  entries: readonly NegativeEntry[],
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
