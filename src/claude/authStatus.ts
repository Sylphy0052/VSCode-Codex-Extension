import type { AccountView } from '../provider/account';

/**
 * `claude auth status --json` からログイン状態を組み立てる（issue #29、design.mdのTP-53）。
 *
 * Phase 0（issue #1 Z-07）のコメントでは `initialize` のcontrol_responseに載る `account`
 * （`{email, organization, subscriptionType, apiProvider}`）を読む想定だったが、実装時に
 * `claude auth status --json` という専用サブコマンドが見つかった（`claude auth --help` で
 * 確認）。こちらは `loggedIn` の真偽値を明示的に持ち、`initialize` より未ログイン判定が
 * 確実なため、この専用サブコマンドを使う。
 *
 * 実測（CLI 2.1.227、ログイン済みの場合）:
 * `{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email, orgId,
 * orgName, subscriptionType: 'max' }`。
 *
 * **未ログイン時の応答形は未実測**（この環境ではログイン済みのため確認できなかった）。
 * `loggedIn` フィールドの有無・真偽だけで判定する防御的な実装にしている。
 */
export function parseAuthStatusJson(text: string): AccountView | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const body = rec(data);
  if (body === undefined) {
    return undefined;
  }

  if (body['loggedIn'] !== true) {
    return { loggedIn: false, method: undefined, identity: undefined, plan: undefined };
  }

  const authMethod = str(body['authMethod']);
  const method =
    authMethod === 'claude.ai'
      ? 'Claude.aiサブスクリプション'
      : authMethod === 'console'
        ? 'Anthropic Console'
        : authMethod === ''
          ? undefined
          : authMethod;

  return {
    loggedIn: true,
    method,
    identity: strOrUndefined(body['email']),
    plan: strOrUndefined(body['subscriptionType']),
  };
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
