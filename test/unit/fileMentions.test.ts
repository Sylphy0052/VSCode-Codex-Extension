import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IGNORE_DIRS,
  FileMentionCatalog,
  filterFiles,
  isIgnored,
  parseGitignore,
  type FileScanPort,
} from '../../src/provider/fileMentions';

describe('parseGitignore', () => {
  it('空行とコメントを飛ばす', () => {
    const rules = parseGitignore(['', '   ', '# コメント', 'dist/'].join('\n'));
    expect(rules.dirNames.has('dist')).toBe(true);
    expect(rules.patterns).toHaveLength(0);
  });

  it('末尾スラッシュの行をディレクトリ名として拾う', () => {
    const rules = parseGitignore(['node_modules/', '/build/', 'docs/mr/'].join('\n'));
    expect([...rules.dirNames].sort()).toEqual(['build', 'node_modules']);
    // 階層を含むものは名前だけでは判断できないためパターンへ回す
    expect(rules.patterns.some((p) => p.test('docs/mr/mr-1.md'))).toBe(true);
  });

  it('否定パターンは扱わない（読めない行は無視する）', () => {
    const rules = parseGitignore(['*.log', '!keep.log'].join('\n'));
    expect(isIgnored('debug.log', rules)).toBe(true);
    // 否定を解釈しないので、keep.log も除外されたままになる
    expect(isIgnored('keep.log', rules)).toBe(true);
  });

  it('スラッシュを含まない行はどの階層でも当たる', () => {
    const rules = parseGitignore('*.log');
    expect(isIgnored('debug.log', rules)).toBe(true);
    expect(isIgnored('src/deep/debug.log', rules)).toBe(true);
    expect(isIgnored('src/debug.logger.ts', rules)).toBe(false);
  });

  it('先頭スラッシュの行はルート直下だけに当たる', () => {
    const rules = parseGitignore('/secret.txt');
    expect(isIgnored('secret.txt', rules)).toBe(true);
    expect(isIgnored('src/secret.txt', rules)).toBe(false);
  });

  it('* は階層を跨がない', () => {
    const rules = parseGitignore('src/*.ts');
    expect(isIgnored('src/a.ts', rules)).toBe(true);
    expect(isIgnored('src/deep/a.ts', rules)).toBe(false);
  });

  it('** は階層を跨ぐ', () => {
    const rules = parseGitignore('src/**/generated.ts');
    expect(isIgnored('src/deep/generated.ts', rules)).toBe(true);
    expect(isIgnored('src/a/b/generated.ts', rules)).toBe(true);
  });

  it('正規表現として特別な文字を含む名前でも壊れない', () => {
    const rules = parseGitignore('a+b(c).txt');
    expect(isIgnored('a+b(c).txt', rules)).toBe(true);
    expect(isIgnored('axbxcx.txt', rules)).toBe(false);
  });
});

describe('DEFAULT_IGNORE_DIRS', () => {
  it('走査に入るとまずいディレクトリを含む', () => {
    expect(DEFAULT_IGNORE_DIRS).toContain('.git');
    expect(DEFAULT_IGNORE_DIRS).toContain('node_modules');
  });
});

describe('filterFiles', () => {
  const files = [
    'src/view/chatView.ts',
    'src/view/chatScript.ts',
    'src/provider/attachments.ts',
    'docs/design.md',
    'README.md',
  ];

  it('クエリが空なら上限まで先頭から返す', () => {
    expect(filterFiles(files, '', 2)).toEqual(['src/view/chatView.ts', 'src/view/chatScript.ts']);
  });

  it('ファイル名の前方一致をパスの部分一致より前に出す', () => {
    const found = filterFiles(files, 'chat', 10);
    expect(found[0]).toBe('src/view/chatView.ts');
    expect(found[1]).toBe('src/view/chatScript.ts');
  });

  it('パスの途中でも当たる', () => {
    expect(filterFiles(files, 'provider/', 10)).toEqual(['src/provider/attachments.ts']);
  });

  it('大文字小文字を区別しない', () => {
    expect(filterFiles(files, 'readme', 10)).toEqual(['README.md']);
  });

  it('当たらなければ空', () => {
    expect(filterFiles(files, 'そんなファイルは無い', 10)).toEqual([]);
  });

  it('上限を超えない', () => {
    expect(filterFiles(files, '', 3)).toHaveLength(3);
  });
});

