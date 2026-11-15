import { describe, expect, it } from 'vitest';

import {
  appendToRoadmapReady,
  candidatesFromLessons,
  classifyPluginFiles,
  describeSyncState,
  fileToPluginRoadmap,
  type PluginImprovementCandidate,
  type PluginRoadmapDeps,
  type PluginRoadmapForge,
} from '../../src/orchestrator/pluginRoadmap';
import type { LessonRecord } from '../../src/orchestrator/runNotes';

interface Fake {
  forge: PluginRoadmapForge;
  roadmapBody: { value: string };
  created: { title: string; body: string }[];
  research: { title: string; body: string }[];
}

function fakeForge(opts: { existing?: number; roadmap?: 'error' | 'none' } = {}): Fake {
  const roadmapBody = { value: '## READY\n- [ ] #1 a\n\n## DONE\n' };
  const created: { title: string; body: string }[] = [];
  const research: { title: string; body: string }[] = [];
  const forge: PluginRoadmapForge = {
    repoVisibility: async () => 'public',
    readRoadmap: async () =>
      opts.roadmap === 'error'
        ? 'error'
        : opts.roadmap === 'none'
          ? undefined
          : { issueNumber: 10, body: roadmapBody.value },
    readResearch: async () => ({ issueNumber: 11, body: '## 提案\n' }),
    findIssueByKey: async () => opts.existing,
    createIssue: async (_r, issue) => {
      created.push(issue);
      return { ok: true, issueNumber: 50 };
    },
    createResearchIssue: async (_r, issue) => {
      research.push(issue);
      return { ok: true, issueNumber: 11 };
    },
    updateIssueBody: async (_r, n, body) => {
      if (n === 10) {
        roadmapBody.value = body;
      }
      return true;
    },
    readHeadCommit: async () => 'a'.repeat(40),
  };
  return { forge, roadmapBody, created, research };
}

function deps(
  fake: Fake,
  candidates: PluginImprovementCandidate[],
  installed: string | 'same' | 'none' = 'same',
): PluginRoadmapDeps {
  return {
    repo: 'me/plugin',
    forge: fake.forge,
    candidates: async () => candidates,
    installedCommit: async () =>
      installed === 'same' ? 'a'.repeat(40) : installed === 'none' ? undefined : installed,
  };
}

const skill: PluginImprovementCandidate = {
  key: 'k1',
  title: 'skillを直す',
  body: '本文',
  files: ['skills/foo/SKILL.md'],
  source: 'repoArtifact',
};

describe('classifyPluginFiles', () => {
  it('skill本文だけならskill', () => {
    expect(classifyPluginFiles(['skills/foo/SKILL.md'])).toBe('skill');
    expect(classifyPluginFiles(['claude-home/skills/foo/ref.md'])).toBe('skill');
  });
  it('hook・設定・規約・空・不正パスはother', () => {
    expect(classifyPluginFiles([])).toBe('other');
    expect(classifyPluginFiles(['hooks/x.py'])).toBe('other');
    expect(classifyPluginFiles(['skills/foo/SKILL.md', 'settings.json'])).toBe('other');
    expect(classifyPluginFiles(['skills/../hooks/x.md'])).toBe('other');
    expect(classifyPluginFiles(['/skills/foo/SKILL.md'])).toBe('other');
  });
});

describe('describeSyncState', () => {
  it('一致', () => {
    expect(describeSyncState({ pluginHead: 'abc', installed: 'abc' })).toContain('一致');
  });
  it('不一致', () => {
    expect(describeSyncState({ pluginHead: 'abc', installed: 'def' })).toContain('不一致');
  });
  it('取得不能は確かめられない', () => {
    const text = describeSyncState({ pluginHead: 'abc', installed: undefined });
    expect(text).toContain('確かめられない');
    expect(text).toContain('不明');
  });
});

