import { effortsFor, type ModelInfo } from '../codex/modelCatalog';
import type { HandoffTrigger } from './handoff';

/**
 * 引き継ぎ先セッションのmodel / effortを、引き継ぎ元の内容から決める（Issue #1082）。
 *
 * 判定はLLM分類器を使わない決定的なルールで行う。分類のために別のモデル呼び出しを挟むと
 * latencyとtokenが増え、分類器自体の揺れも入る。代わりにキーワードの加点で抽象レベル
 * L0〜L5を出し、そのレベルをモデルカタログ（`modelCatalog.ts`）の一覧へ当てて具体の
 * model / effortへ解決する。
 *
 * model × effortの組み合わせを直接持たないのは、モデルが更新されたときに壊れないため。
 * このリポジトリはモデル一覧もeffort一覧もCLIから動的に取っており、静的な対応表を持つと
 * その仕組みを迂回して、存在しないモデル名や非対応のeffortをCLIへ渡すことになる。
 */

/** 抽象レベル。0が最も軽く、5が最も重い。 */
export type HandoffLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** ルータの入力。`HandoffPointerInput` が既に集めている値だけで構成する。 */
export interface HandoffRouterInput {
  trigger: HandoffTrigger;
  /** 直前のターンが失敗して終わったか。 */
  turnFailed: boolean;
  /** 直近のユーザー指示（会話順）。 */
  recentUserMessages: readonly string[];
  cwd: string | undefined;
  gitBranch: string | undefined;
  /**
   * 直前のターンで編集したファイル。**ターン単位でリセットされる**ため件数は信用できない
   * （`handoff.ts` の同名の項目を参照）。パスの判定にだけ使い、ファイル数の加点には使わない。
   */
  turnEditedFiles: readonly string[];
}

/** ルータの出力。`reasons` はポインタファイルとログへそのまま出す。 */
export interface HandoffRouterDecision {
  level: HandoffLevel;
  /** 解決したモデル。カタログからティアを判定できなければ引き継ぎ元のまま。 */
  model: string;
  /** 解決したeffort。effort非対応のモデルでは空文字。 */
  effort: string;
  /** なぜこのレベルになったか。UIは増やさず、ここに事実だけ残す。 */
  reasons: string[];
}

/** 加点に使う分類。floorを持つものだけ名前を付ける。 */
type Signal = 'security' | 'architecture' | 'root_cause' | 'migration' | 'concurrency' | 'generic';

interface Rule {
  signal: Signal;
  /** 加点の理由としてそのまま出す短い名前。 */
  label: string;
  keywords: readonly string[];
}

/**
 * キーワード表。日本語と英語の両方を持つ。
 *
 * 判定は小文字化した文字列への部分一致で行う。単語境界を見ないのは、日本語には語の区切りが
 * 無く、英語側だけ厳密にすると挙動が言語によって食い違うため。誤検知は「レベルが1段上がる」
 * だけで、壊れた設定をCLIへ渡すことにはならない。
 */
const RULES: readonly Rule[] = [
  { signal: 'generic', label: 'refactor', keywords: ['refactor', 'リファクタ'] },
  {
    signal: 'root_cause',
    label: 'root cause',
    keywords: ['debug', 'root cause', '原因', 'バグ', '落ちる', '再現'],
  },
  {
    signal: 'architecture',
    label: 'architecture',
    keywords: ['architecture', 'design', '設計', 'アーキテクチャ'],
  },
  {
    signal: 'concurrency',
    label: 'concurrency',
    keywords: ['concurrency', 'async', 'race', '並行', '競合', '非同期'],
  },
  { signal: 'migration', label: 'migration', keywords: ['migration', 'マイグレーション', '移行'] },
  {
    signal: 'security',
    label: 'security',
    keywords: ['auth', 'security', '認証', '認可', 'セキュリティ', '脆弱'],
  },
  {
    signal: 'generic',
    label: 'performance',
    keywords: ['performance', 'perf', '性能', '遅い', 'パフォーマンス'],
  },
];

/** パスから分類を拾う。`cwd` / `gitBranch` / 編集ファイルのどれに出ても同じ扱い。 */
const PATH_RULES: readonly { signal: Signal; label: string; fragments: readonly string[] }[] = [
  { signal: 'security', label: 'path:auth', fragments: ['auth/', 'payment/'] },
  { signal: 'migration', label: 'path:migration', fragments: ['migration/', 'migrations/'] },
  {
    signal: 'architecture',
    label: 'path:infra',
    fragments: ['terraform/', '.github/workflows/'],
  },
];

/** 分類ごとの最低レベル。加点の結果がこれを下回るときだけ引き上げる。 */
const FLOORS: Partial<Record<Signal, HandoffLevel>> = {
  security: 4,
  architecture: 4,
  root_cause: 3,
  migration: 3,
  concurrency: 3,
};

/**
 * モデルのティア。カタログ（`ModelInfo`）はティア情報を持たないため、slugの部分一致で
 * 順位付けする。
 *
 * どのキーワードにも当たらないときはモデルを変えない（引き継ぎ元をそのまま使う）。
 * 知らないモデルを順位の分からないまま並べて選ぶより、変えない方が壊れ方が小さい。
 */
const MODEL_TIERS: readonly (readonly string[])[] = [
  ['haiku', 'luna'], // 低
  ['sonnet', 'terra'], // 中
  ['fable', 'opus', 'sol'], // 高
];

