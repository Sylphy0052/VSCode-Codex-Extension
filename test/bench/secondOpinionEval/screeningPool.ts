/**
 * 読む対象の選び方と並べ替えの鍵（Issue #1046 手順3）。
 *
 * `screeningOrder.ts` / `supplementalOrder.ts` はどちらも import 時に `main()` を呼ぶCLIなので、
 * そこから関数を輸入すると相手のCLIまで走ってしまう（実際に追加poolの生成で、強い証拠側の
 * 出力を追加poolのパスへ書いてしまった）。共有する純粋な部分はこのファイルへ置く。
 */

import { createHash } from 'node:crypto';

import { type EvidenceChannel, type EvidenceCandidates } from './evidenceChannels';

/** 強い証拠の側の並べ替えseed。変えたら別の順序になるので、版と一緒に上げる。 */
export const STRONG_SHUFFLE_SEED = 'ground-truth-screen-v1:';

/**
 * 強い証拠の系統を持つ案件を選ぶ。
 *
 * `follow-up-test` は「後続のfix PRがテストを触っている」、`openedAfterMerge` は「マージ後に
 * 立ったIssueがこのPRを参照している」で、どちらも実験や独立した報告へつながりうる。
 *
 * **これは415件から得られるprimary ground truthの全体ではない。** account review / comment
 * しか持たない案件にも `independent-human` になりうるものが残っている。ここで作るのは
 * あくまで、強い証拠を持つ部分集合から作ったpoolである。足りなければ探索範囲を広げる。
 */
export function hasStrongEvidence(candidate: EvidenceCandidates): boolean {
  return (
    candidate.channels.includes('follow-up-test') ||
    candidate.followUpIssues.some((issue) => issue.openedAfterMerge)
  );
}

/** 並べ替えの鍵。PR番号とseedだけで決まるので、何度実行しても同じ順になる。 */
export function shuffleKeyOf(prNumber: number, seed: string = STRONG_SHUFFLE_SEED): string {
  return createHash('sha256').update(`${seed}${prNumber}`).digest('hex');
}

/** 鍵の昇順に並べる。同じ入力からは、入力の並び順によらず同じ順を返す。 */
export function shuffledOrderOf(
  candidates: readonly EvidenceCandidates[],
  seed: string,
): { prNumber: number; shuffleKey: string }[] {
  return candidates
    .map((candidate) => ({
      prNumber: candidate.prNumber,
      shuffleKey: shuffleKeyOf(candidate.prNumber, seed),
    }))
    .sort((a, b) => (a.shuffleKey < b.shuffleKey ? -1 : a.shuffleKey > b.shuffleKey ? 1 : 0));
}

/** 強い証拠を持つ案件を、凍結した規則の順に並べる。 */
export function screeningOrderOf(
  candidates: readonly EvidenceCandidates[],
  seed: string = STRONG_SHUFFLE_SEED,
): { prNumber: number; shuffleKey: string }[] {
  return shuffledOrderOf(candidates.filter(hasStrongEvidence), seed);
}

/** 追加poolの並べ替えseed。強い証拠の側とは別にする（同じ順序の焼き直しにしないため）。 */
export const SUPPLEMENTAL_SHUFFLE_SEED = 'ground-truth-supplemental-v1:';

/**
 * 追加poolへ入れる系統。
 *
 * 手順2が機械的に付けた channel だけで決める。`follow-up-test` と `openedAfterMerge` な
 * follow-up issue は強い証拠の側にあるので、ここには `hasStrongEvidence` が偽の案件しか
 * 来ない。中身を読んで入れる・外すは決めない。
 */
export const SUPPLEMENTAL_CHANNELS: readonly EvidenceChannel[] = [
  'follow-up-fix',
  'account-review',
  'account-comment',
  'closing-issue',
];

/** 追加poolに入るか。強い証拠を持たず、追加の系統のどれかを持つ案件。 */
export function isSupplementalCandidate(candidate: EvidenceCandidates): boolean {
  if (hasStrongEvidence(candidate)) {
    return false;
  }
  return candidate.channels.some((channel) => SUPPLEMENTAL_CHANNELS.includes(channel));
}

/** 追加poolの案件を、凍結した規則の順に並べる。tierは付けない。 */
export function supplementalOrderOf(
  candidates: readonly EvidenceCandidates[],
  seed: string = SUPPLEMENTAL_SHUFFLE_SEED,
): { prNumber: number; shuffleKey: string }[] {
  return shuffledOrderOf(candidates.filter(isSupplementalCandidate), seed);
}

/**
 * 2つのpoolが1件も重ならないことを確かめる。
 *
 * 重なると、同じ案件が2つのpoolの分母へ二重に入る。fail-closedで止める。
 */
export function verifyDisjoint(
  supplemental: readonly { prNumber: number }[],
  strong: readonly { prNumber: number }[],
): void {
  const strongSet = new Set(strong.map((entry) => entry.prNumber));
  const overlap = supplemental.filter((entry) => strongSet.has(entry.prNumber));
  if (overlap.length > 0) {
    throw new Error(
      `追加poolが強い証拠のpoolと重なっています（${overlap.length} 件）: ${overlap
        .slice(0, 10)
        .map((entry) => `#${entry.prNumber}`)
        .join(' ')}`,
    );
  }
}
