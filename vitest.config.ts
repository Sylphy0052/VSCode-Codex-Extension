import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 既定のincludeはリポジトリ全体を走査するため、worktree（.claude/worktrees配下）の
    // テストまで拾って件数が二重になる。対象をこのツリーのテストだけに限定する。
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
