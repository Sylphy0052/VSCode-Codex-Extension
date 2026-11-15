import { stripControlCharsPreservingNewlines } from './sanitize';

/**
 * 最適化ハーネス（Issue #2106）のタスクごとの「最適化の仕様」。
 *
 * 拡張が指標のコマンドを測り、候補の採否を計測で決める。LLMは仮説と変更を出すだけで、仕様は
 * 人がKanbanで承認したものだけが使える。準備・指標・正しさのコマンドは拡張がsandboxの外で
 * 実行するため、仕様の文字列はすべて「承認画面で全文を見た人が許したもの」として扱う。
 *
 * 指標の取り方は2つだけ。出力の文字列から正規表現で数値を拾う方式は、候補のコードが偽の数値を
 * 出力できるため採らない。
 * - `wallTime`: 拡張が指標のコマンドの実行時間を測る
 * - `file`: 変更禁止の計測スクリプトが`metricFile`へ書くJSON（`{"value": <数値>, "<副指標の名前>": <数値>}`）
 *   から数値を取る。拡張は実行前にそのファイルを消す
 */

export type OptimizeMetricSource = 'wallTime' | 'file';

/** 小さいほど良い（`minimize`）か、大きいほど良い（`maximize`）か。 */
export type OptimizeDirection = 'minimize' | 'maximize';

/** 差の大きさ。`absolute`は指標と同じ単位の値、`percent`は基準値に対する割合（%）。 */
export interface OptimizeDelta {
  kind: 'absolute' | 'percent';
  value: number;
}

/** 悪化を許さない副指標。値は`file`の指標JSONの`name`のキーから取る。 */
export interface OptimizeSecondaryMetric {
  name: string;
  direction: OptimizeDirection;
  /** 悪化してよい最大の幅。 */
  tolerance: OptimizeDelta;
}

export interface OptimizeBudget {
  /** 試行回数の上限。 */
  maxTrials: number;
  /** 所要時間の上限（分）。 */
  maxMinutes: number;
}

export interface OptimizationSpec {
  /** 準備のコマンド（依存の導入とビルド。例: `npm ci`）。無ければ省く。 */
  setupCommand?: string;
  metricSource: OptimizeMetricSource;
  /** 指標を測るコマンド。`wallTime`ではこの実行時間が指標になる。 */
  metricCommand: string;
  /** `file`のときだけ。リポジトリからの相対パス。 */
  metricFile?: string;
  direction: OptimizeDirection;
  /** 改善と見なす最小の差。 */
  minImprovement: OptimizeDelta;
  /** 有意水準（0より大きく0.5以下）。 */
  significanceLevel: number;
  secondaryMetrics?: OptimizeSecondaryMetric[];
  /** 正しさの確認コマンド。終了コード0を正しいとする。 */
  correctnessCommand: string;
  /** 変更してよいパス。ここに無いパスはすべて変更禁止（ベンチマーク・fixture・テスト・設定・計測スクリプトも）。 */
  allowedPaths: string[];
  budget: OptimizeBudget;
  /** 目標値。届いたら打ち切る。 */
  target?: number;
  /** 1つの案を測る回数N。 */
  measurementRuns: number;
}

export const MIN_MEASUREMENT_RUNS = 5;
export const MAX_MEASUREMENT_RUNS = 100;
export const MAX_TRIALS_LIMIT = 500;
export const MAX_MINUTES_LIMIT = 7 * 24 * 60;
export const MAX_ALLOWED_PATHS = 50;
export const MAX_SECONDARY_METRICS = 10;
export const MAX_COMMAND_LENGTH = 1000;
export const MAX_PATH_LENGTH = 300;
export const MAX_METRIC_NAME_LENGTH = 64;

const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type OptimizeParsed<T> = { ok: true; value: T } | { ok: false; message: string };

