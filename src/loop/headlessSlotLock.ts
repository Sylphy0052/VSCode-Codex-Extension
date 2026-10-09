import { mkdir, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 短命CLIの実行枠をウィンドウ（拡張ホスト）の間で1つに絞る排他（Issue #1912）。
 *
 * `headlessCli.ts`の順番待ちはプロセス内だけで数えるため、3〜4ウィンドウでタスクを回すと
 * ウィンドウの数だけ同時に起動していた。`globalStorageUri`配下に世代付きのロックファイルを置き、
 * 実行の前に取る。方式は`claude/usageProbe.ts`の取得権と同じで、ディレクトリ内で最大の世代
 * （`<接頭辞>.<N>`）が現在のロックになる。期限切れなら`N+1`を`wx`で作り、作れた1者だけが実行する。
 *
 * 実行は数十秒〜数分続くため、持ち主は実行中にmtimeを更新し続ける（ハートビート）。更新が
 * `SLOT_STALE_MS`より古いロックは、保持したまま落ちたウィンドウの残骸として奪う。
 */

const SLOT_FILE_PREFIX = 'headless-cli-slot.lock';

/** 持ち主がmtimeを更新する間隔。 */
const SLOT_HEARTBEAT_MS = 5_000;

/**
 * この時間を超えて更新されていないロックは奪う。mtimeがこの時間を超えて未来にあるものも、
 * 時計のずれた書き手の残骸として奪う（`usageProbe.ts`と同じ扱い）。
 */
const SLOT_STALE_MS = 30_000;

/** 取った実行枠。実行が終わったら`release`する。 */
export interface HeadlessSlot {
  release(): Promise<void>;
}

export class HeadlessSlotLock {
  private warned = false;

  constructor(
    private readonly dir: string,
    private readonly logWarn: (message: string) => void = () => undefined,
  ) {}

  /**
   * 実行枠を取る。他のウィンドウが実行中なら`undefined`を返す（呼び出し側が時間をおいて取り直す）。
   * 共有先に書けないときは、ウィンドウ間の調整を諦めて枠を渡す（短命CLIを止め続けない）。
   */
  async tryAcquire(): Promise<HeadlessSlot | undefined> {
    try {
      await mkdir(this.dir, { recursive: true });
      const latest = Math.max(0, ...(await this.listGenerations()));
      if (latest > 0) {
        try {
          const age = Date.now() - (await stat(this.lockPath(latest))).mtimeMs;
          if (Math.abs(age) <= SLOT_STALE_MS) {
            return undefined;
          }
        } catch (e) {
          // 見た後に、より新しい世代の取得者の掃除で消えた。今回は取らない
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          }
          throw e;
        }
      }
      const own = latest + 1;
      try {
        await writeFile(this.lockPath(own), String(process.pid), { encoding: 'utf8', flag: 'wx' });
      } catch (e) {
        // 同じ世代を別のウィンドウが先に作った
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          return undefined;
        }
        throw e;
      }
      // 古いreaddirで止まっていた者は、掃除で消えた番号を作り直せてしまう。作った後に
      // 自分より大きい世代があれば、並び立たないよう自分の世代を期限切れにして退く
      const after = await this.listGenerations();
      if (after.some((generation) => generation > own)) {
        await this.expire(own);
        return undefined;
      }
      for (const generation of after.filter((g) => g < own)) {
        await unlink(this.lockPath(generation)).catch(() => undefined);
      }
      return this.hold(own);
    } catch (e) {
      // 書けない状態は呼び出しのたびに続くため、ログは1回だけにする
      if (!this.warned) {
        this.warned = true;
        this.logWarn(
          `短命CLIの実行枠を作れませんでした（ウィンドウ間の調整なしで実行します）: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      return { release: () => Promise.resolve() };
    }
  }

  /** 取った世代のmtimeを更新し続け、`release`で期限切れへ戻す。 */
  private hold(generation: number): HeadlessSlot {
    const timer = setInterval(() => {
      const now = new Date();
      // 更新できなくても、期限が過ぎて他のウィンドウに奪われるだけ
      utimes(this.lockPath(generation), now, now).catch(() => undefined);
    }, SLOT_HEARTBEAT_MS);
    timer.unref?.();
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        clearInterval(timer);
        await this.expire(generation);
      },
    };
  }

  /**
   * 世代のファイルは消さず、期限切れの時刻へ戻す。消すと世代が空に戻り、期限切れを見て
   * 次の世代を作る者と番号が重なりうるため（`usageProbe.ts`の`release`と同じ）。
   */
  private async expire(generation: number): Promise<void> {
    await utimes(this.lockPath(generation), 0, 0).catch(() => undefined);
  }

  private lockPath(generation: number): string {
    return path.join(this.dir, `${SLOT_FILE_PREFIX}.${generation}`);
  }

  private async listGenerations(): Promise<number[]> {
    const generations: number[] = [];
    for (const name of await readdir(this.dir)) {
      const suffix = name.startsWith(`${SLOT_FILE_PREFIX}.`)
        ? name.slice(SLOT_FILE_PREFIX.length + 1)
        : '';
      if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(Number(suffix))) {
        generations.push(Number(suffix));
      }
    }
    return generations;
  }
}
