/* eslint-disable no-console -- 証拠候補がどこで減るかを出すのがこのファイルの目的 */
/**
 * 手順1で凍結した sampling frame の各案件について、正解ラベルの根拠になりうる材料を集める
 * （Issue #1046 手順2）。
 *
 * 使い方:
 *
 * ```
 * # 1回だけ: GitHubから引いて、証拠の素をそのまま保存する
 * npx tsx test/bench/secondOpinionEval/evidenceCandidates.ts \
 *   --frame eval-results/sampling-frame-v2.json \
 *   --evidence-src-out eval-results/evidence-source-v2.json \
 *   --out eval-results/evidence-candidates-v2.json
 *
 * # 以降: 保存した素からのみ作り直す
 * npx tsx test/bench/secondOpinionEval/evidenceCandidates.ts \
 *   --frame eval-results/sampling-frame-v2.json \
 *   --evidence-src eval-results/evidence-source-v2.json \
 *   --out eval-results/evidence-candidates-v2.json
 * ```
 *
 * **ここでは正解ラベルを作らない。** 集めるのは「その問題が真だと確定した根拠」を人が読んで
 * 判断するための材料であって、材料の有無で `groundTruthBasis` を機械的に決めることはしない。
 * Issue #1046 が書いているとおり、「後続コミットで直した」という事実だけでは、元の問題が実際
 * に成立した証拠にならない。
 *
 * **Codexレビューは正解ラベルの根拠にしない。** ただし件数は数える。数えないと「Codexの指摘
 * しか無い案件」が何件あるかを後から示せない。
 *
 * 手順1と同じく、素とその派生の両方を凍結する。素は取り直さず、派生は1バイトでも違えば拒否
 * する。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  collectCandidates,
  summarizeChannels,
  type EvidenceCandidates,
  type RawCrossReference,
  type RawPrEvidence,
} from './evidenceChannels';
import { refuseIfExists, writeFrozen } from './frozenFile';

const run = promisify(execFile);

const REPO_OWNER = 'Sylphy0052';
const REPO_NAME = 'VSCode-Codex-Extension';

/**
 * 手順1で凍結した sampling frame v2 のsha256。
 *
 * 母集団が変われば証拠の集計も別物になる。frameは絶対パスを含まないので、この値はcloneの
 * 置き場所に依らない。ずれたら止める。frameを作り直したときは、こちらの版も上げる。
 */
const EXPECTED_FRAME_SHA256 = 'aaf4a28de0d6a3f8b24815f52e89dfc7bf5cadc6dd932f773004aa7cbd621bc6';

/** 証拠候補の収集規則の版。規則を変えたら上げ、前の版のファイルは残す。 */
const EVIDENCE_RULES_VERSION = 2;

/** 1リクエストで引くPR数。GraphQLのnode数上限に収まる範囲で大きくとる。 */
const BATCH_SIZE = 20;

const COMMENT_PAGE = 100;
const REVIEW_PAGE = 50;
const CLOSING_ISSUE_PAGE = 10;
const TIMELINE_PAGE = 100;
const FILE_PAGE = 100;

interface FramePullRequest {
  prNumber: number;
  title: string;
  mergedAt: string;
  excludedBy: string | undefined;
}

interface Frame {
  sourceSha256: string;
  exclusionRulesVersion: number;
  prs: FramePullRequest[];
}

interface EvidenceSource {
  capturedAt: string;
  frameSha256: string;
  evidenceRulesVersion: number;
  prs: RawPrEvidence[];
  followUpFiles: { prNumber: number; files: string[] }[];
}

interface Args {
  framePath: string;
  evidenceSrcPath: string | undefined;
  evidenceSrcOutPath: string | undefined;
  outPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token !== undefined && token.startsWith('--')) {
      values.set(token.slice(2), argv[i + 1] ?? '');
      i += 1;
    }
  }
  const framePath = values.get('frame');
  if (framePath === undefined || framePath === '') {
    throw new Error('--frame（手順1で凍結した sampling frame）は必須です');
  }
  const outPath = values.get('out');
  if (outPath === undefined || outPath === '') {
    throw new Error('--out は必須です');
  }
  const evidenceSrcPath = values.get('evidence-src');
  const evidenceSrcOutPath = values.get('evidence-src-out');
  if (
    (evidenceSrcPath === undefined || evidenceSrcPath === '') &&
    (evidenceSrcOutPath === undefined || evidenceSrcOutPath === '')
  ) {
    // 素を保存しないままGitHubを引くと、その集計がどの入力から出たかを後から示せない
    throw new Error(
      '--evidence-src（保存済みの素）か --evidence-src-out（これから保存する先）のどちらかは必須です',
    );
  }
  return { framePath, evidenceSrcPath, evidenceSrcOutPath, outPath };
}

