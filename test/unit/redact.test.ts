import { describe, expect, it } from 'vitest';

import { redactCredentials, REDACTION_MARK } from '../../src/secondOpinion/redact';

/**
 * `redactCredentials` の取りこぼしと誤検知を固定する（Issue #963）。
 *
 * この関数は外部のモデルサービスへ送る直前の最後の砦であり、取りこぼせば認証情報が出ていき、
 * 伏せすぎればレビュー対象のコードが壊れた状態で読まれる。どちらの向きも回帰として検出したい
 * ので、「伏せる」ケースと「伏せない」ケースを対にして置く。
 *
 * 文字列リテラルにそれらしいトークンを直書きするとsecret走査に引っかかるため、既存のテストと
 * 同じく接頭辞を分割して組み立てる。
 */

/** 既知の形式のトークン（値そのものが発行元を名乗る形）。 */
const GITLAB_PAT = `gl${'pat'}-abcdefghijklmnopqrst`;
const AWS_TEMP_KEY = `AS${'IA'}ABCDEFGHIJKLMNOP`;
const JWT = [
  `ey${'J'}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`,
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
  'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
].join('.');
const AZURE_SAS_SIG = `sig=${'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ0123456'}`;

describe('redactCredentials: quoteされたキー名（Issue #963）', () => {
  it('JSONのダブルクオートで囲まれたキーでも値を伏せる', () => {
    const result = redactCredentials('{"api_key": "9f8e7d6c5b4a39281706"}');
    expect(result.text).toBe(`{"api_key": "${REDACTION_MARK}"}`);
    expect(result.counts['認証情報の代入']).toBe(1);
  });

  it('単引用で囲まれたキーでも値を伏せる', () => {
    const result = redactCredentials("{'client_secret': '9f8e7d6c5b4a39281706'}");
    expect(result.text).toBe(`{'client_secret': '${REDACTION_MARK}'}`);
  });

  it('キー名のクオートは同じ字で閉じているものだけ拾う（囲いの取り違えを起こさない）', () => {
    // 開きだけがクオート——素の代入として拾えれば十分で、`"` を勝手に足さない
    const result = redactCredentials('"api_key = 9f8e7d6c5b4a39281706');
    expect(result.text).toBe(`"api_key = ${REDACTION_MARK}`);
  });

  it('陽性対照: クオートの無い素の代入はこれまで通り伏せる', () => {
    const result = redactCredentials('API_KEY=9f8e7d6c5b4a39281706');
    expect(result.text).toBe(`API_KEY=${REDACTION_MARK}`);
  });
});

describe('redactCredentials: 既知の形式のトークン（Issue #963）', () => {
  it('GitLabのpersonal access tokenを伏せる', () => {
    const result = redactCredentials(`token: ${GITLAB_PAT}`);
    expect(result.text).not.toContain(GITLAB_PAT);
    expect(result.counts['既知の形式のトークン']).toBe(1);
  });

  it('AWSの一時アクセスキーを伏せる', () => {
    const result = redactCredentials(`credentials は ${AWS_TEMP_KEY} でした`);
    expect(result.text).not.toContain(AWS_TEMP_KEY);
    expect(result.counts['既知の形式のトークン']).toBe(1);
  });

  it('キー名の無いbare JWTを伏せる', () => {
    const result = redactCredentials(`ヘッダに ${JWT} が入っていた`);
    expect(result.text).not.toContain(JWT);
    expect(result.counts['既知の形式のトークン']).toBe(1);
  });

  it('Azure SASの署名を伏せる', () => {
    const result = redactCredentials(
      `https://example.blob.core.windows.net/c?sv=2021-08-06&${AZURE_SAS_SIG}`,
    );
    expect(result.text).not.toContain(AZURE_SAS_SIG);
  });

  it('陽性対照: 表が空になっていない（すべて素通りしても気づけるようにする）', () => {
    const known = [GITLAB_PAT, AWS_TEMP_KEY, JWT];
    for (const token of known) {
      expect(redactCredentials(token).total).toBeGreaterThan(0);
    }
  });
});

describe('redactCredentials: 秘密でない識別子を壊さない（Issue #963）', () => {
  it('キー名が認証情報らしくても、右辺が識別子なら伏せない', () => {
    const text = [
      'const tokenType = access_token;',
      'passwordPolicy = strict-password',
      'const secretName = userProvidedName;',
    ].join('\n');
    const result = redactCredentials(text);
    expect(result.text).toBe(text);
    expect(result.total).toBe(0);
  });

  it('区切りもcamelCaseも無い一続きの英字列は識別子とみなさず伏せる', () => {
    // 単語に見えない英字だけの値は乱数列の可能性があるので、伏せ漏れを避ける側へ倒す
    const result = redactCredentials('api_key: abcdefghijklmnop');
    expect(result.text).toBe(`api_key: ${REDACTION_MARK}`);
  });

  it('クオートされた文字列リテラルは識別子の除外を通さない', () => {
    // 裸の値は他の識別子への参照だが、文字列リテラルは値そのもの。数字が無くても認証情報でありうる
    const result = redactCredentials('password = "CorrectHorseBattery"');
    expect(result.text).toBe(`password = "${REDACTION_MARK}"`);
  });

  it('数字を含む値は識別子に見えても伏せる', () => {
    const result = redactCredentials('access_token = live_key_20260829');
    expect(result.text).toBe(`access_token = ${REDACTION_MARK}`);
  });

  it('既知の形式は識別子の判定を通さない（キー名からの推定とは基準を分ける）', () => {
    // `glpat-` に続くのは英字だけだが、値そのものが発行元を名乗るので伏せる
    const result = redactCredentials(GITLAB_PAT);
    expect(result.text).toBe(REDACTION_MARK);
  });
});
