import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  PromptForm,
  QuestionForm,
  TaskRunForm,
  ToolApprovalForm,
  type FormKeysRef,
  type Submit,
} from './answerForms';
import type { Bridge, ReplyResult, ControlResult } from './bridge';
import {
  HandoffForm,
  ResumeDetail,
  ResumeRow,
  ReviewList,
  ReviewSection,
  SideQuestionForm,
} from './extras';
import { KindIcon, ProviderIcon, StatusIcon } from './icons';
import { IssueStartDialog, orderRuns, RunsPane } from './runs';
import { McHeader, PrefsDialog, SaveFilterDialog, UsageDialog } from './globalPanels';
import { UsageHistoryDialog } from './usageHistory';
import {
  activeSavedFilter,
  cycleSavedFilter,
  findSelectedTask,
  fromFilterSpec,
  taskOpBlockReason,
  toFilterSpec,
} from './globalLogic';
import {
  HistoryDialog,
  LaunchSettingsFields,
  LifecycleButtons,
  MarkBar,
  normalizeLaunchSettings,
} from './lifecycle';
import {
  ACTIVITY_LABELS,
  LIFECYCLE_LABELS,
  pruneMarks,
  summarizeLifecycle,
  countSessionsInRepo,
  EMPTY_FILTER,
  countByActivity,
  filterPending,
  filterResumable,
  filterSessions,
  formatElapsed,
  groupSessionsByRepo,
  cardStatus,
  cardStatusLabel,
  DEFAULT_REPLY_WAIT_MS,
  formatCost,
  formatTokens,
  isUnreadReply,
  needsAttention,
  stalledSince,
  KEY_HELP,
  moveSelection,
  needsApprovalDetail,
  PENDING_KIND_LABELS,
  purposeLabels,
  recentSkillNames,
  formatSkillTime,
  reconcileSelection,
  type McCardStatus,
  type McDensity,
  type McFilter,
  type McProviderFilter,
} from './logic';
import {
  activateAccessKey,
  refreshAccessKeys,
  scopeActions,
  scopeInputs,
  tabStaysInPane,
  submitAround,
  trapTab,
} from './accessKeys';
import {
  COMPOSER_KEY_HELP,
  KEY_BINDINGS,
  bindingDisplay,
  keyLabelFor,
  resolveKey,
  type McKeyCommand,
  type McSessionOp,
} from './keys';
import { Composer, type ComposerKeysRef } from './composer';
import { CommandPalette, type McPaletteEntry } from './palette';
import { SessionSettingsPanel } from './sessionSettings';
import { SessionOpDialog, type McSessionOpDialog } from './sessionOps';
import { MC_EXTENSION_COMMANDS } from './extensionCommands';
import { Conversation, type ConversationKeysRef, type TurnLogState } from './conversation';
import { hasOlderTurns, logFromPage, mergeTurnPage, TURN_PAGE_SIZE, type TurnLog } from './turnLog';
import type {
  McActivity,
  McApprovalDetail,
  McAttachment,
  McControlAction,
  McLaunchChoices,
  McLaunchRepo,
  McLaunchSettings,
  McLifecycleOp,
  McPendingItem,
  McProvider,
  McRepo,
  McRunOp,
  McRunTaskOp,
  McResumeItem,
  McSession,
  McSkillUse,
  McSnapshot,
  McTarget,
} from './protocol';

/** Reload後に戻す画面の状態（`vscode.setState`）。 */
interface PersistedState {
  filter: McFilter;
  selected: string | undefined;
  viewMode: 'list' | 'grid';
  tab: 'sessions' | 'runs';
  /** ボタン上にアクセスキーを出すか（Issue #2152の3。`.`で切り替える）。 */
  showAccessKeys: boolean;
  /** 一覧の密度（Issue #2151の3。`Shift+V`で切り替える）。 */
  density: McDensity;
}

/** フォーカスを置けるペイン（Issue #2152の2）。Runsタブは`list`がrunの画面。 */
type McPane = 'rail' | 'list' | 'detail';

/** 経過時間の表示を描き直す間隔。 */
const TICK_MS = 5_000;

/** セッションの項目にだけ効く操作。Runsタブでは何もしない（パレットにも出さない）。 */
const SESSION_ONLY_COMMANDS: ReadonlySet<McKeyCommand['kind']> = new Set([
  'approve',
  'decline',
  'choose',
  'reply',
  'toggleMark',
  'lifecycle',
  // 一覧 / カードはセッションの一覧だけの表示（Runsタブには効かない）
  'view',
  // 詳細ペインの会話（Issue #2157）
  'turnSearch',
  'turnMatch',
  'turnMatchPrev',
  'turnFolds',
  'turnOlder',
  // 指示欄の添付・送信キュー（Issue #2158）
  'attach',
  'queue',
  // 実行中セッションの設定（Issue #2159）
  'settings',
  'planMode',
  'fastMode',
  // 選んだセッションへの操作（Issue #2160）
  'sessionOp',
]);

const PROVIDER_FILTERS: ReadonlyArray<[McProviderFilter, string]> = [
  ['all', 'すべて'],
  ['codex', 'Codex'],
  ['claude', 'Claude'],
];

type Loadable<T> =
  { status: 'loading' } | { status: 'ok'; value: T } | { status: 'error'; error: string };

function targetKey(target: McTarget): string {
  return `${target.windowId}|${target.provider}|${target.threadId}`;
}

function pendingRowId(item: McPendingItem): string {
  return `p:${item.id}`;
}

function sessionRowId(session: McSession): string {
  return `s:${session.key}`;
}

function isActivity(value: unknown): value is McActivity {
  return typeof value === 'string' && Object.hasOwn(ACTIVITY_LABELS, value);
}

function resumeRowId(item: McResumeItem): string {
  return `r:${item.id}`;
}

function readPersisted(raw: unknown): PersistedState {
  const fallback: PersistedState = {
    filter: EMPTY_FILTER,
    selected: undefined,
    viewMode: 'list',
    tab: 'sessions',
    showAccessKeys: true,
    density: 'comfortable',
  };
  if (typeof raw !== 'object' || raw === null) {
    return fallback;
  }
  const v = raw as Partial<PersistedState>;
  const filter = v.filter;
  return {
    filter:
      typeof filter === 'object' && filter !== null
        ? {
            repoKey: typeof filter.repoKey === 'string' ? filter.repoKey : undefined,
            provider:
              filter.provider === 'codex' || filter.provider === 'claude' ? filter.provider : 'all',
            currentWindowOnly: filter.currentWindowOnly === true,
            query: typeof filter.query === 'string' ? filter.query : '',
            activity: isActivity(filter.activity) ? filter.activity : undefined,
          }
        : EMPTY_FILTER,
    selected: typeof v.selected === 'string' ? v.selected : undefined,
    viewMode: v.viewMode === 'grid' ? 'grid' : 'list',
    tab: v.tab === 'runs' ? 'runs' : 'sessions',
    showAccessKeys: v.showAccessKeys !== false,
    density: v.density === 'compact' ? 'compact' : 'comfortable',
  };
}

/**
 * 文字を打ち込まない`<input>`の種類。チェックボックスなどは英字を受け取らないので入力欄として
 * 扱わない。扱うと、アクセスキーで押した後にフォーカスが残り、次の英字が効かなくなる（Issue #2152）。
 * `radio`と`range`は矢印キーで値を変えるので、入力欄のまま扱う（←/→をペイン移動に取らない）。
 */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox',
  'button',
  'submit',
  'reset',
  'image',
  'file',
  'color',
]);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/** Enterで押される要素か（ボタン・リンク・`<summary>`）。 */
function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLAnchorElement ||
    (target instanceof HTMLElement && target.tagName === 'SUMMARY')
  );
}

/** 応答の`approvals`から、Inboxの項目に当たる1件を探す。 */
function findApproval(
  approvals: readonly McApprovalDetail[],
  item: McPendingItem,
): McApprovalDetail | undefined {
  return approvals.find(
    (a) =>
      a.requestId === item.requestId &&
      (item.kind === 'codexPrompt' ? a.kind === 'codexPrompt' : a.kind !== 'codexPrompt'),
  );
}

