import type {
  McActivity,
  McPendingItem,
  McPendingKind,
  McPromptField,
  McQuestion,
  McRepo,
  McResumeItem,
  McSession,
} from './protocol';

/**
 * Mission Control（Issue #2136）の画面の判断のうち、DOMに依らない部分。
 *
 * 単体テストから直接呼べるよう、DOMの型もPreactも使わない。
 */

export type McProviderFilter = 'all' | 'codex' | 'claude';

export interface McFilter {
  /** repoレールで選んだrepo。`undefined`はすべて。 */
  repoKey: string | undefined;
  provider: McProviderFilter;
  currentWindowOnly: boolean;
  /** `/`で入れる検索語。タイトル・要約・repo名に部分一致（大文字小文字は区別しない）。 */
  query: string;
  /** Railで選んだ状態（Issue #2138の6）。`undefined`はすべて。セッションだけを絞る。 */
  activity?: McActivity | undefined;
}

export const EMPTY_FILTER: McFilter = {
  repoKey: undefined,
  provider: 'all',
  currentWindowOnly: false,
  query: '',
  activity: undefined,
};

interface Filterable {
  provider: 'codex' | 'claude';
  isCurrentWindow: boolean;
  repoKey: string;
}

function matchesBase(item: Filterable, filter: McFilter): boolean {
  if (filter.repoKey !== undefined && item.repoKey !== filter.repoKey) {
    return false;
  }
  if (filter.provider !== 'all' && item.provider !== filter.provider) {
    return false;
  }
  return !filter.currentWindowOnly || item.isCurrentWindow;
}

function matchesQuery(fields: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  return fields.some((field) => field.toLowerCase().includes(q));
}

function repoLabelOf(repos: readonly McRepo[], key: string): string {
  return repos.find((repo) => repo.key === key)?.label ?? '';
}

/**
 * Inboxの絞り込み。task runの質問も会話の項目と同じ条件で絞る（段階1のlowで、統括ページの
 * task run欄だけ絞り込みが効かなかったのを繰り返さない）。
 */
export function filterPending(
  items: readonly McPendingItem[],
  repos: readonly McRepo[],
  filter: McFilter,
): McPendingItem[] {
  return items.filter(
    (item) =>
      matchesBase(item, filter) &&
      matchesQuery([item.title, item.summary, repoLabelOf(repos, item.repoKey)], filter.query),
  );
}

export function filterSessions(
  sessions: readonly McSession[],
  repos: readonly McRepo[],
  filter: McFilter,
): McSession[] {
  return sessions.filter(
    (session) =>
      matchesBase(session, filter) &&
      (filter.activity === undefined || session.activity === filter.activity) &&
      matchesQuery(
        [session.title, session.cwdLabel, repoLabelOf(repos, session.repoKey)],
        filter.query,
      ),
  );
}

/** 状態ごとのセッション数（Railの「状態」一覧用。状態以外の絞り込みは掛けて数える）。 */
export function countByActivity(
  sessions: readonly McSession[],
  repos: readonly McRepo[],
  filter: McFilter,
): Record<McActivity, number> {
  const counts: Record<McActivity, number> = {
    approvalPending: 0,
    handoffPending: 0,
    running: 0,
    backgroundRunning: 0,
    idle: 0,
  };
  for (const session of filterSessions(sessions, repos, { ...filter, activity: undefined })) {
    counts[session.activity] += 1;
  }
  return counts;
}

/**
 * 再開待ち（Issue #2138の4）の絞り込み。スナップショットはこのウィンドウの分だけなので
 * 「このウィンドウのみ」は常に満たす。状態の絞り込みは掛けない（セッションではないため）。
 */
export function filterResumable(
  items: readonly McResumeItem[],
  repos: readonly McRepo[],
  filter: McFilter,
): McResumeItem[] {
  return items.filter(
    (item) =>
      matchesBase({ ...item, isCurrentWindow: true }, filter) &&
      matchesQuery([item.title, item.cwdLabel, repoLabelOf(repos, item.repoKey)], filter.query),
  );
}

/** セッションをrepoごとにまとめる。repoの並びはレールと同じ（`repos`の順）。 */
export function groupSessionsByRepo(
  sessions: readonly McSession[],
  repos: readonly McRepo[],
): Array<{ repo: McRepo; sessions: McSession[] }> {
  const groups: Array<{ repo: McRepo; sessions: McSession[] }> = [];
  for (const repo of repos) {
    const inRepo = sessions.filter((session) => session.repoKey === repo.key);
    if (inRepo.length > 0) {
      groups.push({ repo, sessions: inRepo });
    }
  }
  return groups;
}

