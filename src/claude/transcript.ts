import {
  currentTurnIndex,
  NO_SEARCH_RESULTS,
  NO_TODO_HISTORY,
  NO_TODOS,
  readWebSearchResults,
  type ChatItem,
  type EditReplace,
  type FileDiff,
  type TodoItem,
  type TodoSnapshot,
  type WebSearchResult,
} from '../appserver/chatState';
import { isSessionId } from '../codex/argvBuilder';
import { readAskUserQuestions, summarizeAskUserQuestions } from './askUserQuestion';
import type { TranscriptMeta } from './types';

/**
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` のパーサ。
 *
 * Claude Code の transcript は1行1イベントのJSONLで、ファイル名がそのまま
 * セッションidになる。壊れた行は個別に読み飛ばし、全体を捨てない。
 */

/** IDEやCLIが挿入する制御タグ。表示名に出ると邪魔なので落とす。 */
const CONTROL_BLOCK =
  /<(system-reminder|command-message|command-name|command-args|local-command-stdout|ide_selection|ide_opened_file)>[\s\S]*?<\/\1>/g;

const JSONL_SUFFIX = '.jsonl';

/**
 * cwd から `projects/` 直下のディレクトリ名を作る（Issue #885）。
 *
 * Claude Code は cwd の英数字以外をすべて `-` へ置換した名前を使う。
 * 手元の1,054ディレクトリで検証したところ、ディレクトリ名がこの規則と食い違うのは
 * 「worktreeで起動したためディレクトリ名はworktree側のパス由来だが、transcriptの
 * `cwd` は別パス」という50件だけで、「ディレクトリ名は対象ワークスペース外なのに
 * `cwd` はワークスペース内」に当たるものは無かった。つまり前方一致による絞り込みは
 * 安全側（取りこぼさない）に働く。確証ではないため、呼び出し側は絞り込みが空振り
 * したときに全走査へ退避する。
 */
export function transcriptDirSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function sessionIdFromTranscriptName(fileName: string): string | undefined {
  if (!fileName.endsWith(JSONL_SUFFIX)) {
    return undefined;
  }
  const id = fileName.slice(0, -JSONL_SUFFIX.length);
  return isSessionId(id) ? id : undefined;
}

/**
 * 先頭の数行からセッションの素性を組み立てる。
 *
 * 先頭行が必ずしも本文ではない（`queue-operation` などが挟まる）ため、
 * cwd と最初のユーザー発言が揃うまで読み進める。
 */
export function parseTranscriptHead(lines: readonly string[]): TranscriptMeta | undefined {
  const reader = createTranscriptHeadReader();
  for (const line of lines) {
    if (reader.push(line)) {
      break;
    }
  }
  return reader.result();
}

/** 1行ずつ食わせて素性を組み立てる読み手（Issue #885）。 */
export interface TranscriptHeadReader {
  /** 1行を取り込む。素性が揃って以降の行が要らなくなったら true を返す。 */
  push(line: string): boolean;
  /** それまでに取り込んだ内容から素性を返す。揃っていなければ undefined。 */
  result(): TranscriptMeta | undefined;
}

/**
 * `parseTranscriptHead` の増分版（Issue #885）。
 *
 * 一覧の構築ではファイルを開く回数と読むバイト数の両方が効くため、行を読みながら
 * 「もう十分か」を判定できる形を用意する。判定条件は `parseTranscriptHead` の
 * 打ち切り条件と同じで、両者の結果は一致する。
 */
