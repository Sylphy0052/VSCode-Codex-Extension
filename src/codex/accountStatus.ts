import type { AccountView } from '../provider/account';

/**
 * Codexの `account/read` からログイン状態を組み立てる（issue #29、design.mdのTP-53）。
 *
 * 実測（codex-cli 0.147.0。`codex app-server generate-json-schema --out` のスキーマも参照）:
 * `account/read`（`GetAccountParams { refreshToken? }` → `GetAccountResponse { account,
 * requiresOpenaiAuth }`）は**スレッドを開始していなくても呼べる**。
 *
 * `account` は `Account`（スキーマ定義）の判別共用体で、`type` が
 * `'chatgpt' | 'apiKey' | 'amazonBedrock'` のいずれか。ChatGPTアカウントでのログインは
 * 実測で確認済み。APIキー／Amazon Bedrockはスキーマ根拠のみ（この環境ではChatGPT
 * アカウントでログイン済みのため、他のtypeは実際には観測していない）。
 *
 * 秘密情報（トークン等）はこの応答にそもそも含まれない。`email` はアカウントの識別に
 * 必要な範囲として表示する（design.mdの受入基準どおり、それ以上は扱わない）。
 */
export function parseAccountRead(raw: unknown): AccountView {
  const account = rec(rec(raw)?.['account']);
  if (account === undefined) {
    return { loggedIn: false, method: undefined, identity: undefined, plan: undefined };
  }

  const type = str(account['type']);
  if (type === 'chatgpt') {
    return {
      loggedIn: true,
      method: 'ChatGPTアカウント',
      identity: strOrUndefined(account['email']),
      plan: strOrUndefined(account['planType']),
    };
  }
  if (type === 'apiKey') {
    return { loggedIn: true, method: 'APIキー', identity: undefined, plan: undefined };
  }
  if (type === 'amazonBedrock') {
    return { loggedIn: true, method: 'Amazon Bedrock', identity: undefined, plan: undefined };
  }
  // 未知のtypeも「読み取れた」範囲でログイン済みとして扱う。typeをそのまま説明にする
  return { loggedIn: true, method: type === '' ? undefined : type, identity: undefined, plan: undefined };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
