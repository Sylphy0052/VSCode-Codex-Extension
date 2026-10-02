/**
 * Forge HubがAIへ送る依頼文（Issue #1814）。
 *
 * GitLab側は`gitlab-*` skillがあるときだけ呼び出し、無ければ手順を平文で並べる。
 * skillの呼び出しはCodexなら`$name`、Claude Codeなら`/name`と書く。
 */

import { describe, expect, it } from 'vitest';

import {
  availableSkillNames,
  buildIssueStartRequest,
  buildWorkActionPrompt,
} from '../../src/forge/hubPrompts';
import type { SkillView } from '../../src/provider/skills';

const ALL_GITLAB_SKILLS: ReadonlySet<string> = new Set([
  'gitlab-develop',
  'gitlab-review',
  'gitlab-cleanup',
]);
const BUNDLED_GITLAB_SKILLS: ReadonlySet<string> = new Set(
  [...ALL_GITLAB_SKILLS].map((name) => `codex-ext:${name}`),
);
const USER_GITLAB_SKILLS: ReadonlySet<string> = new Set(
  [...ALL_GITLAB_SKILLS].map((name) => `codex-ext-user:${name}`),
);
const NO_SKILLS: ReadonlySet<string> = new Set();

function skill(name: string, enabled = true): SkillView {
  return {
    key: name,
    name,
    description: '',
    origin: 'user',
    originDetail: undefined,
    enabled,
    toggleable: false,
  };
}

describe('availableSkillNames', () => {
  it('有効なskillの名前だけを返す', () => {
    const names = availableSkillNames({
      ok: true,
      skills: [skill('gitlab-develop'), skill('gitlab-review', false)],
      warnings: [],
    });
    expect([...names]).toEqual(['gitlab-develop']);
  });

  it('一覧を取れなかったときは空集合にする', () => {
    expect(availableSkillNames({ ok: false, reason: '起動できない' }).size).toBe(0);
    expect(availableSkillNames(undefined).size).toBe(0);
  });
});

describe('buildIssueStartRequest', () => {
  it('skillが無いGitLabでは、skill名ではなく手順を平文で送る', () => {
    const text = buildIssueStartRequest('gitlab', 'codex', 12, NO_SKILLS);
    expect(text).not.toContain('gitlab-develop');
    expect(text).toContain('glab issue view 12');
    expect(text).toContain('Closes #12');
    expect(text).toContain('自己レビュー');
  });

  it('skillがあるGitLabでは、Codexは$、Claude Codeは/でskillを呼ぶ', () => {
    expect(buildIssueStartRequest('gitlab', 'codex', 12, ALL_GITLAB_SKILLS)).toBe(
      '$gitlab-develop #12',
    );
    expect(buildIssueStartRequest('gitlab', 'claude', 12, ALL_GITLAB_SKILLS)).toBe(
      '/gitlab-develop #12',
    );
  });

  it('素の名前が揃っていれば、同梱skillがあっても素の名前を呼ぶ', () => {
    const all = new Set([...ALL_GITLAB_SKILLS, ...BUNDLED_GITLAB_SKILLS, ...USER_GITLAB_SKILLS]);
    expect(buildIssueStartRequest('gitlab', 'codex', 12, all)).toBe('$gitlab-develop #12');
  });

  it('素の名前が一部だけなら、同梱skillを呼ぶ', () => {
    const mixed = new Set(['gitlab-develop', ...BUNDLED_GITLAB_SKILLS]);
    expect(buildIssueStartRequest('gitlab', 'codex', 12, mixed)).toBe(
      '$codex-ext:gitlab-develop #12',
    );
    expect(buildIssueStartRequest('gitlab', 'claude', 12, mixed)).toBe(
      '/codex-ext:gitlab-develop #12',
    );
  });

  it('同梱が無く利用者skillだけなら、codex-ext-user:を呼ぶ', () => {
    expect(buildIssueStartRequest('gitlab', 'claude', 12, USER_GITLAB_SKILLS)).toBe(
      '/codex-ext-user:gitlab-develop #12',
    );
  });

  it('GitHubはskillの有無に関わらず従来どおり', () => {
    expect(buildIssueStartRequest('github', 'claude', 12, ALL_GITLAB_SKILLS)).toBe(
      'GitHub Issue #12に着手してください。',
    );
  });
});

describe('buildWorkActionPrompt', () => {
  it('skillがあるGitLabでは、状態ごとに今と同じskillを呼ぶ', () => {
    expect(
      buildWorkActionPrompt('gitlab', 'codex', 'inProgress', 12, undefined, ALL_GITLAB_SKILLS),
    ).toBe('$gitlab-develop #12');
    expect(buildWorkActionPrompt('gitlab', 'codex', 'review', 12, 34, ALL_GITLAB_SKILLS)).toBe(
      '$gitlab-review PR/MR #34',
    );
    expect(buildWorkActionPrompt('gitlab', 'claude', 'cleanup', 12, 34, ALL_GITLAB_SKILLS)).toBe(
      '/gitlab-cleanup PR/MR #34',
    );
  });

  it('skillが無いGitLabでは、どの状態でもskill名を送らない', () => {
    for (const status of ['inProgress', 'review', 'ciPending', 'ci', 'cleanup'] as const) {
      const text = buildWorkActionPrompt('gitlab', 'claude', status, 12, 34, NO_SKILLS);
      expect(text).not.toMatch(/[$/]gitlab-/);
      expect(text).toContain('glab ');
    }
  });

  it('3つ揃わない出どころだけなら、skillを呼ばず平文にする', () => {
    const onlyDevelop = new Set(['gitlab-develop']);
    for (const status of ['inProgress', 'review', 'cleanup'] as const) {
      const text = buildWorkActionPrompt('gitlab', 'codex', status, 12, 34, onlyDevelop);
      expect(text).not.toMatch(/[$/]gitlab-/);
    }
  });

  it('同梱skillが揃っていれば、状態ごとにcodex-ext:を呼ぶ', () => {
    expect(
      buildWorkActionPrompt('gitlab', 'codex', 'review', 12, 34, BUNDLED_GITLAB_SKILLS),
    ).toBe('$codex-ext:gitlab-review PR/MR #34');
    expect(
      buildWorkActionPrompt('gitlab', 'claude', 'cleanup', 12, 34, BUNDLED_GITLAB_SKILLS),
    ).toBe('/codex-ext:gitlab-cleanup PR/MR #34');
  });

  it('GitHubは従来どおりの平文', () => {
    expect(buildWorkActionPrompt('github', 'codex', 'review', 12, 34, ALL_GITLAB_SKILLS)).toBe(
      'PR/MR #34をレビューし、必要な対応を進めてください。',
    );
  });
});
