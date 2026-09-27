import { describe, expect, it } from 'vitest';
import type { CliCommandResult, CliCommandRunner, ForgeFileSystemPort } from '../../src/orchestrator/forge';
import { fetchChildBodies } from '../../src/orchestrator/roadmapPlanProposal';
import type {
  RoadmapChild,
  RoadmapImportDeps,
  RoadmapImportTarget,
} from '../../src/orchestrator/roadmapImport';

/**
 * レビュー指摘（Issue #1581 item2）: 子Issueの本文を1件ずつ順に取得すると、子Issueが多い
 * ロードマップで計画の解決が遅くなる。現状の実装（`FETCH_CONCURRENCY`件を上限にした
 * ワーカープール）が実際に並列で取得することを固定する回帰テスト。
 */

const FETCH_CONCURRENCY = 4;

class ConcurrencyTrackingCli implements CliCommandRunner {
  calls = 0;
  active = 0;
  maxActive = 0;

  async run(_command: string, _args: readonly string[], _cwd: string): Promise<CliCommandResult> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active -= 1;
    return { code: 0, stdout: JSON.stringify({ body: 'x' }), stderr: '' };
  }
}

const fs: ForgeFileSystemPort = {
  async writeTempFile(): Promise<string> {
    return '/tmp/fake-body';
  },
  async removeTempFile(): Promise<void> {},
};

const target: RoadmapImportTarget = { host: 'github', cwd: '/tmp', roadmapIssueNumber: 1 };

describe('fetchChildBodies', () => {
  it('FETCH_CONCURRENCY件を上限に並列で子Issueの本文を取得する（直列取得ではない）', async () => {
    const cli = new ConcurrencyTrackingCli();
    const deps: RoadmapImportDeps = { cli, fs };
    const children: RoadmapChild[] = Array.from({ length: 10 }, (_, i) => ({
      issueNumber: i + 1,
      title: `子${String(i + 1)}`,
      checked: false,
    }));

    const bodies = await fetchChildBodies(deps, target, children);

    expect(bodies.size).toBe(10);
    expect(cli.calls).toBe(10);
    // 直列なら常に1。並列であることを実測で確かめる
    expect(cli.maxActive).toBeGreaterThan(1);
    expect(cli.maxActive).toBeLessThanOrEqual(FETCH_CONCURRENCY);
  });

  it('子が0件でも空のまま返す', async () => {
    const cli = new ConcurrencyTrackingCli();
    const deps: RoadmapImportDeps = { cli, fs };
    const bodies = await fetchChildBodies(deps, target, []);
    expect(bodies.size).toBe(0);
    expect(cli.calls).toBe(0);
  });
});
