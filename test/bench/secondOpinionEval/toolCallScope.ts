/* eslint-disable no-console -- 集計結果を出すのがこのファイルの目的 */
/**
 * Advisorが走らせたコマンドを、レビュー材料（bundle）の中と外で数え分ける（Issue #1061）。
 *
 * 費用は「条件Aとの `toolCalls` の差＝探索の増分」として読む設計である（Issue #1047）。ところが
 * Advisorは固定指示に反してbundleの外——`~/.codex/skills/<name>/SKILL.md` など——を読みに行く
 * ことがあり、その回数と失敗が条件Aの側に混ざる。#1061 で `thread/start` のconfigへ
 * `skills.include_instructions=false` を重ねて塞いだが、**それより前に取った実行記録は残る**。
 * ここは、取り直さずに既存の記録から材料の中だけを数えるための集計である。
 *
 * 判定は「コマンド本体に絶対パスが現れるか」で行う。bundleはセッションの作業ディレクトリなので、
 * 材料への参照は `changes.diff` / `base/...` / `after/...` のような相対パスで出る（実測:
 * `eval-results/probe-c-repo-v1/`）。先頭の `/bin/bash -lc` はどのコマンドにも付くため、
 * シェルの起動部分を落としてから見る。
 *
 * **完全な判定ではない。** bundleを絶対パスで指したコマンドは外と数えてしまうし、`$HOME` の
 * ような変数経由の参照は拾えない。回数の内訳を後から言えるようにするための道具であって、
 * 「外を読んでいないことの証明」には使わない（証明の側は上流で塞ぐ #1061 の変更が担う）。
 *
 * 使い方:
 *
 * ```
 * npx tsx test/bench/secondOpinionEval/toolCallScope.ts <結果ディレクトリ>
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

import type { EvalRunRecord, EvalToolCall } from './types';

/** コマンド1件がbundleの中だけを触っていたか。 */
export type ToolCallScope = 'inside' | 'outside';

/**
 * 先頭のシェル起動（`/bin/bash -lc "..."`）を落とす。
 *
 * ここを落とさないと、どのコマンドも `/bin/bash` という絶対パスを持つことになり、全件が
 * 「外」になる。
 */
function stripShellPrefix(detail: string): string {
  return detail.replace(/^\s*\S*\/?(?:ba|z|d|k)?sh\s+-[\w-]*c\s*/u, '');
}

/**
 * コマンド本体に現れる絶対パス。
 *
 * 引用符・パイプ・リダイレクトで切れるところまでを1つのパスとして拾う。`//` で始まるコメント
 * などを拾わないよう、2文字目は `/` 以外に限る。
 */
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`=(])(\/[^/\s"'`;|&)]+(?:\/[^\s"'`;|&)]*)*)/gu;

/** そのコマンドがbundleの外を触っているか。触っていれば `outside`。 */
export function classifyToolCall(call: EvalToolCall): ToolCallScope {
  return absolutePathsIn(call.detail).length === 0 ? 'inside' : 'outside';
}

/** コマンドに現れた絶対パス。判定の根拠を出すために公開している。 */
export function absolutePathsIn(detail: string): string[] {
  const body = stripShellPrefix(detail);
  return [...body.matchAll(ABSOLUTE_PATH_PATTERN)].map((match) => match[1] ?? '');
}

/** 1つの実行記録の内訳。 */
export interface ToolCallScopeBreakdown {
  conditionId: string;
  caseId: string;
  attempt: number;
  /** `commandExecution` の総数。 */
  commands: number;
  inside: number;
  outside: number;
  /** 外を触ったコマンドに現れた絶対パス（重複を除く）。 */
  outsidePaths: string[];
}

/** コマンドの実行だけを見る。回答や推論の項目は数に入れない。 */
const COMMAND_KIND = 'commandExecution';

export function breakdownFor(record: EvalRunRecord): ToolCallScopeBreakdown {
  const commands = record.toolCalls.filter((call) => call.kind === COMMAND_KIND);
  const outside = commands.filter((call) => classifyToolCall(call) === 'outside');
  const paths = new Set(outside.flatMap((call) => absolutePathsIn(call.detail)));
  return {
    conditionId: record.conditionId,
    caseId: record.caseId,
    attempt: record.attempt,
    commands: commands.length,
    inside: commands.length - outside.length,
    outside: outside.length,
    outsidePaths: [...paths].sort(),
  };
}

function readRecords(dir: string): EvalRunRecord[] {
  return fs
    .readdirSync(dir)
    .filter(
      (name) => name.endsWith('.json') && !name.startsWith('cases') && name !== 'manifest.json',
    )
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as EvalRunRecord)
    .filter((record) => Array.isArray(record.toolCalls));
}

function main(): void {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error(
      '使い方: npx tsx test/bench/secondOpinionEval/toolCallScope.ts <結果ディレクトリ>',
    );
    process.exitCode = 1;
    return;
  }
  for (const record of readRecords(dir)) {
    const breakdown = breakdownFor(record);
    console.log(
      `${breakdown.caseId} / ${breakdown.conditionId} / #${breakdown.attempt}: ` +
        `コマンド${breakdown.commands}回（bundle内${breakdown.inside} / 外${breakdown.outside}）`,
    );
    for (const outsidePath of breakdown.outsidePaths) {
      console.log(`  外: ${outsidePath}`);
    }
  }
}

main();
