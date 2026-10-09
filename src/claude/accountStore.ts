import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  link,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UsageSlot, UsageSlots } from './usageText';

/**
 * Claude Codeの複数アカウントの登録・切り替え（Issue #1921）。
 *
 * 認証はアカウントに関係なく `<claudeHome>/.credentials.json` の1ファイルにある。
 * これをアカウントごとに `<claudeHome>/accounts/<id>/` へ退避し、差し替えて切り替える。
 * 保存先の形は検証用スクリプト（`~/.claude/bin/claude-account.sh`・
 * `claude-usage-watch.mjs`）とそろえてあり、どちらから操作しても同じ状態を読み書きする。
 *
 * **トークンの中身は扱わない**。認証ファイルはJSONのオブジェクトであることだけを確かめ、
 * バイト列のまま写す。中身を返却・ログ出力しない。画面へ返すのは `<id>`・表示名・
 * 優先度・メールアドレス・使用率の記録だけ。
 */

/** `<id>` として受け付ける形。ディレクトリ名になるため、パス区切りや `..` を通さない。 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID_RE.test(id) && id !== '.' && id !== '..';
}

/** 表示名の上限。サイドバーの1行に収まる程度。 */
const MAX_NAME_LENGTH = 40;
const INVALID_NAME_REASON = `表示名は1〜${MAX_NAME_LENGTH}文字で、改行を含めないでください`;

/** 表示名を整える。空・長すぎ・制御文字入りは `undefined`。 */
export function normalizeAccountName(name: string): string | undefined {
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed === '' || trimmed.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** 使用率の記録1枠分。`resetsAt` はepochミリ秒。 */
export interface SavedAccountLimit {
  pct: number;
  resetsAt: number | undefined;
}

/** `usage.json` の記録（スクリプトが書く）。 */
export interface SavedAccountUsage {
  /** 記録した時刻（epochミリ秒）。 */
  recordedAt: number;
  fiveHour: SavedAccountLimit | undefined;
  weekly: SavedAccountLimit | undefined;
}

export interface SavedAccountView {
  id: string;
  /** 表示名。`meta.json` が無いアカウント（スクリプトで登録したもの）は `<id>`。 */
  name: string;
  /** 小さいほど優先度が高い。 */
  priority: number;
  email: string | undefined;
  /** `.current` が指すアカウントか。 */
  current: boolean;
  usage: SavedAccountUsage | undefined;
}

export type SavedAccountsSnapshot =
  { ok: true; accounts: SavedAccountView[] } | { ok: false; reason: string };

export type AccountStoreResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /**
       * 稼働中のアカウントにメールアドレスの記録が無いため照合できなかった（スクリプトで
       * 登録した後にトークンが更新された場合など）。利用者が同じアカウントだと確かめれば
       * `adoptCurrentEmail` で記録して切り替え直せる。
       */
      confirmCurrent?: { id: string; name: string };
    };

interface AccountMeta {
  name: string | undefined;
  priority: number | undefined;
  email: string | undefined;
}

/** `meta.json` の生の中身。スクリプトが足したキーを消さないよう、書き換えるキー以外は保つ。 */
type RawMeta = Record<string, unknown>;

const CREDENTIALS = '.credentials.json';
const META = 'meta.json';
const USAGE = 'usage.json';
const CURRENT = '.current';
/** ウィンドウ（拡張ホスト）をまたいで書き換えを1本にするロック。新規作成（wx）で取る。 */
const LOCK = '.ext-op.lock';
/** 持ち主が落ちて残ったロックを奪うまでの時間。書き換えは数ファイルなので十分長い。 */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 100;

export class ClaudeAccountStore {
  /** 同じウィンドウの中の書き換えを1本ずつ通す。 */
  private queue: Promise<AccountStoreResult> = Promise.resolve({ ok: true });

  constructor(private readonly claudeHome: string) {}

  private get accountsDir(): string {
    return join(this.claudeHome, 'accounts');
  }

  private get liveCredentials(): string {
    return join(this.claudeHome, CREDENTIALS);
  }

  private slot(id: string): string {
    return join(this.accountsDir, id);
  }

