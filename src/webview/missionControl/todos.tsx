import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import { ProviderIcon } from './icons';
import type { McLaunchRepo, McTodo, McTodoInput } from './protocol';
import {
  emptyTodoInput,
  formatTodoMeta,
  isOverdue,
  orderTodos,
  repoLabel,
  todayKey,
  todoToInput,
} from './todoLogic';

/**
 * 期日付きのTodo（Mission Control 段階24。Issue #2180）の部品。カレンダー（`workCalendar.tsx`）と
 * Todoの一覧（`TodoListDialog`）が同じ部品・同じキーを使う。
 *
 * キー（一覧・カレンダー共通）: aで追加、eで編集、xで完了 / 未完了、Shift+Dで削除（2回押す）、
 * sでそのTodoから新規セッションを始める（入力欄に作業名とskill名を入れ、送信はしない）。
 */

/** Todoから新規セッションを始めるときに、新規セッションの画面へ渡す初期値。 */
export interface TodoLaunchSeed {
  todo: McTodo;
}

type TodosState =
  { status: 'loading' } | { status: 'ok'; todos: McTodo[] } | { status: 'error'; error: string };

export interface TodoOps {
  state: TodosState;
  todos: McTodo[];
  /** 直近の操作の失敗。 */
  error: string | undefined;
  /** 保存の応答（変更後の一覧）を反映する。 */
  apply(todos: McTodo[] | undefined): void;
  toggleDone(todo: McTodo): void;
  remove(todo: McTodo): void;
}

/** Todoの一覧の取り寄せと、完了・削除。 */
export function useTodos(bridge: Bridge): TodoOps {
  const [state, setState] = useState<TodosState>({ status: 'loading' });
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void bridge.todos().then((result) => {
      if (!alive) return;
      setState(
        result.ok
          ? { status: 'ok', todos: result.todos ?? [] }
          : { status: 'error', error: result.error ?? 'Todoを読めませんでした' },
      );
    });
    return () => {
      alive = false;
    };
  }, [bridge]);
  const apply = useCallback((todos: McTodo[] | undefined): void => {
    setError(undefined);
    if (todos !== undefined) setState({ status: 'ok', todos });
  }, []);
  const settle = useCallback(
    (result: { ok: boolean; error?: string | undefined; todos?: McTodo[] | undefined }): void => {
      if (result.ok) apply(result.todos);
      else setError(result.error ?? 'Todoを更新できませんでした');
    },
    [apply],
  );
  return {
    state,
    todos: state.status === 'ok' ? state.todos : [],
    error,
    apply,
    toggleDone: (todo) => {
      void bridge.todoDone(todo.id, !todo.done).then(settle);
    },
    remove: (todo) => {
      void bridge.todoDelete(todo.id).then(settle);
    },
  };
}

/**
 * Todoの一覧の行とキー（a / e / x / Shift+D / s）を受け持つ。カーソルの移動は呼び出し側が
 * 決める（カレンダーはShift+N / Shift+P、一覧は↑ / ↓）。
 */
export function useTodoKeys(options: {
  ops: TodoOps;
  selected: McTodo | undefined;
  newDue: () => string;
  onEdit: (input: McTodoInput) => void;
  onStart: (todo: McTodo) => void;
}): { handle: (e: KeyboardEvent) => boolean; confirmDelete: string | undefined } {
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);
  const { ops, selected } = options;
  useEffect(() => {
    // 選んでいるTodoが変われば、削除の確かめはやり直す
    setConfirmDelete(undefined);
  }, [selected?.id]);
  const handle = (e: KeyboardEvent): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
    if (e.key === 'a' && !e.shiftKey) {
      options.onEdit(emptyTodoInput(options.newDue(), selected?.provider));
      return true;
    }
    if (selected === undefined) return false;
    if (e.key === 'e' && !e.shiftKey) {
      options.onEdit(todoToInput(selected));
      return true;
    }
    if (e.key === 'x' && !e.shiftKey) {
      ops.toggleDone(selected);
      return true;
    }
    if (e.key === 'D' && e.shiftKey) {
      // 押し続けたときの自動の繰り返しは2回目に数えない（1回押しただけで消さない）
      if (e.repeat) return true;
      if (confirmDelete === selected.id) {
        setConfirmDelete(undefined);
        ops.remove(selected);
      } else {
        setConfirmDelete(selected.id);
      }
      return true;
    }
    if (e.key === 's' && !e.shiftKey) {
      options.onStart(selected);
      return true;
    }
    return false;
  };
  return { handle, confirmDelete };
}

