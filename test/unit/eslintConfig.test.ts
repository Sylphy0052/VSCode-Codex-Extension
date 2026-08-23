import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * eslintの型情報ルールが実際に効いていることを検査する（Issue #649 / WF-G T26）。
 *
 * 型情報を要するルール（`no-floating-promises` など）は、`parserOptions.project` の
 * 指定が外れても**エラーにはならず、ルールが黙って何も検出しなくなる**。lintは緑の
 * ままなので、設定が壊れたことに誰も気づけない。
 *
 * そのため**実効設定にルール名が載っていることを見るだけでは足りない**。ルールの指定は
 * `project` を外しても残るので、その検査は設定の壊れ方を素通りさせる。ここでは違反する
 * コードを一時的に置いて、実際に検出されることを確かめる。実測で確認した壊れ方は2つ:
 * `tsconfig.integration.json` を渡すのをやめると `test/integration` 側だけが素通りし、
 * ルールの指定を消すと両方が素通りする。
 *
 * vitestはリポジトリルートで動く（`vitest.config.ts` の位置が基準）。
 */
const repoRoot = process.cwd();

/**
 * ESLintの起動にはTypeScriptのプログラム構築が要り、このリポジトリの規模では
 * 単独実行で約3秒、他のテストと並列に走ると10秒を超える。vitestの既定の5秒では
 * 原理的に足りないため、このファイルのテストにだけ長いタイムアウトを置く。
 * 個別のタイムアウトで間欠的な失敗を先送りしているのではなく、**このテストの
 * 実行時間そのものが既定を超える**ということである。
 */
const ESLINT_TIMEOUT_MS = 120_000;

/** awaitもvoidも付けずにPromiseを投げっぱなしにする、`no-floating-promises` の違反。 */
const FLOATING_PROMISE_SOURCE = 'export function probe(): void {\n  Promise.resolve(1);\n}\n';

/**
 * `src` と `test/integration` の両方へ違反コードを置き、1回のlintで検査する。
 *
 * 実ファイルを書くのは、型情報ルールが `tsconfig` の `include` から組み立てた
 * TypeScriptのプログラムを見るためである。`lintText` に仮想のパスを渡すと、その
 * ファイルはプログラムに含まれず型情報が付かない。
 *
 * 2箇所を1回のlintにまとめているのは、プログラムの構築がこのテストの所要のほぼ全てで、
 * ESLintを2回起動すると倍かかるため。
 */
const PROBE_FILES = [
  // tsconfig.jsonが見ている側。
  'src/t26FloatingPromiseProbe.ts',
  // tsconfig.jsonのexcludeに入っており、tsconfig.integration.jsonを渡していないと
  // 型情報が付かない側。
  'test/integration/t26FloatingPromiseProbe.ts',
] as const;

async function lintProbeFiles(): Promise<Map<string, string[]>> {
  const absolutes = PROBE_FILES.map((relative) => path.join(repoRoot, relative));
  await Promise.all(absolutes.map((absolute) => writeFile(absolute, FLOATING_PROMISE_SOURCE)));
  try {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles([...absolutes]);
    return new Map(
      results.map((result) => [
        path.relative(repoRoot, result.filePath),
        result.messages.map((message) => message.ruleId ?? ''),
      ]),
    );
  } finally {
    await Promise.all(absolutes.map((absolute) => rm(absolute, { force: true })));
  }
}

async function rulesFor(file: string): Promise<Record<string, unknown>> {
  const eslint = new ESLint({ cwd: repoRoot });
  const config = (await eslint.calculateConfigForFile(path.join(repoRoot, file))) as {
    rules?: Record<string, unknown>;
  };
  return config.rules ?? {};
}

/**
 * ルールが設定されているかを返す。
 *
 * `calculateConfigForFile` が返すのは正規化済みの設定で、severityは文字列（`'error'`）
 * ではなく**数値**（`2`）、値は常に配列（`[2]` や `[2, {...}]`）で入る。設定ファイルに
 * 書いた見た目のまま比べると、有効なのに `undefined` として読めてしまう。
 */
function isConfigured(rules: Record<string, unknown>, name: string): boolean {
  return Array.isArray(rules[name]);
}

describe('eslintの型情報ルール', () => {
  it(
    'srcとtest/integrationの両方で未処理のPromiseを検出する',
    async () => {
      const byFile = await lintProbeFiles();
      for (const relative of PROBE_FILES) {
        expect(byFile.get(relative), relative).toContain('@typescript-eslint/no-floating-promises');
      }
    },
    ESLINT_TIMEOUT_MS,
  );

  it(
    '未処理Promiseの相方のルールも設定されている',
    async () => {
      const rules = await rulesFor('src/extension.ts');
      expect(isConfigured(rules, '@typescript-eslint/no-misused-promises')).toBe(true);
      expect(isConfigured(rules, '@typescript-eslint/await-thenable')).toBe(true);
    },
    ESLINT_TIMEOUT_MS,
  );

  it(
    '型情報ルールはTypeScript以外へは当てない（設定ファイル自身など）',
    async () => {
      const rules = await rulesFor('eslint.config.mjs');
      expect(isConfigured(rules, '@typescript-eslint/no-floating-promises')).toBe(false);
    },
    ESLINT_TIMEOUT_MS,
  );

  it(
    'require-awaitは採っていない（導入時点で350件出るため）',
    async () => {
      const rules = await rulesFor('src/extension.ts');
      expect(isConfigured(rules, '@typescript-eslint/require-await')).toBe(false);
    },
    ESLINT_TIMEOUT_MS,
  );
});
