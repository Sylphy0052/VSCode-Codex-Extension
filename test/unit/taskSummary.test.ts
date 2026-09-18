import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem } from '../../src/appserver/chatState';
import {
  buildResponseSummary,
  buildStructuredSummary,
  formatBrief,
  MAX_STRUCTURED_ITEM_LENGTH,
  MAX_STRUCTURED_ITEMS,
  MAX_SUMMARY_LENGTH,
  responseBodyText,
} from '../../src/orchestrator/taskSummary';

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

describe('buildStructuredSummary / formatBrief（design.md §16.4「既定はpull型」、Issue #1271）', () => {
  const empty = { files: [], artifacts: [] };

  it('見出しごとに決めたことと未解決へ振り分ける', () => {
    const state = {
      ...initialChatState,
      turnResultText: [
        '作業を終えた',
        '## 決定',
        '- 方式Aを採る',
        '- 設定は既定のまま',
        '## 未解決',
        '- 移行手順は次のIssueで決める',
      ].join('\n'),
    };
    const brief = buildStructuredSummary(state, empty);
    expect(brief.decisions).toEqual(['方式Aを採る', '設定は既定のまま']);
    expect(brief.openQuestions).toEqual(['移行手順は次のIssueで決める']);
  });

  it('区分を判定できない見出しの配下は決めたこととして扱う', () => {
    const state = {
      ...initialChatState,
      turnResultText: '## 変更内容\n- ポートを1つ足した',
    };
    expect(buildStructuredSummary(state, empty).decisions).toEqual(['ポートを1つ足した']);
  });

  it('見出しが無くても、行そのものが未解決を表すなら未解決へ入れる', () => {
    const state = {
      ...initialChatState,
      turnResultText: '- 実装した\n- TODO: 実機で確認する\n- 要確認: 権限の既定値',
    };
    const brief = buildStructuredSummary(state, empty);
    expect(brief.decisions).toEqual(['実装した']);
    expect(brief.openQuestions).toEqual(['TODO: 実機で確認する', '要確認: 権限の既定値']);
  });

  it('箇条書きが1つも無い応答からは何も取れない（抽出は体裁の推測でしかない）', () => {
    const state = { ...initialChatState, turnResultText: '普通の文章で報告しただけ。' };
    const brief = buildStructuredSummary(state, empty);
    expect(brief.decisions).toEqual([]);
    expect(brief.openQuestions).toEqual([]);
    // 抽出に失敗してもワークフローは止めない。1行要約だけは残る
    expect(brief.summary).toBe('普通の文章で報告しただけ。');
  });

  it('同じ項目は重複させず、件数の上限で打ち切る', () => {
    const lines = Array.from({ length: MAX_STRUCTURED_ITEMS + 3 }, (_, i) => `- 項目${i}`);
    const state = {
      ...initialChatState,
      turnResultText: ['- 同じ項目', '- 同じ項目', ...lines].join('\n'),
    };
    const { decisions } = buildStructuredSummary(state, empty);
    expect(decisions.length).toBe(MAX_STRUCTURED_ITEMS);
    expect(decisions.filter((d) => d === '同じ項目').length).toBe(1);
  });

  it('1項目が長すぎる場合は上限で省略する', () => {
    const long = 'a'.repeat(MAX_STRUCTURED_ITEM_LENGTH + 50);
    const state = { ...initialChatState, turnResultText: `- ${long}` };
    const item = buildStructuredSummary(state, empty).decisions[0] ?? '';
    expect(item.length).toBe(MAX_STRUCTURED_ITEM_LENGTH + 1); // 省略記号(…)の1文字ぶん
    expect(item.endsWith('…')).toBe(true);
  });

  it('filesとartifactsも同じ件数の上限に載せる', () => {
    const files = Array.from({ length: MAX_STRUCTURED_ITEMS + 2 }, (_, i) => `src/f${i}.ts`);
    const brief = buildStructuredSummary(initialChatState, { files, artifacts: ['参照1'] });
    expect(brief.files.length).toBe(MAX_STRUCTURED_ITEMS);
    expect(brief.artifacts).toEqual(['参照1']);
  });

  it('turnResultTextが空でも直近のagentMessageから抽出する（書き出し側と入口を揃える）', () => {
    const state = {
      ...initialChatState,
      turnResultText: '',
      items: [agentMessage('## 決定\n- 途中経過の決定')],
    };
    expect(buildStructuredSummary(state, empty).decisions).toEqual(['途中経過の決定']);
    expect(responseBodyText(state)).toBe('## 決定\n- 途中経過の決定');
  });

  it('応答がまだ無ければ本文は空文字（この場合は受け渡しファイルを書かない）', () => {
    expect(responseBodyText(initialChatState)).toBe('');
  });

  it('formatBriefは中身のある区分だけを並べる', () => {
    const state = {
      ...initialChatState,
      turnResultText: '要点だけ書いた\n## 決定\n- 方式Aを採る',
    };
    const text = formatBrief(buildStructuredSummary(state, { files: [], artifacts: ['参照1'] }));
    expect(text).toContain('要点だけ書いた');
    expect(text).toContain('決めたこと:\n- 方式Aを採る');
    expect(text).toContain('成果物:\n- 参照1');
    // 空の区分は見出しごと出さない
    expect(text).not.toContain('未解決:');
    expect(text).not.toContain('変更したファイル:');
  });

  it('formatBriefは中身が1つも無ければ空文字（空の枠をプロンプトへ残さない）', () => {
    expect(formatBrief(buildStructuredSummary(initialChatState, empty))).toBe('');
  });
});
