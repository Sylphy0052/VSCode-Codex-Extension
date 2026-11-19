import { describe, expect, it } from 'vitest';
import {
  KEY_BINDINGS,
  KEY_HELP,
  assignAccessKeys,
  bindingDisplay,
  boundLetters,
  filterPalette,
  mapKey,
  parseKeySpec,
  resolveKey,
  type McKeyInput,
  type McPaletteEntry,
} from '../../src/webview/missionControl/keys';

/** Mission Controlのキーの表（Issue #2152）。ヘルプ・判定・パレットが同じ表から作られることを確かめる。 */

const base: McKeyInput = {
  key: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  inEditable: false,
};

function inputOf(spec: string): McKeyInput {
  const { key, shift, ctrl } = parseKeySpec(spec);
  return {
    ...base,
    key: shift && /^[a-z]$/u.test(key) ? key.toUpperCase() : key,
    shiftKey: shift,
    ctrlKey: ctrl,
  };
}

/** 打てるキーの全体（英字の大小とShift・CapsLock、数字、記号、名前付きのキー、Ctrl付き）。 */
function universe(): McKeyInput[] {
  const inputs: McKeyInput[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const letter of letters) {
    inputs.push({ ...base, key: letter });
    inputs.push({ ...base, key: letter.toUpperCase(), shiftKey: true });
    // CapsLockで大文字が届く（Shift無し）
    inputs.push({ ...base, key: letter.toUpperCase() });
  }
  const others = [
    ...'0123456789',
    ...'`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?',
    ' ',
    'Enter',
    'Escape',
    'Tab',
    'ArrowDown',
    'ArrowUp',
    'ArrowLeft',
    'ArrowRight',
    'Backspace',
    'Delete',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ];
  for (const key of others) {
    inputs.push({ ...base, key });
    inputs.push({ ...base, key, shiftKey: true });
    inputs.push({ ...base, key, ctrlKey: true });
  }
  return inputs;
}

