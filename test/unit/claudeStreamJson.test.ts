import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_CHARS } from '../../src/appserver/chatState';
import { applyStreamEvent, initialClaudeState } from '../../src/claude/streamJson';
import { consumeNdjson } from '../../src/util/ndjson';

const ID = 'e71f0acf-2b5b-4ea5-b6c7-24ca8d7668f9';

const apply = (events: Record<string, unknown>[]) =>
  events.reduce((state, event) => applyStreamEvent(state, event), initialClaudeState);

describe('consumeNdjson', () => {
  it('完成した行だけ返し、途中の行は残す', () => {
    const { values, rest } = consumeNdjson('{"a":1}\n{"b":2}\n{"c":');
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('{"c":');
  });

  it('壊れた行と空行を捨てる', () => {
    const { values } = consumeNdjson('not json\n\n{"a":1}\n[1,2]\n');
    expect(values).toEqual([{ a: 1 }]);
  });
});

describe('applyStreamEvent', () => {
  it('system/init でセッションidが確定する', () => {
    const state = apply([{ type: 'system', subtype: 'init', session_id: ID, model: 'opus' }]);
    expect(state.threadId).toBe(ID);
    expect(state.busy).toBe(true);
  });

  it('assistantのテキストを項目にする', () => {
    const state = apply([
      {
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: '直します' }] },
      },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.kind).toBe('agentMessage');
    expect(state.items[0]?.text).toBe('直します');
  });

  it('1メッセージ内の複数テキストを別々の項目にする', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'text', text: '一つ目' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
            { type: 'text', text: '二つ目' },
          ],
        },
      },
    ]);
    expect(state.items.map((i) => i.text)).toEqual(['一つ目', '', '二つ目']);
  });

  it('thinkingをreasoningとして扱う', () => {
    const state = apply([
      {
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'thinking', thinking: '考え中' }] },
      },
    ]);
    expect(state.items[0]?.kind).toBe('reasoning');
  });

  it('tool_useとtool_resultを1つの項目に束ねる', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '2 passed', is_error: false },
          ],
        },
      },
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.kind).toBe('commandExecution');
    expect(state.items[0]?.detail).toBe('npm test');
    expect(state.items[0]?.text).toBe('2 passed');
    expect(state.items[0]?.status).toBe('completed');
  });

  it('長すぎるツール結果は末尾を残して切り詰める', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big.log' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'x'.repeat(MAX_OUTPUT_CHARS + 50) + 'tail',
            },
          ],
        },
      },
    ]);
    expect(state.items[0]?.text).toHaveLength(MAX_OUTPUT_CHARS);
    expect(state.items[0]?.text.endsWith('tail')).toBe(true);
    expect(state.items[0]?.truncated).toBe(true);
  });

  it('ツールが読んだ画像を項目に持たせる', () => {
    // 実測: Read でpngを読ませると image ブロックが base64 で返る
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/dot.png' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' },
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(state.items[0]?.images).toEqual([
      { dataUrl: 'data:image/png;base64,iVBORw0K', path: undefined, alt: 'ツールが読んだ画像' },
    ]);
  });

  it('失敗したツール結果に印を付ける', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'failed', is_error: true }],
        },
      },
    ]);
    expect(state.items[0]?.status).toBe('エラー');
  });

  // Web検索の結果（issue #18）。ライブのstream-jsonでも同じ tool_use_result を実測している
  // （transcript.tsのテストと同じ実測データ）ため、履歴の読み直しと同じ経路で拾えることを確かめる
  it('WebSearchのtool_use_resultから検索結果を積む', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'q' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content:
                'Web search results for query: "q"\n\nLinks: [{"title":"A","url":"https://a.example"}]',
              is_error: false,
            },
          ],
        },
        tool_use_result: {
          query: 'q',
          results: [
            { tool_use_id: 'srvtoolu_1', content: [{ title: 'A', url: 'https://a.example' }] },
          ],
        },
      },
    ]);
    expect(state.items[0]).toMatchObject({
      kind: 'webSearch',
      detail: 'q',
      searchResults: [{ title: 'A', url: 'https://a.example' }],
    });
  });

  it('WebFetchはtool_use_resultにresultsが無いためsearchResultsが空のまま', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://a.example' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '# 本文', is_error: false }],
        },
        tool_use_result: {
          bytes: 100,
          code: 200,
          codeText: 'OK',
          result: '# 本文',
          durationMs: 10,
          url: 'https://a.example',
        },
      },
    ]);
    expect(state.items[0]).toMatchObject({ kind: 'webSearch', detail: 'https://a.example' });
    expect(state.items[0]?.searchResults).toEqual([]);
  });

  it('部分メッセージのデルタを積む', () => {
    const state = apply([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        parent_tool_use_id: null,
        uuid: 'u1',
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'こん' },
        },
        uuid: 'u1',
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'にちは' },
        },
        uuid: 'u1',
      },
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe('こんにちは');
  });

  it('ストリーミングの断片を1つの項目にまとめる', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'stream_event',
        uuid: 'u1',
        event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
      },
      {
        type: 'stream_event',
        uuid: 'u2',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        uuid: 'u3',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'こ' } },
      },
      {
        type: 'stream_event',
        uuid: 'u4',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'んにちは' },
        },
      },
    ]);
    const messages = state.items.filter((i) => i.kind === 'agentMessage');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('こんにちは');
  });

  it('完成メッセージがストリーミング中の項目を置き換える', () => {
    // assistant は message.id を持つ。断片と同じ項目でなければ二重に出る
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'stream_event',
        uuid: 'u1',
        event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
      },
      {
        type: 'stream_event',
        uuid: 'u2',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        uuid: 'u3',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'こ' } },
      },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'こんにちは' }],
        },
      },
    ]);
    const messages = state.items.filter((i) => i.kind === 'agentMessage');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('こんにちは');
  });

  it('message_startが無い次ターンでも前ターンの断片を上書きしない', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '前の応答' },
        },
      },
      {
        type: 'assistant',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: '前の応答' }] },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '次の応答' },
        },
      },
      {
        type: 'assistant',
        message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: '次の応答' }] },
      },
    ]);

    const messages = state.items.filter((i) => i.kind === 'agentMessage');
    expect(messages).toHaveLength(2);
    expect(messages.map((i) => i.text)).toEqual(['前の応答', '次の応答']);
    expect(messages[1]?.id).toBe('msg_2:text:0');
  });

  it('message_startと完成メッセージのIDが異なっても断片を置き換える', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'partial_msg', role: 'assistant', content: [] },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '応答' },
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'complete_msg',
          role: 'assistant',
          content: [{ type: 'text', text: '応答' }],
        },
      },
    ]);

    const messages = state.items.filter((i) => i.kind === 'agentMessage');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'complete_msg:text:0', text: '応答' });
  });

  it('rate_limit_event から制限の状態を取り込む', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: 1786342200,
          rateLimitType: 'five_hour',
        },
      },
    ]);
    expect(state.usage).toEqual({
      usedPercent: undefined,
      resetsAt: 1786342200,
      limitLabel: '5時間',
      limited: false,
    });
  });

  it('制限に到達した rate_limit_event を limited として扱う', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1786342200, rateLimitType: 'seven_day' },
      },
    ]);
    expect(state.usage?.limited).toBe(true);
    expect(state.usage?.limitLabel).toBe('週次');
  });

  it('未知の制限種別はそのまま表示名にする', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'monthly' },
      },
    ]);
    expect(state.usage?.limitLabel).toBe('monthly');
    expect(state.usage?.resetsAt).toBeUndefined();
  });

  it('result で応答中を解除する', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.01,
      },
    ]);
    expect(state.busy).toBe(false);
    expect(state.turnFailed).toBe(false);
  });

  it('is_error や success 以外のsubtypeを失敗として残す', () => {
    const byFlag = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      { type: 'result', subtype: 'success', is_error: true },
    ]);
    expect(byFlag.turnFailed).toBe(true);

    const bySubtype = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      { type: 'result', subtype: 'error_during_execution' },
    ]);
    expect(bySubtype.turnFailed).toBe(true);

    // 次のターンが始まれば消える
    const next = applyStreamEvent(bySubtype, { type: 'system', subtype: 'init', session_id: ID });
    expect(next.turnFailed).toBe(false);
  });

  it('ユーザー発言をそのまま項目にする（replay-user-messages）', () => {
    const state = apply([
      {
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'text', text: '直して' }] },
      },
    ]);
    expect(state.items[0]?.kind).toBe('userMessage');
    expect(state.items[0]?.text).toBe('直して');
  });

  it('ユーザーが送った画像を項目にする（issue #690）', () => {
    const state = apply([
      {
        type: 'user',
        uuid: 'u1',
        message: {
          content: [
            { type: 'text', text: '見て' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' },
            },
          ],
        },
      },
    ]);
    expect(state.items[0]?.kind).toBe('userMessage');
    expect(state.items[0]?.text).toBe('見て');
    expect(state.items[0]?.images).toEqual([
      { dataUrl: 'data:image/png;base64,iVBORw0K', path: undefined, alt: '送った画像' },
    ]);
  });

  it('テキストなし・画像だけの送信でも項目にする', () => {
    const state = apply([
      {
        type: 'user',
        uuid: 'u1',
        message: {
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' },
            },
          ],
        },
      },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe('');
    expect(state.items[0]?.images).toHaveLength(1);
  });

  it('Skillツールが注入するSKILL.md本文をskillContextとして畳む（issue #691）', () => {
    const state = apply([
      {
        type: 'user',
        uuid: 'u1',
        isMeta: true,
        sourceToolUseID: 'toolu_01abc',
        message: { content: [{ type: 'text', text: 'SKILL.mdの内容' }] },
      },
    ]);
    expect(state.items[0]?.kind).toBe('skillContext');
    expect(state.items[0]?.text).toBe('SKILL.mdの内容');
  });

  it('slash command起動でsourceToolUseIDが無くてもskillContextにする（issue #889）', () => {
    const state = apply([
      {
        type: 'user',
        uuid: 'u1',
        isMeta: true,
        message: {
          content: [
            {
              type: 'text',
              text: 'Base directory for this skill: /home/u/.claude/skills/gitlab-cleanup\n\n# gitlab-cleanup',
            },
          ],
        },
      },
    ]);
    expect(state.items[0]?.kind).toBe('skillContext');
    expect(state.items[0]?.detail).toBe('gitlab-cleanup');
  });

  it('sourceToolUseID無しのisMeta（caveat等）は従来どおりuserMessageのまま', () => {
    const state = apply([
      {
        type: 'user',
        uuid: 'u1',
        isMeta: true,
        message: { content: [{ type: 'text', text: '<local-command-caveat>Caveat</...>' }] },
      },
    ]);
    expect(state.items[0]?.kind).toBe('userMessage');
  });

  it('未知のイベントで状態を変えない', () => {
    const state = apply([{ type: 'prompt_suggestion', text: '次はこれ' }]);
    expect(state).toEqual(initialClaudeState);
  });
});

