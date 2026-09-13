import { describe, expect, it } from 'vitest';
import {
  AUTO_CLAUDE_MODEL,
  buildClaudeEvaluatorArgs,
  buildCodexEvaluatorArgs,
  readClaudeResult,
  redactEvaluatorPrompt,
  resolveEvaluatorProvider,
} from '../../src/loop/goalEvaluatorProcess';
import type { GoalEvaluatorInput } from '../../src/loop/goalLoop';

describe('resolveEvaluatorProvider', () => {
  it('inherit なら会話しているCLIをそのまま使う', () => {
    expect(resolveEvaluatorProvider('inherit', 'claude')).toBe('claude');
    expect(resolveEvaluatorProvider('inherit', 'codex')).toBe('codex');
  });

  it('明示された指定は会話しているCLIより優先する', () => {
    expect(resolveEvaluatorProvider('codex', 'claude')).toBe('codex');
    expect(resolveEvaluatorProvider('claude', 'codex')).toBe('claude');
  });
});

describe('buildClaudeEvaluatorArgs', () => {
  it('built-inツールを無効化する', () => {
    const args = buildClaudeEvaluatorArgs('auto');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('利用者の設定（CLAUDE.md・hooks・skills）を読ませない', () => {
    // これが無いと、リポジトリ直下で呼んだときに利用者側の規約がEvaluatorへ混ざる（実測）
    const args = buildClaudeEvaluatorArgs('auto');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('前回の評価セッションを引き継がない（毎ターンstateless）', () => {
    const args = buildClaudeEvaluatorArgs('auto');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--session-id');
  });

  it('応答をJSONで受け取る', () => {
    const args = buildClaudeEvaluatorArgs('auto');
    expect(args).toContain('-p');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('auto なら軽量モデル、指定があればそれを使う', () => {
    expect(buildClaudeEvaluatorArgs('auto')).toContain(AUTO_CLAUDE_MODEL);
    expect(buildClaudeEvaluatorArgs('')).toContain(AUTO_CLAUDE_MODEL);
    const explicit = buildClaudeEvaluatorArgs('claude-sonnet-5');
    expect(explicit[explicit.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });
});

describe('buildCodexEvaluatorArgs', () => {
  it('書き込みを伴う操作をサンドボックスで塞ぐ（--tools "" に相当）', () => {
    const args = buildCodexEvaluatorArgs('auto', '/tmp/out.txt');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('セッションを残さず、利用者の設定も読ませない', () => {
    const args = buildCodexEvaluatorArgs('auto', '/tmp/out.txt');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
  });

  it('前回の評価セッションを引き継がない（毎ターンstateless）', () => {
    const args = buildCodexEvaluatorArgs('auto', '/tmp/out.txt');
    expect(args).not.toContain('resume');
    expect(args).not.toContain('fork');
    expect(args[0]).toBe('exec');
  });

  it('最終メッセージの書き出し先を渡す', () => {
    const args = buildCodexEvaluatorArgs('auto', '/tmp/out.txt');
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/out.txt');
  });

  it('auto ならモデルを指定しない', () => {
    expect(buildCodexEvaluatorArgs('auto', '/tmp/out.txt')).not.toContain('-m');
    const explicit = buildCodexEvaluatorArgs('gpt-5-codex', '/tmp/out.txt');
    expect(explicit[explicit.indexOf('-m') + 1]).toBe('gpt-5-codex');
  });
});

describe('readClaudeResult', () => {
  it('--output-format json の result を取り出す', () => {
    expect(readClaudeResult('{"type":"result","result":"{\\"verdict\\":\\"continue\\"}"}')).toBe(
      '{"verdict":"continue"}',
    );
  });

  it('JSONでなければ本文としてそのまま返す（出力形式が変わっても壊さない）', () => {
    expect(readClaudeResult('{"verdict":"achieved"}\n')).toBe('{"verdict":"achieved"}\n');
  });

  it('空なら未取得として扱う', () => {
    expect(readClaudeResult('   ')).toBeUndefined();
  });

  it('result が文字列でなければ本文へ倒す', () => {
    expect(readClaudeResult('{"result":42}')).toBe('{"result":42}');
  });
});

describe('redactEvaluatorPrompt（Issue #1168）', () => {
  const input = (overrides: Partial<GoalEvaluatorInput> = {}): GoalEvaluatorInput => ({
    goal: { purpose: '認証を直す', acceptanceCriteria: 'npm test が exit 0 で終わる' },
    evidence: [],
    summary: '',
    recentTurns: [],
    iteration: 1,
    ...overrides,
  });

  // 実在の形に見える値をソースへ直書きしない（secretスキャンに当たる）。実行時に組み立てる
  const fakeGitHubToken = `ghp_${'a1b2c3d4'.repeat(5)}`;
  const fakeJwt = `eyJ${'x'.repeat(12)}.${'y'.repeat(12)}.${'z'.repeat(12)}`;
  const fakeAwsKey = `AKIA${'A'.repeat(16)}`;
  const fakeOpenAiKey = `sk-live-${'q'.repeat(24)}`;
  const fakeDbPassword = `s3cret${'p4ss'.repeat(2)}`;

  it('証拠のコマンド引数・末尾出力に混ざった資格情報を伏せてから送る', () => {
    const result = redactEvaluatorPrompt(
      input({
        evidence: [
          {
            kind: 'test',
            source: `GITHUB_TOKEN=${fakeGitHubToken} npm test`,
            status: 'pass',
            detail: ['exit 0', `Authorization: Bearer ${fakeJwt}`].join('\n'),
            iteration: 1,
          },
        ],
      }),
    );
    expect(result.total).toBeGreaterThan(0);
    expect(result.text).not.toContain(fakeGitHubToken);
    expect(result.text).not.toContain(fakeJwt);
  });

  it('応答本文・要約・ゴール本文に混ざった資格情報も伏せる', () => {
    const result = redactEvaluatorPrompt(
      input({
        goal: {
          purpose: 'DBへ繋ぐ',
          acceptanceCriteria: 'password: "hunter2-hunter2" で接続できる',
          constraints: `${fakeAwsKey} を使う`,
        },
        summary: `export API_KEY=${fakeOpenAiKey}`,
        recentTurns: [`接続文字列は postgres://app:${fakeDbPassword}@db.example.com/app`],
      }),
    );
    expect(result.text).not.toContain('hunter2-hunter2');
    expect(result.text).not.toContain(fakeAwsKey);
    expect(result.text).not.toContain(fakeOpenAiKey);
    expect(result.text).not.toContain(fakeDbPassword);
    expect(result.text).toContain('db.example.com');
  });

  it('業務コードは伏せない（伏せると判定が成り立たない）', () => {
    const result = redactEvaluatorPrompt(
      input({ recentTurns: ['function authenticate(user) { return user.token !== undefined; }'] }),
    );
    expect(result.total).toBe(0);
    expect(result.text).toContain('function authenticate(user)');
  });
});
