import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { createLogger } from '../../src/log';

/** `appendLine` だけを記録する `vscode.OutputChannel` の最小フェイク。 */
function createFakeChannel(): { channel: vscode.OutputChannel; lines: string[] } {
  const lines: string[] = [];
  const channel = {
    appendLine: (line: string) => {
      lines.push(line);
    },
    show: () => {},
  } as unknown as vscode.OutputChannel;
  return { channel, lines };
}

describe('createLogger（Issue #391: 一般経路のログにもホームディレクトリのマスクを掛ける）', () => {
  it('fsエラーをそのまま流してもホームディレクトリのユーザー名がログに出ない', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    log.warn("ENOENT: no such file or directory, scandir '/home/alice/.codex/sessions'");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('alice');
    expect(lines[0]).toContain("scandir '~/.codex/sessions'");
  });

  it('info / error も同じくマスクされる', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    log.info('/home/alice/work');
    log.error('/home/alice/work');
    expect(lines[0]).toContain('INFO');
    expect(lines[0]).toContain('~/work');
    expect(lines[1]).toContain('ERROR');
    expect(lines[1]).toContain('~/work');
  });

  it('実ホームディレクトリと一致しない慣習的なホームパスもユーザー名だけ隠す', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    log.warn("EACCES: permission denied, open '/Users/bob/Library/x.json'");
    expect(lines[0]).not.toContain('bob');
    expect(lines[0]).toContain('/Users/***/Library/x.json');
  });

  it('URL中のuserinfo（トークン付きURL）もマスクする', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    log.error("fatal: Authentication failed for 'https://token123@github.com/org/repo.git/'");
    expect(lines[0]).not.toContain('token123');
    expect(lines[0]).toContain('https://***@github.com/org/repo.git/');
  });

  it('長いメッセージを切り詰めない（障害調査に必要な情報を落とさない）', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    const long = 'x'.repeat(1000);
    log.info(long);
    expect(lines[0]).toContain(long);
  });

  it('改行を含むメッセージ（スタックトレース等）の改行を潰さない', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    log.error('Error: boom\n    at foo (/home/alice/a.ts:1:1)');
    expect(lines[0]).toContain('\n    at foo (~/a.ts:1:1)');
  });

  it('sanitizeForLogを通した文字列を再度渡しても変化しない（二重適用が冪等）', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    log.warn("scandir '/home/***/.codex' https://***@github.com/org/repo ~/work");
    expect(lines[0]).toContain("scandir '/home/***/.codex' https://***@github.com/org/repo ~/work");
  });

  it('パスを含まないメッセージは変えない', () => {
    const { channel, lines } = createFakeChannel();
    const log = createLogger(channel, '/home/alice');
    log.info('セッションを復元しました');
    expect(lines[0]).toContain('セッションを復元しました');
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] INFO {2}/u);
  });
});
