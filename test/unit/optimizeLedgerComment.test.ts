import { describe, expect, it } from 'vitest';
import {
  fetchPullRequestCommentBodies,
  postPullRequestComment,
  type CliCommandResult,
} from '../../src/orchestrator/forge';
import type { OptimizeTrialRecord } from '../../src/orchestrator/optimizeLedger';
import {
  buildLedgerComment,
  LEDGER_COMMENT_MAX_LENGTH,
  ledgerCommentMarker,
} from '../../src/orchestrator/optimizeLedgerComment';

const record = (trial: number, over: Partial<OptimizeTrialRecord> = {}): OptimizeTrialRecord => ({
  trial,
  at: '2026-11-16T00:00:00.000Z',
  llm: {
    hypothesis: `仮説${trial}`,
    prediction: '予測',
    approach: '方式',
    changeSummary: '要約',
  },
  correctness: { passed: true, detail: 'ok' },
  metric: { samples: 5, median: 80, spread: 1, significant: true },
  secondary: [],
  load: { loadAverage1m: 0, freeMemoryMb: 1000 },
  decision: { outcome: 'adopted', reason: '有意に改善' },
  ...over,
});

describe('buildLedgerComment', () => {
  it('基準値・最良値・試行ごとの仮説と採否と反証の要点を載せ、LLMが書いた部分に印を付ける', () => {
    const body = buildLedgerComment({
      loopId: 'run-1-T1',
      records: [
        record(1, { refutation: { verdict: 'holds', detail: '崩れない', engine: 'codex' } }),
        record(2, {
          decision: { outcome: 'rejected', reason: '反証役が反証した: 計測中だけ速い' },
          refutation: { verdict: 'refuted', detail: '計測中だけ速い', engine: 'codex' },
        }),
      ],
      baseline: 100,
      best: { metric: 80, trial: 1, commit: 'abc' },
      stopReason: '試行回数の予算を使い切った',
    });
    expect(body.split('\n')[0]).toBe(ledgerCommentMarker('run-1-T1', 2, 'abc'));
    expect(body).toContain('- 基準値: 100');
    expect(body).toContain('- 最良値: 80（試行 #1、commit abc）');
    expect(body).toContain('| 1 | 採用 |');
    expect(body).toContain('| 2 | 不採用 |');
    expect(body).toContain('- 仮説（LLMが書いた）: `仮説1`');
    expect(body).toContain('- 反証（反証できた、Codex）: `計測中だけ速い`（LLMが書いた）');
    expect(body).toContain('反証役が反証した（理由は反証の行）');
    expect(body).toContain('止めた理由: 試行回数の予算を使い切った');
  });

  it('LLMが書いた文はインラインコードに閉じ込め、囲いや表を壊せない', () => {
    const body = buildLedgerComment({
      loopId: 'x',
      records: [
        record(1, {
          llm: {
            hypothesis: '`@someone` ![img](http://e) | 表を壊す\n## 見出し',
            prediction: '',
            approach: '',
            changeSummary: '',
          },
        }),
      ],
    });
    expect(body).toContain(
      '- 仮説（LLMが書いた）: `ˋ@someoneˋ ![img](http://e) ｜ 表を壊す ## 見出し`',
    );
    expect(body).toContain('- 予測（LLMが書いた）: （空）');
    expect(body).not.toMatch(/^## 見出し/m);
  });

  it('長すぎるときは古い試行の詳細から省き、表は全試行を残す', () => {
    const long = 'あ'.repeat(300);
    const records = Array.from({ length: 200 }, (_, i) =>
      record(i + 1, {
        llm: { hypothesis: long, prediction: long, approach: long, changeSummary: long },
      }),
    );
    const body = buildLedgerComment({ loopId: 'x', records });
    expect(Array.from(body).length).toBeLessThanOrEqual(LEDGER_COMMENT_MAX_LENGTH);
    expect(body).toContain('| 1 | 採用 |');
    expect(body).toContain('| 200 | 採用 |');
    expect(body).toContain('#### 試行 #200');
    expect(body).not.toContain('#### 試行 #1（');
    expect(body).toMatch(/古い試行\d+件の詳細は長さの上限のため省いた/);
  });
});

describe('postPullRequestComment / fetchPullRequestCommentBodies', () => {
  const cli = (result: CliCommandResult) => {
    const calls: { command: string; args: readonly string[] }[] = [];
    return {
      calls,
      run: async (command: string, args: readonly string[]) => {
        calls.push({ command, args });
        return result;
      },
    };
  };
  const files: string[] = [];
  const fs = {
    writeTempFile: async (content: string) => {
      files.push(content);
      return '/tmp/x/body.md';
    },
    removeTempFile: async () => undefined,
  };

  it('GitHubはgh pr commentに本文のファイルを渡す', async () => {
    const c = cli({ code: 0, stdout: '', stderr: '' });
    const out = await postPullRequestComment(
      { cli: c, fs },
      { host: 'github', cwd: '/r', number: 7, body: '台帳' },
    );
    expect(out).toEqual({ ok: true });
    expect(c.calls[0]).toEqual({
      command: 'gh',
      args: ['pr', 'comment', '7', '--body-file=/tmp/x/body.md'],
    });
    expect(files).toContain('台帳');
  });

  it('GitLabはMRのnotesへ本文のファイルを渡し、失敗はメッセージで返す', async () => {
    const c = cli({ code: 1, stdout: '', stderr: 'denied' });
    const out = await postPullRequestComment(
      { cli: c, fs },
      { host: 'gitlab', cwd: '/r', number: 3, body: '台帳' },
    );
    expect(out.ok).toBe(false);
    expect(c.calls[0]?.command).toBe('glab');
    expect(c.calls[0]?.args).toEqual([
      'api',
      'projects/:id/merge_requests/3/notes',
      '--field=body=@/tmp/x/body.md',
    ]);
  });

  it('不正な番号・空の本文は投稿しない', async () => {
    const c = cli({ code: 0, stdout: '', stderr: '' });
    expect(
      (
        await postPullRequestComment(
          { cli: c, fs },
          { host: 'github', cwd: '/r', number: 0, body: 'a' },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await postPullRequestComment(
          { cli: c, fs },
          { host: 'github', cwd: '/r', number: 1, body: ' ' },
        )
      ).ok,
    ).toBe(false);
    expect(c.calls).toHaveLength(0);
  });

  it('コメントの本文を読む（GitHub・GitLab）。読めなければundefined', async () => {
    const gh = cli({ code: 0, stdout: '{"comments":[{"body":"a"},{"body":"b"}]}', stderr: '' });
    expect(
      await fetchPullRequestCommentBodies(gh, { host: 'github', cwd: '/r', number: 7 }),
    ).toEqual(['a', 'b']);
    const gl = cli({ code: 0, stdout: '[{"body":"n"}]', stderr: '' });
    expect(
      await fetchPullRequestCommentBodies(gl, { host: 'gitlab', cwd: '/r', number: 7 }),
    ).toEqual(['n']);
    const bad = cli({ code: 0, stdout: 'x', stderr: '' });
    expect(
      await fetchPullRequestCommentBodies(bad, { host: 'github', cwd: '/r', number: 7 }),
    ).toBeUndefined();
    const failed = cli({ code: 1, stdout: '', stderr: '' });
    expect(
      await fetchPullRequestCommentBodies(failed, { host: 'github', cwd: '/r', number: 7 }),
    ).toBeUndefined();
  });
});
