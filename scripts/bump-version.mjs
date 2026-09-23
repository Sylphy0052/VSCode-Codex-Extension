// `npm run package`の前にバージョンを日付と連番で振り直す（issue #1364）。
//
// 形式は`YYYY.MDD.N`（例: 2026-09-23の1回目は`2026.923.1`）。VS Code拡張のバージョンは
// semverで、各数値に先頭ゼロを付けられない。そのため月日は「月×100+日」の数値にする。
// この形なら日付順とsemverの大小が一致する。
//
// `N`はその日の連番。今の`version`が今日の`YYYY.MDD`で始まっていれば`N+1`、
// そうでなければ`1`にする。日付はビルドした端末のローカル時刻で決める。
// GitHub Releaseでは`RELEASE_SEQUENCE`にワークフロー実行番号を渡す。
import { readFileSync, writeFileSync } from 'node:fs';

const now = new Date();
const prefix = `${now.getFullYear()}.${(now.getMonth() + 1) * 100 + now.getDate()}`;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const match = /^(\d+\.\d+)\.(\d+)$/.exec(pkg.version);
const releaseSequence = process.env.RELEASE_SEQUENCE;
if (
  releaseSequence !== undefined &&
  (!/^[1-9]\d*$/.test(releaseSequence) || !Number.isSafeInteger(Number(releaseSequence)))
) {
  throw new Error('RELEASE_SEQUENCE must be a positive integer');
}
const seq =
  releaseSequence !== undefined
    ? Number(releaseSequence)
    : match !== null && match[1] === prefix
      ? Number(match[2]) + 1
      : 1;
const version = `${prefix}.${seq}`;

pkg.version = version;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

// package-lock.jsonも揃えておかないと、次の`npm install`で差分が出る
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = version;
lock.packages[''].version = version;
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);

console.log(`version: ${version}`);
