/**
 * 本測定の24件を層化ランダム抽出する（Issue #1046 手順4）。
 *
 * `screeningOrder.ts` / `supplementalOrder.ts` と同じく、CLI（`selectCases.ts`）から純粋な
 * 部分だけを切り出してある。import しただけで抽出が走ると、凍結したファイルを別の入力から
 * 書き換えてしまうため。
 *
 * **層化は難易度の1軸だけで、内訳は抽出の前に固定する**（`docs/second-opinion-eval.md`）。
 * `kind` は属性として持つが層化には使わない。変更規模（`changeSizeStratum`）は層化の軸では
 * なく、抽出結果が特定のサイズ帯へ寄っていないかの確認にだけ使う。
 */

import { createHash } from 'node:crypto';

/** 層化の唯一の軸。件数の内訳は {@link STRATUM_QUOTAS} で先に決める。 */
export type DifficultyStratum =
  /** 見落としやすい重大問題を含む正例。recall の天井を作らないために要る。 */
  | 'hard-positive'
  /** 気づける程度の問題を含む正例。通常運用に近い状態を測る。 */
  | 'normal-positive'
  /** 重要な実装欠陥が無いと主張できる変更。`hallucinatedFindings` の分母になる。 */
  | 'no-problem'
  /** 材料だけでは判断しきれない変更。留保できるかと、決めつける癖を測る。 */
  | 'indeterminate';

export const DIFFICULTY_STRATA: readonly DifficultyStratum[] = [
  'hard-positive',
  'normal-positive',
  'no-problem',
  'indeterminate',
];

/** 正例の層。eligibility（`discoverable` かつ `explicitlyExposed` でない）を要求する。 */
export const POSITIVE_STRATA: ReadonlySet<DifficultyStratum> = new Set<DifficultyStratum>([
  'hard-positive',
  'normal-positive',
]);

/**
 * 層ごとの必要数。合計24件。
 *
 * **抽出を始める前に固定する。** 抜いてから内訳を決めると、供給の多い層へ寄せた結果を
 * 「そういう設計だった」と後から言えてしまう。
 */
export const STRATUM_QUOTAS: Readonly<Record<DifficultyStratum, number>> = {
  'hard-positive': 9,
  'normal-positive': 6,
  'no-problem': 6,
  indeterminate: 3,
};

export const SELECTION_TARGET_SIZE = 24;

/** 抽出の並べ替えseed。変えたら別の24件になるので、版と一緒に上げる。 */
export const SELECTION_SHUFFLE_SEED = 'primary-selection-v1:';

/** 変更規模の層。`samplingFrame.ts` が付ける値と同じ。 */
export type ChangeSizeStratum = 'S' | 'M' | 'L' | 'XL';

export const CHANGE_SIZE_STRATA: readonly ChangeSizeStratum[] = ['S', 'M', 'L', 'XL'];

/** 変更規模の層ごとの最低件数。層化ではなくバランス確認の弱い制約。 */
export const MIN_PER_CHANGE_SIZE_STRATUM = 3;

/** 変更行数がp90を超える案件（`extreme-tail`）の最低件数。 */
export const MIN_EXTREME_TAIL = 1;

export const EXTREME_TAIL_TAG = 'extreme-tail';

/**
 * 制約を満たす組み合わせが出るまでの試行回数の上限。
 *
 * 上限に達したら**seedを増やし続けずに止める**。満たすまで引き直せる設計にすると、
 * 「制約を満たした」ではなく「満たすまで回した」になる。止まったときは母集団か制約の
 * どちらかが無理なので、人が見直す。
 */
export const MAX_ATTEMPTS = 100;

/** 抽出の母集団に入れる1件。層の判断は人が screening の結果から決める。 */
export interface SelectionCandidate {
  caseId: string;
  prNumber: number;
  stratum: DifficultyStratum;
  /** 属性として持つだけで層化には使わない。結果に内訳を出すために要る。 */
  kind: string;
  changeSizeStratum: ChangeSizeStratum;
  /** `samplingFrame.ts` が付けた目印。`extreme-tail` の判定に使う。 */
  tags: string[];
}

/** 凍結済みの sampling frame から、照合に使う分だけ。 */
export interface FramePullRequest {
  prNumber: number;
  changeSizeStratum: ChangeSizeStratum | undefined;
  tags: string[];
  excludedBy: string | undefined;
}

/** 条件ごとの eligibility 判定（`eligibility.json` の1件）。 */
export interface EligibilityEntry {
  caseId: string;
  conditionId: string;
  discoverable: boolean;
  explicitlyExposed: boolean;
}

/** 並べ替えの鍵。caseId と seed だけで決まるので、入力の並び順によらず同じ順になる。 */
export function shuffleKeyOf(caseId: string, seed: string): string {
  return createHash('sha256').update(`${seed}${caseId}`).digest('hex');
}

/** 試行ごとのseed。attempt を混ぜるだけで、規則そのものは変えない。 */
export function seedForAttempt(attempt: number, seed: string = SELECTION_SHUFFLE_SEED): string {
  return `${seed}attempt${attempt}:`;
}

