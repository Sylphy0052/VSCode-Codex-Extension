import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Claude Codeの複数アカウントの登録・切り替え（Issue #1921）。
 *
 * 認証はアカウントに関係なく `<claudeHome>/.credentials.json` の1ファイルにある。
 * これをアカウントごとに `<claudeHome>/accounts/<id>/` へ退避し、差し替えて切り替える。
 * 保存先の形は検証用スクリプト（`~/.claude/bin/claude-account.sh`・
 * `claude-usage-watch.mjs`）とそろえてあり、どちらから操作しても同じ状態を読み書きする。
 *
 * **トークンの中身は扱わない**。認証ファイルはバイト列のまま写すだけで、中身を解釈・
 * 返却・ログ出力しない。画面へ返すのは `<id>`・表示名・優先度・メールアドレス・
 * 使用率の記録だけ。
 */

/** `<id>` として受け付ける形。ディレクトリ名になるため、パス区切りや `..` を通さない。 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID_RE.test(id) && id !== '.' && id !== '..';
}

/** 表示名の上限。サイドバーの1行に収まる程度。 */
const MAX_NAME_LENGTH = 40;

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

export type AccountStoreResult = { ok: true } | { ok: false; reason: string };

interface AccountMeta {
  name?: string | undefined;
  priority?: number | undefined;
  email?: string | undefined;
  registeredAt?: number | undefined;
}

const CREDENTIALS = '.credentials.json';
const META = 'meta.json';
const USAGE = 'usage.json';
const CURRENT = '.current';

export class ClaudeAccountStore {
  /** 書き換えは1本ずつ通す。切り替えと削除が並ぶと、書き戻し先が消えた後に書き込みうる。 */
  private queue: Promise<unknown> = Promise.resolve();

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

