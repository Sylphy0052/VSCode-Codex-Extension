/**
 * askGptモード（Issue #947）の純粋ロジックの検証。
 *
 * 対象は「親が生成した質問文の検証」と「送信前の認証情報の伏せ字化」の2つ。どちらも
 * `vscode` に依存しないため、view層を起こさずに単体で確かめられる。
 *
 * 伏せ字化のテストで使う「秘密に見える文字列」は、このファイルへ直書きせず接頭辞と本体を
 * 分けて組み立てる。実在の鍵ではないが、形が本物と同じである以上、リポジトリ全体を走査する
 * secret scanner はそれを区別できないため。
 */

import { describe, expect, it } from 'vitest';
import {
  ASK_GPT_MAX_CHARS,
  ASK_GPT_SECTION_HEADINGS,
  normalizeSecondOpinionMode,
  validateAskGptRequestText,
} from '../../src/secondOpinion/askGpt';
import { buildAskGptSecondOpinionPrompt } from '../../src/secondOpinion/prompt';
import {
  describeRedaction,
  mergeRedactionCounts,
  redactCredentials,
} from '../../src/secondOpinion/redact';

/** 8セクションをすべて備えた最小の正しい質問文。 */
function validText(): string {
  return ['# 質問: テスト', '', ...ASK_GPT_SECTION_HEADINGS.map((h) => `${h}\n\n本文\n`)].join(
    '\n',
  );
}

const DASHES = '-'.repeat(5);

describe('normalizeSecondOpinionMode', () => {
  it('askGpt だけを askGpt として受け取り、未知の値は direct へ倒す', () => {
    expect(normalizeSecondOpinionMode('askGpt')).toBe('askGpt');
    expect(normalizeSecondOpinionMode('direct')).toBe('direct');
    expect(normalizeSecondOpinionMode('ASKGPT')).toBe('direct');
    expect(normalizeSecondOpinionMode(undefined)).toBe('direct');
    expect(normalizeSecondOpinionMode(42)).toBe('direct');
  });
});

