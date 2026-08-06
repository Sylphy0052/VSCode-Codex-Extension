export interface EffortInfo {
  effort: string;
  description: string | undefined;
}

export interface ModelInfo {
  slug: string;
  displayName: string;
  description: string | undefined;
  defaultEffort: string | undefined;
  efforts: EffortInfo[];
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
        efforts: parseEfforts(m['supported_reasoning_levels']),
      },
      priority: typeof priority === 'number' ? priority : Number.MAX_SAFE_INTEGER,
    });
  }

  return parsed.sort((a, b) => a.priority - b.priority).map((p) => p.info);
}

function parseEfforts(raw: unknown): EffortInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const efforts: EffortInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const effort = e['effort'];
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
 */
export function effortsFor(models: ModelInfo[], slug: string): string[] {
  const model = slug === '' ? undefined : findModel(models, slug);
  if (model !== undefined && model.efforts.length > 0) {
    return model.efforts.map((e) => e.effort);
  }
  if (models.length === 0) {
    return [...FALLBACK_EFFORTS];
  }
  // モデル未指定なら、どのモデルでも選びうる値の和集合を出す
  const union = new Set<string>();
  for (const m of models) {
    for (const e of m.efforts) {
      union.add(e.effort);
    }
  }
  return union.size > 0 ? [...union] : [...FALLBACK_EFFORTS];
}
