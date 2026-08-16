import { describe, expect, it } from 'vitest';
import {
  resolveWithinWorkspace,
  verifyRealPathWithinWorkspace,
} from '../../src/util/diffWorkspacePath';

describe('resolveWithinWorkspace', () => {
  it('ワークスペース内の相対パスを絶対パスへ解決する', () => {
    const result = resolveWithinWorkspace('src/foo.ts', ['/work/repo']);
    expect(result).toEqual({ ok: true, absolutePath: '/work/repo/src/foo.ts' });
  });

  it('ワークスペース内を指す絶対パスをそのまま受け入れる', () => {
    const result = resolveWithinWorkspace('/work/repo/src/foo.ts', ['/work/repo']);
    expect(result).toEqual({ ok: true, absolutePath: '/work/repo/src/foo.ts' });
  });

  it('ワークスペースの外を指す絶対パスを拒む', () => {
    const result = resolveWithinWorkspace('/etc/passwd', ['/work/repo']);
    expect(result.ok).toBe(false);
  });

  it('..を含む相対パスは打ち消し合って結果的に内側へ収まっても拒む', () => {
    const result = resolveWithinWorkspace('src/../src/foo.ts', ['/work/repo']);
    expect(result.ok).toBe(false);
  });

  it('..でワークスペースの外へ脱出しようとするパスを拒む', () => {
    const result = resolveWithinWorkspace('../../etc/passwd', ['/work/repo']);
    expect(result.ok).toBe(false);
  });

  it('空文字のパスを拒む', () => {
    const result = resolveWithinWorkspace('', ['/work/repo']);
    expect(result.ok).toBe(false);
  });

  it('複数ワークスペースのうちどれかの内側なら受け入れる', () => {
    const result = resolveWithinWorkspace('/work/second/file.ts', [
      '/work/first',
      '/work/second',
    ]);
    expect(result).toEqual({ ok: true, absolutePath: '/work/second/file.ts' });
  });

  it('ワークスペースが1つも無ければ拒む', () => {
    const result = resolveWithinWorkspace('src/foo.ts', []);
    expect(result.ok).toBe(false);
  });

  it('ワークスペースルート自身は対象にしない', () => {
    const result = resolveWithinWorkspace('/work/repo', ['/work/repo']);
    expect(result.ok).toBe(false);
  });
});

describe('verifyRealPathWithinWorkspace', () => {
  it('実在するファイルがワークスペース配下ならそのまま受け入れる', async () => {
    const realpath = async (p: string): Promise<string> => p;
    const result = await verifyRealPathWithinWorkspace('/work/repo/src/foo.ts', ['/work/repo'], realpath);
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
    const result = await verifyRealPathWithinWorkspace('/work/repo/src/foo.ts', ['/work/repo'], realpath);
    expect(result.ok).toBe(false);
  });
});
