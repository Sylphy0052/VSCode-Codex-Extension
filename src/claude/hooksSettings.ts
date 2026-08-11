import type { HookOrigin, HookView } from '../provider/hooks';

/**
 * Claude Codeの `get_settings` control_requestの応答からhooks一覧を組み立てる。
 *
 * 実測(CLI 2.1.227)でCodexの `hooks/list` に相当する専用の一覧要求は無い。`initialize` に
 * 続けて `hooks_list` `list_hooks` `get_hooks` `hooks_status` `hook_list` `settings_list` を
 * 総当たりしたがいずれも `Unsupported control request subtype` で拒否された。**`get_settings`
 * だけが実在し**、`{ effective: {...}, sources: [{source, settings}], applied: {...} }` を返す。
 * `effective.hooks` が実際に使われるhookの一覧(イベント名をキーにしたグループの配列)。
 *
 * **信頼状態を返すフィールドは無い**。実測で確かめるため、`.claude/settings.json` に
 * プロジェクト側のhookを1件だけ置いた状態で `claude --print` を起動したところ、
 * 承認なしにそのままhookが実行された(`hook_started` → `hook_response` が届き、
 * 何かを尋ねるcontrol_requestは来なかった)。Codexと違い、Claude Codeには
 * 「hookを信頼するまで実行を止める」仕組みそのものがプロトコル層に無いとみられる。
 * そのため `HookView.trust` は常に `'unsupported'` にする(design.mdの「無いなら『無い』と
 * 画面に出す」方針。黙って承認済み扱いにしない)。
 *
 * ## 出どころ(origin)の求め方
 *
 * `sources` は `{source: 'userSettings'|'projectSettings'|..., settings: {...}}` の配列。
 * 実測で確認できたのは `userSettings`(`~/.claude/settings.json`)と
 * `projectSettings`(プロジェクトの `.claude/settings.json`)の2つ。
 *
 * `effective.hooks[eventName]` は、各 `sources[].settings.hooks[eventName]` を**そのまま
 * 連結したもの**になっている(実測: user側2グループ + project側1グループを設定したところ、
 * `effective` 側は3グループの単純な合計だった)。そこで、`effective` 側の各グループについて、
 * まだ使っていない同一内容(JSON深い等価)のグループをsourcesの中から探し、見つかった
 * ソース名をoriginとして採用する(先着順に消費する。同一内容の重複グループを二重に
 * 数えないため)。
 *
 * **plugin由来のhookはsourcesに出てこない**(実測: pluginが実際に動かしたhookが
 * `effective.hooks` にも `sources` にも現れなかった。Claude Codeにプラグインを提供する
 * `genshijin` がSessionStartフックを持つ環境で確認)。そのため、どのsourceにも
 * 見つからなかったグループは `origin: 'unknown'` として扱う。**この一覧はplugin由来の
 * hookを漏らしうる**ことをUI側の注記に明記すること。
 */
const SOURCE_ORIGIN: Record<string, HookOrigin> = {
  userSettings: 'user',
  projectSettings: 'project',
};

interface HookGroup {
  matcher: string | undefined;
  hooks: HookEntryRaw[];
}

interface HookEntryRaw {
  type: string | undefined;
  command: string | undefined;
}

export function readHooksFromSettings(payload: unknown): HookView[] | undefined {
  const body = rec(payload);
  const effective = rec(body?.['effective']);
  const hooksByEvent = rec(effective?.['hooks']);
  if (hooksByEvent === undefined) {
    return undefined;
  }

  const sourcePools = buildSourcePools(body?.['sources']);
  const views: HookView[] = [];

  for (const [eventName, rawGroups] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(rawGroups)) {
      continue;
    }
    let groupIndex = 0;
    for (const rawGroup of rawGroups) {
      const group = asGroup(rawGroup);
      groupIndex += 1;
      if (group === undefined) {
        continue;
      }
      const origin = consumeMatchingOrigin(sourcePools, eventName, group);
      let hookIndex = 0;
      for (const entry of group.hooks) {
        views.push({
          key: `${eventName}:${groupIndex - 1}:${hookIndex}`,
          eventName,
          matcher: group.matcher,
          handlerType: entry.type ?? 'command',
          command: entry.command,
          origin: origin?.origin ?? 'unknown',
          originDetail: origin?.label,
          pluginId: undefined,
          enabled: true,
          trust: 'unsupported',
          trustHash: undefined,
        });
        hookIndex += 1;
      }
    }
  }

  return views;
}

interface SourcePool {
  label: string;
  origin: HookOrigin;
  /** イベント名ごとの、まだ消費していないグループ。 */
  groupsByEvent: Map<string, HookGroup[]>;
}

function buildSourcePools(rawSources: unknown): SourcePool[] {
  const pools: SourcePool[] = [];
  if (!Array.isArray(rawSources)) {
    return pools;
  }
  for (const rawSource of rawSources) {
    const source = rec(rawSource);
    const label = str(source?.['source']);
    const settings = rec(source?.['settings']);
    const hooksByEvent = rec(settings?.['hooks']);
    if (label === '' || hooksByEvent === undefined) {
      continue;
    }
    const groupsByEvent = new Map<string, HookGroup[]>();
    for (const [eventName, rawGroups] of Object.entries(hooksByEvent)) {
      if (!Array.isArray(rawGroups)) {
        continue;
      }
      const groups = rawGroups.map(asGroup).filter((g): g is HookGroup => g !== undefined);
      groupsByEvent.set(eventName, groups);
    }
    pools.push({ label, origin: SOURCE_ORIGIN[label] ?? 'unknown', groupsByEvent });
  }
  return pools;
}

/**
 * `effective` 側の1グループと深い等価のグループをまだ消費していないsourceから探し、
 * 見つかったら1件消費してoriginを返す。見つからなければ `undefined`(pluginなど、
 * sourcesに現れない出どころ)。
 */
function consumeMatchingOrigin(
  pools: SourcePool[],
  eventName: string,
  group: HookGroup,
): { origin: HookOrigin; label: string } | undefined {
  for (const pool of pools) {
    const groups = pool.groupsByEvent.get(eventName);
    if (groups === undefined) {
      continue;
    }
    const index = groups.findIndex((g) => deepEqual(g, group));
    if (index !== -1) {
      groups.splice(index, 1);
      return { origin: pool.origin, label: pool.label };
    }
  }
  return undefined;
}

function asGroup(raw: unknown): HookGroup | undefined {
  const g = rec(raw);
  if (g === undefined) {
    return undefined;
  }
  const rawHooks = g['hooks'];
  if (!Array.isArray(rawHooks)) {
    return undefined;
  }
  const hooks: HookEntryRaw[] = [];
  for (const rawEntry of rawHooks) {
    const entry = rec(rawEntry);
    if (entry === undefined) {
      continue;
    }
    hooks.push({ type: strOrUndefined(entry['type']), command: strOrUndefined(entry['command']) });
  }
  return { matcher: strOrUndefined(g['matcher']), hooks };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
