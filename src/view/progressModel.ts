import type { ChatItem, ChatState, TodoItem, TodoSnapshot } from '../appserver/chatState';

/**
 * 進捗画面（issue #721）の表示モデル。`ChatState` から組み立てる純粋なロジックで、
 * `vscode` には依存しない（テストから直接呼べるようにするため）。
 *
 * ターンの区切りはユーザーの発言（`userMessage`）に置く。`ChatItem.turnId` は
 * Codexにしか入らない（Claude Codeは常に `undefined`。`src/claude/streamJson.ts` 参照）ため、
 * プロバイダをまたいで同じ数え方ができるのは発言の位置だけになる。
 */

/** 応答の抜粋として持つ長さ。これを超えた分は捨てる（画面は一覧性を優先する）。 */
export const RESPONSE_PREVIEW_CHARS = 200;

/** 指示の抜粋として持つ長さ。 */
export const INSTRUCTION_PREVIEW_CHARS = 200;

/** TODOの状態がどう変わったか。 */
export type TodoChangeKind = 'added' | 'started' | 'completed' | 'removed';

export interface TodoChange {
  /** 対象のTODOの本文。同一性の判定にも使う（`TodoWrite` はidを持たないため）。 */
  content: string;
  kind: TodoChangeKind;
}

/** 1ターン分の経過。 */
export interface ProgressTurn {
  /** 0起点。`currentTurnIndex` の数え方と揃える。 */
  index: number;
  /** そのターンのユーザーの指示（抜粋）。発言より前に始まった分は空。 */
  instruction: string;
  /** そのターンの最後の応答（抜粋）。まだ応答が無ければ空。 */
  response: string;
  /** そのターンで変更したファイル。重複は除く。 */
  editedFiles: string[];
  /**
   * そのターンで各ファイルへ何回書き込みが届いたか。`editedFiles` の各要素をキーに持つ。
   *
   * `editedFiles` から重複を落としたままだと「1回直しただけ」と「同じファイルを10回
   * 往復した」が画面上で区別できない。件数の一覧性は `editedFiles` 側で保ち、
   * 回数はこちらに分けて持つ（既存の利用側の数え方を変えないため）。
   */
  fileEditCounts: Record<string, number>;
  /** そのターンで実行したコマンド。同じコマンドの繰り返しも別の行として残す。 */
  commands: string[];
  /** そのターンで起きたTODOの変化。同じTODOが複数回変わったときは最後の変化だけを残す。 */
  todoChanges: TodoChange[];
}

/** 変更したファイルをディレクトリでまとめた1組（issue #749）。 */
export interface EditedFileGroup {
  /**
   * 表示用のディレクトリ。共通の接頭辞を落とした後の値で、末尾に `/` を付ける。
   * すべてのファイルが同じ階層にあるときや、共通接頭辞を落として何も残らないときは空文字列。
   */
  dir: string;
  /** そのディレクトリ直下のファイル名。並びは最初に変更した順。 */
  files: string[];
}

export interface ProgressSummary {
  turnCount: number;
  /** セッション全体で変更したファイル。重複は除く。 */
  editedFiles: string[];
  /**
   * `editedFiles` をディレクトリでまとめたもの（issue #749）。平坦な一覧のままだと、
   * 長いセッションでどのあたりを触っているのかが読み取れないため。
   * 数え方を変えずに済むよう、`editedFiles` はそのまま残してある。
   */
  editedFileGroups: EditedFileGroup[];
  commandCount: number;
  /** 現在のTODOの件数。 */
  todoTotal: number;
  /** そのうち完了している件数。 */
  todoCompleted: number;
  /** 応答中か。 */
  busy: boolean;
}

export interface ProgressView {
  summary: ProgressSummary;
  /** 現在のTODO一覧。Codexのセッションでは常に空。 */
  checklist: TodoItem[];
  turns: ProgressTurn[];
}

