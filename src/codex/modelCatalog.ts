export interface EffortInfo {
  effort: string;
  description: string | undefined;
}

export interface ModelInfo {
  slug: string;
  displayName: string;
  description: string | undefined;
  defaultEffort: string | undefined;
  /**
   * そもそもeffortを選べるモデルか。
   *
   * Claude Codeの haiku のように effort の概念を持たないモデルがあるため、
   * 「対応しない」と「一覧を取れなかった」を区別する。Codexは全モデルが対応する。
   */
  supportsEffort: boolean;
  efforts: EffortInfo[];
  /**
   * Fast mode（Claude Codeの `/fast`。Issue #198）を持つモデルか。
   *
   * `initialize` の応答の `models[].supportsFastMode` 由来で、**Claude Code側にしか無い**
   * 概念のためCodexでは常に `undefined`。`supportsEffort` と違って三値（対応する / 対応
   * しない / そもそも情報が無い）を区別する必要があるので任意項目にしてある。
   */
  supportsFastMode?: boolean | undefined;
}

/**
 * カタログが読めない場合のフォールバック。
 * 実データ（models_cache.json）で確認できた値の和集合。
 */
export const FALLBACK_EFFORTS: readonly string[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

/** `-c model_reasoning_effort=<値>` に渡してよい形か。引数注入を防ぐ。 */
const EFFORT_RE = /^[a-z][a-z0-9-]*$/;

export function isEffortToken(value: string): boolean {
  return EFFORT_RE.test(value);
}

/**
 * `~/.codex/models_cache.json` をパースする。
 *
 * Codexが更新するキャッシュであり、こちらからは読むだけ。取得できない場合や形式が
 * 変わった場合でも空配列を返して落ちないようにする（UIは自由入力へフォールバックする）。
 */
export function parseModelCatalog(content: string): ModelInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return [];
  }

  if (typeof raw !== 'object' || raw === null) {
    return [];
  }

  const models = (raw as Record<string, unknown>)['models'];
  if (!Array.isArray(models)) {
    return [];
  }

  const parsed: Array<{ info: ModelInfo; priority: number }> = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const m = entry as Record<string, unknown>;
    const slug = m['slug'];
    if (typeof slug !== 'string' || slug === '') {
      continue;
    }
    // 一覧に出さないモデル（内部用途）は除く
    if (m['visibility'] !== 'list') {
      continue;
    }

    const displayName = m['display_name'];
    const description = m['description'];
    const defaultEffort = m['default_reasoning_level'];
    const priority = m['priority'];

    parsed.push({
      info: {
        slug,
        displayName: typeof displayName === 'string' && displayName !== '' ? displayName : slug,
        description: typeof description === 'string' ? description : undefined,
        defaultEffort: typeof defaultEffort === 'string' ? defaultEffort : undefined,
        supportsEffort: true,
        efforts: parseEfforts(m['supported_reasoning_levels'], 'effort'),
      },
      priority: typeof priority === 'number' ? priority : Number.MAX_SAFE_INTEGER,
    });
  }

  return parsed.sort((a, b) => a.priority - b.priority).map((p) => p.info);
}

/**
 * `model/list` の応答をパースする。
 *
 * app-serverが返す一覧であり、CLIが新しいモデルに対応すればそのまま反映される。
 * 取得できない場合は `parseModelCatalog`（キャッシュファイル）へ退避するため、
 * ここでは形が違えば黙って空を返す。
 *
 * 実測の1件（`codex-cli 0.147.0`）:
 * `{id, model, displayName, description, hidden, isDefault, defaultReasoningEffort,
 *   supportedReasoningEfforts:[{reasoningEffort, description}]}`
 */
export function parseModelList(result: unknown): ModelInfo[] {
  const data = asRecord(result)?.['data'];
  if (!Array.isArray(data)) {
    return [];
  }

  const models: ModelInfo[] = [];
  for (const entry of data) {
    const m = asRecord(entry);
    if (m === undefined) {
      continue;
    }
    // `model` が実際にCLIへ渡す値。無い応答に備えて `id` で代用する
    const slug = str(m['model']) || str(m['id']);
    if (slug === '') {
      continue;
    }
    // 既定のピッカーに出さないモデルは選択肢にも出さない
    if (m['hidden'] === true) {
      continue;
    }

    const displayName = str(m['displayName']);
    const description = m['description'];
    const defaultEffort = m['defaultReasoningEffort'];

    models.push({
      slug,
      displayName: displayName === '' ? slug : displayName,
      description: typeof description === 'string' && description !== '' ? description : undefined,
      defaultEffort: typeof defaultEffort === 'string' ? defaultEffort : undefined,
      supportsEffort: true,
      efforts: parseEfforts(m['supportedReasoningEfforts'], 'reasoningEffort'),
    });
  }
  return models;
}

/**
 * `model/list` の続きを取るためのカーソル。続きが無ければ `undefined`。
 */
export function readNextCursor(result: unknown): string | undefined {
  const cursor = str(asRecord(result)?.['nextCursor']);
  return cursor === '' ? undefined : cursor;
}

function parseEfforts(raw: unknown, key: string): EffortInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const efforts: EffortInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const effort = e[key];
    if (typeof effort !== 'string' || !isEffortToken(effort)) {
      continue;
    }
    const description = e['description'];
    efforts.push({
      effort,
      description: typeof description === 'string' ? description : undefined,
    });
  }
  return efforts;
}

export function findModel(models: ModelInfo[], slug: string): ModelInfo | undefined {
  return models.find((m) => m.slug === slug);
}

/**
 * 指定モデルで選べるeffort。モデル未指定・カタログ未取得のときは和集合を返す。
 *
 * effortに対応しないモデル（Claude Codeの haiku など）では空配列を返す。呼び出し側は
 * 選択肢を出さないこと。`fallback` は一覧そのものを取れなかったときに使う。
 */
export function effortsFor(
  models: ModelInfo[],
  slug: string,
  fallback: readonly string[] = FALLBACK_EFFORTS,
): string[] {
  const model = slug === '' ? undefined : findModel(models, slug);
  if (model !== undefined) {
    if (!model.supportsEffort) {
      return [];
    }
    if (model.efforts.length > 0) {
      return model.efforts.map((e) => e.effort);
    }
  }
  if (models.length === 0) {
    return [...fallback];
  }
  // モデル未指定なら、どのモデルでも選びうる値の和集合を出す
  const union = new Set<string>();
  for (const m of models) {
    for (const e of m.efforts) {
      union.add(e.effort);
    }
  }
  return union.size > 0 ? [...union] : [...fallback];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
