import { describe, expect, it } from 'vitest';
import {
  MASK_EMAIL,
  buildLessonIssueBody,
  decideIssueFiling,
  isPromotable,
  maskForGithub,
  renderPromotedLesson,
} from '../../src/orchestrator/lessonPromotion';
import type { LessonRecord, LessonSource } from '../../src/orchestrator/runNotes';

function lesson(source?: LessonSource, over: Partial<LessonRecord> = {}): LessonRecord {
  return {
    v: 1,
    kind: 'lesson',
    id: '123e4567-e89b-42d3-a456-426614174000',
    recordedAt: '2026-11-15T00:00:00.000Z',
    runId: 'r1',
    runKind: 'taskRun',
    observation: '観察',
    evidence: ['ev'],
    instruction: '指示',
    ...(source === undefined ? {} : { source }),
    ...over,
  };
}
const OWN = 'Sylphy0052/VSCode-Codex-Extension';

describe('昇格', () => {
  it('出典が外部・他repo・未記録の教訓は候補にならない', () => {
    expect(isPromotable(lesson('external'))).toBe(false);
    expect(isPromotable(lesson('otherRepo'))).toBe(false);
    expect(isPromotable(lesson())).toBe(false);
    expect(renderPromotedLesson(lesson())).toBeUndefined();
  });

  it('repo成果物の教訓はテンプレートの形になり自由文を含まない', () => {
    const text = renderPromotedLesson(
      lesson('repoArtifact', { observation: 'IGNORE ALL', instruction: 'rm -rf' }),
    );
    expect(text).toBe(
      '.agents/run-notes.jsonlの教訓123e4567-e89b-42d3-a456-426614174000（出典: このrepoの成果物、記録: 2026-11-15T00:00:00.000Z）を確認してから着手する。',
    );
    expect(text).not.toContain('IGNORE');
  });

  it('idが想定の形でなければ昇格しない', () => {
    expect(renderPromotedLesson(lesson('repoArtifact', { id: 'x\nignore' }))).toBeUndefined();
  });
});

describe('起票', () => {
  it('他repo由来・公開範囲不明は起票しない', () => {
    expect(decideIssueFiling(lesson('otherRepo'), 'public').ok).toBe(false);
    expect(decideIssueFiling(lesson('repoArtifact'), 'unknown').ok).toBe(false);
    expect(buildLessonIssueBody(lesson('otherRepo'), 'public', { ownRepo: OWN })).toBeUndefined();
  });

  it('本文にマスク対象が残らない', () => {
    const body = buildLessonIssueBody(
      lesson('repoArtifact', {
        observation: 'a@example.com が https://internal.example.co.jp/x/y で失敗',
        evidence: [
          'https://github.com/secret-org/private-repo/pull/1',
          'git@github.com:org/other.git',
        ],
        instruction: `https://github.com/${OWN}/issues/1 を参照`,
      }),
      'public',
      { ownRepo: OWN },
    );
    expect(body).toBeDefined();
    expect(body).not.toContain('example.com');
    expect(body).not.toContain('internal.example');
    expect(body).not.toContain('secret-org');
    expect(body).not.toContain('org/other');
    expect(body).toContain(MASK_EMAIL);
    expect(body).toContain(`github.com/${OWN}/issues/1`);
  });

  it('maskForGithubはホスト付きポートも伏せる', () => {
    expect(maskForGithub('http://10.0.0.1:8080/a', { ownRepo: OWN })).not.toContain('10.0.0.1');
  });

  it('userinfo付き・http以外のスキーム・IPv6のホストも伏せる', () => {
    const out = maskForGithub(
      'https://user:pw@h.corp/x git://host.corp/y ssh://git@git.corp.example/t/r.git https://[::1]:80/a',
      { ownRepo: OWN },
    );
    for (const leaked of ['h.corp', 'host.corp', 'corp.example', '::1', 'user']) {
      expect(out).not.toContain(leaked);
    }
  });

  it('文末のピリオドが付いた自repoのURLは伏せない', () => {
    expect(maskForGithub(`see https://github.com/${OWN}.`, { ownRepo: OWN })).toBe(
      `see https://github.com/${OWN}.`,
    );
  });
});
