import { describe, expect, it } from 'vitest';
import { isValidPluginName } from '../../src/provider/plugins';

describe('isValidPluginName', () => {
  it('空白を含まない文字列を許可する', () => {
    expect(isValidPluginName('github')).toBe(true);
    expect(isValidPluginName('genshijin@genshijin')).toBe(true);
  });

  it('空文字・空白を含む文字列を拒否する', () => {
    expect(isValidPluginName('')).toBe(false);
    expect(isValidPluginName('a b')).toBe(false);
    expect(isValidPluginName(' ')).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    expect(isValidPluginName(undefined)).toBe(false);
    expect(isValidPluginName(123)).toBe(false);
    expect(isValidPluginName(null)).toBe(false);
  });
});