function fail<T>(message: string): OptimizeParsed<T> {
  return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKey(raw: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(raw).find((key) => !allowed.includes(key));
}

function readCommand(value: unknown, field: string, required: boolean): OptimizeParsed<string> {
  if (value === undefined && !required) {
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return fail(`${field}は文字列で指定する`);
  }
  const cleaned = stripControlCharsPreservingNewlines(value).trim();
  if (cleaned === '') {
    return fail(`${field}が空`);
  }
  if (cleaned.includes('\n')) {
    return fail(`${field}は1行で指定する（改行を含められない）`);
  }
  if ([...cleaned].length > MAX_COMMAND_LENGTH) {
    return fail(`${field}は${String(MAX_COMMAND_LENGTH)}文字以内にする`);
  }
  return { ok: true, value: cleaned };
}

function readPath(value: unknown, field: string): OptimizeParsed<string> {
  if (typeof value !== 'string') {
    return fail(`${field}は文字列で指定する`);
  }
  const cleaned = stripControlCharsPreservingNewlines(value).trim();
  if (cleaned === '' || cleaned.includes('\n') || [...cleaned].length > MAX_PATH_LENGTH) {
    return fail(`${field}は1行・${String(MAX_PATH_LENGTH)}文字以内の空でないパスで指定する`);
  }
  if (cleaned.startsWith('/') || cleaned.startsWith('~') || /^[A-Za-z]:/u.test(cleaned)) {
    return fail(`${field}はリポジトリからの相対パスで指定する`);
  }
  if (cleaned.includes('\\')) {
    return fail(`${field}は/区切りで指定する`);
  }
  const segments = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    return fail(`${field}に..を含められない`);
  }
  const meaningful = segments.filter((s) => !/^\*+$/u.test(s));
  if (meaningful.length === 0) {
    return fail(`${field}はリポジトリ全体を許すパスにできない（許すパスを列挙する）`);
  }
  return { ok: true, value: segments.join('/') };
}

function readNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  integer: boolean,
): OptimizeParsed<number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`${field}は数値で指定する`);
  }
  if (integer && !Number.isSafeInteger(value)) {
    return fail(`${field}は整数で指定する`);
  }
  if (value < min || value > max) {
    return fail(`${field}は${String(min)}以上${String(max)}以下にする`);
  }
  return { ok: true, value };
}

function readDelta(value: unknown, field: string): OptimizeParsed<OptimizeDelta> {
  if (!isRecord(value)) {
    return fail(`${field}は{kind, value}のオブジェクトで指定する`);
  }
  const extra = unknownKey(value, ['kind', 'value']);
  if (extra !== undefined) {
    return fail(`${field}に未知のキー${extra}がある`);
  }
  if (value.kind !== 'absolute' && value.kind !== 'percent') {
    return fail(`${field}.kindはabsoluteかpercentで指定する`);
  }
  const amount = readNumber(value.value, `${field}.value`, 0, Number.MAX_SAFE_INTEGER, false);
  if (!amount.ok) {
    return amount;
  }
  if (value.kind === 'percent' && amount.value > 1000) {
    return fail(`${field}.valueは%のとき1000以下にする`);
  }
  return { ok: true, value: { kind: value.kind, value: amount.value } };
}

function readDirection(value: unknown, field: string): OptimizeParsed<OptimizeDirection> {
  return value === 'minimize' || value === 'maximize'
    ? { ok: true, value }
    : fail(`${field}はminimizeかmaximizeで指定する`);
}

function readSecondary(raw: unknown, field: string): OptimizeParsed<OptimizeSecondaryMetric> {
  if (!isRecord(raw)) {
    return fail(`${field}はオブジェクトで指定する`);
  }
  const extra = unknownKey(raw, ['name', 'direction', 'tolerance']);
  if (extra !== undefined) {
    return fail(`${field}に未知のキー${extra}がある`);
  }
  if (typeof raw.name !== 'string' || !METRIC_NAME.test(raw.name) || raw.name === 'value') {
    return fail(
      `${field}.nameは英字で始まる英数字・_・.・-の${String(MAX_METRIC_NAME_LENGTH)}文字以内で指定する（valueは主指標の名前なので使えない）`,
    );
  }
  const direction = readDirection(raw.direction, `${field}.direction`);
  if (!direction.ok) {
    return direction;
  }
  const tolerance = readDelta(raw.tolerance, `${field}.tolerance`);
  if (!tolerance.ok) {
    return tolerance;
  }
  return {
    ok: true,
    value: { name: raw.name, direction: direction.value, tolerance: tolerance.value },
  };
}

const SPEC_KEYS = [
  'setupCommand',
  'metricSource',
  'metricCommand',
  'metricFile',
  'direction',
  'minImprovement',
  'significanceLevel',
  'secondaryMetrics',
  'correctnessCommand',
  'allowedPaths',
  'budget',
  'target',
  'measurementRuns',
];

