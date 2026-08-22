// test:external-cli用のランナー。
//
// なぜこのラッパーが要るか（issue #463）:
// `node --test test/external-cli/*.test.mjs` を直接npm scriptに書くと、シェルの
// グロブ展開に依存する。対象ファイルが1件もマッチしない場合でも`node --test`自体は
// エラーにならず、`tests 0 / pass 0 / fail 0`で終了コード0を返す（実測: Node 24で
// `node --test nonexistent/*.test.mjs` → `tests 0`かつEXIT=0）。ファイルの削除・
// rename・条件付きskip化のいずれでも「何も検査せず緑」になりうる。design.md §9.1の
// 前提を継続検査するというこのジョブの目的（issue #458）を無効化してしまう。
//
// 現状はさらに、CIのNodeが20系であることに偶然守られてもいた。グロブのCLI展開は
// Node 21以降でしか組み込みサポートされないため、Node 20ではシェルがグロブを展開し、
// マッチが無いとリテラル文字列が渡って`Could not find test/external-cli/*.test.mjs`で
// exit 1になっていた。CIのNodeを21以降へ上げた時点でこの偶然の防御は消えるため、
// ここではNodeのバージョンに関わらず対象ファイルの存在を明示的に検査する。
//
// 対象ディレクトリの実ファイルをreaddirSyncで列挙し、1件もなければガードでexit 1に
// する。マッチしたファイルはグロブではなく明示的なパス配列としてnode --testへ渡す。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const TARGET_DIR = 'test/external-cli';

const files = readdirSync(TARGET_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `${TARGET_DIR}/${name}`);

if (files.length === 0) {
  process.stderr.write(
    `[run-external-cli-tests] ${TARGET_DIR}に*.test.mjsが1件も無い。` +
      'design.md §9.1の前提を検査するテスト（issue #458）が実行されずに' +
      '緑判定になるのを防ぐため、対象0件はエラー扱いにする。\n',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`[run-external-cli-tests] node --testの起動に失敗した: ${result.error}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
