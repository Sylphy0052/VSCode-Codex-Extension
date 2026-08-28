import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import {
  appendEvidence,
  buildWorkerReportEvidence,
  collectCommandEvidence,
  collectRecentTurns,
  MAX_EVIDENCE_ITEMS,
  MAX_RECENT_TURNS,
  normalizeGoalDefinition,
  type GoalEvidence,
} from '../../src/loop/goalLoop';

const item = (overrides: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem => ({
  text: '',
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
  ...overrides,
});

const command = (id: string, detail: string, status: string | undefined, text = ''): ChatItem =>
  item({ id, kind: 'commandExecution', detail, status, text });

const evidence = (overrides: Partial<GoalEvidence> = {}): GoalEvidence => ({
  kind: 'test',
  source: 'npm test',
  status: 'pass',
  detail: 'exit 0',
  iteration: 1,
  ...overrides,
});

const state = (items: ChatItem[]): ChatState => ({ ...initialChatState, items });

describe('normalizeGoalDefinition', () => {
  it('目的と受入基準が揃っているときだけゴールとして受け付ける', () => {
    expect(
      normalizeGoalDefinition({ purpose: ' 認証を直す ', acceptanceCriteria: ' 全テストが通る ' }),
    ).toEqual({ purpose: '認証を直す', acceptanceCriteria: '全テストが通る' });
  });

  it('片方だけでは受け付けない', () => {
    expect(normalizeGoalDefinition({ purpose: '認証を直す' })).toBeUndefined();
    expect(normalizeGoalDefinition({ acceptanceCriteria: '全テストが通る' })).toBeUndefined();
    expect(normalizeGoalDefinition({ purpose: '  ', acceptanceCriteria: 'x' })).toBeUndefined();
  });

  it('オブジェクトでない入力を受け付けない', () => {
    expect(normalizeGoalDefinition(undefined)).toBeUndefined();
    expect(normalizeGoalDefinition('目的')).toBeUndefined();
    expect(normalizeGoalDefinition(null)).toBeUndefined();
  });

  it('制約は空ならキーごと持たない', () => {
    const withoutConstraints = normalizeGoalDefinition({
      purpose: 'a',
      acceptanceCriteria: 'b',
      constraints: '   ',
    });
    expect(withoutConstraints).toBeDefined();
    expect(Object.hasOwn(withoutConstraints as object, 'constraints')).toBe(false);
    expect(
      normalizeGoalDefinition({
        purpose: 'a',
        acceptanceCriteria: 'b',
        constraints: 'テストを弱めない',
      }),
    ).toMatchObject({ constraints: 'テストを弱めない' });
  });
});

describe('collectCommandEvidence', () => {
  it('終了コード0を pass、0以外を fail として拾う', () => {
    const collected = collectCommandEvidence(
      [command('c1', 'npm test', 'exit 0'), command('c2', 'npm run build', 'exit 2')],
      new Set(),
      3,
    );
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ kind: 'test', status: 'pass', iteration: 3 });
    expect(collected[1]).toMatchObject({ status: 'fail' });
  });

  it('まだ終了していないコマンドは証拠にしない', () => {
    expect(collectCommandEvidence([command('c1', 'npm test', 'inProgress')], new Set(), 1)).toEqual(
      [],
    );
    expect(collectCommandEvidence([command('c1', 'npm test', undefined)], new Set(), 1)).toEqual(
      [],
    );
  });

  it('既に拾ったidは積み直さない', () => {
    const items = [command('c1', 'npm test', 'exit 0')];
    expect(collectCommandEvidence(items, new Set(['c1']), 2)).toEqual([]);
  });

  it('コマンド以外の項目は無視する', () => {
    expect(
      collectCommandEvidence(
        [item({ id: 'a1', kind: 'agentMessage', text: '終わりました' })],
        new Set(),
        1,
      ),
    ).toEqual([]);
  });

  it('コマンド行から証拠の種別を当てる', () => {
    const kinds = collectCommandEvidence(
      [
        command('c1', 'npx vitest run', 'exit 0'),
        command('c2', 'npx eslint src', 'exit 0'),
        command('c3', 'git status', 'exit 0'),
        command('c4', 'make', 'exit 0'),
      ],
      new Set(),
      1,
    ).map((e) => e.kind);
    expect(kinds).toEqual(['test', 'lint', 'git', 'build']);
  });

  it('出力は末尾を残して切り詰める（失敗理由は末尾に出るため）', () => {
    const [collected] = collectCommandEvidence(
      [command('c1', 'npm test', 'exit 1', `${'x'.repeat(5_000)}FAILED`)],
      new Set(),
      1,
    );
    expect(collected?.detail.startsWith('exit 1\n')).toBe(true);
    expect(collected?.detail.endsWith('FAILED')).toBe(true);
    expect(collected?.detail.length).toBeLessThan(1_000);
  });
});