  /** 登録済みのアカウントを優先度の順に返す。`accounts/` が無ければ空。 */
  async list(): Promise<SavedAccountsSnapshot> {
    try {
      const ids = await this.registeredIds();
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

  /**
   * 今の `.credentials.json` を新しいアカウントとして登録し、稼働中にする。
   * `email` が既に登録済みのアカウントと同じなら断る（同じアカウントの二重登録を防ぐ）。
   */
  register(name: string, email: string | undefined): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      const normalized = normalizeAccountName(name);
      if (normalized === undefined) {
        return {
          ok: false,
          reason: `表示名は1〜${MAX_NAME_LENGTH}文字で、改行を含めないでください`,
        };
      }
      const live = await readOptional(this.liveCredentials);
      if (live === undefined) {
        return { ok: false, reason: 'ログインしていません。先にClaude Codeでログインしてください' };
      }
      const ids = await this.registeredIds();
      const metas = await Promise.all(
        ids.map(async (id) => ({ id, meta: await this.readMeta(id) })),
      );
      if (email !== undefined) {
        const same = metas.find((m) => m.meta.email === email);
        if (same !== undefined) {
          return {
            ok: false,
            reason: `${email} は「${same.meta.name ?? same.id}」として登録済みです`,
          };
        }
      }
      const id = await this.newId();
      const priority =
        metas.reduce((max, m) => Math.max(max, m.meta.priority ?? 0), 0) +
        (metas.length > 0 ? 1 : 0);
      await this.writeSecret(join(this.slot(id), CREDENTIALS), live);
      await this.writeMeta(id, { name: normalized, priority, email, registeredAt: Date.now() });
      await this.writeSecret(join(this.accountsDir, CURRENT), Buffer.from(`${id}\n`));
      return { ok: true };
    });
  }

  /**
   * `id` のアカウントへ切り替える。
   *
   * 1. 稼働中のアカウントの退避先へ、今の `.credentials.json` を書き戻す（refresh tokenが
   *    入れ替わっていても新しい方を残す）
   * 2. 切り替え先の認証ファイルを `.credentials.json` へ写す
   * 3. `.current` を更新する
   *
   * `liveEmail` は今ログインしているアカウントのメールアドレス（`claude auth status`）。
   * 稼働中として記録したアカウントと違う（`/login` で別アカウントに入った後など）ときは、
   * 書き戻すと別人の認証で上書きしてしまうため切り替えない。
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
      const live = await readOptional(this.liveCredentials);
      if (live !== undefined) {
        const unsaved = await this.checkLiveIsSaved(current, live, liveEmail);
        if (unsaved !== undefined) {
          return { ok: false, reason: unsaved };
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
        const target = await readFile(join(this.slot(id), CREDENTIALS));
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
        return {
          ok: false,
          reason: `認証ファイルは切り替えましたが、.current の更新で止まりました: ${errorMessage(e)}`,
        };
      }
      return { ok: true };
    });
  }

  /**
   * 今の `.credentials.json` が登録済みのどれかとして残っているかを確かめる。
   * 残っていなければ、切り替えると失われるため理由を返す。
   */
  private async checkLiveIsSaved(
    current: string | undefined,
    live: Buffer,
    liveEmail: string | undefined,
  ): Promise<string | undefined> {
    if (current !== undefined) {
      const meta = await this.readMeta(current);
      if (meta.email !== undefined && liveEmail !== undefined && meta.email !== liveEmail) {
        return `今ログインしているアカウント（${liveEmail}）は、稼働中として記録した「${meta.name ?? current}」（${meta.email}）と違います。先に「今のアカウントを登録」で登録してください`;
      }
      return undefined;
    }
    // `.current` が無い（または登録が消えた）ときは、中身が同じ退避ファイルがあれば失われない
    for (const id of await this.registeredIds()) {
      const saved = await readOptional(join(this.slot(id), CREDENTIALS));
      if (saved !== undefined && saved.equals(live)) {
        return undefined;
      }
    }
    return '今ログインしているアカウントが登録されていないため、切り替えると認証情報が失われます。先に「今のアカウントを登録」で登録してください';
  }

  rename(id: string, name: string): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if (!(await this.isRegistered(id))) {
        return { ok: false, reason: `「${id}」は登録されていません` };
      }
      const normalized = normalizeAccountName(name);
      if (normalized === undefined) {
        return {
          ok: false,
          reason: `表示名は1〜${MAX_NAME_LENGTH}文字で、改行を含めないでください`,
        };
      }
      const meta = await this.readMeta(id);
      await this.writeMeta(id, { ...meta, name: normalized });
      return { ok: true };
    });
  }

  /** 優先度を1つ上げる（`up`）か下げる（`down`）。並びを0から振り直して `meta.json` へ残す。 */
  move(id: string, direction: 'up' | 'down'): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if (!(await this.isRegistered(id))) {
        return { ok: false, reason: `「${id}」は登録されていません` };
      }
      const current = await this.readCurrent();
      const ordered = sortByPriority(
        await Promise.all((await this.registeredIds()).map((i) => this.view(i, current))),
      );
      const index = ordered.findIndex((a) => a.id === id);
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= ordered.length) {
        return { ok: true };
      }
      [ordered[index], ordered[swapWith]] = [ordered[swapWith]!, ordered[index]!];
      for (const [priority, account] of ordered.entries()) {
        const meta = await this.readMeta(account.id);
        if (meta.priority !== priority) {
          await this.writeMeta(account.id, { ...meta, priority });
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

  /** 表示名（`meta.json` が無ければ `<id>`）。確認ダイアログに出す。 */
  async displayName(id: string): Promise<string> {
    return (await this.readMeta(id)).name ?? id;
  }

  /** 書き換えを1本ずつ通し、途中で投げた例外は理由として返す。 */
  private serialized(task: () => Promise<AccountStoreResult>): Promise<AccountStoreResult> {
    const guarded = (): Promise<AccountStoreResult> =>
      task().catch((e: unknown) => ({ ok: false, reason: errorMessage(e) }));
    const run = this.queue.then(guarded, guarded);
    this.queue = run;
    return run;
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

  private async readMeta(id: string): Promise<AccountMeta> {
    const parsed = await readJson(join(this.slot(id), META));
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const raw = parsed as Record<string, unknown>;
    const name = typeof raw['name'] === 'string' ? normalizeAccountName(raw['name']) : undefined;
    return {
      name,
      priority: Number.isSafeInteger(raw['priority']) ? (raw['priority'] as number) : undefined,
      email: typeof raw['email'] === 'string' ? raw['email'] : undefined,
      registeredAt: typeof raw['registeredAt'] === 'number' ? raw['registeredAt'] : undefined,
    };
  }

  /** `usage.json`（`{ t, limits: { '5h': {pct, resetsAt}, 'week:all models': ... } }`）を読む。 */
  private async readUsage(id: string): Promise<SavedAccountUsage | undefined> {
    const parsed = await readJson(join(this.slot(id), USAGE));
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

  private async writeMeta(id: string, meta: AccountMeta): Promise<void> {
    await this.writeSecret(join(this.slot(id), META), Buffer.from(`${JSON.stringify(meta)}\n`));
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
   * 0600で一時ファイルへ書いてからrenameする（書きかけを読ませない）。
   * 置き場のディレクトリは0700にそろえる。
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
      await writeFile(tmp, data, { mode: 0o600 });
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

/** 壊れたJSONや読めないファイルは無いものとして扱う（スクリプトと同じ）。 */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
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