/** レベルからティアの段（0=低 / 1=中 / 2=高）へ。 */
function tierForLevel(level: HandoffLevel): number {
  if (level <= 1) return 0;
  if (level <= 3) return 1;
  return 2;
}

function normalize(values: readonly (string | undefined)[]): string {
  return values
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join('\n')
    .toLowerCase();
}

/**
 * レベルからeffort配列の添字へ。
 *
 * 端は仕様で固定する（L0=最下位、L5=最上位、L1=下から2番目、L4=上から2番目）。間は線形に
 * 割り当てたうえで、単調性が崩れないようclampする。配列の長さはモデルによって変わるため、
 * 長さが足りなければ端へ丸める。
 */
function effortIndex(level: HandoffLevel, count: number): number {
  const last = count - 1;
  if (last <= 0) return 0;
  const low = Math.min(1, last);
  const high = Math.max(0, last - 1);
  switch (level) {
    case 0:
      return 0;
    case 1:
      return low;
    case 4:
      return high;
    case 5:
      return last;
    default: {
      const linear = Math.round((level / 5) * last);
      return Math.min(Math.max(linear, low), high);
    }
  }
}

function levelFromScore(score: number): HandoffLevel {
  if (score <= 1) return 0;
  if (score <= 3) return 1;
  if (score <= 5) return 2;
  if (score <= 7) return 3;
  if (score <= 9) return 4;
  return 5;
}

/** ティアに合うモデルを一覧から選ぶ。見つからなければ `undefined`（＝据え置き）。 */
function pickModel(models: readonly ModelInfo[], tier: number): string | undefined {
  for (let t = tier; t >= 0; t -= 1) {
    for (const keyword of MODEL_TIERS[t] ?? []) {
      const hit = models.find((m) => m.slug.toLowerCase().includes(keyword));
      if (hit !== undefined) {
        // 求めたティアそのものが見つかったときだけ採用する。下位へ落ちるのは「そのティアの
        // モデルがカタログに無い」場合で、引き継ぎ元より軽いモデルへ勝手に降格させない
        return t === tier ? hit.slug : undefined;
      }
    }
  }
  return undefined;
}

/**
 * 引き継ぎ先のmodel / effortを決める。
 *
 * 判定材料がまったく無いとき（直近のユーザー指示が空で、直前のターンも失敗しておらず、
 * パスにも当たらない）は `undefined` を返す。呼び出し側はそのとき引き継ぎ元の値をそのまま
 * 持ち越す。材料が無いのにL0を返すと、重い作業を軽いモデルへ落とす誤った降格になる。
 *
 * @param current 引き継ぎ元のmodel / effort。モデルのティアを判定できないときの据え置き先
 * @param fallbackEfforts カタログからeffortを取れないときの退避先（Claude Codeは `CLAUDE_EFFORTS`）
 */
export function decideHandoffModel(
  input: HandoffRouterInput,
  models: readonly ModelInfo[],
  current: { model: string; effort: string },
  fallbackEfforts?: readonly string[],
): HandoffRouterDecision | undefined {
  const text = normalize(input.recentUserMessages);
  const paths = normalize([input.cwd, input.gitBranch, ...input.turnEditedFiles]).replace(
    /\\/g,
    '/',
  );

  let score = 1;
  const reasons: string[] = [];
  const signals = new Set<Signal>();

  for (const rule of RULES) {
    if (rule.keywords.some((k) => text.includes(k))) {
      score += 1;
      signals.add(rule.signal);
      reasons.push(`+1 ${rule.label}`);
    }
  }
  for (const rule of PATH_RULES) {
    if (rule.fragments.some((f) => paths.includes(f))) {
      signals.add(rule.signal);
      reasons.push(`floor ${rule.label}`);
    }
  }
  if (input.turnFailed) {
    reasons.push('previous attempt failed');
  }

  if (reasons.length === 0) {
    // 材料が無い。ここでL0を返さない
    return undefined;
  }

  let level = levelFromScore(score);
  for (const signal of signals) {
    const floor = FLOORS[signal];
    if (floor !== undefined && floor > level) {
      level = floor;
      reasons.push(`floor ${signal} -> L${floor}`);
    }
  }

  // 直前のターンが失敗しているときはレベルを1段上げる。加点（+1）にしないのは、キーワードの
  // 加点はscore最大9＝L4止まりで、L5へは加点だけでは届かないため。「同じ重さでもう一度
  // やらせても同じところで失敗する」という信号を、他のキーワードより強く扱う
  if (input.turnFailed && level < 5) {
    level = (level + 1) as HandoffLevel;
    reasons.push(`+1 level -> L${level} (previous attempt failed)`);
  }

  // L5（最上位effort）は「一度失敗した後の再挑戦」だけに使う。max相当は
  // diminishing returnsの可能性があり、失敗していないのに届かせない
  if (level === 5 && !input.turnFailed) {
    level = 4;
    reasons.push('L5 -> L4 (no previous failure)');
  }

  const model = pickModel(models, tierForLevel(level)) ?? current.model;
  const efforts =
    fallbackEfforts === undefined
      ? effortsFor([...models], model)
      : effortsFor([...models], model, fallbackEfforts);
  const effort = efforts.length === 0 ? '' : (efforts[effortIndex(level, efforts.length)] ?? '');

  reasons.unshift(`L${level} (score=${score})`);
  return { level, model, effort, reasons };
}
