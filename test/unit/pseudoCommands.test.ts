import { describe, expect, it } from 'vitest';
import {
  buildInitInstructionText,
  CODEX_PSEUDO_COMMANDS,
  routePseudoCommand,
  trimmedArgsOrUndefined,
  withPseudoCommands,
  type PseudoCommand,
} from '../../src/provider/pseudoCommands';
import type { SlashCommand } from '../../src/provider/slashCommands';

const pseudo: PseudoCommand[] = [
  { name: 'compact', description: '圧縮する', argumentHint: '', action: 'compact' },
];

describe('CODEX_PSEUDO_COMMANDS', () => {
  it('拡張機能側で実行できるものだけを載せる', () => {
    // 対応する動作が無いものを載せると「押しても何も起きない」状態に戻る
    expect(CODEX_PSEUDO_COMMANDS.map((c) => c.name)).toEqual(['compact', 'init', 'btw']);
  });

  it('説明が付いている', () => {
    expect(CODEX_PSEUDO_COMMANDS.every((c) => c.description !== '')).toBe(true);
  });

  it('/btw は質問を引数に取る（脇道の質問。issue #24）', () => {
    const btw = CODEX_PSEUDO_COMMANDS.find((c) => c.name === 'btw');
    expect(btw?.action).toBe('sideQuestion');
    expect(btw?.argumentHint).not.toBe('');
  });
});

describe('trimmedArgsOrUndefined', () => {
  it('前後の空白を落として返す', () => {
    expect(trimmedArgsOrUndefined('  今何時？  ')).toBe('今何時？');
  });

  it('空文字は undefined', () => {
    expect(trimmedArgsOrUndefined('')).toBeUndefined();
  });

  it('空白だけも undefined', () => {
    expect(trimmedArgsOrUndefined('   ')).toBeUndefined();
  });
});

describe('routePseudoCommand', () => {
  it('コマンド行だけなら引き受ける', () => {
    expect(routePseudoCommand(pseudo, '/compact')).toEqual({ name: 'compact', action: 'compact', args: '' });
  });

  it('前後の空白は無視する', () => {
    expect(routePseudoCommand(pseudo, '  /compact  ')).toEqual({ name: 'compact', action: 'compact', args: '' });
  });

  it('引数は取り出して渡す', () => {
    expect(routePseudoCommand(pseudo, '/compact 要点だけ残して')).toEqual({
      name: 'compact',
      action: 'compact',
      args: '要点だけ残して',
    });
  });

  it('知らないコマンドは引き受けない', () => {
    expect(routePseudoCommand(pseudo, '/status')).toBeUndefined();
  });

  it('/btw は質問を引数として取り出す', () => {
    expect(routePseudoCommand(CODEX_PSEUDO_COMMANDS, '/btw 今のタイムゾーンは？')).toEqual({
      name: 'btw',
      action: 'sideQuestion',
      args: '今のタイムゾーンは？',
    });
  });

  it('普通の発言は引き受けない', () => {
    expect(routePseudoCommand(pseudo, 'compact してください')).toBeUndefined();
    expect(routePseudoCommand(pseudo, '')).toBeUndefined();
  });

  it('本文を伴う複数行は普通の発言として扱う', () => {
    // 「/compact」で始まる長文を書いたときに、意図せず圧縮が走らないようにする
    expect(routePseudoCommand(pseudo, '/compact\nこの続きを書いて')).toBeUndefined();
  });
});

describe('withPseudoCommands', () => {
  const others: SlashCommand[] = [
    { name: 'doc', description: '書く', argumentHint: '' },
    { name: 'compact', description: '別物', argumentHint: '' },
  ];

  it('擬似コマンドを先頭へ置く', () => {
    expect(withPseudoCommands(pseudo, others).map((c) => c.name)).toEqual(['compact', 'doc']);
  });

  it('同じ名前は擬似コマンドを優先する', () => {
    // 送信時の振り替えは名前で決まる。説明だけ別のものが出ると食い違う
    expect(withPseudoCommands(pseudo, others)[0]?.description).toBe('圧縮する');
  });

  it('擬似コマンドが無くても壊れない', () => {
    expect(withPseudoCommands([], others)).toEqual(others);
  });
});

describe('buildInitInstructionText', () => {
  it('AGENTS.mdが無いときは新規作成を指示する', () => {
    expect(buildInitInstructionText(false)).toContain('新規に作成');
  });

  it('AGENTS.mdが既にあるときは踏まえた更新を指示する', () => {
    const text = buildInitInstructionText(true);
    expect(text).toContain('既存のAGENTS.md');
    expect(text).toContain('更新');
  });

  it('どちらも次の担当者が知るべき情報をまとめるよう伝える', () => {
    expect(buildInitInstructionText(false)).toContain('AGENTS.md');
    expect(buildInitInstructionText(true)).toContain('AGENTS.md');
  });
});
