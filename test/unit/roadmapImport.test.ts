import { describe, expect, it } from 'vitest';
import type { CliCommandResult, CliCommandRunner, ForgeFileSystemPort } from '../../src/orchestrator/forge';
import {
  findRoadmapPlanSection,
  formatRoadmapPlanSection,
  rewriteRoadmapPlanMeta,
  writeRoadmapPlan,
  type RoadmapImportDeps,
  type RoadmapImportTarget,
} from '../../src/orchestrator/roadmapImport';
import {
  ROADMAP_PLAN_VERSION,
  computeRoadmapPlanHash,
  hashRoadmapPlanSectionContent,
  type RoadmapPlanMeta,
} from '../../src/orchestrator/roadmapPlanHash';
import type { RoadmapPlanNode } from '../../src/orchestrator/roadmapRunState';

/**
 * レビュー指摘（Issue #1581 item3）: 確認したときの区画のハッシュ（`sectionHash` /
 * `replaceSectionHash`）と、書く直前に読み直した本文の区画のハッシュを比べてから書く実装
 * （`writeRoadmapPlan` / `rewriteRoadmapPlanMeta`）が、確認後に別プロセス・別ウィンドウが
 * 区画を書き換えていた場合に、上書きせず書き込みCLI（`gh issue edit`）を呼ばないことを
 * 固定する回帰テスト。
 */

/** `gh issue view` は呼ぶたびに`bodies`から順に返す。他のコマンドは成功を返す。 */
class FakeCli implements CliCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  private viewCount = 0;

  constructor(private readonly bodies: readonly string[]) {}

  async run(command: string, args: readonly string[], _cwd: string): Promise<CliCommandResult> {
    this.calls.push({ command, args: [...args] });
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      const body = this.bodies[Math.min(this.viewCount, this.bodies.length - 1)] ?? '';
      this.viewCount += 1;
      return { code: 0, stdout: JSON.stringify({ body }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  /** 本文の書き込み（`gh issue edit`）が呼ばれたかどうか。 */
  hasEditCall(): boolean {
    return this.calls.some((c) => c.command === 'gh' && c.args[0] === 'issue' && c.args[1] === 'edit');
  }
}

const fs: ForgeFileSystemPort = {
  async writeTempFile(): Promise<string> {
    return '/tmp/fake-body';
  },
  async removeTempFile(): Promise<void> {},
};

const target: RoadmapImportTarget = { host: 'github', cwd: '/tmp', roadmapIssueNumber: 1 };

const nodesOriginal: RoadmapPlanNode[] = [{ issueNumber: 101, dependsOn: [], wave: undefined }];
const nodesEdited: RoadmapPlanNode[] = [{ issueNumber: 102, dependsOn: [], wave: undefined }];

function bodyWithSection(nodes: readonly RoadmapPlanNode[]): string {
  // `writeRoadmapPlan`のvalidateRoadmapPlanが子Issueのチェックリストと計画のノードを
  // 突き合わせるため、対応する子Issueの行も入れておく
  const checklist = nodes.map((node) => `- [ ] #${String(node.issueNumber)}: 子${String(node.issueNumber)}`);
  return ['# ロードマップ', '', ...checklist, '', ...formatRoadmapPlanSection(nodes), ''].join('\n');
}

describe('writeRoadmapPlan', () => {
  it('承認時のハッシュと、書く直前に読み直した区画のハッシュが食い違えば、書かずにsectionExistsを返す', async () => {
    const originalBody = bodyWithSection(nodesOriginal);
    const section = findRoadmapPlanSection(originalBody);
    expect(section.kind).toBe('present');
    const approvedHash = section.kind === 'present' ? hashRoadmapPlanSectionContent(section.content) : '';

    // 承認後、別プロセス/ウィンドウが区画を書き換えた後の本文（書く直前の読み直しで返る）
    const editedBody = bodyWithSection(nodesEdited);
    const cli = new FakeCli([editedBody]);
    const deps: RoadmapImportDeps = { cli, fs };

    const outcome = await writeRoadmapPlan(deps, target, nodesOriginal, {
      replaceSectionHash: approvedHash,
    });

    expect(outcome.kind).toBe('sectionExists');
    expect(cli.hasEditCall()).toBe(false);
  });

  it('区画のハッシュが変わっていなければ書き込む', async () => {
    const originalBody = bodyWithSection(nodesOriginal);
    const section = findRoadmapPlanSection(originalBody);
    const approvedHash = section.kind === 'present' ? hashRoadmapPlanSectionContent(section.content) : '';

    const cli = new FakeCli([originalBody]);
    const deps: RoadmapImportDeps = { cli, fs };

    const outcome = await writeRoadmapPlan(deps, target, nodesOriginal, {
      replaceSectionHash: approvedHash,
    });

    expect(outcome.kind).toBe('written');
    expect(cli.hasEditCall()).toBe(true);
  });
});

describe('rewriteRoadmapPlanMeta', () => {
  const meta: RoadmapPlanMeta = {
    planVersion: ROADMAP_PLAN_VERSION,
    sourceHash: '0'.repeat(32),
    generatedPlanHash: computeRoadmapPlanHash(['- #101 段1 依存: なし']),
    children: new Map([[101, '0'.repeat(12)]]),
  };

  it('sectionHashが今読み直した区画と食い違えば、書かずにsectionChangedを返す', async () => {
    const originalBody = bodyWithSection(nodesOriginal);
    const section = findRoadmapPlanSection(originalBody);
    const approvedHash = section.kind === 'present' ? hashRoadmapPlanSectionContent(section.content) : '';

    const editedBody = bodyWithSection(nodesEdited);
    const cli = new FakeCli([editedBody]);
    const deps: RoadmapImportDeps = { cli, fs };

    const outcome = await rewriteRoadmapPlanMeta(deps, target, approvedHash, meta);

    expect(outcome.kind).toBe('sectionChanged');
    expect(cli.hasEditCall()).toBe(false);
  });

  it('sectionHashが今の区画と合えば書き込む', async () => {
    const originalBody = bodyWithSection(nodesOriginal);
    const section = findRoadmapPlanSection(originalBody);
    const approvedHash = section.kind === 'present' ? hashRoadmapPlanSectionContent(section.content) : '';

    const cli = new FakeCli([originalBody]);
    const deps: RoadmapImportDeps = { cli, fs };

    const outcome = await rewriteRoadmapPlanMeta(deps, target, approvedHash, meta);

    expect(outcome.kind).toBe('written');
    expect(cli.hasEditCall()).toBe(true);
  });
});
