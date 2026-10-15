import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  link,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { isStandbyStale } from './accountPolicy';
import {
  type AccountIdentity,
  type IdentifyAccount,
  readAccessToken,
  sameIdentity,
} from './oauthProfile';
import type { UsageSlot, UsageSlots } from './usageText';

/**
 * Claude Codeの複数アカウントの登録・切り替え（Issue #1921）。
 *
 * 認証はアカウントに関係なく `<claudeHome>/.credentials.json` の1ファイルにある。
 * これをアカウントごとに `<claudeHome>/accounts/<id>/` へ退避し、差し替えて切り替える。
 * 保存先の形は検証用スクリプト（`~/.claude/bin/claude-account.sh`・
 * `claude-usage-watch.mjs`）とそろえてあり、どちらから操作しても同じ状態を読み書きする。
 *
 * アカウントの同一性は、認証ファイルのaccess tokenで取ったprofileの `accountUuid` と
 * `organizationUuid` で見分ける（Issue #1930）。`claude auth status` のメールアドレスは
 * `~/.claude.json` の `oauthAccount` から読まれ、認証ファイルを差し替えても変わらないため使わない。
 * 切り替えたときは `~/.claude.json` の `oauthAccount` も切り替え先のものへ差し替える。
 *
 * **トークンの中身は返さない**。認証ファイルはバイト列のまま写し、読むのはprofileの照合に
 * 使うaccess tokenだけ。中身を返却・ログ出力しない。画面へ返すのは `<id>`・表示名・
 * 優先度・メールアドレス・使用率の記録だけ。
 */

/** `<id>` として受け付ける形。ディレクトリ名になるため、パス区切りや `..` を通さない。 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID_RE.test(id) && id !== '.' && id !== '..';
}

/** webviewの登録ボタンの文言。失敗理由の案内でも同じ文言を指すため1か所で持つ。 */
export const REGISTER_CURRENT_ACCOUNT_LABEL = '今のアカウントを登録';

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
  /** profileで確かめたメールアドレス。確かめていなければ `undefined`。 */
  email: string | undefined;
  /** `.current` が指すアカウントか。 */
  current: boolean;
  usage: SavedAccountUsage | undefined;
}

export type SavedAccountsSnapshot =
  { ok: true; accounts: SavedAccountView[] } | { ok: false; reason: string };

export type AccountStoreResult =
  | {
      ok: true;
      /** 本体の操作は済んだが、付随する処理（`~/.claude.json` の更新など）が済まなかった理由。 */
      warning?: string;
    }
  | {
      ok: false;
      reason: string;
      /**
       * 稼働中のアカウントに同一性の記録が無いため照合できなかった（旧版やスクリプトで
       * 登録した後にトークンが更新された場合など）。利用者が `live` を稼働中のアカウントだと
       * 確かめれば、`adoptCurrent` で記録して切り替え直せる。
       */
      confirmCurrent?: {
        id: string;
        name: string;
        live: AccountIdentity;
        /** 認証ファイルのプラン（`subscriptionType`・`rateLimitTier`）。退避先と同じときだけ確認に回る。 */
        plan: string | undefined;
      };
    };

interface AccountMeta {
  name: string | undefined;
  priority: number | undefined;
  /** profileで確かめた同一性。旧版の `meta.json` は `email` だけを持ち、これは信用しない。 */
  identity: AccountIdentity | undefined;
}

/** `meta.json` の生の中身。スクリプトが足したキーを消さないよう、書き換えるキー以外は保つ。 */
type RawMeta = Record<string, unknown>;

const CREDENTIALS = '.credentials.json';
/** 書き戻しで上書きする前の退避ファイル。メールアドレスの一致だけで書き戻したときの取り違えに備える。 */
const CREDENTIALS_BACKUP = '.credentials.json.bak';
/** 待機中のアカウントの計測でCLIが更新したトークンを、書き戻せなかったときに残す先（Issue #1943）。 */
const CREDENTIALS_ROTATED = '.credentials.json.rotated';
const META = 'meta.json';
const USAGE = 'usage.json';
/** `usage.json` の `limits` のキー（スクリプトと同じ）。 */
const USAGE_KEYS: Record<keyof UsageSlots, string> = {
  fiveHour: '5h',
  weekly: 'week:all models',
};
/** `~/.claude.json` の `oauthAccount` の控え。切り替え時に `~/.claude.json` へ戻す。 */
const OAUTH_ACCOUNT = 'oauth-account.json';
const CURRENT = '.current';
/**
 * 待機中のアカウントを計測する一時的な `CLAUDE_CONFIG_DIR`（`accounts/@probe-XXXXXX`）の接頭辞。
 * `@` はアカウントIDに使えないので `registeredIds()` に拾われない（Issue #1943）。
 */
