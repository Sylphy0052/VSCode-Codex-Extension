/**
 * メインAIへの指示の下書きの解釈（Issue #929 Handoff）。
 *
 * ここで通した下書きは、承認されれば書き換えのできるメインAIへ渡る。読めない応答を推測で
 * 補って通さないこと、要約と指示文の切り分けが曖昧なまま通らないことを確かめる。
 */

import { describe, expect, it } from 'vitest';
import { parseHandoffDraft } from '../../src/secondOpinion/handoff';

function jsonBlock(body: string): string {
  return ['結論をまとめました。', '', '```json', body, '```'].join('\n');
}

describe('parseHandoffDraft（Issue #929）', () => {
  it('2つのキーを持つJSONを読み取る', () => {
    const raw = jsonBlock(
      JSON.stringify({ userSummary: 'B案を勧める', mainInstruction: 'B案で実装すること' }),
    );
    expect(parseHandoffDraft(raw)).toEqual({
      ok: true,
      draft: { userSummary: 'B案を勧める', mainInstruction: 'B案で実装すること' },
    });
  });

  it('前後の説明文は無視する（コードブロックの中だけを読む）', () => {
    const raw = [
      '以下が下書きです。userSummary には要約を入れました。',
      '',
      '```json',
      JSON.stringify({ userSummary: '要約', mainInstruction: '指示' }),
      '```',
      '',
      '不明点があれば追加で相談してください。',
    ].join('\n');
    expect(parseHandoffDraft(raw)).toMatchObject({ ok: true });
  });

  it('コードブロックが無ければ下書きにしない', () => {
    const raw = JSON.stringify({ userSummary: '要約', mainInstruction: '指示' });
    expect(parseHandoffDraft(raw)).toEqual({
      ok: false,
      reason: 'JSONのコードブロックが見つかりませんでした',
    });
  });

  it('コードブロックが複数あれば下書きにしない（どれが結論か決められない）', () => {
    const raw = [
      jsonBlock(JSON.stringify({ userSummary: '例', mainInstruction: '例' })),
      jsonBlock(JSON.stringify({ userSummary: '本命', mainInstruction: '本命' })),
    ].join('\n\n');
    expect(parseHandoffDraft(raw)).toMatchObject({ ok: false });
    expect((parseHandoffDraft(raw) as { reason: string }).reason).toContain('2個');
  });

  it('JSONとして壊れていれば理由を返す', () => {
    const result = parseHandoffDraft(jsonBlock('{ "userSummary": '));
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('JSONとして読めませんでした');
  });

  it('オブジェクト以外は受け付けない', () => {
    expect(parseHandoffDraft(jsonBlock('["指示"]'))).toEqual({
      ok: false,
      reason: 'JSONの中身がオブジェクトではありませんでした',
    });
  });

  it('mainInstruction が欠けていれば受け付けない', () => {
    expect(parseHandoffDraft(jsonBlock(JSON.stringify({ userSummary: '要約' })))).toEqual({
      ok: false,
      reason: 'mainInstruction が文字列ではありませんでした',
    });
  });

  it('空白だけの値は空として扱う', () => {
    const raw = jsonBlock(JSON.stringify({ userSummary: '要約', mainInstruction: '   \n  ' }));
    expect(parseHandoffDraft(raw)).toEqual({ ok: false, reason: 'mainInstruction が空でした' });
  });

  it('長すぎる指示文は受け付けない（全文を読ませずに承認させない）', () => {
    const raw = jsonBlock(
      JSON.stringify({ userSummary: '要約', mainInstruction: 'あ'.repeat(8_001) }),
    );
    const result = parseHandoffDraft(raw);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('mainInstruction が長すぎます');
  });

  it('前後の空白は落として返す', () => {
    const raw = jsonBlock(
      JSON.stringify({ userSummary: '\n 要約 \n', mainInstruction: '\n 指示 \n' }),
    );
    expect(parseHandoffDraft(raw)).toEqual({
      ok: true,
      draft: { userSummary: '要約', mainInstruction: '指示' },
    });
  });

  it('中身にバッククォートを含む長いフェンスも読める', () => {
    const raw = [
      '````json',
      JSON.stringify({ userSummary: '```を含む要約', mainInstruction: '指示' }),
      '````',
    ].join('\n');
    expect(parseHandoffDraft(raw)).toMatchObject({
      ok: true,
      draft: { userSummary: '```を含む要約' },
    });
  });

  it('閉じていないコードブロックは読まない', () => {
    const raw = ['```json', JSON.stringify({ userSummary: '要約', mainInstruction: '指示' })].join(
      '\n',
    );
    expect(parseHandoffDraft(raw)).toEqual({
      ok: false,
      reason: 'JSONのコードブロックが見つかりませんでした',
    });
  });
});
