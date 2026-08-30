/* eslint-disable no-console -- 検証結果を出すのがこのファイルの目的 */
/**
 * ハーネスがCodex CLIのプロトコルを正しく読めているかを1回だけ確かめる（Issue #1044）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/probe.ts [--out <トレース出力先>]
 * ```
 *
 * **本番の案件を1件流して「回答が返ったからよし」とするのでは足りない。** ハーネスは本体と同じ
 * `applyEvent` / `lastNonEmptyAgentMessageText` を使っているので、読み方が間違っていれば本体と
 * 同じように間違え、辻褄が合ってしまう。ここでは答えが分かっている問いを投げ、
 *
 * - ツールを1回使わせる（材料を読ませる経路が生きているか）
 * - 先頭と末尾に目印を書かせる（回答の頭と終わりが欠けていないか）
 * - ファイル内の値を読ませる（読んだ内容が本当に回答へ入るか）
 *
 * を同時に見る。生のJSON-RPCも全部残すので、`applyEvent` の解釈と突き合わせられる。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

import { runCodexTurn } from './codexTurn';

const MODEL = process.env['PROBE_MODEL'] ?? 'gpt-5.6-sol';
const EFFORT = process.env['PROBE_EFFORT'] ?? 'low';

function parseOut(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--out');
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const nonce = randomUUID().slice(0, 8);
  const secret = randomUUID();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-probe-'));
  const traceFile = parseOut(process.argv.slice(2)) ?? path.join(dir, 'trace.jsonl');

  await fs.writeFile(
    path.join(dir, 'probe.txt'),
    `この行は無視してよい。\nPROBE_VALUE=${secret}\nこの行も無視してよい。\n`,
    'utf8',
  );

  const prompt = [
    `作業ディレクトリの probe.txt を読んでから、次の形式でだけ答えてください。`,
    '',
    `1行目: START_${nonce}`,
    '2行目: probe.txt に書かれている PROBE_VALUE の値',
    '3行目以降: この確認の手順を5行以上で説明する（回答が途中で切れていないかを見るため）',
    `最終行: END_${nonce}`,
  ].join('\n');

  console.log(`[probe] cwd=${dir}`);
  console.log(`[probe] trace=${traceFile}`);
  const result = await runCodexTurn({ cwd: dir, prompt, model: MODEL, effort: EFFORT, traceFile });

  const response = result.response;
  const checks: { label: string; ok: boolean; detail: string }[] = [
    {
      label: 'ターンが正常終了した',
      ok: result.error === undefined,
      detail: result.error ?? 'エラーなし',
    },
    {
      label: '回答の本文を取得できた',
      ok: response.trim() !== '',
      detail: `${response.length} 文字`,
    },
    {
      label: '回答の先頭が欠けていない',
      ok: response.includes(`START_${nonce}`),
      detail: `START_${nonce}`,
    },
    {
      label: '回答の末尾まで取得できている',
      ok: response.trimEnd().endsWith(`END_${nonce}`),
      detail: `END_${nonce}`,
    },
    {
      label: 'ファイルを読んだ内容が回答へ入っている',
      ok: response.includes(secret),
      detail: 'PROBE_VALUE',
    },
    {
      label: 'トークン使用量を取得できた',
      ok: typeof result.sessionTokens === 'number',
      detail: String(result.sessionTokens),
    },
  ];

  for (const check of checks) {
    console.log(`[probe] ${check.ok ? 'OK  ' : 'NG  '} ${check.label}（${check.detail}）`);
  }
  console.log(`[probe] latency=${result.latencyMs}ms`);
  console.log('[probe] 回答（先頭200文字）:');
  console.log(response.slice(0, 200));

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(
      `[probe] ${failed.length} 件失敗。${traceFile} の生イベントと突き合わせて、` +
        'どのイベントを取り違えているかを特定すること。',
    );
    process.exitCode = 1;
    return;
  }
  console.log('[probe] 全項目OK。本番の案件を流してよい。');
}

main().catch((e: unknown) => {
  console.error(`[probe] 失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
