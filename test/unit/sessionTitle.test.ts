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
      it('識別子も役割も無ければラベルのみ', () => {
        const input: SessionPanelTitleInput = {};
        expect(buildSessionPanelTitle(input, label)).toBe(label);
      });

      it('role === orchestrator ではオーケストレーター用のタブ名', () => {
        const input: SessionPanelTitleInput = { role: 'orchestrator' };
        expect(buildSessionPanelTitle(input, label)).toBe('進行役');
      });

      it('mergeResolutionTaskIdがあれば衝突解決用のタブ名（roleより優先）', () => {
        const input: SessionPanelTitleInput = {
          role: 'orchestrator',
          mergeResolutionTaskId: 'task-42',
        };
        expect(buildSessionPanelTitle(input, label)).toBe('衝突解決 task-42');
      });

      it('role === task では識別子も役割も無ければラベルのみ', () => {
        const input: SessionPanelTitleInput = { role: 'task' };
        expect(buildSessionPanelTitle(input, label)).toBe(label);
      });

      it('taskIdがあれば通常のタスクのタブ名に含める（Issue #599）', () => {
        const input: SessionPanelTitleInput = { role: 'task', taskId: 'task-3' };
        expect(buildSessionPanelTitle(input, label)).toBe('task-3');
      });

      // 衝突解決セッションは対象idを既に含むため、taskIdより情報量が多い
      it('mergeResolutionTaskIdはtaskIdより優先する', () => {
        const input: SessionPanelTitleInput = {
          taskId: 'task-3',
          mergeResolutionTaskId: 'task-42',
        };
        expect(buildSessionPanelTitle(input, label)).toBe('衝突解決 task-42');
      });

      // オーケストレーターセッションは依存グラフのノードではないため、taskIdを持つ
      // 意味が無い。万一渡ってきても役割のほうを見せる
      it('role === orchestrator はtaskIdより優先する', () => {
        const input: SessionPanelTitleInput = { role: 'orchestrator', taskId: 'task-3' };
        expect(buildSessionPanelTitle(input, label)).toBe('進行役');
      });

      it('taskIdが空文字ならラベルのみ（値が無いのと同じ扱い）', () => {
        const input: SessionPanelTitleInput = { role: 'task', taskId: '' };
        expect(buildSessionPanelTitle(input, label)).toBe(label);
      });

      // ここからIssue #1201（Issue番号と役割でタブ名を組む）
      it('Issue番号と役割があれば両方を並べる', () => {
        const input: SessionPanelTitleInput = {
          role: 'task',
          taskId: 'T1',
          issue: 1200,
          teamRole: 'implementer',
        };
        expect(buildSessionPanelTitle(input, label)).toBe('#1200 実装');
      });

      it('Issue番号はtaskIdより優先する', () => {
        const input: SessionPanelTitleInput = { role: 'task', taskId: 'T1', issue: 1200 };
        expect(buildSessionPanelTitle(input, label)).toBe('#1200');
      });

      it('Issue番号が無ければtaskIdと役割を並べる', () => {
        const input: SessionPanelTitleInput = {
          role: 'task',
          taskId: 'T3',
          teamRole: 'tester',
        };
        expect(buildSessionPanelTitle(input, label)).toBe('T3 テスター');
      });

      it('役割だけならその表示名のみ', () => {
        const input: SessionPanelTitleInput = { role: 'task', teamRole: 'reviewer' };
        expect(buildSessionPanelTitle(input, label)).toBe('レビュワー');
      });

      // 衝突解決・オーケストレーターは識別子より先に効く（既存の優先順位を変えない）
      it('mergeResolutionTaskIdはIssue番号より優先する', () => {
        const input: SessionPanelTitleInput = {
          issue: 1200,
          teamRole: 'implementer',
          mergeResolutionTaskId: 'T1',
        };
        expect(buildSessionPanelTitle(input, label)).toBe('衝突解決 T1');
      });

      it('role === orchestrator はIssue番号より優先する', () => {
        const input: SessionPanelTitleInput = {
          role: 'orchestrator',
          issue: 1200,
          teamRole: 'orchestrator',
        };
        expect(buildSessionPanelTitle(input, label)).toBe('進行役');
      });
    });
  }
});
