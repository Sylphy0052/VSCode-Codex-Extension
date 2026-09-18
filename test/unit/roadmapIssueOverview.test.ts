import { describe, expect, it } from 'vitest';

import type { CliCommandRunner } from '../../src/orchestrator/forge';
import {
  createCliIssueListPort,
  parseRoadmapMarkdown,
  reconcileRoadmapIssues,
  type RoadmapIssueSummary,
} from '../../src/orchestrator/roadmap';
import type { GitCommandRunner } from '../../src/orchestrator/worktree';

/**
 * ワークフローViewのロードマップ欄（Issue #1257）が使う突き合わせと、その材料を取る
 * Issue一覧ポートの状態指定のテスト。
 */

const MARKDOWN = [
  '# 認証の刷新',
  '',
  '## フェーズ1',
  '',
  '- [x] R1 設計を決める',
  '  - Issue: #10',
  '- [ ] R2 実装する',
  '  - Issue: #11',
  '',
  '## フェーズ2',
  '',
  '- [ ] R3 まだ起票していない',
  '- [ ] R4 一覧に無いIssue',
  '  - Issue: #999',
].join('\n');

function issue(number: number, state: string, extra?: Partial<RoadmapIssueSummary>) {
  return { number, title: `issue ${number}`, state, ...extra } satisfies RoadmapIssueSummary;
}

describe('reconcileRoadmapIssues', () => {
  it('Issueの状態をopen/closed/notFound/unlinkedへ振り分ける', () => {
    const overview = reconcileRoadmapIssues(parseRoadmapMarkdown(MARKDOWN), [
      issue(10, 'CLOSED'),
      issue(11, 'OPEN'),
    ]);

    expect(overview.title).toBe('認証の刷新');
    expect(overview.issuesAvailable).toBe(true);
    expect(overview.phases.map((p) => p.name)).toEqual(['フェーズ1', 'フェーズ2']);
    expect(overview.phases[0]?.items.map((i) => [i.id, i.checked, i.issueState])).toEqual([
      ['R1', true, 'closed'],
      ['R2', false, 'open'],
    ]);
    expect(overview.phases[1]?.items.map((i) => [i.id, i.issueState])).toEqual([
      ['R3', 'unlinked'],
      ['R4', 'notFound'],
    ]);
  });

  it('GitLabのopened/closedも同じ語彙へ寄せる', () => {
    const overview = reconcileRoadmapIssues(parseRoadmapMarkdown(MARKDOWN), [
      issue(10, 'closed'),
      issue(11, 'opened'),
    ]);

    expect(overview.phases[0]?.items.map((i) => i.issueState)).toEqual(['closed', 'open']);
  });

  it('状態を解釈できなければunknownにする', () => {
    const overview = reconcileRoadmapIssues(parseRoadmapMarkdown(MARKDOWN), [issue(10, 'draft')]);

    expect(overview.phases[0]?.items[0]?.issueState).toBe('unknown');
  });

  it('一覧が取れなければIssue行のある項目はunknown、無い項目はunlinkedのまま', () => {
    const overview = reconcileRoadmapIssues(parseRoadmapMarkdown(MARKDOWN), undefined);

    expect(overview.issuesAvailable).toBe(false);
    expect(overview.phases[0]?.items.map((i) => i.issueState)).toEqual(['unknown', 'unknown']);
    expect(overview.phases[1]?.items.map((i) => i.issueState)).toEqual(['unlinked', 'unknown']);
  });

  it('https以外のURLは載せない', () => {
    const overview = reconcileRoadmapIssues(parseRoadmapMarkdown(MARKDOWN), [
      issue(10, 'open', { url: 'https://example.com/issues/10' }),
      issue(11, 'open', { url: 'javascript:alert(1)' }),
    ]);

    expect(overview.phases[0]?.items[0]?.issueUrl).toBe('https://example.com/issues/10');
    expect(overview.phases[0]?.items[1]?.issueUrl).toBeUndefined();
  });

  it('Issueのタイトルは無害化して載せる', () => {
    const overview = reconcileRoadmapIssues(parseRoadmapMarkdown(MARKDOWN), [
      issue(10, 'open', { title: '改行\nを含むタイトル' }),
    ]);

    expect(overview.phases[0]?.items[0]?.issueTitle).not.toContain('\n');
  });
});

describe('createCliIssueListPort の state 指定', () => {
  function fakeGit(remoteUrl: string): GitCommandRunner {
    return {
      run: async (args) => {
        if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return { code: 0, stdout: `${remoteUrl}\n`, stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
    };
  }

  function recordingCli(stdout: string) {
    const calls: { command: string; args: readonly string[] }[] = [];
    const cli: CliCommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout, stderr: '' };
      },
    };
    return { cli, calls };
  }

  it('既定ではopenのみ（--state allを付けない）', async () => {
    const { cli, calls } = recordingCli('[]');
    await createCliIssueListPort(fakeGit('git@github.com:o/r.git'), cli).listIssues('/w');

    expect(calls[0]?.args).not.toContain('--state');
  });

  it('state: all なら gh へ --state all を渡す', async () => {
    const { cli, calls } = recordingCli('[]');
    await createCliIssueListPort(fakeGit('git@github.com:o/r.git'), cli, {
      state: 'all',
    }).listIssues('/w');

    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--state', 'all']));
    expect(calls[0]?.args.join(' ')).toContain('number,title,body,labels,state,url');
  });

  it('state: all なら glab へ --all を渡す', async () => {
    const { cli, calls } = recordingCli('[]');
    await createCliIssueListPort(fakeGit('git@gitlab.com:o/r.git'), cli, {
      state: 'all',
    }).listIssues('/w');

    expect(calls[0]?.command).toBe('glab');
    expect(calls[0]?.args).toContain('--all');
  });

  it('GitHubのurl・GitLabのweb_urlを拾う', async () => {
    const github = recordingCli(
      JSON.stringify([{ number: 1, title: 'a', url: 'https://github.com/o/r/issues/1' }]),
    );
    const fromGitHub = await createCliIssueListPort(
      fakeGit('git@github.com:o/r.git'),
      github.cli,
    ).listIssues('/w');
    expect(fromGitHub?.[0]?.url).toBe('https://github.com/o/r/issues/1');

    const gitlab = recordingCli(
      JSON.stringify([{ iid: 2, title: 'b', web_url: 'https://gitlab.com/o/r/-/issues/2' }]),
    );
    const fromGitLab = await createCliIssueListPort(
      fakeGit('git@gitlab.com:o/r.git'),
      gitlab.cli,
    ).listIssues('/w');
    expect(fromGitLab?.[0]?.url).toBe('https://gitlab.com/o/r/-/issues/2');
  });
});
