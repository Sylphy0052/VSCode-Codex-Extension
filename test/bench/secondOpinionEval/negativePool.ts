/**
 * `no-problem` と `indeterminate` の候補集合の決め方（Issue #1295）。
 *
 * `negativeOrder.ts` / `indeterminateOrder.ts` はどちらも import 時に `main()` を呼ぶCLIなので、
 * 共有する純粋な部分はこちらへ置く（`screeningPool.ts` と同じ理由）。
 *
 * **証拠channelの読み方ではなく、sampling frame 側の機械的な性質で決める。** screening の
 * `disposition` からこの2層は作れない。`no-relevant-finding` は「正解ラベルにできる欠陥を
 * 作れなかった」であって「重要な問題が無い」ではなく、そのまま負例にすると
 * `hallucinatedFindings` の分母が壊れる。
 */

import { type EvidenceCandidates } from './evidenceChannels';
import { shuffleKeyOf } from './screeningPool';

/** `no-problem` の並べ替えseed。他のpoolと別にする（同じ順序の焼き直しにしないため）。 */
export const NEGATIVE_SHUFFLE_SEED = 'ground-truth-negative-v1:';

/** `indeterminate` の並べ替えseed。 */
export const INDETERMINATE_SHUFFLE_SEED = 'ground-truth-indeterminate-v1:';

/** `samplingFrame.ts` の除外規則と同じ判定。文書の変更は production の振る舞いを変えない。 */
export function isDocsPath(file: string): boolean {
  return file.startsWith('docs/') || file.endsWith('.md');
}

/** 文書以外の変更ファイル。負例の根拠は、この集合の性質だけで決める。 */
export function nonDocsFilesOf(files: readonly string[]): string[] {
  return files.filter((file) => !isDocsPath(file));
}

/**
 * production のコードを1行も触らない変更か。
 *
 * これが `no-problem` の1つめの根拠になる。「読んだが問題が見つからなかった」という不在の
 * 証明ではなく、**差分そのものが根拠**である。production を触らない以上、production の
 * 振る舞いを壊す欠陥は構造上あり得ない。
 *
 * frame の `test-only` タグとは判定が違う。タグは docs を含む全変更ファイルが `test/` 配下で
 * あることを要求するが、ここでは文書の変更を無視する（実測で 9件 → 20件 になる）。
 */
export function touchesTestsOnly(files: readonly string[]): boolean {
  const nonDocs = nonDocsFilesOf(files);
  return nonDocs.length > 0 && nonDocs.every((file) => file.startsWith('test/'));
}

/**
 * マージ後に、このPRを参照する後続PRも後続Issueも立っていないか。
 *
 * これが `no-problem` の2つめの根拠（事後の裏づけ）になる。単独では弱いが、
 * {@link touchesTestsOnly} と合わせて「重要な実装欠陥が無い」を積極的に主張する。
 *
 * マージ前から存在するIssueが後で言及されただけのものは、このPRを受けた報告ではないので
 * `openedAfterMerge` で絞る（手順2と同じ読み方）。
 */
export function hasNoFollowUp(candidate: EvidenceCandidates): boolean {
  return (
    candidate.followUpPrs.length === 0 &&
    !candidate.followUpIssues.some((issue) => issue.openedAfterMerge)
  );
}

/** 鍵の昇順に並べる。PR番号とseedだけで決まるので、入力の並び順によらず同じ順になる。 */
export function orderByShuffleKey<T extends { prNumber: number }>(
  entries: readonly T[],
  seed: string,
): (T & { shuffleKey: string })[] {
  return entries
    .map((entry) => ({ ...entry, shuffleKey: shuffleKeyOf(entry.prNumber, seed) }))
    .sort((a, b) => (a.shuffleKey < b.shuffleKey ? -1 : a.shuffleKey > b.shuffleKey ? 1 : 0));
}

/** 凍結済みの sampling frame から、この工程で使う分だけ。 */
export interface FrameEntry {
  prNumber: number;
  baseSha: string | undefined;
  targetSha: string | undefined;
  changeSizeStratum: string | undefined;
  tags: string[];
  excludedBy: string | undefined;
}

/**
 * pool が frame の eligible の部分集合であることを確かめる。
 *
 * frame で除外済みのPRや、frame に無いPRが混ざると、母集団の外から案件を持ち込んだことに
 * なる。fail-closed で止める。
 */
export function verifySubsetOfEligible(
  pool: readonly { prNumber: number }[],
  frame: readonly FrameEntry[],
): void {
  const byNumber = new Map(frame.map((entry) => [entry.prNumber, entry]));
  const problems: string[] = [];
  for (const entry of pool) {
    const framed = byNumber.get(entry.prNumber);
    if (framed === undefined) {
      problems.push(`#${entry.prNumber} が sampling frame にありません`);
    } else if (framed.excludedBy !== undefined) {
      problems.push(`#${entry.prNumber} は frame で ${framed.excludedBy} により除外済みです`);
    }
  }
  const seen = new Set<number>();
  for (const entry of pool) {
    if (seen.has(entry.prNumber)) {
      problems.push(`#${entry.prNumber} が重複しています`);
    }
    seen.add(entry.prNumber);
  }
  if (problems.length > 0) {
    throw new Error(
      `pool が sampling frame の eligible の部分集合ではありません（${problems.length} 件）: ${problems
        .slice(0, 10)
        .join(' / ')}`,
    );
  }
}

/**
 * 層ごとの必要数（予備20%込み）。`stratifiedSample.ts` の `STRATUM_QUOTAS` から導いた値。
 *
 * ここに達しない pool は、読み終えても最終の24件を組めない。生成そのものは止めないが、
 * 足りていないことを出力へ残す（**足りないまま抜いて「そろった」ことにしない**）。
 */
export const NEEDED_WITH_RESERVE = { 'no-problem': 8, indeterminate: 4 } as const;

/**
 * 読んで確定させる工程があるか。
 *
 * **凍結済みの pool 自身が持つ `difficultyStratum` から導く。** CLI 側の登録表を見て決めると、
 * 未登録の pool（`--allow-unregistered`）で確認が丸ごと飛び、読む前の候補件数がそのまま
 * 確定件数として書き出される。
 *
 * `no-problem` は、削除・書換が既存の検証を弱めていないかを読んで確かめて初めて確定する。
 * `indeterminate` は規則が機械的に閉じているので、読んで確定させる工程が無い。
 */
export function requiresConfirmation(difficultyStratum: string): boolean {
  return difficultyStratum === 'no-problem';
}
