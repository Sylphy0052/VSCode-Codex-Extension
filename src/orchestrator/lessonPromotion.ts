/**
 * 教訓の昇格と改善Issueの起票に信頼境界を設ける（Issue #2085）。
 *
 * - 昇格（工程プロンプトの定型文・`docs/knowledge/`へ入れること）は、出典がこのrepo内の成果物の
 *   教訓だけに許す。昇格した文は囲いの外、つまり指示の側に入るため、外部由来の文を通さない。
 * - 昇格する文は固定テンプレートへの値の差し込みだけで作る。差し込む値は検証済みのUUID・
 *   ISO日時・列挙の出典ラベルに限り、`observation`・`instruction`などの自由文は入れない。
 * - GitHubへ起票・投稿する前に、URLのホスト・他repoの名前・メールアドレスを伏せる。
 *   他repoの作業由来の教訓は出さない。宛先repoの公開範囲が確かめられないときも出さない。
 *
 * `vscode`にも入出力にも依存しない純粋関数。
 */

import { redactCredentials } from '../secondOpinion/redact';
import type { LessonRecord, LessonSource } from './runNotes';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** 出典の種類を人に見せるときの固定ラベル。 */
const SOURCE_LABELS: Record<LessonSource, string> = {
  repoArtifact: 'このrepoの成果物',
  otherRepo: '他repoの作業',
  external: '外部由来のテキスト',
};

/** 出典の種類。記録に無いときは外部由来として扱う。 */
export function lessonSourceOf(lesson: Pick<LessonRecord, 'source'>): LessonSource {
  return lesson.source ?? 'external';
}

/** 昇格の候補になれるか。出典がこのrepo内の成果物のものだけ。 */
export function isPromotable(lesson: Pick<LessonRecord, 'source'>): boolean {
  return lessonSourceOf(lesson) === 'repoArtifact';
}

/**
 * 昇格する文を固定テンプレートで作る。昇格できない教訓、`id`・`recordedAt`が想定の形でない
 * 教訓は`undefined`を返す。自由文（観察・指示・根拠）は文に入れない。
 */
export function renderPromotedLesson(lesson: LessonRecord): string | undefined {
  if (!isPromotable(lesson)) {
    return undefined;
  }
  if (!UUID_PATTERN.test(lesson.id) || !ISO_DATE_PATTERN.test(lesson.recordedAt)) {
    return undefined;
  }
  const label = SOURCE_LABELS[lessonSourceOf(lesson)];
  return `.agents/run-notes.jsonlの教訓${lesson.id}（出典: ${label}、記録: ${lesson.recordedAt}）を確認してから着手する。`;
}

/** 宛先repoの公開範囲。`unknown`は確かめられなかった場合。 */
export type RepoVisibility = 'public' | 'private' | 'internal' | 'unknown';

/** 起票してよいかの判定。`ok: false`のときは起票しない。 */
export type IssueFilingDecision = { ok: true } | { ok: false; reason: string };

export function decideIssueFiling(
  lesson: Pick<LessonRecord, 'source'>,
  destinationVisibility: RepoVisibility,
): IssueFilingDecision {
  if (destinationVisibility === 'unknown') {
    return { ok: false, reason: '宛先repoの公開範囲を確かめられないため起票しない' };
  }
  if (lessonSourceOf(lesson) === 'otherRepo') {
    return { ok: false, reason: '他repoの作業由来の教訓はGitHubへ出さない' };
  }
  return { ok: true };
}

export const MASK_URL_HOST = '<HOST>';
export const MASK_REPO = '<REPO>';
export const MASK_EMAIL = '<EMAIL>';

export interface IssueMaskOptions {
  /** 伏せずに残す`owner/name`（宛先repo自身）。大文字小文字は区別しない。 */
  ownRepo: string;
}

/**
 * GitHubへ出す文からURLのホスト・他repoの名前・メールアドレスを伏せる。資格情報も伏せる。
 * `github.com/<owner>/<name>`の形は`ownRepo`以外を`<REPO>`にする。
 */
export function maskForGithub(text: string, options: IssueMaskOptions): string {
  const own = options.ownRepo.toLowerCase();
  let out = redactCredentials(text).text;
  // SSH形式のremote。メールの伏せより先に処理する
  out = out.replace(
    /git@[\w.-]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=\s|$)/gi,
    (_m: string, owner: string, name: string) =>
      `${owner}/${name}`.toLowerCase() === own ? `${owner}/${name}` : MASK_REPO,
  );
  // メールは先に伏せる（URLのuserinfoと混ざらないように）
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, MASK_EMAIL);
  // GitHub URLのrepoは、宛先repo以外を伏せる。ホストは残す（公開情報のため）
  out = out.replace(
    /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/gi,
    (match: string, owner: string, name: string) =>
      `${owner}/${name}`.toLowerCase() === own ? match : `https://github.com/${MASK_REPO}`,
  );
  // それ以外のURLはホストを伏せる（パスは残す）
  out = out.replace(
    /(https?:\/\/)([^\s/:?#<>"')]+)(:\d+)?/gi,
    (match: string, scheme: string, host: string) =>
      host.toLowerCase().replace(/^www\./, '') === 'github.com' || host === MASK_REPO
        ? match
        : `${scheme}${MASK_URL_HOST}`,
  );
  return out;
}

/** 教訓から改善Issueの本文を作る。起票してはいけないときは`undefined`。 */
export function buildLessonIssueBody(
  lesson: LessonRecord,
  destinationVisibility: RepoVisibility,
  options: IssueMaskOptions,
): string | undefined {
  if (!decideIssueFiling(lesson, destinationVisibility).ok) {
    return undefined;
  }
  const lines = [
    '## 観察',
    lesson.observation,
    '',
    '## 根拠',
    ...(lesson.evidence.length > 0 ? lesson.evidence.map((e) => `- ${e}`) : ['- なし']),
    '',
    '## 提案',
    lesson.instruction,
  ];
  return maskForGithub(lines.join('\n'), options);
}
