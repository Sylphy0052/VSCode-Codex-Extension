import { describe, expect, it } from 'vitest';
import { sanitizeForLog } from '../../src/orchestrator/sanitize';

describe('sanitizeForLog（design.md §16.7のsanitizeForReasonを共通化。レビュー指摘: warning）', () => {
  it('制御文字・改行を空白に畳む', () => {
    expect(sanitizeForLog('a\nb\tc\x00d')).toBe('a b c d');
  });

  it('連続する空白を1つに畳む', () => {
    expect(sanitizeForLog('a    b')).toBe('a b');
  });

  it('長すぎる値を切り詰め、省略記号を付ける', () => {
    const long = 'x'.repeat(300);
    const result = sanitizeForLog(long);
    expect(result.length).toBe(201);
    expect(result.endsWith('…')).toBe(true);
  });

  it('URL中のuserinfo（user:pass@）をマスクする', () => {
    const raw =
      "fatal: Authentication failed for 'https://token123:x-oauth-basic@github.com/org/repo.git/'";
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('token123');
    expect(result).not.toContain('x-oauth-basic');
    expect(result).toContain('https://***@github.com/org/repo.git/');
  });

  it('userinfoを含まない通常のURLは変えない', () => {
    expect(sanitizeForLog('see https://github.com/org/repo')).toBe(
      'see https://github.com/org/repo',
    );
  });
});
