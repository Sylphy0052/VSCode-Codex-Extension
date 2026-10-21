import { join } from 'node:path';
import type { ProviderId } from './provider/id';
import { KeyedStateFile } from './util/keyedStateFile';
import type { MementoLike } from './util/memento';

/** 旧globalStateのキー接頭辞（Issue #2006で廃止。移行のためだけに残す）。 */
const LEGACY_KEY_PREFIX = 'agent.sessionModelSettings';

/** 保存する件数の上限。超えたら最後に使った（書いた・1日以上ぶりに読んだ）時刻の古いものから捨てる。 */
export const SESSION_MODEL_SETTINGS_MAX_ENTRIES = 10_000;

const FILE_NAME = 'session-model-settings.json';

/** モデル設定ファイルの置き場所。`context.globalStorageUri`配下（ウィンドウ間で配信されない、Issue #2006）。 */
export function sessionModelSettingsFilePath(globalStorageDir: string): string {
  return join(globalStorageDir, FILE_NAME);
}

export interface SessionModelSettings {
  model: string;
  effort: string;
}

function legacyKey(provider: ProviderId, sessionId: string): string {
  return `${LEGACY_KEY_PREFIX}.${provider}.${sessionId}`;
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
  private readonly legacy: LegacySettingsMemento | undefined;
  /** 旧キーの移行。deleteはこれを待ってから行う（移行前に消すと、他ウィンドウが旧キーから読み戻せる）。 */
  private readonly migration: Promise<void>;

  constructor(
    filePath?: string,
    legacy?: LegacySettingsMemento,
    /** 旧キーの移行に失敗したとき呼ぶ。旧キーは残り、次回起動でやり直す。 */
    onMigrationError: (error: unknown) => void = () => undefined,
  ) {
    this.file = new KeyedStateFile(filePath, readSettings, SESSION_MODEL_SETTINGS_MAX_ENTRIES);
    this.legacy = filePath === undefined ? undefined : legacy;
    this.migration =
      filePath !== undefined && legacy !== undefined
        ? this.migrateLegacy(legacy).catch(onMigrationError)
        : Promise.resolve();
  }

  get(provider: ProviderId, sessionId: string): SessionModelSettings | undefined {
    // ファイルに無く、どのウィンドウでもまだ移行が済んでいなければ旧キーを見る
    // （移行済みなら、旧キーの値はファイルへ移っている。消された値を旧キーから読み戻さない）
    const stored =
      this.file.get(storageId(provider, sessionId)) ??
      (this.file.isMigrated()
        ? undefined
        : readSettings(this.legacy?.get<unknown>(legacyKey(provider, sessionId), undefined)));
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
    await this.migration;
    await this.file.delete(storageId(provider, sessionId));
    // 旧キーが残っていると、getの読み替えで消したはずの値が戻る
    if (this.legacy?.get<unknown>(legacyKey(provider, sessionId), undefined) !== undefined) {
      await this.legacy.update(legacyKey(provider, sessionId), undefined);
    }
  }

  /** 旧キーをファイルへ移し、書けたら旧キーを消す。旧キーが残る限り起動のたびに呼ばれる。 */
  private async migrateLegacy(legacy: LegacySettingsMemento): Promise<void> {
    const prefix = `${LEGACY_KEY_PREFIX}.`;
    const legacyKeys = (): string[] =>
      (legacy.keys?.() ?? []).filter((key) => key.startsWith(prefix));
    const initialKeys = legacyKeys();
    if (initialKeys.length === 0) {
      return;
    }
    let migratedKeys: string[] = initialKeys;
    await this.file.importMissing(() => {
      migratedKeys = legacyKeys();
      const items: [string, SessionModelSettings][] = [];
      for (const key of migratedKeys) {
        const settings = readSettings(legacy.get<unknown>(key, undefined));
        if (settings !== undefined) {
          items.push([key.slice(prefix.length), settings]);
        }
      }
      return items;
    });
    // 並列に投げて、globalStateの書出しを1回にまとめさせる
    await Promise.all(migratedKeys.map((key) => legacy.update(key, undefined)));
  }
}