/** 鍵の昇順に並べる。 */
export function shuffledOrderOf(
  candidates: readonly SelectionCandidate[],
  seed: string,
): SelectionCandidate[] {
  return [...candidates]
    .map((candidate) => ({ candidate, key: shuffleKeyOf(candidate.caseId, seed) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.candidate);
}

/** 変更規模のバランス制約に対して、足りていないものを並べる。空なら制約を満たしている。 */
export function balanceShortfalls(selected: readonly SelectionCandidate[]): string[] {
  const shortfalls: string[] = [];
  for (const stratum of CHANGE_SIZE_STRATA) {
    const count = selected.filter((entry) => entry.changeSizeStratum === stratum).length;
    if (count < MIN_PER_CHANGE_SIZE_STRATUM) {
      shortfalls.push(`変更規模 ${stratum} が ${count} 件（最低 ${MIN_PER_CHANGE_SIZE_STRATUM}）`);
    }
  }
  const extremeTail = selected.filter((entry) => entry.tags.includes(EXTREME_TAIL_TAG)).length;
  if (extremeTail < MIN_EXTREME_TAIL) {
    shortfalls.push(`${EXTREME_TAIL_TAG} が ${extremeTail} 件（最低 ${MIN_EXTREME_TAIL}）`);
  }
  return shortfalls;
}

/**
 * 母集団が抽出できる形かを確かめる。
 *
 * caseId の重複と層ごとの不足で止める。**足りないまま抜いて「そろった」ことにしない。**
 */
export function verifyPool(candidates: readonly SelectionCandidate[]): void {
  // pool は人が書くJSONなので、既知の値だけが来るとは限らない。未知の層は
  // どの層にも入らないまま静かに落ちるか、内訳の集計を NaN にする。先に弾く。
  const unknown = candidates.flatMap((candidate) => {
    const problems: string[] = [];
    if (!DIFFICULTY_STRATA.includes(candidate.stratum)) {
      problems.push(
        `${candidate.caseId}: stratum が ${DIFFICULTY_STRATA.join(' / ')} のいずれでもありません（${String(candidate.stratum)}）`,
      );
    }
    if (!CHANGE_SIZE_STRATA.includes(candidate.changeSizeStratum)) {
      problems.push(
        `${candidate.caseId}: changeSizeStratum が ${CHANGE_SIZE_STRATA.join(' / ')} のいずれでもありません（${String(candidate.changeSizeStratum)}）`,
      );
    }
    return problems;
  });
  if (unknown.length > 0) {
    throw new Error(`pool に未知の値があります（${unknown.length} 件）: ${summarize(unknown)}`);
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.caseId)) {
      duplicates.add(candidate.caseId);
    }
    seen.add(candidate.caseId);
  }
  if (duplicates.size > 0) {
    throw new Error(`caseId が重複しています: ${[...duplicates].join(' ')}`);
  }
  const shortages = DIFFICULTY_STRATA.flatMap((stratum) => {
    const available = candidates.filter((candidate) => candidate.stratum === stratum).length;
    const quota = STRATUM_QUOTAS[stratum];
    return available < quota ? [`${stratum}: ${available} 件（必要 ${quota}）`] : [];
  });
  if (shortages.length > 0) {
    throw new Error(
      `層の候補が足りません。screening を読み進めてから抽出してください: ${shortages.join(' / ')}`,
    );
  }
}

/**
 * pool が申告した属性を、凍結済みの sampling frame と突き合わせる。
 *
 * **pool の自己申告を信じない。** ここを緩めると、`extreme-tail` の目印や変更規模の層を
 * 書き換えて、バランス制約を通したい組み合わせを作れてしまう。
 */
