import { describe, expect, it } from 'vitest';
import {
  buildPromptValues,
  buildQuestionAnswers,
  chooseOption,
  EMPTY_DRAFT,
  EMPTY_FILTER,
  filterPending,
  filterSessions,
  formatElapsed,
  mapKey,
  moveSelection,
  setOther,
} from '../../src/webview/missionControl/logic';
import type { McPendingItem, McRepo, McSession } from '../../src/webview/missionControl/protocol';
import { MISSION_CONTROL_STYLES } from '../../src/webview/missionControl/styles';

const repos: McRepo[] = [
  { key: '/w/app', label: 'app', full: '/w/app', sessionCount: 1, pendingCount: 1 },
  { key: '/w/other', label: 'other', full: '/w/other', sessionCount: 1, pendingCount: 1 },
];

function item(overrides: Partial<McPendingItem>): McPendingItem {
  return {
    id: 'p',
    kind: 'toolApproval',
    windowId: 'w1',
    threadId: 't',
    provider: 'codex',
    isCurrentWindow: true,
    repoKey: '/w/app',
    title: 'npm test',
    summary: '',
    createdAt: 0,
    answer: 'decision',
    ...overrides,
  };
}

describe('Inboxの絞り込み（Issue #2136）', () => {
  const items = [
    item({ id: 'a' }),
    item({
      id: 'run',
      kind: 'taskRunQuestion',
      repoKey: '/w/other',
      provider: 'claude',
      isCurrentWindow: false,
      title: 'T1 設計',
      summary: 'どちらの案？',
    }),
  ];

  it('task runの質問にもrepo・provider・ウィンドウ・検索の絞り込みが効く', () => {
    expect(
      filterPending(items, repos, { ...EMPTY_FILTER, repoKey: '/w/app' }).map((i) => i.id),
    ).toEqual(['a']);
    expect(
      filterPending(items, repos, { ...EMPTY_FILTER, provider: 'codex' }).map((i) => i.id),
    ).toEqual(['a']);
    expect(
      filterPending(items, repos, { ...EMPTY_FILTER, currentWindowOnly: true }).map((i) => i.id),
    ).toEqual(['a']);
    expect(
      filterPending(items, repos, { ...EMPTY_FILTER, query: 'どちら' }).map((i) => i.id),
    ).toEqual(['run']);
    expect(
      filterPending(items, repos, { ...EMPTY_FILTER, query: 'OTHER' }).map((i) => i.id),
    ).toEqual(['run']);
  });

  it('セッションも同じ条件で絞る', () => {
    const sessions: McSession[] = [
      {
        key: 's1',
        windowId: 'w1',
        threadId: 't',
        provider: 'codex',
        isCurrentWindow: true,
        repoKey: '/w/app',
        title: 'リファクタ',
        activity: 'running',
        activitySince: 0,
        cwdLabel: 'app',
        cwdFull: '/w/app',
        pendingCount: 0,
      },
    ];
    expect(filterSessions(sessions, repos, { ...EMPTY_FILTER, query: 'リファ' })).toHaveLength(1);
    expect(filterSessions(sessions, repos, { ...EMPTY_FILTER, provider: 'claude' })).toHaveLength(
      0,
    );
  });
});