export function App(props: { bridge: Bridge }): JSX.Element {
  const { bridge } = props;
  const initial = useMemo(() => readPersisted(bridge.getState()), [bridge]);
  const [snapshot, setSnapshot] = useState<McSnapshot | undefined>(undefined);
  /** 拡張ホストの時計とwebviewの時計の差。経過時間を拡張ホストの時刻で数える。 */
  const [clockOffset, setClockOffset] = useState(0);
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState<McFilter>(initial.filter);
  const [selected, setSelected] = useState<string | undefined>(initial.selected);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(initial.viewMode);
  const [helpOpen, setHelpOpen] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, Loadable<McApprovalDetail[]>>>({});
  const [turns, setTurns] = useState<Record<string, TurnLogState>>({});
  /**
   * 会話を取り直した回数（宛先ごと）。古いやり取りの読み足しは始めた時の値を覚えておき、
   * その間に取り直していたら応答を捨てて続きも取らない（Issue #2157）。
   */
  const turnsGeneration = useRef(new Map<string, number>());
  /** 回答を送った項目。共有ファイルから消えるまで、Inboxで送信済みとして薄く出す。 */
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  /**
   * 回答が断られた理由（項目のid → 文）。失敗すると中身を取り寄せ直し、回答欄は作り直される
   * ため、理由は回答欄の外で持つ。
   */
  const [answerErrors, setAnswerErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [toast, setToast] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const formKeys: FormKeysRef = useRef(null);
  const conversationKeys: ConversationKeysRef = useRef(null);
  const composerKeys: ComposerKeysRef = useRef(null);
  /** 最初のスナップショットを受けるまでは先頭を自動で選ぶ。 */
  const autoSelect = useRef(true);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 名前変更・クリア・巻き戻しのダイアログ（Issue #2160）。対象は開いた時点のセッションに固定する
  const [opDialog, setOpDialog] = useState<
    { op: McSessionOpDialog; session: McSession } | undefined
  >(undefined);
  const [tab, setTab] = useState<'sessions' | 'runs'>(initial.tab);
  const [selectedRun, setSelectedRun] = useState<string | undefined>(undefined);
  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [issuesOpen, setIssuesOpen] = useState(false);
  // 費用・利用枠の詳細、MCの設定、絞り込みの保存（Issue #2162）
  const [usageOpen, setUsageOpen] = useState(false);
  /** 利用枠の推移グラフ（Issue #2176）。 */
  const [usageHistoryOpen, setUsageHistoryOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  /** 複数選択（`x`）したセッションの`McSession.key`（Issue #2149の1）。 */
  const [marks, setMarks] = useState<ReadonlySet<string>>(new Set());
  // Issue #2152: フォーカスのあるペイン・コマンドパレット・アクセスキーの表示
  const [paneFocus, setPaneFocus] = useState<McPane>('list');
  const [palette, setPalette] = useState<readonly McPaletteEntry[] | undefined>(undefined);
  const [showAccessKeys, setShowAccessKeys] = useState(initial.showAccessKeys);
  const [density, setDensity] = useState<McDensity>(initial.density);

  useEffect(() => {
    const off = bridge.onSnapshot((next) => {
      setClockOffset(next.now - Date.now());
      setSnapshot(next);
    });
    // 初回の一覧は`ready`に対して送られる（listenerを張る前に送られても届かないため）
    bridge.ready();
    return off;
  }, [bridge]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    bridge.setState({
      filter,
      selected,
      viewMode,
      tab,
      showAccessKeys,
      density,
    } satisfies PersistedState);
  }, [bridge, filter, selected, viewMode, tab, showAccessKeys, density]);

  useEffect(() => {
    if (toast === '') {
      return undefined;
    }
    const timer = setTimeout(() => setToast(''), 3_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const repos = snapshot?.repos ?? [];
  const pending = useMemo(
    () => filterPending(snapshot?.pending ?? [], repos, filter),
    [snapshot, repos, filter],
  );
  const sessions = useMemo(
    () => filterSessions(snapshot?.sessions ?? [], repos, filter),
    [snapshot, repos, filter],
  );
  const groups = useMemo(() => groupSessionsByRepo(sessions, repos), [sessions, repos]);
  // Issue #2172: 目的の1文要約。似た要約は一覧全体で見比べてブランチ名を添える
  const purposes = useMemo(() => purposeLabels(snapshot?.sessions ?? []), [snapshot]);
  // Issue #2138: 再開待ちとレビュー待ち
  const resumable = useMemo(
    () => filterResumable(snapshot?.resumable ?? [], repos, filter),
    [snapshot, repos, filter],
  );
  const reviewSessions = useMemo(() => sessions.filter((s) => s.review !== undefined), [sessions]);
  const rowIds = useMemo(
    () => [
      ...pending.map(pendingRowId),
      ...resumable.map(resumeRowId),
      ...groups.flatMap((g) => g.sessions.map(sessionRowId)),
    ],
    [pending, resumable, groups],
  );

  // 選択中の行が消えた（回答済み・絞り込み）ら選択を外す。同じ位置の別の行へ移すと、遅れて
  // 押した回答キーが別の項目へ届く。先頭を選ぶのは最初のスナップショットのときだけ
  useEffect(() => {
    if (snapshot === undefined) {
      return;
    }
    const next = reconcileSelection(rowIds, selected, autoSelect.current);
    autoSelect.current = false;
    if (next !== selected) {
      setSelected(next);
    }
  }, [snapshot, rowIds, selected]);

  // 複数選択は、一覧に見えているセッションだけに保つ（絞り込みで隠れたものへ操作が届かない）
  useEffect(() => {
    setMarks((prev) =>
      pruneMarks(
        prev,
        sessions.map((s) => s.key),
      ),
    );
  }, [sessions]);

  const selectedPending = pending.find((item) => pendingRowId(item) === selected);
  const selectedResume = resumable.find((item) => resumeRowId(item) === selected);
  const selectedSession =
    selectedPending === undefined
      ? sessions.find((session) => sessionRowId(session) === selected)
      : undefined;
  const detailTarget: McTarget | undefined =
    selectedPending !== undefined
      ? selectedPending.kind === 'taskRunQuestion'
        ? undefined
        : selectedPending
      : selectedSession;
  const sessionOf = (target: McTarget): McSession | undefined =>
    snapshot?.sessions.find(
      (s) =>
        s.windowId === target.windowId &&
        s.provider === target.provider &&
        s.threadId === target.threadId,
    );

  const loadApprovals = (target: McTarget): void => {
    const key = targetKey(target);
    setApprovals((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    void bridge.request(target, { action: 'approvalDetail' }).then((result) => {
      setApprovals((prev) => ({
        ...prev,
        [key]: result.ok
          ? { status: 'ok', value: result.approvals ?? [] }
          : { status: 'error', error: result.error ?? '中身を取り寄せられませんでした' },
      }));
    });
  };
  const loadTurns = (target: McTarget): void => {
    const key = targetKey(target);
    turnsGeneration.current.set(key, (turnsGeneration.current.get(key) ?? 0) + 1);
    setTurns((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    void bridge.request(target, { action: 'recentTurns', limit: TURN_PAGE_SIZE }).then((result) => {
      setTurns((prev) => ({
        ...prev,
        [key]: result.ok
          ? {
              status: 'ok',
              value: logFromPage({
                turns: result.turns ?? [],
                start: result.turnStart,
                total: result.turnTotal,
              }),
            }
          : { status: 'error', error: result.error ?? 'やり取りを取り寄せられませんでした' },
      }));
    });
  };
  /**
   * 古いやり取りを読み足す（Issue #2157）。`all`なら会話の先頭まで続けて取る（検索のとき）。
   * 次の位置は応答の`turnStart`から決めるので、途中で状態を読み直さない。
   */
  const loadOlderTurns = (target: McTarget, all: boolean): void => {
    const key = targetKey(target);
    const now = turns[key];
    if (now?.status !== 'ok' || now.value.olderLoading || !hasOlderTurns(now.value)) {
      return;
    }
    const setOlder = (update: (log: TurnLog) => TurnLog): void => {
      setTurns((prev) => {
        const entry = prev[key];
        return entry?.status === 'ok'
          ? { ...prev, [key]: { status: 'ok', value: update(entry.value) } }
          : prev;
      });
    };
    setOlder((log) => ({ ...log, olderLoading: true, olderError: undefined }));
    const generation = turnsGeneration.current.get(key);
    const fetchBefore = (before: number): void => {
      void bridge
        .request(target, { action: 'recentTurns', limit: TURN_PAGE_SIZE, before })
        .then((result) => {
          // 読み足しの間に取り直した（再読込・選び直し）なら、古い位置の応答を新しいログへ混ぜない
          if (turnsGeneration.current.get(key) !== generation) {
            return;
          }
          if (!result.ok) {
            setOlder((log) => ({
              ...log,
              olderLoading: false,
              olderError: result.error ?? '古いやり取りを取り寄せられませんでした',
            }));
            return;
          }
          const page = {
            turns: result.turns ?? [],
            start: result.turnStart,
            total: result.turnTotal,
          };
          // 範囲を返さない相手（古い版）や、進まない応答では止める（同じ位置を取り続けない）
          const next = page.start !== undefined && page.start < before ? page.start : undefined;
          const more = all && next !== undefined && next > 0;
          setOlder((log) => ({ ...mergeTurnPage(log, page), olderLoading: more }));
          if (more) {
            fetchBefore(next);
          }
        });
    };
    fetchBefore(now.value.start ?? 0);
  };

  const conversationFor = (target: McTarget): JSX.Element => (
    <Conversation
      key={targetKey(target)}
      log={turns[targetKey(target)]}
      keysRef={conversationKeys}
      onReload={() => loadTurns(target)}
      onLoadOlder={() => loadOlderTurns(target, false)}
      onLoadAll={() => loadOlderTurns(target, true)}
    />
  );

  // 選んだ項目の全文と直近のやり取りを取り寄せる。回答には全文の取り寄せが先に要る
  // （拡張ホストは中身を見せていない要求への回答を断る。Issue #1259）
  const selectedPendingId = selectedPending?.id;
  const needsDetail = selectedPending !== undefined && needsApprovalDetail(selectedPending.kind);
  const detailKey = detailTarget === undefined ? undefined : targetKey(detailTarget);
  useEffect(() => {
    if (detailTarget === undefined) {
      return;
    }
    if (needsDetail) {
      loadApprovals(detailTarget);
    }
    loadTurns(detailTarget);
    // 選択が変わったときだけ取り寄せ直す
  }, [selectedPendingId, detailKey]);

  // ライブtail（Issue #2137の3）。詳細で選んでいるセッションを拡張ホストへ伝え、届いた
  // やり取りで差し替える。取り直しの間隔・止めどきは拡張ホストが持つ。
  // 詳細ペインはSessionsタブにしか無い。Runsタブの間も伝えたままだと、拡張ホストは表示中と
  // みなして返事待ちを既読にしてしまう（Issue #2171）ので、Sessionsタブの間だけ伝える
  const watchTarget = tab === 'sessions' ? detailTarget : undefined;
  const watchKey = watchTarget === undefined ? undefined : targetKey(watchTarget);
  useEffect(() => {
    bridge.watch(watchTarget);
  }, [watchKey]);
  useEffect(() => {
    const off = bridge.onLiveTurns((live) => {
      const key = targetKey(live.target);
      setTurns((prev) => {
        if (live.ok) {
          // 読み足した古いやり取りは残し、届いた末尾の範囲だけを差し替える（Issue #2157）
          const entry = prev[key];
          const page = { turns: live.turns ?? [], start: live.turnStart, total: live.turnTotal };
          return {
            ...prev,
            [key]: {
              status: 'ok',
              value: mergeTurnPage(entry?.status === 'ok' ? entry.value : undefined, page),
            },
          };
        }
        // 一時的な失敗では、取れていたやり取りを消さない
        return prev[key]?.status === 'ok'
          ? prev
          : {
              ...prev,
              [key]: { status: 'error', error: live.error ?? 'やり取りを取り寄せられませんでした' },
            };
      });
    });
    return () => {
      off();
      bridge.watch(undefined);
    };
  }, [bridge]);

  const submitFor =
    (item: McPendingItem): Submit =>
    async (action: McControlAction) => {
      setAnswerError(item.id, undefined);
      const result: ControlResult = await bridge.request(item, action);
      if (result.ok) {
        setSent((prev) => new Set(prev).add(item.id));
        setToast('回答を送りました');
        return undefined;
      }
      const failure = result.error ?? '回答を送れませんでした';
      // 取り寄せた中身は1回の回答で使い切る。失敗したら取り寄せ直して答え直せるようにする。
      // 回答欄は作り直されて理由を持てないため、理由は詳細ペインの側で出す
      if (needsApprovalDetail(item.kind)) {
        setAnswerError(item.id, failure);
        loadApprovals(item);
        return undefined;
      }
      return failure;
    };

  const setAnswerError = (id: string, message: string | undefined): void => {
    setAnswerErrors((prev) => {
      if (message === undefined && !prev.has(id)) {
        return prev;
      }
      const next = new Map(prev);
      if (message === undefined) {
        next.delete(id);
      } else {
        next.set(id, message);
      }
      return next;
    });
  };

  const sessionAction = (session: McSession, action: McControlAction, done: string): void => {
    void bridge.request(session, action).then((result) => {
      setToast(result.ok ? done : (result.error ?? '操作に失敗しました'));
    });
  };

  /** composerからの指示（Issue #2137の4）。失敗の理由は呼び出し側（composer）で出す。 */
  const sendTo = async (
    session: McSession,
    text: string,
    attachments: readonly McAttachment[],
  ): Promise<string | undefined> => {
    // 画像があるときは別の種別で送る（古い版のウィンドウが画像を落として送らないように。Issue #2158）
    const result = await bridge.request(
      session,
      attachments.length === 0
        ? { action: 'send', text }
        : { action: 'sendWithAttachments', text, attachments: [...attachments] },
    );
    if (!result.ok) {
      return result.error ?? '指示を送れませんでした';
    }
    setToast(
      attachments.length === 0
        ? '指示を送りました'
        : `画像${String(attachments.length)}枚を添えて指示を送りました`,
    );
    return undefined;
  };

  // Issue #2149の1: 操作の対象は、複数選択があればそれ、無ければ選択中の行のセッション
  // （Inboxの項目なら、その会話）。task runの質問は会話ではないので対象にしない
  const focusedSession: McSession | undefined =
    selectedSession ??
    (selectedPending !== undefined && selectedPending.kind !== 'taskRunQuestion'
      ? sessionOf(selectedPending)
      : undefined);
  const lifecycleTargets = (): McSession[] =>
    marks.size > 0
      ? sessions.filter((s) => marks.has(s.key))
      : focusedSession === undefined
        ? []
        : [focusedSession];
  const runLifecycle = (
    op: McLifecycleOp,
    targets: readonly McSession[] = lifecycleTargets(),
  ): void => {
    if (targets.length === 0) {
      setToast(`${LIFECYCLE_LABELS[op]}セッションを選んでください（j / kで移動、xで複数選択）`);
      return;
    }
    // 確認（deleteと実行中の終了）は拡張ホストがモーダルで出す
    void bridge.lifecycle(op, targets).then((result) => {
      if (!result.ok) {
        setToast(result.error ?? `${LIFECYCLE_LABELS[op]}できませんでした`);
        return;
      }
      setToast(summarizeLifecycle(op, result.outcomes ?? []));
      // 成功した分だけ複数選択から外す（失敗した分は選んだまま残して再試行できるようにする）
      const done = new Set(
        (result.outcomes ?? []).filter((o) => o.ok).map((o) => targetKey(o.target)),
      );
      setMarks((prev) => {
        const next = new Set(
          [...prev].filter((key) => {
            const s = sessions.find((x) => x.key === key);
            return s === undefined || !done.has(targetKey(s));
          }),
        );
        return next.size === prev.size ? prev : next;
      });
    });
  };
  // Issue #2160: 選んだ1つのセッションへの操作。複数選択には効かせない（clear・巻き戻しを
  // まとめて行わないように）。名前変更・クリア・巻き戻しはダイアログで入力・確認してから送る
  const runSessionOp = (op: McSessionOp): void => {
    const session = focusedSession;
    if (session === undefined) {
      setToast('操作するセッションを選んでください（j / kで移動）');
      return;
    }
    switch (op) {
      case 'rename':
      case 'clear':
        setOpDialog({ op, session });
        return;
      case 'rewind':
        if (session.provider !== 'claude') {
          setToast('巻き戻せるのはClaudeのセッションだけです');
          return;
        }
        setOpDialog({ op, session });
        return;
      case 'fork':
        sessionAction(session, { action: 'fork' }, `「${session.title}」を分岐しました`);
        return;
      case 'pin':
        sessionAction(
          session,
          { action: session.pinned === true ? 'unpin' : 'pin' },
          session.pinned === true
            ? `「${session.title}」のピン留めを外しました`
            : `「${session.title}」をピン留めしました`,
        );
        return;
      case 'handoff':
        sessionAction(session, { action: 'handoff' }, `「${session.title}」の引き継ぎを始めました`);
        return;
    }
  };
  const toggleMark = (session: McSession | undefined): void => {
    if (session === undefined) {
      setToast('複数選択できるのはセッションの行です');
      return;
    }
    setMarks((prev) => {
      const next = new Set(prev);
      if (next.has(session.key)) {
        next.delete(session.key);
      } else {
        next.add(session.key);
      }
      return next;
    });
  };

  // Runsタブ（Issue #2150）
  const runsSnap = snapshot?.runs;
  const orderedRuns = useMemo(() => orderRuns(runsSnap?.runs ?? []), [runsSnap]);
  const runIds = orderedRuns.map((r) => r.runId);
  const effectiveRun = orderedRuns.find((r) => r.runId === selectedRun) ?? orderedRuns[0];
  const runAction = (op: McRunOp): void => {
    if (effectiveRun === undefined) {
      setToast('runを選んでください');
      return;
    }
    const sent: McRunOp = op === 'pause' && effectiveRun.halted ? 'unpause' : op;
    void bridge.runOp(sent, effectiveRun.runId).then(reportRunResult);
  };
  const reportRunResult = (result: ReplyResult): void => {
    if (!result.ok) {
      setToast(result.error ?? '操作に失敗しました');
    } else if (result.message !== undefined && result.message !== '') {
      setToast(result.message);
    }
  };
  const runParallel = (delta: 1 | -1): void => {
    if (effectiveRun === undefined || runsSnap === undefined) {
      setToast('runを選んでください');
      return;
    }
    const next = Math.min(Math.max(effectiveRun.maxParallel + delta, 1), runsSnap.maxParallelLimit);
    void bridge.runParallel(effectiveRun.runId, next).then(reportRunResult);
  };
  const runStart = (): void => {
    void bridge.runStart().then(reportRunResult);
  };
  // runのタスク単位の操作（Issue #2162）。選んだタスクが今のrunに無ければ選んでいない扱いにし、
  // runが変わったら選択を解く（別のrunの同じidのタスクへ操作が飛ばないように）
  const runTasks = effectiveRun?.tasks ?? [];
  const effectiveTask = findSelectedTask(runTasks, selectedTask);
  const effectiveRunId = effectiveRun?.runId;
  useEffect(() => {
    setSelectedTask(undefined);
  }, [effectiveRunId]);
  const moveTask = (delta: 1 | -1): void => {
    const next = moveSelection(
      runTasks.map((t) => t.taskId),
      effectiveTask?.taskId,
      delta,
    );
    setSelectedTask(next);
    if (next !== undefined) {
      document
        .querySelector(`[data-task="${CSS.escape(next)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  };
  const runTaskOp = (op: McRunTaskOp, taskId: string | undefined = effectiveTask?.taskId): void => {
    const blocked =
      effectiveRun === undefined ? 'runを選んでください' : taskOpBlockReason(runTasks, taskId, op);
    if (effectiveRun === undefined || taskId === undefined || blocked !== undefined) {
      setToast(blocked ?? 'タスクを選んでください（Shift+J / Shift+K）');
      return;
    }
    setSelectedTask(taskId);
    // 確認（やり直し・停止とも）は拡張ホストのモーダルで出す。ホストもidが今のrunにあるかを確かめる
    void bridge.runTaskOp(op, effectiveRun.runId, taskId).then(reportRunResult);
  };
  // 保存した絞り込み（Issue #2162）
  const savedFilters = snapshot?.savedFilters ?? [];
  const switchSavedFilter = (delta: 1 | -1): void => {
    const next = cycleSavedFilter(savedFilters, filter, delta);
    if (next === undefined) {
      setToast('保存した絞り込みはありません（Shift+Wで保存）');
      return;
    }
    setFilter(fromFilterSpec(next.filter));
    setToast(`絞り込み「${next.name}」`);
  };
  const deleteSavedFilter = (): void => {
    const active = activeSavedFilter(savedFilters, filter);
    if (active === undefined) {
      setToast('削除する保存した絞り込みを ] / [ で選んでください');
      return;
    }
    void bridge.deleteFilter(active.name).then((result) => {
      setToast(
        result.ok
          ? `絞り込み「${active.name}」を削除しました`
          : (result.error ?? '削除に失敗しました'),
      );
    });
  };
  const reloadWindow = (): void => {
    void bridge.reloadWindow().then((result) => {
      if (!result.ok) {
        setToast(result.error ?? 'Reloadを取りやめました');
      }
    });
  };

  // フォーカスを置けるペイン（Issue #2152の2）。Runsタブは詳細がrunの画面に含まれる
  const panes: readonly McPane[] = tab === 'runs' ? ['rail', 'list'] : ['rail', 'list', 'detail'];
  const effectivePane: McPane = panes.includes(paneFocus) ? paneFocus : 'list';
  const focusPane = (pane: McPane): void => {
    setPaneFocus(pane);
    document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus({ preventScroll: true });
  };
  /** repo一覧の`j` / `k`。「すべて」→各repoの順に選ぶ。 */
  const moveRepo = (delta: 1 | -1): void => {
    const ids = ['', ...repos.map((repo) => repo.key)];
    const next = moveSelection(ids, filter.repoKey ?? '', delta);
    setFilter((f) => ({
      ...f,
      repoKey: next === '' || next === undefined ? undefined : next,
    }));
  };

  /** キー・パレットから来た操作を実行する（Issue #2136の5・#2152）。 */
  const dispatch = (
    command: McKeyCommand,
    ctx: { editable: boolean; target: EventTarget | null } = {
      editable: false,
      target: null,
    },
  ): void => {
    const onRuns = tab === 'runs';
    // 費用・利用枠・設定・絞り込みの保存はどのタブでも効く（Issue #2162）
    switch (command.kind) {
      case 'usage':
        setUsageHistoryOpen(false);
        setUsageOpen((open) => !open);
        return;
      case 'usageHistory':
        setUsageOpen(false);
        setUsageHistoryOpen((open) => !open);
        return;
      case 'prefs':
        setPrefsOpen(true);
        return;
      case 'saveFilter':
        setSaveFilterOpen(true);
        return;
      case 'savedFilter':
        switchSavedFilter(command.delta);
        return;
      case 'deleteFilter':
        deleteSavedFilter();
        return;
      case 'task':
      case 'taskOp':
        if (!onRuns) {
          setToast('Runsタブで使います');
        } else if (command.kind === 'task') {
          moveTask(command.delta);
        } else {
          runTaskOp(command.op);
        }
        return;
      default:
        break;
    }
    if (command.kind === 'runOp' || command.kind === 'parallel') {
      if (!onRuns) {
        setToast('Runsタブで使います');
      } else if (command.kind === 'runOp') {
        runAction(command.op);
      } else {
        runParallel(command.delta);
      }
      return;
    }
    if (onRuns && SESSION_ONLY_COMMANDS.has(command.kind)) {
      return;
    }
    if (effectivePane === 'rail' && (command.kind === 'next' || command.kind === 'prev')) {
      moveRepo(command.kind === 'next' ? 1 : -1);
      return;
    }
    if (effectivePane === 'rail' && command.kind === 'detail') {
      focusPane('list');
      return;
    }
    if (onRuns && command.kind === 'detail') {
      runAction('switch');
      return;
    }
    if (onRuns && command.kind === 'newSession') {
      runStart();
      return;
    }
    switch (command.kind) {
      case 'pane': {
        const index = panes.indexOf(effectivePane);
        focusPane(panes[(index + command.delta + panes.length) % panes.length] ?? 'list');
        return;
      }
      case 'palette':
        // パレットは一番上のダイアログになり、詳細の操作を拾えなくなるので開く前に集める
        setPalette(buildPalette());
        return;
      case 'accessKeys':
        setShowAccessKeys((on) => !on);
        return;
      case 'view':
        setViewMode((mode) => (mode === 'grid' ? 'list' : 'grid'));
        return;
      case 'density':
        setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'));
        return;
      case 'submit':
        submitAround(ctx.target);
        return;
      case 'tab':
        setTab((t) => (t === 'runs' ? 'sessions' : 'runs'));
        return;
      case 'issues':
        setIssuesOpen(true);
        return;
      case 'next':
      case 'prev': {
        if (onRuns) {
          const nextRun = moveSelection(
            runIds,
            effectiveRun?.runId,
            command.kind === 'next' ? 1 : -1,
          );
          setSelectedRun(nextRun);
          if (nextRun !== undefined) {
            document
              .querySelector(`[data-row="${CSS.escape(`run:${nextRun}`)}"]`)
              ?.scrollIntoView({ block: 'nearest' });
          }
          return;
        }
        const next = moveSelection(rowIds, selected, command.kind === 'next' ? 1 : -1);
        setSelected(next);
        if (next !== undefined) {
          document
            .querySelector(`[data-row="${CSS.escape(next)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      case 'detail': {
        const first = detailRef.current?.querySelector<HTMLElement>(
          'button:not(:disabled), input, textarea',
        );
        setPaneFocus('detail');
        (first ?? detailRef.current)?.focus();
        return;
      }
      case 'search':
        searchRef.current?.focus();
        return;
      case 'turnSearch':
      case 'turnMatch':
      case 'turnMatchPrev':
      case 'turnFolds':
      case 'turnOlder': {
        const keys = conversationKeys.current;
        if (keys === null) {
          setToast('会話を出している項目を選んでください');
          return;
        }
        if (command.kind === 'turnSearch') {
          setPaneFocus('detail');
          keys.search();
        } else if (command.kind === 'turnMatch' || command.kind === 'turnMatchPrev') {
          keys.step(command.kind === 'turnMatch' ? 1 : -1);
        } else if (command.kind === 'turnFolds') {
          keys.toggleFolds();
        } else {
          keys.loadOlder();
        }
        return;
      }
      case 'attach':
      case 'queue': {
        const keys = composerKeys.current;
        if (keys === null) {
          setToast('指示欄のあるセッションを選んでください');
          return;
        }
        setPaneFocus('detail');
        if (command.kind === 'attach') {
          keys.attach();
        } else {
          keys.toggleQueue();
        }
        return;
      }
      case 'settings':
      case 'planMode':
      case 'fastMode': {
        // 設定欄（Issue #2159）。plan / fastはボタンを押し、settingsは最初の選択欄へ移る
        const selector =
          command.kind === 'settings'
            ? '[data-settings-first]'
            : command.kind === 'planMode'
              ? '[data-settings-plan]'
              : '[data-settings-fast]';
        const element = detailRef.current?.querySelector<HTMLElement>(selector);
        if (element === null || element === undefined || element.hasAttribute('disabled')) {
          setToast(
            command.kind === 'fastMode'
              ? 'Fast modeを使えるClaudeのセッションを選んでください'
              : '設定を変えられるセッションを選んでください',
          );
          return;
        }
        setPaneFocus('detail');
        if (command.kind === 'settings') {
          element.focus();
        } else {
          element.click();
        }
        return;
      }
      case 'help':
        setHelpOpen((open) => !open);
        return;
      case 'newSession':
        setLaunchOpen(true);
        return;
      case 'escape':
        if (helpOpen) {
          setHelpOpen(false);
        } else if (usageOpen) {
          setUsageOpen(false);
        } else if (usageHistoryOpen) {
          setUsageHistoryOpen(false);
        } else if (ctx.editable && ctx.target instanceof HTMLElement) {
          // 入力欄から出たら、そのペインにフォーカスを残す（フォーカス位置を見失わないように）
          const pane = ctx.target.closest<HTMLElement>('[data-pane]');
          if (pane === null) {
            ctx.target.blur();
          } else {
            pane.focus({ preventScroll: true });
          }
        } else if (marks.size > 0) {
          setMarks(new Set());
        }
        return;
      case 'toggleMark':
        toggleMark(focusedSession);
        return;
      case 'lifecycle':
        runLifecycle(command.op);
        return;
      case 'history':
        setHistoryOpen(true);
        return;
      case 'sessionOp':
        runSessionOp(command.op);
        return;
      case 'choose':
        formKeys.current?.choose(command.index);
        return;
      case 'approve':
        formKeys.current?.approve();
        return;
      case 'decline':
        formKeys.current?.decline();
        return;
      case 'reply':
        if (formKeys.current !== null) {
          formKeys.current.reply();
        } else {
          // セッションの詳細では、指示のcomposerへ移る
          setPaneFocus('detail');
          detailRef.current?.querySelector<HTMLElement>('textarea.composer-input')?.focus();
        }
        return;
    }
  };

  /** コマンドパレットの項目（Issue #2152の1）。キーの表・ペイン・絞り込み・詳細のボタン。 */
  const buildPalette = (): McPaletteEntry[] => {
    const onRuns = tab === 'runs';
    const hasItem = onRuns ? effectiveRun !== undefined : selected !== undefined;
    const entries: McPaletteEntry[] = [];
    KEY_BINDINGS.forEach((binding, index) => {
      if (binding.hideInPalette === true || typeof binding.command === 'function') {
        return;
      }
      const command = binding.command;
      // 今のタブで効かない操作は出さない（タブの切り替えは出すので、そこから届く）
      if (binding.scope === 'runs' && !onRuns) {
        return;
      }
      if (onRuns && SESSION_ONLY_COMMANDS.has(command.kind)) {
        return;
      }
      // providerに無い操作は出さない（Issue #2159）。Fast modeはCodexと、CLIが状態を返さない
      // Claudeのセッションでは設定欄にボタンが無いので、パレットにも出さない
      if (
        command.kind === 'fastMode' &&
        (detailRef.current?.querySelector('[data-settings-fast]') ?? null) === null
      ) {
        return;
      }
      // 巻き戻しはClaudeにしか無い（Issue #2160）
      if (
        command.kind === 'sessionOp' &&
        command.op === 'rewind' &&
        focusedSession?.provider !== 'claude'
      ) {
        return;
      }
      entries.push({
        id: `key:${String(index)}`,
        label: onRuns && binding.runsLabel !== undefined ? binding.runsLabel : binding.label,
        keyLabel: bindingDisplay(binding),
        contextual: binding.contextual === true && hasItem,
        run: () => latest.current.dispatch(command),
      });
    });
    // 指示欄の補完（Issue #2158）。入力欄の中のキーなので、表の外からパレットへ足す
    if (!onRuns && composerKeys.current !== null) {
      entries.push(
        {
          id: 'composer:file',
          label: '指示欄: ファイルを補完する（@を入れて候補を出す）',
          keyLabel: '@',
          contextual: true,
          run: () => {
            setPaneFocus('detail');
            composerKeys.current?.complete('@');
          },
        },
        {
          id: 'composer:command',
          label: '指示欄: スラッシュコマンドを補完する（行頭に/を入れて候補を出す）',
          keyLabel: '/（行頭）',
          contextual: true,
          run: () => {
            setPaneFocus('detail');
            composerKeys.current?.complete('/');
          },
        },
      );
    }
    // 詳細ペインのボタン（diffを開く・中断など）。選んでいる項目に効くので上に出す
    for (const [i, action] of scopeActions(document).entries()) {
      entries.push({
        id: `detail:${String(i)}`,
        label: `詳細: ${action.label}`,
        keyLabel: action.element.dataset['akey'],
        contextual: true,
        run: () => {
          if (action.element.isConnected) {
            action.element.click();
          }
        },
      });
    }
    for (const [i, input] of scopeInputs(document).entries()) {
      entries.push({
        id: `input:${String(i)}`,
        label: `入力欄へ: ${input.label}`,
        keyLabel: input.element.dataset['akey'],
        contextual: true,
        run: () => {
          if (input.element.isConnected) {
            input.element.focus();
          }
        },
      });
    }
    const paneLabels: Record<McPane, string> = {
      rail: 'repo一覧へ移る',
      list: onRuns ? 'run一覧へ移る' : '一覧へ移る',
      detail: '詳細へ移る',
    };
    for (const pane of panes) {
      entries.push({
        id: `pane:${pane}`,
        label: paneLabels[pane],
        contextual: false,
        run: () => latest.current.focusPane(pane),
      });
    }
    const setFilterLater = (next: Partial<McFilter>) => () => setFilter((f) => ({ ...f, ...next }));
    entries.push({
      id: 'repo:all',
      label: 'repoで絞り込む: すべて',
      contextual: false,
      run: setFilterLater({ repoKey: undefined }),
    });
    for (const repo of repos) {
      entries.push({
        id: `repo:${repo.key}`,
        label: `repoで絞り込む: ${repo.label}`,
        contextual: false,
        run: setFilterLater({ repoKey: repo.key }),
      });
    }
    entries.push({
      id: 'activity:all',
      label: '状態で絞り込む: すべて',
      contextual: false,
      run: setFilterLater({ activity: undefined }),
    });
    for (const activity of Object.keys(ACTIVITY_LABELS) as McActivity[]) {
      entries.push({
        id: `activity:${activity}`,
        label: `状態で絞り込む: ${ACTIVITY_LABELS[activity]}`,
        contextual: false,
        run: setFilterLater({ activity }),
      });
    }
    for (const [provider, label] of PROVIDER_FILTERS) {
      entries.push({
        id: `provider:${provider}`,
        label: `CLIで絞り込む: ${label}`,
        contextual: false,
        run: setFilterLater({ provider }),
      });
    }
    // 保存した絞り込み（Issue #2162）。名前はホストで1行・40字までに揃えてある
    for (const saved of savedFilters) {
      entries.push({
        id: `savedFilter:${saved.name}`,
        label: `保存した絞り込み: ${saved.name}`,
        contextual: false,
        run: () => setFilter(fromFilterSpec(saved.filter)),
      });
    }
    entries.push(
      {
        id: 'currentWindowOnly',
        label: `このウィンドウのみ: ${filter.currentWindowOnly ? 'オフにする' : 'オンにする'}`,
        contextual: false,
        run: setFilterLater({ currentWindowOnly: !filter.currentWindowOnly }),
      },
      {
        id: 'markClear',
        label: '複数選択を外す',
        contextual: false,
        run: () => setMarks(new Set()),
      },
      {
        id: 'reload',
        label: 'ウィンドウをReloadする',
        contextual: false,
        run: reloadWindow,
      },
    );
    // 許可リストの拡張コマンド（Issue #2161）。送るのはidだけで、providerを渡すコマンドには
    // 選択中のセッションの宛先を添える（拡張ホストが知っているセッションかを確かめる）
    const commandTarget = onRuns ? undefined : focusedSession;
    for (const command of MC_EXTENSION_COMMANDS) {
      entries.push({
        id: `command:${command.id}`,
        label: command.label,
        contextual: false,
        run: () => {
          const to = command.arg === 'provider' ? commandTarget : undefined;
          void bridge.runCommand(command.id, to).then((result) => {
            if (!result.ok) {
              setToast(result.error ?? 'コマンドを実行できませんでした');
            }
          });
        },
      });
    }
    return entries;
  };

  // キーボード操作（Issue #2136の5）。最新の状態をrefで読む
  const latest = useRef({
    helpOpen,
    usageOpen,
    usageHistoryOpen,
    launchOpen,
    historyOpen,
    issuesOpen,
    opDialogOpen: opDialog !== undefined,
    globalDialogOpen: prefsOpen || saveFilterOpen,
    paletteOpen: palette !== undefined,
    tab,
    dispatch,
    focusPane,
  });
  latest.current = {
    helpOpen,
    usageOpen,
    usageHistoryOpen,
    launchOpen,
    historyOpen,
    issuesOpen,
    opDialogOpen: opDialog !== undefined,
    globalDialogOpen: prefsOpen || saveFilterOpen,
    paletteOpen: palette !== undefined,
    tab,
    dispatch,
    focusPane,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // ダイアログ・入力欄が自分で受け持ったキー（履歴の↑ / ↓、composerのCtrl+Enterなど）
      if (event.defaultPrevented) {
        return;
      }
      // IMEで変換している途中のキーは、送信を含むどのコマンドにも使わない
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      const editable = isEditable(event.target);
      const input = {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        inEditable: editable || event.isComposing,
      };
      const resolved = resolveKey(input);
      const state = latest.current;
      const dialogOpen =
        state.launchOpen ||
        state.historyOpen ||
        state.issuesOpen ||
        state.opDialogOpen ||
        state.globalDialogOpen ||
        state.paletteOpen;
      const plainLetter =
        /^[a-z]$/iu.test(event.key) &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !editable &&
        !event.isComposing;
      // 新規起動・履歴・パレットの画面を出している間は、一覧・回答のキーを効かせない（Escで閉じる
      // だけ。履歴の↑ / ↓・Enterは`HistoryDialog`が受け持つ）。Tabは画面の中で回し、
      // Ctrl+Enterで送信し、英字はボタンのアクセスキーにする（Issue #2152の3・4）
      if (dialogOpen) {
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].pop();
        if (resolved?.command.kind === 'escape' && !editable) {
          event.preventDefault();
          setLaunchOpen(false);
          setHistoryOpen(false);
          setIssuesOpen(false);
          setOpDialog(undefined);
          setPrefsOpen(false);
          setSaveFilterOpen(false);
          setPalette(undefined);
        } else if (resolved?.command.kind === 'escape' && event.target instanceof HTMLElement) {
          if (state.paletteOpen) {
            setPalette(undefined);
          } else {
            event.target.blur();
          }
        } else if (resolved?.command.kind === 'submit') {
          if (submitAround(event.target)) {
            event.preventDefault();
          }
        } else if (event.key === 'Tab' && dialog !== undefined) {
          if (trapTab(dialog, event.shiftKey)) {
            event.preventDefault();
          }
        } else if (plainLetter && activateAccessKey(document, event.key.toLowerCase())) {
          event.preventDefault();
        }
        return;
      }
      if (
        state.helpOpen &&
        resolved?.command.kind !== 'help' &&
        resolved?.command.kind !== 'escape'
      ) {
        return;
      }
      // 利用枠の詳細と推移グラフ（Issue #2176）もヘルプと同じく、開閉・互いの切替とEscだけを
      // 効かせる（Issue #2162）
      if (
        (state.usageOpen || state.usageHistoryOpen) &&
        resolved?.command.kind !== 'usage' &&
        resolved?.command.kind !== 'usageHistory' &&
        resolved?.command.kind !== 'escape'
      ) {
        return;
      }
      // セッションのタブで、全体のキーに当たらない英字（Runsタブだけのキーを含む）は詳細ペインの
      // アクセスキーにする
      const freeOnThisTab =
        resolved === undefined || (resolved.binding.scope === 'runs' && state.tab !== 'runs');
      if (plainLetter && freeOnThisTab && state.tab === 'sessions') {
        if (activateAccessKey(document, event.key.toLowerCase())) {
          event.preventDefault();
          return;
        }
      }
      // 詳細ペインの中のTabは、端に着くまで標準の移動で順に辿る（アクセスキーが尽きた操作にも届く）
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const pane = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(
          '[data-pane="detail"]',
        );
        if (pane !== null && pane !== undefined && tabStaysInPane(pane, event.shiftKey)) {
          return;
        }
      }
      // ボタン・リンクの上のEnterは、そのボタンを押す標準の操作に任せる。奪うとTabで移って
      // Enterで押す操作ができない
      if (
        resolved === undefined ||
        (resolved.command.kind === 'detail' && isActivatable(event.target))
      ) {
        return;
      }
      event.preventDefault();
      state.dispatch(resolved.command, { editable, target: event.target });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ペインのフォーカスを、クリック・Tabで移ったフォーカスにも合わせる（Issue #2152の2）
  useEffect(() => {
    const follow = (event: Event): void => {
      const pane =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-pane]')?.dataset['pane']
          : undefined;
      if (pane === 'rail' || pane === 'list' || pane === 'detail') {
        setPaneFocus(pane);
      }
    };
    document.addEventListener('focusin', follow);
    document.addEventListener('pointerdown', follow);
    return () => {
      document.removeEventListener('focusin', follow);
      document.removeEventListener('pointerdown', follow);
    };
  }, []);

  // 詳細ペイン・ダイアログのボタンへアクセスキーを振り直す（Issue #2152の3）。ボタンは子の
  // 部品の状態でも増減するので、DOMの変化を見て次のフレームでまとめて振る
  useEffect(() => {
    const root = document.getElementById('root') ?? document.body;
    let queued = false;
    const schedule = (): void => {
      if (queued) {
        return;
      }
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        refreshAccessKeys(document);
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'open', 'data-tab'],
    });
    schedule();
    return () => observer.disconnect();
  }, []);

  if (snapshot === undefined) {
    return <p class="empty">読み込み中…</p>;
  }
  const now = Date.now() + clockOffset;
  const tabButtons = (
    <div class="seg" role="group" aria-label="タブ">
      <button
        type="button"
        aria-pressed={tab === 'sessions'}
        title="セッション（t）"
        data-key-label="t"
        onClick={() => setTab('sessions')}
      >
        セッション
      </button>
      <button
        type="button"
        aria-pressed={tab === 'runs'}
        title="Runs（t）"
        data-key-label="t"
        onClick={() => setTab('runs')}
      >
        Runs（{String(runsSnap?.runs.length ?? 0)}）
      </button>
    </div>
  );
  // 回答欄が描かれないときは、前の項目の回答欄へキーが届かないよう外す
  formKeys.current = null;

  return (
    <div
      class={['mc', showAccessKeys ? 'akeys' : '', density === 'compact' ? 'compact' : '']
        .filter((c) => c !== '')
        .join(' ')}
      data-tab={tab}
      data-pane-focus={effectivePane}
      data-density={density}
    >
      <McHeader
        sessions={snapshot.sessions}
        usage={snapshot.usage}
        now={now}
        savedFilters={savedFilters}
        filter={filter}
        onUsage={() => setUsageOpen((open) => !open)}
        onPrefs={() => setPrefsOpen(true)}
        onSaveFilter={() => setSaveFilterOpen(true)}
      />
      <Rail
        focused={effectivePane === 'rail'}
        repos={repos}
        snapshot={snapshot}
        filter={filter}
        onFilter={(next) => setFilter(next)}
      />
      {tab === 'runs' ? (
        <RunsPane
          runs={runsSnap}
          selectedRun={effectiveRun?.runId}
          onSelect={setSelectedRun}
          onOp={runAction}
          onParallel={runParallel}
          onStart={runStart}
          onIssues={() => setIssuesOpen(true)}
          selectedTask={effectiveTask?.taskId}
          onSelectTask={setSelectedTask}
          onTaskOp={runTaskOp}
          tabButtons={tabButtons}
          focused={effectivePane === 'list'}
        />
      ) : null}
      {tab === 'sessions' ? (
        <>
          <div
            class={effectivePane === 'list' ? 'pane center pane-focused' : 'pane center'}
            data-pane="list"
            tabIndex={-1}
            aria-label="一覧"
          >
            <div class="toolbar">
              {tabButtons}
              <input
                ref={searchRef}
                class="search"
                type="search"
                placeholder="検索（/）"
                data-key-label="/"
                aria-label="タイトル・要約・repo名で検索"
                value={filter.query}
                onInput={(e) => setFilter({ ...filter, query: e.currentTarget.value })}
              />
              <div
                class="seg"
                role="group"
                aria-label="セッション一覧の表示（v）"
                title="一覧 / カードを切り替える（v）"
                data-key-label="v"
              >
                <button
                  type="button"
                  aria-pressed={viewMode === 'list'}
                  onClick={() => setViewMode('list')}
                >
                  一覧
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === 'grid'}
                  onClick={() => setViewMode('grid')}
                >
                  カード
                </button>
              </div>
              <div
                class="seg"
                role="group"
                aria-label="表示の密度（Shift+V）"
                title="表示の密度を切り替える（Shift+V）"
                data-key-label="Shift+V"
              >
                <button
                  type="button"
                  aria-pressed={density === 'comfortable'}
                  onClick={() => setDensity('comfortable')}
                >
                  標準
                </button>
                <button
                  type="button"
                  aria-pressed={density === 'compact'}
                  onClick={() => setDensity('compact')}
                >
                  詰める
                </button>
              </div>
              <button
                type="button"
                class="btn primary"
                onClick={() => setLaunchOpen(true)}
                title="新規セッション（n）"
                data-key-label="n"
              >
                ＋ 新規
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => setHistoryOpen(true)}
                title="履歴から再開（h）"
                data-key-label="h"
              >
                履歴
              </button>
              <button
                type="button"
                class="btn"
                title="ウィンドウをReloadする"
                onClick={reloadWindow}
              >
                Reload
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => setHelpOpen(true)}
                title="キー操作（?）"
                data-key-label="?"
              >
                ?
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => dispatch({ kind: 'palette' })}
                title="コマンドパレット（:）"
                data-key-label=":"
              >
                操作
              </button>
            </div>
            <section class="section" aria-label="Inbox">
              <h2 class="pane-title">
                Inbox（{String(pending.length + resumable.length)}）
                {pending.length > 0 ? (
                  <span class="badge attention" title="回答を待っている項目の数">
                    {String(pending.length)}
                  </span>
                ) : null}
              </h2>
              {pending.length === 0 && resumable.length === 0 ? (
                <p class="empty">回答待ちの項目はありません。</p>
              ) : (
                pending.map((item) => (
                  <PendingRow
                    key={item.id}
                    item={item}
                    repos={repos}
                    session={sessionOf(item)}
                    now={now}
                    selected={selected === pendingRowId(item)}
                    sent={sent.has(item.id)}
                    onSelect={() => setSelected(pendingRowId(item))}
                  />
                ))
              )}
              {resumable.map((item) => (
                <ResumeRow
                  key={item.id}
                  item={item}
                  repos={repos}
                  now={now}
                  selected={selected === resumeRowId(item)}
                  onSelect={() => setSelected(resumeRowId(item))}
                />
              ))}
            </section>
            <ReviewSection
              sessions={reviewSessions}
              selected={selected}
              rowId={sessionRowId}
              onSelect={setSelected}
            />
            <section class="section" aria-label="セッション一覧">
              <h2 class="pane-title">セッション（{String(sessions.length)}）</h2>
              <MarkBar count={marks.size} onOp={runLifecycle} onClear={() => setMarks(new Set())} />
              {groups.length === 0 ? (
                <EmptyGuide filtered={(snapshot.sessions ?? []).length > 0} />
              ) : (
                groups.map((group) => (
                  <div key={group.repo.key}>
                    <h3 class="group-title" title={group.repo.full}>
                      {group.repo.label}
                      <span class="count">{String(group.sessions.length)}</span>
                    </h3>
                    <div class={viewMode === 'grid' ? 'grid' : undefined}>
                      {group.sessions.map((session) => (
                        <SessionRow
                          key={session.key}
                          session={session}
                          purpose={purposes.get(session.key)}
                          now={now}
                          stallMs={snapshot.stallMs}
                          replyWaitMs={snapshot.replyWaitMs ?? DEFAULT_REPLY_WAIT_MS}
                          selected={selected === sessionRowId(session)}
                          marked={marks.has(session.key)}
                          onSelect={() => setSelected(sessionRowId(session))}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
          <div
            class={effectivePane === 'detail' ? 'pane pane-focused' : 'pane'}
            ref={detailRef}
            data-pane="detail"
            tabIndex={-1}
            aria-label="詳細"
          >
            {selectedPending !== undefined ? (
              <PendingDetail
                key={selectedPending.id}
                item={selectedPending}
                bridge={bridge}
                repos={repos}
                session={sessionOf(selectedPending)}
                now={now}
                sent={sent.has(selectedPending.id)}
                answerError={answerErrors.get(selectedPending.id)}
                approvals={approvals[targetKey(selectedPending)]}
                conversation={conversationFor(selectedPending)}
                formKeys={formKeys}
                submit={submitFor(selectedPending)}
                onReload={() => loadApprovals(selectedPending)}
                onSessionAction={sessionAction}
              />
            ) : selectedSession !== undefined ? (
              <SessionDetail
                key={selectedSession.key}
                session={selectedSession}
                purpose={purposes.get(selectedSession.key)}
                bridge={bridge}
                onToast={setToast}
                now={now}
                stallMs={snapshot.stallMs}
                replyWaitMs={snapshot.replyWaitMs ?? DEFAULT_REPLY_WAIT_MS}
                onSend={(text, attachments) => sendTo(selectedSession, text, attachments)}
                composerKeys={composerKeys}
                pending={(snapshot.pending ?? []).filter(
                  (p) =>
                    p.windowId === selectedSession.windowId &&
                    p.threadId === selectedSession.threadId &&
                    p.provider === selectedSession.provider,
                )}
                conversation={conversationFor(selectedSession)}
                onSelectPending={(item) => setSelected(pendingRowId(item))}
                onSessionAction={sessionAction}
                marked={marks.has(selectedSession.key)}
                // 詳細のボタンは、複数選択があってもこのセッションだけに効かせる
                onLifecycle={(op) => runLifecycle(op, [selectedSession])}
                onToggleMark={() => toggleMark(selectedSession)}
              />
            ) : selectedResume !== undefined ? (
              <ResumeDetail
                key={selectedResume.id}
                item={selectedResume}
                now={now}
                bridge={bridge}
                onToast={setToast}
              />
            ) : (
              <p class="empty">項目を選ぶと詳細が出ます（j / kで移動）。</p>
            )}
          </div>
        </>
      ) : null}
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
      {usageOpen ? (
        <UsageDialog
          sessions={snapshot.sessions}
          usage={snapshot.usage}
          now={now}
          onClose={() => setUsageOpen(false)}
          onHistory={() => {
            setUsageOpen(false);
            setUsageHistoryOpen(true);
          }}
        />
      ) : null}
      {usageHistoryOpen ? (
        <UsageHistoryDialog bridge={bridge} onClose={() => setUsageHistoryOpen(false)} />
      ) : null}
      {prefsOpen ? (
        <PrefsDialog
          bridge={bridge}
          prefs={snapshot.prefs}
          onClose={() => setPrefsOpen(false)}
          onDone={(message) => setToast(message)}
        />
      ) : null}
      {saveFilterOpen ? (
        <SaveFilterDialog
          bridge={bridge}
          filter={filter}
          savedFilters={savedFilters}
          toSpec={toFilterSpec}
          onClose={() => setSaveFilterOpen(false)}
          onDone={(message) => {
            setSaveFilterOpen(false);
            setToast(message);
          }}
        />
      ) : null}
      {palette !== undefined ? (
        <CommandPalette entries={palette} onClose={() => setPalette(undefined)} />
      ) : null}
      {launchOpen ? (
        <LaunchDialog
          bridge={bridge}
          sessions={snapshot.sessions}
          onClose={() => setLaunchOpen(false)}
          onLaunched={(message) => {
            setLaunchOpen(false);
            setToast(message);
          }}
        />
      ) : null}
      {issuesOpen ? (
        <IssueStartDialog
          bridge={bridge}
          folders={runsSnap?.folders ?? []}
          onClose={() => setIssuesOpen(false)}
          onDone={(message) => {
            setIssuesOpen(false);
            setToast(message);
          }}
        />
      ) : null}
      {historyOpen ? (
        <HistoryDialog
          bridge={bridge}
          onClose={() => setHistoryOpen(false)}
          onOpened={(message) => {
            setHistoryOpen(false);
            setToast(message);
          }}
        />
      ) : null}
      {opDialog !== undefined ? (
        <SessionOpDialog
          bridge={bridge}
          session={opDialog.session}
          op={opDialog.op}
          onClose={() => setOpDialog(undefined)}
          onDone={(message) => {
            setOpDialog(undefined);
            setToast(message);
          }}
        />
      ) : null}
      <div class="toast" role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}

function Rail(props: {
  focused: boolean;
  repos: readonly McRepo[];
  snapshot: McSnapshot;
  filter: McFilter;
  onFilter: (filter: McFilter) => void;
}): JSX.Element {
  const { filter, onFilter } = props;
  const providers = PROVIDER_FILTERS;
  const activityCounts = countByActivity(props.snapshot.sessions, props.repos, filter);
  return (
    <nav
      class={props.focused ? 'pane pane-focused' : 'pane'}
      aria-label="repo"
      data-pane="rail"
      tabIndex={-1}
    >
      <h2 class="pane-title">Repo</h2>
      <button
        type="button"
        class={filter.repoKey === undefined ? 'rail-item active' : 'rail-item'}
        onClick={() => onFilter({ ...filter, repoKey: undefined })}
      >
        <span class="rail-label">すべて</span>
        <span class="count">{String(props.snapshot.sessions.length)}</span>
        {props.snapshot.pending.length > 0 ? (
          <span class="badge">{String(props.snapshot.pending.length)}</span>
        ) : null}
      </button>
      {props.repos.map((repo) => (
        <button
          key={repo.key}
          type="button"
          class={filter.repoKey === repo.key ? 'rail-item active' : 'rail-item'}
          title={repo.full}
          onClick={() => onFilter({ ...filter, repoKey: repo.key })}
        >
          <span class="rail-label">{repo.label}</span>
          <span class="count">{String(repo.sessionCount)}</span>
          {repo.pendingCount > 0 ? <span class="badge">{String(repo.pendingCount)}</span> : null}
        </button>
      ))}
      <h2 class="pane-title">状態</h2>
      <button
        type="button"
        class={filter.activity === undefined ? 'rail-item active' : 'rail-item'}
        onClick={() => onFilter({ ...filter, activity: undefined })}
      >
        <span class="rail-label">すべて</span>
      </button>
      {(Object.keys(ACTIVITY_LABELS) as McActivity[]).map((activity) => (
        <button
          key={activity}
          type="button"
          class={filter.activity === activity ? 'rail-item active' : 'rail-item'}
          onClick={() => onFilter({ ...filter, activity })}
        >
          <span class="rail-label">{ACTIVITY_LABELS[activity]}</span>
          <span class="count">{String(activityCounts[activity])}</span>
        </button>
      ))}
      <div class="filters">
        <div class="seg" role="group" aria-label="provider">
          {providers.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter.provider === value}
              onClick={() => onFilter({ ...filter, provider: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={filter.currentWindowOnly}
            onChange={(e) => onFilter({ ...filter, currentWindowOnly: e.currentTarget.checked })}
          />
          このウィンドウのみ
        </label>
      </div>
    </nav>
  );
}

function PendingRow(props: {
  item: McPendingItem;
  repos: readonly McRepo[];
  session: McSession | undefined;
  now: number;
  selected: boolean;
  sent: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { item } = props;
  const kindLabel = PENDING_KIND_LABELS[item.kind];
  const repo = props.repos.find((r) => r.key === item.repoKey);
  const meta = [kindLabel, repo?.label, props.session?.title].filter(
    (v): v is string => v !== undefined && v !== '',
  );
  const classes = ['row', props.selected ? 'selected' : '', props.sent ? 'sent' : ''];
  return (
    <div
      class={classes.filter((c) => c !== '').join(' ')}
      data-row={pendingRowId(item)}
      role="option"
      aria-selected={props.selected}
      onClick={props.onSelect}
    >
      <KindIcon kind={item.kind} label={kindLabel} />
      <span class="row-title">{item.title}</span>
      <span class="row-meta">
        {props.sent ? '送信済み' : formatElapsed(props.now - item.createdAt)}
      </span>
      <span class="row-sub">
        {meta.join(' · ')}
        {item.summary === '' ? '' : ` — ${item.summary}`}
      </span>
    </div>
  );
}

/** ピルのhoverの説明。 */
const PILL_TITLES: Partial<Record<McCardStatus, string>> = {
  stalled: '実行中ですが、出力が止まっています',
  replyWait: 'ターンが終わり、あなたの返事を待っています',
  replyWaitLong: 'あなたの返事を長く待っています',
};

/**
 * 状態のピル。実行中で出力が止まっていれば「停滞」（Issue #2137の5）、待機中の通常チャットは
 * 「返事待ち」（Issue #2171）にする。
 */
function ActivityPill(props: {
  session: McSession;
  now: number;
  stallMs: number;
  replyWaitMs: number;
}): JSX.Element {
  const { session, now, stallMs, replyWaitMs } = props;
  const status = cardStatus(session, now, stallMs, replyWaitMs);
  const since = stalledSince(session);
  const label = cardStatusLabel(status);
  // 状態が変わると作り直して、ピルの出現のアニメーションで変化（完了など）を知らせる。
  // 返事待ちの経過はピルの直後に並ぶ待機の経過（`activitySince`起点）と同じなので添えない
  return (
    <span key={status} class={`pill ${status}`} title={PILL_TITLES[status]}>
      <StatusIcon status={status} label={label} decorative />
      {status === 'stalled' && since !== undefined
        ? `${label} ${formatElapsed(now - since)}`
        : label}
    </span>
  );
}

/** 未読の印（Issue #2171）。返事待ちのうち、ターンの終わりをまだ人が見ていないもの。 */
function UnreadBadge(props: { session: McSession }): JSX.Element | null {
  return isUnreadReply(props.session) ? (
    <span class="badge unread" title="ターンが終わってから、まだ表示していません">
      ● 未読
    </span>
  ) : null;
}

/** カードの補足（model・トークン・費用）。取れたものだけを並べる。 */
function sessionFacts(session: McSession): string[] {
  const facts: string[] = [];
  if (session.model !== undefined && session.model !== '') {
    facts.push(session.model);
  }
  if (session.tokens !== undefined) {
    facts.push(`${formatTokens(session.tokens)} tokens`);
  }
  if (session.costUsd !== undefined) {
    facts.push(formatCost(session.costUsd));
  }
  return facts;
}

/** セッションが1件も無い・絞り込みで0件のときの案内（Issue #2151の3）。最初の操作をキー付きで示す。 */
function EmptyGuide(props: { filtered: boolean }): JSX.Element {
  if (props.filtered) {
    return (
      <p class="empty">
        条件に合うセッションはありません。検索（<kbd>{keyLabelFor('search')}</kbd>
        ）と左の絞り込みを見直してください。
      </p>
    );
  }
  const steps: ReadonlyArray<[McKeyCommand['kind'], string]> = [
    ['newSession', '新しいセッションを始める'],
    ['history', '履歴から会話を再開する'],
    ['issues', 'roadmap・Issueから起動する'],
    ['help', 'キー操作の一覧を見る'],
  ];
  return (
    <div class="empty empty-guide">
      <p>セッションはありません。次のキーで始められます。</p>
      <ul>
        {steps.map(([kind, text]) => (
          <li key={kind}>
            <kbd>{keyLabelFor(kind)}</kbd>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionRow(props: {
  session: McSession;
  /** 目的の1文要約（Issue #2172）。似た要約が並ぶときはブランチ名が付いている。 */
  purpose?: string | undefined;
  now: number;
  stallMs: number;
  replyWaitMs: number;
  selected: boolean;
  /** 複数選択（`x`）に入っているか。 */
  marked: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { session } = props;
  const status: McCardStatus = cardStatus(session, props.now, props.stallMs, props.replyWaitMs);
  const attention = needsAttention(session);
  const facts = sessionFacts(session);
  // 直近に起動したskill（Issue #2173）
  const recentSkills = recentSkillNames(session.skills);
  const classes = [
    'row',
    'session-row',
    `status-${status}`,
    attention ? 'attention' : '',
    isUnreadReply(session) ? 'unread' : '',
    props.selected ? 'selected' : '',
    props.marked ? 'marked' : '',
  ]
    .filter((c) => c !== '')
    .join(' ');
  return (
    <div
      class={classes}
      data-row={sessionRowId(session)}
      data-status={status}
      role="option"
      aria-selected={props.selected}
      aria-checked={props.marked}
      onClick={props.onSelect}
    >
      {props.marked ? (
        <span class="mark" aria-label="選択中">
          ✓
        </span>
      ) : (
        <ProviderIcon provider={session.provider} />
      )}
      <span class="row-title">{session.title}</span>
      <span class="row-meta">
        <UnreadBadge session={session} />
        <ActivityPill
          session={session}
          now={props.now}
          stallMs={props.stallMs}
          replyWaitMs={props.replyWaitMs}
        />{' '}
        {formatElapsed(props.now - session.activitySince)}
      </span>
      {props.purpose === undefined ? null : (
        <span class="row-purpose" title={`目的: ${props.purpose}`}>
          {props.purpose}
        </span>
      )}
      {facts.length === 0 ? null : <span class="row-facts">{facts.join(' · ')}</span>}
      {recentSkills.length === 0 ? null : (
        <span class="row-skills" title={`直近のskill（新しい順）: ${recentSkills.join(', ')}`}>
          skill: {recentSkills.join(' ← ')}
        </span>
      )}
      {session.lastOutput === undefined ? null : (
        <span class="row-out" title={session.lastOutput}>
          {session.lastOutput}
        </span>
      )}
      <span class="row-sub" title={session.cwdFull}>
        {session.cwdLabel}
        {session.isCurrentWindow ? ' · このウィンドウ' : ' · 別ウィンドウ'}
        {session.loop?.running === true
          ? session.loop.paused
            ? ' · ループ停止中'
            : ' · ループ中'
          : ''}
        {session.pendingCount > 0 ? (
          <span class="badge attention" title="このセッションで回答を待っている項目の数">
            ! 要対応 {String(session.pendingCount)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function SessionActions(props: {
  session: McSession;
  onSessionAction: (session: McSession, action: McControlAction, done: string) => void;
  /** セッションidをコピーする（旧統括ページの「idをコピー」。Issue #1305、#2138）。 */
  onCopyRef?: (() => void) | undefined;
}): JSX.Element {
  const { session, onSessionAction } = props;
  const busy = session.activity !== 'idle';
  return (
    <div class="actions">
      <button
        type="button"
        class="btn"
        onClick={() => onSessionAction(session, { action: 'open' }, 'チャットタブを開きました')}
      >
        チャットタブで開く
      </button>
      {busy ? (
        <button
          type="button"
          class="btn"
          onClick={() => onSessionAction(session, { action: 'interrupt' }, '中断を送りました')}
        >
          中断
        </button>
      ) : null}
      {session.loop?.running === true ? (
        session.loop.paused ? (
          <button
            type="button"
            class="btn"
            onClick={() => onSessionAction(session, { action: 'resumeLoop' }, '再開しました')}
          >
            再開
          </button>
        ) : (
          <button
            type="button"
            class="btn"
            onClick={() => onSessionAction(session, { action: 'pauseLoop' }, '一時停止しました')}
          >
            一時停止
          </button>
        )
      ) : null}
      {props.onCopyRef === undefined ? null : (
        <button
          type="button"
          class="btn"
          title="send_message / ask_sessionの宛先に使うセッションidをコピーする"
          onClick={props.onCopyRef}
        >
          idをコピー
        </button>
      )}
    </div>
  );
}

function PendingDetail(props: {
  item: McPendingItem;
  bridge: Bridge;
  repos: readonly McRepo[];
  session: McSession | undefined;
  now: number;
  sent: boolean;
  /** 直前の回答が断られた理由。 */
  answerError: string | undefined;
  approvals: Loadable<McApprovalDetail[]> | undefined;
  /** 会話（Issue #2157）。宛先ごとの取り寄せは`App`が持つ。 */
  conversation: JSX.Element;
  formKeys: FormKeysRef;
  submit: Submit;
  onReload: () => void;
  onSessionAction: (session: McSession, action: McControlAction, done: string) => void;
}): JSX.Element {
  const { item, approvals } = props;
  const repo = props.repos.find((r) => r.key === item.repoKey);
  const formProps = { item, keys: props.formKeys, submit: props.submit };
  let form: JSX.Element;
  if (props.sent) {
    form = <p class="notice">回答を送りました。一覧から消えるまでお待ちください。</p>;
  } else if (item.kind === 'taskRunQuestion') {
    form = <TaskRunForm {...formProps} />;
  } else if (item.kind === 'handoff') {
    form = <HandoffForm item={item} bridge={props.bridge} submit={props.submit} />;
  } else if (!needsApprovalDetail(item.kind)) {
    form = <p class="notice">この項目はチャットタブで答えてください。</p>;
  } else if (approvals === undefined || approvals.status === 'loading') {
    form = <p class="notice">中身を取り寄せ中…</p>;
  } else if (approvals.status === 'error') {
    form = (
      <div>
        <p class="error">{approvals.error}</p>
        <button type="button" class="btn" onClick={props.onReload}>
          取り寄せ直す
        </button>
      </div>
    );
  } else {
    const approval = findApproval(approvals.value, item);
    form =
      approval === undefined ? (
        <p class="notice">この項目は既に回答済みか、取り下げられました。</p>
      ) : item.kind === 'askUserQuestion' ? (
        <QuestionForm {...formProps} approval={approval} />
      ) : item.kind === 'codexPrompt' ? (
        <PromptForm {...formProps} approval={approval} />
      ) : (
        <ToolApprovalForm {...formProps} approval={approval} />
      );
  }
  return (
    <div class="detail">
      <h2>
        <KindIcon kind={item.kind} label={PENDING_KIND_LABELS[item.kind]} /> {item.title}
      </h2>
      <p class="notice">
        {[
          PENDING_KIND_LABELS[item.kind],
          repo?.label,
          props.session?.title,
          `待ち ${formatElapsed(props.now - item.createdAt)}`,
        ]
          .filter((v): v is string => v !== undefined && v !== '')
          .join(' · ')}
      </p>
      {props.answerError === undefined || props.sent ? null : (
        <p class="error" role="alert">
          {props.answerError}
        </p>
      )}
      {form}
      {props.session !== undefined ? (
        <SessionActions session={props.session} onSessionAction={props.onSessionAction} />
      ) : null}
      {item.kind === 'taskRunQuestion' ? null : props.conversation}
    </div>
  );
}

/** セッションで起動したskillを時刻つきで古い順に全件出す（Issue #2173）。無ければ何も出さない。 */
function SkillTimeline(props: {
  skills: readonly McSkillUse[] | undefined;
  now: number;
}): JSX.Element | null {
  const skills = props.skills ?? [];
  if (skills.length === 0) {
    return null;
  }
  return (
    <div class="detail-skills">
      <h3>
        使ったskill <span class="count">{String(skills.length)}</span>
      </h3>
      <ol>
        {skills.map((skill, index) => (
          <li key={`${String(skill.at)}:${String(index)}`}>
            <span class="muted">{formatSkillTime(skill.at, props.now)}</span> {skill.name}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SessionDetail(props: {
  session: McSession;
  /** 目的の1文要約（Issue #2172）。 */
  purpose?: string | undefined;
  bridge: Bridge;
  onToast: (message: string) => void;
  now: number;
  stallMs: number;
  replyWaitMs: number;
  pending: readonly McPendingItem[];
  /** 会話（Issue #2157）。宛先ごとの取り寄せは`App`が持つ。 */
  conversation: JSX.Element;
  onSelectPending: (item: McPendingItem) => void;
  onSessionAction: (session: McSession, action: McControlAction, done: string) => void;
  onSend: (text: string, attachments: readonly McAttachment[]) => Promise<string | undefined>;
  composerKeys: ComposerKeysRef;
  marked: boolean;
  onLifecycle: (op: McLifecycleOp) => void;
  onToggleMark: () => void;
}): JSX.Element {
  const { session } = props;
  return (
    <div class="detail">
      <h2>
        <ProviderIcon provider={session.provider} /> {session.title}
      </h2>
      <p class="notice" title={session.cwdFull}>
        <ActivityPill
          session={session}
          now={props.now}
          stallMs={props.stallMs}
          replyWaitMs={props.replyWaitMs}
        />{' '}
        {formatElapsed(props.now - session.activitySince)} · {session.cwdLabel} ·{' '}
        {session.isCurrentWindow ? 'このウィンドウ' : '別ウィンドウ'}
      </p>
      {props.purpose === undefined ? null : (
        <p class="detail-purpose">
          <span class="muted">目的:</span> {props.purpose}
        </p>
      )}
      <SkillTimeline skills={session.skills} now={props.now} />
      <SessionActions
        session={session}
        onSessionAction={props.onSessionAction}
        onCopyRef={() =>
          void props.bridge.copyRef(session).then((result) => {
            props.onToast(
              result.ok
                ? 'セッションidをコピーしました'
                : (result.error ?? 'コピーできませんでした'),
            );
          })
        }
      />
      <LifecycleButtons
        provider={session.provider}
        marked={props.marked}
        onOp={props.onLifecycle}
        onToggleMark={props.onToggleMark}
      />
      {props.pending.length === 0 ? null : (
        <div>
          <h3>要対応</h3>
          <div class="choices">
            {props.pending.map((item) => (
              <button
                key={item.id}
                type="button"
                class="choice"
                onClick={() => props.onSelectPending(item)}
              >
                <span>
                  {PENDING_KIND_LABELS[item.kind]}: {item.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <ReviewList session={session} bridge={props.bridge} onToast={props.onToast} />
      <SessionSettingsPanel session={session} bridge={props.bridge} onToast={props.onToast} />
      {props.conversation}
      <Composer
        session={session}
        bridge={props.bridge}
        keysRef={props.composerKeys}
        onSend={props.onSend}
        onToast={props.onToast}
      />
      <SideQuestionForm session={session} bridge={props.bridge} />
    </div>
  );
}

/** 起動先の候補の出どころ（選択肢の見出し）。 */
const LAUNCH_SOURCE_LABELS: Record<McLaunchRepo['source'], string> = {
  picked: '選んだフォルダ',
  recent: '最近使った',
  session: '開いているセッション',
  history: '履歴',
};

/**
 * 新規セッションの起動（Issue #2137の1・2）。repoを選び、Codex / Claudeと最初の指示を決める。
 * 同じrepoで既にセッションが開いていれば、worktreeを既定でONにして警告を出す。
 */
function LaunchDialog(props: {
  bridge: Bridge;
  sessions: readonly McSession[];
  onClose: () => void;
  onLaunched: (message: string) => void;
}): JSX.Element {
  const { bridge } = props;
  const [repos, setRepos] = useState<Loadable<McLaunchRepo[]>>({ status: 'loading' });
  const [path, setPath] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState<McProvider>('codex');
  const [prompt, setPrompt] = useState('');
  /** 利用者が手で切り替えたworktreeの指定。`undefined`の間はrepoに応じた既定を使う。 */
  const [worktreeChoice, setWorktreeChoice] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const firstRef = useRef<HTMLSelectElement | null>(null);
  // Issue #2149の2: model・effort・承認方針・プリセット。空は「設定のまま」
  const [choices, setChoices] = useState<McLaunchChoices | undefined>(undefined);
  const [settings, setSettings] = useState<McLaunchSettings>({});
  /** 前回の選択を当てたrepo。repoを選び直したときだけ当て直す。 */
  const appliedRepo = useRef<string | undefined>(undefined);

  useEffect(() => {
    void bridge.launchOptions().then((result) => {
      if (!result.ok) {
        setRepos({ status: 'error', error: result.error ?? '候補を取り寄せられませんでした' });
        return;
      }
      const list = result.repos ?? [];
      setRepos({ status: 'ok', value: list });
      setChoices(result.choices);
      setPath((current) => current ?? list[0]?.path);
    });
  }, [bridge]);
  useEffect(() => {
    firstRef.current?.focus();
  }, [repos.status]);

  const list = repos.status === 'ok' ? repos.value : [];
  const chosen = list.find((repo) => repo.path === path);
  const running = chosen === undefined ? 0 : countSessionsInRepo(props.sessions, chosen.key);
  const worktree = worktreeChoice ?? running > 0;

  // repoを選んだら、そのrepoで前回選んだ値を既定にする
  const chosenKey = chosen?.key;
  useEffect(() => {
    if (choices === undefined || chosenKey === undefined || appliedRepo.current === chosenKey) {
      return;
    }
    appliedRepo.current = chosenKey;
    const remembered = choices.defaults[chosenKey];
    if (remembered === undefined) {
      return;
    }
    setProvider(remembered.provider);
    setSettings(normalizeLaunchSettings(remembered.provider, remembered, choices));
  }, [choices, chosenKey]);

  const changeProvider = (next: McProvider): void => {
    setProvider(next);
    setSettings((prev) => normalizeLaunchSettings(next, prev, choices));
  };

  const pick = (): void => {
    setError(undefined);
    void bridge.pickFolder().then((result) => {
      if (!result.ok) {
        setError(result.error ?? 'フォルダを選べませんでした');
        return;
      }
      const repo = result.repo;
      if (repo === undefined) {
        return;
      }
      setRepos((prev) =>
        prev.status === 'ok'
          ? { status: 'ok', value: [repo, ...prev.value.filter((r) => r.path !== repo.path)] }
          : { status: 'ok', value: [repo] },
      );
      setPath(repo.path);
      setWorktreeChoice(undefined);
    });
  };
  const launch = (): void => {
    if (busy || chosen === undefined) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const request = { cwd: chosen.path, provider, prompt, worktree, ...settings };
    void bridge.launch(request).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '起動できませんでした');
        return;
      }
      const name = provider === 'codex' ? 'Codex' : 'Claude';
      props.onLaunched(
        worktree
          ? `${name}をworktreeで起動しました（${result.cwd ?? ''}）`
          : `${name}を起動しました`,
      );
    });
  };
  const groups = (['picked', 'recent', 'session', 'history'] as const)
    .map((source) => ({ source, repos: list.filter((repo) => repo.source === source) }))
    .filter((group) => group.repos.length > 0);

  return (
    <div class="help" role="dialog" aria-label="新規セッション">
      <form
        class="help-box launch-box"
        onSubmit={(e) => {
          e.preventDefault();
          launch();
        }}
      >
        <h2>新規セッション</h2>
        <label>
          Repo
          <span class="launch-row">
            <select
              ref={firstRef}
              class="text-input"
              aria-label="起動するrepo"
              value={path ?? ''}
              disabled={busy}
              onChange={(e) => {
                setPath(e.currentTarget.value);
                setWorktreeChoice(undefined);
              }}
            >
              {groups.map((group) => (
                <optgroup key={group.source} label={LAUNCH_SOURCE_LABELS[group.source]}>
                  {group.repos.map((repo) => (
                    <option key={repo.path} value={repo.path} title={repo.path}>
                      {repo.label}（{repo.path}）
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button type="button" class="btn" disabled={busy} onClick={pick}>
              フォルダを選ぶ…
            </button>
          </span>
        </label>
        {repos.status === 'loading' ? <p class="notice">候補を取り寄せ中…</p> : null}
        {repos.status === 'error' ? <p class="error">{repos.error}</p> : null}
        <div class="seg" role="group" aria-label="起動するCLI">
          <button
            type="button"
            aria-pressed={provider === 'codex'}
            disabled={busy}
            onClick={() => changeProvider('codex')}
          >
            Codex
          </button>
          <button
            type="button"
            aria-pressed={provider === 'claude'}
            disabled={busy}
            onClick={() => changeProvider('claude')}
          >
            Claude
          </button>
        </div>
        <LaunchSettingsFields
          choices={choices}
          provider={provider}
          value={settings}
          disabled={busy}
          onChange={setSettings}
          onProvider={setProvider}
        />
        <label>
          最初の指示（空なら会話を開くだけ）
          <textarea
            class="text-input"
            rows={4}
            value={prompt}
            disabled={busy}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
                e.preventDefault();
                launch();
              }
            }}
          />
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={worktree}
            disabled={busy}
            onChange={(e) => setWorktreeChoice(e.currentTarget.checked)}
          />
          別のworktreeで動かす（.claude/worktrees/ 配下に作る）
        </label>
        {running > 0 ? (
          <p class="warn" role="alert">
            このrepoでは既に{String(running)}
            件のセッションが開いています。同じ作業ツリーを2つのセッションが編集すると、変更が衝突します。
            {worktree ? '' : ' worktreeをOFFのまま起動しようとしています。'}
          </p>
        ) : null}
        <p class="notice">
          {choices === undefined
            ? 'model・effort・承認方針は拡張機能の設定のまま起動します（会話のタブで変えられます）。'
            : '承認方針は拡張機能の設定より緩くできません。選んだ値はrepoごとに覚え、次回の既定にします。'}
        </p>
        {error === undefined ? null : (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button type="submit" class="btn primary" disabled={busy || chosen === undefined}>
            {busy ? '起動中…' : '起動'}
          </button>
          <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </form>
    </div>
  );
}

function HelpOverlay(props: { onClose: () => void }): JSX.Element {
  return (
    <div class="help" role="dialog" aria-label="キー操作" onClick={props.onClose}>
      <div class="help-box">
        <h2>キー操作</h2>
        <p class="notice">
          詳細ペインとダイアログのボタンは、ボタン上の英字1つで押せます（.で表示を切り替え）。
        </p>
        <table>
          <tbody>
            {KEY_HELP.map(([key, label]) => (
              <tr key={`${key} ${label}`}>
                <td>
                  <kbd>{key}</kbd>
                </td>
                <td>{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>指示欄の中</h3>
        <table aria-label="指示欄の中のキー">
          <tbody>
            {COMPOSER_KEY_HELP.map(([key, label]) => (
              <tr key={`${key} ${label}`}>
                <td>
                  <kbd>{key}</kbd>
                </td>
                <td>{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
