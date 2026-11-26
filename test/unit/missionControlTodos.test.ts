import { describe, expect, it, vi } from 'vitest';
import {
  deleteTodo,
  MAX_TODOS,
  parseTodoInput,
  readTodos,
  saveTodo,
  setTodoDone,
  TodoStore,
  TODOS_STATE_KEY,
  validDueDate,
} from '../../src/view/missionControlTodos';
import {
  launchMissionControlSession,
  parseLaunchRequest,
} from '../../src/view/missionControlLaunch';
import type { McLaunchDeps } from '../../src/view/missionControlLaunch';
import type { McTodo } from '../../src/webview/missionControl/protocol';
import {
  formatCellTodos,
  isOverdue,
  orderTodos,
  todayKey,
  todoDraftText,
  todosByDay,
} from '../../src/webview/missionControl/todoLogic';
import { resolveKey } from '../../src/webview/missionControl/keys';

function todo(overrides: Partial<McTodo> = {}): McTodo {
  return {
    id: 't1',
    title: '設計を詰める',
    due: '2026-11-30',
    skill: 'gitlab-develop',
    repo: '/w/app',
    provider: 'claude',
    done: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const input = {
  title: '設計を詰める',
  due: '2026-11-30',
  skill: 'gitlab-develop',
  repo: '/w/app',
  provider: 'claude',
};

describe('validDueDate（Issue #2180）', () => {
  it('月末・閏年の2月末を実在する日だけ受け付ける', () => {
    expect(validDueDate('2026-01-31')).toBe(true);
    expect(validDueDate('2026-04-31')).toBe(false);
    expect(validDueDate('2026-02-28')).toBe(true);
    expect(validDueDate('2026-02-29')).toBe(false);
    expect(validDueDate('2028-02-29')).toBe(true);
    expect(validDueDate('2026-12-31')).toBe(true);
    expect(validDueDate('2026-13-01')).toBe(false);
    expect(validDueDate('2026-00-10')).toBe(false);
    expect(validDueDate('1999-12-31')).toBe(false);
    expect(validDueDate('2026-1-5')).toBe(false);
    expect(validDueDate(20261130)).toBe(false);
  });

  it('夏時間の切替日（America/Los_Angelesの2026-03-08・2026-11-01）も日付として受け付ける', () => {
    expect(validDueDate('2026-03-08')).toBe(true);
    expect(validDueDate('2026-11-01')).toBe(true);
  });
});

describe('parseTodoInput（Issue #2180）', () => {
  it('作業名は制御文字・改行を除いて1行にし、200文字で切る', () => {
    const parsed = parseTodoInput({
      ...input,
      title: '  一行目\n二行目\u001b[31m赤\u0007  ',
    });
    expect(parsed).toMatchObject({ title: '一行目 二行目 [31m赤' });
    const long = parseTodoInput({ ...input, title: 'あ'.repeat(300) });
    expect(typeof long === 'object' && long.title.length).toBe(201);
    expect(parseTodoInput({ ...input, title: ' \n ' })).toBe('作業名を入れてください');
  });

  it('skillは先頭の/・$を外し、英数字と . _ : - だけを受け付ける', () => {
    expect(parseTodoInput({ ...input, skill: '/gitlab-develop' })).toMatchObject({
      skill: 'gitlab-develop',
    });
    expect(parseTodoInput({ ...input, skill: '$plugin:skill.v2' })).toMatchObject({
      skill: 'plugin:skill.v2',
    });
    expect(parseTodoInput({ ...input, skill: '' })).toMatchObject({ skill: '' });
    expect(typeof parseTodoInput({ ...input, skill: 'a b' })).toBe('string');
    expect(typeof parseTodoInput({ ...input, skill: 'x;rm -rf' })).toBe('string');
    expect(typeof parseTodoInput({ ...input, skill: 'a'.repeat(81) })).toBe('string');
  });

  it('repoは空か絶対パス（NUL・改行なし）、providerはcodex / claude、期日は実在する日', () => {
    expect(parseTodoInput({ ...input, repo: '' })).toMatchObject({ repo: '' });
    expect(parseTodoInput({ ...input, repo: 'rel/path' })).toBe('repoは絶対パスで指定してください');
    expect(parseTodoInput({ ...input, repo: '/w/a\nb' })).toBe('repoは絶対パスで指定してください');
    expect(parseTodoInput({ ...input, repo: '/w/app/../app' })).toMatchObject({ repo: '/w/app' });
    expect(parseTodoInput({ ...input, provider: 'gpt' })).toBe('CodexかClaudeを選んでください');
    expect(parseTodoInput({ ...input, due: '2026-02-30' })).toBe('期日が正しくありません');
    expect(parseTodoInput(null)).toBe('Todoの内容が不正です');
    expect(parseTodoInput({ ...input, id: 5 })).toBe('Todoのidが不正です');
  });
});

describe('Todoの変更（Issue #2180）', () => {
  it('追加は期日の早い順に並べ、編集は完了の状態と作った時刻を変えない', () => {
    const first = saveTodo([], { ...input, due: '2026-12-01' } as never, 10, () => 'a');
    expect(first.ok).toBe(true);
    const todos = first.ok ? first.todos : [];
    const second = saveTodo(todos, { ...input, due: '2026-11-30' } as never, 20, () => 'b');
    expect(second.ok && second.todos.map((t) => t.id)).toEqual(['b', 'a']);
    const doneList = setTodoDone(second.ok ? second.todos : [], 'a', true, 30);
    expect(doneList.ok && doneList.todos.find((t) => t.id === 'a')?.done).toBe(true);
    const edited = saveTodo(
      doneList.ok ? doneList.todos : [],
      { ...input, id: 'a', title: '直した', due: '2026-11-29' } as never,
      40,
    );
    expect(edited.ok && edited.todos[0]).toMatchObject({
      id: 'a',
      title: '直した',
      done: true,
      createdAt: 10,
      updatedAt: 40,
    });
  });

  it('無いidの編集・完了・削除と、上限を超える追加は断る', () => {
    expect(saveTodo([], { ...input, id: 'x' } as never, 1)).toEqual({
      ok: false,
      error: 'Todoが見つかりません',
    });
    expect(setTodoDone([todo()], 'x', true, 1).ok).toBe(false);
    expect(setTodoDone([todo()], 't1', 'yes', 1).ok).toBe(false);
    expect(deleteTodo([todo()], 'x').ok).toBe(false);
    expect(deleteTodo([todo()], 't1')).toEqual({ ok: true, todos: [] });
    const full = Array.from({ length: MAX_TODOS }, (_, i) => todo({ id: String(i) }));
    expect(saveTodo(full, input as never, 1).ok).toBe(false);
  });

  it('保存済みの値は壊れた要素・idの重複を捨て、作業名を読み直す', () => {
    expect(readTodos('x')).toEqual([]);
    const todos = readTodos([
      todo(),
      todo({ title: '重複' }),
      { ...todo({ id: 't2' }), title: '悪い\u001b名前' },
      { ...todo({ id: 't3' }), due: 'bad' },
      null,
    ]);
    expect(todos.map((t) => [t.id, t.title])).toEqual([
      ['t1', '設計を詰める'],
      ['t2', '悪い 名前'],
    ]);
  });

  it('TodoStoreは続けて届いた変更を直列にし、片方を消さない', async () => {
    const data = new Map<string, unknown>();
    const memento = {
      get: (k: string) => data.get(k),
      update: vi.fn(async (k: string, v: unknown) => {
        await Promise.resolve();
        data.set(k, v);
      }),
    };
    const store = new TodoStore(memento, () => 100);
    const [a, b] = await Promise.all([
      store.save({ ...input, title: '一つ目' } as never),
      store.save({ ...input, title: '二つ目' } as never),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(store.list().map((t) => t.title)).toEqual(['一つ目', '二つ目']);
    expect(memento.update).toHaveBeenCalledWith(TODOS_STATE_KEY, expect.any(Array));
    const id = store.list()[0]?.id;
    expect((await store.setDone(id, true)).ok).toBe(true);
    expect((await store.remove(id)).ok).toBe(true);
    expect(store.list().map((t) => t.title)).toEqual(['二つ目']);
  });
});

describe('Todoの表示（Issue #2180）', () => {
  it('期日ごとに引け、月末と翌月1日を別の日にする', () => {
    const map = todosByDay([
      todo({ id: 'a', due: '2026-01-31' }),
      todo({ id: 'b', due: '2026-02-01' }),
      todo({ id: 'c', due: '2028-02-29' }),
      todo({ id: 'd', due: '2026-01-31' }),
    ]);
    expect(map.get('2026-01-31')?.map((t) => t.id)).toEqual(['a', 'd']);
    expect(map.get('2026-02-01')?.map((t) => t.id)).toEqual(['b']);
    expect(map.get('2028-02-29')?.map((t) => t.id)).toEqual(['c']);
  });

  it('今日と期日超過はローカル時刻の0時で区切る（夏時間の切替日の23時台・0時台を含む）', () => {
    // TZ=America/Los_Angelesでは2026-03-08が23時間、2026-11-01が25時間
    expect(todayKey(new Date(2026, 2, 8, 23, 30).getTime())).toBe('2026-03-08');
    expect(todayKey(new Date(2026, 2, 9, 0, 10).getTime())).toBe('2026-03-09');
    expect(todayKey(new Date(2026, 10, 1, 23, 59).getTime())).toBe('2026-11-01');
    expect(todayKey(new Date(2026, 0, 31, 23, 59).getTime())).toBe('2026-01-31');
    expect(todayKey(new Date(2026, 1, 1, 0, 0).getTime())).toBe('2026-02-01');
    const t = todo({ due: '2026-03-08' });
    expect(isOverdue(t, '2026-03-08')).toBe(false);
    expect(isOverdue(t, '2026-03-09')).toBe(true);
    expect(isOverdue({ ...t, done: true }, '2026-03-09')).toBe(false);
  });

  it('入力欄へ入れる文はCLIごとのskillの呼び方で作業名を続ける', () => {
    expect(todoDraftText(todo())).toBe('/gitlab-develop 設計を詰める');
    expect(todoDraftText(todo({ provider: 'codex' }))).toBe('$gitlab-develop 設計を詰める');
    expect(todoDraftText(todo({ skill: '' }))).toBe('設計を詰める');
  });

  it('マスには未完了の件数だけを出し、一覧は未完了を期日順に先へ並べる', () => {
    expect(formatCellTodos([todo(), todo({ id: 'b', done: true })])).toBe('Todo 1');
    expect(formatCellTodos([todo({ done: true })])).toBe('');
    expect(formatCellTodos(undefined)).toBe('');
    expect(
      orderTodos([
        todo({ id: 'done', done: true, due: '2026-01-01' }),
        todo({ id: 'late', due: '2026-12-01' }),
        todo({ id: 'early', due: '2026-11-01' }),
      ]).map((t) => t.id),
    ).toEqual(['early', 'late', 'done']);
  });

  it('yでTodoを開く（ヘルプとパレットはKEY_BINDINGSから作る）', () => {
    expect(
      resolveKey({
        key: 'y',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        inEditable: false,
      })?.command,
    ).toEqual({ kind: 'todos' });
  });
});

describe('Todoから起動する新規セッションの下書き（Issue #2180）', () => {
  const base = { cwd: '/w/app', provider: 'claude', prompt: '', worktree: false };

  it('draftは送る指示と別に受け、最初の指示と同時には指定できない', () => {
    expect(parseLaunchRequest({ ...base, draft: '/skill 作業' })).toMatchObject({
      prompt: '',
      draft: '/skill 作業',
    });
    expect(parseLaunchRequest({ ...base })).not.toHaveProperty('draft');
    expect(parseLaunchRequest({ ...base, draft: '  ' })).not.toHaveProperty('draft');
    expect(parseLaunchRequest({ ...base, draft: 5 })).toBe('入力欄へ入れる文が不正です');
    expect(parseLaunchRequest({ ...base, prompt: 'go', draft: 'x' })).toBe(
      '最初の指示と入力欄へ入れる文は同時に指定できません',
    );
  });

  it('draftは会話を開く処理へそのまま渡す（送信はしない）', async () => {
    const open = vi.fn(async () => 'thread-1');
    const deps = {
      git: { run: vi.fn() },
      worktreeFs: {} as never,
      worktrees: {} as never,
      isDirectory: async () => true,
      appendExclude: vi.fn(),
      open,
    } as unknown as McLaunchDeps;
    const result = await launchMissionControlSession(
      { cwd: '/w/app', provider: 'claude', prompt: '', worktree: false, draft: '/s 作業' },
      deps,
    );
    expect(result).toEqual({ ok: true, cwd: '/w/app', threadId: 'thread-1' });
    expect(open).toHaveBeenCalledWith('claude', '/w/app', '', undefined, '/s 作業');
  });
});
