import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEND_ON,
  SEND_KEY_SOURCE,
  decideSendKeyAction,
  normalizeSendOn,
  type SendKeyEventLike,
  type SendOnMode,
} from '../../src/view/sendKey';

const key = (overrides: Partial<SendKeyEventLike> = {}): SendKeyEventLike => ({
  key: 'Enter',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe('normalizeSendOn（issue #288）', () => {
  it('"enter" はそのまま通す', () => {
    expect(normalizeSendOn('enter')).toBe('enter');
  });

  it('未知の値・undefined・数値などは既定（ctrlEnter）へ丸める', () => {
    expect(normalizeSendOn('ctrlEnter')).toBe('ctrlEnter');
    expect(normalizeSendOn(undefined)).toBe(DEFAULT_SEND_ON);
    expect(normalizeSendOn('')).toBe(DEFAULT_SEND_ON);
    expect(normalizeSendOn('Enter')).toBe(DEFAULT_SEND_ON);
    expect(normalizeSendOn(123)).toBe(DEFAULT_SEND_ON);
  });
});

describe('decideSendKeyAction（ctrlEnterモード。issue #288）', () => {
  const sendOn: SendOnMode = 'ctrlEnter';

  it('Enter単独では送信しない（改行のまま、従来の挙動）', () => {
    expect(decideSendKeyAction(key(), sendOn)).toBe('ignore');
  });

  it('Shift+Enterでも送信しない', () => {
    expect(decideSendKeyAction(key({ shiftKey: true }), sendOn)).toBe('ignore');
  });

  it('Ctrl+Enterで送信する', () => {
    expect(decideSendKeyAction(key({ ctrlKey: true }), sendOn)).toBe('send');
  });

  it('Cmd（meta）+Enterでも送信する', () => {
    expect(decideSendKeyAction(key({ metaKey: true }), sendOn)).toBe('send');
  });

  it('IME変換中のEnterは送信しない（Ctrl+Enterであっても）', () => {
    expect(decideSendKeyAction(key({ isComposing: true }), sendOn)).toBe('ignore');
    expect(decideSendKeyAction(key({ ctrlKey: true, isComposing: true }), sendOn)).toBe('ignore');
  });

  it('Enter以外のキーには反応しない', () => {
    expect(decideSendKeyAction(key({ key: 'a' }), sendOn)).toBe('ignore');
  });
});

describe('decideSendKeyAction（enterモード。issue #288）', () => {
  const sendOn: SendOnMode = 'enter';

  it('Enter単独で送信する', () => {
    expect(decideSendKeyAction(key(), sendOn)).toBe('send');
  });

  it('Shift+Enterは改行に回し、送信しない', () => {
    expect(decideSendKeyAction(key({ shiftKey: true }), sendOn)).toBe('ignore');
  });

  it('Ctrl+Enterでも送信できる（ctrlEnterに慣れた手を潰さない）', () => {
    expect(decideSendKeyAction(key({ ctrlKey: true }), sendOn)).toBe('send');
  });

  it('Cmd（meta）+Enterでも送信できる', () => {
    expect(decideSendKeyAction(key({ metaKey: true }), sendOn)).toBe('send');
  });

  it('IME変換中のEnterは送信しない', () => {
    expect(decideSendKeyAction(key({ isComposing: true }), sendOn)).toBe('ignore');
  });

  it('IME変換中はShift+Enterでも送信しない', () => {
    expect(decideSendKeyAction(key({ isComposing: true, shiftKey: true }), sendOn)).toBe(
      'ignore',
    );
  });
});

/**
 * webview側の送信キー判定は `chatScript` へソースとして埋め込まれ、型検査もlintも効かない。
 * ここで評価して振る舞いだけを確かめる（`webviewScript.test.ts` は構文しか見ない）。
 * `stateDelta.test.ts` の `mergeItems` と同じ流儀。
 */
const webviewDecideSendKeyAction = new Function(
  `return (${SEND_KEY_SOURCE});`,
)() as typeof decideSendKeyAction;

describe('decideSendKeyAction（webview側。issue #288）', () => {
  const cases: Array<[string, SendKeyEventLike, SendOnMode]> = [
    ['ctrlEnterのEnter単独', key(), 'ctrlEnter'],
    ['ctrlEnterのCtrl+Enter', key({ ctrlKey: true }), 'ctrlEnter'],
    ['ctrlEnterのIME変換中', key({ isComposing: true }), 'ctrlEnter'],
    ['enterのEnter単独', key(), 'enter'],
    ['enterのShift+Enter', key({ shiftKey: true }), 'enter'],
    ['enterのCtrl+Enter', key({ ctrlKey: true }), 'enter'],
    ['enterのIME変換中', key({ isComposing: true }), 'enter'],
  ];

  it.each(cases)('%s はTS実装と同じ結果になる', (_label, event, sendOn) => {
    expect(webviewDecideSendKeyAction(event, sendOn)).toBe(decideSendKeyAction(event, sendOn));
  });
});
