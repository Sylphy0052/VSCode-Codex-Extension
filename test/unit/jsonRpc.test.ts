import { describe, expect, it } from 'vitest';
import {
  consumeFrames,
  FrameBuffer,
  encodeNotification,
  encodeRequest,
  readForkedThreadId,
} from '../../src/codex/jsonRpc';
import { MAX_APP_SERVER_LINE_BYTES, MAX_LINE_BUFFER_BYTES } from '../../src/process/childProcess';

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

  it('maxBytesを渡すと既定より大きい行を通せる（issue #795）', () => {
    // app-server経路は会話アイテムを全件含む応答が1行で届くため、既定の10MBでは足りない
    const overDefault = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);
    expect(consumeFrames(overDefault).overflow).toBe(true);
    expect(consumeFrames(overDefault, MAX_APP_SERVER_LINE_BYTES).overflow).toBe(false);
  });

  it('maxBytesを渡しても、それを超えればoverflowは立つ（上限を撤廃していない）', () => {
    expect(consumeFrames('x'.repeat(1025), 1024).overflow).toBe(true);
    expect(consumeFrames('x'.repeat(1024), 1024).overflow).toBe(false);
  });

  it('マルチバイト文字はバイト数で判定する（code unit数ではない）', () => {
    // 「あ」はUTF-16では1 code unit、UTF-8では3バイト
    const text = 'あ'.repeat(4);
    expect(text.length).toBe(4);
    expect(consumeFrames(text, 12).overflow).toBe(false);
    expect(consumeFrames(text, 11).overflow).toBe(true);
  });
});

describe('FrameBuffer', () => {
  it('チャンクをまたいで完成した行だけを返す', () => {
    const frames = new FrameBuffer();
    expect(frames.push(Buffer.from('{"id":1,')).messages).toEqual([]);
    const result = frames.push(Buffer.from('"result":{}}\n{"id":2'));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe(1);
    expect(result.rest).toBe('{"id":2');
  });

  it('1チャンクに複数行が入っていてもすべて取り出す', () => {
    const frames = new FrameBuffer();
    const { messages } = frames.push(Buffer.from('{"id":1}\n{"id":2}\n'));
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('改行が来ないまま上限を超えるとoverflowが立つ（issue #795）', () => {
    const frames = new FrameBuffer(1024);
    // 行が完成しないチャンクでも、上限の判定は毎回行う
    expect(frames.push(Buffer.from('x'.repeat(1024))).overflow).toBe(false);
    expect(frames.push(Buffer.from('x')).overflow).toBe(true);
  });

  it('上限の判定はバイト数で行う（マルチバイト文字）', () => {
    const frames = new FrameBuffer(11);
    expect(frames.push(Buffer.from('あああ')).overflow).toBe(false);
    expect(frames.push(Buffer.from('あ')).overflow).toBe(true);
  });

  it('clearで溜めている未完成分と積算バイト数を捨てる', () => {
    const frames = new FrameBuffer(1024);
    expect(frames.push(Buffer.from('x'.repeat(1025))).overflow).toBe(true);
    frames.clear();
    const after = frames.push(Buffer.from('{"id":1}\n'));
    expect(after.overflow).toBe(false);
    expect(after.messages).toHaveLength(1);
    expect(after.rest).toBe('');
  });

  it('マルチバイト文字がチャンクの境界で分断されても壊れない（issue #795）', () => {
    // `chunk.toString('utf8')`をチャンクごとに呼ぶと置換文字（U+FFFD）へ化ける分割位置
    const line = Buffer.from('{"id":1,"result":{"t":"あいう"}}\n');
    const frames = new FrameBuffer();
    for (let i = 1; i < line.length; i += 1) {
      frames.clear();
      expect(frames.push(line.subarray(0, i)).messages).toEqual([]);
      const { messages } = frames.push(line.subarray(i));
      expect(messages).toHaveLength(1);
      expect(messages[0]?.result).toEqual({ t: 'あいう' });
    }
  });

  it('clearすると持ち越し中の不完全なバイト列も捨てる（前の世代の残骸を継がない）', () => {
    const frames = new FrameBuffer();
    const head = Buffer.from('あ').subarray(0, 2);
    expect(frames.push(head).messages).toEqual([]);
    frames.clear();
    const { messages, rest } = frames.push(Buffer.from('{"id":1}\n'));
    expect(messages).toHaveLength(1);
    expect(rest).toBe('');
  });

  it('行の完成後は積算バイト数が残りの分まで戻る', () => {
    const frames = new FrameBuffer(16);
    expect(frames.push(Buffer.from('{"id":1}\n')).overflow).toBe(false);
    // 直前のチャンクを含めた総量（9+9=18バイト）ではなく、restの分だけで判定する
    expect(frames.push(Buffer.from('{"id":2}\n')).overflow).toBe(false);
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