export function createTranscriptHeadReader(): TranscriptHeadReader {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let gitBranch: string | undefined;
  let firstUserText: string | undefined;

  return {
    push(line: string): boolean {
      const entry = parseLine(line);
      if (entry === undefined) {
        return false;
      }

      sessionId ??= str(entry['sessionId']) || undefined;
      cwd ??= str(entry['cwd']) || undefined;
      startedAt ??= str(entry['timestamp']) || undefined;
      gitBranch ??= str(entry['gitBranch']) || undefined;

      if (firstUserText === undefined && isHumanMessage(entry)) {
        const text = cleanText(messageText(entry));
        if (text !== '') {
          firstUserText = text;
        }
      }

      return sessionId !== undefined && cwd !== undefined && firstUserText !== undefined;
    },
    result(): TranscriptMeta | undefined {
      if (sessionId === undefined || cwd === undefined) {
        return undefined;
      }
      return { sessionId, cwd, firstUserText, startedAt, gitBranch };
    },
  };
}

/** transcript / tool_use から読み取った結果。 */
export interface TranscriptItems {
  items: ChatItem[];
  /** 最後に呼ばれた TodoWrite の内容。使っていなければ空。 */
  todos: TodoItem[];
  /**
   * TodoWriteが呼ばれるたびの一覧（issue #721）。進捗画面のタイムラインに使う。
   * 使っていなければ空。
   */
  todoHistory: TodoSnapshot[];
}

/**
 * 会話全体を表示用の項目列にする。
 * Codexのチャット画面と同じ `ChatItem` へ寄せ、描画側を1本に保つ。
 *
 * TodoWriteは一覧をまるごと送ってくる（実測）。会話に項目としては積まず、
 * 最後に呼ばれた内容だけを `todos` として別に返す（専用表示の初期値に使う）。
 */
export function transcriptItems(lines: readonly string[]): TranscriptItems {
  const items: ChatItem[] = [];
  /** tool_use id → items上の位置。tool_result で結果を書き戻すため。 */
  const toolIndex = new Map<string, number>();
  let todos: TodoItem[] = NO_TODOS;
  let todoHistory: TodoSnapshot[] = NO_TODO_HISTORY;

  for (const line of lines) {
    const entry = parseLine(line);
    if (entry === undefined || entry['isSidechain'] === true) {
      continue;
    }

    const type = str(entry['type']);
    if (type === 'user') {
      appendUserEntry(entry, items, toolIndex);
      continue;
    }
    if (type === 'attachment') {
      appendInvokedSkills(entry, items);
      continue;
    }
    if (type === 'assistant') {
      const found = appendAssistantEntry(entry, items, toolIndex);
      if (found !== undefined) {
        todos = found;
        // 進捗画面のタイムライン用に、書き換わった時点の一覧を積む（issue #721）
        todoHistory = [...todoHistory, { todos: found, turnIndex: currentTurnIndex(items) }];
      }
    }
  }

  return { items, todos, todoHistory };
}

/**
 * `type: "attachment"` で届くSkill注入（`attachment.type === 'invoked_skills'`、issue #889）。
 *
 * 手元のtranscriptでは185件がこの形で、`type: "user"` の注入とは別枠で積まれる。
 * 表示は同じ `skillContext` に寄せ、1件のattachmentに複数skillが入る場合は
 * uuidに連番を足して別項目にする。
 */
function appendInvokedSkills(entry: Record<string, unknown>, items: ChatItem[]): void {
  const attachment = rec(entry['attachment']);
  if (attachment === undefined || str(attachment['type']) !== 'invoked_skills') {
    return;
  }
  const skills = Array.isArray(attachment['skills']) ? attachment['skills'] : [];
  skills.forEach((raw, index) => {
    const skill = rec(raw);
    if (skill === undefined) {
      return;
    }
    const text = cleanText(str(skill['content']));
    if (text === '') {
      return;
    }
    const name = str(skill['name']) || skillContextName(text);
    const uuid = str(entry['uuid']);
    items.push(
      item(entry, 'skillContext', {
        text,
        detail: name,
        id: index === 0 ? uuid : `${uuid}-${index}`,
      }),
    );
  });
}

