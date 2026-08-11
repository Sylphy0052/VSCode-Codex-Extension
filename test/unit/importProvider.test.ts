import { describe, expect, it } from 'vitest';
import {
  isKnownImportItemType,
  isValidImportItemKey,
  labelForImportItemType,
} from '../../src/provider/import';

describe('labelForImportItemType', () => {
  it('既知の種別を日本語ラベルへ変換する', () => {
    expect(labelForImportItemType('SKILLS')).toBe('skills');
    expect(labelForImportItemType('CONFIG')).toBe('設定（config.toml）');
    expect(labelForImportItemType('AGENTS_MD')).toBe('Instructions（AGENTS.md）');
    expect(labelForImportItemType('SESSIONS')).toBe('最近のセッション');
  });

  it('未知の種別は元の文字列をそのまま返す（一覧を落とさない）', () => {
    expect(labelForImportItemType('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('isKnownImportItemType', () => {
  it('スキーマのenumに含まれる10種別を既知として扱う', () => {
    const known = [
      'AGENTS_MD',
      'CONFIG',
      'SKILLS',
      'PLUGINS',
      'MCP_SERVER_CONFIG',
      'SUBAGENTS',
      'HOOKS',
      'COMMANDS',
      'MEMORY',
      'SESSIONS',
    ];
    for (const type of known) {
      expect(isKnownImportItemType(type)).toBe(true);
    }
  });

  it('未知の種別はfalse', () => {
    expect(isKnownImportItemType('UNKNOWN')).toBe(false);
    expect(isKnownImportItemType('')).toBe(false);
  });
});

describe('isValidImportItemKey', () => {
  it('通常の文字列を許可する', () => {
    expect(isValidImportItemKey('SKILLS:')).toBe(true);
    expect(isValidImportItemKey('SKILLS:/workspace/repo')).toBe(true);
  });

  it('空文字を拒否する', () => {
    expect(isValidImportItemKey('')).toBe(false);
  });

  it('制御文字を含む文字列を拒否する', () => {
    expect(isValidImportItemKey('SKILLS:\n/etc')).toBe(false);
    expect(isValidImportItemKey('SKILLS:\0')).toBe(false);
  });

  it('極端に長い文字列を拒否する', () => {
    expect(isValidImportItemKey('a'.repeat(2001))).toBe(false);
    expect(isValidImportItemKey('a'.repeat(2000))).toBe(true);
  });

  it('文字列以外を拒否する', () => {
    expect(isValidImportItemKey(undefined)).toBe(false);
    expect(isValidImportItemKey(123)).toBe(false);
    expect(isValidImportItemKey(null)).toBe(false);
  });
});
