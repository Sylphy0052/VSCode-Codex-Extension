import type { McProvider, McTodo, McTodoInput } from './protocol';
import { calendarDayKey, todayDate } from './workCalendarLogic';

/**
 * 期日付きのTodo（Mission Control 段階24。Issue #2180）の並べ方と表示の文字列。DOMの型も
 * Preactも使わない（単体テストから直接呼ぶ）。期日はローカル日付の`YYYY-MM-DD`で、
 * カレンダーの`calendarDayKey`と同じ書式・同じ境目（ローカル時刻の0時）で比べる。
 */

/** 期日（`YYYY-MM-DD`）からその日のTodoを引く表。並びは渡した順のまま。 */
export function todosByDay(todos: readonly McTodo[]): Map<string, McTodo[]> {
  const map = new Map<string, McTodo[]>();
  for (const todo of todos) {
    const list = map.get(todo.due);
    if (list === undefined) map.set(todo.due, [todo]);
    else list.push(todo);
  }
  return map;
}

/** 一覧の並び: 未完了を期日の早い順に、完了を後ろへ（同じ期日は作った順）。 */
export function orderTodos(todos: readonly McTodo[]): McTodo[] {
  return [...todos].sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) ||
      a.createdAt - b.createdAt,
  );
}

/** 今日（ローカル日付）の`YYYY-MM-DD`。 */
export function todayKey(now: number = Date.now()): string {
  return calendarDayKey(todayDate(now));
}

/** 期日を過ぎた未完了か。期日の当日は過ぎていない。 */
export function isOverdue(todo: McTodo, today: string): boolean {
  return !todo.done && todo.due < today;
}

/** 新しいTodoの入力の初期値。 */
export function emptyTodoInput(due: string, provider: McProvider = 'claude'): McTodoInput {
  return { title: '', due, skill: '', repo: '', provider };
}

/** 編集の入力の初期値。 */
export function todoToInput(todo: McTodo): McTodoInput {
  return {
    id: todo.id,
    title: todo.title,
    due: todo.due,
    skill: todo.skill,
    repo: todo.repo,
    provider: todo.provider,
  };
}

/**
 * Todoから開く会話の入力欄へ入れる文。skillはCLIごとの呼び方（Claudeは`/名前`、Codexは
 * `$名前`）で先頭に置き、作業名を続ける。送信はしない（人が確かめて送る）。
 */
export function todoDraftText(todo: Pick<McTodo, 'title' | 'skill' | 'provider'>): string {
  if (todo.skill === '') return todo.title;
  const prefix = todo.provider === 'codex' ? '$' : '/';
  return `${prefix}${todo.skill} ${todo.title}`;
}

function shortDue(due: string): string {
  const [, month, day] = due.split('-');
  return `${String(Number(month))}/${String(Number(day))}`;
}

/** 一覧の補足（`11/30 · skill gitlab-develop · Claude · repo名`）。 */
export function formatTodoMeta(todo: McTodo, today: string): string {
  const parts = [shortDue(todo.due) + (isOverdue(todo, today) ? '（期日超過）' : '')];
  if (todo.skill !== '') parts.push(`skill ${todo.skill}`);
  parts.push(todo.provider === 'codex' ? 'Codex' : 'Claude');
  if (todo.repo !== '') parts.push(repoLabel(todo.repo));
  return parts.join(' · ');
}

/** repoのパスの末尾の名前（`/a/b/repo` → `repo`）。 */
export function repoLabel(repo: string): string {
  const parts = repo.split(/[\\/]+/u).filter((p) => p !== '');
  return parts[parts.length - 1] ?? repo;
}

/** カレンダーのマスに出す件数（`Todo 2`）。未完了が無ければ空文字。 */
export function formatCellTodos(todos: readonly McTodo[] | undefined): string {
  const open = (todos ?? []).filter((t) => !t.done).length;
  return open === 0 ? '' : `Todo ${String(open)}`;
}
