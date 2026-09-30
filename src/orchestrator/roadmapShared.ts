/**
 * ロードマップ実行（Issue #1465、廃止: #1623）とオーケストレータモードの両方から使う、
 * 小さな共有の型・定数・関数だけを集めたモジュール。
 *
 * 元は`roadmapRunState.ts`にあったが、ロードマップ実行の廃止（Issue #1623）に伴い
 * `roadmapRunState.ts`ごと削除する一方、ここに置いたものはロードマップ計画の取込み
 * （`roadmapImport.ts`）や質問のエスカレーション判定（`roadmapQuestionMcp.ts`、
 * オーケストレータモードでも使う）が引き続き必要とするため、このファイルへ切り出した。
 */

/** Issue番号として有効か（`0`より大きい安全な整数）。 */
export function isValidIssueNumber(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** 着手順（計画）の1ノード。波（`wave`）は表示のためだけに使う。 */
export interface RoadmapPlanNode {
  issueNumber: number;
  dependsOn: readonly number[];
  wave: number | undefined;
}

export interface RoadmapPlan {
  /** 着手順の早い順。 */
  nodes: readonly RoadmapPlanNode[];
  /** ロードマップ本文の計画区画をそのまま使ったか、このrunで生成して書き戻したか。 */
  source: 'existingSection' | 'generated';
  /**
   * 計画の出どころ（Issue #1555）。区画のハッシュが生成時のままなら`generated`、人が区画を
   * 手で直していれば`manually_modified`。メタデータの無い区画では判定できず`undefined`。
   * 後から足したため、永続化済みの古い状態では無い。
   */
  planOrigin?: RoadmapPlanOrigin | undefined;
}

export type RoadmapPlanOrigin = 'generated' | 'manually_modified';

/**
 * Issueセッションが`ask_orchestrator`で尋ねた質問を、Reflexに選択肢を選ばせない理由。
 * 1つでも付いた質問は、選択肢があっても回答者判定にかけ、オーケストレーターかユーザーの判断を待つ。
 * `USER_ONLY_ESCALATIONS`に入るものが付いた質問は回答者判定も通さずユーザーが決める（Issue #1763）。
 */
export const ROADMAP_QUESTION_ESCALATIONS = [
  'scopeChange',
  'requirementChange',
  'publicInterface',
  'destructiveOperation',
  'securityAuth',
  'largeDependency',
  'outsideRepoWrite',
  'secrets',
  'release',
  'specConflict',
] as const;
export type RoadmapQuestionEscalation = (typeof ROADMAP_QUESTION_ESCALATIONS)[number];
