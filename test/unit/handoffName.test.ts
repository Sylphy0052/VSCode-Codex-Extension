import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import { deriveHandoffBaseName, nextHandoffName } from '../../src/view/handoff';

const userMessage = (text: string): ChatItem =>
  ({ kind: 'userMessage', text }) as unknown as ChatItem;

const stateWith = (overrides: Partial<ChatState>): ChatState => ({
  ...initialChatState,
  ...overrides,
});

describe('nextHandoffName（issue #1145）', () => {
  it('印の無い名前には (続き2) を付ける', () => {
    expect(nextHandoffName('セッション名の改修')).toBe('セッション名の改修 (続き2)');
  });

  it('既に印がある名前は世代を1つ進める', () => {
    expect(nextHandoffName('セッション名の改修 (続き2)')).toBe('セッション名の改修 (続き3)');
    expect(nextHandoffName('セッション名の改修 (続き9)')).toBe('セッション名の改修 (続き10)');
  });

  it('元の名前が無ければ印だけを返す', () => {
    expect(nextHandoffName(undefined)).toBe('(続き2)');
    expect(nextHandoffName('   ')).toBe('(続き2)');
  });

  it('長い名前は切り詰める', () => {
    const name = nextHandoffName('あ'.repeat(40));
    expect(name).toBe(`${'あ'.repeat(32)}… (続き2)`);
  });

  it('改行や連続した空白を1つにまとめる', () => {
    expect(nextHandoffName('設計を\n見直す')).toBe('設計を 見直す (続き2)');
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

  it('名前が無ければ最初のユーザー発言を使う', () => {
    const state = stateWith({ items: [userMessage('最初の発言')] });
    expect(deriveHandoffBaseName(state)).toBe('最初の発言');
  });

  it('材料が何も無ければundefinedを返す', () => {
    expect(deriveHandoffBaseName(stateWith({}))).toBeUndefined();
  });
});