async function loadFrame(framePath: string): Promise<{ frame: Frame; sha256: string }> {
  const raw = await fs.readFile(framePath, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== EXPECTED_FRAME_SHA256) {
    throw new Error(
      `sampling frame のsha256が想定と一致しません。想定: ${EXPECTED_FRAME_SHA256} / 実測: ${sha256}。` +
        '母集団が変わっています。EXPECTED_FRAME_SHA256 と EVIDENCE_RULES_VERSION を上げ、前の版のファイルは残してください',
    );
  }
  return { frame: JSON.parse(raw) as Frame, sha256 };
}

async function graphql(query: string): Promise<Record<string, unknown>> {
  const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=${query}`], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { data?: Record<string, unknown>; errors?: unknown };
  if (parsed.errors !== undefined) {
    throw new Error(`GraphQLがエラーを返しました: ${JSON.stringify(parsed.errors)}`);
  }
  if (parsed.data === undefined) {
    throw new Error('GraphQLの応答に data がありません');
  }
  return parsed.data;
}

interface GqlActor {
  login: string;
}

interface GqlComment {
  author: GqlActor | null;
  createdAt: string;
  body: string;
}

interface GqlPrEvidence {
  number: number;
  mergedAt: string;
  comments: { totalCount: number; nodes: GqlComment[] };
  reviews: {
    totalCount: number;
    nodes: { author: GqlActor | null; state: string; body: string | null }[];
  };
  closingIssuesReferences: {
    totalCount: number;
    nodes: {
      number: number;
      title: string;
      author: GqlActor | null;
      body: string | null;
      comments: { totalCount: number; nodes: GqlComment[] };
    }[];
  };
  timelineItems: {
    nodes: {
      createdAt?: string;
      source?: {
        __typename: string;
        number: number;
        title: string;
        author: GqlActor | null;
        createdAt: string;
        mergedAt?: string | null;
      };
    }[];
  };
}

const EVIDENCE_FRAGMENT = `
fragment Evidence on PullRequest {
  number
  mergedAt
  comments(first: ${COMMENT_PAGE}) { totalCount nodes { author { login } createdAt body } }
  reviews(first: ${REVIEW_PAGE}) { totalCount nodes { author { login } state body } }
  closingIssuesReferences(first: ${CLOSING_ISSUE_PAGE}) {
    totalCount
    nodes {
      number title author { login } body
      comments(first: ${COMMENT_PAGE}) { totalCount nodes { author { login } createdAt body } }
    }
  }
  timelineItems(first: ${TIMELINE_PAGE}, itemTypes: [CROSS_REFERENCED_EVENT]) {
    nodes {
      ... on CrossReferencedEvent {
        createdAt
        source {
          ... on Issue { __typename number title author { login } createdAt }
          ... on PullRequest { __typename number title author { login } createdAt mergedAt }
        }
      }
    }
  }
}`;

function toComment(node: GqlComment): {
  authorLogin: string | undefined;
  createdAt: string;
  body: string;
} {
  return { authorLogin: node.author?.login, createdAt: node.createdAt, body: node.body };
}

function toCrossReference(node: {
  createdAt?: string;
  source?: {
    __typename: string;
    number: number;
    title: string;
    author: GqlActor | null;
    createdAt: string;
    mergedAt?: string | null;
  };
}): RawCrossReference | undefined {
  const source = node.source;
  if (source === undefined || node.createdAt === undefined) {
    return undefined;
  }
  const kind =
    source.__typename === 'Issue'
      ? 'Issue'
      : source.__typename === 'PullRequest'
        ? 'PullRequest'
        : 'other';
  return {
    createdAt: node.createdAt,
    kind,
    number: source.number,
    title: source.title,
    authorLogin: source.author?.login,
    sourceCreatedAt: source.createdAt,
    mergedAt: source.mergedAt ?? undefined,
  };
}

/** 取り切れなかった項目を残す。件数の解釈を誤らせるので、黙って落とさない。 */
function truncationsOf(node: GqlPrEvidence): string[] {
  const truncated: string[] = [];
  if (node.comments.nodes.length < node.comments.totalCount) {
    truncated.push(`comments(${node.comments.nodes.length}/${node.comments.totalCount})`);
  }
  if (node.reviews.nodes.length < node.reviews.totalCount) {
    truncated.push(`reviews(${node.reviews.nodes.length}/${node.reviews.totalCount})`);
  }
  if (node.closingIssuesReferences.nodes.length < node.closingIssuesReferences.totalCount) {
    truncated.push(
      `closingIssues(${node.closingIssuesReferences.nodes.length}/${node.closingIssuesReferences.totalCount})`,
    );
  }
  // timelineItems の totalCount は itemTypes での絞り込み前の件数を返すので比較に使えない。
  // 取り切れたかは「上限まで埋まっていないこと」で見る
  if (node.timelineItems.nodes.length >= TIMELINE_PAGE) {
    truncated.push(`crossReferences(>=${TIMELINE_PAGE})`);
  }
  return truncated;
}

function toRawEvidence(node: GqlPrEvidence): RawPrEvidence {
  return {
    prNumber: node.number,
    mergedAt: node.mergedAt,
    comments: node.comments.nodes.map(toComment),
    reviews: node.reviews.nodes.map((review) => ({
      authorLogin: review.author?.login,
      state: review.state,
      body: review.body ?? '',
    })),
    closingIssues: node.closingIssuesReferences.nodes.map((issue) => ({
      number: issue.number,
      title: issue.title,
      authorLogin: issue.author?.login,
      body: issue.body ?? '',
      comments: issue.comments.nodes.map(toComment),
    })),
    crossReferences: node.timelineItems.nodes
      .map(toCrossReference)
      .filter((ref): ref is RawCrossReference => ref !== undefined),
    truncated: truncationsOf(node),
  };
}

async function fetchEvidence(prNumbers: readonly number[]): Promise<RawPrEvidence[]> {
  const collected: RawPrEvidence[] = [];
  for (let offset = 0; offset < prNumbers.length; offset += BATCH_SIZE) {
    const batch = prNumbers.slice(offset, offset + BATCH_SIZE);
    const aliases = batch
      .map((number) => `    p${number}: pullRequest(number: ${number}) { ...Evidence }`)
      .join('\n');
    const query = `query {
  repository(owner: "${REPO_OWNER}", name: "${REPO_NAME}") {
${aliases}
  }
}
${EVIDENCE_FRAGMENT}`;
    const data = await graphql(query);
    const repository = data['repository'] as Record<string, GqlPrEvidence>;
    for (const number of batch) {
      const node = repository[`p${number}`];
      if (node === undefined) {
        throw new Error(`PR #${number} の応答がありません`);
      }
      collected.push(toRawEvidence(node));
    }
    console.log(`[evidence] ${collected.length} / ${prNumbers.length} 件`);
  }
  return collected;
}

