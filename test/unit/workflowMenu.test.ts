import { describe, expect, it } from 'vitest';
import { buildWorkflowMenuEntries } from '../../src/view/workflowMenu';

/** 項目のコマンドIDだけを並び順どおりに取り出す。 */
function commands(runningCount: number): string[] {
  return buildWorkflowMenuEntries(runningCount).map((e) => e.command);
}

describe('buildWorkflowMenuEntries（ワークフローの導線、issue #250）', () => {
  describe('実行中のrunが無いとき', () => {
    it('実行・View・生成・チーム・ロードマップ・ファイル変換の6項目をこの順で返す', () => {
      expect(commands(0)).toEqual([
        'agent.workflows.run',
        'agent.workflows.view',
        'agent.workflows.plan',
        'agent.workflows.team',
        'agent.workflows.roadmap',
        'agent.workflows.convertRoadmap',
      ]);
    });

    it('停止は候補に出さない（選んでも止めるものが無いため）', () => {
      expect(commands(0)).not.toContain('agent.workflows.stop');
    });

    it('負の件数を渡されても実行中なしと同じ扱いにする', () => {
      expect(commands(-1)).toEqual(commands(0));
    });
  });

  describe('実行中のrunがあるとき', () => {
    it('Viewを開くが先頭に来て、停止が候補に加わる', () => {
      expect(commands(1)).toEqual([
        'agent.workflows.view',
        'agent.workflows.run',
        'agent.workflows.plan',
        'agent.workflows.team',
        'agent.workflows.roadmap',
        'agent.workflows.convertRoadmap',
        'agent.workflows.stop',
      ]);
    });

    it('先頭のViewの説明に実行中の件数が入る', () => {
      const entries = buildWorkflowMenuEntries(3);

      expect(entries[0]?.description).toContain('実行中 3件');
    });

    it('件数を添えてもViewの元の説明が残る', () => {
      const withRunning = buildWorkflowMenuEntries(2)[0];
      const withoutRunning = buildWorkflowMenuEntries(0).find(
        (e) => e.command === 'agent.workflows.view',
      );

      expect(withoutRunning).toBeDefined();
      expect(withRunning?.description).toContain(withoutRunning!.description);
      expect(withRunning?.label).toBe(withoutRunning!.label);
    });
  });

  it('どの項目もラベルと説明が空でなく、agent.workflows配下のコマンドを指す', () => {
    for (const runningCount of [0, 1]) {
      for (const entry of buildWorkflowMenuEntries(runningCount)) {
        expect(entry.label).not.toBe('');
        expect(entry.description).not.toBe('');
        expect(entry.command).toMatch(/^agent\.workflows\./u);
      }
    }
  });
});