/**
 * `propose_plan`のタスクの`optimization`を検証する。型に合わない値は切り詰めずに理由付きで拒否し、
 * 書き直させる。返す値はキーの順序が固定なので、`sameOptimization`で全項目を比べられる。
 */
export function parseOptimizationSpec(raw: unknown, at: string): OptimizeParsed<OptimizationSpec> {
  if (!isRecord(raw)) {
    return fail(`${at}はオブジェクトで指定する`);
  }
  const extra = unknownKey(raw, SPEC_KEYS);
  if (extra !== undefined) {
    return fail(`${at}に未知のキー${extra}がある`);
  }
  const setup = readCommand(raw.setupCommand, `${at}.setupCommand`, false);
  if (!setup.ok) {
    return setup;
  }
  const metricSource = raw.metricSource ?? 'wallTime';
  if (metricSource !== 'wallTime' && metricSource !== 'file') {
    return fail(
      `${at}.metricSourceはwallTimeかfileで指定する（出力の正規表現で拾う方式は使えない）`,
    );
  }
  const metricCommand = readCommand(raw.metricCommand, `${at}.metricCommand`, true);
  if (!metricCommand.ok) {
    return metricCommand;
  }
  let metricFile: string | undefined;
  if (metricSource === 'file') {
    const file = readPath(raw.metricFile, `${at}.metricFile`);
    if (!file.ok) {
      return file;
    }
    metricFile = file.value;
  } else if (raw.metricFile !== undefined) {
    return fail(`${at}.metricFileはmetricSourceがfileのときだけ指定する`);
  }
  const direction = readDirection(raw.direction, `${at}.direction`);
  if (!direction.ok) {
    return direction;
  }
  const minImprovement = readDelta(raw.minImprovement, `${at}.minImprovement`);
  if (!minImprovement.ok) {
    return minImprovement;
  }
  const level = readNumber(raw.significanceLevel, `${at}.significanceLevel`, 1e-6, 0.5, false);
  if (!level.ok) {
    return level;
  }
  const secondary = readSecondaryList(raw.secondaryMetrics, metricSource, `${at}.secondaryMetrics`);
  if (!secondary.ok) {
    return secondary;
  }
  const correctness = readCommand(raw.correctnessCommand, `${at}.correctnessCommand`, true);
  if (!correctness.ok) {
    return correctness;
  }
  const paths = readAllowedPaths(raw.allowedPaths, `${at}.allowedPaths`);
  if (!paths.ok) {
    return paths;
  }
  const budget = readBudget(raw.budget, `${at}.budget`);
  if (!budget.ok) {
    return budget;
  }
  let target: number | undefined;
  if (raw.target !== undefined) {
    const t = readNumber(raw.target, `${at}.target`, -Number.MAX_VALUE, Number.MAX_VALUE, false);
    if (!t.ok) {
      return t;
    }
    target = t.value;
  }
  const runs = readNumber(
    raw.measurementRuns,
    `${at}.measurementRuns`,
    MIN_MEASUREMENT_RUNS,
    MAX_MEASUREMENT_RUNS,
    true,
  );
  if (!runs.ok) {
    return runs;
  }
  const value: OptimizationSpec = {
    ...(setup.value === '' ? {} : { setupCommand: setup.value }),
    metricSource,
    metricCommand: metricCommand.value,
    ...(metricFile === undefined ? {} : { metricFile }),
    direction: direction.value,
    minImprovement: minImprovement.value,
    significanceLevel: level.value,
    ...(secondary.value.length === 0 ? {} : { secondaryMetrics: secondary.value }),
    correctnessCommand: correctness.value,
    allowedPaths: paths.value,
    budget: budget.value,
    ...(target === undefined ? {} : { target }),
    measurementRuns: runs.value,
  };
  return { ok: true, value };
}

function readSecondaryList(
  raw: unknown,
  metricSource: OptimizeMetricSource,
  field: string,
): OptimizeParsed<OptimizeSecondaryMetric[]> {
  if (raw === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw) || raw.length > MAX_SECONDARY_METRICS) {
    return fail(`${field}は${String(MAX_SECONDARY_METRICS)}件以内の配列で指定する`);
  }
  if (raw.length > 0 && metricSource !== 'file') {
    return fail(
      `${field}はmetricSourceがfileのときだけ指定する（値を計測スクリプトのJSONから取るため）`,
    );
  }
  const list: OptimizeSecondaryMetric[] = [];
  for (const [i, item] of raw.entries()) {
    const parsed = readSecondary(item, `${field}[${String(i)}]`);
    if (!parsed.ok) {
      return parsed;
    }
    list.push(parsed.value);
  }
  if (new Set(list.map((m) => m.name)).size !== list.length) {
    return fail(`${field}のnameが重複している`);
  }
  return { ok: true, value: list };
}