/** Todoの行の並び。 */
export function TodoRows(props: {
  todos: readonly McTodo[];
  index: number;
  label: string;
  onSelect: (i: number) => void;
  onStart: (todo: McTodo) => void;
}): JSX.Element {
  const today = todayKey();
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-todo-row="${String(props.index)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [props.index]);
  return (
    <div class="history-list todo-list" ref={listRef} role="listbox" aria-label={props.label}>
      {props.todos.map((todo, i) => {
        const classes = [
          'row',
          i === props.index ? 'selected' : '',
          todo.done ? 'todo-done' : '',
          isOverdue(todo, today) ? 'todo-overdue' : '',
        ]
          .filter((c) => c !== '')
          .join(' ');
        return (
          <div
            key={todo.id}
            data-todo-row={String(i)}
            class={classes}
            role="option"
            aria-selected={i === props.index}
            onClick={() => props.onSelect(i)}
            onDblClick={() => props.onStart(todo)}
          >
            <ProviderIcon provider={todo.provider} />
            <span class="row-title">{todo.title}</span>
            <span class="row-meta">{todo.done ? '完了' : ''}</span>
            <span class="row-sub" title={todo.repo}>
              {formatTodoMeta(todo, today)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Todoの追加・編集のフォーム。Enter（Ctrl+Enter）で保存、Escで閉じる。repoの候補は
 * 新規セッションと同じもの（`launchOptions`）を出す。
 */
export function TodoFormDialog(props: {
  bridge: Bridge;
  initial: McTodoInput;
  onSaved: (todos: McTodo[] | undefined) => void;
  onClose: () => void;
}): JSX.Element {
  const { bridge, initial } = props;
  const [value, setValue] = useState<McTodoInput>(initial);
  const [repos, setRepos] = useState<McLaunchRepo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
    let alive = true;
    void bridge.launchOptions().then((result) => {
      if (alive && result.ok) setRepos(result.repos ?? []);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const repoOptions = useMemo(() => {
    const list = repos.map((r) => ({ path: r.path, label: `${r.label}（${r.path}）` }));
    if (value.repo !== '' && !list.some((r) => r.path === value.repo)) {
      list.unshift({ path: value.repo, label: `${repoLabel(value.repo)}（${value.repo}）` });
    }
    return list;
  }, [repos, value.repo]);

  const set = <K extends keyof McTodoInput>(key: K, next: McTodoInput[K]): void => {
    setValue((prev) => ({ ...prev, [key]: next }));
  };

  const save = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void bridge.todoSave(value).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? 'Todoを保存できませんでした');
        return;
      }
      props.onSaved(result.todos);
    });
  };

  return (
    <div
      class="help"
      role="dialog"
      aria-label={initial.id === undefined ? 'Todoを追加' : 'Todoを編集'}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <form
        class="help-box launch-box"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h2>{initial.id === undefined ? 'Todoを追加' : 'Todoを編集'}</h2>
        <label>
          作業名
          <input
            ref={titleRef}
            class="text-input"
            type="text"
            maxLength={200}
            value={value.title}
            disabled={busy}
            onInput={(e) => set('title', e.currentTarget.value)}
          />
        </label>
        <label>
          期日
          <input
            class="text-input"
            type="date"
            min="2000-01-01"
            max="9999-12-31"
            value={value.due}
            disabled={busy}
            onInput={(e) => set('due', e.currentTarget.value)}
          />
        </label>
        <label>
          使うskill（空なら付けない。例: gitlab-develop）
          <input
            class="text-input"
            type="text"
            maxLength={80}
            value={value.skill}
            disabled={busy}
            onInput={(e) => set('skill', e.currentTarget.value)}
          />
        </label>
        <label>
          Repo
          <select
            class="text-input"
            aria-label="起動するrepo"
            value={value.repo}
            disabled={busy}
            onChange={(e) => set('repo', e.currentTarget.value)}
          >
            <option value="">（起動するときに選ぶ）</option>
            {repoOptions.map((r) => (
              <option key={r.path} value={r.path} title={r.path}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <div class="seg" role="group" aria-label="起動するCLI">
          <button
            type="button"
            aria-pressed={value.provider === 'claude'}
            disabled={busy}
            onClick={() => set('provider', 'claude')}
          >
            Claude
          </button>
          <button
            type="button"
            aria-pressed={value.provider === 'codex'}
            disabled={busy}
            onClick={() => set('provider', 'codex')}
          >
            Codex
          </button>
        </div>
        {error !== undefined ? <p class="error">{error}</p> : null}
        <div class="actions">
          <button type="submit" class="btn primary" disabled={busy}>
            保存（Enter）
          </button>
          <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
            やめる（Esc）
          </button>
        </div>
      </form>
    </div>
  );
}

/** 削除の確かめ・操作の失敗の表示。 */
export function TodoNotices(props: {
  ops: TodoOps;
  confirmDelete: string | undefined;
}): JSX.Element | null {
  const { ops, confirmDelete } = props;
  if (ops.state.status === 'error') return <p class="error">{ops.state.error}</p>;
  if (ops.error !== undefined) return <p class="error">{ops.error}</p>;
  if (confirmDelete !== undefined) {
    return <p class="error">もう一度Shift+Dを押すと、このTodoを削除します。</p>;
  }
  return null;
}

/**
 * Todoの一覧（全期日）。↑ / ↓（j / k）で選び、a / e / x / Shift+D / s（Enter）で操作する。
 */
export function TodoListDialog(props: {
  bridge: Bridge;
  onClose: () => void;
  onStart: (todo: McTodo) => void;
}): JSX.Element {
  const { bridge } = props;
  const ops = useTodos(bridge);
  const [cursor, setCursor] = useState(0);
  const [form, setForm] = useState<McTodoInput | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const todos = useMemo(() => orderTodos(ops.todos), [ops.todos]);
  const index = Math.min(cursor, Math.max(todos.length - 1, 0));
  const selected = todos[index];
  const keys = useTodoKeys({
    ops,
    selected,
    newDue: () => todayKey(),
    onEdit: setForm,
    onStart: props.onStart,
  });

  useEffect(() => {
    if (form === undefined) boxRef.current?.focus();
  }, [form]);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== boxRef.current) return;
    const last = Math.max(todos.length - 1, 0);
    let handled = true;
    if (e.key === 'ArrowDown' || (e.key === 'j' && !e.shiftKey)) {
      setCursor(Math.min(index + 1, last));
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && !e.shiftKey)) {
      setCursor(Math.max(index - 1, 0));
    } else if (e.key === 'Enter' && selected !== undefined) {
      props.onStart(selected);
    } else {
      handled = keys.handle(e);
    }
    if (handled) e.preventDefault();
  };

  return (
    <>
      <div
        class="help"
        role="dialog"
        aria-label="Todo"
        data-reserved-keys="jkaexds"
        onKeyDown={onKeyDown}
      >
        <div class="help-box history-box" ref={boxRef} tabIndex={-1}>
          <h2>Todo（期日付き）</h2>
          <p class="notice">
            ↑ / ↓（j / k）で選ぶ。aで追加、eで編集、xで完了、Shift+Dで削除、s（Enter）で
            新規セッションを始める（入力欄に作業名とskill名を入れる。送信はしない）。
          </p>
          <TodoNotices ops={ops} confirmDelete={keys.confirmDelete} />
          {ops.state.status === 'loading' ? <p class="notice">Todoを読み込み中…</p> : null}
          {ops.state.status === 'ok' && todos.length === 0 ? (
            <p class="empty">Todoはありません。aで追加します。</p>
          ) : null}
          <TodoRows
            todos={todos}
            index={index}
            label="Todo"
            onSelect={setCursor}
            onStart={props.onStart}
          />
          <div class="actions">
            <button
              type="button"
              class="btn"
              onClick={() => setForm(emptyTodoInput(todayKey(), selected?.provider))}
            >
              追加（a）
            </button>
            <button
              type="button"
              class="btn"
              disabled={selected === undefined}
              onClick={() => {
                if (selected !== undefined) props.onStart(selected);
              }}
            >
              セッションを始める（s）
            </button>
            <button type="button" class="btn" onClick={props.onClose}>
              閉じる（Esc）
            </button>
          </div>
        </div>
      </div>
      {form !== undefined ? (
        <TodoFormDialog
          bridge={bridge}
          initial={form}
          onSaved={(next) => {
            ops.apply(next);
            setForm(undefined);
          }}
          onClose={() => setForm(undefined)}
        />
      ) : null}
    </>
  );
}
