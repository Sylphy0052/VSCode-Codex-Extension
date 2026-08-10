import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // worktree（.claude/worktrees配下）は別ツリーなので、ここからは検査しない
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', '.vscode-test/**', '.claude/**'],
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
