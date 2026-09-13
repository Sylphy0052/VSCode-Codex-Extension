import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
// 根拠付きの手動記録から表示用の台帳を生成する。精査状態は推定しない。
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const inventory = JSON.parse(fs.readFileSync(path.join(directory, 'inventory.json'), 'utf8'));
const records = JSON.parse(fs.readFileSync(path.join(directory, 'reviewed.json'), 'utf8'));
const tracked = cp
  .execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const extra = tracked.filter(
  (p) =>
    !inventory.files.some((f) => f.path === p) &&
    (p.startsWith('test/') ||
      /^docs\/(?:manual-test.*\.md|integration-testing\.md|second-opinion-eval\.md|fixtures\/)/.test(
        p,
      )),
);
const files = [
  ...inventory.files,
  ...extra.map((p) => ({
    path: p,
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(root, p)))
      .digest('hex'),
    units: [],
    embedded: [],
  })),
];
const currentHashes = new Map(
  files.map((f) => {
    const absolute = path.join(root, f.path);
    return [
      f.path,
      fs.existsSync(absolute)
        ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
        : undefined,
    ];
  }),
);
const status = (f) =>
  records[f.path] && records[f.path].sha256 === f.sha256 && f.sha256 === currentHashes.get(f.path)
    ? `[静的精査済](${records[f.path].evidence})`
    : '未精査';
const count = (f, kind) => f.units.filter((u) => u.kind === kind).length;
const branchCount = (f) =>
  f.units.filter((u) => !['function', 'test-definition', 'assertion'].includes(u.kind)).length;
const done = files.filter((f) => status(f) !== '未精査');
const rows = files.map(
  (f) =>
    `|[${f.path}](../../../${f.path})|${count(f, 'function')}|${branchCount(f)}|${count(f, 'test-definition')} / ${count(f, 'assertion')}|${f.embedded.length}|${status(f)}|`,
);
fs.writeFileSync(
  path.join(directory, 'files.md'),
  `# 全件台帳\n\n基準:${inventory.commit}。静的精査済${done.length}/${files.length}ファイル、残${files.length - done.length}ファイル。コード${inventory.files.length}件、手動テスト文書・fixture${extra.length}件。テスト未実行。\n\n関数・分岐・テスト候補は外側の構文数。候補の重複・埋め込み候補・暗黙の例外については[集計定義](README.md)を参照。精査済みは全試験の成功や分岐カバレッジを意味しない。コードのSHA-256が変われば未精査に戻す。\n\n|ファイル|関数|分岐構文|テスト定義候補 / assertion候補|埋め込み候補|状態・根拠|\n|---|---:|---:|---:|---:|---|\n${rows.join('\n')}\n`,
);
process.stdout.write(
  JSON.stringify({
    reviewed: done.length,
    total: files.length,
    pending: files.length - done.length,
    extra: extra.length,
  }),
);