const PROBE_PREFIX = '@probe-';
/** 一時的な `CLAUDE_CONFIG_DIR` の中でCLIが読む全体設定。 */
const PROBE_GLOBAL_CONFIG = '.claude.json';
const RELOGIN_HINT = 'このアカウントは再ログインが要るかもしれません';
/** ウィンドウ（拡張ホスト）をまたいで書き換えを1本にするロック。新規作成（wx）で取る。 */
const LOCK = '.ext-op.lock';
/** 持ち主が落ちて残ったロックを奪うまでの時間。書き換えは数ファイルなので十分長い。 */
const STALE_LOCK_MS = 30_000;
/**
 * 待機中のアカウントの計測（CLIの起動を含み20秒を超えうる）の間、ロックの時刻を更新する
 * 間隔。古いロックとして奪われると、計測中の退避先を他のウィンドウがライブへ写しうる。
 */
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 100;
/** 照合できなかった旧版の登録を、同じ認証ファイルのまま照合し直すまでの間隔（通信失敗に備える）。 */
const REPAIR_RETRY_MS = 5 * 60_000;
/** CLIが `~/.claude.json` を書くときに取るロック（proper-lockfileのディレクトリ）を待つ時間。 */
const CONFIG_LOCK_WAIT_MS = 3_000;
const LIVE_CHANGED_REASON =
  '切り替えの途中でClaude Codeが認証ファイルを更新したため止めました。もう一度試してください';

export class ClaudeAccountStore {
  /** 同じウィンドウの中の書き換えを1本ずつ通す。 */
  private queue: Promise<AccountStoreResult> = Promise.resolve({ ok: true });
  /**
   * 同一性の記録が無い登録を照合し直した認証ファイル（sha256）。照合できなかったものを
   * 一覧の表示のたびに呼び直さない。認証ファイルが書き戻されて変われば、もう一度試す。
   */
  private readonly repairAttempted = new Map<string, { digest: string; at: number }>();

  /**
   * @param identify access tokenからprofileを取る（`createProfileIdentifier`）
   * @param globalConfigPath CLIの全体設定（通常 `~/.claude.json`）。`oauthAccount` を差し替える
   */
  constructor(
    private readonly claudeHome: string,
    private readonly identify: IdentifyAccount,
    private readonly globalConfigPath: string,
  ) {}

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
      await this.repairIdentities(ids);
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
   * 今ログインしているアカウントのメールアドレス（profileで確かめたもの）。登録の表示名の
   * 初期値に使う。取れなければ `undefined`。
   */
  async liveEmail(): Promise<string | undefined> {
    const live = await readOptional(this.liveCredentials).catch(() => undefined);
    return live === undefined ? undefined : (await this.identifyCredentials(live))?.email;
  }

