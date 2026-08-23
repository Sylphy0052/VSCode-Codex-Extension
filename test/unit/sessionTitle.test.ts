import { describe, expect, it } from 'vitest';
import { buildSessionPanelTitle, type SessionPanelTitleInput } from '../../src/view/sessionTitle';

/**
 * `openTaskSession`（`chatView.ts` / `claudeChatView.ts`）のタブ名の組み立てを検証する
 * （Issue #533）。PR #532で「タブ名に対象タスクのidを含める」を入れたが、`runner.test.ts`
 * の fake host は `title` という概念を持たない（`TaskSessionInput` に `title` フィールドが
 * 無く、タイトル計算はManager側にある）ため、fake host経由では原理的に検証できない。
 * `buildSessionPanelTitle` を純粋関数として直接呼ぶ。
 */
describe('buildSessionPanelTitle（Issue #533の3分岐）', () => {
  const cases: Array<{ label: string }> = [{ label: 'Codex' }, { label: 'Claude Code' }];

  for (const { label } of cases) {
    describe(`label = ${label}`, () => {
      it('通常のタスクではラベルのみ', () => {
        const input: SessionPanelTitleInput = {};
        expect(buildSessionPanelTitle(input, label)).toBe(label);
      });

      it('role === orchestrator ではオーケストレーター用のタブ名', () => {
        const input: SessionPanelTitleInput = { role: 'orchestrator' };
        expect(buildSessionPanelTitle(input, label)).toBe(`${label}: オーケストレーター`);
      });

      it('mergeResolutionTaskIdがあれば衝突解決用のタブ名（roleより優先）', () => {
        const input: SessionPanelTitleInput = {
          role: 'orchestrator',
          mergeResolutionTaskId: 'task-42',
        };
        expect(buildSessionPanelTitle(input, label)).toBe(`${label}: 衝突解決 task-42`);
      });

      it('role === task では通常のタスクと同じくラベルのみ', () => {
        const input: SessionPanelTitleInput = { role: 'task' };
        expect(buildSessionPanelTitle(input, label)).toBe(label);
      });
    });
  }
});