describe('buildWorkerReportEvidence', () => {
  it('そのターンの応答を status unknown の申告として1件にする', () => {
    const report = buildWorkerReportEvidence(
      {
        ...state([item({ id: 'a1', kind: 'agentMessage', text: '直しました' })]),
        turnResultText: '直しました',
      },
      2,
    );
    expect(report).toMatchObject({ kind: 'worker-report', status: 'unknown', iteration: 2 });
    expect(report?.detail).toBe('直しました');
  });

  it('応答が無ければ証拠を作らない', () => {
    expect(buildWorkerReportEvidence(state([]), 1)).toBeUndefined();
  });

  it('そのターンが何も言わなければ、会話に残る過去の発言は拾わない（issue #933）', () => {
    // コマンド実行だけで本文を返さなかったターン。`items`には前のターンの発言が残る
    const report = buildWorkerReportEvidence(
      {
        ...state([item({ id: 'a1', kind: 'agentMessage', text: '前のターンで直しました' })]),
        turnResultText: '',
      },
      2,
    );
    expect(report).toBeUndefined();
  });
});

describe('appendEvidence', () => {
  it('元の配列を変更せず、新しい配列を返す', () => {
    const ledger = [evidence()];
    const merged = appendEvidence(ledger, [evidence({ source: 'npm run build' })]);
    expect(ledger).toHaveLength(1);
    expect(merged).toHaveLength(2);
  });

  it('上限を超えたら古いものから落とす', () => {
    const many = Array.from({ length: MAX_EVIDENCE_ITEMS + 5 }, (_unused, i) =>
      evidence({ source: `cmd-${i}` }),
    );
    const merged = appendEvidence([], many);
    expect(merged).toHaveLength(MAX_EVIDENCE_ITEMS);
    expect(merged[merged.length - 1]?.source).toBe(`cmd-${MAX_EVIDENCE_ITEMS + 4}`);
  });
});

describe('collectRecentTurns', () => {
  it('直近の応答を古い順に返す', () => {
    const turns = collectRecentTurns([
      item({ id: 'a1', kind: 'agentMessage', text: '1回目' }),
      item({ id: 'a2', kind: 'agentMessage', text: '2回目' }),
      item({ id: 'a3', kind: 'agentMessage', text: '3回目' }),
    ]);
    expect(turns).toEqual(['1回目', '2回目', '3回目']);
  });

  it('件数の上限を超えたら新しい方を残す', () => {
    const items = Array.from({ length: MAX_RECENT_TURNS + 2 }, (_unused, i) =>
      item({ id: `a${i}`, kind: 'agentMessage', text: `turn-${i}` }),
    );
    const turns = collectRecentTurns(items);
    expect(turns).toHaveLength(MAX_RECENT_TURNS);
    expect(turns[turns.length - 1]).toBe(`turn-${MAX_RECENT_TURNS + 1}`);
  });

  it('空の応答とコマンドは数えない', () => {
    expect(
      collectRecentTurns([
        item({ id: 'a1', kind: 'agentMessage', text: '   ' }),
        command('c1', 'npm test', 'exit 0'),
      ]),
    ).toEqual([]);
  });
});
