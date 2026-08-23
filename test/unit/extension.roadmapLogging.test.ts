import { describe, expect, it } from 'vitest';
import {
  formatCorrectedIssuesDetail,
  formatDroppedDependenciesDetail,
  formatRoadmapWarningsDetail,
} from '../../src/extension';
import type {
  CorrectedIssue,
  DroppedRoadmapDependency,
  RoadmapIssueEntry,
} from '../../src/orchestrator/roadmap';

/**
 * Issue #427 の受入基準:
 * 1. `extension.ts`はロードマップ検証の`warnings`を読み、`errors`と同じ導線（ログ表示）へ
 *    乗せる（実行は止めない）。
 * 2. `correctedIssues` / `droppedDependencies`のidをOutput panel（`log.warn`）へ出す前に
 *    `sanitizeForLog`で無害化する。件数が多い場合でも要素ごとに無害化するため、200文字上限で
 *    後続の要素が丸ごと失われない。
 */

describe('formatRoadmapWarningsDetail（ロードマップ検証の警告をログ用にまとめる）', () => {
  it('warningsのmessageをつなげる', () => {
    const warnings: RoadmapIssueEntry[] = [
      { itemIds: ['a1'], message: '読み飛ばした行があります' },
      { itemIds: ['a2'], message: 'Issue番号を読み取れませんでした' },
    ];
    expect(formatRoadmapWarningsDetail(warnings, '\n')).toBe(
      '読み飛ばした行があります\nIssue番号を読み取れませんでした',
    );
  });
});

describe('formatCorrectedIssuesDetail（correctedIssuesのidを無害化してログ用にまとめる）', () => {
  it('制御文字を含むitemIdを無害化する', () => {
    const issues: CorrectedIssue[] = [{ itemId: 'taskevil', actual: 10, expected: 20 }];
    const detail = formatCorrectedIssuesDetail(issues);
    expect(detail).not.toContain('');
    expect(detail).toContain('10');
    expect(detail).toContain('20');
  });

  it('件数が多くても要素ごとに無害化するため後続要素が消えない（200文字上限の影響を受けない）', () => {
    const longId = 'x'.repeat(150);
    const issues: CorrectedIssue[] = [
      { itemId: longId, actual: 1, expected: 2 },
      { itemId: 'later-item', actual: 3, expected: 4 },
    ];
    const detail = formatCorrectedIssuesDetail(issues);
    expect(detail).toContain('later-item');
  });
});

describe('formatDroppedDependenciesDetail（droppedDependenciesのidを無害化してログ用にまとめる）', () => {
  it('制御文字を含むidを無害化する', () => {
    const deps: DroppedRoadmapDependency[] = [{ itemId: 'a', dependsOnId: 'b' }];
    const detail = formatDroppedDependenciesDetail(deps);
    expect(detail).not.toContain('');
  });

  it('件数が多くても要素ごとに無害化するため後続要素が消えない', () => {
    const longId = 'y'.repeat(150);
    const deps: DroppedRoadmapDependency[] = [
      { itemId: longId, dependsOnId: 'dep1' },
      { itemId: 'later-item', dependsOnId: 'later-dep' },
    ];
    const detail = formatDroppedDependenciesDetail(deps);
    expect(detail).toContain('later-item');
    expect(detail).toContain('later-dep');
  });
});
