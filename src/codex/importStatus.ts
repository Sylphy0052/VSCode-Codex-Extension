import {
  isKnownImportItemType,
  labelForImportItemType,
  type ImportHistoryEntryView,
  type ImportHistoryItemTypeResultView,
  type ImportItemDetailGroup,
  type ImportItemView,
  type ImportRunItemResult,
} from '../provider/import';

/**
 * 他エージェントからの設定インポート（issue #36、design.md TP-57）。
 *
 * 実測（codex-cli 0.147.0。このリポジトリで `codex app-server` を起動して呼び出し、実際の
 * 応答を確認した。読み取り専用の要求は実際の環境に対して送った）と `codex app-server
 * generate-json-schema --out` のスキーマが根拠。**実行系（`externalAgentConfig/import`）は
 * issue #146で別途、`CODEX_HOME` と `$HOME` の両方を隔離した環境に対して実行し確認済み**
 * （後述、および `appServerClient.ts` の `runImport` / design.md §14.30参照）。
 *
 * - `externalAgentConfig/detect`（`{cwds?, includeHome?, maxSessionAgeDays?, maxSessions?,
 *   migrationSource?}` → `{items: [ExternalAgentConfigMigrationItem], connectors: [...]}`）。
 *   実測: `includeHome` を渡さない既定の呼び出しでは `items: []`（**何も検出しない**）。
 *   `includeHome: true` を渡すと、この環境の実際の `~/.claude` から `CONFIG` / `HOOKS` /
 *   `SKILLS` / `PLUGINS` / `SESSIONS` の5種別が検出できた（`MCP_SERVER_CONFIG` /
 *   `SUBAGENTS` / `COMMANDS` / `MEMORY` / `AGENTS_MD` はこの環境に対象が無く未確認）。
 * - `migrationSource` は自由文字列（スキーマにenumは無い）。実測: 省略時・`'claude-code'`
 *   指定時のどちらも同じ結果（Claude Codeが既定のソース）。`'cursor'` を指定すると空
 *   （この環境にCursorの設定が無いため）。未知の値（`'bogus-nonexistent'`）を渡しても
 *   エラーにならず既定のソースにフォールバックした（スキーマの説明文と一致）。
 *   バイナリの文字列調査（`strings`）でも `external-agent-migration/src/source_cla.rs`
 *   （Claude Code）と `source_cur.rs`（Cursor）の2つのソース実装が確認できる。
 *   本issueのスコープはissue本文の通りClaude Codeのみのため、`migrationSource` は指定せず
 *   既定に委ねる（Cursorの選択UIはスコープ外）。
 * - `ExternalAgentConfigMigrationItem` は `{cwd, description, details, itemType}`。
 *   `details`（`MigrationDetails`）は `commands` / `hooks` / `mcpServers` / `memory`
 *   （文字列配列。他と違い名前ではなく内容そのもの）/ `plugins`
 *   （`{marketplaceName, pluginNames}`） / `sessions`（`{cwd, path, title}`） / `skills` /
 *   `subagents` を持つ。
 * - `externalAgentConfig/import`（`{migrationItems: [...], migrationSource?, providerId?,
 *   source?}` → `{importId}`）。`migrationItems` は `detect` が返した項目を**そのまま**
 *   送り返す形（スキーマの型が一致）。この拡張はdetectで受け取った生のJSONをキーで
 *   キャッシュしておき、選ばれた項目だけをそのまま再送する（`appServerClient.ts` の
 *   `detectImportCandidates` / `runImport` 参照）。**issue #146で実測して確認済み**:
 *   隔離環境で `HOOKS` / `SKILLS` の項目をそれぞれ単独で送り、選んだ項目だけが実行される
 *   （部分選択が実際に効く）ことを確認した。
 * - `externalAgentConfig/import/progress` と `externalAgentConfig/import/completed`
 *   （通知。`{importId, itemTypeResults: [{itemType, successes, failures}]}`）は**実測済み**
 *   （issue #146）。Phase 0で確認されたバイナリのUI文言（「Import started. You can keep
 *   working while it finishes.」）どおり非同期に進み、実測では要求送信から数十ミリ秒以内に
 *   `progress`・`completed` の順で届いた。`completed` 通知を待って結果を確定する
 *   （`appServerClient.ts` 参照）。
 * - `externalAgentConfig/import/readHistories`（params: `null` → `{data: [...],
 *   connectors: [...]}`）は実測。この環境は過去のインポート実行が無いため `data: []`。
 *   `ExternalAgentConfigImportHistory` は `{completedAtMs, failures, importId, providerId,
 *   successes}`。
 * - `externalAgentConfig/import/recordHistory` は「拡張機能の外（TUI等）で完了したインポートの
 *   結果をapp-serverの履歴へ後から記録する」ためのメソッド（スキーマの説明）。この拡張は
 *   常に自分自身の `externalAgentConfig/import` 経由で実行するため、対応する項目は自然に
 *   同じapp-serverの履歴へ記録される想定であり、別途呼ぶ必要が無い（**issue #146で実測して
 *   確認済み**: `import` 実行直後に `readHistories` を呼ぶと、`recordHistory` を別途呼ばずとも
 *   今回の実行が履歴に現れた）。使わない。
 * - `connectors`（`ExternalAgentDetectedConnectorCandidate`。リモートMCPサーバー由来の候補）は
 *   この環境では常に空配列だった。itemTypeとは別のUI概念で、受入基準（取り込む対象を
 *   種別で選べる）にも直接関係しないため本issueのスコープ外とする。
 */

