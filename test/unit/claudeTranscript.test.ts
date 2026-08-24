import { describe, expect, it } from 'vitest';
import {
  claudeSearchResults,
  describeTool,
  normalizeTodos,
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

  it('Edit は old_string/new_string を切り詰め前の生の文字列のまま editReplace へ持つ（issue #310）', () => {
    const tool = describeTool('Edit', {
      file_path: '/work/a.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 10;',
    });
    expect(tool.diffs[0]?.editReplace).toEqual({
      oldString: 'const a = 1;\nconst b = 2;',
      newString: 'const a = 10;',
    });
  });

  it('Edit で old_string が空（実質新規追加）のときは kind が add になり editReplace は無い', () => {
    const tool = describeTool('Edit', {
      file_path: '/work/new.ts',
      old_string: '',
      new_string: 'const a = 1;',
    });
    expect(tool.diffs[0]).toMatchObject({ path: '/work/new.ts', kind: 'add' });
    expect(tool.diffs[0]?.editReplace).toBeUndefined();
  });

  it('Edit の内容が200行を超えても、editReplaceは切り詰めずに完全な文字列を持つ（issue #310）', () => {
    // diff（表示用テキスト）はMAX_DIFF_LINES（200行）で切り詰められるが、
    // editReplaceは復元の検索置換に使うため切り詰めてはいけない
    const oldString = Array.from({ length: 300 }, (_, i) => `old${i}`).join('\n');
    const newString = Array.from({ length: 300 }, (_, i) => `new${i}`).join('\n');
    const tool = describeTool('Edit', {
      file_path: '/work/big.ts',
      old_string: oldString,
      new_string: newString,
    });
    expect(tool.diffs[0]?.editReplace).toEqual({ oldString, newString });
    // diff本文（表示用）の方は従来どおり省略される
    expect(tool.diffs[0]?.diff).toContain('省略');
  });

  it('Write は全行を追加として扱う', () => {
    const tool = describeTool('Write', { file_path: '/work/new.ts', content: 'line1\nline2' });
    expect(tool.diffs[0]).toMatchObject({ path: '/work/new.ts', kind: 'add' });
    expect(tool.diffs[0]?.diff).toBe('+line1\n+line2');
    expect(tool.diffs[0]?.editReplace).toBeUndefined();
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
    const { items } = transcriptItems([
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
    const { items } = transcriptItems([
      '{壊れ',
      userLine('本命'),
      userLine('副', { isSidechain: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('本命');
  });

  it('Skillツールが注入するSKILL.md本文をskillContextとして畳む（issue #691）', () => {
    const { items } = transcriptItems([
      userLine('SKILL.mdの内容', {
        isMeta: true,
        sourceToolUseID: 'toolu_01abc',
        userType: undefined,
        origin: undefined,
      }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['skillContext']);
    expect(items[0]?.text).toBe('SKILL.mdの内容');
  });

  it('sourceToolUseID無しのisMeta（caveat等）は従来どおり非表示にする', () => {
    const { items } = transcriptItems([
      userLine('<local-command-caveat>Caveat</local-command-caveat>', {
        isMeta: true,
        userType: undefined,
        origin: undefined,
      }),
    ]);
    expect(items).toEqual([]);
  });

  it('TodoWriteは会話の項目には積まない', () => {
    const { items } = transcriptItems([
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'TodoWrite',
              input: { todos: [{ content: '直す', status: 'pending', activeForm: '直している' }] },
            },
          ],
        },
      }),
    ]);
    expect(items).toEqual([]);
  });

  it('最後に呼ばれたTodoWriteの内容をtodosとして返す', () => {
    const call = (todos: Record<string, unknown>[]) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `a-${todos.length}`,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }],
        },
      });

    const { todos } = transcriptItems([
      call([{ content: 'A', status: 'pending', activeForm: 'A中' }]),
      call([
        { content: 'A', status: 'completed', activeForm: 'A中' },
        { content: 'B', status: 'in_progress', activeForm: 'B中' },
      ]),
    ]);

    expect(todos).toEqual([
      { content: 'A', status: 'completed', activeForm: 'A中' },
      { content: 'B', status: 'in_progress', activeForm: 'B中' },
    ]);
  });

  it('TodoWriteを使っていないセッションではtodosが空になる', () => {
    const { todos } = transcriptItems([userLine('本文')]);
    expect(todos).toEqual([]);
  });

  it('TodoWriteが呼ばれるたびの一覧を、何ターン目かと一緒に積む（issue #721）', () => {
    const call = (id: string, todos: unknown[]): string =>
      JSON.stringify({
        type: 'assistant',
        uuid: id,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }],
        },
      });

    const { todoHistory } = transcriptItems([
      userLine('最初の指示'),
      call('t1', [{ content: 'A', status: 'pending', activeForm: 'A中' }]),
      userLine('次の指示'),
      call('t2', [{ content: 'A', status: 'completed', activeForm: 'A中' }]),
    ]);

    expect(todoHistory).toEqual([
      { todos: [{ content: 'A', status: 'pending', activeForm: 'A中' }], turnIndex: 0 },
      { todos: [{ content: 'A', status: 'completed', activeForm: 'A中' }], turnIndex: 1 },
    ]);
  });

  it('TodoWriteを使っていないセッションでは履歴も空になる（issue #721）', () => {
    expect(transcriptItems([userLine('本文')]).todoHistory).toEqual([]);
  });
});