describe('TODO一覧（TodoWrite）', () => {
  it('TodoWriteのtool_useを専用一覧にし、会話の項目には積まない', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Aを準備する', status: 'pending', activeForm: 'Aを準備中' },
                  { content: 'Bを実行する', status: 'pending', activeForm: 'Bを実行中' },
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(state.items).toEqual([]);
    expect(state.todos).toEqual([
      { content: 'Aを準備する', status: 'pending', activeForm: 'Aを準備中' },
      { content: 'Bを実行する', status: 'pending', activeForm: 'Bを実行中' },
    ]);
  });

  it('更新のたびに一覧を置き換える（差分ではなく全体が届く）', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'TodoWrite',
              input: { todos: [{ content: 'A', status: 'pending', activeForm: 'A中' }] },
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm2',
          content: [
            {
              type: 'tool_use',
              id: 't2',
              name: 'TodoWrite',
              input: { todos: [{ content: 'A', status: 'in_progress', activeForm: 'A中' }] },
            },
          ],
        },
      },
    ]);
    expect(state.todos).toEqual([{ content: 'A', status: 'in_progress', activeForm: 'A中' }]);
  });

  it('書き換わるたびに履歴へ積む（issue #721）', () => {
    const write = (id: string, status: string): Record<string, unknown> => ({
      type: 'assistant',
      message: {
        id,
        content: [
          {
            type: 'tool_use',
            id,
            name: 'TodoWrite',
            input: { todos: [{ content: 'A', status, activeForm: 'A中' }] },
          },
        ],
      },
    });

    const state = apply([write('m1', 'pending'), write('m2', 'completed')]);

    // ユーザーの発言が無い状態で書かれた分は0ターン目として積む
    expect(state.todoHistory).toEqual([
      { todos: [{ content: 'A', status: 'pending', activeForm: 'A中' }], turnIndex: 0 },
      { todos: [{ content: 'A', status: 'completed', activeForm: 'A中' }], turnIndex: 0 },
    ]);
  });

  it('TodoWriteを使わないセッションではtodosが空のまま', () => {
    const state = apply([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
    ]);
    expect(state.todos).toEqual([]);
  });

  it('ターンをまたいでも一覧を持ち越す（会話全体のTODOのため）', () => {
    const withTodos = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'TodoWrite',
              input: { todos: [{ content: 'A', status: 'in_progress', activeForm: 'A中' }] },
            },
          ],
        },
      },
      { type: 'result', subtype: 'success' },
    ]);
    const next = applyStreamEvent(withTodos, { type: 'system', subtype: 'init', session_id: ID });
    expect(next.todos).toEqual([{ content: 'A', status: 'in_progress', activeForm: 'A中' }]);
  });
});

