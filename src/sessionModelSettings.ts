import { join } from 'node:path';
import type { ProviderId } from './provider/id';
import { KeyedStateFile } from './util/keyedStateFile';
import type { MementoLike } from './util/memento';

/** 旧globalStateのキー接頭辞（Issue #2006で廃止。移行のためだけに残す）。 */
const LEGACY_KEY_PREFIX = 'agent.sessionModelSettings';

/** 保存する件数の上限。超えたら最後に書いた時刻の古いものから捨てる。 */
export const SESSION_MODEL_SETTINGS_MAX_ENTRIES = 5_000;

const FILE_NAME = 'session-model-settings.json';

/** モデル設定ファイルの置き場所。`context.globalStorageUri`配下（ウィンドウ間で配信されない、Issue #2006）。 */
export function sessionModelSettingsFilePath(globalStorageDir: string): string {
  return join(globalStorageDir, FILE_NAME);
}

export interface SessionModelSettings {
  model: string;
  effort: string;
}

function storageId(provider: ProviderId, sessionId: string): string {
  return `${provider}.${sessionId}`;
}

function readSettings(value: unknown): SessionModelSettings | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['model'] !== 'string' || typeof record['effort'] !== 'string') {
    return undefined;
  }
  return { model: record['model'], effort: record['effort'] };
}

/**
 * 旧globalStateの`agent.sessionModelSettings.*`を持つMemento。`keys()`が無いMementoでは移行しない。
 */
export type LegacySettingsMemento = MementoLike & { keys?(): readonly string[] };

/**
 * モデルとeffortだけをセッションID別に永続化する。
 *
 * 保存先は`globalStorageUri`配下の1ファイル（Issue #2006）。`filePath`が`undefined`なら
 * メモリ上にだけ持つ（テスト等）。旧globalStateのキーは起動を止めずに移行し、ファイルへ
 * 書けたことを確かめてから消す。
 */
export class SessionModelSettingsStore {
  private readonly file: KeyedStateFile<SessionModelSettings>;

  constructor(filePath?: string, legacy?: LegacySettingsMemento) {
    this.file = new KeyedStateFile(filePath, readSettings, SESSION_MODEL_SETTINGS_MAX_ENTRIES);
    if (filePath !== undefined && legacy !== undefined) {
      void this.migrateLegacy(legacy).catch(() => undefined);
    }
  }

  get(provider: ProviderId, sessionId: string): SessionModelSettings | undefined {
    const stored = this.file.get(storageId(provider, sessionId));
    return stored === undefined ? undefined : { ...stored };
  }

  async set(
    provider: ProviderId,
    sessionId: string,
    settings: SessionModelSettings,
  ): Promise<void> {
    await this.file.set(storageId(provider, sessionId), { ...settings });
  }

  /** セッション本体を削除したときに、対応する保存値も破棄する。 */
  async delete(provider: ProviderId, sessionId: string): Promise<void> {
    await this.file.delete(storageId(provider, sessionId));
  }

  /** 旧キーをファイルへ移し、書けたら旧キーを消す。旧キーが残る限り起動のたびに呼ばれる。 */
  private async migrateLegacy(legacy: LegacySettingsMemento): Promise<void> {
    const prefix = `${LEGACY_KEY_PREFIX}.`;
    const legacyKeys = (legacy.keys?.() ?? []).filter((key) => key.startsWith(prefix));
    if (legacyKeys.length === 0) {
      return;
    }
    const items: [string, SessionModelSettings][] = [];
    for (const key of legacyKeys) {
      const settings = readSettings(legacy.get<unknown>(key, undefined));
      if (settings !== undefined) {
        items.push([key.slice(prefix.length), settings]);
      }
    }
    await this.file.importMissing(items);
    // 並列に投げて、globalStateの書出しを1回にまとめさせる
    await Promise.all(legacyKeys.map((key) => legacy.update(key, undefined)));
  }
}
