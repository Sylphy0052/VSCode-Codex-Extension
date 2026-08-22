import { describe, expect, it } from 'vitest';
import { chatCsp } from '../../src/view/chatCsp';

describe('chatCsp（issue #358、CSPの組み立てを1箇所に集約）', () => {
  it('既定ではimg-src data:を含める（添付画像のサムネイル用）', () => {
    const csp = chatCsp('https://fake-webview.test', 'nonce-value');

    expect(csp).toBe(
      "default-src 'none'; style-src https://fake-webview.test 'unsafe-inline'; script-src 'nonce-nonce-value'; img-src data:",
    );
  });

  it('includeImgData: falseを渡すとimg-src data:を含めない（画像を扱わない画面向け）', () => {
    const csp = chatCsp('https://fake-webview.test', 'nonce-value', { includeImgData: false });

    expect(csp).toBe(
      "default-src 'none'; style-src https://fake-webview.test 'unsafe-inline'; script-src 'nonce-nonce-value'",
    );
    expect(csp).not.toContain('img-src');
  });
});
