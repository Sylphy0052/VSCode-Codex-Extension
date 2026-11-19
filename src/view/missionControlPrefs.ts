import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type {
  McActivity,
  McBooleanPrefKey,
  McFilterSpec,
  McNumberPrefKey,
  McPrefKey,
  McPrefs,
  McSavedFilter,
} from '../webview/missionControl/protocol';

/**
 * Mission Controlから変えられる設定と、名前を付けた絞り込みの保存（Issue #2162）。
 *
 * webviewから届く値はどれも信用しない。設定は固定の許可リストとキーが完全一致するものだけを
 * 受け、値の型と範囲をここで確かめる（`missionControlCommands.ts`の`runCommand`と同じ考え方）。
 * vscodeに依らない（単体テストから直接呼ぶ）。
 */

interface BooleanPrefSpec {
  kind: 'boolean';
  fallback: boolean;
}
interface NumberPrefSpec {
  kind: 'number';
  fallback: number;
  min: number;
  max: number;
}

const BOOLEAN_PREFS: Readonly<Record<McBooleanPrefKey, BooleanPrefSpec>> = {
  'notifications.approvalPending': { kind: 'boolean', fallback: true },
  'notifications.turnComplete': { kind: 'boolean', fallback: false },
  'notifications.sound.enabled': { kind: 'boolean', fallback: true },
  'notifications.sound.turnComplete': { kind: 'boolean', fallback: true },
  'notifications.sound.approvalPending': { kind: 'boolean', fallback: true },
  'notifications.sound.handoff': { kind: 'boolean', fallback: true },
  'notifications.sound.onlyWhenHidden': { kind: 'boolean', fallback: false },
};
/** `package.json`の`minimum` / `maximum` / `default`と同じ。 */
const NUMBER_PREFS: Readonly<Record<McNumberPrefKey, NumberPrefSpec>> = {
  'missionControl.stallMinutes': { kind: 'number', fallback: 5, min: 1, max: 1440 },
};

/**
 * 許可リスト（キーとの完全一致で引く。`Map`なので`__proto__`などは当たらない）。
 * 音のファイルのパスと再生コマンド（`notifications.sound.*File`・`playerCommand`）は、
 * 任意のファイルやコマンドを指せるので載せない。
 */
const PREF_SPECS: ReadonlyMap<string, BooleanPrefSpec | NumberPrefSpec> = new Map<
  string,
  BooleanPrefSpec | NumberPrefSpec
>([...Object.entries(BOOLEAN_PREFS), ...Object.entries(NUMBER_PREFS)]);

export const MC_PREF_KEYS: readonly McPrefKey[] = [...PREF_SPECS.keys()] as McPrefKey[];

/** `agent`節の設定を読む関数（`getConfiguration('agent').get`）。 */
export type McPrefReader = (key: McPrefKey) => unknown;

/** 今の値。型・範囲の合わない値は`package.json`の既定へ丸める（画面に壊れた値を出さない）。 */
export function readMcPrefs(read: McPrefReader): McPrefs {
  const prefs: Record<string, boolean | number> = {};
  for (const [key, spec] of PREF_SPECS) {
    const raw = read(key as McPrefKey);
    prefs[key] = isValidValue(spec, raw) ? raw : spec.fallback;
  }
  return prefs as McPrefs;
}

export interface McPrefChange {
  key: McPrefKey;
  value: boolean | number;
}

const SET_PREF_KEYS: ReadonlySet<string> = new Set(['type', 'seq', 'key', 'value']);

/** `setPref`を確かめる。変えてよければキーと値を、だめなら理由の文を返す。 */
export function parseSetPref(message: Record<string, unknown>): McPrefChange | string {
  if (!hasOnlyKeys(message, SET_PREF_KEYS)) {
    return '設定の変更の形が正しくありません';
  }
  const key = message.key;
  const spec = typeof key === 'string' ? PREF_SPECS.get(key) : undefined;
  if (spec === undefined) {
    return 'この設定はMission Controlから変えられません';
  }
  const value = message.value;
  if (!isValidValue(spec, value)) {
    return spec.kind === 'boolean'
      ? '設定の値が正しくありません'
      : `設定の値は${String(spec.min)}〜${String(spec.max)}の整数にしてください`;
  }
  return { key: key as McPrefKey, value };
}

function isValidValue(
  spec: BooleanPrefSpec | NumberPrefSpec,
  value: unknown,
): value is boolean | number {
  if (spec.kind === 'boolean') {
    return typeof value === 'boolean';
  }
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max
  );
}

// ---- 絞り込みの保存 ----

/** 保存できる絞り込みの数（`[` / `]`で回すので多すぎない数にする）。 */
export const MAX_SAVED_FILTERS = 20;
/** 名前の長さの上限。 */
export const MAX_FILTER_NAME_CHARS = 40;
const MAX_QUERY_CHARS = 200;
const MAX_REPO_KEY_CHARS = 1000;

const ACTIVITIES: ReadonlySet<string> = new Set<McActivity>([
  'idle',
  'running',
  'approvalPending',
  'handoffPending',
  'backgroundRunning',
]);

/**
 * 名前を1行にして長さを切る。制御文字・改行は空白へ、前後の空白は落とす。空になれば`undefined`。
 * 保存した名前は別ウィンドウ・globalStateを通るので、読むときにも通す。
 */
