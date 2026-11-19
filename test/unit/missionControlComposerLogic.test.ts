import { describe, expect, it } from 'vitest';
import {
  applyCompletion,
  completionTokenAt,
  filterCommands,
  mentionOf,
  stepIndex,
} from '../../src/webview/missionControl/composerLogic';

/** 指示欄の補完（Issue #2158）。 */

describe('completionTokenAt', () => {
  it('行頭の/はスラッシュコマンドの補完', () => {
    expect(completionTokenAt('/ini', 4)).toEqual({
      kind: 'command',
      start: 0,
      end: 4,
      query: 'ini',
    });
    expect(completionTokenAt('/', 1)).toEqual({ kind: 'command', start: 0, end: 1, query: '' });
  });

  it('行頭以外の/・空白の後の/では候補を出さない', () => {
    expect(completionTokenAt('see /ini', 8)).toBeUndefined();
    expect(completionTokenAt('/init now', 9)).toBeUndefined();
  });

  it('先頭か空白の後の@はファイルの補完', () => {
    expect(completionTokenAt('@src', 4)).toEqual({ kind: 'file', start: 0, end: 4, query: 'src' });
    expect(completionTokenAt('look @src/a', 11)).toEqual({
      kind: 'file',
      start: 5,
      end: 11,
      query: 'src/a',
    });
    expect(completionTokenAt('look\n@', 6)).toEqual({ kind: 'file', start: 5, end: 6, query: '' });
  });

  it('語の途中の@（メールアドレス）では候補を出さない', () => {
    expect(completionTokenAt('a@b', 3)).toBeUndefined();
    expect(completionTokenAt('@src ', 5)).toBeUndefined();
  });

  it('カーソルより前だけを見る', () => {
    expect(completionTokenAt('@src rest', 2)).toEqual({
      kind: 'file',
      start: 0,
      end: 2,
      query: 's',
    });
  });
});

describe('applyCompletion', () => {
  it('語を候補で置き換えて空白を1つ足す', () => {
    const token = completionTokenAt('look @sr please', 8);
    expect(token).toBeDefined();
    expect(applyCompletion('look @sr please', token!, 'src/a.ts')).toEqual({
      text: 'look @src/a.ts please',
      caret: 15,
    });
  });

  it('カーソルの後ろに続く語の残りも置き換える', () => {
    const token = completionTokenAt('@srXX', 3)!;
    expect(applyCompletion('@srXX', token, 'src')).toEqual({ text: '@src ', caret: 5 });
  });

  it('スラッシュコマンドは/付きで入れる', () => {
    const token = completionTokenAt('/in', 3)!;
    expect(applyCompletion('/in', token, 'init')).toEqual({ text: '/init ', caret: 6 });
  });
});

describe('filterCommands', () => {
  const commands = [
    { name: 'compact', description: '会話を要約', argumentHint: '' },
    { name: 'init', description: 'CLAUDE.mdを作る', argumentHint: '' },
    { name: 'review', description: 'initial review', argumentHint: '[pr]' },
  ];

  it('空なら全部を元の順で', () => {
    expect(filterCommands(commands, '').map((c) => c.name)).toEqual(['compact', 'init', 'review']);
  });

  it('前方一致を先に、部分一致（説明を含む）を後に', () => {
    expect(filterCommands(commands, 'ini').map((c) => c.name)).toEqual(['init', 'review']);
  });

  it('上限で切る', () => {
    expect(filterCommands(commands, '', 2)).toHaveLength(2);
  });
});

describe('stepIndex / mentionOf', () => {
  it('端で反対側へ回る', () => {
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });

  it('空白を含むパスは引用符で囲む', () => {
    expect(mentionOf('/a/b.txt')).toBe('@/a/b.txt');
    expect(mentionOf('/a b/c.txt')).toBe('@"/a b/c.txt"');
  });
});