/** 経過時間を短く出す（「12秒」「3分」「2時間」「1日」）。 */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) {
    return `${String(sec)}秒`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${String(min)}分`;
  }
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    return `${String(hour)}時間`;
  }
  return `${String(Math.floor(hour / 24))}日`;
}

export const ACTIVITY_LABELS: Record<McActivity, string> = {
  approvalPending: '入力待ち',
  handoffPending: '引き継ぎ確認',
  running: '実行中',
  backgroundRunning: 'バックグラウンド実行中',
  idle: '待機',
};

export const PENDING_KIND_LABELS: Record<McPendingKind, string> = {
  toolApproval: 'ツール承認',
  askUserQuestion: '質問',
  codexPrompt: 'Codexの質問',
  workflowApproval: 'ワークフロー承認',
  taskRunQuestion: 'task runの質問',
  handoff: '引き継ぎ確認',
};

/** Inboxから直接答えられる種類か。それ以外はチャットタブで開いて答える。 */
export function isAnswerableInInbox(kind: McPendingKind): boolean {
  return (
    kind === 'toolApproval' ||
    kind === 'askUserQuestion' ||
    kind === 'codexPrompt' ||
    kind === 'taskRunQuestion' ||
    kind === 'handoff'
  );
}

/** 全文（`approvalDetail`）を取り寄せないと答えられない種類か。 */
export function needsApprovalDetail(kind: McPendingKind): boolean {
  return kind === 'toolApproval' || kind === 'askUserQuestion' || kind === 'codexPrompt';
}

/**
 * 選択肢1つ分の下書き。`selected`は選んだラベル（または値）、`other`は「その他」の入力。
 *
 * 単一選択では、選択肢と「その他」は片方しか持たない（`chooseOption`と`setOther`が
 * 互いを消す）。段階1のlowで、両方を入れると受信側に拒否されたのを画面側で起こさない。
 */
export interface ChoiceDraft {
  selected: string[];
  other: string;
}

export const EMPTY_DRAFT: ChoiceDraft = { selected: [], other: '' };

export function chooseOption(draft: ChoiceDraft, value: string, multiple: boolean): ChoiceDraft {
  if (!multiple) {
    return { selected: [value], other: '' };
  }
  const selected = draft.selected.includes(value)
    ? draft.selected.filter((v) => v !== value)
    : [...draft.selected, value];
  return { selected, other: draft.other };
}

export function setOther(draft: ChoiceDraft, other: string, multiple: boolean): ChoiceDraft {
  if (!multiple && other.trim() !== '') {
    return { selected: [], other };
  }
  return { selected: draft.selected, other };
}

function draftValues(draft: ChoiceDraft | undefined): string[] {
  if (draft === undefined) {
    return [];
  }
  const other = draft.other.trim();
  return other === '' ? [...draft.selected] : [...draft.selected, other];
}

/**
 * AskUserQuestionの回答を組み立てる。未回答の質問があれば理由の文を返す。
 * 受信側（`validateAskUserQuestionAnswers`）が通す形だけを作る。
 */
export function buildQuestionAnswers(
  questions: readonly McQuestion[],
  drafts: ReadonlyMap<number, ChoiceDraft>,
): Record<string, string[]> | string {
  const answers: Record<string, string[]> = {};
  for (const [index, q] of questions.entries()) {
    const values = draftValues(drafts.get(index));
    if (values.length === 0) {
      return `未回答の質問があります: ${q.header || q.question}`;
    }
    if (!q.multiSelect && values.length > 1) {
      return `1つだけ選ぶ質問です: ${q.header || q.question}`;
    }
    answers[q.question] = values;
  }
  return answers;
}

/** Codexの問い合わせの回答を組み立てる。必須の欄が空なら理由の文を返す。 */
export function buildPromptValues(
  fields: readonly McPromptField[],
  drafts: ReadonlyMap<number, ChoiceDraft>,
): Record<string, string[]> | string {
  const values: Record<string, string[]> = {};
  for (const [index, field] of fields.entries()) {
    const fieldValues = draftValues(drafts.get(index));
    if (field.required && fieldValues.length === 0) {
      return `必須の欄が空です: ${field.label || field.id}`;
    }
    if (!field.multiple && fieldValues.length > 1) {
      return `1つだけ選ぶ欄です: ${field.label || field.id}`;
    }
    values[field.id] = fieldValues;
  }
  return values;
}

/** キーボード操作（Issue #2136の5）。 */
export type McKeyCommand =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'detail' }
  | { kind: 'choose'; index: number }
  | { kind: 'approve' }
  | { kind: 'decline' }
  | { kind: 'reply' }
  | { kind: 'search' }
  | { kind: 'help' }
  | { kind: 'newSession' }
  | { kind: 'escape' };

export interface McKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** 入力欄にフォーカスがあるか。あるときは`Escape`以外を文字入力として通す。 */
  inEditable: boolean;
}

export function mapKey(input: McKeyInput): McKeyCommand | undefined {
  if (input.key === 'Escape') {
    return { kind: 'escape' };
  }
  if (input.inEditable || input.ctrlKey || input.metaKey || input.altKey) {
    return undefined;
  }
  switch (input.key) {
    case 'j':
    case 'ArrowDown':
      return { kind: 'next' };
    case 'k':
    case 'ArrowUp':
      return { kind: 'prev' };
    case 'Enter':
      return { kind: 'detail' };
    case 'a':
      return { kind: 'approve' };
    case 'd':
      return { kind: 'decline' };
    case 'r':
      return { kind: 'reply' };
    case '/':
      return { kind: 'search' };
    case '?':
      return { kind: 'help' };
    case 'n':
      return { kind: 'newSession' };
    default:
      break;
  }
  if (/^[1-9]$/u.test(input.key)) {
    return { kind: 'choose', index: Number(input.key) - 1 };
  }
  return undefined;
}

/** 一覧の選択を1つ動かす。選択が一覧に無ければ先頭（`delta < 0`なら末尾）へ。 */
export function moveSelection(
  ids: readonly string[],
  current: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (ids.length === 0) {
    return undefined;
  }
  const index = current === undefined ? -1 : ids.indexOf(current);
  if (index < 0) {
    return delta > 0 ? ids[0] : ids[ids.length - 1];
  }
  const next = Math.min(Math.max(index + delta, 0), ids.length - 1);
  return ids[next];
}

/**
 * スナップショットが変わったときの選択の扱い。
 *
 * 選択中の行が一覧に残っていればそのまま。消えた（回答済み・絞り込み）ら選択を外す。同じ位置の
 * 別の行へ移すと、遅れて押した`a` / `d` / 数字が別の項目への回答になる（段階2のレビュー）。
 * `autoSelect`（最初の表示。Reload前の選択が残っていないときを含む）の間だけ先頭を選ぶ。
 */
export function reconcileSelection(
  ids: readonly string[],
  current: string | undefined,
  autoSelect: boolean,
): string | undefined {
  if (current !== undefined && ids.includes(current)) {
    return current;
  }
  return autoSelect ? ids[0] : undefined;
}

/**
 * 停滞（Issue #2137の5）。実行中なのに、出力が`stallMs`以上動いていないセッション。
 * 出力の時刻を持たない（古い版のウィンドウの）セッションは判定しない。
 *
 * 起点は出力の時刻と実行中になった時刻の遅い方にする。出力の時刻だけだと、前のターンの
 * 出力から時間が経った会話で実行を始めた直後に停滞と出る（Issue #2138）。
 */
export function isStalled(
  session: Pick<McSession, 'activity' | 'lastOutputAt' | 'activitySince'>,
  now: number,
  stallMs: number,
): boolean {
  const since = stalledSince(session);
  return session.activity === 'running' && since !== undefined && now - since >= stallMs;
}

/** 停滞の起点（`isStalled`の説明を参照）。出力の時刻が無ければ`undefined`。 */
export function stalledSince(
  session: Pick<McSession, 'lastOutputAt' | 'activitySince'>,
): number | undefined {
  return session.lastOutputAt === undefined
    ? undefined
    : Math.max(session.lastOutputAt, session.activitySince);
}

/** 同じrepoで開いているセッションの数（新規起動でworktreeを既定ONにするかの判断）。 */
export function countSessionsInRepo(sessions: readonly McSession[], repoKey: string): number {
  return sessions.filter((session) => session.repoKey === repoKey).length;
}

/** 画面に出すキーの一覧（`?`）。 */
export const KEY_HELP: ReadonlyArray<[string, string]> = [
  ['j / k', '次 / 前の項目'],
  ['Enter', '詳細へ移る'],
  ['1〜9', '選択肢を選ぶ'],
  ['a', '承認 / 回答を送る'],
  ['d', '拒否'],
  ['r', '返信欄へ移る'],
  ['n', '新規セッション'],
  ['/', '検索'],
  ['?', 'この一覧'],
  ['Esc', '閉じる / 入力欄から出る'],
];