  /**
   * 今の `.credentials.json` を新しいアカウントとして登録し、稼働中にする。
   * profileの同一性か認証ファイルの中身が登録済みのものと同じなら断る（二重登録を防ぐ）。
   * profileを取れないときは断る。中身の一致だけでは、トークンが更新された後の同じ
   * アカウントを見分けられないため。
   */
  register(name: string): Promise<AccountStoreResult> {
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
      const identity = await this.identifyCredentials(live);
      if (identity === undefined) {
        return {
          ok: false,
          reason:
            '今ログインしているアカウントを確かめられないため、登録済みのアカウントと重複していないか確かめられません。Claude Codeで一度やり取りしてから試してください',
        };
      }
      const ids = await this.registeredIds();
      let maxPriority = -1;
      for (const id of ids) {
        const meta = await this.readMeta(id);
        if (meta.identity !== undefined && sameIdentity(meta.identity, identity)) {
          return {
            ok: false,
            reason: `${describeIdentity(identity)}は「${meta.name ?? id}」として登録済みです`,
          };
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
          ...identityMeta(identity),
          registeredAt: Date.now(),
        });
        await this.writeSecret(join(this.accountsDir, CURRENT), Buffer.from(`${id}\n`));
      } catch (e) {
        // 一覧に名前の無い退避先を残さない
        await rm(this.slot(id), { recursive: true, force: true });
        throw e;
      }
      // ログインした直後なら `~/.claude.json` は今のアカウントのもの。切り替えで戻せるよう控える
      await this.snapshotOauthAccount(id, identity).catch(() => undefined);
      return { ok: true };
    });
  }

  /**
   * `id` のアカウントへ切り替える。
   *
   * 1. 今の `.credentials.json` を、その持ち主のアカウントの退避先へ書き戻す（refresh tokenが
   *    入れ替わっていても新しい方を残す）。持ち主はprofileの同一性で決める（`resolveLiveOwner`）
   * 2. 切り替え先の認証ファイルを `.credentials.json` へ写す
   * 3. `.current` を更新する。失敗したら2を元に戻す
   * 4. `~/.claude.json` の `oauthAccount` を切り替え先のものへ差し替える（失敗は `warning`）
   *
   * 今の認証の持ち主を確かめられないときは、書き戻すと別のアカウントの退避先を上書きしうる
   * ため切り替えない（稼働中のアカウントに同一性の記録が無いだけのときは `confirmCurrent`
   * を付けて返す）。
   */
  switchTo(id: string): Promise<AccountStoreResult> {
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
        const resolved = await this.resolveLiveOwner(current, live);
        if (!resolved.ok) {
          return resolved;
        }
        // profileを待つ間にCLIがトークンを更新していたら、古い方を書き戻すとrefresh tokenを失う
        if (!(await this.liveUnchanged(live))) {
          return { ok: false, reason: LIVE_CHANGED_REASON };
        }
        const { owner, identity } = resolved;
        try {
          await this.backupBeforeWriteBack(owner, live);
          await this.writeSecret(join(this.slot(owner), CREDENTIALS), live);
          if (identity !== undefined) {
            await this.recordIdentity(owner, identity);
            await this.snapshotOauthAccount(owner, identity).catch(() => undefined);
          }
        } catch (e) {
          return {
            ok: false,
            reason: `稼働中のアカウントの書き戻しで止まりました: ${errorMessage(e)}`,
          };
        }
        if (owner === id) {
          // 今の認証が既に切り替え先のもの（別の端末で /login した後など）。退避した古い方で
          // 上書きせず、稼働中の記録だけを直す
          await this.writeSecret(join(this.accountsDir, CURRENT), Buffer.from(`${id}\n`));
          return this.withOauthAccountSynced(id);
        }
      }
      // 書き戻しの後にCLIが更新していたら、上書きすると新しいrefresh tokenを失う。退避先に
      // 書いた方は古くなるだけで、次の切り替えで新しい方が書き戻される
      if (!(await this.liveUnchanged(live))) {
        return { ok: false, reason: LIVE_CHANGED_REASON };
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
      return this.withOauthAccountSynced(id);
    });
  }

  /**
   * 稼働中のアカウントの使用率を `usage.json` へ記録する（スクリプトと同じ形）。
   * 取得している間にアカウントが切り替わっていたら、どちらの値か判らないので捨てる
   * （`expectedId` が今の稼働中と違うとき）。待機中のアカウントは `probeStandby` で記録する。
   */
  recordUsage(expectedId: string, slots: UsageSlots, nowMs: number): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if ((await this.currentId()) !== expectedId) {
        return { ok: false, reason: '取得中にアカウントが切り替わったため記録しませんでした' };
      }
      await this.writeSecret(join(this.slot(expectedId), USAGE), usageRecord(slots, nowMs));
      return { ok: true };
    });
  }

  /**
   * 待機中のアカウントの使用率を計測し、`usage.json` へ記録する（Issue #1943）。
   *
   * CLIの `/usage` はライブの認証でしか動かないため、対象の認証ファイルを一時的な
   * `CLAUDE_CONFIG_DIR`（`accounts/@probe-XXXXXX`）へ写し、`measure` にそこでCLIを走らせる。
   * CLIがトークンをローテーションしていれば、確かめてから退避先へ書き戻す。
   * 書き戻しが終わるまでロックを持つ。計測中に `switchTo` が同じ退避先をライブへ写すと、
   * 計測側のrefreshで写した側のrefresh tokenが無効になるため。
   *
   * 稼働中・ライブと同じログイン・記録が新しいアカウントは何もせず `ok: true` を返す。
   * 記録の新しさはロックの中で見直すので、複数のウィンドウが同じアカウントを続けて測らない。
   */
  probeStandby(
    id: string,
    measure: (configDir: string) => Promise<UsageSlots | undefined>,
    nowMs: number,
  ): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      const leftover = await this.removeProbeDirs();
      const current = await this.readCurrent();
      if (
        id === current ||
        !(await this.isRegistered(id)) ||
        !isStandbyStale(await this.view(id, current), nowMs)
      ) {
        return withWarning({ ok: true }, leftover);
      }
      const saved = await readOptional(join(this.slot(id), CREDENTIALS));
      const savedRefresh = saved === undefined ? undefined : refreshTokenOf(saved);
      if (saved === undefined || savedRefresh === undefined) {
        return withWarning(
          { ok: false, reason: `「${id}」の退避先の認証ファイルを読めないため計測しませんでした` },
          leftover,
        );
      }
      // `.current` が実体とずれていても、ライブと同じログインを測るとrefreshでライブの
      // トークンを無効にしうる。ライブは既存のprobeが測るので、ここでは触らない。
      // 持ち主の判定（`resolveLiveOwner`）は通信するため、refresh tokenの一致で代える
      const live = await readOptional(this.liveCredentials).catch(() => undefined);
      if (live !== undefined && refreshTokenOf(live) === savedRefresh) {
        return withWarning({ ok: true }, leftover);
      }
      const oauthBuf = await readOptional(join(this.slot(id), OAUTH_ACCOUNT)).catch(
        () => undefined,
      );
      const oauthAccount = oauthBuf === undefined ? undefined : asRecord(parseJson(oauthBuf));

      await this.rejectSymlinkDirs(this.accountsDir);
      const dir = await mkdtemp(join(this.accountsDir, PROBE_PREFIX));
      let result: AccountStoreResult;
      try {
        result = await this.measureInProbeDir(id, dir, saved, oauthAccount, measure, nowMs);
      } catch (e) {
        result = { ok: false, reason: `「${id}」を計測できませんでした: ${errorMessage(e)}` };
      }
      const removeFailure = await rm(dir, { recursive: true, force: true }).then(
        () => undefined,
        (e: unknown) => `一時ディレクトリ${shortenHome(dir)}を消せませんでした: ${errorMessage(e)}`,
      );
      return withWarning(withWarning(result, leftover), removeFailure);
    });
  }

  /**
   * 拡張が計測の途中で落ちて残った一時ディレクトリ（`accounts/@probe-*`）を消す。中に認証が
   * 残っているため、起動時に呼ぶ。他のウィンドウの計測中のものを消さないようロックを取る。
   */
  async cleanupProbeDirs(): Promise<AccountStoreResult> {
    // アカウントを使っていない環境に、ロックのためだけの `accounts/` を作らない
    if (!(await exists(this.accountsDir))) {
      return { ok: true };
    }
    return this.serialized(async () => withWarning({ ok: true }, await this.removeProbeDirs()));
  }

  /** 一時ディレクトリへ認証を写してCLIを走らせ、書き戻しと記録までを行う。 */
  private async measureInProbeDir(
    id: string,
    dir: string,
    saved: Buffer,
    oauthAccount: Record<string, unknown> | undefined,
    measure: (configDir: string) => Promise<UsageSlots | undefined>,
    nowMs: number,
  ): Promise<AccountStoreResult> {
    // mkdtempの既定も0700だが、umaskに頼らずそろえる
    await chmod(dir, 0o700);
    const probeCredentials = join(dir, CREDENTIALS);
    await writeFile(probeCredentials, saved, { mode: 0o600, flag: 'wx' });
    const config = oauthAccount === undefined ? {} : { oauthAccount };
    await writeFile(join(dir, PROBE_GLOBAL_CONFIG), Buffer.from(`${JSON.stringify(config)}\n`), {
      mode: 0o600,
      flag: 'wx',
    });
    const lock = join(this.accountsDir, LOCK);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lock, now, now).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    // 計測が失敗しても、途中でローテーションしたトークンは書き戻す
    const slots = await measure(dir)
      .catch(() => undefined)
      .finally(() => clearInterval(heartbeat));
    const writeBackFailure = await this.writeBackProbeCredentials(id, saved, probeCredentials);
    if (slots === undefined) {
      return withWarning(
        { ok: false, reason: `「${id}」の使用率を計測できませんでした` },
        writeBackFailure,
      );
    }
    await this.writeSecret(join(this.slot(id), USAGE), usageRecord(slots, nowMs));
    return withWarning({ ok: true }, writeBackFailure);
  }

  /**
   * 計測中にCLIがローテーションした認証を退避先へ書き戻す。書き戻さなかったとき・
   * 書き戻せなかったときは理由を返す（トークンやファイルの中身は含めない）。
   */
  private async writeBackProbeCredentials(
    id: string,
    saved: Buffer,
    probeCredentials: string,
  ): Promise<string | undefined> {
    let rotated: Buffer | undefined;
    try {
      rotated = await readOptional(probeCredentials);
    } catch (e) {
      return `「${id}」の一時ディレクトリの認証ファイルを読めないため書き戻しませんでした（${RELOGIN_HINT}）: ${errorMessage(e)}`;
    }
    if (rotated?.equals(saved) === true) {
      return undefined;
    }
    if (rotated === undefined || refreshTokenOf(rotated) === undefined) {
      return `「${id}」の一時ディレクトリの認証ファイルが無いか壊れているため書き戻しませんでした（${RELOGIN_HINT}）`;
    }
    const target = join(this.slot(id), CREDENTIALS);
    const stored = await readOptional(target).catch(() => undefined);
    if (stored?.equals(saved) !== true) {
      // ロックを取らない外部のスクリプトが書き換えた。どちらが新しいか判らないので触らない
      return `「${id}」の退避先が計測中に書き換えられたため、更新されたトークンを書き戻しませんでした（${await this.keepRotated(id, probeCredentials)}）`;
    }
    try {
      await this.backupBeforeWriteBack(id, rotated);
      await this.writeSecret(target, rotated);
    } catch (e) {
      return `「${id}」の更新されたトークンを退避先へ書き戻せませんでした（${await this.keepRotated(id, probeCredentials)}）: ${errorMessage(e)}`;
    }
    return undefined;
  }

  /**
   * 書き戻せなかった更新後のトークンを、一時ディレクトリと一緒に消さずに退避先の隣へ移す。
   * 古いトークンは無効になっているので、消すと再ログインするしかなくなる。同じファイル
   * システム内のrenameなので、ディスクが一杯でも移せる。結果を利用者向けの一文で返す。
   */
  private async keepRotated(id: string, probeCredentials: string): Promise<string> {
    const kept = join(this.slot(id), CREDENTIALS_ROTATED);
    try {
      // CLIが緩いモードで書き直していても、他のユーザーに読めない形で残す
      await chmod(probeCredentials, 0o600);
      await rename(probeCredentials, kept);
      return `更新されたトークンを${shortenHome(kept)}に残しました。${CREDENTIALS}へ置き換えると再ログインせずに済みます`;
    } catch {
      return RELOGIN_HINT;
    }
  }

  /** `accounts/@probe-*` を消す。消せなかったものがあれば理由を返す。 */
  private async removeProbeDirs(): Promise<string | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.accountsDir);
    } catch (e) {
      if (isNotFound(e)) {
        return undefined;
      }
      throw e;
    }
    const failed: string[] = [];
    for (const name of entries.filter((n) => n.startsWith(PROBE_PREFIX))) {
      const path = join(this.accountsDir, name);
      await rm(path, { recursive: true, force: true }).catch(() => failed.push(shortenHome(path)));
    }
    return failed.length === 0
      ? undefined
      : `計測用の一時ディレクトリを消せませんでした: ${failed.join(', ')}`;
  }

  /**
   * 稼働中のアカウントが上限で止まったことを `usage.json` へ記録する（Issue #1937）。
   * `slots` の枠だけを使用率100%・解除時刻 `resetsAt`（epochミリ秒）に置き換え、他の枠は残す。
   * 止まったアカウントは `/usage` を取り直すまで記録が古いままになり、リセット時刻を過ぎた
   * 枠が空いているとみなされて、上限中のまま切替先に選ばれてしまうため。
   */
  recordLimitHit(
    expectedId: string,
    slots: readonly (keyof UsageSlots)[],
    resetsAt: number,
    nowMs: number,
  ): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if ((await this.currentId()) !== expectedId) {
        return { ok: false, reason: '稼働中のアカウントが切り替わったため記録しませんでした' };
      }
      const path = join(this.slot(expectedId), USAGE);
      const buf = await readOptional(path).catch(() => undefined);
      const parsed = buf === undefined ? undefined : parseJson(buf);
      const previous =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)['limits']
          : undefined;
      const limits: Record<string, unknown> =
        typeof previous === 'object' && previous !== null ? { ...previous } : {};
      const hit: UsageSlot = { pct: 100, resetsAt };
      for (const slot of slots) {
        limits[USAGE_KEYS[slot]] = hit;
      }
      await this.writeSecret(path, Buffer.from(`${JSON.stringify({ t: nowMs, limits })}\n`));
      return { ok: true };
    });
  }

  /**
   * 稼働中のアカウントに、今ログインしているアカウントの同一性を記録する。利用者が確認
   * ダイアログで `confirmed` を稼働中のアカウントだと確かめた後にだけ呼ぶ（`switchTo` の
   * `confirmCurrent`）。確認を待つ間にログイン中のアカウントが変わっていたら記録しない。
   */
  adoptCurrent(id: string, confirmed: AccountIdentity): Promise<AccountStoreResult> {
    return this.serialized(async () => {
      if ((await this.currentId()) !== id) {
        return { ok: false, reason: '稼働中のアカウントが変わりました。もう一度試してください' };
      }
      const live = await readOptional(this.liveCredentials);
      const identity = live === undefined ? undefined : await this.identifyCredentials(live);
      if (identity === undefined || !sameIdentity(identity, confirmed)) {
        return {
          ok: false,
          reason: '確認の間にログイン中のアカウントが変わりました。もう一度試してください',
        };
      }
      const recorded = (await this.readMeta(id)).identity;
      if (recorded !== undefined && !sameIdentity(recorded, identity)) {
        return {
          ok: false,
          reason: `「${id}」には別のアカウント（${describeIdentity(recorded)}）が記録されています`,
        };
      }
      for (const other of await this.registeredIds()) {
        const meta = other === id ? undefined : await this.readMeta(other);
        if (meta?.identity !== undefined && sameIdentity(meta.identity, identity)) {
          return {
            ok: false,
            reason: `${describeIdentity(identity)}は「${meta.name ?? other}」として登録済みです`,
          };
        }
      }
      await this.recordIdentity(id, identity);
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
   * 今の `.credentials.json` の持ち主（書き戻し先）を決める。
   *
   * - profileを取れたら、同一性が一致する登録を持ち主とする（稼働中の記録を優先）。CLIによる
   *   上書きや別の端末での `/login` の後でも、退避先を取り違えない
   * - 一致する登録が無くても、中身が同じで同一性が未記録の退避ファイルがあればそれ
   * - どれでもなく、稼働中のアカウントに同一性の記録が無ければ `confirmCurrent` を付けて断る
   * - profileを取れず、中身が同じ退避ファイルも無ければ断る
   */
  private async resolveLiveOwner(
    current: string | undefined,
    live: Buffer,
  ): Promise<
    | { ok: true; owner: string; identity: AccountIdentity | undefined }
    | Extract<AccountStoreResult, { ok: false }>
  > {
    const identity = await this.identifyCredentials(live);
    const ids = await this.registeredIds();
    // 同じ同一性の登録が複数あれば稼働中の記録を選ぶ
    const ordered = current === undefined ? ids : [current, ...ids.filter((i) => i !== current)];
    if (identity !== undefined) {
      for (const id of ordered) {
        const recorded = (await this.readMeta(id)).identity;
        if (recorded !== undefined && sameIdentity(recorded, identity)) {
          return { ok: true, owner: id, identity };
        }
      }
    }
    for (const id of ordered) {
      if ((await readOptional(join(this.slot(id), CREDENTIALS)))?.equals(live) === true) {
        // 中身が同じなのに別の同一性が記録されていれば、どちらかが誤っているので書き戻さない
        if (identity === undefined || (await this.readMeta(id)).identity === undefined) {
          return { ok: true, owner: id, identity };
        }
      }
    }
    if (current === undefined) {
      return {
        ok: false,
        reason: `今ログインしているアカウントが登録されていないため、切り替えると認証情報が失われます。先に「${REGISTER_CURRENT_ACCOUNT_LABEL}」で登録してください`,
      };
    }
    const meta = await this.readMeta(current);
    const name = meta.name ?? current;
    if (identity === undefined) {
      return {
        ok: false,
        reason: `今ログインしているアカウントを確かめられないため、稼働中として記録した「${name}」と同じか確かめられません。別のアカウントの退避先を上書きしないよう切り替えを止めました。Claude Codeで一度やり取りしてから試してください`,
      };
    }
    if (meta.identity === undefined) {
      // 利用者の確認だけで書き戻す経路なので、機械的に違うと分かるものは確認に回さない。
      // 壊れた `meta.json` の登録が本当の持ち主かもしれないときも断る（readRawMetaが投げる）
      for (const other of ids) {
        await this.readRawMeta(other);
      }
      const savedCurrent = await readOptional(join(this.slot(current), CREDENTIALS));
      const savedPlan = savedCurrent === undefined ? undefined : readPlan(savedCurrent);
      const livePlan = readPlan(live);
      if (savedPlan !== undefined && livePlan !== undefined && savedPlan !== livePlan) {
        return {
          ok: false,
          reason: `今ログインしているアカウント（${describeIdentity(identity)}・${livePlan}）は、稼働中として記録した「${name}」（${savedPlan}）とプランが違います。切り替えると認証情報が失われるため止めました。先に「${REGISTER_CURRENT_ACCOUNT_LABEL}」で登録してください（同じアカウントでプランを変えた場合は、登録した後に「${name}」を削除してください）`,
        };
      }
      return {
        ok: false,
        reason: `稼働中として記録した「${name}」にアカウントの記録が無く、今ログインしているアカウント（${describeIdentity(identity)}）と同じか確かめられません`,
        confirmCurrent: { id: current, name, live: identity, plan: livePlan },
      };
    }
    return {
      ok: false,
      reason: `今ログインしているアカウント（${describeIdentity(identity)}）は登録されていないため、切り替えると認証情報が失われます。先に「${REGISTER_CURRENT_ACCOUNT_LABEL}」で登録してください`,
    };
  }

  /** 認証ファイルのaccess tokenでprofileを取る。期限切れ・取得失敗は `undefined`。 */
  private async identifyCredentials(credentials: Buffer): Promise<AccountIdentity | undefined> {
    const token = readAccessToken(credentials, Date.now());
    return token === undefined ? undefined : this.identify(token);
  }

  /** 同一性を `meta.json` へ記録する。同じ内容なら書かない。 */
  private async recordIdentity(id: string, identity: AccountIdentity): Promise<void> {
    const recorded = (await this.readMeta(id)).identity;
    if (
      recorded !== undefined &&
      sameIdentity(recorded, identity) &&
      recorded.email === identity.email &&
      recorded.organizationName === identity.organizationName
    ) {
      return;
    }
    await this.writeMeta(id, identityMeta(identity));
  }

  /**
   * 同一性の記録が無い登録（旧版で登録したもの）を、退避した認証ファイルのaccess tokenで
   * 照合し直す。照合できなかった認証ファイルは、書き戻されて中身が変わるか `REPAIR_RETRY_MS`
   * 経つまで呼び直さない。他の登録と同一性がぶつかるときは記録しない。書き換えのロックの外から呼ぶ。
   */
  private async repairIdentities(ids: string[]): Promise<void> {
    // 1件ごとに通信を待つと一覧の表示が件数分遅れるため、まとめて照合する
    await Promise.all(ids.map((id) => this.repairIdentity(id)));
  }

  private async repairIdentity(id: string): Promise<void> {
    if ((await this.readMeta(id)).identity !== undefined) {
      return;
    }
    const saved = await readOptional(join(this.slot(id), CREDENTIALS)).catch(() => undefined);
    if (saved === undefined) {
      return;
    }
    const digest = createHash('sha256').update(saved).digest('hex');
    const attempted = this.repairAttempted.get(id);
    if (attempted?.digest === digest && Date.now() - attempted.at < REPAIR_RETRY_MS) {
      return;
    }
    this.repairAttempted.set(id, { digest, at: Date.now() });
    const identity = await this.identifyCredentials(saved);
    if (identity === undefined) {
      return;
    }
    await this.serialized(async () => {
      // 照合している間に書き戻されていたら、古い認証ファイルの結果なので記録しない
      const now = await readOptional(join(this.slot(id), CREDENTIALS));
      if (now?.equals(saved) !== true || (await this.readMeta(id)).identity !== undefined) {
        return { ok: true };
      }
      for (const other of await this.registeredIds()) {
        const recorded = other === id ? undefined : (await this.readMeta(other)).identity;
        if (recorded !== undefined && sameIdentity(recorded, identity)) {
          return { ok: true };
        }
      }
      await this.recordIdentity(id, identity);
      return { ok: true };
    });
  }

  /**
   * `~/.claude.json` の `oauthAccount` が `identity` のものなら、`id` の退避先へ控える。
   * 切り替えで戻すときに、CLIがログイン時に書いた形をそのまま使うため。
   */
  private async snapshotOauthAccount(id: string, identity: AccountIdentity): Promise<void> {
    const config = asRecord(parseJson(await readFile(this.globalConfigPath)));
    const account = asRecord(config?.['oauthAccount']);
    if (account !== undefined && matchesIdentity(account, identity)) {
      await this.writeSecret(
        join(this.slot(id), OAUTH_ACCOUNT),
        Buffer.from(`${JSON.stringify(account)}\n`),
      );
    }
  }

  /**
   * `~/.claude.json` の `oauthAccount` を `id` のものへ差し替える（切り替えの最後）。控えが
   * あればそれを、無ければ記録した同一性から最小の形を作る。他のキーは保つ。差し替えられ
   * なくても切り替え自体は済んでいるので、`warning` を付けて `ok` で返す。
   *
   * CLIは `~/.claude.json` を頻繁に書き換える。CLIと同じロック（`~/.claude.json.lock`）を取り、
   * その中で読み直して書く。CLIもロックの中で読み直してから自分の変更だけを当てるため、
   * 互いの変更を消さない。
   */
  private async withOauthAccountSynced(id: string): Promise<AccountStoreResult> {
    const identity = (await this.readMeta(id)).identity;
    if (identity === undefined) {
      return {
        ok: true,
        warning: `切り替え先のアカウントを確かめられていないため、~/.claude.jsonのアカウント表示を差し替えませんでした（Claude Codeの表示するメールアドレスは古いままです。一覧でメールアドレスが確かめられた後に切り替え直すと直ります）`,
      };
    }
    const saved = await readOptional(join(this.slot(id), OAUTH_ACCOUNT)).catch(() => undefined);
    const snapshot = saved === undefined ? undefined : asRecord(parseJson(saved));
    const oauthAccount =
      snapshot !== undefined && matchesIdentity(snapshot, identity)
        ? snapshot
        : {
            accountUuid: identity.accountUuid,
            emailAddress: identity.email,
            organizationUuid: identity.organizationUuid,
            ...(identity.organizationName === undefined
              ? {}
              : { organizationName: identity.organizationName }),
          };
    try {
      return await withCliConfigLock(this.globalConfigPath, async () => {
        const info = await lstat(this.globalConfigPath);
        if (info.isSymbolicLink()) {
          return {
            ok: true,
            warning:
              '~/.claude.jsonがシンボリックリンクのため、アカウント表示を差し替えませんでした',
          };
        }
        const config = asRecord(parseJson(await readFile(this.globalConfigPath)));
        if (config === undefined) {
          return {
            ok: true,
            warning: '~/.claude.jsonを解釈できないため、アカウント表示を差し替えませんでした',
          };
        }
        const present = asRecord(config['oauthAccount']);
        if (present !== undefined && matchesIdentity(present, identity)) {
          return { ok: true };
        }
        await replaceFile(
          this.globalConfigPath,
          Buffer.from(`${JSON.stringify({ ...config, oauthAccount }, null, 2)}\n`),
          info.mode & 0o777,
        );
        return { ok: true };
      });
    } catch (e) {
      return {
        ok: true,
        warning: `~/.claude.jsonのアカウント表示を差し替えられませんでした: ${errorMessage(e)}`,
      };
    }
  }

  /**
   * 書き戻しで上書きする前の退避ファイルを `.credentials.json.bak` へ残す。持ち主の判定を
   * 誤ったときに、上書きされた側の認証を取り戻せるようにする。中身が同じなら残さない。
   */
  private async backupBeforeWriteBack(id: string, live: Buffer): Promise<void> {
    const saved = await readOptional(join(this.slot(id), CREDENTIALS));
    if (saved !== undefined && !saved.equals(live)) {
      await this.writeSecret(join(this.slot(id), CREDENTIALS_BACKUP), saved);
    }
  }

  /** `.credentials.json` が `previous` を読んだときのままか。CLIは拡張のロックを取らずに書き換える。 */
  private async liveUnchanged(previous: Buffer | undefined): Promise<boolean> {
    const now = await readOptional(this.liveCredentials);
    return previous === undefined ? now === undefined : now?.equals(previous) === true;
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
   * 同時操作も `accounts/.ext-op.lock` で1本にする（検証スクリプトの `save`・`use` も同じロックを取る）。
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
      for (const file of [CREDENTIALS, CREDENTIALS_BACKUP, META, USAGE, OAUTH_ACCOUNT]) {
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
      email: meta.identity?.email,
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
      identity: parseIdentityMeta(raw),
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
      fiveHour: parseLimit(byKey[USAGE_KEYS.fiveHour]),
      weekly: parseLimit(byKey[USAGE_KEYS.weekly]),
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
    await this.rejectSymlinkDirs(dir);
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

  /**
   * `<claudeHome>` より下の置き場（`accounts/`・`accounts/<id>/`）がシンボリックリンクなら断る。
   * `chmod` や書き込みがリンク先へ及び、退避先の外のディレクトリを0700にしたり認証を置いたりするため。
   */
  private async rejectSymlinkDirs(dir: string): Promise<void> {
    // 末尾の `/` などで文字列が一致せず `<claudeHome>` より上まで遡らないよう、正規化した形で比べる
    const root = resolvePath(this.claudeHome);
    for (let d = resolvePath(dir); d !== root && d !== dirname(d); d = dirname(d)) {
      if ((await lstat(d)).isSymbolicLink()) {
        throw new Error(`${d}がシンボリックリンクのため書き込みませんでした`);
      }
    }
  }
}

/**
 * `meta.json` へ書く同一性のキー。`email` はスクリプトと共有する表示用のキー。組織名が
 * 無くなったときに古い値を残さないよう、`null` で上書きする。
 */
function identityMeta(identity: AccountIdentity): RawMeta {
  return {
    email: identity.email,
    accountUuid: identity.accountUuid,
    organizationUuid: identity.organizationUuid,
    organizationName: identity.organizationName ?? null,
  };
}

/** 認証ファイルのプラン（`subscriptionType`・`rateLimitTier`）。トークンは返さない。 */
function readPlan(credentials: Buffer): string | undefined {
  const oauth = asRecord(asRecord(parseJson(credentials))?.['claudeAiOauth']);
  const parts = [oauth?.['subscriptionType'], oauth?.['rateLimitTier']].filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  return parts.length === 0 ? undefined : parts.join('/');
}

/** `accountUuid` と `organizationUuid` がそろっているときだけ同一性として読む。 */
function parseIdentityMeta(raw: RawMeta): AccountIdentity | undefined {
  const { accountUuid, organizationUuid, email, organizationName } = raw;
  if (
    typeof accountUuid !== 'string' ||
    accountUuid === '' ||
    typeof organizationUuid !== 'string' ||
    organizationUuid === '' ||
    typeof email !== 'string'
  ) {
    return undefined;
  }
  return {
    accountUuid,
    organizationUuid,
    email,
    organizationName: typeof organizationName === 'string' ? organizationName : undefined,
  };
}

/** 確認ダイアログや理由に出すアカウントの説明（メールアドレスと組織名）。 */
export function describeIdentity(identity: AccountIdentity): string {
  return identity.organizationName === undefined
    ? identity.email
    : `${identity.email}・${identity.organizationName}`;
}

/** `~/.claude.json` の `oauthAccount` の形のオブジェクトが `identity` のものか。 */
function matchesIdentity(account: Record<string, unknown>, identity: AccountIdentity): boolean {
  return (
    account['accountUuid'] === identity.accountUuid &&
    account['organizationUuid'] === identity.organizationUuid
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * CLIが全体設定を書くときに取るロック（proper-lockfileの `<path>.lock` ディレクトリ）を取って
 * `task` を走らせる。CLIが持っていれば待ち、取れなければ投げる（古いロックも奪わない。
 * 奪うかどうかの判断はCLIに任せる）。
 */
async function withCliConfigLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== 'EEXIST') {
        throw e;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        'Claude Codeが設定を書き換え中のため待ちきれませんでした（Claude Codeの表示するメールアドレスは、次に切り替えるまで古いままです）',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  // 持つのは読み書きの数msだけなので、CLIが古いとみなす10秒には届かない（mtimeは更新しない）
  try {
    return await task();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * CLIの全体設定を一時ファイル経由で置き換える。権限は元のファイルに合わせる（`writeSecret`
 * と違い、置き場（ホームディレクトリ）の権限は触らない）。
 */
async function replaceFile(path: string, data: Buffer, mode: number): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, data, { mode, flag: 'wx' });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
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

/** 認証ファイルのrefresh token。同じログインかどうかの比較にだけ使い、返却・ログ出力しない。 */
function refreshTokenOf(credentials: Buffer): string | undefined {
  const oauth = asRecord(asRecord(parseJson(credentials))?.['claudeAiOauth']);
  const token = oauth?.['refreshToken'];
  return typeof token === 'string' && token !== '' ? token : undefined;
}

/** `usage.json` の中身（スクリプトと同じ形）。 */
function usageRecord(slots: UsageSlots, nowMs: number): Buffer {
  const limits: Record<string, UsageSlot> = {};
  if (slots.fiveHour !== undefined) {
    limits[USAGE_KEYS.fiveHour] = slots.fiveHour;
  }
  if (slots.weekly !== undefined) {
    limits[USAGE_KEYS.weekly] = slots.weekly;
  }
  return Buffer.from(`${JSON.stringify({ t: nowMs, limits })}\n`);
}

/** 結果に付随する理由を足す。失敗なら `reason` へ続け、成功なら `warning` へ続ける。 */
function withWarning(result: AccountStoreResult, note: string | undefined): AccountStoreResult {
  if (note === undefined) {
    return result;
  }
  if (!result.ok) {
    return { ...result, reason: `${result.reason}。${note}` };
  }
  return { ...result, warning: result.warning === undefined ? note : `${result.warning}。${note}` };
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

/** 通知に出す失敗理由。fsのエラーが含むホームディレクトリの絶対パスは `~` に縮める。 */
function errorMessage(e: unknown): string {
  return shortenHome(e instanceof Error ? e.message : String(e));
}

/** ホームディレクトリの絶対パスを `~` に縮める。 */
function shortenHome(text: string): string {
  const home = homedir();
  return home.length > 1 ? text.split(home).join('~') : text;
}
