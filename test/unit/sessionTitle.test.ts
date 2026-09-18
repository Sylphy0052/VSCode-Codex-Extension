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

      // 分割（`onContextLow: split`。Issue #1273、design.md §16.47）の世代の印。
      // 書式はチャットの自動引き継ぎ（`buildHandoffSessionName`）と同じ `(続きN)` に揃える
      describe('世代の印（Issue #1273）', () => {
        it('generationが無ければ従来どおり付かない', () => {
          const input: SessionPanelTitleInput = { issue: 1200 };
          expect(buildSessionPanelTitle(input, label)).toBe('#1200');
        });

        it('1代目（通常の起動）にも付かない', () => {
          const input: SessionPanelTitleInput = { issue: 1200, generation: 1 };
          expect(buildSessionPanelTitle(input, label)).toBe('#1200');
        });

        it('2代目以降は末尾に付く', () => {
          const input: SessionPanelTitleInput = { issue: 1200, generation: 3 };
          expect(buildSessionPanelTitle(input, label)).toBe('#1200 (続き3)');
        });

        it('識別子も役割も無いフォールバックにも付く', () => {
          const input: SessionPanelTitleInput = { generation: 2 };
          expect(buildSessionPanelTitle(input, label)).toBe(`${label} (続き2)`);
        });

        it('衝突解決・進行役にも付く（どのタブの続きか見分けられるようにする）', () => {
          expect(
            buildSessionPanelTitle({ mergeResolutionTaskId: 'T1', generation: 2 }, label),
          ).toBe('衝突解決 T1 (続き2)');
          expect(buildSessionPanelTitle({ role: 'orchestrator', generation: 2 }, label)).toBe(
            '進行役 (続き2)',
          );
        });

        it('壊れた値（NaN・小数・0以下）では付けない', () => {
          for (const generation of [Number.NaN, 1.5, 0, -1]) {
            expect(buildSessionPanelTitle({ issue: 1200, generation }, label)).toBe('#1200');
          }
        });
      });
    });
  }
});