function appendUserEntry(
  entry: Record<string, unknown>,
  items: ChatItem[],
  toolIndex: Map<string, number>,
): void {
  const content = messageContent(entry);
  const toolResultCount = content.filter((part) => str(part['type']) === 'tool_result').length;

  for (const part of content) {
    if (str(part['type']) !== 'tool_result') {
      continue;
    }
    const target = toolIndex.get(str(part['tool_use_id']));
    const existing = target === undefined ? undefined : items[target];
    if (target === undefined || existing === undefined) {
      continue;
    }
    items[target] = {
      ...existing,
      text: toolResultText(part['content']),
      status: part['is_error'] === true ? 'エラー' : 'completed',
      searchResults:
        existing.kind === 'webSearch'
          ? claudeSearchResults(entry['tool_use_result'], toolResultCount)
          : existing.searchResults,
    };
  }

  // Skill起動時にCLIが注入するSKILL.md全文（issue #691、判定はissue #889で拡張）。
  // 他の `isMeta: true`（`<local-command-caveat>`・cross-session-message等）と混同しない
  // よう `isSkillContextEntry` で絞り込み、streamJson.tsのapplyUserと同じ判定で
  // fold対象（`skillContext`）として積む。非表示にはしない
  if (entry['isMeta'] === true) {
    const skillText = cleanText(messageText(entry));
    if (skillText !== '' && isSkillContextEntry(entry, skillText)) {
      items.push(
        item(entry, 'skillContext', { text: skillText, detail: skillContextName(skillText) }),
      );
    }
    return;
  }

  if (!isHumanMessage(entry)) {
    return;
  }
  const text = cleanText(messageText(entry));
  if (text === '') {
    return;
  }
  items.push(item(entry, 'userMessage', { text }));
}

/** ツール名。会話には積まず、専用の一覧として別に持つ。 */
export const TODO_WRITE_TOOL = 'TodoWrite';

/**
 * @returns TodoWriteが見つかった場合はその内容。無ければ undefined
 *   （呼び出し側は undefined のとき todos を上書きしない）。
 */
function appendAssistantEntry(
  entry: Record<string, unknown>,
  items: ChatItem[],
  toolIndex: Map<string, number>,
): TodoItem[] | undefined {
  let todos: TodoItem[] | undefined;

  for (const part of messageContent(entry)) {
    const type = str(part['type']);
    if (type === 'text') {
      const text = cleanText(str(part['text']));
      if (text !== '') {
        items.push(item(entry, 'agentMessage', { text }));
      }
      continue;
    }
    if (type === 'thinking') {
      const text = cleanText(str(part['thinking']));
      if (text !== '') {
        items.push(item(entry, 'reasoning', { text }));
      }
      continue;
    }
    if (type === 'tool_use') {
      const name = str(part['name']);
      if (name === TODO_WRITE_TOOL) {
        todos = normalizeTodos(part['input']);
        continue;
      }
      const tool = describeTool(name, rec(part['input']) ?? {});
      items.push(
        item(entry, tool.kind, { detail: tool.detail, id: str(part['id']), diffs: tool.diffs }),
      );
      toolIndex.set(str(part['id']), items.length - 1);
    }
  }

  return todos;
}

/**
 * TodoWriteの `input` を専用一覧の形にする。実測した中身:
 * `{ todos: [{ content, status, activeForm }] }`。
 * `status` は `pending` / `in_progress` / `completed`（実測）。未知の値もそのまま持ち、
 * 表示側で言葉に直す（CLIの語彙が増えても行が消えないように）。
 *
 * 壊れた入力（配列でない・contentが空）は個別に読み飛ばす。全体を捨てない。
 */
export function normalizeTodos(input: unknown): TodoItem[] {
  const todos = rec(input)?.['todos'];
  if (!Array.isArray(todos)) {
    return NO_TODOS;
  }

  const result: TodoItem[] = [];
  for (const raw of todos) {
    const entry = rec(raw);
    const content = str(entry?.['content']).trim();
    if (content === '') {
      continue;
    }
    result.push({
      content,
      status: str(entry?.['status']) || 'pending',
      activeForm: str(entry?.['activeForm']) || content,
    });
  }
  return result;
}

