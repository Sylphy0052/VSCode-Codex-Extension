import type { AppView } from '../provider/plugins';

/**
 * Codexの `app/installed` の応答からapp一覧を組み立てる（issue #32、design.md §14.20）。
 *
 * 実測（codex-cli 0.147.0。この環境で実際にインストール済みのapp（connector）を読んだ。
 * 設定は変更していない）: `{apps: [{id, runtimeName, enabled, callable}]}`。
 *
 * `app/list`（マーケットプレイスのカタログ全体）は `plugin/list` と同じ理由でこの環境では
 * 応答が非常に大きく（未インストールのapp候補まで含む）、導入済みのものだけを一覧する
 * 本issueのスコープでは使わない。
 */
export function parseAppsInstalled(raw: unknown): InstalledAppRef[] {
  const apps = rec(raw)?.['apps'];
  if (!Array.isArray(apps)) {
    return [];
  }

  const result: InstalledAppRef[] = [];
  for (const rawApp of apps) {
    const app = rec(rawApp);
    const id = str(app?.['id']);
    if (app === undefined || id === '') {
      continue;
    }
    result.push({
      id,
      runtimeName: strOrUndefined(app['runtimeName']),
      enabled: app['enabled'] === true,
      callable: app['callable'] === true,
    });
  }
  return result;
}

export interface InstalledAppRef {
  id: string;
  runtimeName: string | undefined;
  enabled: boolean;
  callable: boolean;
}

/**
 * Codexの `app/read` の応答から、appの名前・説明を読む（issue #32）。
 *
 * 実測: `{apps: [{id, name, description, ...}], missingAppIds: []}`。`app/installed` は
 * `runtimeName` しか持たないため（実測で確認）、人が読める説明はこちらで補う。
 */
export function parseAppsRead(
  raw: unknown,
): Map<string, { name: string; description: string | undefined }> {
  const result = new Map<string, { name: string; description: string | undefined }>();
  const apps = rec(raw)?.['apps'];
  if (!Array.isArray(apps)) {
    return result;
  }
  for (const rawApp of apps) {
    const app = rec(rawApp);
    const id = str(app?.['id']);
    const name = str(app?.['name']);
    if (app === undefined || id === '' || name === '') {
      continue;
    }
    result.set(id, { name, description: strOrUndefined(app['description']) });
  }
  return result;
}

/**
 * `app/installed` と `app/read` を突き合わせて画面用の一覧にする。
 *
 * `app/read` が失敗・部分的にしか読めない場合でも、`runtimeName`（`app/installed` にある）
 * を名前の代わりに使い、一覧そのものは失わない。
 */
export function mergeApps(
  installed: InstalledAppRef[],
  details: Map<string, { name: string; description: string | undefined }>,
): AppView[] {
  const apps: AppView[] = installed.map((app) => {
    const detail = details.get(app.id);
    return {
      key: app.id,
      name: detail?.name ?? app.runtimeName ?? app.id,
      description: detail?.description,
      enabled: app.enabled,
      callable: app.callable,
    };
  });
  apps.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return apps;
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