export function normalizeFilterName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const oneLine = sanitizeInlineText(raw, MAX_FILTER_NAME_CHARS * 4)
    .replace(/\s+/gu, ' ')
    .trim();
  if (oneLine === '') {
    return undefined;
  }
  const chars = [...oneLine];
  return chars.length > MAX_FILTER_NAME_CHARS
    ? chars.slice(0, MAX_FILTER_NAME_CHARS).join('')
    : oneLine;
}

/** 絞り込みの中身を確かめて作り直す。合わなければ`undefined`。 */
export function normalizeFilterSpec(raw: unknown): McFilterSpec | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const provider = v.provider;
  if (provider !== 'all' && provider !== 'codex' && provider !== 'claude') {
    return undefined;
  }
  if (typeof v.currentWindowOnly !== 'boolean' || typeof v.query !== 'string') {
    return undefined;
  }
  if (v.query.length > MAX_QUERY_CHARS) {
    return undefined;
  }
  const spec: McFilterSpec = {
    provider,
    currentWindowOnly: v.currentWindowOnly,
    // 検索語は1行の入力欄から来る。改行などは空白にしておく
    query: sanitizeInlineText(v.query, MAX_QUERY_CHARS),
  };
  if (v.repoKey !== undefined) {
    if (typeof v.repoKey !== 'string' || v.repoKey.length > MAX_REPO_KEY_CHARS) {
      return undefined;
    }
    spec.repoKey = v.repoKey;
  }
  if (v.activity !== undefined) {
    if (typeof v.activity !== 'string' || !ACTIVITIES.has(v.activity)) {
      return undefined;
    }
    spec.activity = v.activity as McActivity;
  }
  return spec;
}

/** globalStateから読んだ値を確かめる。壊れた項目は落とし、名前の重複は先のものを残す。 */
export function readSavedFilters(raw: unknown): McSavedFilter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: McSavedFilter[] = [];
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    if (out.length >= MAX_SAVED_FILTERS) {
      break;
    }
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const name = normalizeFilterName(entry.name);
    const filter = normalizeFilterSpec(entry.filter);
    if (
      name === undefined ||
      filter === undefined ||
      seen.has(name) ||
      out.some((f) => sameFilterSpec(f.filter, filter))
    ) {
      continue;
    }
    seen.add(name);
    out.push({ name, filter });
  }
  return out;
}

const SAVE_FILTER_KEYS: ReadonlySet<string> = new Set(['type', 'seq', 'name', 'filter']);
const DELETE_FILTER_KEYS: ReadonlySet<string> = new Set(['type', 'seq', 'name']);

/**
 * `saveFilter`を当てた後の一覧。同じ名前があれば中身を差し替えて位置を保つ。だめなら理由の文。
 */
export function applySaveFilter(
  current: readonly McSavedFilter[],
  message: Record<string, unknown>,
): McSavedFilter[] | string {
  if (!hasOnlyKeys(message, SAVE_FILTER_KEYS)) {
    return '絞り込みの保存の形が正しくありません';
  }
  const name = normalizeFilterName(message.name);
  if (name === undefined) {
    return '名前を入れてください';
  }
  const filter = normalizeFilterSpec(message.filter);
  if (filter === undefined) {
    return '絞り込みの中身が正しくありません';
  }
  // 中身が同じものを別の名前で持つと、`[` / `]`と削除が今の絞り込みを中身で見分けるので、
  // 後の名前へ切り替えられず、削除も先の名前に当たる。同じ中身は1つだけにする
  const twin = current.find((f) => f.name !== name && sameFilterSpec(f.filter, filter));
  if (twin !== undefined) {
    return `同じ絞り込みが「${twin.name}」で保存されています`;
  }
  const index = current.findIndex((f) => f.name === name);
  if (index >= 0) {
    return current.map((f, i) => (i === index ? { name, filter } : f));
  }
  if (current.length >= MAX_SAVED_FILTERS) {
    return `保存できる絞り込みは${String(MAX_SAVED_FILTERS)}件までです`;
  }
  return [...current, { name, filter }];
}

function sameFilterSpec(a: McFilterSpec, b: McFilterSpec): boolean {
  return (
    a.provider === b.provider &&
    a.currentWindowOnly === b.currentWindowOnly &&
    a.query === b.query &&
    a.repoKey === b.repoKey &&
    a.activity === b.activity
  );
}

/** `deleteFilter`を当てた後の一覧。だめなら理由の文。 */
export function applyDeleteFilter(
  current: readonly McSavedFilter[],
  message: Record<string, unknown>,
): McSavedFilter[] | string {
  if (!hasOnlyKeys(message, DELETE_FILTER_KEYS)) {
    return '絞り込みの削除の形が正しくありません';
  }
  const name = normalizeFilterName(message.name);
  if (name === undefined || !current.some((f) => f.name === name)) {
    return 'その名前の絞り込みはありません';
  }
  return current.filter((f) => f.name !== name);
}

function hasOnlyKeys(message: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const proto: unknown = Object.getPrototypeOf(message);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Reflect.ownKeys(message).every((key) => typeof key === 'string' && allowed.has(key));
}
