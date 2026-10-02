import type { SkillsSnapshot } from '../provider/skills';
import type { ForgeHubProvider, ForgeWorkItem } from './hub';

/**
 * Forge HubからAIへ送る依頼文を組み立てる（Issue #1814）。
 *
 * GitLab側は`gitlab-*` skillが3つ揃った出どころを、素の名前（ホーム・リポジトリのskill）→
 * 同梱（`codex-ext:`）→利用者（`codex-ext-user:`）の順に選んで呼ぶ。どこにも揃わない環境で
 * skill名だけを送ると、エラーにならないまま計画の記録・自己レビュー・後片付けが抜け落ちる。
 * そのため揃わないときはGitHub側と同じく平文の依頼文にする。
 */

/** Forge Hubが呼び分けるGitLab向けskill。 */
export type ForgeGitLabSkill = 'gitlab-develop' | 'gitlab-review' | 'gitlab-cleanup';

/**
 * skill一覧から、呼び出せるskillの名前を取り出す。
 *
 * 取得に失敗したときは空集合にする。skillがあるのに平文で送っても手順は抜けないが、
 * 無いのにskill名を送ると手順が丸ごと抜けるため、分からないときは平文側へ倒す。
 */
export function availableSkillNames(snapshot: SkillsSnapshot | undefined): ReadonlySet<string> {
  if (snapshot === undefined || !snapshot.ok) return new Set();
  return new Set(snapshot.skills.filter((skill) => skill.enabled).map((skill) => skill.name));
}

const GITLAB_SKILLS: readonly ForgeGitLabSkill[] = [
  'gitlab-develop',
  'gitlab-review',
  'gitlab-cleanup',
];

/**
 * 呼び出し名の接頭辞。素の名前（ホーム・リポジトリのskill）が先、
 * 次に同梱skill、利用者skillの順に選ぶ（Issue #1828）。
 */
const SKILL_NAME_PREFIXES = ['', 'codex-ext:', 'codex-ext-user:'] as const;

/**
 * 3つのskillが全部揃っている出どころの接頭辞を返す。無ければundefined（平文にする）。
 *
 * skillごとに出どころを選ぶと、素の`gitlab-develop`が素の`gitlab-review`を探して
 * 手順が抜けるため、必ず3つの組で選ぶ。
 */
export function resolveGitLabSkillPrefix(skills: ReadonlySet<string>): string | undefined {
  return SKILL_NAME_PREFIXES.find((prefix) =>
    GITLAB_SKILLS.every((skill) => skills.has(`${prefix}${skill}`)),
  );
}

/** skillの呼び出し文字列。Codexは`$name`、Claude Codeは`/name`と書く。 */
export function skillInvocation(
  provider: ForgeHubProvider,
  skill: ForgeGitLabSkill,
  prefix = '',
): string {
  return provider === 'claude' ? `/${prefix}${skill}` : `$${prefix}${skill}`;
}

export function buildIssueStartPrompt(
  host: 'github' | 'gitlab' | undefined,
  number: number,
): string {
  const command = host === 'gitlab' ? `glab issue view ${number}` : `gh issue view ${number}`;
  return [
    `Forge HubからIssue #${number}に着手します。`,
    `最初に \`${command}\` で本文と現在の状態を確認してください。`,
    '作業はこの隔離worktreeだけで行い、実装前に計画をIssueへ残してください。',
    'commit/pushやMR作成、マージ、破壊的操作は、必要な確認を取ってから進めてください。',
  ].join('\n');
}

/** 着手時の依頼文の末尾に付ける、何をするかの指示。 */
export function buildIssueStartRequest(
  host: 'github' | 'gitlab' | undefined,
  provider: ForgeHubProvider,
  number: number,
  skills: ReadonlySet<string>,
): string {
  if (host !== 'gitlab') return `GitHub Issue #${number}に着手してください。`;
  const prefix = resolveGitLabSkillPrefix(skills);
  if (prefix !== undefined)
    return `${skillInvocation(provider, 'gitlab-develop', prefix)} #${number}`;
  return [`GitLab Issue #${number}に着手してください。`, ...gitlabDevelopSteps(number)].join('\n');
}

