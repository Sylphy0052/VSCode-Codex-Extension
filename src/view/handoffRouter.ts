import { effortsFor, type ModelInfo } from '../codex/modelCatalog';

/**
 * 引き継ぎ先セッションのmodel / effortを、作業の見立て（assessment）から決める（Issue #1082）。
 *
 * 見立てそのものはCLIのヘッドレス実行に出させる（`handoffClassifier.ts`）が、**LLMには
 * model / effortを選ばせない**。LLMが返すのは作業の性質を5つの軸で測った数値だけで、
 * それをどのモデル・どのeffortに割り当てるかはここの決定論的な規則で決める。意味の理解は
 * LLM、方針の適用はコード、という分担にしておくと、割り当てを変えたいときにプロンプトを
 * いじらず済み、LLMが勝手に最上位モデルを指名することも起きない。
 *
 * effortとmodelは別の軸で決める。effortは「どれだけ深く考えるか」（difficulty）、modelは
 * 「どれだけ広く・曖昧で・危険で・自律的か」（scope / ambiguity / risk / autonomy）。この
 * 分離があると「モデルは上げないが深く考えさせる」（Sonnet / xhigh、GPT-6-Sol / xhigh）と
 * 「深く考える必要は無いが広い」（Opus / high、Sol / high）を区別できる。
 */

/** 各軸の値。0が最も軽い。 */
export type AssessmentScore = 0 | 1 | 2;

/**
 * 作業の種類。分類器が勝手に新しい分類を作れないよう、ここに列挙したものだけを受け付ける。
 */
