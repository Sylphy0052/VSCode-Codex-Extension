import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import { buildHandoffSessionName, deriveHandoffBaseName } from '../../src/view/handoff';

const userMessage = (text: string): ChatItem =>
  ({ kind: 'userMessage', text }) as unknown as ChatItem;

const stateWith = (overrides: Partial<ChatState>): ChatState => ({
  ...initialChatState,
  ...overrides,
});

describe('buildHandoffSessionName（issue #1145、材料はissue #1255）', () => {
  it('印の無い引き継ぎ元には (続き2) を付ける', () => {
    expect(buildHandoffSessionName({ previousName: '前の名前' })).toBe('前の名前 (続き2)');
  });

  it('引き継ぎ元に印があれば本体を保ったまま世代を1つ進める', () => {
    expect(buildHandoffSessionName({ previousName: '前の名前 (続き2)' })).toBe('前の名前 (続き3)');
    expect(buildHandoffSessionName({ previousName: '前の名前 (続き9)' })).toBe('前の名前 (続き10)');
  });

  it('プロバイダの接頭辞は落とす', () => {
    expect(buildHandoffSessionName({ previousName: 'Codex: タスクA (続き2)' })).toBe(
      'タスクA (続き3)',
    );
  });

  it('引き継ぎ元の名前が無ければ印だけを返す', () => {
    expect(buildHandoffSessionName({})).toBe('(続き2)');
    expect(buildHandoffSessionName({ previousName: '   ' })).toBe('(続き2)');
    expect(buildHandoffSessionName({ previousName: '(続き3)' })).toBe('(続き4)');
  });

  it('長い名前は切り詰めない（issue #1255。表示の省略はVSCodeに任せる）', () => {
    expect(buildHandoffSessionName({ previousName: 'あ'.repeat(40) })).toBe(
      `${'あ'.repeat(40)} (続き2)`,
    );
  });

  it('改行や連続した空白を1つにまとめる', () => {
    expect(buildHandoffSessionName({ previousName: '設計を\n見直す' })).toBe(
      '設計を 見直す (続き2)',
    );
  });
});

describe('buildHandoffSessionName: 名前の無い引き継ぎ元の本体を補う（issue #1407）', () => {
  const handoffPrompt = [
    '# 継続 2026-09-23 fix/1407/handoff-tab-name',
    '',
    '前提: cwd=/repo',
    '作業: 引き継ぎ先のタブ名を補う',
    '',
    '次:',
    '1. テストを書く',
  ].join('\n');

  it('引き継ぎ元に名前があれば作業行やブランチより優先する', () => {
    expect(
      buildHandoffSessionName({
        previousName: '前の名前 (続き2)',
        handoffPrompt,
        gitBranch: 'fix/1407/handoff-tab-name',
      }),
    ).toBe('前の名前 (続き3)');
  });

  it('名前が無ければhandoffプロンプトの作業行を本体にする', () => {
    expect(
      buildHandoffSessionName({ handoffPrompt, gitBranch: 'fix/1407/handoff-tab-name' }),
    ).toBe('引き継ぎ先のタブ名を補う (続き2)');
  });

  it('印だけの名前から引き継ぐときも本体を補い、世代は進める', () => {
    expect(buildHandoffSessionName({ previousName: '(続き4)', handoffPrompt })).toBe(
      '引き継ぎ先のタブ名を補う (続き5)',
    );
  });

  it('長い作業行は切り詰める', () => {
    const long = `作業: ${'あ'.repeat(50)}`;
    expect(buildHandoffSessionName({ handoffPrompt: long })).toBe(
      `${'あ'.repeat(40)}… (続き2)`,
    );
  });

  it('作業行が無ければブランチ名を本体にする', () => {
    expect(
      buildHandoffSessionName({ handoffPrompt: '# 継続 2026-09-23', gitBranch: 'feat/12/x' }),
    ).toBe('feat/12/x (続き2)');
    expect(buildHandoffSessionName({ previousName: '(続き3)', gitBranch: 'feat/12/x' })).toBe(
      'feat/12/x (続き4)',
    );
  });

  it('main・master・HEADは手掛かりにならないので使わない', () => {
    for (const gitBranch of ['main', 'master', 'HEAD']) {
      expect(buildHandoffSessionName({ gitBranch })).toBe('(続き2)');
    }
  });
});

describe('deriveHandoffBaseName（issue #1145）', () => {
  it('オーケストレータが指定した名前を最優先にし、接頭辞は落とす', () => {
    const state = stateWith({ name: 'CLI由来の名前' });
    expect(deriveHandoffBaseName(state, 'Codex: タスクA')).toBe('タスクA');
    expect(deriveHandoffBaseName(state, 'Claude Code: タスクB')).toBe('タスクB');
  });

  it('指定が無ければCLIや人が付けた名前を使う', () => {
    const state = stateWith({ name: 'CLI由来の名前', items: [userMessage('最初の発言')] });
    expect(deriveHandoffBaseName(state)).toBe('CLI由来の名前');
  });

  it('名前が無ければundefinedを返す（最初のユーザー発言へは落ちない。issue #1228）', () => {
    const state = stateWith({ items: [userMessage('最初の発言')] });
    expect(deriveHandoffBaseName(state)).toBeUndefined();
  });

  it('材料が何も無ければundefinedを返す', () => {
    expect(deriveHandoffBaseName(stateWith({}))).toBeUndefined();
  });
});
