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
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
);