describe('normalizeTodos', () => {
  it('実測した形（todos配列）をそのまま読む', () => {
    const todos = normalizeTodos({
      todos: [
        { content: 'Aを準備する', status: 'pending', activeForm: 'Aを準備中' },
        { content: 'Bを実行する', status: 'in_progress', activeForm: 'Bを実行中' },
        { content: 'Cを確認する', status: 'completed', activeForm: 'Cを確認中' },
      ],
    });
    expect(todos).toEqual([
      { content: 'Aを準備する', status: 'pending', activeForm: 'Aを準備中' },
      { content: 'Bを実行する', status: 'in_progress', activeForm: 'Bを実行中' },
      { content: 'Cを確認する', status: 'completed', activeForm: 'Cを確認中' },
    ]);
  });

  it('未知の状態語彙もそのまま持つ', () => {
    const todos = normalizeTodos({ todos: [{ content: 'X', status: 'blocked' }] });
    expect(todos[0]?.status).toBe('blocked');
  });

  it('activeFormが無ければcontentで補う', () => {
    const todos = normalizeTodos({ todos: [{ content: 'X', status: 'pending' }] });
    expect(todos[0]?.activeForm).toBe('X');
  });

  it('statusが無ければpending扱いにする', () => {
    const todos = normalizeTodos({ todos: [{ content: 'X' }] });
    expect(todos[0]?.status).toBe('pending');
  });

  it('contentが空の項目は読み飛ばす', () => {
    const todos = normalizeTodos({ todos: [{ content: '' }, { content: '  ' }] });
    expect(todos).toEqual([]);
  });

  it('todosが配列でない・入力が壊れている場合は空にする', () => {
    expect(normalizeTodos({})).toEqual([]);
    expect(normalizeTodos({ todos: 'not-an-array' })).toEqual([]);
    expect(normalizeTodos(undefined)).toEqual([]);
    expect(normalizeTodos(null)).toEqual([]);
    expect(normalizeTodos('string')).toEqual([]);
  });
});

