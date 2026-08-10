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

  it('未知のイベントで状態を変えない', () => {
    const state = apply([{ type: 'prompt_suggestion', text: '次はこれ' }]);
    expect(state).toEqual(initialClaudeState);
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

  it('進行中の status では何もしない', () => {
    const state = apply([{ type: 'system', subtype: 'status', status: 'compacting', uuid: 's0' }]);
    expect(state.items).toEqual([]);
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
