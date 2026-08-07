import { describe, expect, it } from 'vitest';
import {
  SUMMARY_MAX_LEN,
  bufferFileName,
  buildActivityRecord,
  serializeActivityRecord,
} from '../../src/activity/record';

const at = (iso: string) => new Date(iso);

describe('buildActivityRecord', () => {
  it('日報バッファが読む形のレコードを作る', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:41:00Z'),
      timeZoneOffsetMinutes: -540, // JST
      source: 'codex',
      cwd: '/home/u/workspace/repo',
      text: '承認フローの実装を依頼',
    });

    expect(record).toEqual({
      ts: '2026-08-07T09:41:00+09:00',
      source: 'codex',
      cwd: '/home/u/workspace/repo',
      text: '承認フローの実装を依頼',
      ref: 'vscode',
    });
  });

  it('UTCのオフセットは +00:00 として書く', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:41:00Z'),
      timeZoneOffsetMinutes: 0,
      source: 'claude-code',
      cwd: '/w/r',
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
        text: 'x',
      }),
    ).toBeUndefined();
  });
});

describe('serializeActivityRecord', () => {
  it('改行で終わる1行のJSONにする', () => {
    const record = buildActivityRecord({
      now: at('2026-08-07T00:41:00Z'),
      timeZoneOffsetMinutes: -540,
      source: 'codex',
      cwd: '/w/r',
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