describe('バックグラウンドタスク一覧（issue #33、design.md §14.23）', () => {
  it('background_tasks_changedの実測形を取り込む', () => {
    // 実測（本issueの調査。実際にclaude --print --input-format stream-jsonを起動し、
    // Bashツールをrun_in_background:trueで呼び出させて確認した生のイベント）
    const state = apply([
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          {
            task_id: 'b1xre2r80',
            task_type: 'local_bash',
            description: 'Sleep 24.37 seconds in background',
          },
        ],
      },
    ]);
    expect(state.backgroundTerminals).toEqual([
      {
        id: 'b1xre2r80',
        command: 'Sleep 24.37 seconds in background',
        status: 'running',
        cwd: undefined,
        processId: undefined,
        taskType: 'local_bash',
        stoppable: true,
      },
    ]);
  });

  it('空のtasksが届くと一覧をまるごと空にする（停止・完了の実測どおり）', () => {
    const withTask = apply([
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep 30' }],
      },
    ]);
    const cleared = applyStreamEvent(withTask, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
    });
    expect(cleared.backgroundTerminals).toEqual([]);
  });

  it('tasksが配列でない通知は無視する', () => {
    const state = apply([{ type: 'system', subtype: 'background_tasks_changed' }]);
    expect(state.backgroundTerminals).toEqual([]);
  });

  it('task_idの無い要素は捨てる', () => {
    const state = apply([
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_type: 'local_bash', description: 'no id' }],
      },
    ]);
    expect(state.backgroundTerminals).toEqual([]);
  });
});