describe('validateAskGptRequestText', () => {
  it('8セクションが順序どおり揃っていれば通す', () => {
    const result = validateAskGptRequestText(`\n${validText()}\n`);
    expect(result.ok).toBe(true);
    // 前後の空白は落として渡す
    expect(result.ok && result.text.startsWith('# 質問:')).toBe(true);
  });

  it('空文字を弾く', () => {
    const result = validateAskGptRequestText('   \n  ');
    expect(result).toEqual({ ok: false, reason: '質問文が空でした' });
  });

  it('上限を超える長さを弾く', () => {
    const result = validateAskGptRequestText('#'.repeat(ASK_GPT_MAX_CHARS + 1));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('上限');
  });

  it('前置きから始まる文を弾く（タイトル行の欠落）', () => {
    const result = validateAskGptRequestText(`以下に質問文を作成しました。\n\n${validText()}`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('タイトル');
  });

  it('見出しが欠けていれば弾く', () => {
    const dropped = validText().replace('## 5. 関連コード', '## 関連するコード');
    const result = validateAskGptRequestText(dropped);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('## 5. 関連コード');
  });

  it('見出しの順序が入れ替わっていれば弾く', () => {
    const text = [
      '# 質問: テスト',
      '',
      ...['## 2. 質問', '## 1. 目的', ...ASK_GPT_SECTION_HEADINGS.slice(2)].map(
        (h) => `${h}\n\n本文\n`,
      ),
    ].join('\n');
    const result = validateAskGptRequestText(text);
    expect(result.ok).toBe(false);
  });

  it('同じ見出しが2回現れれば弾く', () => {
    const result = validateAskGptRequestText(`${validText()}\n\n## 4. 環境\n\n重複\n`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('複数回');
  });

  it('本文中に見出し文字列が引用されていても、行頭でなければ数えない', () => {
    const result = validateAskGptRequestText(`${validText()}\n\n参考: 「## 4. 環境」を参照。\n`);
    expect(result.ok).toBe(true);
  });
});

describe('redactCredentials', () => {
  it('PEM形式の秘密鍵をブロックごと伏せる', () => {
    const body = 'MIIEowIBAAKCAQEA\nabcdef';
    const text = `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\n${body}\n${DASHES}END RSA PRIVATE KEY${DASHES}`;
    const result = redactCredentials(text);
    expect(result.text).not.toContain('MIIEowIBAAKCAQEA');
    expect(result.counts['秘密鍵']).toBe(1);
  });

  it('URLに埋め込まれた認証情報はホストとユーザー名だけ残す', () => {
    const result = redactCredentials('https://alice:s3cr3t-value@example.com/repo.git');
    expect(result.text).toBe('https://alice:<MASKED>@example.com/repo.git');
  });

  it('Authorizationヘッダのトークンを伏せる', () => {
    const result = redactCredentials('Authorization: Bearer abcdef0123456789ABCDEF');
    expect(result.text).toBe('Authorization: Bearer <MASKED>');
  });

  it('既知の形式のトークンをキー名なしでも伏せる', () => {
    const ghToken = `gh${'p'}_a1b2c3d4e5f6g7h8i9j0k1l2`;
    const awsKey = `AK${'IA'}ABCDEFGHIJKLMNOP`;
    const result = redactCredentials(`${ghToken} と ${awsKey}`);
    expect(result.text).not.toContain(ghToken);
    expect(result.text).not.toContain(awsKey);
    expect(result.counts['既知の形式のトークン']).toBe(2);
  });

  it('代入形式の認証情報はキー名を残して値だけ伏せる', () => {
    const result = redactCredentials('const API_KEY = "9f8e7d6c5b4a39281706"');
    expect(result.text).toBe('const API_KEY = "<MASKED>"');
  });

  it('環境変数の参照やプレースホルダは伏せない（読めなくなるだけで守るものが無い）', () => {
    const text = [
      'password = os.environ["DB_PASSWORD"]',
      'client_secret: your-secret-here',
      'token = "xxxxxxxxxxxx"',
      'API_KEY=${OPENAI_API_KEY}',
    ].join('\n');
    const result = redactCredentials(text);
    expect(result.text).toBe(text);
    expect(result.total).toBe(0);
  });

  it('件数の内訳を1行にまとめる。0件なら undefined', () => {
    expect(describeRedaction(redactCredentials('何も無い文'))).toBeUndefined();
    const note = describeRedaction(redactCredentials('const API_KEY = "9f8e7d6c5b4a39281706"'));
    expect(note).toContain('認証情報の代入1件');
  });
});

describe('mergeRedactionCounts（Issue #954）', () => {
  it('複数回の伏せ字化の件数を1つに合算する', () => {
    const a = redactCredentials('const API_KEY = "9f8e7d6c5b4a39281706"');
    const b = redactCredentials('const API_KEY = "0011223344556677aabb"');
    const merged = mergeRedactionCounts(a, b);

    expect(merged.total).toBe(2);
    expect(merged.counts['認証情報の代入']).toBe(2);
  });

  it('ルール名が違えば内訳を並べる', () => {
    const assignment = redactCredentials('const API_KEY = "9f8e7d6c5b4a39281706"');
    const url = redactCredentials('https://alice:s3cr3t-value@example.com/repo.git');
    const note = describeRedaction(mergeRedactionCounts(assignment, url));

    expect(note).toContain('認証情報の代入1件');
    expect(note).toContain('URL埋め込みの認証情報1件');
  });

  it('どちらも0件なら合算も0件で、注記は出ない', () => {
    const merged = mergeRedactionCounts(
      redactCredentials('何も無い文'),
      redactCredentials('こちらも普通の文'),
    );

    expect(merged.total).toBe(0);
    expect(describeRedaction(merged)).toBeUndefined();
  });

  it('引数が無くても0件として扱う', () => {
    expect(mergeRedactionCounts().total).toBe(0);
  });
});

describe('buildAskGptSecondOpinionPrompt の依頼文（Issue #954）', () => {
  const questionText = '# 質問: テスト\n\n## 1. 目的\n\n本文';

  it('利用者の依頼文を、質問文より前の独立した節として置く', () => {
    const prompt = buildAskGptSecondOpinionPrompt(questionText, 'この設計で進めてよいか');

    expect(prompt).toContain('## 利用者からの依頼');
    expect(prompt).toContain('この設計で進めてよいか');
    expect(prompt.indexOf('## 利用者からの依頼')).toBeLessThan(
      prompt.indexOf('## 質問（作業中のエージェントが組み立てたもの）'),
    );
  });

  it('固定指示は依頼文より前に出る', () => {
    const prompt = buildAskGptSecondOpinionPrompt(questionText, '依頼');

    expect(prompt.indexOf('独立した立場から意見を求められています')).toBeLessThan(
      prompt.indexOf('## 利用者からの依頼'),
    );
  });

  it('依頼文を要約・整形せずそのまま渡す（前後の空白だけ落とす）', () => {
    const raw = '  1行目\n\n- 箇条書き\n- もう1つ  ';
    const prompt = buildAskGptSecondOpinionPrompt(questionText, raw);

    expect(prompt).toContain('1行目\n\n- 箇条書き\n- もう1つ');
  });

  it('依頼文もコードフェンスで囲む（見出しや箇条書きが固定指示と混ざらない）', () => {
    const prompt = buildAskGptSecondOpinionPrompt(questionText, '## 見出しに見える依頼');
    const afterHeading = prompt.slice(prompt.indexOf('## 利用者からの依頼'));

    expect(afterHeading).toMatch(/## 利用者からの依頼\n\n```markdown\n## 見出しに見える依頼\n```/);
  });

  it('依頼文と質問文が食い違うときは依頼文を優先する、と伝える', () => {
    const prompt = buildAskGptSecondOpinionPrompt(questionText, '依頼');

    expect(prompt).toContain('利用者の依頼文が求めていることを優先してください');
  });
});
