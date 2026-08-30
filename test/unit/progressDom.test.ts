import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildProgressPayload } from '../../src/view/progressDelta';
import type { ProgressTurn, ProgressView } from '../../src/view/progressModel';
import { progressScript } from '../../src/view/progressScript';
import { progressBody } from '../../src/view/progressView';

/**
 * 進捗画面のwebviewを実際のDOMの上で動かす（issue #1025）。
 *
 * 他のwebviewのテスト（`webviewScript.test.ts`）はスクリプトを文字列として構文だけ
 * 見ている。ここで見たいのは「作り直しでユーザーの状態が失われないか」なので、
 * 文字列の突き合わせでは確かめられない。
 *
 * `jsdom` の環境をvitestへ被せる（`@vitest-environment`）のではなく `JSDOM` を直接
 * 組み立てるのは、**拡張ホスト側のコードで `document` を書けてしまう状態を作らない**
 * ため。`tsconfig.json` の `lib` は `ES2022` だけで、DOMを足すと `src` 全体で
 * `document` が型として通り、実行時にしか落ちない誤りをtscが見逃すようになる。
 */

/** webviewを1つ起動する。戻り値から窓と、拡張機能へ送られたメッセージを見る。 */
function boot(): {
  window: JSDOM['window'];
  posted: unknown[];
  deliver: (payload: unknown) => void;
  turnNodes: () => Element[];
} {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${progressBody()}</body></html>`, {
    runScripts: 'outside-only',
  });
  const window = dom.window;
  const posted: unknown[] = [];
  (window as unknown as Record<string, unknown>)['acquireVsCodeApi'] = () => ({
    postMessage: (message: unknown) => {
      posted.push(message);
    },
  });
  // スクリプトはwebviewのトップレベルとして書かれている。同じ形で窓の中で評価する
  window.eval(progressScript());
  return {
    window,
    posted,
    deliver: (payload: unknown) => {
      window.dispatchEvent(
        new window.MessageEvent('message', { data: { type: 'progress', payload } }),
      );
    },
    turnNodes: () => [...window.document.querySelectorAll('#timeline > details.turn')],
  };
}

const turn = (index: number, over: Partial<ProgressTurn> = {}): ProgressTurn => ({
  index,
  instruction: `指示 ${index}`,
  response: `応答 ${index}`,
  editedFiles: [],
  fileEditCounts: Object.create(null) as Record<string, number>,
  commands: [],
  todoChanges: [],
  ...over,
});

const view = (turns: ProgressTurn[], busy = true): ProgressView => ({
  summary: {
    turnCount: turns.length,
    editedFiles: [],
    editedFileGroups: [],
    commandCount: 0,
    todoTotal: 0,
    todoCompleted: 0,
    busy,
  },
  checklist: [],
  turns,
});

/** `<details>` が開いているか。jsdomの要素はテストからは緩い型で来る。 */
const isOpen = (node: Element | undefined): boolean =>
  (node as unknown as { open: boolean } | undefined)?.open === true;

describe('タイムラインの作り直し（issue #1025）', () => {
  it('変わっていないターンのノードは作り直さない', () => {
    const { deliver, turnNodes } = boot();
    const before = view([turn(0), turn(1), turn(2)]);
    deliver(buildProgressPayload(undefined, before));
    const first = turnNodes();
    expect(first).toHaveLength(3);

    // 末尾のターンの応答だけが伸びた、応答中に毎回起きる形
    const after = view([turn(0), turn(1), turn(2, { response: '応答 2 の続き' })]);
    deliver(buildProgressPayload(before, after));

    const second = turnNodes();
    expect(second).toHaveLength(3);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    // 変わったターンだけは作り直される
    expect(second[2]).not.toBe(first[2]);
    expect(second[2]?.textContent).toContain('応答 2 の続き');
  });

  it('選んだ文字が、後続の更新をまたいで残る', () => {
    const { window, deliver } = boot();
    const before = view([turn(0), turn(1)]);
    deliver(buildProgressPayload(undefined, before));

    const target = window.document.querySelector('#timeline > details.turn .response');
    expect(target).not.toBeNull();
    const range = window.document.createRange();
    range.selectNodeContents(target as Node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe('応答 0');

    // 末尾のターンだけが伸びる更新。選択しているのは先頭のターン
    const after = view([turn(0), turn(1, { response: '応答 1 の続き' })]);
    deliver(buildProgressPayload(before, after));

    expect(window.getSelection()?.toString()).toBe('応答 0');
  });

  it('増えたターンは末尾へ足し、既にあるターンはそのまま残す', () => {
    const { deliver, turnNodes } = boot();
    const before = view([turn(0)]);
    deliver(buildProgressPayload(undefined, before));
    const first = turnNodes();

    const after = view([turn(0), turn(1)]);
    deliver(buildProgressPayload(before, after));

    const second = turnNodes();
    expect(second).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
  });

  it('全量が届いたら作り直す（巻き戻し・resume）', () => {
    const { deliver, turnNodes } = boot();
    const before = view([turn(0), turn(1), turn(2)]);
    deliver(buildProgressPayload(undefined, before));
    const first = turnNodes();

    const after = view([turn(0)]);
    deliver(buildProgressPayload(before, after));

    const second = turnNodes();
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
  });

  it('自分で開いた古いターンは、後続の更新をまたいでも開いたまま', () => {
    const { deliver, turnNodes } = boot();
    // OPEN_TURNS は3。5ターンあれば先頭の2つは畳まれている
    const before = view([turn(0), turn(1), turn(2), turn(3), turn(4)]);
    deliver(buildProgressPayload(undefined, before));
    expect(isOpen(turnNodes()[0])).toBe(false);

    // summary のクリックが開閉を覚える経路（issue #750）
    const head = turnNodes()[0]?.querySelector('summary');
    (head as unknown as { click: () => void }).click();

    const after = view([turn(0), turn(1), turn(2), turn(3), turn(4, { response: '続き' })]);
    deliver(buildProgressPayload(before, after));

    expect(isOpen(turnNodes()[0])).toBe(true);
  });

  it('据え置いたターンの見出しに当たっていたフォーカスが残る', () => {
    const { window, deliver, turnNodes } = boot();
    const before = view([turn(0), turn(1), turn(2)]);
    deliver(buildProgressPayload(undefined, before));
    const head = turnNodes()[0]?.querySelector('summary');
    (head as unknown as { focus: () => void }).focus();
    expect(window.document.activeElement).toBe(head);

    const after = view([turn(0), turn(1), turn(2, { response: '続き' })]);
    deliver(buildProgressPayload(before, after));

    expect(window.document.activeElement).toBe(head);
  });

  it('「閉じているNターンを開く」に当たっていたフォーカスが残る', () => {
    const { window, deliver } = boot();
    // 5ターンあれば先頭の2つが畳まれ、ボタンが出る
    const before = view([turn(0), turn(1), turn(2), turn(3), turn(4)]);
    deliver(buildProgressPayload(undefined, before));
    const button = window.document.querySelector('#timelineMore button');
    expect(button).not.toBeNull();
    (button as unknown as { focus: () => void }).focus();
    expect(window.document.activeElement).toBe(button);

    // 畳まれている件数が変わらない更新では、ボタンを作り直さない
    const after = view([turn(0), turn(1), turn(2), turn(3), turn(4, { response: '続き' })]);
    deliver(buildProgressPayload(before, after));

    expect(window.document.activeElement).toBe(button);
  });

  it('積み直せなければ全量を送り直してもらう', () => {
    const { deliver, posted } = boot();

    deliver({
      summary: view([]).summary,
      checklist: [],
      turns: { mode: 'delta', turns: [], total: 3 },
    });

    expect(posted).toContainEqual({ type: 'progressFull' });
  });
});

describe('状態の読み上げ（issue #1025）', () => {
  it('状態バッジは live region で、遷移したときだけ書き換わる', () => {
    const { window, deliver } = boot();
    deliver(buildProgressPayload(undefined, view([turn(0)], true)));
    const badge = window.document.getElementById('statusBadge');
    expect(badge?.getAttribute('aria-live')).toBe('polite');
    const text = badge?.querySelector('.text');
    expect(text?.textContent).toBe('応答中');

    // 応答中のまま更新が続いても、読み上げ対象のノードは触らない
    deliver(
      buildProgressPayload(view([turn(0)], true), view([turn(0, { response: '続き' })], true)),
    );
    expect(window.document.getElementById('statusBadge')?.querySelector('.text')).toBe(text);

    // 待機中へ移ったときだけ書き換わる
    deliver(
      buildProgressPayload(view([turn(0, { response: '続き' })], true), view([turn(0)], false)),
    );
    expect(window.document.getElementById('statusBadge')?.querySelector('.text')?.textContent).toBe(
      '待機中',
    );
  });
});
