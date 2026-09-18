import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import { readRecentTurns } from '../../src/view/chatManagerBase';

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
  it('人の発言とエージェントの応答だけを古い順で返す', () => {
    expect(readRecentTurns({ items: conversation }, 10)).toEqual([
      { role: 'user', text: '1件目の質問', truncated: false },
      { role: 'agent', text: '1件目の応答', truncated: false },
      { role: 'user', text: '2件目の質問', truncated: false },
      { role: 'agent', text: '2件目の応答', truncated: false },
    ]);
  });

  it('指定した件数だけ新しい方から取る', () => {
    expect(readRecentTurns({ items: conversation }, 2)).toEqual([
      { role: 'user', text: '2件目の質問', truncated: false },
      { role: 'agent', text: '2件目の応答', truncated: false },
    ]);
  });

  it('本文が空白だけの項目は飛ばす', () => {
    const items = [item('agentMessage', '   '), item('userMessage', '本文あり')];
    expect(readRecentTurns({ items }, 5)).toEqual([
      { role: 'user', text: '本文あり', truncated: false },
    ]);
  });

  it('長い本文は切り詰めて印を立てる', () => {
    const [turn] = readRecentTurns({ items: [item('userMessage', 'あ'.repeat(700))] }, 1);
    expect(turn?.truncated).toBe(true);
    expect(turn?.text).toHaveLength(600);
  });

  it('件数は1件以上、上限以下へ丸める', () => {
    const items = Array.from({ length: 40 }, (_, i) => item('userMessage', `発言${i}`, `u${i}`));
    expect(readRecentTurns({ items }, 0)).toHaveLength(1);
    expect(readRecentTurns({ items }, -5)).toHaveLength(1);
    expect(readRecentTurns({ items }, 1000)).toHaveLength(20);
    expect(readRecentTurns({ items }, 2.7)).toHaveLength(2);
  });

  it('件数が数値として壊れていても1件は返す', () => {
    const items = [item('userMessage', '発言')];
    expect(readRecentTurns({ items }, Number.NaN)).toHaveLength(1);
    expect(readRecentTurns({ items }, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  it('やり取りが無ければ空になる', () => {
    expect(readRecentTurns({ items: [] }, 5)).toEqual([]);
    expect(readRecentTurns({ items: [item('commandExecution', 'ls')] }, 5)).toEqual([]);
  });
});
