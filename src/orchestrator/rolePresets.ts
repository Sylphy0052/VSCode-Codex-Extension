import type { Provider } from './workflow';

/**
 * チームモードの役割プリセット（design.md §16.44、Issue #693）。
 *
 * ワークフローのタスクへ「会社の役割」を割り当て、役割から `model` / `effort` の**既定値
 * だけ**を引く。タスクが `model` / `effort` を明示していればそちらが勝つ（`resolveTask`
 * 参照）。VSCode APIには依存しない純粋なロジックのみを置く。
 *
 * **役割は権限に関わらない。** `approvalMode` / `sandbox` / `autoApprove` はここでは一切
 * 決めず、従来どおり `buildEffectiveTaskConfig`（`taskConfig.ts`）のクランプだけが決める
 * （design.md §16.16「実効設定を組み立てる唯一の入口」の不変条件を崩さないため。役割から
 * 権限を引けるようにすると、エージェントが生成しうるYAMLが役割名の指定だけで実効権限を
 * 動かせる経路になる）。
 */

/**
 * 役割の語彙。会社の職能を参考にした固定の一覧。
 *
 * 未知の値は `validateWorkflow` が警告して「役割なし」へ倒す（`resolveRole` 参照）。
 * 自由文字列を許さないのは、役割がプリセットの参照キーであり、綴り違いを黙って
 * 受け入れると意図しないモデル・effortで走ってしまうため。
 */
export const TEAM_ROLES = [
  'orchestrator',
  'manager',
  'em',
  'architect',
  'designer',
  'implementer',
  'reviewer',
  'tester',
  'writer',
  'researcher',
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * 役割に割り当てる思考の重さ。実際のモデル名・effortはプロバイダごとに違うため、
 * 役割はまずこの段階の抽象へ寄せ、プロバイダごとの対応表（`TIER_MODELS`）で解決する。
 *
 * `escalation`（Codex: Sol / Claude: Fable）は**どの役割の既定値にもしない**。
 * 「詰まったときだけ使う」という運用方針（Issue #693）を、既定値から到達できないという
 * 構造で担保する。使うときはタスクの `model` / `effort` で明示的に指定する。
 */
export type RoleTier = 'light' | 'standard' | 'deep' | 'escalation';

/** 役割 → 重さ。 */
const ROLE_TIERS: Record<TeamRole, RoleTier> = {
  // 全体の段取りと統合。判断の質がそのまま run 全体の質になるため深く考えさせる
  orchestrator: 'deep',
  manager: 'deep',
  em: 'deep',
  architect: 'deep',
  designer: 'deep',
  // 決まった仕様を形にする作業。速度と量を優先する
  implementer: 'light',
  // 機械的な観点（規約・明らかな誤り）の確認。深い設計判断はarchitect/emへ回す前提
  reviewer: 'light',
  tester: 'light',
  // 文章を書く・調べる。実装よりは考えるが、設計判断ほどではない
  writer: 'standard',
  researcher: 'standard',
};

/** 重さ → プロバイダごとのモデルslug。 */
const TIER_MODELS: Record<RoleTier, Record<Provider, string>> = {
  light: { codex: 'gpt-5.6-luna', claude: 'sonnet' },
  standard: { codex: 'gpt-5.6-luna', claude: 'sonnet' },
  deep: { codex: 'gpt-5.6-terra', claude: 'opus' },
  escalation: { codex: 'gpt-5.6-sol', claude: 'fable' },
};

/**
 * 重さ → effort。プロバイダによらず共通の語彙（`low` / `medium` / `high`）だけを使う。
 *
 * `xhigh` / `max` / `ultra`（`FALLBACK_EFFORTS`、`modelCatalog.ts`）は既定値には使わない。
 * モデルによって対応の有無が違い、既定値が対応外だと `effortsFor` の選択肢に無い値を
 * CLIへ渡すことになるため。明示指定する経路（タスクの `effort`）は従来どおり自由。
 */
const TIER_EFFORTS: Record<RoleTier, string> = {
  light: 'low',
  standard: 'medium',
  deep: 'high',
  escalation: 'high',
};

/** 表示用の日本語ラベル（ワークフローView・QuickPick）。 */
const ROLE_LABELS: Record<TeamRole, string> = {
  orchestrator: '進行役',
  manager: 'マネージャー',
  em: 'EM',
  architect: 'アーキテクト',
  designer: '設計者',
  implementer: '実装',
  reviewer: 'レビュワー',
  tester: 'テスター',
  writer: 'ライター',
  researcher: 'リサーチャー',
};

const TEAM_ROLE_SET: ReadonlySet<string> = new Set(TEAM_ROLES);

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && TEAM_ROLE_SET.has(value);
}

/** 役割の表示名。未知の値は受け取らない（`isTeamRole` を通してから呼ぶ）。 */
export function roleLabel(role: TeamRole): string {
  return ROLE_LABELS[role];
}

/** 役割の思考の重さ。 */
export function roleTier(role: TeamRole): RoleTier {
  return ROLE_TIERS[role];
}

/** 役割から引く `model` / `effort` の既定値。 */
export interface RoleDefaults {
  model: string;
  effort: string;
}

/**
 * 役割とプロバイダから `model` / `effort` の既定値を引く。
 *
 * ここが返すのは**あくまで既定値**で、タスクが明示した値を上書きしない。実際の適用は
 * `resolveTask`（`workflow.ts`）が `optStr(t['model']) ?? roleDefault ?? defaults.model`
 * の優先順で行う。
 */
export function roleDefaults(role: TeamRole, provider: Provider): RoleDefaults {
  const tier = ROLE_TIERS[role];
  return { model: TIER_MODELS[tier][provider], effort: TIER_EFFORTS[tier] };
}

/**
 * `escalation` 段のモデル（Codex: Sol / Claude: Fable）。
 *
 * 既定値としては使わないが、「詰まったときに何へ上げればよいか」を人とオーケストレーターへ
 * 示すために公開する（ワークフローViewの注記・`planner.ts` のプロンプト）。
 */
export function escalationModel(provider: Provider): string {
  return TIER_MODELS.escalation[provider];
}
