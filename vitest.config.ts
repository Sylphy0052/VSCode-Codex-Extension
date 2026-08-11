import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 実物の'vscode'は拡張機能ホスト内でしか解決できない。chatView.ts等を
      // 実クラスのままテストできるよう、最小モックへ差し替える（test/mocks/vscode.ts）。
      vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
  test: {
    // 既定のincludeはリポジトリ全体を走査するため、worktree（.claude/worktrees配下）の
    // テストまで拾って件数が二重になる。対象をこのツリーのテストだけに限定する。
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
