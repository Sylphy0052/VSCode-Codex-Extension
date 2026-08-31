/**
 * 証拠候補の分類（Issue #1046 手順2）。
 *
 * ここでやるのは**候補の列挙だけ**で、正解ラベルの根拠が成立するかは判定しない。
 * `groundTruthBasis` を決めるのは手順3で、その判断は「その問題が真だと何で確定したか」を
 * 人が中身を読んで下す。ここが返すのは、その判断の入力になる材料の在り処である。
 *
 * **投稿者のloginで「人間の証拠」と決めない。** このリポジトリのPR本文もコメントも、多くは
 * AIエージェントがアカウント所有者の名前で書いている。login が `Sylphy0052` であることは
 * 「アカウントから投稿された」以上を意味しない。`model` と `account` を分けているのは、
 * 明示的にAIレビュアーだと分かるものを先に落とすためであって、残りを人間の分析だと見なす
 * ためではない。
 */

/** 投稿者の種別。`account` は「人間が書いた」ではなく「AIレビュアーだと断定できない」の意。 */
export type AuthorKind = 'model' | 'account' | 'unknown';

/**
 * AIレビュアーだと分かっているlogin。
 *
 * ここに載っていないloginを人間扱いしない。GitHub Appは末尾が `[bot]` になるので、それも
 * まとめて `model` として扱う。
 */
export const MODEL_AUTHOR_LOGINS: readonly string[] = ['chatgpt-codex-connector', 'copilot'];

export function authorKindOf(login: string | undefined): AuthorKind {
  if (login === undefined || login === '') {
    return 'unknown';
  }
  const normalized = login.toLowerCase();
  if (MODEL_AUTHOR_LOGINS.includes(normalized) || normalized.endsWith('[bot]')) {
    return 'model';
  }
  return 'account';
}

export interface RawComment {
  authorLogin: string | undefined;
  createdAt: string;
  body: string;
}

export interface RawReview {
  authorLogin: string | undefined;
  state: string;
  body: string;
}

export interface RawLinkedIssue {
  number: number;
  title: string;
  authorLogin: string | undefined;
  body: string;
  comments: RawComment[];
}

export interface RawCrossReference {
  /** 参照された時刻。このPRのマージ後かどうかは、この値で見る。 */
  createdAt: string;
  kind: 'Issue' | 'PullRequest' | 'other';
  number: number;
  title: string;
  authorLogin: string | undefined;
  /**
   * 参照元そのものが作られた時刻。
   *
   * 参照が後でも、参照元が前から存在していれば「このPRを受けて立った報告」ではない。
   * 系統の判定はマージ後の参照で立て、この区別は手順3の判断材料として残す。
   */
  sourceCreatedAt: string;
  mergedAt: string | undefined;
}

/** GitHubから引いた素。`gh` の返した内容をそのまま並べ替えただけのもの。 */
export interface RawPrEvidence {
  prNumber: number;
  mergedAt: string;
  comments: RawComment[];
  reviews: RawReview[];
  closingIssues: RawLinkedIssue[];
  crossReferences: RawCrossReference[];
  /** 取り切れなかった項目。件数の解釈を誤らせるので、黙って落とさず残す。 */
  truncated: string[];
}

/**
 * 証拠候補の系統。
 *
 * どれも「候補がある」以上を主張しない。`follow-up-fix` があっても、Issue #1046 の言うとおり
 * 「後続コミットで直した」という事実だけでは元の問題が成立した証拠にならない。
 */
export type EvidenceChannel =
  /** マージ後に立った後続のfix / revert PRが、このPRを参照している。 */
  | 'follow-up-fix'
  /** その後続PRがテストを触っている（実験による確定の候補）。 */
  | 'follow-up-test'
  /** マージ後に立ったIssueが、このPRを参照している。 */
  | 'follow-up-issue'
  /** このPRが閉じたIssue。変更の背景であって、不具合が起きた証拠ではない。 */
  | 'closing-issue'
  /** AIレビュアー以外のアカウントによるコメント。AIの転記かどうかは手順3で見る。 */
  | 'account-comment';

export interface FollowUpPr {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | undefined;
  /** Conventional Commits の型。タイトルから読めなければ `undefined`。 */
  changeType: string | undefined;
  /** テストファイルを触っているか。ファイル一覧を引けていなければ `undefined`。 */
  touchesTests: boolean | undefined;
}

export interface EvidenceCandidates {
  prNumber: number;
  followUpPrs: FollowUpPr[];
  followUpIssues: {
    number: number;
    title: string;
    /** 参照された時刻。 */
    createdAt: string;
    /** Issue自体が立った時刻。マージ前から存在するIssueはこのPRを受けた報告ではない。 */
    sourceCreatedAt: string;
    /** マージ後に立ったIssueか。 */
    openedAfterMerge: boolean;
    authorKind: AuthorKind;
  }[];
  closingIssues: { number: number; title: string; authorKind: AuthorKind; commentCount: number }[];
  accountCommentCount: number;
  modelCommentCount: number;
  accountReviewCount: number;
  modelReviewCount: number;
  channels: EvidenceChannel[];
}

/** 後続のfixとみなすタイトルの型。`feat` は問題の証拠にならないので入れない。 */
const FIX_CHANGE_TYPES: readonly string[] = ['fix', 'revert', 'test', 'perf'];