describe('キーの表（KEY_BINDINGS）', () => {
  it('同じキー（Shift・Ctrlの有無まで同じ）を2つの操作に割り当てていない', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const binding of KEY_BINDINGS) {
      for (const raw of binding.keys) {
        const { key, shift, ctrl } = parseKeySpec(raw);
        const id = `${ctrl ? 'C-' : ''}${shift ? 'S-' : ''}${key}`;
        const other = seen.get(id);
        if (other !== undefined) {
          duplicates.push(`${id}: ${other} / ${binding.label}`);
        }
        seen.set(id, binding.label);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('表のキーはすべて、その行の操作に判定される', () => {
    for (const binding of KEY_BINDINGS) {
      for (const raw of binding.keys) {
        const resolved = resolveKey(inputOf(raw));
        expect(resolved?.binding, raw).toBe(binding);
      }
    }
  });

  it('表の外のキーは判定されない（判定されるキーは必ず表のどこかの行に書いてある）', () => {
    for (const input of universe()) {
      const resolved = resolveKey(input);
      if (resolved === undefined) {
        continue;
      }
      const pressed = /^[A-Za-z]$/u.test(input.key) ? input.key.toLowerCase() : input.key;
      const listed = resolved.binding.keys.some((raw) => parseKeySpec(raw).key === pressed);
      expect(listed, JSON.stringify(input)).toBe(true);
    }
  });
});

describe('ヘルプの一覧（KEY_HELP）と実際の割り当て', () => {
  it('判定されるキーはすべて、その操作の行がヘルプにある', () => {
    for (const input of universe()) {
      const resolved = resolveKey(input);
      if (resolved === undefined) {
        continue;
      }
      const display = bindingDisplay(resolved.binding);
      const row = KEY_HELP.find(([key]) => key === display);
      expect(row, JSON.stringify(input)).toBeDefined();
    }
  });

  it('ヘルプの行はすべて表の行から作られ、表に無い行は無い', () => {
    const expected = KEY_BINDINGS.flatMap((binding) => {
      const display = bindingDisplay(binding);
      const label = binding.scope === 'runs' ? `${binding.label}（Runs）` : binding.label;
      return binding.runsLabel === undefined
        ? [[display, label]]
        : [
            [display, label],
            [`${display}（Runs）`, binding.runsLabel],
          ];
    });
    expect(KEY_HELP).toEqual(expected);
  });

  it('ヘルプのキーの表記は、表の各キーを含む', () => {
    expect(KEY_HELP).toContainEqual(['j / ↓', '次の項目（repo一覧ではrepoを選ぶ）']);
    expect(KEY_HELP).toContainEqual(['Shift+D', 'セッションを削除（必ず確認）']);
    expect(KEY_HELP).toContainEqual(['Shift+F', 'runを終える（必ず確認）（Runs）']);
    expect(KEY_HELP).toContainEqual(['Tab / →', '右のペインへ移る（repo一覧 → 一覧 → 詳細）']);
    expect(KEY_HELP).toContainEqual(['Shift+Tab / ←', '左のペインへ移る']);
    expect(KEY_HELP).toContainEqual([':', 'コマンドパレット（操作を名前で選ぶ）']);
    expect(KEY_HELP).toContainEqual(['Ctrl+Enter', 'フォーム・ダイアログを送信する']);
  });
});

describe('mapKey（既存の割り当てを壊さない）', () => {
  it('Shift+Dは削除、小文字のdは拒否、CapsLockの大文字Dも拒否', () => {
    expect(mapKey({ ...base, key: 'D', shiftKey: true })).toEqual({
      kind: 'lifecycle',
      op: 'delete',
    });
    expect(mapKey({ ...base, key: 'd' })).toEqual({ kind: 'decline' });
    expect(mapKey({ ...base, key: 'D' })).toEqual({ kind: 'decline' });
  });

  it('Shift+Fはrunの終了、CapsLockの大文字Fは何もしない', () => {
    expect(mapKey({ ...base, key: 'F', shiftKey: true })).toEqual({
      kind: 'runOp',
      op: 'finish',
    });
    expect(mapKey({ ...base, key: 'F' })).toBeUndefined();
    expect(mapKey({ ...base, key: 'J', shiftKey: true })).toBeUndefined();
  });

  it('hは履歴のまま', () => {
    expect(mapKey({ ...base, key: 'h' })).toEqual({ kind: 'history' });
  });

  it('Tab / Shift+Tab / ← / →はペインの移動', () => {
    expect(mapKey({ ...base, key: 'Tab' })).toEqual({ kind: 'pane', delta: 1 });
    expect(mapKey({ ...base, key: 'Tab', shiftKey: true })).toEqual({ kind: 'pane', delta: -1 });
    expect(mapKey({ ...base, key: 'ArrowRight' })).toEqual({ kind: 'pane', delta: 1 });
    expect(mapKey({ ...base, key: 'ArrowLeft' })).toEqual({ kind: 'pane', delta: -1 });
    // 入力欄の中のTabは標準の移動に任せる
    expect(mapKey({ ...base, key: 'Tab', inEditable: true })).toBeUndefined();
    // 入力欄（フィルタ・ダイアログ）の中の← / →はカーソル移動に任せる
    expect(mapKey({ ...base, key: 'ArrowLeft', inEditable: true })).toBeUndefined();
    expect(mapKey({ ...base, key: 'ArrowRight', inEditable: true })).toBeUndefined();
  });

  it('記号はShiftの有無を問わない（配列でShiftの要否が違うため）', () => {
    expect(mapKey({ ...base, key: ':', shiftKey: true })).toEqual({ kind: 'palette' });
    expect(mapKey({ ...base, key: ':' })).toEqual({ kind: 'palette' });
    expect(mapKey({ ...base, key: '?', shiftKey: true })).toEqual({ kind: 'help' });
    expect(mapKey({ ...base, key: '+', shiftKey: true })).toEqual({ kind: 'parallel', delta: 1 });
    expect(mapKey({ ...base, key: '.' })).toEqual({ kind: 'accessKeys' });
  });

  it('Ctrl+Enter（macはCmd+Enter）は入力欄の中でも送信、Escは修飾キーを問わない', () => {
    expect(mapKey({ ...base, key: 'Enter', ctrlKey: true, inEditable: true })).toEqual({
      kind: 'submit',
    });
    expect(mapKey({ ...base, key: 'Enter', metaKey: true })).toEqual({ kind: 'submit' });
    expect(mapKey({ ...base, key: 'Enter', inEditable: true })).toBeUndefined();
    expect(mapKey({ ...base, key: 'Escape', altKey: true })).toEqual({ kind: 'escape' });
    expect(mapKey({ ...base, key: 'Escape', ctrlKey: true })).toEqual({ kind: 'escape' });
    expect(mapKey({ ...base, key: 'j', altKey: true })).toBeUndefined();
  });
});

describe('アクセスキー', () => {
  it('セッションのタブでは、全体のキーの英字を使わず、Runsタブだけのキーは使える', () => {
    const sessions = boundLetters('sessions');
    for (const letter of ['j', 'k', 'a', 'd', 'r', 'n', 'x', 'c', 'e', 'h', 't', 'i']) {
      expect(sessions.has(letter), letter).toBe(true);
    }
    for (const letter of ['o', 'p', 'z', 'u']) {
      expect(sessions.has(letter), letter).toBe(false);
      expect(boundLetters('runs').has(letter), letter).toBe(true);
    }
  });

  it('予約の英字を避けて順に振り、尽きたら振らない', () => {
    const reserved = boundLetters('sessions');
    const keys = assignAccessKeys(30, reserved);
    const given = keys.filter((k): k is string => k !== undefined);
    expect(given.length).toBe(26 - reserved.size);
    expect(new Set(given).size).toBe(given.length);
    for (const key of given) {
      expect(reserved.has(key), key).toBe(false);
    }
    expect(keys[0]).toBe('s');
    expect(keys[29]).toBeUndefined();
  });
});

describe('filterPalette', () => {
  const entry = (id: string, label: string, contextual: boolean, keyLabel?: string) =>
    ({ id, label, contextual, keyLabel, run: () => undefined }) satisfies McPaletteEntry;

  it('選んでいる項目に効く操作を上に出し、組の中は元の順を保つ', () => {
    const entries = [
      entry('1', '検索', false),
      entry('2', '承認', true),
      entry('3', 'タブ', false),
      entry('4', '拒否', true),
    ];
    expect(filterPalette(entries, '').map((e) => e.id)).toEqual(['2', '4', '1', '3']);
  });

  it('空白で区切った語をすべて名前かキーの表記に含むものだけ残す', () => {
    const entries = [
      entry('1', 'repoで絞り込む: app', false),
      entry('2', 'repoで絞り込む: other', false),
      entry('3', 'セッションを削除', true, 'Shift+D'),
    ];
    expect(filterPalette(entries, 'REPO app').map((e) => e.id)).toEqual(['1']);
    expect(filterPalette(entries, 'shift+d').map((e) => e.id)).toEqual(['3']);
  });
});
