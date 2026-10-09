import { spawn } from 'node:child_process';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
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

/**
 * 取得中であることを示す排他ファイル名の接頭辞（`sharedDir`の直下）。
 * 実際のファイルは`<接頭辞>.<世代番号>`で、ディレクトリ内で最大の世代が現在のロックになる。
 * 旧版の`claude-usage-probe.lock`（世代なし）は読まない。版が混在する間に取得が重複しうるだけで、
 * 残った旧ファイルは害がないため、互換のための処理は置かない。
 */
const CLAIM_FILE_PREFIX = 'claude-usage-probe.lock';

/**
 * この時間を過ぎた排他ファイルは、保持したまま落ちたものとして次の世代で奪う。
 * mtimeがこの時間を超えて未来にあるものも、時計のずれた書き手の残骸として奪う。
 */
const CLAIM_STALE_MS = TIMEOUT_MS * 2;

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
  /** 自分が取得中のロックの世代。取得していなければundefined。 */
  private claimedGeneration: number | undefined;

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
   *
   * ロックは世代番号付きのファイル（`<接頭辞>.<N>`）で、最大のNが現在のロック。
   * 期限切れなら`N+1`を`wx`で作る。同じ世代を作れるのは`wx`に成功した1者だけで、
   * 「消して作り直す」のように途中で落ちて残る中間状態が無い。`wx`の排他作成は
   * NTFS・NFSv3以降でも原子的で、`rename`や`link`より環境差が少ない。
   * 解放しても世代のファイルは残して期限切れにするだけなので、番号は戻らない。
   */
  private async claim(now: number): Promise<boolean> {
    if (this.sharedDir === undefined) {
      return true;
    }
    try {
      await mkdir(this.sharedDir, { recursive: true });
      const latest = Math.max(0, ...(await this.listGenerations()));
      if (latest > 0) {
        try {
          // ホームをNFSで共有するホスト間では、mtimeを付けた時計とDate.now()がずれうる。
          // 未来のmtimeを「常に新しい」と見ると、ずれた分だけ全ウィンドウが取得できなくなるので、
          // ずれも期限の幅までしか認めない。逆向きのずれで早く期限切れと見て取得が重なるのは、
          // `claude`の起動が1回増えるだけなので許す。持ち主が落ちたとき、他が取得できない時間は
          // ずれの分だけ延び、最長で期限の2倍になる
          const age = Date.now() - (await stat(this.lockPath(latest))).mtimeMs;
          if (Math.abs(age) <= CLAIM_STALE_MS) {
            return false;
          }
        } catch (e) {
          // 見た後に、より新しい世代の取得者の掃除で消えた。今回は取得しない
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
          }
          throw e;
        }
      }
      const own = latest + 1;
      try {
        await writeFile(this.lockPath(own), String(now), { encoding: 'utf8', flag: 'wx' });
      } catch (e) {
        // 同じ世代を別のウィンドウが先に作った。今回は取得しない
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          return false;
        }
        throw e;
      }
      // 作った時点で記録する。以降で例外になり取得へ進んでも、releaseで期限切れにできる
      this.claimedGeneration = own;
      // 古いreaddirで止まっていた者は、掃除で消えた番号を作り直せてしまう。作った後に
      // 自分より大きい世代があれば、並び立たないよう自分の世代を期限切れにして退く
      const after = await this.listGenerations();
      if (after.some((generation) => generation > own)) {
        this.claimedGeneration = undefined;
        await utimes(this.lockPath(own), 0, 0).catch(() => undefined);
        return false;
      }
      // 自分より古い世代は用済み。1件ずつ消し、失敗や既に無い場合は次回に回す
      for (const generation of after.filter((g) => g < own)) {
        await unlink(this.lockPath(generation)).catch(() => undefined);
      }
      return true;
    } catch (e) {
      // 共有先に書けない場合は、他のウィンドウとの調整を諦めて自分で取得する
      this.log.warn(
        `使用量の取得権を作れませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
      return true;
    }
  }

  private lockPath(generation: number): string {
    return path.join(this.sharedDir ?? '', `${CLAIM_FILE_PREFIX}.${generation}`);
  }

  /** 共有先にあるロックの世代番号を返す。 */
  private async listGenerations(): Promise<number[]> {
    const generations: number[] = [];
    for (const name of await readdir(this.sharedDir ?? '')) {
      const suffix = name.startsWith(`${CLAIM_FILE_PREFIX}.`)
        ? name.slice(CLAIM_FILE_PREFIX.length + 1)
        : '';
      // 先頭ゼロや桁あふれの名前が混ざっても、世代の最大値を壊さない
      if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(Number(suffix))) {
        generations.push(Number(suffix));
      }
    }
    return generations;
  }

  /**
   * 取得権を手放す。自分の世代のファイルは消さず、期限切れの時刻へ戻す。
   * 消すと、世代が空に戻り、期限切れを見て次の世代を作る者と番号が重なりうるため。
   */
  private async release(): Promise<void> {
    const generation = this.claimedGeneration;
    this.claimedGeneration = undefined;
    if (this.sharedDir === undefined || generation === undefined) {
      return;
    }
    try {
      await utimes(this.lockPath(generation), 0, 0);
    } catch {
      // 戻せなくても、期限が過ぎれば次の世代で奪われる
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
      // transcriptを~/.claude/projects/へ残さない（Issue #1911）
      const proc = spawn(this.claudePath(), ['--print', '--no-session-persistence', '/usage'], {
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
