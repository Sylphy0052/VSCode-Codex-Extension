import { describe, expect, it } from 'vitest';
import {
  MAX_EDITED_FILES,
  SUMMARY_MAX_LEN,
  bufferFileName,
  buildActivityRecord,
  serializeActivityRecord,
} from '../../src/activity/record';

const at = (iso: string) => new Date(iso);

describe('buildActivityRecord (kind: prompt)', () => {
  it('日報バッファが読む形のレコードを作る', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:41:00Z'),
      timeZoneOffsetMinutes: -540, // JST
      source: 'codex',
      cwd: '/home/u/workspace/repo',
      sessionId: 'sess-1',
      kind: 'prompt',
      text: '承認フローの実装を依頼',
    });

    expect(record).toEqual({
      ts: '2026-08-07T09:41:00+09:00',
      source: 'codex',
      cwd: '/home/u/workspace/repo',
      text: '承認フローの実装を依頼',
      ref: 'vscode',
      session_id: 'sess-1',
      kind: 'prompt',
    });
  });

  it('UTCのオフセットは +00:00 として書く', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:41:00Z'),
      timeZoneOffsetMinutes: 0,
      source: 'claude-code',
      cwd: '/w/r',
      sessionId: 's',
      kind: 'prompt',
      text: 'x',
    });
    expect(record?.ts).toBe('2026-08-07T00:41:00+00:00');
  });

  it('負のオフセット（西半球）も符号を保つ', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:41:00Z'),
      timeZoneOffsetMinutes: 300, // UTC-5
      source: 'codex',
      cwd: '/w/r',
      sessionId: 's',
      kind: 'prompt',
      text: 'x',
    });
    expect(record?.ts).toBe('2026-08-06T19:41:00-05:00');
  });

  it('改行と連続空白を1行へ畳む', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:00:00Z'),
      timeZoneOffsetMinutes: -540,
      source: 'codex',
      cwd: '/w/r',
      sessionId: 's',
      kind: 'prompt',
      text: '  一行目\n\n二行目\t三行目  ',
    });
    expect(record?.text).toBe('一行目 二行目 三行目');
  });

  it('上限を超える本文を切り詰める', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:00:00Z'),
      timeZoneOffsetMinutes: -540,
      source: 'codex',
      cwd: '/w/r',
      sessionId: 's',
      kind: 'prompt',
      text: 'あ'.repeat(SUMMARY_MAX_LEN + 50),
    });
    expect(record?.text).toBe(`${'あ'.repeat(SUMMARY_MAX_LEN)}…`);
  });

  it('本文が空なら記録しない', () => {
    const base = {
      now: at('2026-08-07T00:00:00Z'),
      timeZoneOffsetMinutes: -540,
      source: 'codex' as const,
      cwd: '/w/r',
      sessionId: 's',
      kind: 'prompt' as const,
    };
    expect(buildActivityRecord({ ...base, text: '' })).toBeUndefined();
    expect(buildActivityRecord({ ...base, text: '   \n ' })).toBeUndefined();
  });

  it('cwdが空なら記録しない（日報がプロジェクトを判定できない）', () => {
    expect(
      buildActivityRecord({
        now: at('2026-08-07T00:00:00Z'),
        timeZoneOffsetMinutes: -540,
        source: 'codex',
        cwd: '',
        sessionId: 's',
        kind: 'prompt',
        text: 'x',
      }),
    ).toBeUndefined();
  });

  it('sessionIdが空なら記録しない（collect.py側の重複排除が成立しない）', () => {
    expect(
      buildActivityRecord({
        now: at('2026-08-07T00:00:00Z'),
        timeZoneOffsetMinutes: -540,
        source: 'codex',
        cwd: '/w/r',
        sessionId: '  ',
        kind: 'prompt',
        text: 'x',
      }),
    ).toBeUndefined();
  });
});

describe('buildActivityRecord (kind: result)', () => {
  const base = {
    now: at('2026-08-07T00:00:00Z'),
    timeZoneOffsetMinutes: -540,
    source: 'codex' as const,
    cwd: '/w/repo',
    sessionId: 's',
    kind: 'result' as const,
  };

  it('応答テキストだけを1行要約にする', () => {
    const record = buildActivityRecord({ ...base, text: '直しました' });
    expect(record?.text).toBe('直しました');
    expect(record?.kind).toBe('result');
  });

  it('編集ファイルがあれば末尾に付記する', () => {
    const record = buildActivityRecord({
      ...base,
      text: '直しました',
      editedFiles: ['/w/repo/src/a.ts', '/w/repo/src/b.ts'],
    });
    expect(record?.text).toBe('直しました [edit: src/a.ts, src/b.ts]');
  });

  it('cwd配下でなければbasenameにする', () => {
    const record = buildActivityRecord({
      ...base,
      text: '直しました',
      editedFiles: ['/other/place/c.ts'],
    });
    expect(record?.text).toBe('直しました [edit: c.ts]');
  });

  it(`編集ファイルが${MAX_EDITED_FILES}件を超えたら残りを+Nで示す`, () => {
    const editedFiles = Array.from({ length: 8 }, (_, i) => `/w/repo/f${i}.ts`);
    const record = buildActivityRecord({ ...base, text: '一括修正', editedFiles });
    expect(record?.text).toBe('一括修正 [edit: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts +3]');
  });

  it('応答テキストが空でも編集ファイルがあれば記録する', () => {
    const record = buildActivityRecord({
      ...base,
      text: '',
      editedFiles: ['/w/repo/a.ts'],
    });
    expect(record?.text).toBe(' [edit: a.ts]');
  });

  it('応答テキストと編集ファイルの両方が空なら記録しない', () => {
    expect(buildActivityRecord({ ...base, text: '', editedFiles: [] })).toBeUndefined();
    expect(buildActivityRecord({ ...base, text: '   ' })).toBeUndefined();
  });

  it('全体で200字を超える場合、編集ファイル一覧を残して応答要約側を削る', () => {
    const record = buildActivityRecord({
      ...base,
      text: 'あ'.repeat(300),
      editedFiles: ['/w/repo/a.ts', '/w/repo/b.ts'],
    });
    const suffix = ' [edit: a.ts, b.ts]';
    expect(record?.text.length).toBeLessThanOrEqual(SUMMARY_MAX_LEN);
    expect(record?.text.endsWith(suffix)).toBe(true);
  });
});

describe('serializeActivityRecord', () => {
  it('改行で終わる1行のJSONにする', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:41:00Z'),
      timeZoneOffsetMinutes: -540,
      source: 'codex',
      cwd: '/w/r',
      sessionId: 's',
      kind: 'prompt',
      text: 'テスト',
    });
    const line = serializeActivityRecord(record!);

    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual(record);
  });
});

describe('bufferFileName', () => {
  it('ローカル日付の YYYY-MM-DD.jsonl を返す', () => {
    // UTCでは前日でも、JSTの暦日で束ねる
    expect(bufferFileName(at('2026-08-06T15:30:00Z'), -540)).toBe('2026-08-07.jsonl');
    expect(bufferFileName(at('2026-08-06T14:30:00Z'), -540)).toBe('2026-08-06.jsonl');
  });
});
