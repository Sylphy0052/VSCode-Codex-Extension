import type {
  McActivity,
  McHistoryItem,
  McLifecycleOp,
  McLifecycleOutcome,
  McPendingItem,
  McPendingKind,
  McPromptField,
  McQuestion,
  McRepo,
  McResumeItem,
  McSession,
  McSkillUse,
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
        [
          session.title,
          session.cwdLabel,
          repoLabelOf(repos, session.repoKey),
          session.purpose ?? '',
        ],
        filter.query,
      ),
  );
}

/** 似た要約かどうかを見比べるための形。空白・記号の違いと大文字小文字を無視する。 */
function purposeFingerprint(purpose: string): string {
  return purpose.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * カードと詳細ペインに出す目的の1文（Issue #2172）を、セッションのkeyごとに返す。要約が無い
 * セッションは載せない。同じ（空白・記号を除いて一致する）要約が2件以上並ぶときは、
 * ブランチ名が分かるものに限って`（ブランチ名）`を添えて見分けられるようにする。
 */
export function purposeLabels(
  sessions: readonly Pick<McSession, 'key' | 'purpose' | 'branch'>[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.purpose !== undefined && session.purpose !== '') {
      const fp = purposeFingerprint(session.purpose);
      counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
  }
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const { purpose, branch } = session;
    if (purpose === undefined || purpose === '') {
      continue;
    }
    const similar = (counts.get(purposeFingerprint(purpose)) ?? 0) > 1;
    labels.set(
      session.key,
      similar && branch !== undefined && branch !== '' ? `${purpose}（${branch}）` : purpose,
    );
  }
  return labels;
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

/** カードに出すskillの件数（Issue #2173）。 */
export const CARD_SKILL_COUNT = 2;

/** カードに出す直近のskill名（新しい順。Issue #2173）。無ければ空配列。 */
export function recentSkillNames(
  skills: readonly McSkillUse[] | undefined,
  count: number = CARD_SKILL_COUNT,
): string[] {
  return (skills ?? [])
    .slice(-count)
    .map((skill) => skill.name)
    .reverse();
}

/**
 * skillを起動した時刻を短く出す（Issue #2173）。`now`と同じ日なら`HH:MM`、違えば`M/D HH:MM`。
 * 時刻はwebviewの地方時で出す。
 */
export function formatSkillTime(at: number, now: number): string {
  const time = new Date(at);
  const today = new Date(now);
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const sameDay =
    time.getFullYear() === today.getFullYear() &&
    time.getMonth() === today.getMonth() &&
    time.getDate() === today.getDate();
  return sameDay
    ? `${hh}:${mm}`
    : `${String(time.getMonth() + 1)}/${String(time.getDate())} ${hh}:${mm}`;
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

// キーの割り当ては`keys.ts`の表にまとめた（Issue #2152）。既存の呼び出し元のため再exportする
export { KEY_HELP, mapKey } from './keys';
export type { McKeyCommand, McKeyInput } from './keys';

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

/**
 * カードの見た目を決める状態（Issue #2151）。`activity`に、停滞（実行中で出力が止まった）を
 * 足したもの。色と形（アイコン・枠の線種）の両方をこれで選ぶ。
 */
export type McCardStatus = McActivity | 'stalled' | 'replyWait' | 'replyWaitLong';

/** 返事待ちを強調するまでの既定（`agent.missionControl.replyWaitMinutes`の既定30分）。 */
export const DEFAULT_REPLY_WAIT_MS = 30 * 60_000;

/**
 * 返事待ち（Issue #2171）。待機中の通常チャット。拡張のidleは実行中でも承認待ちでもない状態なので、
 * 中身（質問で終わったか等）は推測しない。オーケストレータ配下の子セッションと、引き継ぎ後に
 * 残った旧タブは人の返事を待っていないので除く。
 */
export function isReplyWaiting(
  session: Pick<McSession, 'activity' | 'taskManaged' | 'handoffKept'>,
): boolean {
  return (
    session.activity === 'idle' && session.taskManaged !== true && session.handoffKept !== true
  );
}

/** 返事待ちが`replyWaitMs`以上続いているか。起点は待機になった時刻（`activitySince`）。 */
export function isLongReplyWait(
  session: Pick<McSession, 'activity' | 'taskManaged' | 'handoffKept' | 'activitySince'>,
  now: number,
  replyWaitMs: number,
): boolean {
  return isReplyWaiting(session) && now - session.activitySince >= replyWaitMs;
}

export function cardStatus(
  session: Pick<
    McSession,
    'activity' | 'lastOutputAt' | 'activitySince' | 'taskManaged' | 'handoffKept'
  >,
  now: number,
  stallMs: number,
  replyWaitMs: number = DEFAULT_REPLY_WAIT_MS,
): McCardStatus {
  if (isStalled(session, now, stallMs)) {
    return 'stalled';
  }
  if (isReplyWaiting(session)) {
    return isLongReplyWait(session, now, replyWaitMs) ? 'replyWaitLong' : 'replyWait';
  }
  return session.activity;
}

/** 状態のピルの文言（名前だけ。経過時間は呼び出し側が添える）。 */
export function cardStatusLabel(status: McCardStatus): string {
  switch (status) {
    case 'stalled':
      return '停滞';
    case 'replyWait':
    case 'replyWaitLong':
      return '返事待ち';
    default:
      return ACTIVITY_LABELS[status];
  }
}

/** 未読の印を出すか（Issue #2171）。返事待ちのものだけ。 */
export function isUnreadReply(
  session: Pick<McSession, 'activity' | 'taskManaged' | 'handoffKept' | 'unread'>,
): boolean {
  return session.unread === true && isReplyWaiting(session);
}

/** 人の対応が要るか（入力待ち・引き継ぎ確認・待ち項目あり）。カードに印を付ける。 */
export function needsAttention(session: Pick<McSession, 'activity' | 'pendingCount'>): boolean {
  return (
    session.activity === 'approvalPending' ||
    session.activity === 'handoffPending' ||
    session.pendingCount > 0
  );
}

/** トークン数を短く出す（`1,234`・`12.3k`・`1.2M`）。 */
export function formatTokens(tokens: number): string {
  if (tokens < 10_000) {
    return Math.round(tokens).toLocaleString('en-US');
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** 推定費用（USD）を出す。1セント未満は`<$0.01`にする（0円に見せない）。 */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) {
    return '<$0.01';
  }
  return `$${usd.toFixed(2)}`;
}

/** 一覧の密度（Issue #2151の3）。 */
export type McDensity = 'comfortable' | 'compact';

/** 同じrepoで開いているセッションの数（新規起動でworktreeを既定ONにするかの判断）。 */
export function countSessionsInRepo(sessions: readonly McSession[], repoKey: string): number {
  return sessions.filter((session) => session.repoKey === repoKey).length;
}

/** 履歴の絞り込み（Issue #2149の3）。日付は`YYYY-MM-DD`（`<input type="date">`の値）。 */
export interface McHistoryFilter {
  query: string;
  /** `McHistoryItem.repoKey`。空ならすべて。 */
  repoKey: string;
  from: string;
  to: string;
}

export const EMPTY_HISTORY_FILTER: McHistoryFilter = { query: '', repoKey: '', from: '', to: '' };

/** `YYYY-MM-DD`をその日の0時（ローカル時刻、ms）にする。読めなければ`undefined`。 */
function parseDay(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * タイトル・repo・日付で絞り、新しい順に並べる。日付で絞るときは、更新時刻の分からない
 * （`updatedAt`が0の）項目を外す。
 */
export function filterHistory(
  items: readonly McHistoryItem[],
  filter: McHistoryFilter,
): McHistoryItem[] {
  const query = filter.query.trim().toLowerCase();
  const from = parseDay(filter.from);
  const toStart = parseDay(filter.to);
  const to = toStart === undefined ? undefined : toStart + DAY_MS;
  return items
    .filter((item) => {
      if (filter.repoKey !== '' && item.repoKey !== filter.repoKey) {
        return false;
      }
      if (
        query !== '' &&
        !item.title.toLowerCase().includes(query) &&
        !item.repoLabel.toLowerCase().includes(query)
      ) {
        return false;
      }
      if ((from !== undefined || to !== undefined) && item.updatedAt <= 0) {
        return false;
      }
      if (from !== undefined && item.updatedAt < from) {
        return false;
      }
      return to === undefined || item.updatedAt < to;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 履歴に出てくるrepo（絞り込みの候補）。ラベル順。 */
export function historyRepos(
  items: readonly McHistoryItem[],
): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!seen.has(item.repoKey)) {
      seen.set(item.repoKey, item.repoLabel);
    }
  }
  return [...seen]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** ライフサイクル操作の表示名。 */
export const LIFECYCLE_LABELS: Record<McLifecycleOp, string> = {
  close: '閉じる',
  archive: 'archive',
  delete: '削除',
};

/** ライフサイクル操作の結果をトースト用の1文にする。 */
export function summarizeLifecycle(
  op: McLifecycleOp,
  outcomes: readonly McLifecycleOutcome[],
): string {
  const ok = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o) => !o.ok);
  const label = LIFECYCLE_LABELS[op];
  if (failed.length === 0) {
    return `${String(ok)}件を${label}しました`;
  }
  const reason = failed[0]?.error ?? '理由不明';
  return ok === 0
    ? `${label}できませんでした: ${reason}`
    : `${String(ok)}件を${label}し、${String(failed.length)}件は失敗しました: ${reason}`;
}

/**
 * 複数選択（`x`）の印を、今の一覧に残っているものだけにする。変わらなければ同じSetを返す。
 */
export function pruneMarks(
  marks: ReadonlySet<string>,
  sessionKeys: readonly string[],
): ReadonlySet<string> {
  const alive = new Set(sessionKeys);
  const next = [...marks].filter((key) => alive.has(key));
  return next.length === marks.size ? marks : new Set(next);
}