export const TASK_TYPES = [
  'research',
  'knowledge',
  'spec',
  'planning',
  'task_decomposition',
  'implementation',
  'bugfix',
  'debugging',
  'refactoring',
  'testing',
  'review_spec',
  'review_impl',
  'security_review',
  'release',
  'pr',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** LLMが返す見立て。数値はすべて0〜2。 */
export interface TaskAssessment {
  taskType: TaskType;
  /** 0=定型・局所、1=複数ステップ、2=深い推論・原因不明・複雑なアルゴリズム。 */
  difficulty: AssessmentScore;
  /** 0=1コンポーネント、1=数ファイルか1サブシステム、2=リポジトリ横断。 */
  scope: AssessmentScore;
  /** 0=要件が明確、1=設計判断が要る、2=問題の定義自体を整理する必要がある。 */
  ambiguity: AssessmentScore;
  /** 0=低リスク、1=互換性・データ・運用への影響、2=security / auth / production / migration。 */
  risk: AssessmentScore;
  /** 0=指示どおり実行、1=実装の詳細を選ぶ、2=分析・設計・実行まで自律。 */
  autonomy: AssessmentScore;
  /** 分類器の自信。0〜1。判定には使わず、理由として残すだけ。 */
  confidence: number;
  reasons: string[];
  /**
   * 今この場で新しいセッションへ切り替えても失うものが無いか（Issue #1090）。
   *
   * 「作業が完結したか」ではなく「新しいセッションがtranscriptとポインタファイルから続きを
   * 始められるか」。途中の議論・未回答の質問・出しかけの成果物があれば `false`。読めなかった
   * ときは `false`（＝切り替えない）へ倒す。
   */
  switchSafe: boolean;
  /** `switchSafe` の根拠を1文で。ポインタファイルとログへ出す。 */
  switchReason: string;
  /**
   * 直前のアシスタント応答が、セッションの切り替え・引き継ぎを自分から提案しているか
   * （Issue #1097）。
   *
   * `CLAUDE.md` / `AGENTS.md` の「セッション切替」規約に従い、アシスタントが「実装は別
   * セッション推奨」「次は新チャットへ引き継ぐ」と述べることがある。この提案は残量にも
   * model/effortの変化にも表れないため、独立した契機として扱う。
   *
   * 判定を正規表現ではなくLLMに任せるのは、言い回しが「/clear して続きを」「handoffして」
   * のようにぶれ、パターンでは漏れと誤検知の両方が出るため。読めなかったときは `false`
   * （＝提案は無かった）へ倒す。
   */
  handoffSuggested: boolean;
  /** `handoffSuggested` の根拠を1文で。提案が無ければ空。 */
  handoffSuggestReason: string;
  /**
   * 直前のアシスタント応答が、ユーザーへ質問して回答を待った状態で終わっているか
   * （Issue #1191）。
   *
   * `switchSafe` と別に持つのは、`assistantSuggested` の契機が `switchSafe` を参照しない
   * ため（Issue #1097）。「この方針でよいか。よければ新セッションで実装する」のように提案と
   * 質問が同じ応答に並ぶと、`switchSafe` が false でも提案だけで発火してしまう。
   *
   * 決定論の検知（`endsWithUserQuestion`）が末尾行しか見ないのに対し、こちらは質問の後に
   * 補足が続く応答も拾える。読めなかったときは `false`（＝回答待ちではない）へ倒す。素通り
   * させる側だが、欠損で毎回止まると引き継ぎが動かなくなるため、既存の欠損時の扱いに合わせる。
   */
  awaitingUserAnswer: boolean;
  /** `awaitingUserAnswer` の根拠を1文で。回答待ちでなければ空。 */
  awaitingUserAnswerReason: string;
}

/** 引き継ぎ先の解決結果が今の設定と実質的に違うか（Issue #1090の `profileChanged`）。 */
export function isProfileChange(current: HandoffProfile, next: HandoffProfile): boolean {
  if (current.model !== next.model) {
    return true;
  }
  // effortは2段以上動いたときだけ「変わった」とする。1段差（high→xhigh）で引き継ぐと
  // 区切りのたびにタブが増える割に、得られる差が小さい。
  const from = EFFORT_LADDER.indexOf(current.effort);
  const to = EFFORT_LADDER.indexOf(next.effort);
  if (from === -1 || to === -1) {
    // どちらかが未指定・ladder外なら比較材料が無い。モデルが同じなら変わっていない扱い
    return false;
  }
  return Math.abs(to - from) >= 2;
}

export function isAssessmentScore(value: unknown): value is AssessmentScore {
  return value === 0 || value === 1 || value === 2;
}

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

/**
 * モデルのティア（低い順）。カタログ（`ModelInfo`）はティア情報を持たないため、slugの部分
 * 一致で順位付けする。
 *
 * Claude Codeは Sonnet < Opus < Fable、Codexは GPT-6-Luna < GPT-6-Sol < GPT-6-Astra。
 * haikuは載せない——引き継ぎ先は「続きの作業をする側」であり、Claudeの最下位モデルまで落とさない。
 *
 * 求めたティアのモデルがカタログに無ければモデルを変えない（引き継ぎ元をそのまま使う）。
 * 知らないモデルを順位の分からないまま並べて選ぶより、変えない方が壊れ方が小さい。
 */
export const MODEL_TIERS: readonly (readonly string[])[] = [
  ['sonnet', 'gpt-6-luna'],
  ['opus', 'gpt-6-sol'],
  ['fable', 'gpt-6-astra'],
];

/**
 * 使うeffortを低い順に並べたもの。difficultyの0 / 1 / 2にそのまま対応する。
 *
 * `low` と `max` は載せない。`low` は引き継ぎ先（続きの作業をする側）の既定として選ぶ理由が
 * 無く、`max` はdiminishing returnsの可能性がある。どちらも人が `agent.autoHandoff.effort`
 * で明示すれば使える。カタログが返す一覧との積を取って使うため、ここに書いた値がその
 * モデルで選べなければ落ちる。
 */
export const EFFORT_LADDER: readonly string[] = ['medium', 'high', 'xhigh'];

/**
 * 引き継ぎ先へどれだけコストを掛けてよいかの方針（Issue #1214）。低い順。
 *
 * 見立て（assessment）からティアとeffortを決める規則そのものは変えず、**決まった結果へ
 * 上限を被せる**。分類器のプロンプトにも触れない。判定の意味（この作業はどれだけ重いか）と
 * 予算の都合（いまどれだけ払えるか）は別の話で、後者のために前者を歪めると、方針を戻した
 * ときに元の判定へ戻らなくなる。
 */
export const COST_PRESETS = ['low', 'balanced', 'full'] as const;
export type CostPreset = (typeof COST_PRESETS)[number];

export function isCostPreset(value: unknown): value is CostPreset {
  return typeof value === 'string' && (COST_PRESETS as readonly string[]).includes(value);
}

/** プリセットごとのモデルのティア上限。`full` は `MODEL_TIERS` の最上位まで。 */
const TIER_CAP: Record<CostPreset, number> = { low: 1, balanced: 2, full: 2 };

/**
 * プリセットごとのeffortの段の上限（`EFFORT_LADDER`の添字）。
 *
 * `low` だけ `high` で止める。`balanced` でxhighを残すのは、effortを削るとモデルを落とす
 * よりも失敗（同じところで詰まって再試行）が増えやすく、結果としてかえって高くつくため。
 */
const EFFORT_CAP: Record<CostPreset, number> = { low: 1, balanced: 2, full: 2 };

/**
 * 最上位のティア（fable / astra）へ上げるための合計スコアの下限。
 *
 * `full` は従来どおり6。`balanced` は8——scope / ambiguity / risk / autonomy がすべて2、
 * つまり「リポジトリ横断で、問題の定義から曖昧で、高リスクで、自律的に進める」ときだけ
 * 最上位を使う。`low` はティア上限が1のため、この値は使わない。
 */
const TIER2_FLOOR: Record<CostPreset, number> = { low: 6, balanced: 8, full: 6 };

/** 引き継ぎ先のmodel / effort。 */
export interface HandoffProfile {
  model: string;
  effort: string;
}

/** 見立てからの解決結果。`reasons` には補正の内訳を残す。 */
export interface ResolvedProfile extends HandoffProfile {
  tier: number;
  effortIndex: number;
  reasons: string[];
}

function clamp(value: number): AssessmentScore {
  return Math.max(0, Math.min(2, Math.round(value))) as AssessmentScore;
}

/**
 * 見立てに補正を掛ける。
 *
 * LLMの見立てを鵜呑みにせず、作業の種類から決まる最低線をここで保証する。security review
 * が「低リスク」と出ても危険側へ倒す、debugging が「定型」と出ても深く考えさせる、など。
 * 直前のターンが失敗しているときはdifficultyを1段上げる（同じ重さで再挑戦させても同じ
 * ところで失敗する）。
 */
export function applyCorrections(
  assessment: TaskAssessment,
  context: { turnFailed: boolean },
): { assessment: TaskAssessment; notes: string[] } {
  const notes: string[] = [];
  const { scope, autonomy } = assessment;
  let { difficulty, ambiguity, risk } = assessment;

  switch (assessment.taskType) {
    case 'security_review':
      if (risk < 2) {
        risk = 2;
        notes.push('security_review: risk=2');
      }
      break;
    case 'debugging':
      if (difficulty < 2) {
        difficulty = 2;
        notes.push('debugging: difficulty=2');
      }
      break;
    case 'spec':
    case 'planning':
      // 仕様・計画は「何を作るか」を決める作業で、要件が明確でも設計判断は要る
      if (ambiguity < 1) {
        ambiguity = 1;
        notes.push(`${assessment.taskType}: ambiguity=1`);
      }
      break;
    default:
      break;
  }

  if (context.turnFailed) {
    const raised = clamp(difficulty + 1);
    if (raised !== difficulty) {
      difficulty = raised;
      notes.push(`previous attempt failed: difficulty=${difficulty}`);
    }
  }

  return {
    assessment: { ...assessment, difficulty, scope, ambiguity, risk, autonomy },
    notes,
  };
}

/**
 * difficultyからeffortの段（`EFFORT_LADDER`の添字）へ。補正の最低線も含む。
 *
 * 最低線（`effort floor`）と上限（コスト方針）がぶつかったときは上限が勝つ。`low` を
 * 選んでいる人にとっては、危ない作業だからこそ安く済ませたい局面のはずで、ここで最低線を
 * 優先すると方針が効かない場面が残る。
 *
 * @param preset 省略時は `full`（上限なし）
 */
export function effortIndexFor(
  assessment: TaskAssessment,
  preset: CostPreset = 'full',
): { index: number; notes: string[] } {
  const notes: string[] = [];
  let index: number = assessment.difficulty;
  // 深く考えないと危ない種類の作業は、difficultyが低く出てもhigh以上にする
  const needsHigh =
    assessment.taskType === 'debugging' ||
    assessment.taskType === 'security_review' ||
    assessment.taskType === 'review_spec' ||
    assessment.risk === 2;
  if (needsHigh && index < 1) {
    index = 1;
    notes.push('effort floor: high');
  }
  const cap = EFFORT_CAP[preset];
  if (index > cap) {
    index = cap;
    notes.push(`コスト方針=${preset}: effortを${EFFORT_LADDER[cap] ?? ''}へ制限`);
  }
  return { index, notes };
}

/**
 * scope / ambiguity / risk / autonomy の合計（0〜8）からティアへ。
 *
 * 2以下は最下位（局所的で明確な作業）、5以下は中位、それ以上は最上位（リポジトリ横断で
 * 曖昧、または高リスクで自律的）。最上位の下限と上限はコスト方針（`preset`）で動く
 * （Issue #1214。`balanced` は最上位を合計8のときだけ、`low` は最上位を使わない）。
 *
 * @param preset 省略時は `full`（従来どおりの割り当て）
 */
export function tierFor(
  assessment: TaskAssessment,
  preset: CostPreset = 'full',
): { tier: number; score: number; notes: string[] } {
  const score = assessment.scope + assessment.ambiguity + assessment.risk + assessment.autonomy;
  const uncapped = score <= 2 ? 0 : score < TIER2_FLOOR[preset] ? 1 : 2;
  const tier = Math.min(uncapped, TIER_CAP[preset]);
  const notes: string[] =
    tier === uncapped ? [] : [`コスト方針=${preset}: モデルのティアを${tier}へ制限`];
  // 下限の引き上げで落ちた分（`balanced` の合計6・7）も、理由として見えるようにする
  if (tier === uncapped && preset !== 'full' && score >= TIER2_FLOOR.full && tier < 2) {
    notes.push(`コスト方針=${preset}: 最上位モデルは合計${TIER2_FLOOR[preset]}以上のときだけ`);
  }
  return { tier, score, notes };
}

/** ティアに合うモデルを一覧から選ぶ。見つからなければ `undefined`（＝据え置き）。 */
export function pickModel(models: readonly ModelInfo[], tier: number): string | undefined {
  for (const keyword of MODEL_TIERS[tier] ?? []) {
    const hit = models.find((m) => m.slug.toLowerCase().includes(keyword));
    if (hit !== undefined) {
      return hit.slug;
    }
  }
  return undefined;
}

/**
 * モデルとeffortの段から、そのモデルで実際に選べるeffortへ。
 *
 * `EFFORT_LADDER` とカタログの一覧の積を取り、段が足りなければ選べる中の最上位へ丸める。
 * effortの概念を持たないモデルでは空文字。
 */
export function effortFor(
  models: readonly ModelInfo[],
  model: string,
  index: number,
  fallbackEfforts?: readonly string[],
): string {
  const available =
    fallbackEfforts === undefined
      ? effortsFor([...models], model)
      : effortsFor([...models], model, fallbackEfforts);
  if (available.length === 0) {
    return '';
  }
  const ladder = EFFORT_LADDER.filter((e) => available.includes(e));
  if (ladder.length === 0) {
    return '';
  }
  return ladder[Math.min(index, ladder.length - 1)] ?? '';
}

/**
 * 見立てをmodel / effortへ解決する。
 *
 * **静的な対応表（`スコア6 = gpt-6-astra / xhigh` のような）は持たない。** このリポジトリは
 * モデル一覧もeffort一覧もCLIから動的に取っており（`modelCatalog.ts` の `effortsFor`）、
 * 静的表を持つとその仕組みを迂回して、存在しないモデル名や非対応のeffortをCLIへ渡すことに
 * なる。ここで持つのは順位（どちらが重いか）だけで、実在するかどうかはカタログに訊く。
 *
 * @param current 引き継ぎ元のmodel / effort。ティアに合うモデルが無いときの据え置き先
 * @param fallbackEfforts カタログからeffort一覧を取れないときの退避先（Claude Codeは `CLAUDE_EFFORTS`）
 * @param preset コスト方針（Issue #1214）。省略時は `full`（従来どおり）
 */
export function resolveProfile(
  raw: TaskAssessment,
  context: { turnFailed: boolean },
  models: readonly ModelInfo[],
  current: HandoffProfile,
  fallbackEfforts?: readonly string[],
  preset: CostPreset = 'full',
): ResolvedProfile {
  const corrected = applyCorrections(raw, context);
  const assessment = corrected.assessment;
  const effort = effortIndexFor(assessment, preset);
  const { tier, score, notes: tierNotes } = tierFor(assessment, preset);

  const model = pickModel(models, tier) ?? current.model;
  const reasons = [
    `${assessment.taskType} difficulty=${assessment.difficulty} scope=${assessment.scope} ambiguity=${assessment.ambiguity} risk=${assessment.risk} autonomy=${assessment.autonomy} (model score=${score})`,
    ...corrected.notes,
    ...tierNotes,
    ...effort.notes,
  ];
  return {
    model,
    effort: effortFor(models, model, effort.index, fallbackEfforts),
    tier,
    effortIndex: effort.index,
    reasons,
  };
}
