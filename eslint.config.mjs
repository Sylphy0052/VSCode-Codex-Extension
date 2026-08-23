import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // worktree（.claude/worktrees配下）は別ツリーなので、ここからは検査しない
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '.vscode-test/**',
      '.claude/**',
      // test/integration（tsconfig.integration.json）のコンパイル出力。ソースは
      // test/integration/**/*.ts 側で検査する
      'out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // 型情報を要するルール（Issue #649 / WF-G T26）。TypeScriptのソースにだけ当てる。
  // 型情報が要るため、tsconfigを2つとも渡す。tsconfig.jsonはsrc/**とtest/unit/**を
  // 見ており、test/integration/**はそのexcludeに入っているためtsconfig.integration.json
  // が要る。片方だけだと、渡していない側の全ファイルがParsing errorになる
  // （実測: tsconfig.jsonだけの場合、test/integration/**の24ファイルが落ちた）。
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.integration.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 本題。awaitもvoidも付けずに投げっぱなしにしたPromiseを検出する。
      // 型情報が無いと「その式がPromiseかどうか」が分からないため、このルールは
      // 型情報付きの設定でしか動かない。
      '@typescript-eslint/no-floating-promises': 'error',
      // Promiseを返す関数を、Promiseを期待しない場所（void を返す約束のコールバック、
      // 条件式など）へ渡すのを検出する。投げっぱなしのPromiseが生まれる別の経路。
      '@typescript-eslint/no-misused-promises': 'error',
      // Promiseでないものへのawait。害は小さいが、上の2つを入れるなら同時に入る。
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  // require-awaitは採らない。導入時点の実測で350件出る。「asyncだがawaitが無い」の
  // 大半は、Promiseを返す約束（インターフェース側の都合）を守っている実装であり、
  // 直す価値に対して差分が大きすぎる。
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
);
