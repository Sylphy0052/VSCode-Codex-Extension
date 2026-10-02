import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { killWithEscalation } from '../process/childProcess';
import type { ChatUsage } from '../appserver/chatState';
import type { Logger } from '../log';
import { parseUsageReport } from './usageText';

/** 応答が返らないまま居座らせない。使用量は無くても困らない情報なので短く切る。 */
const TIMEOUT_MS = 20_000;

/**
 * 続けて発言しても叩き直さない間隔。全ウィンドウで共有する（Issue #1809）。
 *
 * 以前はウィンドウごとに60秒だった。ターンの完了ごとに呼ばれるため、3〜4ウィンドウで
 * タスクを回すと`claude`の起動が毎分数本ずつ重なり、負荷平均を押し上げていた。消費率は
 * 分単位では動かず、到達とリセット時刻は`rate_limit_event`で即時に届くので、間隔を広げても
 * 表示の遅れは割合だけにとどまる。
 */
const MIN_INTERVAL_MS = 5 * 60_000;

/** ウィンドウ間で共有する直近の取得結果のファイル名（`sharedDir`の直下）。 */
const SHARED_FILE_NAME = 'claude-usage-probe.json';

/** 共有ファイルの中身。`usage`が無いのは、取得中か読めなかった場合。 */
interface SharedUsageRecord {
  readAt: number;
  usage: ChatUsage | undefined;
}

/**
 * `claude --print /usage` を単独で実行して消費率を読む。
 *
 * 会話中のセッションへ `/usage` を送ると応答が会話に混ざるため、別プロセスで聞く。
 * `rate_limit_event` は割合を持たないので、これが唯一の取得手段になる。
 */
export class ClaudeUsageProbe {
  private lastReadAt = 0;
  private running = false;

  constructor(
    private readonly claudePath: () => string,
    private readonly log: Logger,
    /**
     * 直近の取得結果を全ウィンドウで共有する置き場所（Issue #1809）。
     * `ExtensionContext.globalStorageUri.fsPath`を渡す。未指定ならウィンドウ内だけで間隔を空ける。
     */
    private readonly sharedDir?: string,
  ) {}

  /**
   * 前回から間隔が空いていれば読む。
   *
   * 他のウィンドウが間隔内に読んでいれば、`claude`を起動せずにその結果を返す。
   *
   * @param now 現在時刻（ミリ秒）。テストから差し替える。
   */
  async read(now: number = Date.now()): Promise<ChatUsage | undefined> {
    if (this.running || now - this.lastReadAt < MIN_INTERVAL_MS) {
      return undefined;
    }
    this.running = true;
    try {
      const shared = await this.readShared();
      if (shared !== undefined && shared.readAt <= now && now - shared.readAt < MIN_INTERVAL_MS) {
        this.lastReadAt = shared.readAt;
        return shared.usage;
      }
      this.lastReadAt = now;
      // 起動する前に時刻だけ書き、取得中に他のウィンドウが重ねて起動しないようにする
      await this.writeShared({ readAt: now, usage: undefined });
      const output = await this.run();
      const usage = output === undefined ? undefined : parseUsageReport(output);
      await this.writeShared({ readAt: now, usage });
      return usage;
    } finally {
      this.running = false;
    }
  }

  private async readShared(): Promise<SharedUsageRecord | undefined> {
    if (this.sharedDir === undefined) {
      return undefined;
    }
    try {
      return parseSharedUsageRecord(
        await readFile(path.join(this.sharedDir, SHARED_FILE_NAME), 'utf8'),
      );
    } catch {
      // 無い・壊れている場合は自分で取得する
      return undefined;
    }
  }

  private async writeShared(record: SharedUsageRecord): Promise<void> {
    if (this.sharedDir === undefined) {
      return;
    }
    const filePath = path.join(this.sharedDir, SHARED_FILE_NAME);
    const tmp = `${filePath}.tmp-${process.pid}`;
    try {
      await mkdir(this.sharedDir, { recursive: true });
      await writeFile(tmp, JSON.stringify(record), 'utf8');
      // 読み手が書きかけの内容を拾わないよう、一時ファイルから置き換える
      await rename(tmp, filePath);
    } catch (e) {
      this.log.warn(
        `使用量の取得結果を共有できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private run(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const proc = spawn(this.claudePath(), ['--print', '/usage'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let out = '';
      const finish = (value: string | undefined): void => {
        clearTimeout(timer);
        // SIGTERMに応答しないハングしたプロセスも回収できるよう、SIGKILLへの
        // エスカレーションを共通処理へ寄せる（issue #402、2点目のLOW対応）。
        killWithEscalation(proc);
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.on('error', (e: Error) => {
        this.log.warn(`使用量を取得できませんでした: ${e.message}`);
        finish(undefined);
      });
      proc.on('close', () => finish(out));
    });
  }
}

/** 共有ファイルを信用せずに読む。別の版の拡張機能が書いた形の違う値は捨てる。 */
function parseSharedUsageRecord(raw: string): SharedUsageRecord | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const v = parsed as Record<string, unknown>;
  if (typeof v.readAt !== 'number' || !Number.isFinite(v.readAt)) {
    return undefined;
  }
  return { readAt: v.readAt, usage: parseSharedUsage(v.usage) };
}

function parseSharedUsage(value: unknown): ChatUsage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.usedPercent !== 'number' || !Number.isFinite(v.usedPercent)) {
    return undefined;
  }
  if (typeof v.limitLabel !== 'string') {
    return undefined;
  }
  return {
    usedPercent: v.usedPercent,
    resetsAt: undefined,
    limitLabel: v.limitLabel,
    limited: undefined,
  };
}
