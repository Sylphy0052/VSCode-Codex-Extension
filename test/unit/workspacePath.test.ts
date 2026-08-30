import { describe, expect, it } from 'vitest';
import { isWithinAnyRoot, isWithinRoot, normalizeWorkspacePath } from '../../src/util/paths';

/**
 * ワークスペースの所属判定（Issue #1019）。
 *
 * 大小文字の既定はパスの形で決まる（ドライブ絶対パスと UNC だけ無視する）。実行環境に
 * 依存しないので既定値そのものも確かめる。
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

  it('UNCのサーバ名と共有名は .. で削れない', () => {
    // 削ると //server/share が //server や // に化けて、別の共有と一致しうる
    expect(normalizeWorkspacePath('//server/share/../..')).toBe('//server/share');
    expect(normalizeWorkspacePath('//server/share/../other')).toBe('//server/share/other');
  });

  it('ドライブ絶対パスではドライブが .. で消えない', () => {
    expect(normalizeWorkspacePath('C:\\')).toBe('C:/');
    expect(normalizeWorkspacePath('C:\\..\\secret')).toBe('C:/secret');
    expect(normalizeWorkspacePath('C:\\a\\..\\..\\x')).toBe('C:/x');
  });

  it('ドライブ相対パス（C:foo）を絶対パスに化けさせない', () => {
    expect(normalizeWorkspacePath('C:foo')).toBe('C:foo');
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

  it('ドライブ絶対パスの根と、ドライブ相対パスを区別する', () => {
    expect(isWithinRoot('C:\\foo', 'C:\\')).toBe(true);
    expect(isWithinRoot('C:', 'C:\\')).toBe(false);
    expect(isWithinRoot('C:foo', 'C:\\')).toBe(false);
  });

  it('既定では、両側がWindowsのパスのときだけ大小文字を無視する', () => {
    // ドライブレターの大小は揺れるので吸収する
    expect(isWithinRoot('c:\\work\\repo\\pkg', 'C:\\work\\repo')).toBe(true);
    expect(isWithinRoot('\\\\Server\\Share\\proj', '//server/share')).toBe(true);
    // POSIXでは /a と /A が別のディレクトリ。実行環境がWindowsでも畳まない
    expect(isWithinRoot('/work/Repo/pkg', '/work/repo')).toBe(false);
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

  it('ルートが空なら配下としない', () => {
    // 旧実装は絶対パスをすべて通していた。絞り込みが全開になる方向なので閉じる
    expect(isWithinRoot('/work/repo', '')).toBe(false);
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
