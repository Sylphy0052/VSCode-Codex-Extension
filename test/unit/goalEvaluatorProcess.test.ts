import { describe, expect, it } from 'vitest';
import {
  AUTO_CLAUDE_MODEL,
  buildClaudeEvaluatorArgs,
  buildCodexEvaluatorArgs,
  readClaudeResult,
  resolveEvaluatorProvider,
} from '../../src/loop/goalEvaluatorProcess';

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
