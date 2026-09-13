import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';

/**
 * 通常の承認カード（command / fileChange / permissions）のボタン構成（issue #1194）。
 *
 * `chatScript`はテンプレートリテラルの中のプレーンJavaScriptで、型検査もlintも効かない。
 * ここで確かめたいのは「押しても効かないボタンを出さないこと」であり、生成結果の文字列に
 * `acceptForSession`が含まれるかどうかでは固定できない（Codex画面では正しく出るため、
 * 同じ文字列が必ず残る）。
 *
 * そこで`renderApproval`だけを生成結果から切り出し、`document`と`vscode`の最小の代役を
 * 与えて実際に動かす。切り出す範囲は目印の2箇所で挟んだ区間なので、実装が動けばここも
 * 一緒に壊れて気付ける（黙って対象を外さない）。
 */

const START = '  function renderApproval(approval, items) {';
const END = ['  /**', '   * AskUserQuestion（issue #685）の選択UI。'].join('\n');

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  disabled: boolean;
  children: FakeNode[];
  appendChild(child: FakeNode): void;
  querySelectorAll(selector: string): FakeNode[];
  addEventListener(type: string, handler: () => void): void;
  click(): void;
}

function createNode(tagName: string): FakeNode {
  const handlers: Array<() => void> = [];
  const node: FakeNode = {
    tagName,
    className: '',
    textContent: '',
    disabled: false,
    children: [],
    appendChild(child) {
      node.children.push(child);
    },
    querySelectorAll(selector) {
      const want = selector.toLowerCase();
      const found: FakeNode[] = [];
      const walk = (n: FakeNode): void => {
        for (const child of n.children) {
          if (child.tagName === want) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    addEventListener(type, handler) {
      if (type === 'click') handlers.push(handler);
    },
    click() {
      for (const handler of handlers) handler();
    },
  };
  return node;
}

type RenderApproval = (
  approval: Record<string, unknown>,
  items: ReadonlyArray<Record<string, unknown>>,
) => FakeNode;

interface Harness {
  render: RenderApproval;
  posted: Array<Record<string, unknown>>;
  askUserQuestionCalls: number;
}

/** 生成されたスクリプトから`renderApproval`の区間を切り出し、代役を与えて動かす。 */
function harness(provider: 'codex' | 'claude'): Harness {
  const source = chatScript(
    provider === 'claude' ? 'Claude Code' : 'Codex',
    { mode: 'quickPick' },
    false,
    [],
    false,
    true,
    'ctrlEnter',
    '{}',
    provider,
  );
  const from = source.indexOf(START);
  const to = source.indexOf(END, from);
  if (from < 0 || to < 0 || to <= from) {
    throw new Error('renderApprovalの区間を切り出せない（目印が変わった可能性）');
  }
  const block = source.slice(from, to);

  const posted: Array<Record<string, unknown>> = [];
  const state = { askUserQuestionCalls: 0 };
  const document = { createElement: (tag: string): FakeNode => createNode(tag) };
  const vscode = {
    postMessage: (message: Record<string, unknown>): void => {
      posted.push(message);
    },
  };
  const renderAskUserQuestion = (): FakeNode => {
    state.askUserQuestionCalls += 1;
    return createNode('div');
  };
  const renderDiffs = (): void => {
    throw new Error('差分の無い承認では呼ばれない');
  };

  const factory = new Function(
    'document',
    'vscode',
    'APPROVAL_PROVIDER',
    'askUserQuestionNodes',
    'renderAskUserQuestion',
    'renderDiffs',
    `${block}\nreturn renderApproval;`,
  ) as (
    document: unknown,
    vscode: unknown,
    provider: string,
    askUserQuestionNodes: Map<string, FakeNode>,
    renderAskUserQuestion: () => FakeNode,
    renderDiffs: () => void,
  ) => RenderApproval;

  return {
    render: factory(
      document,
      vscode,
      provider,
      new Map<string, FakeNode>(),
      renderAskUserQuestion,
      renderDiffs,
    ),
    posted,
    get askUserQuestionCalls(): number {
      return state.askUserQuestionCalls;
    },
  };
}

const approval = {
  requestId: 'req-1',
  kind: 'command',
  title: 'コマンドの実行を許可しますか',
  detail: 'rm -rf /tmp/example',
  itemId: undefined,
};

const buttonsOf = (node: FakeNode): FakeNode[] => node.querySelectorAll('button');

const buttonAt = (buttons: readonly FakeNode[], index: number): FakeNode => {
  const button = buttons[index];
  if (button === undefined) throw new Error(`ボタンが足りない: ${index}`);
  return button;
};

describe('renderApproval のボタン構成', () => {
  it('Codexでは「この会話では常に許可」を出す（会話単位の許可を実際に送れる）', () => {
    const h = harness('codex');

    const labels = buttonsOf(h.render(approval, [])).map((b) => b.textContent);

    expect(labels).toEqual(['許可', 'この会話では常に許可', '拒否']);
  });

  it('Claudeでは「この会話では常に許可」を出さない（単発の許可にしかならない）', () => {
    const h = harness('claude');

    const labels = buttonsOf(h.render(approval, [])).map((b) => b.textContent);

    expect(labels).toEqual(['許可', '拒否']);
  });

  it('Claudeでも許可・拒否は従来どおり送る', () => {
    const h = harness('claude');
    const buttons = buttonsOf(h.render(approval, []));

    buttonAt(buttons, 0).click();

    expect(h.posted).toEqual([{ type: 'approve', requestId: 'req-1', decision: 'accept' }]);
    // 押した後は二重送信を防ぐため全ボタンを無効化する（従来の振る舞い）
    expect(buttons.map((b) => b.disabled)).toEqual([true, true]);

    const other = harness('claude');
    const otherButtons = buttonsOf(other.render(approval, []));
    buttonAt(otherButtons, 1).click();
    expect(other.posted).toEqual([{ type: 'approve', requestId: 'req-1', decision: 'decline' }]);
  });

  it('ClaudeのAskUserQuestionは専用の描画へ委譲したまま（今回の出し分けの対象外）', () => {
    const h = harness('claude');

    h.render({ requestId: 'req-2', kind: 'askUserQuestion', title: '質問' }, []);

    expect(h.askUserQuestionCalls).toBe(1);
    expect(h.posted).toEqual([]);
  });
});
