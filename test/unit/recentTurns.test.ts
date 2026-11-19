import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import { readRecentTurns, readTurnPage } from '../../src/view/chatManagerBase';

/**
 * 統括ページのカードへ出す直近のやり取り（Issue #1260）。
 *
 * 件数は共有ディレクトリ越しに別プロセスから届くため、丸めを外すと「1件も返らない」
 * （`NaN`が比較を常に偽にする）といった、エラーにならない壊れ方をする。境界を直接なぞる。
 */

function item(kind: string, text: string, id = `${kind}-${text}`): ChatItem {
  return { id, kind, text, detail: '', status: undefined, turnId: undefined, diffs: [] };
}

const conversation = [
  item('userMessage', '1件目の質問'),
  item('agentMessage', '1件目の応答'),
  item('commandExecution', 'ls -la'),
  item('reasoning', '考え中'),
  item('userMessage', '2件目の質問'),
  item('agentMessage', '2件目の応答'),
];

describe('readRecentTurns', () => {
  it('発言・応答・ツール呼び出しを古い順で返し、思考は含めない', () => {
    expect(readRecentTurns({ items: conversation }, 10)).toEqual([
      { id: 'userMessage-1件目の質問', role: 'user', text: '1件目の質問', truncated: false },
      { role: 'agent', text: '1件目の応答', truncated: false },
      { role: 'tool', text: 'ls -la', truncated: false, title: '$ ' },
      { id: 'userMessage-2件目の質問', role: 'user', text: '2件目の質問', truncated: false },
      { role: 'agent', text: '2件目の応答', truncated: false },
    ]);
  });

  it('指定した件数だけ新しい方から取る', () => {
    expect(readRecentTurns({ items: conversation }, 2)).toEqual([
      { id: 'userMessage-2件目の質問', role: 'user', text: '2件目の質問', truncated: false },
      { role: 'agent', text: '2件目の応答', truncated: false },
    ]);
  });

  it('本文が空白だけの項目は飛ばす', () => {
    const items = [item('agentMessage', '   '), item('userMessage', '本文あり')];
    expect(readRecentTurns({ items }, 5)).toEqual([
      { id: 'userMessage-本文あり', role: 'user', text: '本文あり', truncated: false },
    ]);
  });

  it('発言には元の項目のidを付け、本文が同じでも区別する（巻き戻しの対象に使う。Issue #2160）', () => {
    const items = [item('userMessage', '同じ', 'uuid-a'), item('userMessage', '同じ', 'uuid-b')];
    expect(readRecentTurns({ items }, 5).map((t) => t.id)).toEqual(['uuid-a', 'uuid-b']);
    expect(
      readRecentTurns({ items: [item('userMessage', 'id無し', '')] }, 5)[0],
    ).not.toHaveProperty('id');
  });

  it('長い本文は切り詰めて印を立てる', () => {
    const [turn] = readRecentTurns({ items: [item('userMessage', 'あ'.repeat(8_100))] }, 1);
    expect(turn?.truncated).toBe(true);
    expect(turn?.text).toHaveLength(8_000);
  });

  it('件数は1件以上、上限以下へ丸める', () => {
    const items = Array.from({ length: 80 }, (_, i) => item('userMessage', `発言${i}`, `u${i}`));
    expect(readRecentTurns({ items }, 0)).toHaveLength(1);
    expect(readRecentTurns({ items }, -5)).toHaveLength(1);
    expect(readRecentTurns({ items }, 1000)).toHaveLength(50);
    expect(readRecentTurns({ items }, 2.7)).toHaveLength(2);
  });

  it('件数が数値として壊れていても1件は返す', () => {
    const items = [item('userMessage', '発言')];
    expect(readRecentTurns({ items }, Number.NaN)).toHaveLength(1);
    expect(readRecentTurns({ items }, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  it('やり取りが無ければ空になる', () => {
    expect(readRecentTurns({ items: [] }, 5)).toEqual([]);
    expect(readRecentTurns({ items: [item('reasoning', '考え中')] }, 5)).toEqual([]);
  });
});

describe('readTurnPage（Issue #2157）', () => {
  const long = Array.from({ length: 130 }, (_, i) => item('userMessage', `発言${i}`, `u${i}`));

  it('beforeを辿って100件を超える会話の先頭まで遡れる', () => {
    const tail = readTurnPage({ items: long }, 50);
    expect([tail.start, tail.total, tail.turns.length]).toEqual([80, 130, 50]);
    expect(tail.turns[0]?.text).toBe('発言80');
    const seen = [...tail.turns];
    let before = tail.start;
    while (before > 0) {
      const page = readTurnPage({ items: long }, 50, before);
      expect(page.start).toBeLessThan(before);
      seen.unshift(...page.turns);
      before = page.start;
    }
    expect(seen.map((t) => t.text)).toEqual(long.map((i) => i.text));
  });

  it('beforeは0〜全件へ丸め、0なら空を返す', () => {
    expect(readTurnPage({ items: long }, 5, 0)).toEqual({ turns: [], start: 0, total: 130 });
    expect(readTurnPage({ items: long }, 5, 999).start).toBe(125);
    expect(readTurnPage({ items: long }, 5, Number.NaN).start).toBe(125);
  });

  it('本文の合計が上限を超える範囲では件数を減らす（1件目は必ず載せる）', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item('agentMessage', 'x'.repeat(8_000), `a${i}`),
    );
    const page = readTurnPage({ items }, 50);
    expect(page.turns).toHaveLength(15);
    expect(page.start).toBe(15);
  });

  it('diffは見出しにファイル、本文にdiffを入れ、ツールの出力は短く切る', () => {
    const change: ChatItem = {
      ...item('fileChange', ''),
      diffs: [
        {
          path: 'a.ts',
          kind: 'update',
          movePath: undefined,
          diff: '-a\n+b',
          editReplace: undefined,
        },
        { path: 'b.ts', kind: 'update', movePath: 'c.ts', diff: '+c', editReplace: undefined },
      ],
    };
    const command: ChatItem = {
      ...item('commandExecution', 'y'.repeat(3_000)),
      detail: 'npm test',
    };
    const { turns } = readTurnPage({ items: [change, command, item('fileChange', '')] }, 10);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({
      role: 'diff',
      text: '-a\n+b\n+c',
      truncated: false,
      title: 'update a.ts, update b.ts → c.ts',
    });
    expect(turns[1]?.title).toBe('$ npm test');
    expect(turns[1]?.text).toHaveLength(2_000);
    expect(turns[1]?.truncated).toBe(true);
  });
});