export function verifyAgainstFrame(
  candidates: readonly SelectionCandidate[],
  framePrs: readonly FramePullRequest[],
): void {
  const byNumber = new Map(framePrs.map((pr) => [pr.prNumber, pr]));
  const problems: string[] = [];
  for (const candidate of candidates) {
    const pr = byNumber.get(candidate.prNumber);
    if (pr === undefined) {
      problems.push(`${candidate.caseId}: #${candidate.prNumber} が sampling frame にありません`);
      continue;
    }
    if (pr.excludedBy !== undefined) {
      problems.push(
        `${candidate.caseId}: #${candidate.prNumber} は frame で ${pr.excludedBy} により除外済みです`,
      );
      continue;
    }
    if (pr.changeSizeStratum !== candidate.changeSizeStratum) {
      problems.push(
        `${candidate.caseId}: changeSizeStratum が frame と違います（frame: ${String(pr.changeSizeStratum)} / pool: ${candidate.changeSizeStratum}）`,
      );
    }
    const frameTags = [...pr.tags].sort().join(',');
    const poolTags = [...candidate.tags].sort().join(',');
    if (frameTags !== poolTags) {
      problems.push(
        `${candidate.caseId}: tags が frame と違います（frame: ${frameTags} / pool: ${poolTags}）`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `pool の属性が sampling frame と一致しません（${problems.length} 件）: ${summarize(problems)}`,
    );
  }
}

/** 食い違いが多いときに、先頭だけ出して残りは件数で示す。 */
function summarize(problems: readonly string[], limit = 10): string {
  const head = problems.slice(0, limit).join(' / ');
  return problems.length > limit ? `${head} ほか ${problems.length - limit} 件` : head;
}

/**
 * 正例が、その条件の eligibility を通っていることを確かめる。
 *
 * 判定の無い正例は**通ったものとして扱わない**。判定していないだけのものを分母へ入れると、
 * recall が「判定漏れの分だけ」下がる（Issue #1046）。
 *
 * ここで見るのは**案件として使えるか**なので、finding が複数あるときは1つでも通っていれば
 * 抽出の候補にする。finding 単位で分母から外すのは集計側（`recall.ts`）の仕事で、そちらは
 * 判定漏れも `unjudged` として数える。
 */
export function verifyPositivesEligible(
  candidates: readonly SelectionCandidate[],
  eligibility: readonly EligibilityEntry[],
  conditionId: string,
): void {
  const judged = new Map<string, EligibilityEntry[]>();
  for (const entry of eligibility) {
    if (entry.conditionId !== conditionId) {
      continue;
    }
    const list = judged.get(entry.caseId) ?? [];
    list.push(entry);
    judged.set(entry.caseId, list);
  }
  const problems: string[] = [];
  for (const candidate of candidates) {
    if (!POSITIVE_STRATA.has(candidate.stratum)) {
      continue;
    }
    const entries = judged.get(candidate.caseId);
    if (entries === undefined || entries.length === 0) {
      problems.push(`${candidate.caseId}: 条件 ${conditionId} の判定がありません`);
      continue;
    }
    if (!entries.some((entry) => entry.discoverable && !entry.explicitlyExposed)) {
      problems.push(
        `${candidate.caseId}: 条件 ${conditionId} で discoverable かつ explicitlyExposed でない finding がありません`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `正例が eligibility を通っていません（${problems.length} 件）: ${summarize(problems)}`,
    );
  }
}

export interface SelectionAttempt {
  attempt: number;
  seed: string;
  /** この試行で満たせなかった制約。空なら採用した試行。 */
  shortfalls: string[];
}

export interface SelectionResult {
  selected: SelectionCandidate[];
  /** 採用した試行の番号。0 でなければ、変更規模の制約で引き直している。 */
  acceptedAttempt: number;
  /** 採用したものを含む全試行。**落ちた試行も残す**（何回引いたかを隠さないため）。 */
  attempts: SelectionAttempt[];
  byStratum: Record<DifficultyStratum, number>;
  byChangeSize: Record<ChangeSizeStratum, number>;
  byKind: Record<string, number>;
  extremeTail: number;
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) {
    counts[value] += 1;
  }
  return counts;
}

/**
 * 層ごとに固定seedで並べ替え、先頭から必要数を抜く。
 *
 * 変更規模のバランス制約を満たさなければ、seed に試行番号を混ぜて引き直す。**引き直しは
 * 番号を1つずつ進めるだけで、途中で規則を変えない。** 試行の履歴は全部返すので、何回目で
 * 通ったかが後から見える。
 */
export function selectStratifiedSample(
  candidates: readonly SelectionCandidate[],
  options: { seed?: string; maxAttempts?: number } = {},
): SelectionResult {
  verifyPool(candidates);
  const seed = options.seed ?? SELECTION_SHUFFLE_SEED;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const attempts: SelectionAttempt[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const attemptSeed = seedForAttempt(attempt, seed);
    const selected = DIFFICULTY_STRATA.flatMap((stratum) =>
      shuffledOrderOf(
        candidates.filter((candidate) => candidate.stratum === stratum),
        attemptSeed,
      ).slice(0, STRATUM_QUOTAS[stratum]),
    );
    const shortfalls = balanceShortfalls(selected);
    attempts.push({ attempt, seed: attemptSeed, shortfalls });
    if (shortfalls.length > 0) {
      continue;
    }
    return {
      selected,
      acceptedAttempt: attempt,
      attempts,
      byStratum: countBy(
        selected.map((entry) => entry.stratum),
        DIFFICULTY_STRATA,
      ),
      byChangeSize: countBy(
        selected.map((entry) => entry.changeSizeStratum),
        CHANGE_SIZE_STRATA,
      ),
      byKind: selected.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
        return counts;
      }, {}),
      extremeTail: selected.filter((entry) => entry.tags.includes(EXTREME_TAIL_TAG)).length,
    };
  }

  const last = attempts[attempts.length - 1];
  throw new Error(
    `${maxAttempts} 回引いても変更規模のバランス制約を満たせませんでした（最後の不足: ${
      last === undefined ? 'なし' : last.shortfalls.join(' / ')
    }）。seed を足して引き直さず、母集団か制約を見直してください`,
  );
}