describe('作業記録用の成果（turnResultText / turnEditedFiles）', () => {
  it('resultイベントのresultフィールドを応答テキストとして取り込む', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      { type: 'result', subtype: 'success', result: '直しました' },
    ]);
    expect(state.turnResultText).toBe('直しました');
  });

  it('Edit/Write/NotebookEditのtool_useを編集ファイルとして集める', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.ts' } },
            { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/w/b.ts' } },
            { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/w/c.ts' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: '完了' },
    ]);
    expect(state.turnEditedFiles).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it('同じファイルへの複数回の編集は1件にまとめる', () => {
    const state = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.ts' } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/w/a.ts' } },
          ],
        },
      },
    ]);
    expect(state.turnEditedFiles).toEqual(['/w/a.ts']);
  });

  it('次のターンが始まると前のターンの成果と編集ファイルをリセットする', () => {
    const first = apply([
      { type: 'system', subtype: 'init', session_id: ID },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.ts' } }],
        },
      },
      { type: 'result', subtype: 'success', result: '完了' },
    ]);
    expect(first.turnEditedFiles).toEqual(['/w/a.ts']);
    expect(first.turnResultText).toBe('完了');

    const next = applyStreamEvent(first, { type: 'system', subtype: 'init', session_id: ID });
    expect(next.turnEditedFiles).toEqual([]);
    expect(next.turnResultText).toBe('');
  });
});