describe('appendToRoadmapReady', () => {
  it('READY一覧の末尾へ足し、同じ番号は足さない', () => {
    const r = appendToRoadmapReady('## READY\n- [ ] #1 a\n\n## DONE\n', 5, 't');
    expect(r.added).toBe(true);
    expect(r.body).toBe('## READY\n- [ ] #1 a\n- [ ] #5 t\n\n## DONE\n');
    expect(appendToRoadmapReady(r.body, 5, 't').added).toBe(false);
  });
});

describe('fileToPluginRoadmap', () => {
  it('skill本文の改善を起票してロードマップ本文へ載せ、同期の状態を記録する', async () => {
    const fake = fakeForge();
    const r = await fileToPluginRoadmap(deps(fake, [skill]));
    expect(fake.created).toHaveLength(1);
    expect(fake.roadmapBody.value).toContain('#50');
    expect(r.notes[0]).toContain('同期の状態');
    expect(r.notes[0]).toContain('一致');
  });

  it('skill本文以外は起票せず調査Issueへ提案する', async () => {
    const fake = fakeForge();
    const r = await fileToPluginRoadmap(
      deps(fake, [{ ...skill, key: 'k2', files: ['hooks/x.py'] }]),
    );
    expect(fake.created).toHaveLength(0);
    expect(fake.roadmapBody.value).not.toContain('#50');
    expect(r.notes.join('\n')).toContain('k2');
  });

  it('同期が不一致・取得不能でも記録に残す', async () => {
    const mismatch = await fileToPluginRoadmap(deps(fakeForge(), [], 'b'.repeat(40)));
    expect(mismatch.notes[0]).toContain('不一致');
    const unknown = await fileToPluginRoadmap(deps(fakeForge(), [], 'none'));
    expect(unknown.notes[0]).toContain('確かめられない');
  });

  it('起票済みでロードマップに無ければ載せ直す', async () => {
    const fake = fakeForge({ existing: 60 });
    const r = await fileToPluginRoadmap(deps(fake, [skill]));
    expect(fake.created).toHaveLength(0);
    expect(fake.roadmapBody.value).toContain('#60');
    expect(r.notes.join('\n')).toContain('載せ直した');
  });

  it('ロードマップを読めなければ起票しない', async () => {
    const fake = fakeForge({ roadmap: 'error' });
    const r = await fileToPluginRoadmap(deps(fake, [skill]));
    expect(fake.created).toHaveLength(0);
    expect(r.notes.join('\n')).toContain('起票しない');
  });

  it('他repo由来の教訓は起票しない', async () => {
    const fake = fakeForge();
    await fileToPluginRoadmap(deps(fake, [{ ...skill, source: 'otherRepo' }]));
    expect(fake.created).toHaveLength(0);
  });
});

describe('candidatesFromLessons', () => {
  const lesson = (over: Partial<LessonRecord>): LessonRecord => ({
    v: 1,
    kind: 'lesson',
    id: '12345678-aaaa',
    recordedAt: '2026-11-15T00:00:00Z',
    runId: 'r1',
    runKind: 'taskRun',
    observation: 'o',
    evidence: [],
    instruction: 'i',
    ...over,
  });

  it('pluginのパスを含む、このrunの教訓だけ候補にする', () => {
    const c = candidatesFromLessons(
      [
        lesson({ instruction: 'skills/foo/SKILL.mdの手順を直す' }),
        lesson({ id: 'bbbbbbbb', instruction: 'このrepoのテストを直す' }),
        lesson({ id: 'cccccccc', runId: 'r2', instruction: 'skills/foo/SKILL.md' }),
      ],
      'r1',
    );
    expect(c).toHaveLength(1);
    expect(c[0]?.files).toEqual(['skills/foo/SKILL.md']);
    expect(c[0]?.source).toBe('external');
    expect(classifyPluginFiles(c[0]?.files ?? [])).toBe('skill');
  });

  it('hookのパスを含む教訓はother扱い', () => {
    const c = candidatesFromLessons([lesson({ instruction: 'hooks/guard.pyを直す' })], 'r1');
    expect(classifyPluginFiles(c[0]?.files ?? [])).toBe('other');
  });
});
