import { describe, expect, it } from 'vitest';
import {
  filterCommands,
  parseCommandFile,
  type SlashCommand,
} from '../../src/provider/slashCommands';

describe('parseCommandFile', () => {
  it('frontmatterの description と argument-hint を読む', () => {
    const content = [
      '---',
      'description: "ドキュメントを生成する"',
      'argument-hint: "[readme | adr]"',
      '---',
      '本文は読まない',
    ].join('\n');
    expect(parseCommandFile('doc', content)).toEqual({
      name: 'doc',
      description: 'ドキュメントを生成する',
      argumentHint: '[readme | adr]',
    });
  });

  it('frontmatterの name を優先する', () => {
    const content = ['---', 'name: daily-report', 'description: 日報を書く', '---'].join('\n');
    expect(parseCommandFile('SKILL', content)?.name).toBe('daily-report');
  });

  it('引用符の有無を問わない', () => {
    const content = ['---', "description: '囲みなし'", '---'].join('\n');
    expect(parseCommandFile('x', content)?.description).toBe('囲みなし');
  });

  it('frontmatterが無ければファイル名だけを使う', () => {
    expect(parseCommandFile('commit', '# 見出し')).toEqual({
      name: 'commit',
      description: '',
      argumentHint: '',
    });
  });

  it('長い説明は1行に畳む', () => {
    const content = ['---', 'description: 前半', '  後半', '---'].join('\n');
    expect(parseCommandFile('x', content)?.description).toBe('前半');
  });
});

describe('filterCommands', () => {
  const commands: SlashCommand[] = [
    { name: 'commit', description: '変更をコミットする', argumentHint: '' },
    { name: 'doc', description: 'ドキュメントを生成する', argumentHint: '' },
    { name: 'daily-report', description: '日報を書く', argumentHint: '' },
  ];

  it('前方一致を先に出す', () => {
    expect(filterCommands(commands, 'd').map((c) => c.name)).toEqual(['doc', 'daily-report']);
  });

  it('部分一致も拾う', () => {
    expect(filterCommands(commands, 'report').map((c) => c.name)).toEqual(['daily-report']);
  });

  it('大文字小文字を区別しない', () => {
    expect(filterCommands(commands, 'DOC').map((c) => c.name)).toEqual(['doc']);
  });

  it('空なら全件返す', () => {
    expect(filterCommands(commands, '')).toHaveLength(3);
  });

  it('該当が無ければ空', () => {
    expect(filterCommands(commands, 'zzz')).toEqual([]);
  });
});