describe('圧縮', () => {
  it('compact_boundary が圧縮の位置を会話に残す', () => {
    const state = apply([
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'b1',
        compact_metadata: { trigger: 'manual', pre_tokens: 41321, post_tokens: 2847 },
      },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: 'compaction:b1',
      kind: 'contextCompaction',
      detail: '手動 ・ 41321 → 2847 トークン',
      status: undefined,
    });
  });

  it('自動の圧縮も同じ形で残す', () => {
    const state = apply([
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'b2',
        compact_metadata: { trigger: 'auto', pre_tokens: 100, post_tokens: 10 },
      },
    ]);
    expect(state.items[0]?.detail).toBe('自動 ・ 100 → 10 トークン');
  });

  it('同じ境目が二度届いても項目は増えない', () => {
    const event = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'b3',
      compact_metadata: { trigger: 'manual', pre_tokens: 1, post_tokens: 0 },
    };
    expect(apply([event, event]).items).toHaveLength(1);
  });

  it('成功の status では項目を作らない（境目と二重になるため）', () => {
    const state = apply([
      { type: 'system', subtype: 'status', status: null, compact_result: 'success', uuid: 's1' },
    ]);
    expect(state.items).toEqual([]);
  });

  it('進行中の status で開始を項目にする（issue #893）', () => {
    const state = apply([{ type: 'system', subtype: 'status', status: 'compacting', uuid: 's0' }]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: 'compaction:s0',
      kind: 'contextCompactionStarted',
    });
  });

  it('同じ進行中の status が二度届いても項目は増えない', () => {
    const event = { type: 'system', subtype: 'status', status: 'compacting', uuid: 's0' };
    expect(apply([event, event]).items).toHaveLength(1);
  });

  it('開始の項目は完了の項目と別に残る（issue #893）', () => {
    const state = apply([
      { type: 'system', subtype: 'status', status: 'compacting', uuid: 's0' },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'b4',
        compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 },
      },
    ]);
    expect(state.items.map((item) => item.kind)).toEqual([
      'contextCompactionStarted',
      'contextCompaction',
    ]);
  });

  it('失敗した圧縮は理由を残す', () => {
    const state = apply([
      {
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'failed',
        compact_error: 'Not enough messages to compact.',
        uuid: 's2',
      },
    ]);
    expect(state.items[0]).toMatchObject({
      kind: 'contextCompaction',
      status: 'エラー',
      text: 'Not enough messages to compact.',
    });
  });

  it('理由が無い失敗でも黙って消さない', () => {
    const state = apply([
      { type: 'system', subtype: 'status', status: null, compact_result: 'failed', uuid: 's3' },
    ]);
    expect(state.items[0]?.text).toBe('理由は判りません');
  });

  it('圧縮後に流れてくる要約は発言として並べない', () => {
    // 要約は content が文字列で届く。配列の part だけを見ているため素通しになる
    const state = apply([
      {
        type: 'user',
        uuid: 'u9',
        message: { role: 'user', content: 'This session is being continued from...' },
      },
    ]);
    expect(state.items).toEqual([]);
  });
});

