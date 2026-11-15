import { describe, expect, it } from 'vitest';
import { createGithubRetrospectiveForge } from '../../src/orchestrator/runRetrospectiveForge';

type Res = { code: number; stdout: string; stderr: string };
const ok = (stdout: string): Res => ({ code: 0, stdout, stderr: '' });
const ng = (stderr = 'boom'): Res => ({ code: 1, stdout: '', stderr });

function setup(respond: (args: readonly string[]) => Res, gitRes: Res = ok('')) {
  const calls: string[][] = [];
  const forge = createGithubRetrospectiveForge(
    {
      git: { run: () => Promise.resolve(gitRes) },
      cli: {
        run: (_c: string, args: readonly string[]) => {
          calls.push([...args]);
          return Promise.resolve(respond(args));
        },
      },
    } as never,
    {
      writeTempFile: () => Promise.resolve('/tmp/body'),
      removeTempFile: () => Promise.resolve(),
    },
  );
  return { forge, calls };
}

describe('createGithubRetrospectiveForge', () => {
  it('isGithub: originのホストで判定する', async () => {
    expect(await setup(() => ok(''), ok('git@github.com:o/r.git')).forge.isGithub('/r')).toBe(true);
    expect(await setup(() => ok(''), ok('git@gitlab.com:o/r.git')).forge.isGithub('/r')).toBe(
      false,
    );
    expect(await setup(() => ok(''), ng()).forge.isGithub('/r')).toBe(false);
  });

  it('repoInfo: 名前が取れなければ公開範囲も信用しない', async () => {
    const good = setup(() => ok('{"nameWithOwner":"o/r","visibility":"PUBLIC"}'));
    expect(await good.forge.repoInfo('/r')).toEqual({ nameWithOwner: 'o/r', visibility: 'public' });
    for (const [v, want] of [
      ['PRIVATE', 'private'],
      ['INTERNAL', 'internal'],
      ['zzz', 'unknown'],
      [1, 'unknown'],
    ] as const) {
      const s = setup(() => ok(JSON.stringify({ nameWithOwner: 'o/r', visibility: v })));
      expect((await s.forge.repoInfo('/r')).visibility).toBe(want);
    }
    const noName = setup(() => ok('{"visibility":"PUBLIC"}'));
    expect(await noName.forge.repoInfo('/r')).toEqual({ nameWithOwner: '', visibility: 'unknown' });
    expect(await setup(() => ng()).forge.repoInfo('/r')).toEqual({
      nameWithOwner: '',
      visibility: 'unknown',
    });
  });

  it('listSelfImproveIssueNumbers: 数値のnumberだけ拾い、失敗はundefined', async () => {
    const s = setup(() => ok('[{"number":1},null,{"number":"x"},{"number":4}]'));
    expect(await s.forge.listSelfImproveIssueNumbers('/r')).toEqual([1, 4]);
    expect(await setup(() => ng()).forge.listSelfImproveIssueNumbers('/r')).toBeUndefined();
    expect(await setup(() => ok('{}')).forge.listSelfImproveIssueNumbers('/r')).toBeUndefined();
  });

  it('findIssueByKey: 本文にバッククォート付きキーがあるものだけ採る', async () => {
    const list = [
      null,
      { number: 1, body: 'k1' },
      { number: 'x', body: '`k1`' },
      { number: 2, body: 3 },
      { number: 3, body: 'a `k1` b' },
    ];
    expect(await setup(() => ok(JSON.stringify(list))).forge.findIssueByKey('/r', 'k1')).toBe(3);
    expect(await setup(() => ok('[]')).forge.findIssueByKey('/r', 'k1')).toBeUndefined();
    expect(await setup(() => ok('{}')).forge.findIssueByKey('/r', 'k1')).toBe('error');
    expect(await setup(() => ng()).forge.findIssueByKey('/r', 'k1')).toBe('error');
  });

  it('ensureLabel: 既知ラベルは色を付け、未知はデフォルト色。失敗しても投げない', async () => {
    const s = setup(() => ng('exists'));
    await s.forge.ensureLabel('/r', 'self-improve');
    await s.forge.ensureLabel('/r', 'other');
    expect(s.calls[0]).toContain('--color=5319e7');
    expect(s.calls[1]).toContain('--color=ededed');
  });

  it('createIssue: 番号を返し、失敗・番号不明はokでない', async () => {
    const issue = { title: 't', body: 'b', labels: ['self-improve', 'research'] };
    const s = setup(() => ok('https://github.com/o/r/issues/12\n'));
    expect(await s.forge.createIssue('/r', issue)).toEqual({ ok: true, issueNumber: 12 });
    expect(s.calls[0].join(' ')).toContain('self-improve,research');
    const failed = await setup(() => ng('denied')).forge.createIssue('/r', issue);
    expect(failed.ok).toBe(false);
    expect(await setup(() => ok('no url')).forge.createIssue('/r', issue)).toEqual({
      ok: false,
      message: '起票したIssueの番号を取れない',
    });
    const badTitle = await setup(() => ok('')).forge.createIssue('/r', { ...issue, title: 'a\nb' });
    expect(badTitle.ok).toBe(false);
  });

  it('readProtectedPaths: git showの結果を解釈し、失敗はundefined', async () => {
    expect(await setup(() => ok(''), ok('# c\nsrc/a.ts\n')).forge.readProtectedPaths('/r')).toEqual(
      ['src/a.ts'],
    );
    expect(await setup(() => ok(''), ng()).forge.readProtectedPaths('/r')).toBeUndefined();
  });

  it('readIssueInfo: title必須。stateがOPENかとラベル名を返す', async () => {
    const s = setup(() =>
      ok(JSON.stringify({ state: 'OPEN', title: 'T', labels: [{ name: 'a' }, { name: 2 }, null] })),
    );
    expect(await s.forge.readIssueInfo('/r', 5)).toEqual({ open: true, labels: ['a'], title: 'T' });
    const closed = setup(() => ok('{"state":"CLOSED","title":"T","labels":"x"}'));
    expect(await closed.forge.readIssueInfo('/r', 5)).toEqual({
      open: false,
      labels: [],
      title: 'T',
    });
    expect(await setup(() => ok('{"state":"OPEN"}')).forge.readIssueInfo('/r', 5)).toBeUndefined();
    expect(await setup(() => ng()).forge.readIssueInfo('/r', 5)).toBeUndefined();
  });
});

