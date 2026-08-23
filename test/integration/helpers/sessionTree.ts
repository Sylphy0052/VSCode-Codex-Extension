import type {
  SessionGroupNodeLike,
  SessionSummaryLike,
  SessionTreeElementLike,
  SessionTreeLike,
} from './extension';

/**
 * `getChildren()`の戻りがグループノードになりうる（issue #293、既定`codex.history.groupBy:
 * date`）ため、既存の統合テスト（`sessionHistory.test.ts` / `extension.test.ts`）が
 * 前提にしていた「フラットなセッション一覧」を組み立て直すヘルパー。
 *
 * `getChildren(element)`をグループへ再帰的に辿り、セッションだけを表示順のまま集める。
 * 現在の実装ではグループが入れ子になることは無いが、`SessionTreeLike`の公開契約
 * （VS Codeの`TreeDataProvider`と同じ「子はgetChildren(element)で取る」契約）どおりに
 * 辿ることで、将来グループが増段されても壊れないようにしてある。
 */
export async function flattenSessions(
  tree: SessionTreeLike,
  element?: SessionTreeElementLike,
): Promise<SessionSummaryLike[]> {
  const children = await tree.getChildren(element);
  const result: SessionSummaryLike[] = [];
  for (const child of children) {
    if (isGroupNode(child)) {
      result.push(...(await flattenSessions(tree, child)));
    } else {
      result.push(child);
    }
  }
  return result;
}

export function isGroupNode(element: SessionTreeElementLike): element is SessionGroupNodeLike {
  return (
    typeof element === 'object' && element !== null && 'kind' in element && element.kind === 'group'
  );
}