const MAX_DETAIL_SAMPLES = 8;
/** 履歴の失敗理由を一覧に出す上限。大量の失敗で画面が埋まらないようにする。 */
const MAX_FAILURE_MESSAGES = 5;

export function buildImportItemKey(itemType: string, cwd: string | null | undefined): string {
  return `${itemType}:${cwd ?? ''}`;
}

export function parseDetectResponse(raw: unknown): {
  items: ImportItemView[];
  /** `externalAgentConfig/import` へそのまま再送するための、キーごとの生の項目。 */
  rawByKey: Map<string, unknown>;
} {
  const items = arrayOf(rec(raw)?.['items']);
  const views: ImportItemView[] = [];
  const rawByKey = new Map<string, unknown>();

  for (const rawItem of items) {
    const item = rec(rawItem);
    const itemTypeRaw = str(item?.['itemType']);
    const description = str(item?.['description']);
    if (item === undefined || itemTypeRaw === '') {
      continue;
    }
    const cwd = strOrUndefined(item['cwd']);
    const key = buildImportItemKey(itemTypeRaw, cwd);
    // 同じ種別・同じcwdの項目が重複して返ることは想定していないが、
    // 起きても後勝ちにせず最初の1件を採用する（一覧の見え方を安定させる）
    if (rawByKey.has(key)) {
      continue;
    }
    rawByKey.set(key, rawItem);

    views.push({
      key,
      itemType: isKnownImportItemType(itemTypeRaw) ? itemTypeRaw : 'UNKNOWN',
      label: labelForImportItemType(itemTypeRaw),
      description,
      scope: cwd === undefined ? 'home' : 'project',
      cwd,
      details: describeDetails(item['details']),
    });
  }

  return { items: views, rawByKey };
}

/** `MigrationDetails` を表示用のグループへ要約する。 */
function describeDetails(rawDetails: unknown): ImportItemDetailGroup[] {
  const details = rec(rawDetails);
  if (details === undefined) {
    return [];
  }

  const groups: ImportItemDetailGroup[] = [];

  const pushNamed = (
    kind: ImportItemDetailGroup['kind'],
    entries: unknown[],
    nameOf: (entry: Record<string, unknown>) => string | undefined,
  ): void => {
    if (entries.length === 0) {
      return;
    }
    const names: string[] = [];
    for (const entry of entries) {
      const record = rec(entry);
      const name = record === undefined ? undefined : nameOf(record);
      if (name !== undefined && name !== '') {
        names.push(name);
      }
    }
    groups.push({
      kind,
      count: entries.length,
      sampleNames: names.slice(0, MAX_DETAIL_SAMPLES),
      moreCount: Math.max(0, names.length - MAX_DETAIL_SAMPLES),
    });
  };

  pushNamed('skills', arrayOf(details['skills']), (e) => strOrUndefined(e['name']));
  pushNamed('hooks', arrayOf(details['hooks']), (e) => strOrUndefined(e['name']));
  pushNamed('mcpServers', arrayOf(details['mcpServers']), (e) => strOrUndefined(e['name']));
  pushNamed('subagents', arrayOf(details['subagents']), (e) => strOrUndefined(e['name']));
  pushNamed('commands', arrayOf(details['commands']), (e) => strOrUndefined(e['name']));

  const plugins = arrayOf(details['plugins']);
  if (plugins.length > 0) {
    const names: string[] = [];
    for (const rawPlugin of plugins) {
      const plugin = rec(rawPlugin);
      const marketplaceName = str(plugin?.['marketplaceName']);
      for (const pluginName of arrayOf(plugin?.['pluginNames'])) {
        if (typeof pluginName === 'string' && pluginName !== '') {
          names.push(marketplaceName === '' ? pluginName : `${pluginName}@${marketplaceName}`);
        }
      }
    }
    groups.push({
      kind: 'plugins',
      count: names.length,
      sampleNames: names.slice(0, MAX_DETAIL_SAMPLES),
      moreCount: Math.max(0, names.length - MAX_DETAIL_SAMPLES),
    });
  }

  const sessions = arrayOf(details['sessions']);
  if (sessions.length > 0) {
    const titles: string[] = [];
    for (const rawSession of sessions) {
      const session = rec(rawSession);
      const title = strOrUndefined(session?.['title']) ?? strOrUndefined(session?.['cwd']);
      if (title !== undefined) {
        titles.push(title);
      }
    }
    groups.push({
      kind: 'sessions',
      count: sessions.length,
      sampleNames: titles.slice(0, MAX_DETAIL_SAMPLES),
      moreCount: Math.max(0, titles.length - MAX_DETAIL_SAMPLES),
    });
  }

  // memoryは実際の中身（文字列そのもの）が入る。会話本文と同じ扱いで内容は出さず件数のみ
  // （design.md §8「セッション本文の漏洩」と同じ考え方）
  const memory = arrayOf(details['memory']);
  if (memory.length > 0) {
    groups.push({ kind: 'memory', count: memory.length, sampleNames: [], moreCount: 0 });
  }

  return groups;
}

