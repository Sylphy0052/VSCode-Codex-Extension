import { describe, expect, it } from 'vitest';
import { consumeFrames, encodeNotification, encodeRequest, readForkedThreadId } from '../../src/codex/jsonRpc';
import { MAX_LINE_BUFFER_BYTES } from '../../src/process/childProcess';

describe('consumeFrames', () => {
  it('完成した行だけをメッセージにする', () => {
    const { messages, rest } = consumeFrames('{"id":1,"result":{}}\n{"id":2');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(1);
    expect(rest).toBe('{"id":2');
  });

  it('分割して届いても連結すれば読める（ストリームの前提）', () => {
    const first = consumeFrames('{"id":1,"resu');
    expect(first.messages).toEqual([]);
    const second = consumeFrames(`${first.rest}lt":{"ok":true}}\n`);
    expect(second.messages[0]?.result).toEqual({ ok: true });
    expect(second.rest).toBe('');
  });

  it('複数行を一度に処理する', () => {
    const { messages } = consumeFrames('{"id":1}\n{"id":2}\n{"method":"x"}\n');
    expect(messages.map((m) => m.id ?? m.method)).toEqual([1, 2, 'x']);
  });

  it('JSONでない行を捨てる（診断出力が混ざるため）', () => {
    const { messages } = consumeFrames('起動しました\n{"id":1}\n');
    expect(messages).toHaveLength(1);
  });

  it('配列やスカラーの行を受け付けない', () => {
    expect(consumeFrames('[1,2]\n"x"\n3\n').messages).toEqual([]);
  });

  it('空行を無視する', () => {
    expect(consumeFrames('\n\n{"id":1}\n').messages).toHaveLength(1);
  });

  it('restが上限以内ならoverflowは立たない', () => {
    const { overflow } = consumeFrames('{"id":1}\n' + 'x'.repeat(1024));
    expect(overflow).toBe(false);
  });

  it('改行を含まない出力が上限を超えるとoverflowが立つ（issue #402、1点目）', () => {
    // 改行が一切無いため、既存メッセージには影響しない（messagesは空のまま）
    const huge = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);
    const { messages, rest, overflow } = consumeFrames(huge);
    expect(messages).toEqual([]);
    expect(rest).toBe(huge);
    expect(overflow).toBe(true);
  });

  it('上限ちょうどまではoverflowが立たない（境界値）', () => {
    const atLimit = 'x'.repeat(MAX_LINE_BUFFER_BYTES);
    expect(consumeFrames(atLimit).overflow).toBe(false);
  });
});

describe('encodeRequest / encodeNotification', () => {
  it('改行区切りのJSON-RPCとして組み立てる', () => {
    const line = encodeRequest(2, 'thread/fork', { threadId: 'a' });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'thread/fork',
      params: { threadId: 'a' },
    });
  });

  it('通知にはidを含めない', () => {
    expect(JSON.parse(encodeNotification('initialized', {}))).toEqual({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    });
  });
});

describe('readForkedThreadId', () => {
  it('実際の応答形からidを取り出す', () => {
    const result = {
      thread: {
        id: '019fd880-dd5b-7a03-a07a-bfd9a1fc4808',
        sessionId: '019fd880-dd5b-7a03-a07a-bfd9a1fc4808',
        forkedFromId: '019fd857-e74b-7462-aefc-0534a981ca7f',
      },
    };
    expect(readForkedThreadId(result)).toBe('019fd880-dd5b-7a03-a07a-bfd9a1fc4808');
  });

  it('idが無ければsessionIdで代用する', () => {
    expect(readForkedThreadId({ thread: { sessionId: 'abc' } })).toBe('abc');
  });

  it('想定外の形はundefined', () => {
    expect(readForkedThreadId(undefined)).toBeUndefined();
    expect(readForkedThreadId({})).toBeUndefined();
    expect(readForkedThreadId({ thread: {} })).toBeUndefined();
    expect(readForkedThreadId({ thread: { id: '' } })).toBeUndefined();
  });
});
