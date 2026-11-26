import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createGithubPluginRoadmapForge,
  isPluginRepoName,
  readSyncedCommit,
} from '../../src/orchestrator/pluginRoadmapForge';

type Res = { code: number; stdout: string; stderr: string };
const ok = (stdout: string): Res => ({ code: 0, stdout, stderr: '' });
const ng = (stderr = 'boom'): Res => ({ code: 1, stdout: '', stderr });

function setup(respond: (args: readonly string[]) => Res) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const written: string[] = [];
  const forge = createGithubPluginRoadmapForge(
    {
      git: { run: () => Promise.resolve(ok('')) },
      cli: {
        run: (_c: string, args: readonly string[]) => {
          calls.push([...args]);
          return Promise.resolve(respond(args));
        },
      },
    } as never,
    '/cwd',
    {
      writeTempFile: (c: string) => {
        written.push(c);
        return Promise.resolve('/tmp/body');
      },
      removeTempFile: (t: string) => {
        removed.push(t);
        return Promise.resolve();
      },
    },
  );
  return { forge, calls, removed, written };
}

const REPO = 'o/r';

describe('isPluginRepoName', () => {
  it('owner/nameだけを受け、先頭-や余分な/を弾く', () => {
    expect(isPluginRepoName('o/r.x_y-z')).toBe(true);
    for (const bad of ['', 'o', '-o/r', 'o/r/s', 'o/ r', 'o/']) {
      expect(isPluginRepoName(bad)).toBe(false);
    }
  });
});