/**
 * 差分に載せる行数の上限。
 *
 * ファイルを丸ごと書くツールがあるため、そのまま持つと状態が膨らむ。
 * 画面側の折りたたみとは別に、ここで持つ量そのものを抑える。
 */
const MAX_DIFF_LINES = 200;

/**
 * ツール呼び出しをCodex側の項目種別へ寄せる。描画側の分岐を増やさないため。
 *
 * Codexは差分をCLIが組み立てて通知に載せてくるが、Claude Codeはツールの入力しか
 * 来ない。ここで入力から差分の形へ組み直す。
 */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
): { kind: string; detail: string; diffs: FileDiff[] } {
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return { kind: 'commandExecution', detail: str(input['command']), diffs: [] };
    case 'Edit':
      return fileChange(input, editDiff(input), buildEditReplace(input));
    case 'Write':
      return fileChange(input, addedDiff(input, str(input['content'])));
    case 'NotebookEdit':
      return fileChange(input, addedDiff(input, str(input['new_source'])));
    case 'Read':
      return { kind: 'fileRead', detail: str(input['file_path']), diffs: [] };
    case 'WebSearch':
      return { kind: 'webSearch', detail: str(input['query']), diffs: [] };
    case 'WebFetch':
      return { kind: 'webSearch', detail: str(input['url']), diffs: [] };
    case 'AskUserQuestion':
      return { kind: 'askUserQuestion', detail: summarizeAskUserQuestion(input), diffs: [] };
    default:
      return { kind: 'mcpToolCall', detail: name, diffs: [] };
  }
}

/** 会話ログ（`kind: 'askUserQuestion'`）の一覧行に出す短い要約。 */
function summarizeAskUserQuestion(input: Record<string, unknown>): string {
  const questions = readAskUserQuestions(input['questions']);
  const summary = questions === undefined ? undefined : summarizeAskUserQuestions(questions);
  return summary ?? 'AskUserQuestion';
}

function fileChange(
  input: Record<string, unknown>,
  diff: string,
  editReplace: EditReplace | undefined = undefined,
): { kind: string; detail: string; diffs: FileDiff[] } {
  const path = str(input['file_path']) || str(input['notebook_path']);
  const kind = str(input['old_string']) === '' ? 'add' : 'update';
  return {
    kind: 'fileChange',
    detail: path,
    diffs:
      path === '' || diff === '' ? [] : [{ path, kind, movePath: undefined, diff, editReplace }],
  };
}

/** 置換の前後を差分にする。行番号は判らないためハンクの見出しは付けない。 */
function editDiff(input: Record<string, unknown>): string {
  const removed = prefixLines(str(input['old_string']), '-');
  const added = prefixLines(str(input['new_string']), '+');
  return [removed, added].filter((s) => s !== '').join('\n');
}

/**
 * Editツールの `old_string` / `new_string` を、切り詰め前の生の文字列のまま保持する
 * （issue #310）。`editDiff` が作る `diff` テキストは表示用に `MAX_DIFF_LINES` で
 * 切り詰められうるが、こちらは復元（`diffRestore.ts` の `reverseApplyEditReplace`）が
 * 現在のファイル内容から `new_string` を過不足なく検索するために使うので切り詰めない。
 * `old_string` が空（Editが実質新規追加として使われた場合、kindは`add`になる）のときは
 * `undefined` を返す。
 */
function buildEditReplace(input: Record<string, unknown>): EditReplace | undefined {
  const oldString = str(input['old_string']);
  if (oldString === '') {
    return undefined;
  }
  return { oldString, newString: str(input['new_string']) };
}

/** 新しく書いた内容を追加行として並べる。 */
function addedDiff(_input: Record<string, unknown>, content: string): string {
  return prefixLines(content, '+');
}

