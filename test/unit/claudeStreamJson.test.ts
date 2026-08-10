import { describe, expect, it } from 'vitest';
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

  it('未知のイベントで状態を変えない', () => {
    const state = apply([{ type: 'prompt_suggestion', text: '次はこれ' }]);
    expect(state).toEqual(initialClaudeState);
  });
});
