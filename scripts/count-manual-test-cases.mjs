#!/usr/bin/env node
/**
 * `docs/manual-test.md` の実機確認ケースを群ごとに数え、範囲の表記を組み立てる。
 *
 * `docs/manual-test-plan.md` の「対象と件数」は手で書かれており、ケースを足すたびに
 * 更新し忘れて実態から離れていた（issue #1028。それ以前にも issue #498 が
 * `manual-test.md` の「進め方」節で同じ状態を直している）。数え直せる形にしておけば、
 * 次に足したときも突き合わせられる。
 *
 * 使い方: `node scripts/count-manual-test-cases.mjs`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'docs/manual-test.md'), 'utf8');

/** 群ごとの表示名。`docs/manual-test-plan.md` の表に合わせる。 */
const GROUP_NAMES = {
  C: 'Codex画面（app-server）',
  L: 'Claude Code画面（stream-json）',
  P: 'ループ実行',
  H: '履歴とタブ復元',
  A: '作業記録（日報連携）',
  W: 'ワークフロー（並列オーケストレーション）',
  U: 'UX改善（横断機能）とチャットの会話操作',
};

/** 表に出す順。plan の表と同じ並びにする。 */
const GROUP_ORDER = ['C', 'L', 'P', 'H', 'A', 'W', 'U'];

const ids = [...source.matchAll(/^### ([A-Z])-([0-9]+|[A-Z]+)([a-z]?)/gm)].map((m) => ({
  group: m[1],
  number: /^[0-9]+$/.test(m[2]) ? Number(m[2]) : null,
  letter: /^[0-9]+$/.test(m[2]) ? null : m[2],
  suffix: m[3],
  id: `${m[1]}-${m[2]}${m[3]}`,
}));

const byGroup = new Map();
for (const item of ids) {
  const list = byGroup.get(item.group) ?? [];
  list.push(item);
  byGroup.set(item.group, list);
}

/**
 * 並べ替え。番号のケースが先、`W-A` のような英字のケースは英字順。
 *
 * 配列を返して `<` で比べると文字列化された辞書順になり、`C-10` が `C-02` より前へ来る。
 * 項目ごとに数値として比べる。
 */
function compare(a, b) {
  const an = a.number ?? Number.MAX_SAFE_INTEGER;
  const bn = b.number ?? Number.MAX_SAFE_INTEGER;
  if (an !== bn) {
    return an - bn;
  }
  const al = a.letter ?? '';
  const bl = b.letter ?? '';
  if (al !== bl) {
    return al < bl ? -1 : 1;
  }
  return a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0;
}

/**
 * 連続した番号を `C-14〜C-17` の形へまとめる。
 *
 * 枝番（`C-33b`）は本体と同じ塊に入れる。plan の表は範囲で書いてあり、枝番を
 * 別扱いにすると「38件」のような手書きの数と合わなくなるため。
 */
function formatRanges(items) {
  const sorted = [...items].sort(compare);
  const parts = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && isContinuous(sorted[end], sorted[end + 1])) {
      end += 1;
    }
    parts.push(start === end ? sorted[start].id : `${sorted[start].id}〜${sorted[end].id}`);
    start = end + 1;
  }
  return parts.join(', ');
}

function isContinuous(a, b) {
  if (a.letter !== null && b.letter !== null) {
    return b.letter.charCodeAt(0) === a.letter.charCodeAt(0) + 1;
  }
  if (a.number === null || b.number === null) {
    return false;
  }
  // 同じ番号の枝番（C-52 → C-52b）と、次の番号（C-14 → C-15）を続きとみなす
  return b.number === a.number || b.number === a.number + 1;
}

let total = 0;
console.log('| 群  | 対象 | 件数 | 範囲 |');
console.log('| --- | ---- | ---- | ---- |');
for (const group of GROUP_ORDER) {
  const items = byGroup.get(group) ?? [];
  total += items.length;
  console.log(`| ${group}群 | ${GROUP_NAMES[group]} | ${items.length} | ${formatRanges(items)} |`);
}
console.log(`\n合計: ${total}件`);

const unknown = [...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g));
if (unknown.length > 0) {
  console.log(`\n表に無い群: ${unknown.join(', ')}（GROUP_NAMES と GROUP_ORDER へ足すこと）`);
}