/** `TodoItem.status` のうち、完了を表す値（CLIの語彙。実測で確認）。 */
const STATUS_COMPLETED = 'completed';
/** `TodoItem.status` のうち、着手中を表す値。 */
const STATUS_IN_PROGRESS = 'in_progress';

export function buildProgress(state: ChatState): ProgressView {
  const turns = buildTurns(state.items);
  applyTodoChanges(turns, state.todoHistory);
  return {
    summary: buildSummary(state, turns),
    checklist: state.todos,
    turns,
  };
}

function buildSummary(state: ChatState, turns: readonly ProgressTurn[]): ProgressSummary {
  const editedFiles: string[] = [];
  let commandCount = 0;
  for (const turn of turns) {
    commandCount += turn.commands.length;
    for (const file of turn.editedFiles) {
      if (!editedFiles.includes(file)) {
        editedFiles.push(file);
      }
    }
  }
  return {
    turnCount: turns.length,
    editedFiles,
    editedFileGroups: groupEditedFiles(editedFiles),
    commandCount,
    todoTotal: state.todos.length,
    todoCompleted: state.todos.filter((todo) => todo.status === STATUS_COMPLETED).length,
    busy: state.busy,
  };
}

/** パスをディレクトリ部分（末尾の `/` 込み）とファイル名へ分ける。 */
function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/**
 * すべてのパスに共通するディレクトリの接頭辞を返す（末尾の `/` 込み。無ければ空文字列）。
 *
 * 文字単位ではなくセグメント単位で比べる。文字で比べると `src/view/a` と `src/viewer/b`
 * から `src/view` が共通だと出てしまい、落とすと `er/b` のような読めないパスが残る。
 */
function commonDirPrefix(paths: readonly string[]): string {
  const first = paths[0];
  if (paths.length < 2 || first === undefined) {
    return '';
  }
  let segments = splitPath(first).dir.split('/');
  for (const path of paths.slice(1)) {
    const other = splitPath(path).dir.split('/');
    const next: string[] = [];
    for (let i = 0; i < Math.min(segments.length, other.length); i += 1) {
      if (segments[i] !== other[i]) {
        break;
      }
      next.push(other[i] as string);
    }
    segments = next;
  }
  const prefix = segments.join('/');
  return prefix === '' ? '' : prefix + (prefix.endsWith('/') ? '' : '/');
}

/**
 * 変更したファイルをディレクトリでまとめる（issue #749）。
 *
 * 共通の接頭辞（ワークスペースのルートなど）は落とす。`cwd` を使わないのは、
 * `ChatState` の `cwd` とエージェントが報告するパスの基準が一致する保証が無いため
 * （相対パスで届くこともある）。実際に届いたパスだけから決めれば取り違えが起きない。
 *
 * 並びは最初に変更した順を保つ。名前順にすると、直近で触ったものが上に来なくなる。
 */
export function groupEditedFiles(paths: readonly string[]): EditedFileGroup[] {
  const prefix = commonDirPrefix(paths);
  const groups: EditedFileGroup[] = [];
  const byDir = new Map<string, EditedFileGroup>();
  for (const path of paths) {
    const { dir, name } = splitPath(path.startsWith(prefix) ? path.slice(prefix.length) : path);
    const found = byDir.get(dir);
    if (found === undefined) {
      const group: EditedFileGroup = { dir, files: [name] };
      byDir.set(dir, group);
      groups.push(group);
    } else {
      found.files.push(name);
    }
  }
  return groups;
}

/**
 * 会話項目をターンへまとめる。
 *
 * ユーザーの発言より前に来た項目（復元直後のシステム通知など）は、最初のターンへ入れる。
 * 捨てると「実行したはずのコマンドが画面に出ない」ことになるため、行き場が無くても残す。
 */
function buildTurns(items: readonly ChatItem[]): ProgressTurn[] {
  const turns: ProgressTurn[] = [];
  let current: ProgressTurn | undefined;

  for (const item of items) {
    if (item.kind === 'userMessage') {
      current = emptyTurn(turns.length);
      current.instruction = clip(item.text, INSTRUCTION_PREVIEW_CHARS);
      turns.push(current);
      continue;
    }
    if (current === undefined) {
      current = emptyTurn(0);
      turns.push(current);
    }
    absorb(current, item);
  }

  return turns;
}