/** 後続PRがテストを触っているかを見るために、そのPRのファイル一覧だけ引く。 */
async function fetchFollowUpFiles(
  prNumbers: readonly number[],
): Promise<{ prNumber: number; files: string[] }[]> {
  const collected: { prNumber: number; files: string[] }[] = [];
  for (let offset = 0; offset < prNumbers.length; offset += BATCH_SIZE) {
    const batch = prNumbers.slice(offset, offset + BATCH_SIZE);
    const aliases = batch
      .map(
        (number) =>
          `    p${number}: pullRequest(number: ${number}) { files(first: ${FILE_PAGE}) { nodes { path } } }`,
      )
      .join('\n');
    const query = `query {
  repository(owner: "${REPO_OWNER}", name: "${REPO_NAME}") {
${aliases}
  }
}`;
    const data = await graphql(query);
    const repository = data['repository'] as Record<
      string,
      { files: { nodes: { path: string }[] } } | null
    >;
    for (const number of batch) {
      const node = repository[`p${number}`];
      if (node === undefined || node === null) {
        continue;
      }
      collected.push({ prNumber: number, files: node.files.nodes.map((file) => file.path) });
    }
    console.log(`[files] ${collected.length} / ${prNumbers.length} 件`);
  }
  return collected;
}

async function loadEvidenceSource(
  args: Args,
  frameSha256: string,
  prNumbers: readonly number[],
): Promise<{ source: EvidenceSource; path: string; sha256: string }> {
  if (args.evidenceSrcPath !== undefined && args.evidenceSrcPath !== '') {
    const raw = await fs.readFile(args.evidenceSrcPath, 'utf8');
    const source = JSON.parse(raw) as EvidenceSource;
    if (source.frameSha256 !== frameSha256) {
      throw new Error(
        `保存済みの素は別のframeから取られています。素: ${source.frameSha256} / 今回のframe: ${frameSha256}`,
      );
    }
    return {
      source,
      path: args.evidenceSrcPath,
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
  }

  const outPath = args.evidenceSrcOutPath ?? '';
  // 素は一度取ったら二度と取り直さない。GitHub側は動くので、引き直すと別物になる
  await refuseIfExists(outPath, '証拠の素');
  const prs = await fetchEvidence(prNumbers);
  const followUpNumbers = [
    ...new Set(
      prs.flatMap((pr) =>
        pr.crossReferences
          .filter((ref) => ref.kind === 'PullRequest' && ref.createdAt > pr.mergedAt)
          .map((ref) => ref.number),
      ),
    ),
  ].sort((a, b) => a - b);
  const followUpFiles = await fetchFollowUpFiles(followUpNumbers);

  const source: EvidenceSource = {
    capturedAt: new Date().toISOString(),
    frameSha256,
    evidenceRulesVersion: EVIDENCE_RULES_VERSION,
    prs,
    followUpFiles,
  };
  const json = `${JSON.stringify(source, null, 2)}\n`;
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, json, 'utf8');
  return { source, path: outPath, sha256: createHash('sha256').update(json).digest('hex') };
}

