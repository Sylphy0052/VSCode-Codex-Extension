import { describe, expect, it } from 'vitest';
import { isValidHookKey } from '../../src/provider/hooks';

describe('isValidHookKey', () => {
  it('通常の識別子らしい形は許可する', () => {
    expect(isValidHookKey('pre-commit')).toBe(true);
    expect(isValidHookKey('preToolUse:0:1')).toBe(true);
    expect(isValidHookKey('my_hook.v2')).toBe(true);
  });

  it('設定の書き込み先を壊しうる二重引用符・バックスラッシュを拒否する', () => {
    expect(isValidHookKey('a"b')).toBe(false);
    expect(isValidHookKey('a\\b')).toBe(false);
  });

  it('空白・制御文字を拒否する', () => {
    expect(isValidHookKey('a b')).toBe(false);
    expect(isValidHookKey('a\tb')).toBe(false);
    expect(isValidHookKey('a\nb')).toBe(false);
    expect(isValidHookKey('')).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    expect(isValidHookKey(undefined)).toBe(false);
    expect(isValidHookKey(123)).toBe(false);
    expect(isValidHookKey(null)).toBe(false);
  });
});
