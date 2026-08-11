import { isValidHookKey, type HookOrigin, type HookTrustState, type HookView } from '../provider/hooks';

/**
 * Codexの `hooks/list` の応答からhooks一覧を組み立てる。
 *
 * 実測(codex-cli 0.147.0。`hooks/list` を呼ぶと `{data:[{cwd,hooks:[],warnings:[],errors:[]}]}` が
 * 返ることを確認済み。この環境にはhookが1件も設定されていないため、`hooks` 配列の中身は
 * スキーマ(`codex app-server generate-json-schema --out` の `HooksListResponse`)が根拠)。
 *
 * `HookMetadata` の主なフィールド:
 * - `key`: 一意なキー。信頼状態を書き戻す(`config/batchWrite`)ときに使う
 * - `eventName` / `matcher` / `handlerType` / `command`: どのイベントで何を実行するか
 * - `source`: `system` `user` `project` `mdm` `sessionFlags` `plugin` `cloudRequirements`
 *   `cloudManagedConfig` `legacyManagedConfigFile` `legacyManagedConfigMdm` `unknown` の10種
 * - `sourcePath`: 定義元のファイルパス。**プロジェクト内で定義されたhookかどうかを
 *   一目で判断する材料になる**(design.md §8の脅威モデルと同じ考え方)
 * - `trustStatus`: `managed` `untrusted` `trusted` `modified`
 * - `currentHash`: 信頼を書き戻すときに添える値(`setHookTrusted` を参照)
 *
 * `cwds` を複数渡した場合、応答は `cwd` ごとの `HooksListEntry` に分かれて返る。同じhookが
 * 複数のcwdに現れることは無い想定だが、念のため `key` で重複排除する。
 */
export function parseHooksList(raw: unknown): { hooks: HookView[]; warnings: string[] } {
  const data = rec(raw)?.['data'];
  if (!Array.isArray(data)) {
    return { hooks: [], warnings: [] };
  }

  const hooks: HookView[] = [];
  const warnings: string[] = [];
  const seenKeys = new Set<string>();

  for (const rawEntry of data) {
    const entry = rec(rawEntry);
    if (entry === undefined) {
      continue;
    }

    for (const w of arrayOf(entry['warnings'])) {
      const text = str(w);
      if (text !== '') {
        warnings.push(text);
      }
    }
    for (const rawError of arrayOf(entry['errors'])) {
      const error = rec(rawError);
      const message = str(error?.['message']);
      if (message === '') {
        continue;
      }
      const path = str(error?.['path']);
      warnings.push(path === '' ? message : `${message} (${path})`);
    }

    for (const rawHook of arrayOf(entry['hooks'])) {
      const hook = parseHookMetadata(rawHook);
      if (hook === undefined || seenKeys.has(hook.key)) {
        continue;
      }
      seenKeys.add(hook.key);
      hooks.push(hook);
    }
  }

  hooks.sort((a, b) => a.eventName.localeCompare(b.eventName) || a.key.localeCompare(b.key));
  return { hooks, warnings };
}

const KNOWN_ORIGINS: readonly HookOrigin[] = [
  'system',
  'user',
  'project',
  'mdm',
  'sessionFlags',
  'plugin',
  'cloudRequirements',
  'cloudManagedConfig',
  'legacyManagedConfigFile',
  'legacyManagedConfigMdm',
  'unknown',
];

const KNOWN_TRUST_STATES: readonly HookTrustState[] = ['managed', 'untrusted', 'trusted', 'modified'];

function parseHookMetadata(rawHook: unknown): HookView | undefined {
  const hook = rec(rawHook);
  const key = str(hook?.['key']);
  if (hook === undefined || key === '') {
    return undefined;
  }

  return {
    key,
    eventName: str(hook['eventName']),
    matcher: strOrUndefined(hook['matcher']),
    handlerType: str(hook['handlerType']) || 'command',
    command: strOrUndefined(hook['command']),
    origin: asOrigin(hook['source']),
    originDetail: strOrUndefined(hook['sourcePath']),
    pluginId: strOrUndefined(hook['pluginId']),
    enabled: hook['enabled'] === true,
    trust: asTrustState(hook['trustStatus']),
    trustHash: strOrUndefined(hook['currentHash']),
  };
}

function asOrigin(value: unknown): HookOrigin {
  const s = str(value);
  return (KNOWN_ORIGINS as readonly string[]).includes(s) ? (s as HookOrigin) : 'unknown';
}

function asTrustState(value: unknown): HookTrustState {
  const s = str(value);
  return (KNOWN_TRUST_STATES as readonly string[]).includes(s)
    ? (s as HookTrustState)
    : 'untrusted';
}

/**
 * hookの信頼を書き込む `config/batchWrite` の1件を組み立てる。
 *
 * **根拠は実行ファイル(`codex`、0.147.0)の文字列調査(strings)のみ**で、実際に書き込んで
 * 確認してはいない(この環境の `~/.codex/config.toml` を書き換えない方針のため)。
 * バイナリには次の文字列が連続して存在する:
 *
 * ```text
 * hooks.state."
 * ".trusted_hash
 * failed to write hook trust:
 * ```
 *
 * これは `hooks.state."<key>".trusted_hash` というkeyPathの組み立てに一致する
 * (`ConfigBatchWriteParams` のスキーマも、`edits[].keyPath` が任意の文字列であることは
 * 裏付けるが、hook信頼専用のkeyPathまでは規定していない)。実測ではなく**strings由来の
 * 推定**であることをコード上に明記する。
 *
 * `key` は `isValidHookKey` を満たすことを呼び出し側が確認してから渡すこと
 * (満たさない場合は例外を投げる。TOMLのキー構造を壊しうる値をそのまま埋め込まないため)。
 */
export function buildHookTrustEdit(
  key: string,
  currentHash: string,
): { keyPath: string; mergeStrategy: 'upsert'; value: string } {
  if (!isValidHookKey(key)) {
    throw new Error(`不正なhookのkeyです: ${key}`);
  }
  return {
    keyPath: `hooks.state."${key}".trusted_hash`,
    mergeStrategy: 'upsert',
    value: currentHash,
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
