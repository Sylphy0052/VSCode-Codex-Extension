import { describe, expect, it } from 'vitest';
import {
  initialChatState,
  type ChatItem,
  type ChatState,
  type TodoItem,
  type TodoSnapshot,
} from '../../src/appserver/chatState';
import { buildProgress, diffTodos } from '../../src/view/progressModel';

/**
 * 進捗画面の表示モデル（issue #721）。ターンの区切り・集計・TODOの差分を固定する。
 */

const item = (kind: string, over: Partial<ChatItem> = {}): ChatItem => ({
  id: over.id ?? `${kind}-${Math.random()}`,
  kind,
  text: '',
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
  ...over,
});

const todo = (content: string, status: string): TodoItem => ({
  content,
  status,
  activeForm: `${content}中`,
});

const stateWith = (items: ChatItem[], over: Partial<ChatState> = {}): ChatState => ({
  ...initialChatState,
  items,
  ...over,
});

const fileChange = (path: string): ChatItem =>
  item('fileChange', {
    diffs: [{ path, kind: 'update', movePath: undefined, diff: '', editReplace: undefined }],
  });

describe('buildProgress', () => {
  it('ユーザーの発言でターンを区切る', () => {
    const view = buildProgress(
      stateWith([
        item('userMessage', { text: '最初の指示' }),
        item('agentMessage', { text: '応答1' }),
        item('userMessage', { text: '次の指示' }),
        item('agentMessage', { text: '応答2' }),
      ]),
    );

    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]?.instruction).toBe('最初の指示');
    expect(view.turns[0]?.response).toBe('応答1');
    expect(view.turns[1]?.index).toBe(1);
    expect(view.summary.turnCount).toBe(2);
  });

  it('ターンの応答は最後のものを出す', () => {
    const view = buildProgress(
      stateWith([
        item('userMessage', { text: '指示' }),
        item('agentMessage', { text: '途中' }),
        item('agentMessage', { text: '最後' }),
      ]),
    );

    expect(view.turns[0]?.response).toBe('最後');
  });

  it('ユーザーの発言より前の項目も捨てずに最初のターンへ入れる', () => {
    const view = buildProgress(stateWith([item('commandExecution', { detail: 'ls' })]));

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.instruction).toBe('');
    expect(view.turns[0]?.commands).toEqual(['ls']);
  });

  it('ファイルとコマンドを集計する（ファイルは重複を除く）', () => {
    const view = buildProgress(
      stateWith([
        item('userMessage', { text: '指示' }),
        fileChange('a.ts'),
        fileChange('a.ts'),
        item('commandExecution', { detail: 'npm test' }),
        item('userMessage', { text: '続き' }),
        fileChange('b.ts'),
        item('commandExecution', { detail: 'npm test' }),
      ]),
    );

    expect(view.turns[0]?.editedFiles).toEqual(['a.ts']);
    expect(view.summary.editedFiles).toEqual(['a.ts', 'b.ts']);
    // 同じコマンドの繰り返しは別々に数える（何回走らせたかが進捗の材料になる）
    expect(view.summary.commandCount).toBe(2);
  });

  it('TODOの履歴をターンごとの変化として配る', () => {
    const history: TodoSnapshot[] = [
      { todos: [todo('A', 'pending'), todo('B', 'pending')], turnIndex: 0 },
      { todos: [todo('A', 'completed'), todo('B', 'in_progress')], turnIndex: 1 },
    ];
    const view = buildProgress(
      stateWith([item('userMessage', { text: '指示' }), item('userMessage', { text: '続き' })], {
        todos: [todo('A', 'completed'), todo('B', 'in_progress')],
        todoHistory: history,
      }),
    );

    expect(view.turns[0]?.todoChanges).toEqual([
      { content: 'A', kind: 'added' },
      { content: 'B', kind: 'added' },
    ]);
    expect(view.turns[1]?.todoChanges).toEqual([
      { content: 'A', kind: 'completed' },
      { content: 'B', kind: 'started' },
    ]);
    expect(view.summary.todoTotal).toBe(2);
    expect(view.summary.todoCompleted).toBe(1);
  });

  it('同じTODOが1ターンで何度も変わったときは最後の変化だけを残す', () => {
    const history: TodoSnapshot[] = [
      { todos: [todo('A', 'pending')], turnIndex: 0 },
      { todos: [todo('A', 'in_progress')], turnIndex: 0 },
      { todos: [todo('A', 'completed')], turnIndex: 0 },
    ];
    const view = buildProgress(
      stateWith([item('userMessage', { text: '指示' })], {
        todos: [todo('A', 'completed')],
        todoHistory: history,
      }),
    );

    expect(view.turns[0]?.todoChanges).toEqual([{ content: 'A', kind: 'completed' }]);
  });

  it('範囲外のturnIndexは最後のターンへ寄せる', () => {
    const view = buildProgress(
      stateWith([item('userMessage', { text: '指示' })], {
        todos: [todo('A', 'completed')],
        todoHistory: [{ todos: [todo('A', 'completed')], turnIndex: 7 }],
      }),
    );

    expect(view.turns[0]?.todoChanges).toEqual([{ content: 'A', kind: 'added' }]);
  });

  it('TODOを持たないセッション（Codex）ではチェックリストが空になる', () => {
    const view = buildProgress(
      stateWith([
        item('userMessage', { text: '指示' }),
        item('commandExecution', { detail: 'ls' }),
      ]),
    );

    expect(view.checklist).toEqual([]);
    expect(view.summary.todoTotal).toBe(0);
    expect(view.turns[0]?.todoChanges).toEqual([]);
  });

  it('応答中かどうかをそのまま持つ', () => {
    expect(buildProgress(stateWith([], { busy: true })).summary.busy).toBe(true);
  });
});

describe('diffTodos', () => {
  it('増えた・着手した・完了した・消えたを見分ける', () => {
    const before = [todo('A', 'pending'), todo('B', 'pending'), todo('C', 'pending')];
    const after = [todo('A', 'in_progress'), todo('B', 'completed'), todo('D', 'pending')];

    expect(diffTodos(before, after)).toEqual([
      { content: 'A', kind: 'started' },
      { content: 'B', kind: 'completed' },
      { content: 'D', kind: 'added' },
      { content: 'C', kind: 'removed' },
    ]);
  });

  it('変化が無ければ空を返す', () => {
    const todos = [todo('A', 'pending')];
    expect(diffTodos(todos, todos)).toEqual([]);
  });
});
