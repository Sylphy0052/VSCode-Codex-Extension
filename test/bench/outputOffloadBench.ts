/* eslint-disable no-console -- 測定結果を表として出すのがこのファイルの目的 */
/**
 * ツール出力のセッション総量の上限（issue #1325）の効き方を測る。
 *
 * 実モデル・実CLIを呼ばない。台本で作った `ChatState` に対して退避を回し、抱えている
 * 本文の量と、部分文字列が親を掴んだままになる問題の直り方を出す。
 *
 *     npx tsx test/bench/outputOffloadBench.ts
 *     NODE_OPTIONS=--expose-gc npx tsx test/bench/outputOffloadBench.ts --retention slice
 *     NODE_OPTIONS=--expose-gc npx tsx test/bench/outputOffloadBench.ts --retention detach
 *
 * 既定の測り方が「抱えている本文の文字数」なのは、プロセス内のメモリ量がこの規模では
 * 物差しにならないため。`heapUsed` は大きな文字列を数えきれず（実測: 50件×20万文字を
 * 載せても0.2MBしか動かない）、`rss` はGCの後もOSへ返らないうえ、退避の書き出しで
 * 増える分が混ざる。
 *
 * `--retention` はそのメモリ量が読める規模（120万文字×200件）で、`slice` のまま末尾を
 * 残すと親の全文が残り、コピーへ通すと手放せることを示す。`detachSubstring`
 * （`appserver/chatState.ts`）がこれを直している。2つのモードは**別プロセスで**走らせて
 * 見比べる。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_OUTPUT_CHARS,
  NO_DIFFS,
  detachSubstring,
  initialChatState,
} from '../../src/appserver/chatState';
import type { ChatItem, ChatState } from '../../src/appserver/chatState';
import {
  MAX_SESSION_OUTPUT_CHARS,
  OFFLOAD_PREVIEW_CHARS,
  applyOutputOffload,
  planOutputOffload,
  sessionOutputChars,
  type OutputOffloadPort,
} from '../../src/appserver/outputOffload';
import { createNodeOutputOffload } from '../../src/session/nodeOutputOffload';

/** 台本の会話の長さ。1件あたりの上限（200,000文字）まで出したコマンドを並べる。 */
const COMMAND_ITEMS = 400;

/** `--retention` で使う本数と1本の長さ。メモリ量が読める規模にする。 */
const RETENTION_ITEMS = 200;
const RETENTION_CHARS = 1_200_000;

function buildState(): ChatState {
  const items: ChatItem[] = [];
  for (let i = 0; i < COMMAND_ITEMS; i += 1) {
    items.push({
      id: `user_${i}`,
      kind: 'userMessage',
      text: `${i}件目の指示`,
      detail: '',
      status: undefined,
      turnId: `turn_${i}`,
      diffs: NO_DIFFS,
    });
    items.push({
      id: `cmd_${i}`,
      kind: 'commandExecution',
      // 上限まで出したコマンド。同じ文字の繰り返しだけにせず、件数を混ぜる
      text: `${i}:`.repeat(MAX_OUTPUT_CHARS / 3),
      detail: `find / -name '*.log' # ${i}`,
      status: 'completed',
      turnId: `turn_${i}`,
      diffs: NO_DIFFS,
    });
  }
  return { ...initialChatState, items };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

/**
 * 上限を下回るまで退避を繰り返す。呼び出し側のフレームに控えた本文を残さないため、
 * ループはこの関数の中だけで完結させる。
 */
async function runOffload(
  initial: ChatState,
  port: OutputOffloadPort,
): Promise<{ state: ChatState; saved: number }> {
  let state = initial;
  let saved = 0;
  for (;;) {
    const plan = planOutputOffload(state.items);
    if (plan.length === 0) {
      return { state, saved };
    }
    for (const entry of plan) {
      if (await port.save(entry.id, entry.text)) {
        saved += 1;
      }
    }
    const next = applyOutputOffload(state, plan);
    if (next === state) {
      return { state, saved };
    }
    state = next;
  }
}

/**
 * 末尾だけを残したあと、元の全文が回収されるかを測る。
 *
 * `slice` は親への参照を持つ文字列を返すため、末尾4,000文字しか使わなくても元の全文が
 * 残る。`--expose-gc` 付きで走らせて、2つのモードを別プロセスで見比べる。
 */
function runRetention(mode: 'slice' | 'detach'): void {
  let source: (string | null)[] = [];
  for (let i = 0; i < RETENTION_ITEMS; i += 1) {
    source.push(`ab${i % 10}`.repeat(RETENTION_CHARS / 3));
  }
  const kept: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const text = source[i] ?? '';
    const tail = text.slice(text.length - OFFLOAD_PREVIEW_CHARS);
    kept.push(mode === 'detach' ? detachSubstring(tail) : tail);
    source[i] = null;
  }
  source = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  gc?.();
  const usage = process.memoryUsage();
  console.log(`切り出し方: ${mode}`);
  console.log(
    `元の本文: ${RETENTION_ITEMS}件 × ${RETENTION_CHARS.toLocaleString()}文字 → ` +
      `残したのは各 ${OFFLOAD_PREVIEW_CHARS.toLocaleString()}文字`,
  );
  console.log(`heapUsed: ${mb(usage.heapUsed)} / rss: ${mb(usage.rss)}`);
  console.log(`残している文字数: ${(kept.length * OFFLOAD_PREVIEW_CHARS).toLocaleString()}`);
}

async function main(): Promise<void> {
  const retentionAt = process.argv.indexOf('--retention');
  if (retentionAt !== -1) {
    runRetention(process.argv[retentionAt + 1] === 'detach' ? 'detach' : 'slice');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'output-offload-bench-'));
  const port = createNodeOutputOffload(dir, (m) => console.error(m));
  try {
    const startedAt = Date.now();
    const initial = buildState();
    const before = sessionOutputChars(initial.items);
    const { state, saved } = await runOffload(initial, port);
    const elapsed = Date.now() - startedAt;
    const restored = await port.load('cmd_0');

    console.log(`項目数: ${state.items.length}（コマンド ${COMMAND_ITEMS}件）`);
    console.log(`上限: ${MAX_SESSION_OUTPUT_CHARS.toLocaleString()}文字`);
    console.log(
      `ツール出力の合計: ${before.toLocaleString()} → ` +
        `${sessionOutputChars(state.items).toLocaleString()}文字`,
    );
    console.log(`退避した件数: ${saved}件 / ${elapsed}ms`);
    console.log(
      `退避した本文の読み戻し: ${
        restored === undefined ? '失敗' : `${restored.length.toLocaleString()}文字`
      }`,
    );
  } finally {
    port.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
