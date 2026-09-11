import { effortsFor, type ModelInfo } from '../codex/modelCatalog';

/**
 * 引き継ぎ先セッションの抽象レベルと、そこからのmodel / effortの解決（Issue #1082）。
 *
 * レベルそのものはCLIのヘッドレス実行で判定する（`handoffLevelJudge.ts`）。このファイルは
 * 判定の結果（L0〜L5）を、実際に選べるモデルとeffortへ落とす部分だけを持つ。model × effort
 * の組み合わせを直接判定させず抽象レベルを1枚挟むのは、モデルが増減してもここだけ直せば
 * 済むようにするため。
 */

/** 抽象レベル。0が最も軽く、5が最も重い。 */
export type HandoffLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const HANDOFF_LEVELS: readonly HandoffLevel[] = [0, 1, 2, 3, 4, 5];

export function isHandoffLevel(value: unknown): value is HandoffLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

/**
 * モデルのティア（低い順）。カタログ（`ModelInfo`）はティア情報を持たないため、slugの部分
 * 一致で順位付けする。
 *
 * Claude Codeは Sonnet < Opus < Fable、Codexは Terra < Sol < Astra。**haikuとlunaは載せない**
 * ——引き継ぎ先は「続きの作業をする側」であり、最下位のモデルまで落とす選択肢を持たせない。
 *
 * 求めたティアのモデルがカタログに無ければモデルを変えない（引き継ぎ元をそのまま使う）。
 * 知らないモデルを順位の分からないまま並べて選ぶより、変えない方が壊れ方が小さい。
 */
export const MODEL_TIERS: readonly (readonly string[])[] = [
  ['sonnet', 'terra'],
  ['opus', 'sol'],
  ['fable', 'astra'],
];

/**
 * 使うeffortを低い順に並べたもの。
 *
 * `max` は載せない。diminishing returnsの可能性があり、引き継ぎ先の既定として選ぶ理由が
 * 無い（人が `agent.autoHandoff.effort` で明示すれば使える）。カタログが返す一覧との積を
 * 取って使うため、ここに書いた値がそのモデルで選べなければ落ちる。
 */
export const EFFORT_LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * レベルからティアの段とeffortの段へ。
 *
 * ティアは3段・effortは4段なので、両方を単調に上げながら6段へ割り当てる。ティアを上げる方が
 * 効きが大きいため、ティアの切り替わり（L1→L2、L3→L4）でeffortを据え置きにしている。
 */
const LEVEL_TABLE: Record<HandoffLevel, { tier: number; effort: number }> = {
  0: { tier: 0, effort: 0 },
  1: { tier: 0, effort: 1 },
  2: { tier: 1, effort: 1 },
  3: { tier: 1, effort: 2 },
  4: { tier: 2, effort: 2 },
  5: { tier: 2, effort: 3 },
};

/** レベルごとの説明。判定を頼むプロンプトへそのまま出す。 */
export const LEVEL_DESCRIPTIONS: Record<HandoffLevel, string> = {
  0: '定型作業。誤字修正、設定値の変更、既に決まった手順の反復。判断がほとんど要らない',
  1: '単純な実装。仕様が決まっていて、読む場所も直す場所も分かっている',
  2: '通常の実装。複数ファイルにまたがるが、設計は決まっている',
  3: '調査を伴う実装。原因の特定、影響範囲の見極め、既存設計の読み解きが要る',
  4: '設計判断を伴う。アーキテクチャの変更、並行処理、セキュリティ、移行など、間違えたときの代償が大きい',
  5: '難航している。直前の試みが失敗している、または未知の領域で試行錯誤が続いている',
};

/** 引き継ぎ先のmodel / effort。 */
export interface HandoffLevelSettings {
  model: string;
  effort: string;
}

/** ティアに合うモデルを一覧から選ぶ。見つからなければ `undefined`（＝据え置き）。 */
function pickModel(models: readonly ModelInfo[], tier: number): string | undefined {
  for (const keyword of MODEL_TIERS[tier] ?? []) {
    const hit = models.find((m) => m.slug.toLowerCase().includes(keyword));
    if (hit !== undefined) {
      return hit.slug;
    }
  }
  return undefined;
}

/**
 * レベルをmodel / effortへ解決する。
 *
 * **静的な対応表（`L4 = gpt-5.6-sol / xhigh` のような）は持たない。** このリポジトリはモデル
 * 一覧もeffort一覧もCLIから動的に取っており（`modelCatalog.ts` の `effortsFor`）、静的表を
 * 持つとその仕組みを迂回して、存在しないモデル名や非対応のeffortをCLIへ渡すことになる。
 * ここで持つのは順位（どちらが重いか）だけで、実在するかどうかはカタログに訊く。
 *
 * @param current 引き継ぎ元のmodel / effort。ティアに合うモデルが無いときの据え置き先
 * @param fallbackEfforts カタログからeffort一覧を取れないときの退避先（Claude Codeは `CLAUDE_EFFORTS`）
 */
export function resolveLevelSettings(
  level: HandoffLevel,
  models: readonly ModelInfo[],
  current: HandoffLevelSettings,
  fallbackEfforts?: readonly string[],
): HandoffLevelSettings {
  const target = LEVEL_TABLE[level];
  const model = pickModel(models, target.tier) ?? current.model;

  const available =
    fallbackEfforts === undefined
      ? effortsFor([...models], model)
      : effortsFor([...models], model, fallbackEfforts);
  if (available.length === 0) {
    // effortの概念を持たないモデル。選択肢を出さない（`effortsFor`のコメント参照）
    return { model, effort: '' };
  }
  // 使う順（`EFFORT_LADDER`）と、そのモデルで実際に選べる値の積を取る。カタログに
  // `max` しか無いような並びでも、ここに載せていない値は選ばれない
  const ladder = EFFORT_LADDER.filter((e) => available.includes(e));
  if (ladder.length === 0) {
    return { model, effort: '' };
  }
  const index = Math.min(target.effort, ladder.length - 1);
  return { model, effort: ladder[index] ?? '' };
}
