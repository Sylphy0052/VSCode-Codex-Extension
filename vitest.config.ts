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
    // test/integration（@vscode/test-electron、実VSCode上で動く）はvitestのプロセス内では
    // 実行できない（実物の'vscode'モジュールが要る）ため、test/unit配下だけに絞る。
    include: ['test/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // #455: 実測（statements 74.92% / branches 72.33% / functions 74.93% / lines 74.82%、
      // Issue #386調査時点）を下回らない値で下限を敷き、以後の低下だけを防ぐ。
      // 80%への引き上げは段階的に別Issueで行う（詳細はdocs/repository-hygiene.mdを参照）。
      // #1852: CIがLintで止まっていた間に実測が下限を割った（lines 60.76% / functions 58.3% /
      // statements 60.35% / branches 54.18%）。その実測値まで下げ、以後の低下を止める。
      // 70/68/70/70へ戻す作業は#1854で行う。taskRun系のテスト追加後の実測（statements 67.6% /
      // branches 61.97% / functions 67.35% / lines 67.97%）の小数以下を切り捨てた値へ引き上げた。
      // chatView系のテスト追加後の実測（statements 73.71% / branches 67.63% / functions 73.26% /
      // lines 74.17%）で、statements・functions・linesは70へ戻り、branchesだけ67へ引き上げた。
      // sandbox系・endSummary等のテスト追加後の実測（statements 75.14% / branches 69.2% /
      // functions 74.56% / lines 75.6%）で全指標が#455の下限を超えたため、70/68/70/70へ戻した。
      thresholds: {
        statements: 70,
        branches: 68,
        functions: 70,
        lines: 70,
      },
    },
  },
});
