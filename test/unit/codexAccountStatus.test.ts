import { describe, expect, it } from 'vitest';
import { parseAccountRead } from '../../src/codex/accountStatus';

describe('parseAccountRead', () => {
  it('ChatGPTアカウントでログイン済みの応答を読む（実測: codex-cli 0.147.0）', () => {
    const view = parseAccountRead({
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'prolite' },
      requiresOpenaiAuth: true,
    });
    expect(view).toEqual({
      loggedIn: true,
      method: 'ChatGPTアカウント',
      identity: 'user@example.com',
      plan: 'prolite',
    });
  });

  it('APIキーでログイン済みの応答を読む（スキーマ根拠: Account定義のapiKeyバリアント）', () => {
    const view = parseAccountRead({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
    expect(view).toEqual({ loggedIn: true, method: 'APIキー', identity: undefined, plan: undefined });
  });

  it('Amazon Bedrockでログイン済みの応答を読む（スキーマ根拠）', () => {
    const view = parseAccountRead({
      account: { type: 'amazonBedrock', usesCodexManagedCredentials: true },
      requiresOpenaiAuth: false,
    });
    expect(view).toEqual({
      loggedIn: true,
      method: 'Amazon Bedrock',
      identity: undefined,
      plan: undefined,
    });
  });

  it('account が null なら未ログイン扱いにする（スキーマ根拠: GetAccountResponse.account は nullable）', () => {
    const view = parseAccountRead({ account: null, requiresOpenaiAuth: true });
    expect(view).toEqual({ loggedIn: false, method: undefined, identity: undefined, plan: undefined });
  });

  it('account フィールドが無い応答も未ログイン扱いにする', () => {
    const view = parseAccountRead({ requiresOpenaiAuth: true });
    expect(view).toEqual({ loggedIn: false, method: undefined, identity: undefined, plan: undefined });
  });

  it('emailがnullでも壊れない（Account.email は nullable）', () => {
    const view = parseAccountRead({
      account: { type: 'chatgpt', email: null, planType: 'unknown' },
      requiresOpenaiAuth: true,
    });
    expect(view).toEqual({
      loggedIn: true,
      method: 'ChatGPTアカウント',
      identity: undefined,
      plan: 'unknown',
    });
  });

  it('未知のtypeでもログイン済みとして扱い、typeをそのまま説明にする', () => {
    const view = parseAccountRead({ account: { type: 'future' }, requiresOpenaiAuth: false });
    expect(view).toEqual({ loggedIn: true, method: 'future', identity: undefined, plan: undefined });
  });

  it('壊れた形の応答では未ログイン扱いにする（例外を投げない）', () => {
    expect(parseAccountRead(null)).toEqual({
      loggedIn: false,
      method: undefined,
      identity: undefined,
      plan: undefined,
    });
    expect(parseAccountRead('文字列')).toEqual({
      loggedIn: false,
      method: undefined,
      identity: undefined,
      plan: undefined,
    });
  });
});
