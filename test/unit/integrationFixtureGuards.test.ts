import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// フィクスチャの実体はJavaScript（`setup.mjs`、ESM）。型は `setup.d.mts` で与えている。
// このテスト自身はCommonJSとして型付けされるため、静的importでは読めない（TS1479）。
type Guard = (label: string, dir: string) => void;
let assertOutsideThisRepository: Guard;
let assertIsolatedGitRepo: Guard;

beforeAll(async () => {
  const fixtures = await import('../integration/fixtures/setup.mjs');
  assertOutsideThisRepository = fixtures.assertOutsideThisRepository;
  assertIsolatedGitRepo = fixtures.assertIsolatedGitRepo;
});

/**
 * 統合テストの実行がこのリポジトリ自身を掴んで `origin` へpushしうる構造を塞ぐガード
 * （Issue #178）の検証。ガード本体は `test/integration/fixtures/setup.mjs` にあり、
 * `.vscode-test.mjs` の読み込み時＝VSCodeが起動するより前に呼ばれる。
 */

// vitestは常にリポジトリの根から走る（`test/unit/nodeFileScan.test.ts` と同じ前提）。
const repoRoot = process.cwd();

const temporaries: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

function initRepo(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'unit-test@example.invalid');
  git('config', 'user.name', 'Unit Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'ガードの検証用\n', 'utf8');
  git('add', 'README.md');
  git('commit', '--no-verify', '-m', 'chore: 初期コミット');
}

afterAll(() => {
  for (const dir of temporaries) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('assertOutsideThisRepository', () => {
  it('このリポジトリの作業ツリーの外なら通す', () => {
    expect(() => assertOutsideThisRepository('起点', makeTempDir('guard-outside-'))).not.toThrow();
  });

  it('このリポジトリの作業ツリーの中なら投げる（.gitignore済みでも同じ）', () => {
    // 実行がここを起点にすると、ワークフローはこのリポジトリ自身へworktree・ブランチを作り、
    // origin へpushしうる（#168で実際に起きた）。
    const inside = join(repoRoot, '.vscode-test', 'guard-check');
    mkdirSync(inside, { recursive: true });
    temporaries.push(inside);
    expect(() => assertOutsideThisRepository('起点', inside)).toThrow(/#178/u);
  });

  it('このリポジトリ自身の根も投げる', () => {
    expect(() => assertOutsideThisRepository('起点', repoRoot)).toThrow(/#178/u);
  });
});

describe('assertIsolatedGitRepo', () => {
  it('自分自身を根とし、remoteを持たないリポジトリなら通す', () => {
    const dir = makeTempDir('guard-isolated-');
    initRepo(dir);
    expect(() => assertIsolatedGitRepo('ワークスペース', dir)).not.toThrow();
  });

  it('gitリポジトリになっていなければ投げる', () => {
    expect(() => assertIsolatedGitRepo('ワークスペース', makeTempDir('guard-nogit-'))).toThrow(
      /#178/u,
    );
  });

  it('親のリポジトリへ遡って解決される場合は投げる', () => {
    const parent = makeTempDir('guard-parent-');
    initRepo(parent);
    const child = join(parent, 'nested');
    mkdirSync(child, { recursive: true });
    expect(() => assertIsolatedGitRepo('ワークスペース', child)).toThrow(/#178/u);
  });

  it('remoteが設定されていれば投げる（pushの到達先を持たせない）', () => {
    const dir = makeTempDir('guard-remote-');
    initRepo(dir);
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/repo.git'], {
      cwd: dir,
      stdio: 'pipe',
    });
    expect(() => assertIsolatedGitRepo('ワークスペース', dir)).toThrow(/#178/u);
  });
});
