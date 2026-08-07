import {
  buildActivityRecord,
  bufferFileName,
  serializeActivityRecord,
  type ActivitySource,
} from './record';

/** 追記の抽象。実体は node:fs（ディレクトリ作成込み）、テストではインメモリ。 */
export interface ActivityAppendPort {
  append(filePath: string, line: string): Promise<void>;
}

/** 記録済みセッションの記憶。実体は globalState。 */
export interface LoggedSessionsPort {
  has(sessionId: string): boolean;
  /** `day` は YYYY-MM-DD。掃除の基準に使う。 */
  add(sessionId: string, day: string): void;
  /** `oldestKept` より前の日付のエントリを落とす。 */
  prune(oldestKept: string): void;
}

export interface ActivityLogSettings {
  enabled: boolean;
  /** バッファの出力先ディレクトリ。解決済みの絶対パス。 */
  dir: string;
}

export interface ClockPort {
  now(): Date;
  timeZoneOffsetMinutes(): number;
}

export interface RecordRequest {
  /** 重複抑止のキー。プロバイダを跨いで一意（UUID）。 */
  sessionId: string;
  source: ActivitySource;
  cwd: string;
  /** セッションの1行要約。空なら記録しない（後の契機で書き直せる）。 */
  text: string;
}

export const nodeClock: ClockPort = {
  now: () => new Date(),
  timeZoneOffsetMinutes: () => new Date().getTimezoneOffset(),
};

/**
 * 拡張機能から実行したセッションを日報バッファへ1行だけ記録する。
 *
 * 記録は会話の成否に影響してはならないため、失敗しても例外を投げず、
 * 既記録にもしない（次の契機で書き直せるようにする）。
 */
export class ActivityLogger {
  constructor(
    private readonly appender: ActivityAppendPort,
    private readonly logged: LoggedSessionsPort,
    private readonly settings: () => ActivityLogSettings,
    private readonly clock: ClockPort,
  ) {}

  async record(request: RecordRequest): Promise<void> {
    const settings = this.settings();
    if (!settings.enabled || this.logged.has(request.sessionId)) {
      return;
    }

    const now = this.clock.now();
    const offset = this.clock.timeZoneOffsetMinutes();
    const record = buildActivityRecord({
      now,
      timeZoneOffsetMinutes: offset,
      source: request.source,
      cwd: request.cwd,
      text: request.text,
    });
    if (record === undefined) {
      return;
    }

    const fileName = bufferFileName(now, offset);
    try {
      await this.appender.append(`${settings.dir}/${fileName}`, serializeActivityRecord(record));
    } catch {
      // 追記できないこと自体は会話の妨げにならない。次の契機に委ねる
      return;
    }
    this.logged.add(request.sessionId, fileName.replace('.jsonl', ''));
  }
}

const RETENTION_DAYS = 30;

export class InMemoryLoggedSessions implements LoggedSessionsPort {
  private readonly map = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) {
      this.map.set(k, v);
    }
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  add(sessionId: string, day: string): void {
    this.map.set(sessionId, day);
  }

  prune(oldestKept: string): void {
    for (const [id, day] of this.map) {
      if (day < oldestKept) {
        this.map.delete(id);
      }
    }
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/** 保持期間の下限日（YYYY-MM-DD）。これより前のエントリは掃除してよい。 */
export function retentionCutoff(now: Date): string {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * バッファの出力先。設定 > `DAILY_BUFFER_DIR` > `~/workspace/dairy/.buffer` の順。
 * 既定値は日報の収集スクリプト（collect.py）が既定で見る場所と同じ。
 */
export function resolveBufferDir(
  configured: string,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  const trimmed = configured.trim();
  if (trimmed !== '') {
    return trimmed;
  }
  const fromEnv = env['DAILY_BUFFER_DIR'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return `${homedir}/workspace/dairy/.buffer`;
}
