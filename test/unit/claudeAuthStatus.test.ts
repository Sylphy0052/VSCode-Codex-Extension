import { describe, expect, it } from 'vitest';
import { parseAuthStatusJson } from '../../src/claude/authStatus';

describe('parseAuthStatusJson', () => {
  it('ログイン済みの応答を読む（実測: claude 2.1.227の`claude auth status --json`）', () => {
    const view = parseAuthStatusJson(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'user@example.com',
        orgId: 'org-id',
        orgName: "user@example.com's Organization",
        subscriptionType: 'max',
      }),
    );
    expect(view).toEqual({
      loggedIn: true,
      method: 'Claude.aiサブスクリプション',
      identity: 'user@example.com',
      plan: 'max',
    });
  });

  it('Anthropic Consoleでのログインを読む（authMethodがconsoleの場合。スキーマ根拠: --help のオプション名）', () => {
    const view = parseAuthStatusJson(
      JSON.stringify({ loggedIn: true, authMethod: 'console', email: 'user@example.com' }),
    );
    expect(view).toEqual({
      loggedIn: true,
      method: 'Anthropic Console',
      identity: 'user@example.com',
      plan: undefined,
    });
  });

  it('loggedIn が false なら未ログイン扱いにする（未実測。falseの実際の応答形は確認していない防御的な実装）', () => {
    const view = parseAuthStatusJson(JSON.stringify({ loggedIn: false }));
    expect(view).toEqual({ loggedIn: false, method: undefined, identity: undefined, plan: undefined });
  });

  it('loggedIn フィールドが無い応答は未ログイン扱いにする', () => {
    const view = parseAuthStatusJson(JSON.stringify({}));
    expect(view).toEqual({ loggedIn: false, method: undefined, identity: undefined, plan: undefined });
  });

  it('壊れたJSONでは undefined を返す（呼び出し側が取得失敗として扱う）', () => {
    expect(parseAuthStatusJson('これはJSONではない')).toBeUndefined();
    expect(parseAuthStatusJson('')).toBeUndefined();
  });

  it('JSONだが配列やnullの場合も undefined を返す', () => {
    expect(parseAuthStatusJson('[1,2,3]')).toBeUndefined();
    expect(parseAuthStatusJson('null')).toBeUndefined();
  });

  it('未知のauthMethodはそのまま説明にする', () => {
    const view = parseAuthStatusJson(JSON.stringify({ loggedIn: true, authMethod: 'sso' }));
    expect(view).toEqual({ loggedIn: true, method: 'sso', identity: undefined, plan: undefined });
  });
});
