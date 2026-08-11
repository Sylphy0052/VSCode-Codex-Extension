import { describe, expect, it } from 'vitest';
import { sanitizeForLog, stripControlChars } from '../../src/orchestrator/sanitize';

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

  it('双方向制御文字（RTL override等）も取り除く（レビュー指摘: medium 3）', () => {
    // U+202E（RTL override）を使って表示上の文字列反転を狙う典型例
    const rtlOverride = '\u202E';
    const spoofed = 'safe' + rtlOverride + 'gnp.exe';
    const result = sanitizeForLog(spoofed);
    expect(result).not.toContain(rtlOverride);
    expect(result).toBe('safegnp.exe');
  });
});

describe('stripControlChars（レビュー指摘: medium 3 / low）', () => {
  it('C0制御文字・DELを空白に畳む', () => {
    expect(stripControlChars('a\nb\tc\x00d\x7Fe')).toBe('a b c d e');
  });

  it('双方向制御文字を跡を残さず削除する', () => {
    // LRM, RLM, ALM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI
    const codePoints = [
      0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ];
    for (const codePoint of codePoints) {
      const ch = String.fromCodePoint(codePoint);
      expect(stripControlChars('a' + ch + 'b')).toBe('ab');
    }
  });

  it('ゼロ幅文字・BOMを跡を残さず削除する（ANSIエスケープ・ゼロ幅文字が残る問題。レビュー指摘: low）', () => {
    // ZERO WIDTH SPACE, WORD JOINER, ZERO WIDTH NO-BREAK SPACE (BOM)
    const codePoints = [0x200b, 0x2060, 0xfeff];
    for (const codePoint of codePoints) {
      const ch = String.fromCodePoint(codePoint);
      expect(stripControlChars('a' + ch + 'b')).toBe('ab');
    }
  });

  it('制御文字を含まない文字列はそのまま返す', () => {
    const example = 'ls -la /repo/work';
    expect(stripControlChars(example)).toBe(example);
  });
});
