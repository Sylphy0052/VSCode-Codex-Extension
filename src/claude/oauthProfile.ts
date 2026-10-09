/**
 * 認証ファイルのaccess tokenが、どのアカウントのものかを確かめる（Issue #1930）。
 *
 * `claude auth status` のメールアドレスは `~/.claude.json` の `oauthAccount` から読まれ、
 * `.credentials.json` を差し替えても変わらない（CLI 2.1.295で確認）。そのため照合には使えず、
 * CLIがログイン時に呼ぶのと同じ `/api/oauth/profile` をaccess tokenで呼んで確かめる。
 * access tokenを使うだけで、refresh tokenは使わない（トークンを入れ替えない）。
 */

/** アカウントの同一性。`accountUuid` と `organizationUuid` の組で見分ける。 */
export interface AccountIdentity {
  accountUuid: string;
  organizationUuid: string;
  email: string;
  organizationName: string | undefined;
}

export type IdentifyAccount = (accessToken: string) => Promise<AccountIdentity | undefined>;

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TIMEOUT_MS = 10_000;

export function sameIdentity(
  a: Pick<AccountIdentity, 'accountUuid' | 'organizationUuid'>,
  b: Pick<AccountIdentity, 'accountUuid' | 'organizationUuid'>,
): boolean {
  return a.accountUuid === b.accountUuid && a.organizationUuid === b.organizationUuid;
}

/**
 * profileを取る。期限切れ・通信失敗・想定外の応答は `undefined`（照合できない側へ倒す）。
 * `warn` に渡すのはHTTPの状態や例外の文言だけで、トークンは含めない。
 */
export function createProfileIdentifier(warn: (message: string) => void): IdentifyAccount {
  return async (accessToken) => {
    try {
      const response = await fetch(PROFILE_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        warn(`アカウントのprofileを取得できませんでした: HTTP ${String(response.status)}`);
        return undefined;
      }
      const identity = parseProfile(await response.json());
      if (identity === undefined) {
        warn('アカウントのprofileを取得できませんでした: 応答の形が想定外でした');
      }
      return identity;
    } catch (e) {
      warn(`アカウントのprofileを取得できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
}

/** `{ account: { uuid, email }, organization: { uuid, name } }` を読む。 */
export function parseProfile(data: unknown): AccountIdentity | undefined {
  const account = rec(rec(data)?.['account']);
  const organization = rec(rec(data)?.['organization']);
  const accountUuid = account?.['uuid'];
  const email = account?.['email'];
  const organizationUuid = organization?.['uuid'];
  const organizationName = organization?.['name'];
  if (
    typeof accountUuid !== 'string' ||
    accountUuid === '' ||
    typeof email !== 'string' ||
    email === '' ||
    typeof organizationUuid !== 'string' ||
    organizationUuid === ''
  ) {
    return undefined;
  }
  return {
    accountUuid,
    organizationUuid,
    email,
    organizationName:
      typeof organizationName === 'string' && organizationName !== '' ? organizationName : undefined,
  };
}

/** 認証ファイルからaccess tokenだけを取り出す。期限切れなら `undefined`（呼んでも401になる）。 */
export function readAccessToken(credentials: Buffer, nowMs: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentials.toString('utf8'));
  } catch {
    return undefined;
  }
  const oauth = rec(rec(parsed)?.['claudeAiOauth']);
  const token = oauth?.['accessToken'];
  const expiresAt = oauth?.['expiresAt'];
  if (typeof token !== 'string' || token === '') {
    return undefined;
  }
  if (typeof expiresAt === 'number' && expiresAt <= nowMs) {
    return undefined;
  }
  return token;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
