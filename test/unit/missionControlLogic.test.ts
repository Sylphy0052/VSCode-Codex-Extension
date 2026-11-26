import { describe, expect, it } from 'vitest';
import {
  buildPromptValues,
  buildQuestionAnswers,
  chooseOption,
  countByActivity,
  countSessionsInRepo,
  EMPTY_DRAFT,
  EMPTY_FILTER,
  filterPending,
  filterResumable,
  filterSessions,
  formatElapsed,
  formatSkillTime,
  isAnswerableInInbox,
  isStalled,
  type McFilter,
  stalledSince,
  mapKey,
  moveSelection,
  purposeLabels,
  recentSkillNames,
  reconcileSelection,
  setOther,
} from '../../src/webview/missionControl/logic';
import type {
  McPendingItem,
  McRepo,
  McResumeItem,
  McSession,
} from '../../src/webview/missionControl/protocol';
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

describe('状態の絞り込みと再開待ち（Issue #2138）', () => {
  function session(overrides: Partial<McSession>): McSession {
    return {
      key: 's',
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
      ...overrides,
    };
  }
  const sessions = [
    session({ key: 'a', activity: 'running' }),
    session({ key: 'b', activity: 'idle' }),
    session({ key: 'c', activity: 'idle', repoKey: '/w/other' }),
    session({ key: 'd', activity: 'handoffPending' }),
  ];

  it('選んだ状態のセッションだけを出す', () => {
    expect(
      filterSessions(sessions, repos, { ...EMPTY_FILTER, activity: 'idle' }).map((s) => s.key),
    ).toEqual(['b', 'c']);
    expect(filterSessions(sessions, repos, EMPTY_FILTER)).toHaveLength(4);
  });

  it('状態ごとの数は、状態以外の絞り込みだけを掛けて数える', () => {
    const counts = countByActivity(sessions, repos, {
      ...EMPTY_FILTER,
      repoKey: '/w/app',
      activity: 'running',
    });
    expect(counts).toEqual({
      approvalPending: 0,
      handoffPending: 1,
      running: 1,
      backgroundRunning: 0,
      idle: 1,
    });
  });

  it('再開待ちにはrepo・provider・検索の絞り込みが効き、状態の絞り込みは効かない', () => {
    const resume: McResumeItem[] = [
      {
        id: 'resume:codex:t1',
        windowId: 'w1',
        provider: 'codex',
        threadId: 't1',
        title: '移行作業',
        repoKey: '/w/app',
        cwdLabel: 'app',
        since: 0,
      },
      {
        id: 'resume:claude:t2',
        windowId: 'w1',
        provider: 'claude',
        threadId: 't2',
        title: '調査',
        repoKey: '/w/other',
        cwdLabel: 'other',
        since: 0,
      },
    ];
    const ids = (filter: McFilter): string[] =>
      filterResumable(resume, repos, filter).map((r) => r.id);
    expect(ids({ ...EMPTY_FILTER, activity: 'idle', currentWindowOnly: true })).toHaveLength(2);
    expect(ids({ ...EMPTY_FILTER, repoKey: '/w/other' })).toEqual(['resume:claude:t2']);
    expect(ids({ ...EMPTY_FILTER, provider: 'codex' })).toEqual(['resume:codex:t1']);
    expect(ids({ ...EMPTY_FILTER, query: '移行' })).toEqual(['resume:codex:t1']);
  });

  it('引き継ぎ確認はInboxで答えられる', () => {
    expect(isAnswerableInInbox('handoff')).toBe(true);
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

describe('セッションの目的の1文要約（Issue #2172）', () => {
  it('要約のあるセッションだけ載せ、似た要約が並ぶときはブランチ名を添える', () => {
    const labels = purposeLabels([
      { key: 'a', purpose: 'ログイン画面を直す', branch: 'fix/1/login' },
      { key: 'b', purpose: 'ログイン画面を直す。', branch: 'fix/2/login' },
      { key: 'c', purpose: 'ログイン画面を直す' },
      { key: 'd', purpose: 'READMEを書く', branch: 'docs/3/readme' },
      { key: 'e' },
    ]);
    expect(labels.get('a')).toBe('ログイン画面を直す（fix/1/login）');
    expect(labels.get('b')).toBe('ログイン画面を直す。（fix/2/login）');
    // ブランチ名が分からなければ要約だけ出す
    expect(labels.get('c')).toBe('ログイン画面を直す');
    expect(labels.get('d')).toBe('READMEを書く');
    expect(labels.has('e')).toBe(false);
  });

  it('要約の語でもセッションを絞り込める', () => {
    const base: McSession = {
      key: 's',
      windowId: 'w1',
      threadId: 't',
      provider: 'codex',
      isCurrentWindow: true,
      repoKey: '/w/app',
      title: 'タイトル',
      activity: 'idle',
      activitySince: 0,
      cwdLabel: 'app',
      cwdFull: '/w/app',
      pendingCount: 0,
    };
    const result = filterSessions(
      [
        { ...base, key: 'a', purpose: '決済の不具合を調べる' },
        { ...base, key: 'b' },
      ],
      repos,
      { ...EMPTY_FILTER, query: '決済' },
    );
    expect(result.map((s) => s.key)).toEqual(['a']);
  });
});

describe('セッションで使ったskill（Issue #2173）', () => {
  it('カードには直近2件を新しい順に出す', () => {
    const skills = [
      { name: 'a', at: 1 },
      { name: 'b', at: 2 },
      { name: 'c', at: 3 },
    ];
    expect(recentSkillNames(skills)).toEqual(['c', 'b']);
    expect(recentSkillNames([{ name: 'a', at: 1 }])).toEqual(['a']);
    expect(recentSkillNames(undefined)).toEqual([]);
  });

  it('時刻は同じ日ならHH:MM、違う日ならM/D HH:MMで出す', () => {
    const now = new Date(2026, 10, 26, 15, 0).getTime();
    expect(formatSkillTime(new Date(2026, 10, 26, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatSkillTime(new Date(2026, 10, 25, 23, 59).getTime(), now)).toBe('11/25 23:59');
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
    expect(mapKey({ ...base, key: 'n' })).toEqual({ kind: 'newSession' });
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

describe('選択の扱い（段階2のレビュー）', () => {
  it('選択中の項目が消えたら、同じ位置の別の項目へ移さずに外す', () => {
    expect(reconcileSelection(['p:a', 'p:b'], 'p:a', false)).toBe('p:a');
    expect(reconcileSelection(['p:b', 'p:c'], 'p:a', false)).toBeUndefined();
    expect(reconcileSelection(['p:b'], undefined, false)).toBeUndefined();
  });

  it('最初の表示の間だけ先頭を選ぶ（Reload前の選択が消えていても）', () => {
    expect(reconcileSelection(['p:b', 'p:c'], undefined, true)).toBe('p:b');
    expect(reconcileSelection(['p:b', 'p:c'], 'p:gone', true)).toBe('p:b');
    expect(reconcileSelection([], undefined, true)).toBeUndefined();
  });
});

describe('停滞とworktreeの既定（Issue #2137）', () => {
  it('実行中で出力が閾値以上動いていなければ停滞', () => {
    expect(
      isStalled({ activity: 'running', lastOutputAt: 0, activitySince: 0 }, 300_000, 300_000),
    ).toBe(true);
    expect(
      isStalled({ activity: 'running', lastOutputAt: 1, activitySince: 0 }, 300_000, 300_000),
    ).toBe(false);
    expect(
      isStalled({ activity: 'idle', lastOutputAt: 0, activitySince: 0 }, 900_000, 300_000),
    ).toBe(false);
    expect(
      isStalled(
        { activity: 'approvalPending', lastOutputAt: 0, activitySince: 0 },
        900_000,
        300_000,
      ),
    ).toBe(false);
    expect(
      isStalled(
        { activity: 'running', lastOutputAt: undefined, activitySince: 0 },
        900_000,
        300_000,
      ),
    ).toBe(false);
  });

  it('実行を始めた直後は、前の出力から時間が経っていても停滞としない（Issue #2138）', () => {
    // 出力は10分前だが、実行中になったのは1秒前
    const session = { activity: 'running', lastOutputAt: 0, activitySince: 599_000 } as const;
    expect(isStalled(session, 600_000, 300_000)).toBe(false);
    expect(stalledSince(session)).toBe(599_000);
    expect(isStalled(session, 899_000, 300_000)).toBe(true);
  });

  it('同じrepoで開いているセッションを数える', () => {
    const base = {
      windowId: 'w1',
      threadId: 't',
      provider: 'codex' as const,
      isCurrentWindow: true,
    };
    const row = (key: string, repoKey: string): McSession => ({
      ...base,
      key,
      repoKey,
      title: key,
      activity: 'idle',
      activitySince: 0,
      cwdLabel: '',
      cwdFull: '',
      pendingCount: 0,
    });
    const list = [row('a', '/w/app'), row('b', '/w/app'), row('c', '/w/other')];
    expect(countSessionsInRepo(list, '/w/app')).toBe(2);
    expect(countSessionsInRepo(list, '/w/none')).toBe(0);
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
