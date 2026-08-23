import { existsSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// フィクスチャの実体はJavaScript（`setup.mjs`、ESM）。型は `setup.d.mts` で与えている。
// このテスト自身はCommonJSとして型付けされるため、静的importでは読めない（TS1479）。
// このファイルは `test/unit/integrationFixtureGuards.test.ts` と同じ流儀（動的import）で
// 書くが、扱う対象は別（あちらは起点の安全性ガード、こちらはフィクスチャの根の生成）なので
// ファイルを分けた。

type CreateFixturesRoot = () => string;
let createFixturesRoot: CreateFixturesRoot;

beforeAll(async () => {
  const fixtures = await import('../integration/fixtures/setup.mjs');
  createFixturesRoot = fixtures.createFixturesRoot;
});

// vitestは常にリポジトリの根から走る（`test/unit/integrationFixtureGuards.test.ts` と同じ前提）。
const repoRoot = process.cwd();

const createdRoots: string[] = [];

afterAll(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * `createFixturesRoot()`（Issue #608）の検証。
 *
 * 同じworktreeで統合テストを2プロセス同時に走らせたとき、後から来たプロセスが
 * 先行プロセスの使用中ディレクトリを消してしまわないよう、フィクスチャの根を
 * プロセスごとにユニークにする。`prepareFixtures()` から一度だけ呼ばれ、返り値の下へ
 * `workspaceFolder` 等がぶら下がる。
 *
 * 「プロセス終了時に自分が作った根だけを消し、他プロセスの分やダウンロードキャッシュへは
 * 触れない」ことは `process.on('exit', ...)` に張ったフックの中身であり、フックは
 * プロセスが実際に終了するときにしか走らないため、このテストの実行中には観測できない
 * （振る舞いのテストで書けない不変条件はソースの並び順で守ってよい、
 * docs/roadmap/ops-rules.md）。目視でも `createFixturesRoot` の実装内で
 * `rmSync` の対象が関数自身の返り値（`root`）のみであることを確認済み。
 */
describe('createFixturesRoot', () => {
  it('呼ぶたびに異なるパスを返す（同時実行での衝突を避ける）', () => {
    const first = createFixturesRoot();
    const second = createFixturesRoot();
    createdRoots.push(first, second);

    expect(first).not.toBe(second);
  });

  it('<repoRoot>/.vscode-test/ の直下に作られる', () => {
    const root = createFixturesRoot();
    createdRoots.push(root);

    const expectedParent = realpathSync(join(repoRoot, '.vscode-test'));
    expect(realpathSync(dirname(root))).toBe(expectedParent);
  });

  it('返った時点でディレクトリが実在する', () => {
    const root = createFixturesRoot();
    createdRoots.push(root);

    expect(existsSync(root)).toBe(true);
  });
});
