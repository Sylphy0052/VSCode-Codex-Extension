import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem } from '../../src/appserver/chatState';
import { buildResponseSummary, MAX_SUMMARY_LENGTH } from '../../src/orchestrator/taskSummary';

function agentMessage(text: string): ChatItem {
  return {
    id: 'i1',
    kind: 'agentMessage',
    text,
    detail: '',
    status: undefined,
    turnId: undefined,
    diffs: [],
  };
}

describe('buildResponseSummary（design.md §16.8「直近の応答の1行要約」）', () => {
  it('ターン完了後はturnResultTextの最初の行を使う', () => {
    const state = { ...initialChatState, turnResultText: '1行目\n2行目以降は捨てる' };
    expect(buildResponseSummary(state)).toBe('1行目');
  });

  it('進行中（turnResultTextが空）は直近のagentMessage項目を使う', () => {
    const state = {
      ...initialChatState,
      turnResultText: '',
      items: [agentMessage('準備中です'), agentMessage('ファイルを編集しています')],
    };
    expect(buildResponseSummary(state)).toBe('ファイルを編集しています');
  });

  it('空のagentMessageは飛ばして直近の非空項目を使う', () => {
    const state = {
      ...initialChatState,
      turnResultText: '',
      items: [agentMessage('最初の応答'), agentMessage('   ')],
    };
    expect(buildResponseSummary(state)).toBe('最初の応答');
  });

  it('応答がまだ無ければ空文字', () => {
    expect(buildResponseSummary(initialChatState)).toBe('');
  });

  it('長い応答は上限文字数で省略する', () => {
    const long = 'a'.repeat(MAX_SUMMARY_LENGTH + 50);
    const state = { ...initialChatState, turnResultText: long };
    const summary = buildResponseSummary(state);
    expect(summary.length).toBe(MAX_SUMMARY_LENGTH + 1); // 省略記号(…)の1文字ぶん
    expect(summary.endsWith('…')).toBe(true);
  });

  it('先頭が空行でも最初の非空行を拾う', () => {
    const state = { ...initialChatState, turnResultText: '\n\n本題はここから' };
    expect(buildResponseSummary(state)).toBe('本題はここから');
  });

  it('ANSIエスケープ・ゼロ幅文字を落とす（レビュー指摘: low）', () => {
    const esc = '\u001b[31m';
    const reset = '\u001b[0m';
    const zeroWidthSpace = '\u200b';
    const state = {
      ...initialChatState,
      turnResultText: esc + 'red' + reset + zeroWidthSpace + 'text',
    };
    const summary = buildResponseSummary(state);
    expect(summary).not.toContain(esc);
    expect(summary).not.toContain(zeroWidthSpace);
  });
});
