import { describe, expect, it } from 'vitest';

import {
  HANDOFF_PROMPT_DETECTED_REASON,
  containsHandoffPrompt,
  decideAutoHandoff,
  invokedHandoffSkill,
  parseHandoffPrompt,
} from '../../src/view/handoff';

/** handoffプロンプトを囲むフェンス。ソース中にバックティックの連続を書かずに組む。 */
const FENCE = '`'.repeat(4);
/** 中身のMarkdownが持つコードブロック。外側より短い。 */
const INNER_FENCE = '`'.repeat(3);

function lines(...rows: readonly string[]): string {
  return rows.join('\n');
}

/** skillが必ず書く2行（Issue #1748）。 */
const SCHEMA = 'schema: handoff/v1';
const HANDOFF_ID = '20260913T120000-a1b2c3';
const ID_LINE = `handoff_id: ${HANDOFF_ID}`;

describe('containsHandoffPrompt（Issue #1150）', () => {
  it('標準モードのhandoffプロンプトを拾う', () => {
    const text = lines(
      '一段落したので引き継ぐ。',
      '',
      `${FENCE}markdown`,
      '# 継続 2026-09-13 feat/1150/deterministic-handoff-prompt-detection',
      SCHEMA,
      ID_LINE,
      '',
      '作業: 決定論検知の実装',
      FENCE,
    );
    expect(containsHandoffPrompt(text)).toBe(true);
  });

  it('Codex版の詳細モードの見出しも拾う（`# 継続` の前方一致）', () => {
    const text = lines(
      `${FENCE}markdown`,
      '# 継続セッション開始プロンプト',
      SCHEMA,
      ID_LINE,
      '',
      '作業: 実装',
      FENCE,
    );
    expect(containsHandoffPrompt(text)).toBe(true);
  });

  it('フェンスの中にコードブロックが入っていても、後ろの見出しまで読む', () => {
    const text = lines(
      `${FENCE}markdown`,
      '状態:',
      '',
      `${INNER_FENCE}bash`,
      'npm run check',
      INNER_FENCE,
      '',
      '# 継続 2026-09-13 main',
      SCHEMA,
      ID_LINE,
      FENCE,
    );
    expect(containsHandoffPrompt(text)).toBe(true);
  });

  it('改行がCRLFでも拾う', () => {
    const text = [`${FENCE}markdown`, '# 継続 2026-09-13 main', SCHEMA, ID_LINE, FENCE].join(
      '\r\n',
    );
    expect(containsHandoffPrompt(text)).toBe(true);
  });

  // 書式を話題にしているだけの応答で誤爆させないため、フェンスを必須にする
  it('フェンスに囲まれていない `# 継続` は拾わない', () => {
    const text = lines(
      'handoffプロンプトの見出しは次の書式になる。',
      '',
      '# 継続 2026-09-13 main',
      '',
      'これは説明であって引き継ぎの提案ではない。',
    );
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  // subagent用プロンプトも4バックティックで囲む規約のため、見出しを必須にする
  it('4バックティック囲みでも、handoffプロンプトの見出しが無ければ拾わない', () => {
    const text = lines(
      '調査をsubagentへ投げる。',
      '',
      `${FENCE}markdown`,
      '# 調査依頼',
      '',
      'src/view/handoff.ts の呼び出し元を洗い出す。',
      FENCE,
    );
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  it('3バックティックのコードブロックの中の見出しは拾わない', () => {
    const text = lines(`${INNER_FENCE}markdown`, '# 継続 2026-09-13 main', INNER_FENCE);
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  it('フェンスが閉じた後の `# 継続` は拾わない', () => {
    const text = lines(`${FENCE}markdown`, '# 調査依頼', FENCE, '', '# 継続 2026-09-13 main');
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  it('`##` 以下の見出しは拾わない（`handoff` skillの見出しは `#` のみ）', () => {
    const text = lines(`${FENCE}markdown`, '## 継続 2026-09-13 main', FENCE);
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  // skillの書式見本を引用しただけの応答で引き継ぎを始めない（Issue #1748）
  it('schemaとhandoff_idが無ければ、見出しがあっても拾わない', () => {
    const text = lines(`${FENCE}markdown`, '# 継続 2026-09-13 main', '作業: 実装', FENCE);
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  it('SKILL.mdの見本どおりhandoff_idがプレースホルダのままなら拾わない', () => {
    const text = lines(
      `${FENCE}markdown`,
      '# 継続 <YYYY-MM-DD> <branch>',
      SCHEMA,
      'handoff_id: <id>',
      FENCE,
    );
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  it('schemaとhandoff_idが別のフェンスにあれば拾わない', () => {
    const text = lines(
      `${FENCE}markdown`,
      '# 継続 2026-09-13 main',
      FENCE,
      `${FENCE}markdown`,
      SCHEMA,
      ID_LINE,
      FENCE,
    );
    expect(containsHandoffPrompt(text)).toBe(false);
  });

  it('空文字・フェンスだけの応答では拾わない', () => {
    expect(containsHandoffPrompt('')).toBe(false);
    expect(containsHandoffPrompt(lines(`${FENCE}markdown`, FENCE))).toBe(false);
  });
});

describe('parseHandoffPrompt（Issue #1748）', () => {
  it('本文とhandoff_idを取り出す', () => {
    const text = lines(
      '引き継ぐ。',
      `${FENCE}markdown`,
      '# 継続 2026-09-30 main',
      SCHEMA,
      ID_LINE,
      '作業: 実装',
      FENCE,
    );
    expect(parseHandoffPrompt(text)).toEqual({
      body: lines('# 継続 2026-09-30 main', SCHEMA, ID_LINE, '作業: 実装'),
      handoffId: HANDOFF_ID,
    });
  });
});

describe('invokedHandoffSkill（Issue #1748）', () => {
  const item = (kind: string, text: string, detail = '') => ({ kind, text, detail });

  it('直前のターンでSkillツールからhandoffを呼んでいれば真', () => {
    expect(
      invokedHandoffSkill([
        item('userMessage', '引き継いで'),
        item('mcpToolCall', '', 'Skill: handoff'),
        item('agentMessage', '引き継ぐ。'),
      ]),
    ).toBe(true);
  });

  it('プラグインの名前空間付きのskill名も数える', () => {
    expect(
      invokedHandoffSkill([item('userMessage', 'x'), item('mcpToolCall', '', 'Skill: kf:handoff')]),
    ).toBe(true);
  });

  it('ユーザーが `/handoff` と打ったターンは真', () => {
    expect(invokedHandoffSkill([item('userMessage', '/handoff'), item('agentMessage', 'x')])).toBe(
      true,
    );
  });

  it('前のターンで呼んだだけなら偽', () => {
    expect(
      invokedHandoffSkill([
        item('mcpToolCall', '', 'Skill: handoff'),
        item('userMessage', '続けて'),
        item('agentMessage', 'x'),
      ]),
    ).toBe(false);
  });

  it('別のskillや名前の似たskillは数えない', () => {
    expect(
      invokedHandoffSkill([
        item('userMessage', 'x'),
        item('mcpToolCall', '', 'Skill: handoff-review'),
        item('mcpToolCall', '', 'Skill: gitlab-develop'),
      ]),
    ).toBe(false);
  });
});

describe('決定論検知から作る契機（Issue #1150）', () => {
  /**
   * 決定論検知の経路が `decideAutoHandoff` へ渡す形。分類器を呼んでいないため
   * `safeBoundary` を渡さない。
   */
  const detected = {
    enabled: true,
    busy: false,
    alreadyStarted: false,
    compacted: false,
    thresholdPercent: 15,
    boundaryGatePassed: true,
    handoffSuggested: true,
    handoffSuggestReason: HANDOFF_PROMPT_DETECTED_REASON,
  } as const;

  it('残量に余裕があっても assistantSuggested が立つ', () => {
    expect(
      decideAutoHandoff({ ...detected, remainingPercent: 90, softThresholdPercent: 40 }),
    ).toEqual({
      kind: 'assistantSuggested',
      switchReason: '',
      suggestReason: HANDOFF_PROMPT_DETECTED_REASON,
    });
  });

  // `safeBoundary` を渡さないので softThreshold の分岐には落ちない。分類器を呼んでいない
  // 以上、「いま切り替えてよいか」の判断材料が無いまま softThreshold を名乗らせない
  it('残量がsoft閾値を下回っていても、softThresholdではなくassistantSuggestedになる', () => {
    expect(
      decideAutoHandoff({ ...detected, remainingPercent: 30, softThresholdPercent: 40 }),
    ).toEqual({
      kind: 'assistantSuggested',
      switchReason: '',
      suggestReason: HANDOFF_PROMPT_DETECTED_REASON,
    });
  });

  it('残量が閾値を下回っていれば、より正確な threshold を優先する', () => {
    expect(
      decideAutoHandoff({ ...detected, remainingPercent: 10, softThresholdPercent: 40 }),
    ).toEqual({ kind: 'threshold', remainingPercent: 10 });
  });

  it('既に引き継ぎ済みなら何も立たない', () => {
    expect(
      decideAutoHandoff({
        ...detected,
        alreadyStarted: true,
        remainingPercent: 90,
        softThresholdPercent: 40,
      }),
    ).toBeUndefined();
  });
});
