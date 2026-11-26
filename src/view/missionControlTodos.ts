import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type { McTodo, McTodoInput } from '../webview/missionControl/protocol';

/**
 * 期日付きのTodo（Mission Control 段階24。Issue #2180）。globalStateに配列で保存する。
 *
 * webviewから届いた値も、globalStateから読んだ値も信頼しない（設定の同期や古い版の値が
 * 混ざりうる）。どちらも`normalizeTodo` / `parseTodoInput`で形・長さ・文字を確かめてから使う。
 * 期日はローカル日付の`YYYY-MM-DD`で持ち、時刻を持たない（夏時間の日でも日がずれない）。
 *
 * vscodeに依らない。
 */

export const TODOS_STATE_KEY = 'agent.missionControl.todos';
export const MAX_TODOS = 500;
export const TODO_TITLE_MAX = 200;
export const TODO_SKILL_MAX = 80;
export const TODO_REPO_MAX = 1024;
const ID_MAX = 100;

/** skill名に使える文字（`plugin:skill`・`skill-name`・`a.b`）。 */
const SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** `YYYY-MM-DD`が実在する日付か（2000〜9999年。カレンダーの範囲と同じ）。 */
export function validDueDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DUE_PATTERN.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1) return false;
  // 月の日数はローカル時刻のDateで求める（0日目＝前の月の末日）
  return day <= new Date(year, month, 0).getDate();
}

/** 作業名を1行にして長さを制限する。空なら`undefined`。 */
function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // 制御文字は空白に替わるので、詰めるのは後で行う
  const cleaned = sanitizeInlineText(value.replace(/\s+/gu, ' ').trim(), TODO_TITLE_MAX)
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

/** skill名。先頭の`/`・`$`は外す。空は空文字、使えない文字を含めば`undefined`。 */
function cleanSkill(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/^[/$]+/u, '');
  if (trimmed === '') return '';
  if (trimmed.length > TODO_SKILL_MAX || !SKILL_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/** repoの絶対パス。空は空文字、不正なら`undefined`。 */
function cleanRepo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === '') return '';
  if (value.length > TODO_REPO_MAX || /[\0\r\n]/u.test(value) || !path.isAbsolute(value)) {
    return undefined;
  }
  return path.resolve(value);
}

/** webviewから届いた追加・編集の入力を確かめる。不正なら理由の文を返す。 */
export function parseTodoInput(raw: unknown): McTodoInput | string {
  if (typeof raw !== 'object' || raw === null) return 'Todoの内容が不正です';
  const m = raw as Record<string, unknown>;
  const title = cleanTitle(m.title);
  if (title === undefined) return '作業名を入れてください';
  if (!validDueDate(m.due)) return '期日が正しくありません';
  const skill = cleanSkill(m.skill);
  if (skill === undefined) {
    return `skill名は英数字と . _ : - だけで${String(TODO_SKILL_MAX)}文字までです`;
  }
  const repo = cleanRepo(m.repo);
  if (repo === undefined) return 'repoは絶対パスで指定してください';
  if (m.provider !== 'codex' && m.provider !== 'claude') return 'CodexかClaudeを選んでください';
  const id = m.id;
  if (id !== undefined && (typeof id !== 'string' || id === '' || id.length > ID_MAX)) {
    return 'Todoのidが不正です';
  }
  return { id, title, due: m.due, skill, repo, provider: m.provider };
}

/** 保存済みの1件を確かめる。壊れていれば`undefined`（捨てる）。 */
function normalizeTodo(raw: unknown): McTodo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const input = parseTodoInput(m);
  if (typeof input === 'string' || input.id === undefined) return undefined;
  const createdAt =
    typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : 0;
  const updatedAt =
    typeof m.updatedAt === 'number' && Number.isFinite(m.updatedAt) ? m.updatedAt : createdAt;
  return { ...input, id: input.id, done: m.done === true, createdAt, updatedAt };
}

/** globalStateの値からTodoの一覧を読む。配列でなければ空。壊れた要素とidの重複は捨てる。 */
export function readTodos(raw: unknown): McTodo[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const todos: McTodo[] = [];
  for (const item of raw.slice(0, MAX_TODOS)) {
    const todo = normalizeTodo(item);
    if (todo === undefined || seen.has(todo.id)) continue;
    seen.add(todo.id);
    todos.push(todo);
  }
  return todos;
}

/** 期日の早い順（同じ日は作った順）。 */
export function sortTodos(todos: readonly McTodo[]): McTodo[] {
  return [...todos].sort(
    (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.createdAt - b.createdAt,
  );
}

export type TodoChange = { ok: true; todos: McTodo[] } | { ok: false; error: string };

/** 追加（`input.id`が無い）か編集。完了の状態と作った時刻は編集で変えない。 */
export function saveTodo(
  todos: readonly McTodo[],
  input: McTodoInput,
  now: number,
  newId: () => string = randomUUID,
): TodoChange {
  const { id, ...fields } = input;
  if (id === undefined) {
    if (todos.length >= MAX_TODOS) {
      return { ok: false, error: `Todoは${String(MAX_TODOS)}件までです` };
    }
    const todo: McTodo = { ...fields, id: newId(), done: false, createdAt: now, updatedAt: now };
    return { ok: true, todos: sortTodos([...todos, todo]) };
  }
  if (!todos.some((t) => t.id === id)) return { ok: false, error: 'Todoが見つかりません' };
  return {
    ok: true,
    todos: sortTodos(todos.map((t) => (t.id === id ? { ...t, ...fields, updatedAt: now } : t))),
  };
}

export function setTodoDone(
  todos: readonly McTodo[],
  id: unknown,
  done: unknown,
  now: number,
): TodoChange {
  if (typeof id !== 'string' || typeof done !== 'boolean') {
    return { ok: false, error: 'Todoの指定が不正です' };
  }
  if (!todos.some((t) => t.id === id)) return { ok: false, error: 'Todoが見つかりません' };
  return {
    ok: true,
    todos: todos.map((t) => (t.id === id ? { ...t, done, updatedAt: now } : t)),
  };
}

export function deleteTodo(todos: readonly McTodo[], id: unknown): TodoChange {
  if (typeof id !== 'string') return { ok: false, error: 'Todoの指定が不正です' };
  if (!todos.some((t) => t.id === id)) return { ok: false, error: 'Todoが見つかりません' };
  return { ok: true, todos: todos.filter((t) => t.id !== id) };
}

/** globalStateの読み書きだけを抜き出した形（`vscode.Memento`の一部）。 */
export interface TodoMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * 保存先。変更は直列にする（webviewから続けて届いた2つの変更が、同じ古い一覧を元に
 * 書いて片方を消さないため）。
 */
export class TodoStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly memento: TodoMemento,
    private readonly now: () => number = Date.now,
  ) {}

  list(): McTodo[] {
    return sortTodos(readTodos(this.memento.get(TODOS_STATE_KEY)));
  }

  save(input: McTodoInput): Promise<TodoChange> {
    return this.change((todos) => saveTodo(todos, input, this.now()));
  }

  setDone(id: unknown, done: unknown): Promise<TodoChange> {
    return this.change((todos) => setTodoDone(todos, id, done, this.now()));
  }

  remove(id: unknown): Promise<TodoChange> {
    return this.change((todos) => deleteTodo(todos, id));
  }

  private change(apply: (todos: McTodo[]) => TodoChange): Promise<TodoChange> {
    const next = this.queue.then(async (): Promise<TodoChange> => {
      const result = apply(this.list());
      if (result.ok) await this.memento.update(TODOS_STATE_KEY, result.todos);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
