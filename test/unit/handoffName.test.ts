import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import { buildHandoffSessionName, deriveHandoffBaseName } from '../../src/view/handoff';

const userMessage = (text: string): ChatItem =>
  ({ kind: 'userMessage', text }) as unknown as ChatItem;

const stateWith = (overrides: Partial<ChatState>): ChatState => ({
  ...initialChatState,
  ...overrides,
});

describe('buildHandoffSessionName（issue #1145、材料はissue #1228）', () => {
  it('印の無い引き継ぎ元からは (続き2) を付ける', () => {
    expect(buildHandoffSessionName({ previousName: '前の名前', topic: '分類器の見立て' })).toBe(
      '分類器の見立て (続き2)',
    );
  });

  it('引き継ぎ元に印があれば世代を1つ進める', () => {
    expect(buildHandoffSessionName({ previousName: '前の名前 (続き2)', topic: '見立て' })).toBe(
      '見立て (続き3)',
    );
    expect(buildHandoffSessionName({ previousName: '前の名前 (続き9)', topic: '見立て' })).toBe(
      '見立て (続き10)',
    );
  });

  it('本体は前世代から継がず、その時点の作業から作り直す（issue #1228）', () => {
    const name = buildHandoffSessionName({
      previousName: '作業の続き。前PCでやっていた作業の指示書があるはず (続き3)',
      topic: 'タブ名の改修',
    });
    expect(name).toBe('タブ名の改修 (続き4)');
  });

  it('明示的に付けられた名前を最優先にし、接頭辞と印は落とす', () => {
    expect(
      buildHandoffSessionName({
        previousName: '前の名前 (続き2)',
        pinnedName: 'Codex: タスクA (続き2)',
        topic: '見立て',
      }),
    ).toBe('タスクA (続き3)');
  });

  it('見立てが無ければ編集したファイル名を使う', () => {
    expect(
      buildHandoffSessionName({
        editedFiles: ['src/view/handoff.ts'],
        recentUserMessages: ['直近の指示'],
      }),
    ).toBe('handoff.ts (続き2)');
  });

  it('編集したファイルが複数あれば件数を添える', () => {
    expect(
      buildHandoffSessionName({
        editedFiles: ['src/view/handoff.ts', 'src/view/chatView.ts', 'test/unit/a.test.ts'],
      }),
    ).toBe('handoff.ts ほか2件 (続き2)');
  });

  it('見立ても編集ファイルも無ければ直近のユーザー発言を使う', () => {
    expect(buildHandoffSessionName({ recentUserMessages: ['最初の指示', '直近の指示'] })).toBe(
      '直近の指示 (続き2)',
    );
  });

  it('引き継ぎの初回プロンプトは材料にしない（issue #1228）', () => {
    expect(
      buildHandoffSessionName({
        recentUserMessages: [
          '前セッションの続き。/tmp/handoff/x.md を読んで、そこに書かれた手順で状況を把握してから作業を続けて。',
        ],
      }),
    ).toBe('(続き2)');
  });

  it('材料が何も無ければ印だけを返す', () => {
    expect(buildHandoffSessionName({})).toBe('(続き2)');
    expect(buildHandoffSessionName({ previousName: '   ', topic: '  ' })).toBe('(続き2)');
  });

  it('長い名前は切り詰める', () => {
    expect(buildHandoffSessionName({ topic: 'あ'.repeat(40) })).toBe(`${'あ'.repeat(16)}… (続き2)`);
  });

  it('改行や連続した空白を1つにまとめる', () => {
    expect(buildHandoffSessionName({ topic: '設計を\n見直す' })).toBe('設計を 見直す (続き2)');
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