export function parseReadHistoriesResponse(raw: unknown): ImportHistoryEntryView[] {
  const data = arrayOf(rec(raw)?.['data']);
  const entries: ImportHistoryEntryView[] = [];

  for (const rawEntry of data) {
    const entry = rec(rawEntry);
    const importId = str(entry?.['importId']);
    if (entry === undefined || importId === '') {
      continue;
    }
    const completedAtMs = typeof entry['completedAtMs'] === 'number' ? entry['completedAtMs'] : 0;
    entries.push({
      importId,
      completedAtMs,
      providerId: strOrUndefined(entry['providerId']),
      results: groupItemTypeResults(arrayOf(entry['successes']), arrayOf(entry['failures'])),
    });
  }

  // 新しい実行を先に出す
  entries.sort((a, b) => b.completedAtMs - a.completedAtMs);
  return entries;
}

export function parseImportResponse(raw: unknown): string | undefined {
  return strOrUndefined(rec(raw)?.['importId']);
}

/**
 * `externalAgentConfig/import/progress` と `externalAgentConfig/import/completed` は
 * どちらも同じ形（`{importId, itemTypeResults}`）。呼び出し側がどちらの通知かをmethod名で
 * 判別する。
 */
export function parseImportNotification(
  raw: unknown,
): { importId: string; results: ImportRunItemResult[] } | undefined {
  const body = rec(raw);
  const importId = str(body?.['importId']);
  if (body === undefined || importId === '') {
    return undefined;
  }
  const itemTypeResults = arrayOf(body['itemTypeResults']);
  const results: ImportRunItemResult[] = [];
  for (const rawResult of itemTypeResults) {
    const result = rec(rawResult);
    const itemTypeRaw = str(result?.['itemType']);
    if (result === undefined || itemTypeRaw === '') {
      continue;
    }
    const successes = arrayOf(result['successes']);
    const failures = arrayOf(result['failures']);
    results.push({
      itemType: isKnownImportItemType(itemTypeRaw) ? itemTypeRaw : 'UNKNOWN',
      label: labelForImportItemType(itemTypeRaw),
      successCount: successes.length,
      failureCount: failures.length,
      failureMessages: failureMessagesOf(failures),
    });
  }
  return { importId, results };
}

function groupItemTypeResults(
  successes: unknown[],
  failures: unknown[],
): ImportHistoryItemTypeResultView[] {
  const byType = new Map<string, { successCount: number; failures: unknown[] }>();

  for (const rawSuccess of successes) {
    const itemTypeRaw = str(rec(rawSuccess)?.['itemType']);
    if (itemTypeRaw === '') {
      continue;
    }
    const entry = byType.get(itemTypeRaw) ?? { successCount: 0, failures: [] };
    entry.successCount += 1;
    byType.set(itemTypeRaw, entry);
  }
  for (const rawFailure of failures) {
    const itemTypeRaw = str(rec(rawFailure)?.['itemType']);
    if (itemTypeRaw === '') {
      continue;
    }
    const entry = byType.get(itemTypeRaw) ?? { successCount: 0, failures: [] };
    entry.failures.push(rawFailure);
    byType.set(itemTypeRaw, entry);
  }

  return Array.from(byType.entries()).map(([itemTypeRaw, entry]) => ({
    itemType: isKnownImportItemType(itemTypeRaw) ? itemTypeRaw : 'UNKNOWN',
    label: labelForImportItemType(itemTypeRaw),
    successCount: entry.successCount,
    failureCount: entry.failures.length,
    failureMessages: failureMessagesOf(entry.failures),
  }));
}

function failureMessagesOf(failures: unknown[]): string[] {
  const messages: string[] = [];
  for (const rawFailure of failures) {
    const message = str(rec(rawFailure)?.['message']);
    if (message !== '') {
      messages.push(message);
    }
  }
  return messages.slice(0, MAX_FAILURE_MESSAGES);
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
