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
}

export const nodeClock: ClockPort = {
  now: () => new Date(),
  timeZoneOffsetMinutes: () => new Date().getTimezoneOffset(),
};

/**
 * 拡張機能から実行したセッションの発言・成果を日報バッファへ記録する。
 *
 * `kind: 'prompt'` は送信のたびに毎回記録する。`kind: 'result'` はターン完了のたびに毎回記録する。
 *
 * 記録は会話の成否に影響してはならないため、失敗しても例外を投げず、
 * 既記録にもしない（次の契機で書き直せるようにする）。
 */
export class ActivityLogger {
  constructor(
    private readonly appender: ActivityAppendPort,
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

    const fileName = bufferFileName(now, offset);
    try {
      await this.appender.append(`${settings.dir}/${fileName}`, serializeActivityRecord(record));
    } catch {
      // 追記できないこと自体は会話の妨げにならない。次の契機に委ねる
      return;
    }
  }
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