function printFunnel(candidates: readonly EvidenceCandidates[], eligible: number): void {
  const summary = summarizeChannels(candidates);
  console.log('');
  console.log(`metadata eligible: ${eligible} 件`);
  console.log('証拠候補の系統（重複してよい。どれも「候補がある」以上を主張しない）:');
  for (const { channel, count } of summary.perChannel) {
    console.log(`  - ${channel}: ${count} 件`);
  }
  console.log(`  - 候補がひとつも無い: ${summary.noChannel} 件`);

  const openedAfterMerge = candidates.filter((candidate) =>
    candidate.followUpIssues.some((issue) => issue.openedAfterMerge),
  ).length;
  console.log('');
  console.log(
    `  うち、マージ後に立ったIssueを含む: ${openedAfterMerge} 件` +
      '（前からあるIssueが後で言及されただけのものを除いた数）',
  );
  const strongest = candidates.filter(
    (candidate) =>
      candidate.channels.includes('follow-up-test') ||
      candidate.followUpIssues.some((issue) => issue.openedAfterMerge),
  ).length;
  console.log(`後続テスト または マージ後に立ったIssue を持つ: ${strongest} 件`);

  const fixOnly = candidates.filter(
    (candidate) =>
      candidate.channels.includes('follow-up-fix') &&
      !candidate.channels.includes('follow-up-test'),
  ).length;
  console.log('');
  console.log(`後続fixはあるがテストが無い: ${fixOnly} 件（実験による確定には至らない）`);
  console.log(
    `Codexレビュー/コメントが付いている: ${candidates.filter((c) => c.modelCommentCount + c.modelReviewCount > 0).length} 件（正解ラベルの根拠には使わない）`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { frame, sha256: frameSha256 } = await loadFrame(args.framePath);
  const eligible = frame.prs.filter((pr) => pr.excludedBy === undefined);
  const prNumbers = eligible.map((pr) => pr.prNumber);

  const source = await loadEvidenceSource(args, frameSha256, prNumbers);
  const followUpFiles = new Map<number, readonly string[]>(
    source.source.followUpFiles.map((entry) => [entry.prNumber, entry.files]),
  );
  const candidates = source.source.prs.map((raw) => collectCandidates(raw, followUpFiles));

  const output = {
    frameSha256,
    frameFile: path.basename(args.framePath),
    evidenceSourceFile: path.basename(source.path),
    evidenceSourceSha256: source.sha256,
    capturedAt: source.source.capturedAt,
    evidenceRulesVersion: EVIDENCE_RULES_VERSION,
    candidates,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const written = await writeFrozen(args.outPath, json);
  const sha256 = createHash('sha256').update(json).digest('hex');

  printFunnel(candidates, eligible.length);

  const truncated = source.source.prs.filter((pr) => pr.truncated.length > 0);
  if (truncated.length > 0) {
    console.log('');
    console.log(`取り切れなかったPR: ${truncated.length} 件`);
    for (const pr of truncated.slice(0, 20)) {
      console.log(`  - #${pr.prNumber}: ${pr.truncated.join(', ')}`);
    }
  }

  console.log('');
  console.log(`証拠の素: ${source.path}`);
  console.log(`  sha256: ${source.sha256}`);
  console.log(`  取得時刻: ${source.source.capturedAt}`);
  console.log(
    `書き出し: ${args.outPath}${written === 'unchanged' ? '（既存と同一。書き換えていない）' : ''}`,
  );
  console.log(`  sha256: ${sha256}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
