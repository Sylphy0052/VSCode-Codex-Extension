import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { waitFor, waitForFileContent } from './helpers/waitFor';

/**
 * 待ちヘルパーそのものの検証（Issue #541、design.md §16.25）。
 *
 * 「ファイルの存在だけを待ってから内容を読む」形が、実際に空を読むことを陽性で示す。
 * これが無いと、`waitForFileContent` が単に `fs.existsSync` を待つだけの実装へ退行しても
 * 統合テストは緑のままになる（退行が現れるのは並列負荷が高いときだけで、平時は再現しない）。
 *
 * 拡張機能へは触れないが、`test/integration` 側のヘルパーを対象にしているためこちらへ置く
 * （`tsconfig.json` は `test/integration/**` を除外しており、ユニット側からは型検査できない）。
 */
suite('待ちヘルパー: 観測したい状態そのものを待つ（Issue #541）', () => {
  const WAIT_OPTIONS = { timeoutMs: 10_000, intervalMs: 20 } as const;

  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waitfor-helper-'));
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('存在だけを待つと空を読む。内容を待てば書き込み後の内容が返る', async function () {
    this.timeout(20_000);
    const target = path.join(dir, 'CLAUDE.md');

    // 「作られてから書き込みが終わるまで」の窓を明示的に作る。並列負荷下で起きているのは
    // これと同じ状態である（Issue #541 の実測: 6並列18回中2回、L-40が `''` を読んで落ちた）
    fs.writeFileSync(target, '');
    const timer = setTimeout(() => {
      fs.writeFileSync(target, '- 常にpnpmを使う\n');
    }, 400);

    try {
      const existed = await waitFor(
        () => fs.existsSync(target),
        (exists) => exists,
        WAIT_OPTIONS,
      );
      assert.equal(existed, true, '存在の待ちが成立していない');
      assert.equal(
        fs.readFileSync(target, 'utf8'),
        '',
        '存在を待った直後に空が読めていない。この対照が成立していないので、下の検証は' +
          '「内容を待てている」ことの証拠にならない',
      );

      const content = await waitForFileContent(
        target,
        (text) => text.includes('pnpm'),
        WAIT_OPTIONS,
      );
      assert.match(content, /- 常にpnpmを使う/);
    } finally {
      clearTimeout(timer);
    }
  });

  test('上限に達したら、最後に読めた内容を添えて落ちる', async function () {
    this.timeout(20_000);
    const target = path.join(dir, 'never-matches.md');
    fs.writeFileSync(target, '途中まで');

    await assert.rejects(
      () => waitForFileContent(target, (text) => text.includes('終わり'), { timeoutMs: 200 }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /途中まで/, '最後に読めた内容がメッセージに無い');
        return true;
      },
    );
  });

  test('ファイルが無いまま上限に達したら、その旨が分かる', async function () {
    this.timeout(20_000);

    await assert.rejects(
      () => waitForFileContent(path.join(dir, 'absent.md'), () => true, { timeoutMs: 200 }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /ファイルが無い/);
        return true;
      },
    );
  });
});