describe('createGithubPluginRoadmapForge', () => {
  it('repoVisibility: 値の対応と失敗・不正名はunknown', async () => {
    for (const [v, want] of [
      ['PUBLIC', 'public'],
      ['private', 'private'],
      ['Internal', 'internal'],
      ['x', 'unknown'],
    ] as const) {
      const { forge } = setup(() => ok(JSON.stringify({ visibility: v })));
      expect(await forge.repoVisibility(REPO)).toBe(want);
    }
    expect(await setup(() => ng()).forge.repoVisibility(REPO)).toBe('unknown');
    expect(await setup(() => ok('{"visibility":1}')).forge.repoVisibility(REPO)).toBe('unknown');
    const bad = setup(() => ok('{}'));
    expect(await bad.forge.repoVisibility('-x/y')).toBe('unknown');
    expect(bad.calls).toEqual([]);
  });

  it('readRoadmap/readResearch: ラベルで引き、無ければundefined、壊れていればerror', async () => {
    const s = setup(() => ok('[{"number":3,"body":"B"}]'));
    expect(await s.forge.readRoadmap(REPO)).toEqual({ issueNumber: 3, body: 'B' });
    expect(await s.forge.readResearch(REPO)).toEqual({ issueNumber: 3, body: 'B' });
    expect(s.calls[0]).toContain('--label=roadmap');
    expect(s.calls[1]).toContain('--label=research');
    expect(await setup(() => ok('[]')).forge.readRoadmap(REPO)).toBeUndefined();
    expect(await setup(() => ok('[{"number":3}]')).forge.readRoadmap(REPO)).toEqual({
      issueNumber: 3,
      body: '',
    });
    expect(await setup(() => ok('[{"number":"3"}]')).forge.readRoadmap(REPO)).toBe('error');
    expect(await setup(() => ok('{}')).forge.readRoadmap(REPO)).toBe('error');
    expect(await setup(() => ng()).forge.readRoadmap(REPO)).toBe('error');
    expect(await setup(() => ok('[]')).forge.readRoadmap('bad')).toBe('error');
  });

  it('findIssueByKey: キー入りの本文だけ拾い、roadmap/researchラベルは除く', async () => {
    const key = 'k1';
    const marker = `<!-- self-improve-key: ${key} -->`;
    const list = [
      null,
      { number: 1, body: marker, labels: [{ name: 'roadmap' }] },
      { number: 2, body: marker, labels: [{ name: 'research' }] },
      { number: 3, body: 'no marker', labels: null },
      { number: 4, body: 5 },
      { number: 'x', body: marker },
      { number: 5, body: marker, labels: [{ name: 'bug' }, null] },
    ];
    const s = setup(() => ok(JSON.stringify(list)));
    expect(await s.forge.findIssueByKey(REPO, key)).toBe(5);
    expect(await setup(() => ok('[]')).forge.findIssueByKey(REPO, key)).toBeUndefined();
    expect(await setup(() => ok('{}')).forge.findIssueByKey(REPO, key)).toBe('error');
    expect(await setup(() => ng()).forge.findIssueByKey(REPO, key)).toBe('error');
    expect(await setup(() => ok('[]')).forge.findIssueByKey('bad', key)).toBe('error');
  });

  it('createIssue: 番号を返し、タイトルの改行は潰し、一時ファイルは必ず消す', async () => {
    const s = setup(() => ok('https://github.com/o/r/issues/42\n'));
    expect(await s.forge.createIssue(REPO, { title: 'a\nb', body: 'BODY' })).toEqual({
      ok: true,
      issueNumber: 42,
    });
    expect(s.calls[0]).toContain('--title=a b');
    expect(s.calls[0]).toContain('--body-file=/tmp/body');
    expect(s.written).toEqual(['BODY']);
    expect(s.removed).toEqual(['/tmp/body']);
  });

  it('createIssue: 失敗・番号不明・不正名はokでない', async () => {
    const f = setup(() => ng('  x  '));
    expect(await f.forge.createIssue(REPO, { title: 't', body: 'b' })).toEqual({
      ok: false,
      message: 'x',
    });
    expect(f.removed).toEqual(['/tmp/body']);
    const empty = setup(() => ng(''));
    expect(await empty.forge.createIssue(REPO, { title: 't', body: 'b' })).toEqual({
      ok: false,
      message: 'gh issue createが失敗',
    });
    const noNum = setup(() => ok('created'));
    expect(await noNum.forge.createIssue(REPO, { title: 't', body: 'b' })).toEqual({
      ok: false,
      message: '起票したIssueの番号を取れない',
    });
    const bad = setup(() => ok(''));
    expect(await bad.forge.createIssue('bad', { title: 't', body: 'b' })).toEqual({
      ok: false,
      message: 'pluginのrepo名が不正',
    });
    expect(bad.written).toEqual([]);
  });

  it('createResearchIssue: ラベルを作ってからresearchラベル付きで起票する', async () => {
    const s = setup((args) => (args[0] === 'label' ? ng() : ok('https://x/issues/7')));
    expect(await s.forge.createResearchIssue(REPO, { title: 't', body: 'b' })).toEqual({
      ok: true,
      issueNumber: 7,
    });
    expect(s.calls[0]?.slice(0, 2)).toEqual(['label', 'create']);
    expect(s.calls[1]).toContain('--label=research');
  });

  it('updateIssueBody: 成否を返し、不正名は何もしない', async () => {
    const s = setup(() => ok(''));
    expect(await s.forge.updateIssueBody(REPO, 9, 'NEW')).toBe(true);
    expect(s.calls[0]).toContain('9');
    expect(s.removed).toEqual(['/tmp/body']);
    expect(await setup(() => ng()).forge.updateIssueBody(REPO, 9, 'NEW')).toBe(false);
    const bad = setup(() => ok(''));
    expect(await bad.forge.updateIssueBody('bad', 9, 'NEW')).toBe(false);
    expect(bad.calls).toEqual([]);
  });

  it('readHeadCommit: SHAの形だけ受ける', async () => {
    expect(await setup(() => ok('abcdef1234\n')).forge.readHeadCommit(REPO)).toBe('abcdef1234');
    expect(await setup(() => ok('zzz')).forge.readHeadCommit(REPO)).toBeUndefined();
    expect(await setup(() => ng()).forge.readHeadCommit(REPO)).toBeUndefined();
    expect(await setup(() => ok('abcdef1')).forge.readHeadCommit('bad')).toBeUndefined();
  });
});

describe('readSyncedCommit', () => {
  it('パス空・読めない・SHAでないはundefined、先頭語がSHAなら返す', async () => {
    expect(await readSyncedCommit('')).toBeUndefined();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'synced-'));
    try {
      expect(await readSyncedCommit(path.join(dir, 'none'))).toBeUndefined();
      const f = path.join(dir, 'f');
      await writeFile(f, 'abcdef1234 extra\n');
      expect(await readSyncedCommit(f)).toBe('abcdef1234');
      await writeFile(f, 'nothex\n');
      expect(await readSyncedCommit(f)).toBeUndefined();
      await writeFile(f, '');
      expect(await readSyncedCommit(f)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