function prefixLines(text: string, marker: string): string {
  if (text === '') {
    return '';
  }
  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_DIFF_LINES).map((line) => `${marker}${line}`);
  if (lines.length > MAX_DIFF_LINES) {
    shown.push(`… 残り${lines.length - MAX_DIFF_LINES}行を省略`);
  }
  return shown.join('\n');
}

/** Skill起動時にCLIが注入する本文の書き出し（実測、issue #889）。 */
const SKILL_CONTEXT_PREFIX = 'Base directory for this skill:';

/**
 * 同じskillを2回目以降に起動したとき、CLIが本文の代わりに注入する注記（実測、issue #934）。
 * 本文と違って `Base directory for this skill:` で始まらないため、別に拾う。
 * 取り出し位置を揃えるため、skill名は必ず1番目のグループに置く。
 */
const SKILL_REINVOCATION_PATTERNS = [
  /^\(Re-invocation of \/(\S+) — /,
  /^Skill \/(\S+) was loaded earlier /,
  /^Skill \/(\S+) is already loaded above[;.]/,
];

/**
 * Skill注入の本文または再実行時の注記かどうか（issue #889、#934）。
 *
 * issue #691 では起動元Skillツールの `sourceToolUseID` の有無だけで判定していたが、
 * `/<skill名>` のようにslash commandから直接起動した場合は `sourceToolUseID` が付かない。
 * 手元の全transcript（613件の注入）では492件が `sourceToolUseID` 付き、85件が無しで、
 * 無しの側はCLIのバージョンに相関しなかった。書き出しの一文でも拾う。
 *
 * さらにissue #934で、セッション履歴（`~/.claude/projects/*.jsonl`）と動作中の
 * stream-jsonでフィールドが違うことが判った。前者には `isMeta: true` が付くが、後者は
 * `isSynthetic: true` だけで `isMeta` も `sourceToolUseID` も付かない（CLI 2.1.247で実測）。
 *
 * `isSynthetic` は割り込みの通知など他の合成メッセージにも付くため、そちらは
 * `sourceToolUseID` では通さず書き出しが合ったものだけを拾う。履歴側の判定は
 * issue #889 までと同じままにして、読み直したときの見え方を変えない。
 * ユーザー自身の発言にはどちらの目印も付かないので、手で同じ文面を書かない限り
 * 巻き込まない。
 */
export function isSkillContextEntry(entry: Record<string, unknown>, text: string): boolean {
  if (entry['isMeta'] === true) {
    return str(entry['sourceToolUseID']) !== '' || isSkillContextText(text);
  }
  return entry['isSynthetic'] === true && isSkillContextText(text);
}

/** 書き出しだけでSkill注入と判る文面か（本文・再実行時の注記の両方）。 */
function isSkillContextText(text: string): boolean {
  if (text.startsWith(SKILL_CONTEXT_PREFIX)) {
    return true;
  }
  return SKILL_REINVOCATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 注入本文の1行目 `Base directory for this skill: <path>` からskill名を取り出す。
 * 見出しに出して「どのskillが動いたか」だけは畳んだままでも判るようにする（issue #889）。
 * 再実行時の注記は本文が無いぶん見出しだけが手がかりになるので、そちらからも取る（issue #934）。
 */
export function skillContextName(text: string): string {
  const head = text.split('\n', 1)[0] ?? '';
  if (!head.startsWith(SKILL_CONTEXT_PREFIX)) {
    return reinvocationSkillName(head);
  }
  const path = head
    .slice(SKILL_CONTEXT_PREFIX.length)
    .trim()
    .replace(/[/\\]+$/, '');
  const name = path.split(/[/\\]/).pop() ?? '';
  return name;
}

/** 再実行時の注記からskill名を取り出す。合わなければ空文字。 */
function reinvocationSkillName(head: string): string {
  for (const pattern of SKILL_REINVOCATION_PATTERNS) {
    const name = pattern.exec(head)?.[1];
    if (name !== undefined) {
      return name;
    }
  }
  return '';
}

function item(
  entry: Record<string, unknown>,
  kind: string,
  overrides: { text?: string; detail?: string; id?: string; diffs?: FileDiff[] },
): ChatItem {
  return {
    id: overrides.id !== undefined && overrides.id !== '' ? overrides.id : str(entry['uuid']),
    kind,
    text: overrides.text ?? '',
    detail: overrides.detail ?? '',
    status: undefined,
    turnId: undefined,
    diffs: overrides.diffs ?? [],
    // tool_useの時点では結果が判らない。tool_resultが届いたときにappendUserEntryが埋める
    searchResults: NO_SEARCH_RESULTS,
  };
}

/**
 * Claude CodeのWebSearchツールの `tool_result` から検索結果を取り出す（issue #18）。
 *
 * APIのメッセージ本体（`content` の `tool_result` ブロック）には結果の構造情報が無い。
 * 実測（`claude --output-format stream-json` でWebSearchを伴うターンを実際に回して確認）
 * した `content` は自然文の1本の文字列で、`Links: [{"title":...,"url":...}, ...]` という
 * JSON断片がその中に埋め込まれているだけ。一方、CLIが同じJSONLの行・stream-jsonの
 * イベントに**別枠で**添える `tool_use_result.results[].content[]` のほうに、構造化された
 * `{title, url}` がそのまま入っている。自然文からの抜き出しよりこちらを使う。
 *
 * `WebFetch` の `tool_use_result` は形が違う（実測: `{bytes, code, codeText, result,
 * durationMs, url}` で `results` を持たない）ため、この関数は自然に空を返す
 * （従来どおりクエリ＝URLだけの表示に留まる）。
 *
 * `toolResultCount` は同じイベントに含まれる `tool_result` の総数。`tool_use_result` は
 * イベント単位でしか持てず、どの呼び出しの結果かをidで対応づける経路が無いため、
 * 2件以上並んでいるときは安全側に倒して何も返さない（実測では常に1件）。
 */
export function claudeSearchResults(
  toolUseResult: unknown,
  toolResultCount: number,
): WebSearchResult[] {
  if (toolResultCount !== 1) {
    return NO_SEARCH_RESULTS;
  }
  const root = rec(toolUseResult);
  const results = root?.['results'];
  if (!Array.isArray(results)) {
    return NO_SEARCH_RESULTS;
  }
  const flattened: unknown[] = [];
  for (const raw of results) {
    const resultEntry = rec(raw);
    const content = resultEntry?.['content'];
    if (Array.isArray(content)) {
      flattened.push(...content);
    }
  }
  return readWebSearchResults(flattened);
}

/**
 * 人の発言かどうか。
 * subagentの指示・ツール結果・システム挿入は表示名にも会話の起点にも使わない。
 */
function isHumanMessage(entry: Record<string, unknown>): boolean {
  if (str(entry['type']) !== 'user' || entry['isSidechain'] === true || entry['isMeta'] === true) {
    return false;
  }
  const userType = entry['userType'];
  if (userType !== undefined && userType !== 'external') {
    return false;
  }
  const origin = rec(entry['origin']);
  if (origin !== undefined && str(origin['kind']) !== 'human') {
    return false;
  }
  return messageContent(entry).some((part) => str(part['type']) === 'text');
}

function messageContent(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = rec(entry['message']);
  const content = message?.['content'];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((part) => rec(part) ?? {});
}

function messageText(entry: Record<string, unknown>): string {
  return messageContent(entry)
    .filter((part) => str(part['type']) === 'text')
    .map((part) => str(part['text']))
    .filter((text) => text !== '')
    .join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const p = rec(part);
      return p !== undefined && str(p['type']) === 'text' ? str(p['text']) : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

function cleanText(text: string): string {
  return text.replace(CONTROL_BLOCK, '').trim();
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    return rec(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