  /**
   * 登録済みのアカウントを優先度の順に返す。`accounts/` が無ければ空。
   * スクリプトなど他の経路で緩い権限のまま作られたものは、ここで0700/0600へ締める。
   */
  async list(): Promise<SavedAccountsSnapshot> {
    try {
      const ids = await this.registeredIds();
      await this.tightenPermissions(ids);
      const current = await this.readCurrent();
      const accounts = await Promise.all(ids.map((id) => this.view(id, current)));
      return { ok: true, accounts: sortByPriority(accounts) };
    } catch (e) {
      return { ok: false, reason: errorMessage(e) };
    }
  }

  /** 稼働中のアカウントの `<id>`。`.current` が無いか、登録が消えていれば `undefined`。 */
  async currentId(): Promise<string | undefined> {
    const current = await this.readCurrent();
    return current !== undefined && (await this.isRegistered(current)) ? current : undefined;
  }

  async isRegistered(id: string): Promise<boolean> {
    return isValidAccountId(id) && (await exists(join(this.slot(id), CREDENTIALS)));
  }

  /** 表示名（`meta.json` が無ければ `<id>`）。確認ダイアログに出す。 */
  async displayName(id: string): Promise<string> {
    return (await this.readMeta(id)).name ?? id;
  }

  /**
   * 今の `.credentials.json` を新しいアカウントとして登録し、稼働中にする。
   * メールアドレスか認証ファイルの中身が登録済みのものと同じなら断る（二重登録を防ぐ）。
   */
  register(name: string, email: string | undefined): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      const normalized = normalizeAccountName(name);
      if (normalized === undefined) {
        return { ok: false, reason: INVALID_NAME_REASON };
      }
      const live = await readOptional(this.liveCredentials);
      if (live === undefined) {
        return { ok: false, reason: 'ログインしていません。先にClaude Codeでログインしてください' };
      }
      if (!isJsonObject(live)) {
        return { ok: false, reason: '今の認証ファイルを解釈できないため登録しませんでした' };
      }
      const ids = await this.registeredIds();
      let maxPriority = -1;
      for (const id of ids) {
        const meta = await this.readMeta(id);
        if (email !== undefined && meta.email === email) {
          return { ok: false, reason: `${email}は「${meta.name ?? id}」として登録済みです` };
        }
        if ((await readOptional(join(this.slot(id), CREDENTIALS)))?.equals(live) === true) {
          return { ok: false, reason: `今のアカウントは「${meta.name ?? id}」として登録済みです` };
        }
        maxPriority = Math.max(maxPriority, meta.priority ?? 0);
      }
      const id = await this.newId();
      await this.writeSecret(join(this.slot(id), CREDENTIALS), live);
      try {
        await this.writeMeta(id, {
          name: normalized,
          priority: maxPriority + 1,
          email,
          registeredAt: Date.now(),
        });
        await this.writeSecret(join(this.accountsDir, CURRENT), Buffer.from(`${id}\n`));
      } catch (e) {
        // 一覧に名前の無い退避先を残さない
        await rm(this.slot(id), { recursive: true, force: true });
        throw e;
      }
      return { ok: true };
    });
  }

  /**
   * `id` のアカウントへ切り替える。
   *
   * 1. 稼働中のアカウントの退避先へ、今の `.credentials.json` を書き戻す（refresh tokenが
   *    入れ替わっていても新しい方を残す）
   * 2. 切り替え先の認証ファイルを `.credentials.json` へ写す
   * 3. `.current` を更新する。失敗したら2を元に戻す
   *
   * `liveEmail` は今ログインしているアカウントのメールアドレス（`claude auth status`）。
   * 今の認証が稼働中として記録したアカウントのものだと確かめられないときは、書き戻すと
   * 別のアカウントの退避先を上書きしうるため切り替えない（照合に使うメールアドレスの記録が
   * 無いだけのときは `confirmCurrent` を付けて返す）。
   */
  switchTo(id: string, liveEmail: string | undefined): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if (!(await this.isRegistered(id))) {
        return { ok: false, reason: `「${id}」は登録されていません` };
      }
      const current = await this.currentId();
      if (current === id) {
        return { ok: true };
      }
      const target = await readFile(join(this.slot(id), CREDENTIALS));
      if (!isJsonObject(target)) {
        return { ok: false, reason: `「${id}」の退避した認証ファイルを解釈できません` };
      }
      const live = await readOptional(this.liveCredentials);
      if (live !== undefined) {
        if (!isJsonObject(live)) {
          return {
            ok: false,
            reason:
              '今の認証ファイルを解釈できないため、書き戻さずに止めました。少し待ってから試してください',
          };
        }
        const unsafe = await this.checkLiveBelongsToCurrent(current, live, liveEmail);
        if (unsafe !== undefined) {
          return unsafe;
        }
        if (current !== undefined) {
          try {
            await this.writeSecret(join(this.slot(current), CREDENTIALS), live);
          } catch (e) {
            return {
              ok: false,
              reason: `稼働中のアカウントの書き戻しで止まりました: ${errorMessage(e)}`,
            };
          }
        }
      }
      try {
        await this.writeSecret(this.liveCredentials, target);
      } catch (e) {
        return {
          ok: false,
          reason: `切り替え先の認証ファイルを写す段階で止まりました（稼働中のアカウントは変わっていません）: ${errorMessage(e)}`,
        };
      }
      try {
        await this.writeSecret(join(this.accountsDir, CURRENT), Buffer.from(`${id}\n`));
      } catch (e) {
        // `.current` と実体がずれたままだと、次の切り替えで別のアカウントの退避先へ書き戻してしまう
        const restored = await this.restoreLive(live);
        return {
          ok: false,
          reason: `.currentの更新で止まりました（${restored ? '認証ファイルは元に戻しました' : '認証ファイルを元に戻せませんでした。ログインし直してください'}）: ${errorMessage(e)}`,
        };
      }
      return { ok: true };
    });
  }

  /**
   * 切り替えた後に、今ログインしているメールアドレスを記録する。スクリプトで登録した
   * アカウント（`meta.json` 無し）は、ここで初めてメールアドレスが付き、以後の照合に使える。
   * 今の認証ファイルが `id` の退避先と同じときだけ書く。
   */
  recordEmail(id: string, email: string | undefined): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if (email === undefined || !(await this.isRegistered(id))) {
        return { ok: true };
      }
      const [live, saved] = await Promise.all([
        readOptional(this.liveCredentials),
        readOptional(join(this.slot(id), CREDENTIALS)),
      ]);
      if (live === undefined || saved === undefined || !live.equals(saved)) {
        return { ok: true };
      }
      if ((await this.readMeta(id)).email === undefined) {
        await this.writeMeta(id, { email });
      }
      return { ok: true };
    });
  }

  /**
   * 稼働中のアカウントの使用率を `usage.json` へ記録する（スクリプトと同じ形）。
   * 取得している間にアカウントが切り替わっていたら、どちらの値か判らないので捨てる
   * （`expectedId` が今の稼働中と違うとき）。待機中のアカウントの値は取りに行かない。
   */
  recordUsage(expectedId: string, slots: UsageSlots, nowMs: number): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if ((await this.currentId()) !== expectedId) {
        return { ok: false, reason: '取得中にアカウントが切り替わったため記録しませんでした' };
      }
      const limits: Record<string, UsageSlot> = {};
      if (slots.fiveHour !== undefined) {
        limits['5h'] = slots.fiveHour;
      }
      if (slots.weekly !== undefined) {
        limits['week:all models'] = slots.weekly;
      }
      await this.writeSecret(
        join(this.slot(expectedId), USAGE),
        Buffer.from(`${JSON.stringify({ t: nowMs, limits })}\n`),
      );
      return { ok: true };
    });
  }

  /**
   * 稼働中のアカウントに、今ログインしているメールアドレスを記録する。利用者が確認ダイアログで
   * 同じアカウントだと確かめた後にだけ呼ぶ（`switchTo` の `confirmCurrent`）。
   */
  adoptCurrentEmail(id: string, email: string): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if ((await this.currentId()) !== id) {
        return { ok: false, reason: '稼働中のアカウントが変わりました。もう一度試してください' };
      }
      const recorded = (await this.readMeta(id)).email;
      if (recorded !== undefined && recorded !== email) {
        return {
          ok: false,
          reason: `「${id}」には別のメールアドレス（${recorded}）が記録されています`,
        };
      }
      for (const other of await this.registeredIds()) {
        const meta = other === id ? undefined : await this.readMeta(other);
        if (meta?.email === email) {
          return { ok: false, reason: `${email}は「${meta.name ?? other}」として登録済みです` };
        }
      }
      await this.writeMeta(id, { email });
      return { ok: true };
    });
  }

  rename(id: string, name: string): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if (!(await this.isRegistered(id))) {
        return { ok: false, reason: `「${id}」は登録されていません` };
      }
      const normalized = normalizeAccountName(name);
      if (normalized === undefined) {
        return { ok: false, reason: INVALID_NAME_REASON };
      }
      await this.writeMeta(id, { name: normalized });
      return { ok: true };
    });
  }

  /** 優先度を1つ上げる（`up`）か下げる（`down`）。並びを0から振り直して `meta.json` へ残す。 */
  move(id: string, direction: 'up' | 'down'): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      const current = await this.readCurrent();
      const ordered = sortByPriority(
        await Promise.all((await this.registeredIds()).map((i) => this.view(i, current))),
      );
      const index = ordered.findIndex((a) => a.id === id);
      if (index < 0) {
        return { ok: false, reason: `「${id}」は登録されていません` };
      }
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= ordered.length) {
        return { ok: true };
      }
      [ordered[index], ordered[swapWith]] = [ordered[swapWith]!, ordered[index]!];
      // 壊れた meta.json が途中にあると並びが半端に書き換わるため、先に全部読めるか確かめる
      for (const account of ordered) {
        await this.readRawMeta(account.id);
      }
      for (const [priority, account] of ordered.entries()) {
        if (account.priority !== priority) {
          await this.writeMeta(account.id, { priority });
        }
      }
      return { ok: true };
    });
  }

  /** 退避先のディレクトリを消す。稼働中のアカウントは消さない。 */
  remove(id: string): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if (!(await this.isRegistered(id))) {
        return { ok: false, reason: `「${id}」は登録されていません` };
      }
      if ((await this.currentId()) === id) {
        return {
          ok: false,
          reason: '稼働中のアカウントは削除できません。先に別のアカウントへ切り替えてください',
        };
      }
      await rm(this.slot(id), { recursive: true, force: true });
      return { ok: true };
    });
  }

  /**
   * 今の `.credentials.json` が、稼働中として記録したアカウントのものかを確かめる。
   * 確かめられなければ、切り替えると認証情報が失われるか別のアカウントの退避先を
   * 上書きするため、理由を返す。
   */
  private async checkLiveBelongsToCurrent(
    current: string | undefined,
    live: Buffer,
    liveEmail: string | undefined,
  ): Promise<Extract<AccountStoreResult, { ok: false }> | undefined> {
    if (current === undefined) {
      // `.current` が無い（または登録が消えた）ときは、中身が同じ退避ファイルがあれば失われない
      for (const id of await this.registeredIds()) {
        if ((await readOptional(join(this.slot(id), CREDENTIALS)))?.equals(live) === true) {
          return undefined;
        }
      }
      return {
        ok: false,
        reason:
          '今ログインしているアカウントが登録されていないため、切り替えると認証情報が失われます。先に「今のアカウントを登録」で登録してください',
      };
    }
    if ((await readOptional(join(this.slot(current), CREDENTIALS)))?.equals(live) === true) {
      return undefined;
    }
    const meta = await this.readMeta(current);
    const name = meta.name ?? current;
    if (meta.email !== undefined && liveEmail !== undefined) {
      return meta.email === liveEmail
        ? undefined
        : {
            ok: false,
            reason: `今ログインしているアカウント（${liveEmail}）は、稼働中として記録した「${name}」（${meta.email}）と違います。先に「今のアカウントを登録」で登録してください`,
          };
    }
    if (meta.email === undefined && liveEmail !== undefined) {
      return {
        ok: false,
        reason: `稼働中として記録した「${name}」にメールアドレスの記録が無く、今ログインしているアカウント（${liveEmail}）と同じか確かめられません`,
        confirmCurrent: { id: current, name },
      };
    }
    return {
      ok: false,
      reason: `今ログインしているメールアドレスを取得できないため、稼働中として記録した「${name}」と同じか確かめられません。別のアカウントの退避先を上書きしないよう切り替えを止めました。少し待ってから試してください`,
    };
  }

  private async restoreLive(previous: Buffer | undefined): Promise<boolean> {
    try {
      if (previous === undefined) {
        await rm(this.liveCredentials, { force: true });
      } else {
        await this.writeSecret(this.liveCredentials, previous);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 書き換えを1本ずつ通し、途中で投げた例外は理由として返す。ウィンドウをまたいだ
   * 同時操作も `accounts/.ext-op.lock` で1本にする（検証スクリプトはこのロックを見ない）。
   */
  private serialized(task: () => Promise<AccountStoreResult>): Promise<AccountStoreResult> {
    const guarded = async (): Promise<AccountStoreResult> => {
      let token: string | undefined;
      try {
        token = await this.acquireLock();
      } catch (e) {
        return { ok: false, reason: errorMessage(e) };
      }
      if (token === undefined) {
        return {
          ok: false,
          reason: '別のウィンドウがアカウントを操作中です。少し待ってから試してください',
        };
      }
      try {
        return await task();
      } catch (e) {
        return { ok: false, reason: errorMessage(e) };
      } finally {
        await this.releaseLock(token);
      }
    };
    const run = this.queue.then(guarded, guarded);
    this.queue = run;
    return run;
  }

  /**
   * ロックファイルを新規作成で取り、持ち主を示すトークンを返す。取れなければ `undefined`。
   * 古いロックは自分専用の名前へrenameしてから捨てる。同時に奪いに来た側が先に取り直した
   * 新しいロックを掴んだ場合は、`link`（既存を上書きしない）で元へ戻す。
   */
  private async acquireLock(): Promise<string | undefined> {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    const lock = join(this.accountsDir, LOCK);
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await writeFile(lock, token, { mode: 0o600, flag: 'wx' });
        return token;
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== 'EEXIST') {
          throw e;
        }
      }
      if (await this.reclaimStaleLock(lock)) {
        continue;
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  /**
   * ロックが消えたか古いロックを捨てたら `true`（すぐ取り直す）。新しいロックがある、または
   * 権限などで奪えないときは `false`（待って期限を見る。空回りさせない）。
   */
  private async reclaimStaleLock(lock: string): Promise<boolean> {
    let held: Awaited<ReturnType<typeof stat>>;
    try {
      held = await stat(lock);
    } catch (e) {
      return isNotFound(e);
    }
    if (Date.now() - held.mtimeMs <= STALE_LOCK_MS) {
      return false;
    }
    const taken = `${lock}.stale-${randomBytes(4).toString('hex')}`;
    try {
      await rename(lock, taken);
    } catch (e) {
      // ENOENTは他の待機者が先に奪った
      return isNotFound(e);
    }
    const info = await stat(taken).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs <= STALE_LOCK_MS) {
      // 同時に奪いに来た側が取り直した新しいロックだった。戻す間に第三者が取ると2者が
      // 同時に入るが、古いロックを2者が同時に見つけた直後に限られるため受け入れる
      await link(taken, lock).catch(() => undefined);
    }
    await rm(taken, { force: true });
    return true;
  }

  /** 自分が取ったロックのときだけ消す（古いとみなされて奪われた後の別の持ち主のものは残す）。 */
  private async releaseLock(token: string): Promise<void> {
    const lock = join(this.accountsDir, LOCK);
    const held = await readFile(lock, 'utf8').catch(() => undefined);
    if (held === token) {
      await rm(lock, { force: true });
    }
  }

  private async registeredIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.accountsDir);
    } catch (e) {
      if (isNotFound(e)) {
        return [];
      }
      throw e;
    }
    const ids: string[] = [];
    for (const id of entries) {
      if (isValidAccountId(id) && (await exists(join(this.slot(id), CREDENTIALS)))) {
        ids.push(id);
      }
    }
    return ids;
  }

  /** 緩い権限のディレクトリ・ファイルを0700/0600へ締める。シンボリックリンクは触らない。 */
  private async tightenPermissions(ids: string[]): Promise<void> {
    const targets: [string, number][] = [[this.accountsDir, 0o700]];
    for (const id of ids) {
      targets.push([this.slot(id), 0o700]);
      for (const file of [CREDENTIALS, META, USAGE]) {
        targets.push([join(this.slot(id), file), 0o600]);
      }
    }
    // 表示が目的の経路なので、他人所有・途中で消えたなどで締められなくても一覧は返す
    for (const [path, mode] of targets) {
      const info = await lstat(path).catch(() => undefined);
      if (info !== undefined && !info.isSymbolicLink() && (info.mode & 0o777) !== mode) {
        await chmod(path, mode).catch(() => undefined);
      }
    }
  }

  private async readCurrent(): Promise<string | undefined> {
    const raw = await readOptional(join(this.accountsDir, CURRENT));
    const id = raw?.toString('utf8').trim();
    return id !== undefined && isValidAccountId(id) ? id : undefined;
  }

  private async view(id: string, current: string | undefined): Promise<SavedAccountView> {
    const [meta, usage] = await Promise.all([this.readMeta(id), this.readUsage(id)]);
    return {
      id,
      name: meta.name ?? id,
      priority: meta.priority ?? Number.MAX_SAFE_INTEGER,
      email: meta.email,
      current: id === current,
      usage,
    };
  }

  /** 表示用に読む。壊れた `meta.json` は無いものとして扱う。 */
  private async readMeta(id: string): Promise<AccountMeta> {
    const raw = await this.readRawMeta(id).catch((): RawMeta => ({}));
    const name = typeof raw['name'] === 'string' ? normalizeAccountName(raw['name']) : undefined;
    return {
      name,
      priority: Number.isSafeInteger(raw['priority']) ? (raw['priority'] as number) : undefined,
      email: typeof raw['email'] === 'string' ? raw['email'] : undefined,
    };
  }

  /** `meta.json` の生の中身。無ければ空。壊れていれば投げる（書き戻しで中身を失わないため）。 */
  private async readRawMeta(id: string): Promise<RawMeta> {
    const buf = await readOptional(join(this.slot(id), META));
    if (buf === undefined) {
      return {};
    }
    const parsed = parseJson(buf);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`「${id}」のmeta.jsonを解釈できないため書き換えませんでした`);
    }
    return parsed as RawMeta;
  }

  /** `meta.json` の `changes` のキーだけを書き換え、他のキーは保つ。 */
  private async writeMeta(id: string, changes: RawMeta): Promise<void> {
    const next = { ...(await this.readRawMeta(id)), ...changes };
    await this.writeSecret(join(this.slot(id), META), Buffer.from(`${JSON.stringify(next)}\n`));
  }

  /** `usage.json`（`{ t, limits: { '5h': {pct, resetsAt}, 'week:all models': ... } }`）を読む。 */
  private async readUsage(id: string): Promise<SavedAccountUsage | undefined> {
    const buf = await readOptional(join(this.slot(id), USAGE)).catch(() => undefined);
    const parsed = buf === undefined ? undefined : parseJson(buf);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const raw = parsed as Record<string, unknown>;
    const limits = raw['limits'];
    if (typeof raw['t'] !== 'number' || typeof limits !== 'object' || limits === null) {
      return undefined;
    }
    const byKey = limits as Record<string, unknown>;
    return {
      recordedAt: raw['t'],
      fiveHour: parseLimit(byKey['5h']),
      weekly: parseLimit(byKey['week:all models']),
    };
  }

  private async newId(): Promise<string> {
    for (;;) {
      const id = `acct-${randomBytes(3).toString('hex')}`;
      if (!(await exists(this.slot(id)))) {
        return id;
      }
    }
  }

  /**
   * 0600で一時ファイルへ書いてからrenameする（書きかけを読ませない）。一時ファイルは
   * 既存のパスやリンクを辿らないよう新規作成に限る。置き場のディレクトリは0700にそろえる。
   */
  private async writeSecret(path: string, data: Buffer): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `<claudeHome>` 自体の権限はCLIのものなので触らない
    if (dir !== this.claudeHome) {
      await chmod(dir, 0o700);
    }
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}

function sortByPriority(accounts: SavedAccountView[]): SavedAccountView[] {
  return [...accounts].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function parseLimit(value: unknown): SavedAccountLimit | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw['pct'] !== 'number') {
    return undefined;
  }
  return {
    pct: raw['pct'],
    resetsAt: typeof raw['resetsAt'] === 'number' ? raw['resetsAt'] : undefined,
  };
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** 認証ファイルが書きかけや空でないことだけを見る。中身（トークン）は読まない。 */
function isJsonObject(buf: Buffer): boolean {
  const parsed = parseJson(buf);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (e) {
    if (isNotFound(e)) {
      return undefined;
    }
    throw e;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'ENOENT';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