describe('セッション中の設定変更', () => {
  it('承認方法が変わったことを会話に残す', () => {
    const state = apply([
      {
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: 'plan',
        uuid: 's1',
      },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: 'settings:s1',
      kind: 'settingsChanged',
      detail: '承認方法を plan に変えました',
    });
  });

  it('同じ通知が二度届いても項目は増えない', () => {
    const event = {
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'plan',
      uuid: 's2',
    };
    expect(apply([event, event]).items).toHaveLength(1);
  });

  it('圧縮の status とは混ざらない', () => {
    const state = apply([
      { type: 'system', subtype: 'status', status: 'compacting', uuid: 's3' },
      { type: 'system', subtype: 'status', status: null, compact_result: 'success', uuid: 's4' },
    ]);
    // 圧縮の開始は項目になる（issue #893）が、設定変更の項目は作られない
    expect(state.items.map((item) => item.kind)).toEqual(['contextCompactionStarted']);
  });
});

describe('Plan mode', () => {
  const status = (permissionMode: string, uuid: string) => ({
    type: 'system',
    subtype: 'status',
    status: null,
    permissionMode,
    uuid,
  });

  it('承認方法が plan なら Plan mode に入る', () => {
    expect(apply([status('plan', 'p1')]).planMode).toBe(true);
  });

  it('plan 以外へ変わると抜ける', () => {
    const inPlan = apply([status('plan', 'p1')]);
    expect(applyStreamEvent(inPlan, status('acceptEdits', 'p2')).planMode).toBe(false);
  });

  it('既定では入っていない', () => {
    expect(initialClaudeState.planMode).toBe(false);
  });

  it('承認方法を持たない status では変えない', () => {
    const inPlan = apply([status('plan', 'p1')]);
    const next = applyStreamEvent(inPlan, {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: 'p3',
    });
    expect(next.planMode).toBe(true);
  });
});

describe('自動圧縮の窓サイズ（issue #201、design.md §14.37）', () => {
  const synthetic = (text: string) => ({
    type: 'assistant',
    message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text }] },
  });

  it('/autocompactの問い合わせ応答から窓サイズを拾う', () => {
    const state = apply([synthetic('Auto-compact window: auto\nAuto-compact summarizes...')]);
    expect(state.autocompactWindow).toEqual({ mode: 'auto', tokens: undefined });
  });

  it('設定済みの応答からトークン数を拾う', () => {
    const state = apply([
      synthetic('Auto-compact window: 300k tokens (from settings)\nAuto-compact summarizes...'),
    ]);
    expect(state.autocompactWindow).toEqual({ mode: 'fixed', tokens: 300000 });
  });

  it('変更後の確認応答でも上書きする', () => {
    const first = apply([synthetic('Auto-compact window: auto\n...')]);
    const next = applyStreamEvent(first, synthetic('Auto-compact window set to 300k tokens'));
    expect(next.autocompactWindow).toEqual({ mode: 'fixed', tokens: 300000 });
  });

  it('model=<synthetic>でなければ拾わない（通常の会話文を誤検出しない）', () => {
    const state = apply([
      {
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'Auto-compact window: auto' }] },
      },
    ]);
    expect(state.autocompactWindow).toBeUndefined();
  });

  it('<synthetic>応答でも書式が一致しなければ直前の値を保つ（/recapの自然文要約など）', () => {
    const withWindow = apply([synthetic('Auto-compact window: auto\n...')]);
    const next = applyStreamEvent(withWindow, synthetic('1+1を聞かれ、2と答えた。'));
    expect(next.autocompactWindow).toEqual({ mode: 'auto', tokens: undefined });
  });

  it('一度も問い合わせていなければ undefined のまま', () => {
    expect(initialClaudeState.autocompactWindow).toBeUndefined();
  });
});
