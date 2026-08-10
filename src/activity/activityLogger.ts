import {
  buildActivityRecord,
  bufferFileName,
  serializeActivityRecord,
  type ActivityKind,
  type ActivitySource,
} from './record';

/** 追記の抽象。実体は node:fs（ディレクトリ作成込み）、テストではインメモリ。 */
export interface ActivityAppendPort {
  append(filePath: string, line: string): Promise<void>;
}

/** キーごとに直前記録した本文を1件だけ覚える。実体は globalState。 */
export interface LoggedSessionsPort {
  /** 直前にこのキーへ記録した本文（無ければ undefined）。同期経路の重複抑止に使う。 */
  lastText(key: string): string | undefined;
  /** `day` は YYYY-MM-DD。掃除の基準に使う。 */
  remember(key: string, text: string, day: string): void;
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
  /** セッションを一意に識別するid（Codex: thread id、Claude: session id）。 */
  sessionId: string;
  source: ActivitySource;
  cwd: string;
  kind: ActivityKind;
  /**
   * `kind: 'prompt'` はユーザー発言そのもの。
   * `kind: 'result'` はアシスタントの最終応答テキスト（1行化・切り詰めは呼び出し側で行わない）。
   * 空なら記録しない（後の契機で書き直せる）。
   */
  text: string;
  /** `kind: 'result'` のときだけ使う。そのターンで編集したファイルパス。 */
  editedFiles?: readonly string[];
  /**
   * 同じ内容の再記録を抑止するか。
   *
   * syncTabNames / syncClaudeActivity のように、同じセッションについて何度も同じ要約を
   * 書きうる同期経路だけ true にする。ユーザーの実発言（送信のたび）は常に false（毎回記録する）。
   */
  suppressDuplicates?: boolean;
}

export const nodeClock: ClockPort = {
  now: () => new Date(),
  timeZoneOffsetMinutes: () => new Date().getTimezoneOffset(),
};

/**
 * 拡張機能から実行したセッションの発言・成果を日報バッファへ記録する。
 *
 * `kind: 'prompt'` は送信のたびに毎回記録する（セッション初回だけに絞る抑止は無い）。
 * `suppressDuplicates: true` を渡した要求（同期経路）だけ、直前と同じ本文なら書かない。
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
    if (!settings.enabled) {
      return;
    }

    const now = this.clock.now();
    const offset = this.clock.timeZoneOffsetMinutes();
    const record = buildActivityRecord({
      now,
      timeZoneOffsetMinutes: offset,
      source: request.source,
      cwd: request.cwd,
      sessionId: request.sessionId,
      kind: request.kind,
      text: request.text,
      ...(request.editedFiles === undefined ? {} : { editedFiles: request.editedFiles }),
    });
    if (record === undefined) {
      return;
    }

    const dedupeKey = `${request.sessionId}:${request.kind}`;
    if (request.suppressDuplicates === true && this.logged.lastText(dedupeKey) === record.text) {
      return;
    }

    const fileName = bufferFileName(now, offset);
    try {
      await this.appender.append(`${settings.dir}/${fileName}`, serializeActivityRecord(record));
    } catch {
      // 追記できないこと自体は会話の妨げにならない。次の契機に委ねる
      return;
    }
    if (request.suppressDuplicates === true) {
      this.logged.remember(dedupeKey, record.text, fileName.replace('.jsonl', ''));
    }
  }
}

const RETENTION_DAYS = 30;

/** キー1件分の記憶。`day` は掃除の基準、`text` は重複判定に使う。 */
export interface LoggedEntry {
  day: string;
  text: string;
}

export class InMemoryLoggedSessions implements LoggedSessionsPort {
  private readonly map = new Map<string, LoggedEntry>();

  constructor(initial: Record<string, LoggedEntry> = {}) {
    for (const [k, v] of Object.entries(initial)) {
      this.map.set(k, v);
    }
  }

  lastText(key: string): string | undefined {
    return this.map.get(key)?.text;
  }

  remember(key: string, text: string, day: string): void {
    this.map.set(key, { day, text });
  }

  prune(oldestKept: string): void {
    for (const [id, entry] of this.map) {
      if (entry.day < oldestKept) {
        this.map.delete(id);
      }
    }
  }

  toRecord(): Record<string, LoggedEntry> {
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
