import { describe, expect, it } from 'vitest';
import { isWithinAnyRoot, isWithinRoot, normalizeWorkspacePath } from '../../src/util/paths';

/**
 * ワークスペースの所属判定（Issue #1019）。
 *
 * 大小文字の既定は実行環境に依存するため、ここでは `caseInsensitive` を明示して
 * 両方の側を確かめる。既定値そのものはテストしない（CI と実機で答えが変わるため）。
 */

describe('normalizeWorkspacePath（issue #1019）', () => {
  it('区切りの向きを揃え、末尾と重複した区切りを落とす', () => {
    expect(normalizeWorkspacePath('C:\\work\\repo\\')).toBe('C:/work/repo');
    expect(normalizeWorkspacePath('/work//repo///')).toBe('/work/repo');
  });

  it('.. と . を畳む', () => {
    expect(normalizeWorkspacePath('/work/repo/../secret')).toBe('/work/secret');
    expect(normalizeWorkspacePath('/work/./repo')).toBe('/work/repo');
    expect(normalizeWorkspacePath('/work/repo/pkg/../..')).toBe('/work');
  });

  it('絶対パスではルートより上へ出ない', () => {
    expect(normalizeWorkspacePath('/work/../..')).toBe('/');
    expect(normalizeWorkspacePath('/..')).toBe('/');
  });

  it('相対パスの先頭の .. は行き先が分からないので残す', () => {
    expect(normalizeWorkspacePath('../secret')).toBe('../secret');
    expect(normalizeWorkspacePath('a/../../b')).toBe('../b');
  });

  it('UNCの先頭の // は残す', () => {
    expect(normalizeWorkspacePath('\\\\server\\share\\proj')).toBe('//server/share/proj');
    expect(normalizeWorkspacePath('//server/share/proj/pkg/..')).toBe('//server/share/proj');
  });
});

describe('isWithinRoot（issue #1019）', () => {
  it('同じ場所と配下を配下とみなす', () => {
    expect(isWithinRoot('/work/repo', '/work/repo')).toBe(true);
    expect(isWithinRoot('/work/repo/src', '/work/repo')).toBe(true);
  });

  it('前方一致だけの別ディレクトリを含めない', () => {
    expect(isWithinRoot('/work/repo-2', '/work/repo')).toBe(false);
    expect(isWithinRoot('/work', '/work/repo')).toBe(false);
  });

  it('.. で外へ出たパスを含めない（誤包含の修正）', () => {
    expect(isWithinRoot('/work/repo/../secret', '/work/repo')).toBe(false);
    expect(isWithinRoot('/work/repo/pkg/../../other', '/work/repo')).toBe(false);
  });

  it('.. が配下へ戻るなら配下のまま', () => {
    expect(isWithinRoot('/work/repo/pkg/../src', '/work/repo')).toBe(true);
  });

  it('末尾の区切りと区切りの向きを吸収する', () => {
    expect(isWithinRoot('C:\\work\\repo\\pkg', 'C:/work/repo/')).toBe(true);
    expect(isWithinRoot('/work/repo/', '/work/repo')).toBe(true);
  });

  it('大小文字を無視する設定では、ドライブレターの大小差を吸収する', () => {
    expect(isWithinRoot('c:\\work\\repo\\pkg', 'C:\\work\\repo', { caseInsensitive: true })).toBe(
      true,
    );
  });

  it('大小文字を区別する設定では、別のディレクトリとして扱う', () => {
    expect(isWithinRoot('/work/Repo/pkg', '/work/repo', { caseInsensitive: false })).toBe(false);
  });

  it('UNCの同じ共有の配下を配下とみなす', () => {
    expect(isWithinRoot('\\\\server\\share\\proj\\pkg', '\\\\server\\share\\proj')).toBe(true);
  });

  it('UNCの別の共有を含めない', () => {
    expect(isWithinRoot('//server/other/proj', '//server/share/proj')).toBe(false);
  });

  it('サーバ名を最上位のディレクトリへ落とさない', () => {
    // 先頭の // を潰すと //server/share が /server/share になり、別の共有と一致しうる
    expect(isWithinRoot('//serverA/share/proj', '//serverB/share/proj')).toBe(false);
  });

  it('ルートを指定されたら絶対パスはすべて配下', () => {
    expect(isWithinRoot('/work/repo', '/')).toBe(true);
  });
});

describe('isWithinAnyRoot（issue #1019）', () => {
  it('いずれかのルートの配下なら真', () => {
    expect(isWithinAnyRoot('/srv/two/pkg', ['/srv/one', '/srv/two'])).toBe(true);
  });

  it('どのルートの配下でもなければ偽', () => {
    expect(isWithinAnyRoot('/srv/three', ['/srv/one', '/srv/two'])).toBe(false);
  });

  it('ルートが無ければ常に偽', () => {
    expect(isWithinAnyRoot('/work/repo', [])).toBe(false);
  });
});
