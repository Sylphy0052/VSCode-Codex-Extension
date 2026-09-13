import { describe, expect, it } from 'vitest';
import {
  resolveWithinWorkspace,
  verifyRealPathWithinWorkspace,
} from '../../src/util/diffWorkspacePath';

describe('resolveWithinWorkspace', () => {
  it('ワークスペース内の相対パスを絶対パスへ解決する', () => {
    const result = resolveWithinWorkspace('src/foo.ts', ['/work/repo'], '/work/repo');
    expect(result).toEqual({ ok: true, absolutePath: '/work/repo/src/foo.ts' });
  });

  it('ワークスペース内を指す絶対パスをそのまま受け入れる', () => {
    const result = resolveWithinWorkspace('/work/repo/src/foo.ts', ['/work/repo'], '/work/repo');
    expect(result).toEqual({ ok: true, absolutePath: '/work/repo/src/foo.ts' });
  });

  it('ワークスペースの外を指す絶対パスを拒む', () => {
    const result = resolveWithinWorkspace('/etc/passwd', ['/work/repo'], '/work/repo');
    expect(result.ok).toBe(false);
  });

  it('..を含む相対パスは打ち消し合って結果的に内側へ収まっても拒む', () => {
    const result = resolveWithinWorkspace('src/../src/foo.ts', ['/work/repo'], '/work/repo');
    expect(result.ok).toBe(false);
  });

  it('..でワークスペースの外へ脱出しようとするパスを拒む', () => {
    const result = resolveWithinWorkspace('../../etc/passwd', ['/work/repo'], '/work/repo');
    expect(result.ok).toBe(false);
  });

  it('空文字のパスを拒む', () => {
    const result = resolveWithinWorkspace('', ['/work/repo'], '/work/repo');
    expect(result.ok).toBe(false);
  });

  it('複数ワークスペースのうちどれかの内側なら受け入れる', () => {
    const result = resolveWithinWorkspace(
      '/work/second/file.ts',
      ['/work/first', '/work/second'],
      '/work/first',
    );
    expect(result).toEqual({ ok: true, absolutePath: '/work/second/file.ts' });
  });

  it('ワークスペースが1つも無ければ拒む', () => {
    const result = resolveWithinWorkspace('src/foo.ts', [], '/work/repo');
    expect(result.ok).toBe(false);
  });

  it('ワークスペースルート自身は対象にしない', () => {
    const result = resolveWithinWorkspace('/work/repo', ['/work/repo'], '/work/repo');
    expect(result.ok).toBe(false);
  });

  // 相対パスの基準は会話の作業ディレクトリ（issue #1178）。ルートを先頭から順に試すと、
  // 相対パスは必ず最初のルートに収まってしまい、別の場所のファイルへ向く
  describe('会話の作業ディレクトリを基準にする（issue #1178）', () => {
    it('複数ルートの2番目が作業ディレクトリなら、そちらの配下へ解決する', () => {
      const result = resolveWithinWorkspace('src/a.txt', ['/work/one', '/work/two'], '/work/two');
      expect(result).toEqual({ ok: true, absolutePath: '/work/two/src/a.txt' });
    });

    it('サブディレクトリが作業ディレクトリなら、そこを基準に解決する', () => {
      const result = resolveWithinWorkspace('src/a.txt', ['/work/one'], '/work/one/packages/app');
      expect(result).toEqual({ ok: true, absolutePath: '/work/one/packages/app/src/a.txt' });
    });

    it('作業ディレクトリが判らなければ、先頭ルートで代替せず拒む', () => {
      const result = resolveWithinWorkspace('src/a.txt', ['/work/one', '/work/two'], undefined);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('作業ディレクトリが判らない');
    });

    it('作業ディレクトリが空文字でも拒む', () => {
      const result = resolveWithinWorkspace('src/a.txt', ['/work/one'], '');
      expect(result.ok).toBe(false);
    });

    it('作業ディレクトリがワークスペースの外なら、解決結果が境界の外になるため拒む', () => {
      const result = resolveWithinWorkspace('src/a.txt', ['/work/one'], '/somewhere/else');
      expect(result.ok).toBe(false);
    });

    it('絶対パスは作業ディレクトリに関係なく従来どおり判定する', () => {
      const inside = resolveWithinWorkspace(
        '/work/one/src/a.txt',
        ['/work/one', '/work/two'],
        '/work/two',
      );
      expect(inside).toEqual({ ok: true, absolutePath: '/work/one/src/a.txt' });

      const outside = resolveWithinWorkspace('/etc/passwd', ['/work/one'], undefined);
      expect(outside.ok).toBe(false);
    });
  });
});

describe('verifyRealPathWithinWorkspace', () => {
  it('実在するファイルがワークスペース配下ならそのまま受け入れる', async () => {
    const realpath = async (p: string): Promise<string> => p;
    const result = await verifyRealPathWithinWorkspace(
      '/work/repo/src/foo.ts',
      ['/work/repo'],
      realpath,
    );
    expect(result).toEqual({ ok: true, absolutePath: '/work/repo/src/foo.ts' });
  });

  it('シンボリックリンクでワークスペースの外の実体を指す場合は拒む', async () => {
    const realpath = async (p: string): Promise<string> =>
      p === '/work/repo/src/link.ts' ? '/outside/secret.ts' : p;
    const result = await verifyRealPathWithinWorkspace(
      '/work/repo/src/link.ts',
      ['/work/repo'],
      realpath,
    );
    expect(result.ok).toBe(false);
  });

  it('対象自身が存在しなくても、実在する親ディレクトリから遡って判定する', async () => {
    const realpath = async (p: string): Promise<string> => {
      if (p === '/work/repo/src/new-file.ts') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return p;
    };
    const result = await verifyRealPathWithinWorkspace(
      '/work/repo/src/new-file.ts',
      ['/work/repo'],
      realpath,
    );
    expect(result).toEqual({ ok: true, absolutePath: '/work/repo/src/new-file.ts' });
  });

  it('親ディレクトリがシンボリックリンクで外の実体を指す場合も拒む', async () => {
    const realpath = async (p: string): Promise<string> => {
      if (p === '/work/repo/src/new-file.ts') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (p === '/work/repo/src') {
        return '/outside/src';
      }
      return p;
    };
    const result = await verifyRealPathWithinWorkspace(
      '/work/repo/src/new-file.ts',
      ['/work/repo'],
      realpath,
    );
    expect(result.ok).toBe(false);
  });

  it('ワークスペースルート自体が読めなければ確認できない扱いにする', async () => {
    const realpath = async (): Promise<string> => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const result = await verifyRealPathWithinWorkspace(
      '/work/repo/src/foo.ts',
      ['/work/repo'],
      realpath,
    );
    expect(result.ok).toBe(false);
  });
});