class FakeScan implements FileScanPort {
  scans = 0;
  skipped: string[] = [];

  constructor(
    private readonly files: Record<string, string[]>,
    private readonly texts: Record<string, string> = {},
  ) {}

  async scan(
    dir: string,
    options: { skipDir(name: string): boolean; limit: number },
  ): Promise<string[]> {
    this.scans++;
    const all = this.files[dir] ?? [];
    // 実体側と同じく、除外ディレクトリの下は返さない
    const kept = all.filter((relPath) => {
      const segments = relPath.split('/').slice(0, -1);
      const hit = segments.find((name) => options.skipDir(name));
      if (hit !== undefined) {
        this.skipped.push(hit);
        return false;
      }
      return true;
    });
    return kept.slice(0, options.limit);
  }

  async readText(filePath: string): Promise<string | undefined> {
    return this.texts[filePath];
  }
}

describe('FileMentionCatalog', () => {
  const cwd = '/w/alpha';

  it('走査した相対パスを返す', async () => {
    const scan = new FakeScan({ [cwd]: ['src/a.ts', 'README.md'] });
    const catalog = new FileMentionCatalog(scan);
    expect(await catalog.list(cwd)).toEqual(['src/a.ts', 'README.md']);
  });

  it('.gitignore に載ったものを落とす', async () => {
    const scan = new FakeScan(
      { [cwd]: ['src/a.ts', 'debug.log'] },
      { [`${cwd}/.gitignore`]: '*.log' },
    );
    const catalog = new FileMentionCatalog(scan);
    expect(await catalog.list(cwd)).toEqual(['src/a.ts']);
  });

  it('.gitignore のディレクトリ指定は走査そのものを止める', async () => {
    const scan = new FakeScan(
      { [cwd]: ['src/a.ts', 'out/bundle.js'] },
      { [`${cwd}/.gitignore`]: 'out/' },
    );
    const catalog = new FileMentionCatalog(scan);
    expect(await catalog.list(cwd)).toEqual(['src/a.ts']);
    expect(scan.skipped).toContain('out');
  });

  it('固定の除外ディレクトリには .gitignore が無くても入らない', async () => {
    const scan = new FakeScan({ [cwd]: ['src/a.ts', 'node_modules/pkg/index.js'] });
    const catalog = new FileMentionCatalog(scan);
    expect(await catalog.list(cwd)).toEqual(['src/a.ts']);
  });

  it('短い間に続けて呼ばれても走査し直さない', async () => {
    const scan = new FakeScan({ [cwd]: ['src/a.ts'] });
    let now = 1_000;
    const catalog = new FileMentionCatalog(scan, () => now);

    await catalog.list(cwd);
    now += 1_000;
    await catalog.list(cwd);
    expect(scan.scans).toBe(1);

    now += 10_000;
    await catalog.list(cwd);
    expect(scan.scans).toBe(2);
  });

  it('別のディレクトリを聞かれたらキャッシュを使わない', async () => {
    const scan = new FakeScan({ [cwd]: ['src/a.ts'], '/w/beta': ['lib/b.ts'] });
    const catalog = new FileMentionCatalog(scan, () => 1_000);

    expect(await catalog.list(cwd)).toEqual(['src/a.ts']);
    expect(await catalog.list('/w/beta')).toEqual(['lib/b.ts']);
    expect(scan.scans).toBe(2);
  });
});
