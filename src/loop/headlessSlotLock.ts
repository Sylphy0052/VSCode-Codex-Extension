import { randomUUID } from 'node:crypto';
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
 *
 * 限界（Issue #1918）: ハートビートは持ち主のイベントループで動くため、拡張ホストが
 * `SLOT_STALE_MS`を超えて止まると（同期処理の詰まり、デバッガでの停止、スリープ明けなど）更新が
 * 途切れ、生きている持ち主の枠を他のウィンドウが奪う。奪われた側は気づかずに実行を続けるので、
 * その実行が終わるまでは一時的に同時2本になりうる。2本で済み、実行が終われば元に戻るため、
 * 実行を止める仕組みは持たない。
 */

const SLOT_FILE_PREFIX = 'headless-cli-slot.lock';

/**
 * 短命CLIの優先度（Issue #2005）。`human`は人の操作を止めて待たせる呼び出し（skill選択）、
 * `stage`は工程を止めて待たせる呼び出し（Reflexの判定など）、`background`はそれ以外の背景処理。
 */
export type HeadlessPriority = 'human' | 'stage' | 'background';

const PRIORITY_RANKS: Record<HeadlessPriority, number> = { human: 2, stage: 1, background: 0 };

export function priorityRank(priority: HeadlessPriority | undefined): number {
  return PRIORITY_RANKS[priority ?? 'background'];
}

/**
 * 実行枠を待っているウィンドウの印。`<接頭辞>.<段>.<ウィンドウの識別子>`で、`stage`以上の要求を
 * 待たせているウィンドウだけが置く。印は`SLOT_STALE_MS`を超えて更新されなければ無視する。
 */
const WANT_FILE_PREFIX = 'headless-cli-want';

/** 待ち印のmtimeを更新し直す間隔。 */
const WANT_REFRESH_MS = 5_000;

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
  /** `dir`を作り終えたか。作った後は取るたびの`mkdir`を省く（Issue #1918）。 */
  private dirReady = false;
  /** 待ち印の持ち主を区別する識別子。自分の印は待たされる理由にしない。 */
  private readonly id = randomUUID();
  private wantedRank = -1;
  private wantedAt = 0;
  private wantedChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly logWarn: (message: string) => void = () => undefined,
  ) {}

  /**
   * 実行枠を取る。他のウィンドウが実行中なら`undefined`を返す（呼び出し側が時間をおいて取り直す）。
   * 他のウィンドウがより高い優先度の要求を待っているときも`undefined`を返し、枠を譲る（Issue #2005）。
   * 共有先に書けないときは、ウィンドウ間の調整を諦めて枠を渡す（短命CLIを止め続けない）。
   *
   * 無競合でも`readdir`・`stat`・`writeFile`・`readdir`・`unlink`とfs呼び出しが数回入り、起動が
   * 数ms遅れる（`headlessCli.ts`の`recordCall`の待ち時間にも載る）。`mkdir`だけは初回に限り、
   * 残りは排他に要るため受け入れる。CLIの実行は数十秒〜数分かかる（Issue #1918）。
   */
  async tryAcquire(priority: HeadlessPriority = 'background'): Promise<HeadlessSlot | undefined> {
    try {
      await this.ensureDir();
      const names = await readdir(this.dir);
      if ((await this.foreignWantedRank(names)) > priorityRank(priority)) {
        return undefined;
      }
      const latest = Math.max(0, ...generationsOf(names));
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
      const after = generationsOf(await readdir(this.dir));
      if (after.some((generation) => generation > own)) {
        await this.expire(own);
        return undefined;
      }
      for (const generation of after.filter((g) => g < own)) {
        await unlink(this.lockPath(generation)).catch(() => undefined);
      }
      return this.hold(own);
    } catch (e) {
      // 共有先が消された場合に、次の呼び出しで作り直す
      this.dirReady = false;
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

  private async ensureDir(): Promise<void> {
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
  }

  /**
   * 自分が実行枠を待たせている要求の最高の段を、待ち印として共有先に残す（Issue #2005）。
   * `-1`で待ちなし。同じ段なら`WANT_REFRESH_MS`ごとにmtimeを更新するだけにして、呼び出しを軽くする。
   * 書けなくても調整を諦めるだけで、実行は止めない。
   */
  setWanted(rank: number): Promise<void> {
    const wanted = rank >= PRIORITY_RANKS.stage ? rank : -1;
    if (
      wanted === this.wantedRank &&
      (wanted < 0 || Date.now() - this.wantedAt < WANT_REFRESH_MS)
    ) {
      return this.wantedChain;
    }
    const previous = this.wantedRank;
    this.wantedRank = wanted;
    this.wantedAt = Date.now();
    this.wantedChain = this.wantedChain.then(async () => {
      try {
        if (previous >= 0 && previous !== wanted) {
          await unlink(this.wantPath(previous)).catch(() => undefined);
        }
        if (wanted >= 0) {
          await this.ensureDir();
          await writeFile(this.wantPath(wanted), String(process.pid), 'utf8');
        }
      } catch {
        this.dirReady = false;
      }
    });
    return this.wantedChain;
  }

  /** 他のウィンドウが`rank`より高い段の要求を待たせているか。 */
  async hasHigherWaiter(rank: number): Promise<boolean> {
    try {
      return (await this.foreignWantedRank(await readdir(this.dir))) > rank;
    } catch {
      return false;
    }
  }

  /** 他のウィンドウの有効な待ち印のうち最高の段。無ければ`-1`。 */
  private async foreignWantedRank(names: readonly string[]): Promise<number> {
    let highest = -1;
    for (const name of names) {
      const match = new RegExp(`^${WANT_FILE_PREFIX}\\.(\\d)\\.(.+)$`).exec(name);
      const rank = Number(match?.[1]);
      if (match === null || match[2] === this.id || !Number.isInteger(rank) || rank <= highest) {
        continue;
      }
      try {
        const age = Date.now() - (await stat(path.join(this.dir, name))).mtimeMs;
        if (Math.abs(age) <= SLOT_STALE_MS) {
          highest = rank;
        }
      } catch {
        // 見た後に持ち主が消した
      }
    }
    return highest;
  }

  private wantPath(rank: number): string {
    return path.join(this.dir, `${WANT_FILE_PREFIX}.${String(rank)}.${this.id}`);
  }
}

function generationsOf(names: readonly string[]): number[] {
  const generations: number[] = [];
  for (const name of names) {
    const suffix = name.startsWith(`${SLOT_FILE_PREFIX}.`)
      ? name.slice(SLOT_FILE_PREFIX.length + 1)
      : '';
    if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(Number(suffix))) {
      generations.push(Number(suffix));
    }
  }
  return generations;
}
