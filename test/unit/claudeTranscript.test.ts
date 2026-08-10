import { describe, expect, it } from 'vitest';
import {
  describeTool,
  parseTranscriptHead,
  sessionIdFromTranscriptName,
  transcriptItems,
} from '../../src/claude/transcript';

describe('describeTool の差分', () => {
  it('Edit は置換前後を差分にする', () => {
    const tool = describeTool('Edit', {
      file_path: '/work/a.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 10;',
    });
    expect(tool.kind).toBe('fileChange');
    expect(tool.diffs).toHaveLength(1);
    expect(tool.diffs[0]).toMatchObject({ path: '/work/a.ts', kind: 'update' });
    expect(tool.diffs[0]?.diff).toBe('-const a = 1;\n-const b = 2;\n+const a = 10;');
  });

  it('Write は全行を追加として扱う', () => {
    const tool = describeTool('Write', { file_path: '/work/new.ts', content: 'line1\nline2' });
    expect(tool.diffs[0]).toMatchObject({ path: '/work/new.ts', kind: 'add' });
    expect(tool.diffs[0]?.diff).toBe('+line1\n+line2');
  });

  it('巨大な内容は切り詰めて省略を知らせる', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
    const diff = describeTool('Write', { file_path: '/work/big.ts', content }).diffs[0]?.diff ?? '';
    expect(diff.split('\n').length).toBeLessThan(500);
    expect(diff).toContain('省略');
  });

  it('差分を作れないツールでは空になる', () => {
    expect(describeTool('Bash', { command: 'ls' }).diffs).toEqual([]);
    expect(describeTool('Edit', { file_path: '/a.ts' }).diffs).toEqual([]);
    expect(describeTool('Write', { file_path: '/a.ts', content: '' }).diffs).toEqual([]);
  });
});

const ID = 'e71f0acf-2b5b-4ea5-b6c7-24ca8d7668f9';

const userLine = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    userType: 'external',
    origin: { kind: 'human' },
    timestamp: '2026-08-06T20:13:18.257Z',
    cwd: '/home/u/workspace/repo',
    sessionId: ID,
    gitBranch: 'main',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  });

describe('sessionIdFromTranscriptName', () => {
  it('ファイル名からidを取り出す', () => {
    expect(sessionIdFromTranscriptName(`${ID}.jsonl`)).toBe(ID);
  });

  it('UUID以外のファイル名は受け付けない', () => {
    expect(sessionIdFromTranscriptName('summary.jsonl')).toBeUndefined();
    expect(sessionIdFromTranscriptName(`${ID}.json`)).toBeUndefined();
  });
});

describe('parseTranscriptHead', () => {
  it('先頭の非ユーザー行を読み飛ばして素性を取り出す', () => {
    const meta = parseTranscriptHead([
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: ID }),
      userLine('拡張機能の設計を見直したい'),
    ]);

    expect(meta).toEqual({
      sessionId: ID,
      cwd: '/home/u/workspace/repo',
      firstUserText: '拡張機能の設計を見直したい',
      startedAt: '2026-08-06T20:13:18.257Z',
      gitBranch: 'main',
    });
  });

  it('壊れた行を飛ばして続きを読む', () => {
    const meta = parseTranscriptHead(['{壊れている', '', userLine('本文')]);
    expect(meta?.firstUserText).toBe('本文');
  });

  it('sidechain（subagent）の発言を表示名に使わない', () => {
    const meta = parseTranscriptHead([
      userLine('subagentの指示', { isSidechain: true }),
      userLine('ユーザーの指示'),
    ]);
    expect(meta?.firstUserText).toBe('ユーザーの指示');
  });

  it('ツール結果やメタ行を表示名に使わない', () => {
    const meta = parseTranscriptHead([
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-06T20:00:00.000Z',
        cwd: '/home/u/workspace/repo',
        sessionId: ID,
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      userLine('ユーザーの指示'),
    ]);
    expect(meta?.firstUserText).toBe('ユーザーの指示');
  });

  it('IDEが挿入する制御タグを表示名から除く', () => {
    const meta = parseTranscriptHead([
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-06T20:13:18.257Z',
        cwd: '/home/u/workspace/repo',
        sessionId: ID,
        origin: { kind: 'human' },
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<ide_opened_file>README.md</ide_opened_file>' },
            { type: 'text', text: '実装を続けて' },
          ],
        },
      }),
    ]);
    expect(meta?.firstUserText).toBe('実装を続けて');
  });

  it('ユーザー発言が無くてもcwdが判れば素性を返す', () => {
    const meta = parseTranscriptHead([
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-06T20:13:20.000Z',
        cwd: '/home/u/workspace/repo',
        sessionId: ID,
        message: { role: 'assistant', content: [{ type: 'text', text: 'こんにちは' }] },
      }),
    ]);
    expect(meta?.cwd).toBe('/home/u/workspace/repo');
    expect(meta?.firstUserText).toBeUndefined();
  });

  it('cwdもidも読めなければ undefined', () => {
    expect(parseTranscriptHead(['{}', 'x'])).toBeUndefined();
  });
});

describe('transcriptItems', () => {
  it('会話を表示用の項目列にする', () => {
    const items = transcriptItems([
      userLine('直して'),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-08-06T20:13:30.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '直します' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-08-06T20:13:35.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      }),
    ]);

    expect(items.map((i) => i.kind)).toEqual(['userMessage', 'agentMessage', 'commandExecution']);
    expect(items[0]?.text).toBe('直して');
    expect(items[2]?.detail).toBe('npm test');
    expect(items[2]?.text).toBe('ok');
  });

  it('sidechainと壊れた行を除く', () => {
    const items = transcriptItems([
      '{壊れ',
      userLine('本命'),
      userLine('副', { isSidechain: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('本命');
  });
});