export function buildWorkActionPrompt(
  host: ForgeWorkItem['host'],
  provider: ForgeHubProvider,
  status: ForgeWorkItem['status'],
  issueNumber: number,
  pullRequestNumber: number | undefined,
  skills: ReadonlySet<string>,
): string {
  const reference =
    pullRequestNumber === undefined ? `Issue #${issueNumber}` : `PR/MR #${pullRequestNumber}`;
  if (status === 'blocked') return `${reference}のブロック理由を調査し、必要な対応をしてください。`;
  if (host === 'gitlab') {
    const prefix = resolveGitLabSkillPrefix(skills);
    if (status === 'inProgress') {
      return prefix !== undefined
        ? `${skillInvocation(provider, 'gitlab-develop', prefix)} #${issueNumber}`
        : [
            `GitLab Issue #${issueNumber}の実装を続けてください。済んでいない手順から進めます。`,
            ...gitlabDevelopSteps(issueNumber),
          ].join('\n');
    }
    if (status === 'cleanup') {
      return prefix !== undefined
        ? `${skillInvocation(provider, 'gitlab-cleanup', prefix)} ${reference}`
        : [
            `${reference}はマージ済みです。対象を確認してcleanupしてください。`,
            ...gitlabCleanupSteps(issueNumber, pullRequestNumber),
          ].join('\n');
    }
    return prefix !== undefined
      ? `${skillInvocation(provider, 'gitlab-review', prefix)} ${reference}`
      : [
          `${reference}をレビューし、必要な対応を進めてください。`,
          ...gitlabReviewSteps(pullRequestNumber),
        ].join('\n');
  }
  if (status === 'inProgress') return `GitHub Issue #${issueNumber}の実装を続けてください。`;
  if (status === 'cleanup')
    return `${reference}はマージ済みです。対象を確認してcleanupしてください。`;
  return `${reference}をレビューし、必要な対応を進めてください。`;
}

// 以下はskillが無い環境向けの手順。`gitlab-*` skillの要点（計画の記録、MR作成、
// 自己レビュー、後片付け）を抜かさないために平文で並べる。

function gitlabDevelopSteps(issueNumber: number): string[] {
  return [
    `1. \`glab issue view ${issueNumber}\` で本文と受入基準を確認する`,
    '2. 実装前に、変更方針と受入基準の確かめ方をIssueのコメントへ残す',
    '3. 実装し、Conventional Commits形式でcommitしてpushする',
    `4. \`glab mr create\` で、本文に \`Closes #${issueNumber}\` を入れたMRを作る`,
    '5. MRの差分を自己レビューし、見つけた問題を直してpushする',
  ];
}

function gitlabReviewSteps(pullRequestNumber: number | undefined): string[] {
  const target = pullRequestNumber === undefined ? '' : ` ${pullRequestNumber}`;
  return [
    `1. \`glab mr view${target}\` と \`glab mr diff${target}\` で状態と差分を確認する`,
    '2. 未解決のコメントとCIの失敗があれば、原因を直してpushする',
    '3. 受入基準を満たしているかを確かめ、結果をMRのコメントへ残す',
    '4. マージは確認を取ってから行う',
  ];
}

function gitlabCleanupSteps(issueNumber: number, pullRequestNumber: number | undefined): string[] {
  const target = pullRequestNumber === undefined ? '' : ` ${pullRequestNumber}`;
  return [
    `1. \`glab mr view${target}\` でマージ済みであることを確認する`,
    '2. マージしたブランチをリモートとローカルから削除し、作業用のworktreeを撤去する',
    `3. Issue #${issueNumber}が開いたままなら、完了の記録をコメントへ残してcloseする`,
    '4. 削除やcloseの前に対象を示し、確認を取る',
  ];
}
