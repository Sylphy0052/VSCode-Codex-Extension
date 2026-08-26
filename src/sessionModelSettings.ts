import type { ProviderId } from './provider/id';
import type { MementoLike } from './util/memento';

const STORAGE_KEY_PREFIX = 'agent.sessionModelSettings';

export interface SessionModelSettings {
  model: string;
  effort: string;
}

function storageId(provider: ProviderId, sessionId: string): string {
  return `${STORAGE_KEY_PREFIX}.${provider}.${sessionId}`;
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

/** モデルとeffortだけをセッションID別に永続化する。 */
export class SessionModelSettingsStore {
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly latest = new Map<string, SessionModelSettings>();

  constructor(private readonly memento: MementoLike) {}

  get(provider: ProviderId, sessionId: string): SessionModelSettings | undefined {
    const key = storageId(provider, sessionId);
    const cached = this.latest.get(key);
    if (cached !== undefined) {
      return { ...cached };
    }
    const stored = readSettings(this.memento.get<unknown>(key, undefined));
    if (stored !== undefined) {
      this.latest.set(key, stored);
      return { ...stored };
    }
    return undefined;
  }

  async set(
    provider: ProviderId,
    sessionId: string,
    settings: SessionModelSettings,
  ): Promise<void> {
    const key = storageId(provider, sessionId);
    const value = { ...settings };
    // Mementoへの書込み完了前に同じセッションを開き直しても、最新値を返す。
    this.latest.set(key, value);
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const next = previous
      // 1回の保存失敗で、その後の変更まで永久に止めない。
      .catch(() => undefined)
      .then(() => this.memento.update(key, value));
    this.pendingWrites.set(key, next);
    try {
      await next;
    } finally {
      if (this.pendingWrites.get(key) === next) {
        this.pendingWrites.delete(key);
      }
    }
  }

  /** セッション本体を削除したときに、対応する保存値も破棄する。 */
  async delete(provider: ProviderId, sessionId: string): Promise<void> {
    const key = storageId(provider, sessionId);
    this.latest.delete(key);
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.memento.update(key, undefined));
    this.pendingWrites.set(key, next);
    try {
      await next;
    } finally {
      if (this.pendingWrites.get(key) === next) {
        this.pendingWrites.delete(key);
      }
    }
  }
}
