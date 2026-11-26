import * as vscode from 'vscode';
import type { McPrefs, McSavedFilter } from '../webview/missionControl/protocol';
import { readMcPrefs, readSavedFilters, type McPrefChange } from './missionControlPrefs';

/** 名前を付けた絞り込みの置き場所（globalState。全ウィンドウ共通）。 */
const SAVED_FILTERS_KEY = 'agent.missionControl.savedFilters';

/**
 * Mission Controlの設定の変更と絞り込みの保存（Issue #2162）。値の検証は
 * `missionControlPrefs.ts`で済ませてから呼ぶ。
 */
export interface McSettingsPort {
  prefs(): McPrefs;
  /** 失敗したら理由の文、成功なら`undefined`。 */
  setPref(change: McPrefChange): Promise<string | undefined>;
  savedFilters(): McSavedFilter[];
  writeSavedFilters(filters: readonly McSavedFilter[]): Promise<void>;
}

export function createMcSettingsPort(globalState: vscode.Memento): McSettingsPort {
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('agent');
  return {
    prefs: () => readMcPrefs((key) => config().get<unknown>(key)),
    async setPref(change) {
      const c = config();
      // ワークスペースの設定があればそちらが効くので、そちらを書き換える（ユーザー設定へ
      // 書いても画面の値が変わらず、反映されないように見えるため）
      const inspected = c.inspect(change.key);
      const target =
        inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      try {
        await c.update(change.key, change.value, target);
      } catch (e: unknown) {
        return `設定を変えられませんでした: ${e instanceof Error ? e.message : String(e)}`;
      }
      return undefined;
    },
    savedFilters: () => readSavedFilters(globalState.get<unknown>(SAVED_FILTERS_KEY)),
    async writeSavedFilters(filters) {
      await globalState.update(SAVED_FILTERS_KEY, filters);
    },
  };
}