describe('選択肢と「その他」の下書き', () => {
  it('単一選択では選択肢と「その他」が互いを消す（段階1のlowを繰り返さない）', () => {
    const chosen = chooseOption(EMPTY_DRAFT, 'A', false);
    const typed = setOther(chosen, '自由入力', false);
    expect(typed).toEqual({ selected: [], other: '自由入力' });
    expect(chooseOption(typed, 'B', false)).toEqual({ selected: ['B'], other: '' });
  });

  it('複数選択では両方を持てる', () => {
    const draft = setOther(
      chooseOption(chooseOption(EMPTY_DRAFT, 'A', true), 'B', true),
      'X',
      true,
    );
    expect(draft).toEqual({ selected: ['A', 'B'], other: 'X' });
    expect(chooseOption(draft, 'A', true).selected).toEqual(['B']);
  });

  it('AskUserQuestionの回答を質問文をキーにして組み立てる', () => {
    const questions = [
      {
        question: 'Q1?',
        header: 'H1',
        options: [{ label: 'A', description: '' }],
        multiSelect: false,
      },
      { question: 'Q2?', header: 'H2', options: [], multiSelect: true },
    ];
    expect(
      buildQuestionAnswers(questions, new Map([[0, chooseOption(EMPTY_DRAFT, 'A', false)]])),
    ).toBe('未回答の質問があります: H2');
    expect(
      buildQuestionAnswers(
        questions,
        new Map([
          [0, setOther(chooseOption(EMPTY_DRAFT, 'A', false), '別案', false)],
          [1, setOther(EMPTY_DRAFT, '  自由  ', true)],
        ]),
      ),
    ).toEqual({ 'Q1?': ['別案'], 'Q2?': ['自由'] });
  });

  it('Codexの問い合わせは必須の欄だけ空を断る', () => {
    const fields = [
      {
        id: 'f1',
        label: 'F1',
        description: '',
        options: [],
        multiple: false,
        allowOther: true,
        required: true,
      },
      {
        id: 'f2',
        label: 'F2',
        description: '',
        options: [],
        multiple: false,
        allowOther: true,
        required: false,
      },
    ];
    expect(buildPromptValues(fields, new Map())).toBe('必須の欄が空です: F1');
    expect(buildPromptValues(fields, new Map([[0, setOther(EMPTY_DRAFT, 'x', false)]]))).toEqual({
      f1: ['x'],
      f2: [],
    });
  });
});

describe('キー操作', () => {
  const base = { ctrlKey: false, metaKey: false, altKey: false, inEditable: false };

  it('j/k・Enter・1〜9・a/d/r・/・?を対応付ける', () => {
    expect(mapKey({ ...base, key: 'j' })).toEqual({ kind: 'next' });
    expect(mapKey({ ...base, key: 'k' })).toEqual({ kind: 'prev' });
    expect(mapKey({ ...base, key: 'Enter' })).toEqual({ kind: 'detail' });
    expect(mapKey({ ...base, key: '3' })).toEqual({ kind: 'choose', index: 2 });
    expect(mapKey({ ...base, key: '0' })).toBeUndefined();
    expect(mapKey({ ...base, key: 'a' })).toEqual({ kind: 'approve' });
    expect(mapKey({ ...base, key: 'd' })).toEqual({ kind: 'decline' });
    expect(mapKey({ ...base, key: 'r' })).toEqual({ kind: 'reply' });
    expect(mapKey({ ...base, key: '/' })).toEqual({ kind: 'search' });
    expect(mapKey({ ...base, key: '?' })).toEqual({ kind: 'help' });
  });

  it('入力欄の中と修飾キー付きは文字入力として通し、Escapeだけ拾う', () => {
    expect(mapKey({ ...base, key: 'a', inEditable: true })).toBeUndefined();
    expect(mapKey({ ...base, key: 'a', ctrlKey: true })).toBeUndefined();
    expect(mapKey({ ...base, key: 'Escape', inEditable: true })).toEqual({ kind: 'escape' });
  });

  it('選択を端で止め、未選択からは先頭（逆向きは末尾）へ', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveSelection(ids, undefined, 1)).toBe('a');
    expect(moveSelection(ids, undefined, -1)).toBe('c');
    expect(moveSelection(ids, 'c', 1)).toBe('c');
    expect(moveSelection(ids, 'a', -1)).toBe('a');
    expect(moveSelection(ids, 'gone', 1)).toBe('a');
    expect(moveSelection([], 'a', 1)).toBeUndefined();
  });
});

describe('formatElapsed', () => {
  it('秒・分・時間・日で短く出す', () => {
    expect(formatElapsed(-5)).toBe('0秒');
    expect(formatElapsed(59_000)).toBe('59秒');
    expect(formatElapsed(3 * 60_000)).toBe('3分');
    expect(formatElapsed(2 * 3_600_000)).toBe('2時間');
    expect(formatElapsed(26 * 3_600_000)).toBe('1日');
  });
});

describe('テーマ（Issue #2136の7）', () => {
  it('色はテーマ変数だけで決め、固定の色を書かない', () => {
    expect(MISSION_CONTROL_STYLES).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(MISSION_CONTROL_STYLES).not.toMatch(/\brgba?\(/u);
    // ピルの文字は前景色、ハイコントラストでは枠で区切る
    expect(MISSION_CONTROL_STYLES).toMatch(/\.pill \{[^}]*color: var\(--vscode-foreground\)/u);
    expect(MISSION_CONTROL_STYLES).toMatch(/vscode-high-contrast .pill[^{]*\{[^}]*contrastBorder/u);
  });
});
