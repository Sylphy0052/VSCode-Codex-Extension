import { describe, expect, it } from 'vitest';

import { applyDiffBudget, parseDiff, utf8Bytes } from '../../src/secondOpinion/diffBudget';

/** ファイル1つ分の差分を組み立てる。hunkは1件あたり同じ大きさになるようにしてある。 */
function fileDiff(path: string, hunks: number, payload = 'x'.repeat(10)): string {
  let out = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  for (let i = 0; i < hunks; i += 1) {
    out += `@@ -${i + 1},1 +${i + 1},1 @@\n+${payload}\n`;
  }
  return out;
}

describe('parseDiff（Issue #926 H）', () => {
  it('ファイルとhunkへ分け、パスは後像側から読む', () => {
    const parsed = parseDiff(fileDiff('src/a.ts', 2) + fileDiff('src/b.ts', 1));
    expect(parsed.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parsed.files[0]?.hunks).toHaveLength(2);
    expect(parsed.files[1]?.hunks).toHaveLength(1);
  });

  it('削除されたファイルは前像側のパスを使う', () => {
    const diff = 'diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n';
    expect(parseDiff(diff).files[0]?.path).toBe('gone.ts');
  });

  it('バイナリを見分ける', () => {
    const diff =
      'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n';
    expect(parseDiff(diff).files[0]?.binary).toBe(true);
  });

  it('自動生成とみなすパスを見分ける', () => {
    const parsed = parseDiff(fileDiff('package-lock.json', 1) + fileDiff('src/a.ts', 1));
    expect(parsed.files.map((file) => file.generated)).toEqual([true, false]);
  });

  it('空の差分は0件', () => {
    expect(parseDiff('')).toEqual({ preamble: '', files: [] });
  });
});

describe('applyDiffBudget（Issue #926 H）', () => {
  it('上限以下なら手を入れない', () => {
    const diff = fileDiff('src/a.ts', 2);
    const result = applyDiffBudget(diff, 10_000);
    expect(result).toEqual({ diff, truncated: false, omissions: [], partials: [] });
  });

  it('hunkの途中では切らない', () => {
    const diff = fileDiff('src/a.ts', 4);
    const result = applyDiffBudget(diff, utf8Bytes(diff) - 1);
    // 残った本文のhunkは、元の形のまま丸ごと入っている
    for (const hunk of result.diff.split(/^(?=@@ )/m).slice(1)) {
      expect(hunk.startsWith('@@ ')).toBe(true);
      if (!hunk.includes('# 省略:')) {
        expect(hunk.endsWith('\n')).toBe(true);
      }
    }
    expect(result.truncated).toBe(true);
  });

  it('1ファイルで予算を超えても、そのファイルは残り省略したhunk数が明記される', () => {
    const diff = fileDiff('src/big.ts', 10);
    const result = applyDiffBudget(diff, 150);
    expect(result.diff).toContain('diff --git a/src/big.ts b/src/big.ts');
    expect(result.omissions).toEqual([]);
    expect(result.partials).toHaveLength(1);
    expect(result.partials[0]?.path).toBe('src/big.ts');
    expect(result.partials[0]?.totalHunks).toBe(10);
    expect(result.diff).toContain('# 省略:');
  });

  it('バイナリは本文を渡さず、一覧へ載せる', () => {
    const binary =
      'diff --git a/img.png b/img.png\nGIT binary patch\n' + `${'z'.repeat(500)}\n`;
    const diff = binary + fileDiff('src/a.ts', 1);
    const result = applyDiffBudget(diff, 300);
    expect(result.diff).not.toContain('GIT binary patch');
    expect(result.omissions.map((entry) => entry.reason)).toEqual(['binary']);
    // テキスト側は丸ごと残る
    expect(result.diff).toContain('diff --git a/src/a.ts b/src/a.ts');
  });

  it('予算が足りないとき、自動生成ファイルを先に落とす', () => {
    const generated = fileDiff('package-lock.json', 20);
    const source = fileDiff('src/a.ts', 1);
    const result = applyDiffBudget(generated + source, utf8Bytes(source) + 50);
    expect(result.omissions).toEqual([
      { path: 'package-lock.json', bytes: utf8Bytes(generated), reason: 'generated' },
    ]);
    // 落としたのは自動生成の方だけで、本体は丸ごと残る
    expect(result.diff).toBe(source);
    expect(result.partials).toEqual([]);
  });

  it('自動生成でも予算に収まるなら落とさない', () => {
    const diff = fileDiff('package-lock.json', 1) + fileDiff('src/a.ts', 1);
    const result = applyDiffBudget(diff, 10_000);
    expect(result.omissions).toEqual([]);
    expect(result.diff).toBe(diff);
  });

  it('後ろのファイルだけが落ちることはない（小さい方から配る）', () => {
    const small = fileDiff('src/z-small.ts', 1);
    const large = fileDiff('src/a-large.ts', 20);
    const result = applyDiffBudget(large + small, 400);
    // 出力順は元のまま
    expect(result.diff.indexOf('a-large.ts')).toBeLessThan(result.diff.indexOf('z-small.ts'));
    // パス順で後ろにある小さいファイルは丸ごと残る
    expect(result.diff).toContain('+xxxxxxxxxx\n@@');
    expect(result.partials.map((entry) => entry.path)).toEqual(['src/a-large.ts']);
  });

  it('予算はUTF-8のbyteで測る', () => {
    const japanese = fileDiff('src/a.ts', 1, 'あ'.repeat(10));
    // 文字数では収まるが、byte数では収まらない大きさ
    expect(japanese.length).toBeLessThan(utf8Bytes(japanese));
    const result = applyDiffBudget(japanese, japanese.length);
    expect(result.truncated).toBe(true);
  });

  it('`diff --git` が無い入力でも予算を超えたまま渡さない', () => {
    const result = applyDiffBudget('a\nb\nc\nd\n', 4);
    expect(utf8Bytes(result.diff)).toBeLessThanOrEqual(4);
    expect(result.truncated).toBe(true);
  });
});
