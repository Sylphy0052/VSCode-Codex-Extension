import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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

/** 取得に失敗したとき、次に読み直すまでの間隔。成功時の間隔だと回復が遅れる。 */
const RETRY_INTERVAL_MS = 60_000;

/** 取得中であることを示す排他ファイル名（`sharedDir`の直下）。 */
const CLAIM_FILE_NAME = 'claude-usage-probe.lock';

/** この時間を過ぎた排他ファイルは、保持したまま落ちたものとして奪う。 */
const CLAIM_STALE_MS = TIMEOUT_MS * 2;

/** 期限切れロックの奪取印のファイル名の接尾辞。続けて奪う対象の世代（mtime）を付ける。 */
const TAKEOVER_SUFFIX = '.takeover-';

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
    let claimed = false;
    try {
      const fresh = await this.readFreshShared(now);
      if (fresh !== undefined) {
        this.lastReadAt = fresh.readAt;
        return fresh.usage;
      }
      // 読んで書くまでの間に別ウィンドウが起動しないよう、排他的に作れたウィンドウだけが取得する
      claimed = await this.claim(now);
      if (!claimed) {
        this.lastReadAt = now - (MIN_INTERVAL_MS - RETRY_INTERVAL_MS);
        return undefined;
      }
      // 取得権を得るまでの間に別ウィンドウが終えていれば、その結果を使う
      const again = await this.readFreshShared(now);
      if (again !== undefined) {
        this.lastReadAt = again.readAt;
        return again.usage;
      }
      this.lastReadAt = now;
      // 起動する前に時刻だけ書き、取得中に他のウィンドウが重ねて起動しないようにする
      await this.writeShared({ readAt: now, usage: undefined });
      const output = await this.run();
      const usage = output === undefined ? undefined : parseUsageReport(output);
      // 失敗は短い間隔で取り直せるよう、読んだ時刻を戻して記録する
      const readAt = usage === undefined ? now - (MIN_INTERVAL_MS - RETRY_INTERVAL_MS) : now;
      this.lastReadAt = readAt;
      await this.writeShared({ readAt, usage });
      return usage;
    } finally {
      if (claimed) {
        await this.release();
      }
      this.running = false;
    }
  }

  /** 間隔内に他のウィンドウが読んだ結果があれば返す。 */
  private async readFreshShared(now: number): Promise<SharedUsageRecord | undefined> {
    const shared = await this.readShared();
    return shared !== undefined && shared.readAt <= now && now - shared.readAt < MIN_INTERVAL_MS
      ? shared
      : undefined;
  }

  /**
   * 取得権を排他的に作る。共有先が無ければ常に得られる。
   * 他のウィンドウが保持中なら得られない。保持したまま落ちたものは期限で奪う。
   */
  private async claim(now: number): Promise<boolean> {
    if (this.sharedDir === undefined) {
      return true;
    }
    const lockPath = path.join(this.sharedDir, CLAIM_FILE_NAME);
    try {
      await mkdir(this.sharedDir, { recursive: true });
      await writeFile(lockPath, String(now), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        // 共有先に書けない場合は、他のウィンドウとの調整を諦めて自分で取得する
        this.log.warn(
          `使用量の取得権を作れませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
        return true;
      }
    }
    try {
      const staleMtimeMs = (await stat(lockPath)).mtimeMs;
      if (Date.now() - staleMtimeMs <= CLAIM_STALE_MS) {
        return false;
      }
      // 「期限切れを見て、消して、作り直す」を複数が同時にやると、後から消した者が先に作り直した
      // 者の新しいロックを消してしまい、両者が取得する。そこで期限切れロックの世代（mtime）ごとの
      // 奪取印を`wx`で作り、作れた1者だけが消して作り直す。`wx`の排他作成はNTFS・NFSv3以降でも
      // 原子的で、`rename`や`link`より環境差が少ない。印は残し、同じ世代を遅れて見た者を弾き続ける。
      try {
        await writeFile(`${lockPath}${TAKEOVER_SUFFIX}${staleMtimeMs}`, String(now), {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch {
        // 別のウィンドウが奪取中、または奪取済み。今回は取得しない
        return false;
      }
      // 印を得てから消す前に、持ち主が解放して別のウィンドウが新しく作った可能性を確かめる
      if ((await stat(lockPath)).mtimeMs !== staleMtimeMs) {
        return false;
      }
      await unlink(lockPath);
      await writeFile(lockPath, String(now), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch {
      // 奪い合いに負けた、または消えた。今回は取得しない
      return false;
    }
  }

  /** 古い奪取印を片付ける。直近のものは、遅れて同じ世代を見たウィンドウを弾くため残す。 */
  private async removeOldTakeoverMarks(): Promise<void> {
    if (this.sharedDir === undefined) {
      return;
    }
    try {
      for (const name of await readdir(this.sharedDir)) {
        if (!name.startsWith(`${CLAIM_FILE_NAME}${TAKEOVER_SUFFIX}`)) {
          continue;
        }
        const markPath = path.join(this.sharedDir, name);
        if (Date.now() - (await stat(markPath)).mtimeMs > CLAIM_STALE_MS) {
          await unlink(markPath);
        }
      }
    } catch {
      // 片付けは次回に回せる
    }
  }

  private async release(): Promise<void> {
    if (this.sharedDir === undefined) {
      return;
    }
    try {
      await unlink(path.join(this.sharedDir, CLAIM_FILE_NAME));
    } catch {
      // 既に無ければよい
    }
    await this.removeOldTakeoverMarks();
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
