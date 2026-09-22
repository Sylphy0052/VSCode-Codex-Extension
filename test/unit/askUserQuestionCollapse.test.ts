// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';

/**
 * AskUserQuestionカードの折りたたみ（issue #1348）。
 *
 * `chatScript`はテンプレートリテラルの中のプレーンJavaScriptで、型検査もlintも効かない。
 * chatApprovalCard.test.tsと同じく生成結果から対象の関数だけを切り出して動かすが、
 * ここでは`hidden`・`classList`・入力要素の選択状態まで確かめたいので、自前の代役では
 * なくjsdomのDOMをそのまま渡す。切り出す範囲は目印の2箇所で挟んだ区間なので、実装が
 * 動けばここも一緒に壊れて気付ける。
 */

const START = '  function renderAskUserQuestion(approval) {';
const END = '  function renderPrompt(prompt) {';

type RenderAskUserQuestion = (approval: unknown) => HTMLElement;

function harness(): RenderAskUserQuestion {
  const source = chatScript('Codex', { mode: 'quickPick' }, false, [], false, true, 'ctrlEnter');
  const from = source.indexOf(START);
  const to = source.indexOf(END, from);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error('renderAskUserQuestionの区間を切り出せない（目印が変わった可能性）');
  }
  const block = source.slice(from, to);
  const vscode = { postMessage: (): void => {} };
  const factory = new Function('document', 'vscode', `${block}\nreturn renderAskUserQuestion;`) as (
    document: Document,
    vscode: unknown,
  ) => RenderAskUserQuestion;
  return factory(document, vscode);
}

const approval = {
  requestId: 'req-1',
  title: '方針の確認',
  questions: [
    {
      question: 'どちらで進めるか',
      header: '方針',
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
    },
    {
      question: '対象の範囲',
      header: '範囲',
      multiSelect: false,
      options: [{ label: 'C' }],
    },
  ],
};

describe('AskUserQuestionカードの折りたたみ', () => {
  it('畳むと見出しだけが残り、開くと選択が残っている', () => {
    const render = harness();
    const wrap = render(approval);
    const toggle = wrap.querySelector('.question-toggle') as HTMLButtonElement;
    const content = wrap.querySelector('.question-content') as HTMLElement;
    const note = wrap.querySelector('.question-collapsed-note') as HTMLElement;

    expect(toggle.textContent).toBe('畳む');
    expect(content.hidden).toBe(false);
    expect(note.hidden).toBe(true);

    // 1問目だけ答えた状態で畳む
    (wrap.querySelector('input[type=radio]') as HTMLInputElement).checked = true;
    toggle.click();

    expect(content.hidden).toBe(true);
    expect(wrap.classList.contains('collapsed')).toBe(true);
    expect(toggle.textContent).toBe('開く');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('未回答 1問');

    toggle.click();

    expect(content.hidden).toBe(false);
    expect(wrap.classList.contains('collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(note.hidden).toBe(true);
    expect((wrap.querySelector('input[type=radio]') as HTMLInputElement).checked).toBe(true);
  });

  it('全問答えてから畳むと回答済みと出る', () => {
    const render = harness();
    const wrap = render(approval);
    const toggle = wrap.querySelector('.question-toggle') as HTMLButtonElement;
    const note = wrap.querySelector('.question-collapsed-note') as HTMLElement;

    // 質問ごとに先頭の選択肢を選ぶ。radioのnameは質問ごとに分かれており、各質問の
    // 末尾には「その他」のradioも並ぶので、通し番号ではなくnameで選ぶ
    for (const index of [0, 1]) {
      const first = wrap.querySelector(
        `input[name="askUserQuestion-req-1-${index}"]`,
      ) as HTMLInputElement;
      first.checked = true;
    }
    toggle.click();

    expect(note.textContent).toBe('回答済み（未送信）');
  });
});