function emptyTurn(index: number): ProgressTurn {
  return {
    index,
    instruction: '',
    response: '',
    editedFiles: [],
    fileEditCounts: {},
    commands: [],
    todoChanges: [],
  };
}

function absorb(turn: ProgressTurn, item: ChatItem): void {
  if (item.kind === 'agentMessage') {
    const text = clip(item.text, RESPONSE_PREVIEW_CHARS);
    if (text !== '') {
      // そのターンの最後の応答を出す（途中の相槌より、いま到達している地点を見たいため）
      turn.response = text;
    }
    return;
  }
  if (item.kind === 'commandExecution') {
    const command = item.detail.trim();
    if (command !== '') {
      turn.commands.push(command);
    }
    return;
  }
  for (const diff of item.diffs) {
    if (diff.path === '') {
      continue;
    }
    if (!turn.editedFiles.includes(diff.path)) {
      turn.editedFiles.push(diff.path);
    }
    turn.fileEditCounts[diff.path] = (turn.fileEditCounts[diff.path] ?? 0) + 1;
  }
}

/**
 * TODOの履歴を、スナップショット同士の差としてターンへ配る。
 *
 * 履歴の `turnIndex` が範囲外のとき（項目が切り詰められた後の状態を読んだ場合など）は
 * 最後のターンへ寄せる。捨てると完了したはずのTODOが画面から消える。
 */
function applyTodoChanges(turns: ProgressTurn[], history: readonly TodoSnapshot[]): void {
  if (turns.length === 0) {
    return;
  }
  let previous: readonly TodoItem[] = [];
  for (const snapshot of history) {
    const changes = diffTodos(previous, snapshot.todos);
    previous = snapshot.todos;
    if (changes.length === 0) {
      continue;
    }
    const index = Math.min(Math.max(snapshot.turnIndex, 0), turns.length - 1);
    const turn = turns[index];
    if (turn === undefined) {
      continue;
    }
    for (const change of changes) {
      // 同じTODOが1ターンの中で何度も変わることがある（着手してすぐ完了する等）。
      // 途中経過を全部出すと読めなくなるので、最後の変化だけを残す
      const existing = turn.todoChanges.findIndex((c) => c.content === change.content);
      if (existing === -1) {
        turn.todoChanges.push(change);
      } else {
        turn.todoChanges[existing] = change;
      }
    }
  }
}

/**
 * TODO一覧2つの差を取る。同一性は本文（`content`）で見る（`TodoWrite` はidを持たない）。
 *
 * 本文が書き換わった場合は「消えて増えた」ものとして出る。CLIが本文を書き直すのは
 * 実際に別の作業へ差し替えたときなので、そのほうが実態に合う。
 */
export function diffTodos(before: readonly TodoItem[], after: readonly TodoItem[]): TodoChange[] {
  const changes: TodoChange[] = [];
  const beforeByContent = new Map(before.map((todo) => [todo.content, todo.status]));

  for (const todo of after) {
    const previousStatus = beforeByContent.get(todo.content);
    if (previousStatus === undefined) {
      changes.push({ content: todo.content, kind: 'added' });
      continue;
    }
    if (previousStatus === todo.status) {
      continue;
    }
    if (todo.status === STATUS_COMPLETED) {
      changes.push({ content: todo.content, kind: 'completed' });
      continue;
    }
    if (todo.status === STATUS_IN_PROGRESS) {
      changes.push({ content: todo.content, kind: 'started' });
    }
  }

  const afterContents = new Set(after.map((todo) => todo.content));
  for (const todo of before) {
    if (!afterContents.has(todo.content)) {
      changes.push({ content: todo.content, kind: 'removed' });
    }
  }

  return changes;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