/**
 * 後続PRのファイル一覧を引くときの上限。
 *
 * ここに達している一覧は途中で切れている可能性があるので、テストが見つからなくても
 * 「テストを触っていない」とは言えない。{@link collectCandidates} はその場合 `undefined`
 * を返す。`false` にすると、引けていないだけのものが「テスト無し」として数えられる。
 */
export const FOLLOW_UP_FILE_PAGE = 100;

const TEST_PATH_PATTERNS = [
  /^test\//,
  /^tests\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
];

export function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

/** `fix(scope): ...` `fix: ...` `Revert "..."` からPRの型を読む。 */
export function changeTypeOf(title: string): string | undefined {
  const conventional = /^([a-z]+)(\([^)]*\))?!?:/.exec(title.trim());
  if (conventional?.[1] !== undefined) {
    return conventional[1];
  }
  if (/^revert\b/i.test(title.trim())) {
    return 'revert';
  }
  return undefined;
}

/**
 * テストを触っているか。分からないときは `false` ではなく `undefined` を返す。
 *
 * 一覧が上限まで埋まっているときは、その先にテストがあっても見えない。
 */
function touchesTestsOf(files: readonly string[] | undefined): boolean | undefined {
  if (files === undefined) {
    return undefined;
  }
  if (files.some(isTestPath)) {
    return true;
  }
  return files.length >= FOLLOW_UP_FILE_PAGE ? undefined : false;
}

/**
 * 証拠候補を数える。
 *
 * 後続かどうかは**このPRがマージされた後に作られたか**で見る。マージ前から存在する参照は、
 * このPRが持ち込んだ問題の証拠になりようがない。
 */
export function collectCandidates(
  raw: RawPrEvidence,
  followUpFiles: ReadonlyMap<number, readonly string[]>,
): EvidenceCandidates {
  const afterMerge = raw.crossReferences.filter((ref) => ref.createdAt > raw.mergedAt);

  const followUpPrs: FollowUpPr[] = afterMerge
    .filter((ref) => ref.kind === 'PullRequest')
    .map((ref) => {
      const files = followUpFiles.get(ref.number);
      return {
        number: ref.number,
        title: ref.title,
        createdAt: ref.createdAt,
        mergedAt: ref.mergedAt,
        changeType: changeTypeOf(ref.title),
        touchesTests: touchesTestsOf(files),
      };
    });

  const followUpIssues = afterMerge
    .filter((ref) => ref.kind === 'Issue')
    .map((ref) => ({
      number: ref.number,
      title: ref.title,
      createdAt: ref.createdAt,
      sourceCreatedAt: ref.sourceCreatedAt,
      openedAfterMerge: ref.sourceCreatedAt > raw.mergedAt,
      authorKind: authorKindOf(ref.authorLogin),
    }));

  const closingIssues = raw.closingIssues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    authorKind: authorKindOf(issue.authorLogin),
    commentCount: issue.comments.length,
  }));

  const commentKinds = raw.comments.map((comment) => authorKindOf(comment.authorLogin));
  const reviewKinds = raw.reviews.map((review) => authorKindOf(review.authorLogin));

  const fixPrs = followUpPrs.filter(
    (pr) => pr.changeType !== undefined && FIX_CHANGE_TYPES.includes(pr.changeType),
  );

  const channels: EvidenceChannel[] = [];
  if (fixPrs.length > 0) {
    channels.push('follow-up-fix');
  }
  if (fixPrs.some((pr) => pr.touchesTests === true)) {
    channels.push('follow-up-test');
  }
  if (followUpIssues.length > 0) {
    channels.push('follow-up-issue');
  }
  if (closingIssues.length > 0) {
    channels.push('closing-issue');
  }
  if (commentKinds.includes('account')) {
    channels.push('account-comment');
  }

  return {
    prNumber: raw.prNumber,
    followUpPrs,
    followUpIssues,
    closingIssues,
    accountCommentCount: commentKinds.filter((kind) => kind === 'account').length,
    modelCommentCount: commentKinds.filter((kind) => kind === 'model').length,
    accountReviewCount: reviewKinds.filter((kind) => kind === 'account').length,
    modelReviewCount: reviewKinds.filter((kind) => kind === 'model').length,
    channels,
  };
}

export const EVIDENCE_CHANNELS: readonly EvidenceChannel[] = [
  'follow-up-fix',
  'follow-up-test',
  'follow-up-issue',
  'closing-issue',
  'account-comment',
];

/**
 * 系統ごとの件数と、候補がひとつも無いPRの数。
 *
 * `closing-issue` と `account-comment` はほぼ全件に付くはずで、ここが絞り込みになるとは
 * 考えていない。絞り込みは手順3の中身の判定で起きる。
 */
export function summarizeChannels(all: readonly EvidenceCandidates[]): {
  total: number;
  perChannel: { channel: EvidenceChannel; count: number }[];
  noChannel: number;
} {
  return {
    total: all.length,
    perChannel: EVIDENCE_CHANNELS.map((channel) => ({
      channel,
      count: all.filter((candidate) => candidate.channels.includes(channel)).length,
    })),
    noChannel: all.filter((candidate) => candidate.channels.length === 0).length,
  };
}