function readAllowedPaths(raw: unknown, field: string): OptimizeParsed<string[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ALLOWED_PATHS) {
    return fail(
      `${field}は1〜${String(MAX_ALLOWED_PATHS)}件の配列で指定する（変更してよいパスの列挙は必須）`,
    );
  }
  const paths: string[] = [];
  for (const [i, item] of raw.entries()) {
    const parsed = readPath(item, `${field}[${String(i)}]`);
    if (!parsed.ok) {
      return parsed;
    }
    paths.push(parsed.value);
  }
  if (new Set(paths).size !== paths.length) {
    return fail(`${field}に同じパスが重複している`);
  }
  return { ok: true, value: paths };
}

function readBudget(raw: unknown, field: string): OptimizeParsed<OptimizeBudget> {
  if (!isRecord(raw)) {
    return fail(`${field}は{maxTrials, maxMinutes}のオブジェクトで指定する`);
  }
  const extra = unknownKey(raw, ['maxTrials', 'maxMinutes']);
  if (extra !== undefined) {
    return fail(`${field}に未知のキー${extra}がある`);
  }
  const trials = readNumber(raw.maxTrials, `${field}.maxTrials`, 1, MAX_TRIALS_LIMIT, true);
  if (!trials.ok) {
    return trials;
  }
  const minutes = readNumber(raw.maxMinutes, `${field}.maxMinutes`, 1, MAX_MINUTES_LIMIT, true);
  if (!minutes.ok) {
    return minutes;
  }
  return { ok: true, value: { maxTrials: trials.value, maxMinutes: minutes.value } };
}

/** 2つの仕様が全項目で同じか（どちらも無いときも同じ）。承認済みの計画の変更検出に使う。 */
export function sameOptimization(
  a: OptimizationSpec | undefined,
  b: OptimizationSpec | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function deltaText(delta: OptimizeDelta): string {
  return delta.kind === 'percent' ? `${String(delta.value)}%` : String(delta.value);
}

/**
 * 承認画面に出す全項目（Issue #2106の仕様4）。コマンドは省略せず全文で出す。承認済みの仕様だけから
 * 作り、Issue本文などの外部由来のテキストは混ぜない。
 */
export function describeOptimization(spec: OptimizationSpec): { label: string; value: string }[] {
  const directionText = spec.direction === 'minimize' ? '小さいほど良い' : '大きいほど良い';
  return [
    { label: '準備のコマンド', value: spec.setupCommand ?? '（なし）' },
    {
      label: '指標の取り方',
      value:
        spec.metricSource === 'wallTime'
          ? '指標のコマンドの実行時間（wallTime）'
          : `計測スクリプトが書くJSON（${spec.metricFile ?? ''}）`,
    },
    { label: '指標のコマンド', value: spec.metricCommand },
    { label: '向き', value: directionText },
    { label: '改善と見なす最小の差', value: deltaText(spec.minImprovement) },
    { label: '有意水準', value: String(spec.significanceLevel) },
    {
      label: '副指標',
      value:
        spec.secondaryMetrics === undefined
          ? '（なし）'
          : spec.secondaryMetrics
              .map(
                (m) =>
                  `${m.name}（${m.direction === 'minimize' ? '小さいほど良い' : '大きいほど良い'}、悪化の許容幅${deltaText(m.tolerance)}）`,
              )
              .join(' / '),
    },
    { label: '正しさの確認コマンド', value: spec.correctnessCommand },
    { label: '変更してよいパス', value: spec.allowedPaths.join(' / ') },
    {
      label: '予算',
      value: `試行${String(spec.budget.maxTrials)}回・${String(spec.budget.maxMinutes)}分`,
    },
    { label: '目標値', value: spec.target === undefined ? '（なし）' : String(spec.target) },
    { label: '計測の回数N', value: String(spec.measurementRuns) },
  ];
}
