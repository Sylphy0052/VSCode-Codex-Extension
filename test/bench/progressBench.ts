/* eslint-disable no-console -- 測定結果を表として出すのがこのファイルの目的 */
/**
 * 進捗画面（issue #721）の状態送信の重さを測る（issue #1024）。
 *
 * `docs/design.md` §9.6 の会話項目の測定と同じ形。webviewへの `postMessage` は
 * 構造化クローンを通るため、直列化のコストを `JSON.stringify` で代理する。
 *
 * 使い方: `npx tsx test/bench/progressBench.ts`
 */
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import { buildProgress } from '../../src/view/progressModel';
import { buildProgressPayload } from '../../src/view/progressDelta';

const RESPONSE = 'これは応答の本文である。'.repeat(20);
const DIFF = '@@ -1,3 +1,4 @@\n-old\n+new\n'.repeat(10);

/**
 * 1ターン分（指示 + 応答 + ファイル変更2件 + コマンド2件）を作る。
 *
 * `distinctFiles` は触るファイルの種類数。`buildSummary` の重複除去と
 * `groupEditedFiles` の共通接頭辞の走査はここに比例するため、外から変えられるようにする。
 */
function turnItems(turn: number, distinctFiles: number): ChatItem[] {
  const base = (kind: string, over: Partial<ChatItem>): ChatItem => ({
    id: `${kind}-${turn}-${Math.random()}`,
    kind,
    text: '',
    detail: '',
    status: undefined,
    turnId: `turn-${turn}`,
    diffs: [],
    ...over,
  });
  return [
    base('userMessage', { text: `指示 ${turn}` }),
    base('agentMessage', { text: RESPONSE }),
    base('fileChange', {
      diffs: [
        {
          path: `src/view/module${turn % distinctFiles}.ts`,
          kind: 'update',
          movePath: undefined,
          diff: DIFF,
          editReplace: undefined,
        },
      ],
    }),
    base('fileChange', {
      diffs: [
        {
          path: `test/unit/module${turn % distinctFiles}.test.ts`,
          kind: 'update',
          movePath: undefined,
          diff: DIFF,
          editReplace: undefined,
        },
      ],
    }),
    base('commandExecution', { detail: `npm test -- -g module${turn}`, status: 'completed' }),
    base('commandExecution', { detail: `git diff --stat`, status: 'completed' }),
  ];
}

function stateOf(itemCount: number, distinctFiles: number): ChatState {
  const items: ChatItem[] = [];
  for (let turn = 0; items.length < itemCount; turn += 1) {
    items.push(...turnItems(turn, distinctFiles));
  }
  return { ...initialChatState, items: items.slice(0, itemCount), busy: true };
}

/** 末尾の応答が1文字伸びた状態を作る。応答中に毎回届く更新の形。 */
function grownTail(state: ChatState): ChatState {
  const items = state.items.slice();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && item.kind === 'agentMessage') {
      items[i] = { ...item, text: `${item.text}続` };
      break;
    }
  }
  return { ...state, items };
}

/** `runs` 回まわして中央値と p95 を返す（ミリ秒）。 */
function measure(runs: number, body: () => void): { p50: number; p95: number } {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    body();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (ratio: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(samples.length * ratio))] ?? 0;
  return { p50: at(0.5), p95: at(0.95) };
}

const COUNTS = [6, 200, 1000, 4000, 10000];
const RUNS = 60;

/**
 * 触るファイルの種類数。40 は同じファイルを往復する現実的な作業、
 * `Infinity` はターンごとに別のファイルを触り続ける最悪の側（重複が一切効かない）。
 */
const DISTINCT_FILES = Number(process.argv[2] ?? 40);

console.log(
  `ファイルの種類数: ${DISTINCT_FILES === Infinity ? 'ターンごとに別（上限なし）' : DISTINCT_FILES}`,
);
console.log(
  '| 項目数 | ターン数 | ファイル数 | 全量サイズ | 全量 p50 | 全量 p95 | 差し分サイズ | 差し分 p50 | 差し分 p95 |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const count of COUNTS) {
  const state = stateOf(count, DISTINCT_FILES);
  const view = buildProgress(state);
  const bytes = Buffer.byteLength(JSON.stringify(view));
  const both = measure(RUNS, () => {
    JSON.stringify(buildProgress(state));
  });
  // 応答中の実際の形に合わせる: 末尾のターンの応答だけが伸びた状態を毎回送る
  const grown = grownTail(state);
  const deltaBytes = Buffer.byteLength(
    JSON.stringify(buildProgressPayload(view, buildProgress(grown))),
  );
  const delta = measure(RUNS, () => {
    JSON.stringify(buildProgressPayload(view, buildProgress(grown)));
  });
  const mb = (value: number): string => `${(value / 1024 / 1024).toFixed(3)}MB`;
  const ms = (v: number): string => `${v.toFixed(2)}ms`;
  console.log(
    `| ${count} | ${view.turns.length} | ${view.summary.editedFiles.length} | ${mb(bytes)} | ${ms(both.p50)} | ${ms(both.p95)} | ${mb(deltaBytes)} | ${ms(delta.p50)} | ${ms(delta.p95)} |`,
  );
}