describe('readMergeState', () => {
  const issueView = (o: object): Res => ok(JSON.stringify(o));
  const merged = {
    state: 'MERGED',
    mergedAt: '2026-01-01T00:00:00Z',
    mergeCommit: { oid: 'abc123' },
  };

  function flow(issue: Res, prs: Record<string, Res>, pkg: Res = ok('{"version":"1.2.3"}')) {
    return setup((args) => {
      if (args[0] === 'issue') {
        return issue;
      }
      if (args[0] === 'pr') {
        return prs[args[2]] ?? ng();
      }
      return pkg;
    });
  }

  it('読めない・OPENの扱い', async () => {
    expect(await flow(ng(), {}).forge.readMergeState('/r', 1)).toEqual({
      state: 'unknown',
      reason: 'Issue #1を読めない',
    });
    expect(await flow(issueView({ state: 'OPEN' }), {}).forge.readMergeState('/r', 1)).toEqual({
      state: 'open',
    });
  });

  it('NOT_PLANNED・参照PRなし・参照が配列でないときはcloseのみ', async () => {
    for (const o of [
      {
        state: 'CLOSED',
        stateReason: 'NOT_PLANNED',
        closedByPullRequestsReferences: [{ number: 2 }],
      },
      { state: 'CLOSED', closedByPullRequestsReferences: [] },
      { state: 'CLOSED', closedByPullRequestsReferences: null },
      { state: 'CLOSED', closedByPullRequestsReferences: [null, { number: 'x' }] },
    ]) {
      expect(await flow(issueView(o), {}).forge.readMergeState('/r', 1)).toEqual({
        state: 'closedWithoutMerge',
      });
    }
  });

  it('merged済みPRの版を読んで返す', async () => {
    const s = flow(
      issueView({ state: 'CLOSED', closedByPullRequestsReferences: [{ number: 7 }] }),
      {
        '7': ok(JSON.stringify(merged)),
      },
    );
    expect(await s.forge.readMergeState('/r', 1)).toEqual({
      state: 'merged',
      mergedAt: Date.parse('2026-01-01T00:00:00Z'),
      version: '1.2.3',
      pullRequestNumber: 7,
      mergeCommit: 'abc123',
    });
  });

  it('merge済みでないPRは飛ばして次へ、全部merge済みでなければclose', async () => {
    const issue = issueView({
      state: 'CLOSED',
      closedByPullRequestsReferences: [{ number: 6 }, { number: 7 }, { number: 8 }, { number: 9 }],
    });
    const prs = {
      '6': ng(),
      '7': ok(JSON.stringify({ state: 'CLOSED' })),
      '8': ok(JSON.stringify({ ...merged, mergedAt: 5 })),
      '9': ok(JSON.stringify({ ...merged, mergeCommit: null })),
    };
    expect(await flow(issue, prs).forge.readMergeState('/r', 1)).toEqual({
      state: 'closedWithoutMerge',
    });
    const second = flow(issue, { ...prs, '7': ok(JSON.stringify(merged)) });
    expect((await second.forge.readMergeState('/r', 1)).state).toBe('merged');
  });

  it('版が読めなければunknown', async () => {
    const issue = issueView({ state: 'CLOSED', closedByPullRequestsReferences: [{ number: 7 }] });
    const prs = { '7': ok(JSON.stringify(merged)) };
    for (const pkg of [ng(), ok('not json'), ok('{"version":1}')]) {
      expect(await flow(issue, prs, pkg).forge.readMergeState('/r', 1)).toEqual({
        state: 'unknown',
        reason: 'PR #7の版を読めない',
      });
    }
  });
});