// Web検索結果（issue #18）。実測（`claude --output-format stream-json` でWebSearchを伴う
// ターンを実際に回して確認）した形をそのまま固定する。
// `tool_use_result`: `{query, results: [{tool_use_id, content: [{title, url}, ...]}]}`
describe('claudeSearchResults', () => {
  const toolUseResult = {
    query: 'microsoft/TypeScript latest release version GitHub',
    results: [
      {
        tool_use_id: 'srvtoolu_01UjMQQwAc51xeT9zJC9TJf1',
        content: [
          { title: 'microsoft/TypeScript v6.0.3 on GitHub', url: 'https://newreleases.io/x' },
          { title: 'Releases · microsoft/TypeScript', url: 'https://github.com/microsoft/x' },
        ],
      },
    ],
  };

  it('tool_use_resultのresults.content からタイトルとURLを取り出す', () => {
    expect(claudeSearchResults(toolUseResult, 1)).toEqual([
      { title: 'microsoft/TypeScript v6.0.3 on GitHub', url: 'https://newreleases.io/x' },
      { title: 'Releases · microsoft/TypeScript', url: 'https://github.com/microsoft/x' },
    ]);
  });

  // WebFetchの実測形（`{bytes, code, codeText, result, durationMs, url}`）には
  // resultsが無いため、常に空になる（従来どおりURL＝クエリだけの表示に留まる）
  it('WebFetchのtool_use_result（resultsを持たない）では空になる', () => {
    const webFetchResult = {
      bytes: 462152,
      code: 200,
      codeText: 'OK',
      result: '# 本文…',
      durationMs: 2788,
      url: 'https://github.com/microsoft/TypeScript/releases',
    };
    expect(claudeSearchResults(webFetchResult, 1)).toEqual([]);
  });

  it('同じイベントに2件以上のtool_resultが並ぶときは対応が取れないため空にする', () => {
    expect(claudeSearchResults(toolUseResult, 2)).toEqual([]);
  });

  it('tool_use_resultが無い・壊れている場合も空になる', () => {
    expect(claudeSearchResults(undefined, 1)).toEqual([]);
    expect(claudeSearchResults(null, 1)).toEqual([]);
    expect(claudeSearchResults({ results: 'not-an-array' }, 1)).toEqual([]);
  });
});

describe('transcriptItems / webSearch', () => {
  const assistantToolUse = (id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `a-${id}`,
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });

  it('WebSearchの結果を searchResults に積む', () => {
    const { items } = transcriptItems([
      assistantToolUse('t1', 'WebSearch', { query: 'TypeScript release' }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content:
                'Web search results for query: "TypeScript release"\n\nLinks: [{"title":"A","url":"https://a.example"}]',
              is_error: false,
            },
          ],
        },
        tool_use_result: {
          query: 'TypeScript release',
          results: [
            {
              tool_use_id: 'srvtoolu_1',
              content: [{ title: 'A', url: 'https://a.example' }],
            },
          ],
        },
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'webSearch',
      detail: 'TypeScript release',
      searchResults: [{ title: 'A', url: 'https://a.example' }],
    });
  });

  it('WebFetchはtool_use_resultにresultsが無いためsearchResultsが空のまま', () => {
    const { items } = transcriptItems([
      assistantToolUse('t1', 'WebFetch', { url: 'https://a.example' }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '# 本文…', is_error: false },
          ],
        },
        tool_use_result: {
          bytes: 100,
          code: 200,
          codeText: 'OK',
          result: '# 本文…',
          durationMs: 10,
          url: 'https://a.example',
        },
      }),
    ]);

    expect(items[0]).toMatchObject({ kind: 'webSearch', detail: 'https://a.example' });
    expect(items[0]?.searchResults).toEqual([]);
  });

  it('tool_use_resultが無い（実測できなかった経路）ときも壊れずクエリだけの表示に留まる', () => {
    const { items } = transcriptItems([
      assistantToolUse('t1', 'WebSearch', { query: 'q' }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      }),
    ]);

    expect(items[0]).toMatchObject({ kind: 'webSearch', detail: 'q', text: 'ok' });
    expect(items[0]?.searchResults).toEqual([]);
  });
});
