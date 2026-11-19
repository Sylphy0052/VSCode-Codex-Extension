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
import type { Bridge, ControlResult } from './bridge';
import {
  HandoffForm,
  ResumeDetail,
  ResumeRow,
  ReviewList,
  ReviewSection,
  SideQuestionForm,
} from './extras';
import { KindIcon, ProviderIcon } from './icons';
import {
  ACTIVITY_LABELS,
  countSessionsInRepo,
  EMPTY_FILTER,
  countByActivity,
  filterPending,
  filterResumable,
  filterSessions,
  formatElapsed,
  groupSessionsByRepo,
  isStalled,
  stalledSince,
  KEY_HELP,
  mapKey,
  moveSelection,
  needsApprovalDetail,
  PENDING_KIND_LABELS,
  reconcileSelection,
  type McFilter,
  type McProviderFilter,
} from './logic';
import type {
  McActivity,
  McApprovalDetail,
  McControlAction,
  McLaunchRepo,
  McPendingItem,
  McProvider,
  McRepo,
  McResumeItem,
  McSession,
  McSnapshot,
  McTarget,
  McTurn,
} from './protocol';

/** Reload後に戻す画面の状態（`vscode.setState`）。 */
interface PersistedState {
  filter: McFilter;
  selected: string | undefined;
  viewMode: 'list' | 'grid';
}

const RECENT_TURNS = 6;
/** 経過時間の表示を描き直す間隔。 */
const TICK_MS = 5_000;

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
  const fallback: PersistedState = { filter: EMPTY_FILTER, selected: undefined, viewMode: 'list' };
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
  };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
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
  const [turns, setTurns] = useState<Record<string, Loadable<McTurn[]>>>({});
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
  /** 最初のスナップショットを受けるまでは先頭を自動で選ぶ。 */
  const autoSelect = useRef(true);
  const [launchOpen, setLaunchOpen] = useState(false);

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
    bridge.setState({ filter, selected, viewMode } satisfies PersistedState);
  }, [bridge, filter, selected, viewMode]);

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
    setTurns((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    void bridge.request(target, { action: 'recentTurns', limit: RECENT_TURNS }).then((result) => {
      setTurns((prev) => ({
        ...prev,
        [key]: result.ok
          ? { status: 'ok', value: result.turns ?? [] }
          : { status: 'error', error: result.error ?? 'やり取りを取り寄せられませんでした' },
      }));
    });
  };

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
  // やり取りで差し替える。取り直しの間隔・止めどきは拡張ホストが持つ
  useEffect(() => {
    bridge.watch(detailTarget);
  }, [detailKey]);
  useEffect(() => {
    const off = bridge.onLiveTurns((live) => {
      const key = targetKey(live.target);
      setTurns((prev) => {
        if (live.ok) {
          return { ...prev, [key]: { status: 'ok', value: live.turns ?? [] } };
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
  const sendTo = async (session: McSession, text: string): Promise<string | undefined> => {
    const result = await bridge.request(session, { action: 'send', text });
    if (!result.ok) {
      return result.error ?? '指示を送れませんでした';
    }
    setToast('指示を送りました');
    return undefined;
  };

  // キーボード操作（Issue #2136の5）。最新の状態をrefで読む
  const latest = useRef({ rowIds, selected, helpOpen, launchOpen });
  latest.current = { rowIds, selected, helpOpen, launchOpen };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const editable = isEditable(event.target);
      const command = mapKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        inEditable: editable || event.isComposing,
      });
      // ボタン・リンクの上のEnterは、そのボタンを押す標準の操作に任せる。奪うとTabで移って
      // Enterで押す操作ができない
      if (command === undefined || (command.kind === 'detail' && isActivatable(event.target))) {
        return;
      }
      const state = latest.current;
      if (state.helpOpen && command.kind !== 'help' && command.kind !== 'escape') {
        return;
      }
      // 新規起動の画面を出している間は、一覧・回答のキーを効かせない（Escで閉じるだけ）
      if (state.launchOpen) {
        if (command.kind === 'escape' && !editable) {
          event.preventDefault();
          setLaunchOpen(false);
        } else if (command.kind === 'escape' && event.target instanceof HTMLElement) {
          event.target.blur();
        }
        return;
      }
      event.preventDefault();
      switch (command.kind) {
        case 'next':
        case 'prev': {
          const next = moveSelection(
            state.rowIds,
            state.selected,
            command.kind === 'next' ? 1 : -1,
          );
          setSelected(next);
          if (next !== undefined) {
            document
              .querySelector(`[data-row="${CSS.escape(next)}"]`)
              ?.scrollIntoView({ block: 'nearest' });
          }
          return;
        }
        case 'detail':
          detailRef.current
            ?.querySelector<HTMLElement>('button:not(:disabled), input, textarea')
            ?.focus();
          return;
        case 'search':
          searchRef.current?.focus();
          return;
        case 'help':
          setHelpOpen((open) => !open);
          return;
        case 'newSession':
          setLaunchOpen(true);
          return;
        case 'escape':
          if (state.helpOpen) {
            setHelpOpen(false);
          } else if (editable && event.target instanceof HTMLElement) {
            event.target.blur();
          }
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
            detailRef.current?.querySelector<HTMLElement>('textarea.composer-input')?.focus();
          }
          return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (snapshot === undefined) {
    return <p class="empty">読み込み中…</p>;
  }
  const now = Date.now() + clockOffset;
  // 回答欄が描かれないときは、前の項目の回答欄へキーが届かないよう外す
  formKeys.current = null;

  return (
    <div class="mc">
      <Rail
        repos={repos}
        snapshot={snapshot}
        filter={filter}
        onFilter={(next) => setFilter(next)}
      />
      <div class="pane center">
        <div class="toolbar">
          <input
            ref={searchRef}
            class="search"
            type="search"
            placeholder="検索（/）"
            aria-label="タイトル・要約・repo名で検索"
            value={filter.query}
            onInput={(e) => setFilter({ ...filter, query: e.currentTarget.value })}
          />
          <div class="seg" role="group" aria-label="セッション一覧の表示">
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
          <button
            type="button"
            class="btn primary"
            onClick={() => setLaunchOpen(true)}
            title="新規セッション（n）"
          >
            ＋ 新規
          </button>
          <button
            type="button"
            class="btn"
            title="ウィンドウをReloadする"
            onClick={() =>
              void bridge.reloadWindow().then((result) => {
                if (!result.ok) {
                  setToast(result.error ?? 'Reloadを取りやめました');
                }
              })
            }
          >
            Reload
          </button>
          <button type="button" class="btn" onClick={() => setHelpOpen(true)} title="キー操作">
            ?
          </button>
        </div>
        <section class="section" aria-label="Inbox">
          <h2 class="pane-title">Inbox（{String(pending.length + resumable.length)}）</h2>
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
          {groups.length === 0 ? (
            <p class="empty">セッションはありません。</p>
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
                      now={now}
                      stallMs={snapshot.stallMs}
                      selected={selected === sessionRowId(session)}
                      onSelect={() => setSelected(sessionRowId(session))}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
      <div class="pane" ref={detailRef} aria-label="詳細">
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
            turns={turns[targetKey(selectedPending)]}
            formKeys={formKeys}
            submit={submitFor(selectedPending)}
            onReload={() => loadApprovals(selectedPending)}
            onReloadTurns={() => loadTurns(selectedPending)}
            onSessionAction={sessionAction}
          />
        ) : selectedSession !== undefined ? (
          <SessionDetail
            key={selectedSession.key}
            session={selectedSession}
            bridge={bridge}
            onToast={setToast}
            now={now}
            stallMs={snapshot.stallMs}
            onSend={(text) => sendTo(selectedSession, text)}
            pending={(snapshot.pending ?? []).filter(
              (p) =>
                p.windowId === selectedSession.windowId &&
                p.threadId === selectedSession.threadId &&
                p.provider === selectedSession.provider,
            )}
            turns={turns[targetKey(selectedSession)]}
            onSelectPending={(item) => setSelected(pendingRowId(item))}
            onReloadTurns={() => loadTurns(selectedSession)}
            onSessionAction={sessionAction}
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
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
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
      <div class="toast" role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}

function Rail(props: {
  repos: readonly McRepo[];
  snapshot: McSnapshot;
  filter: McFilter;
  onFilter: (filter: McFilter) => void;
}): JSX.Element {
  const { filter, onFilter } = props;
  const providers: Array<[McProviderFilter, string]> = [
    ['all', 'すべて'],
    ['codex', 'Codex'],
    ['claude', 'Claude'],
  ];
  const activityCounts = countByActivity(props.snapshot.sessions, props.repos, filter);
  return (
    <nav class="pane" aria-label="repo">
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

/** 状態のピル。実行中で出力が止まっていれば「停滞」にする（Issue #2137の5）。 */
function ActivityPill(props: { session: McSession; now: number; stallMs: number }): JSX.Element {
  const { session, now, stallMs } = props;
  const since = stalledSince(session);
  if (isStalled(session, now, stallMs) && since !== undefined) {
    return (
      <span class="pill stalled" title="実行中ですが、出力が止まっています">
        停滞 {formatElapsed(now - since)}
      </span>
    );
  }
  return <span class={`pill ${session.activity}`}>{ACTIVITY_LABELS[session.activity]}</span>;
}

function SessionRow(props: {
  session: McSession;
  now: number;
  stallMs: number;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { session } = props;
  return (
    <div
      class={props.selected ? 'row selected' : 'row'}
      data-row={sessionRowId(session)}
      role="option"
      aria-selected={props.selected}
      onClick={props.onSelect}
    >
      <ProviderIcon provider={session.provider} />
      <span class="row-title">{session.title}</span>
      <span class="row-meta">
        <ActivityPill session={session} now={props.now} stallMs={props.stallMs} />{' '}
        {formatElapsed(props.now - session.activitySince)}
      </span>
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
        {session.pendingCount > 0 ? ` · 要対応 ${String(session.pendingCount)}` : ''}
      </span>
    </div>
  );
}

function SessionActions(props: {
  session: McSession;
  onSessionAction: (session: McSession, action: McControlAction, done: string) => void;
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
    </div>
  );
}

function Turns(props: {
  turns: Loadable<McTurn[]> | undefined;
  onReload: () => void;
}): JSX.Element {
  const { turns } = props;
  return (
    <div>
      <h3>
        直近のやり取り{' '}
        <button type="button" class="btn" onClick={props.onReload}>
          再読込
        </button>
      </h3>
      {turns === undefined || turns.status === 'loading' ? (
        <p class="notice">取り寄せ中…</p>
      ) : turns.status === 'error' ? (
        <p class="error">{turns.error}</p>
      ) : turns.value.length === 0 ? (
        <p class="notice">やり取りはまだありません。</p>
      ) : (
        turns.value.map((turn, index) => (
          <div key={String(index)} class={`turn ${turn.role}`}>
            <p class="turn-role">{turn.role === 'user' ? 'あなた' : 'エージェント'}</p>
            <p class="turn-text">
              {turn.text}
              {turn.truncated ? '…（続きはチャットタブで）' : ''}
            </p>
          </div>
        ))
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
  turns: Loadable<McTurn[]> | undefined;
  formKeys: FormKeysRef;
  submit: Submit;
  onReload: () => void;
  onReloadTurns: () => void;
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
      {item.kind === 'taskRunQuestion' ? null : (
        <Turns turns={props.turns} onReload={props.onReloadTurns} />
      )}
    </div>
  );
}

function SessionDetail(props: {
  session: McSession;
  bridge: Bridge;
  onToast: (message: string) => void;
  now: number;
  stallMs: number;
  pending: readonly McPendingItem[];
  turns: Loadable<McTurn[]> | undefined;
  onSelectPending: (item: McPendingItem) => void;
  onReloadTurns: () => void;
  onSessionAction: (session: McSession, action: McControlAction, done: string) => void;
  onSend: (text: string) => Promise<string | undefined>;
}): JSX.Element {
  const { session } = props;
  return (
    <div class="detail">
      <h2>
        <ProviderIcon provider={session.provider} /> {session.title}
      </h2>
      <p class="notice" title={session.cwdFull}>
        <ActivityPill session={session} now={props.now} stallMs={props.stallMs} />{' '}
        {formatElapsed(props.now - session.activitySince)} · {session.cwdLabel} ·{' '}
        {session.isCurrentWindow ? 'このウィンドウ' : '別ウィンドウ'}
      </p>
      <SessionActions session={session} onSessionAction={props.onSessionAction} />
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
      <Turns turns={props.turns} onReload={props.onReloadTurns} />
      <Composer onSend={props.onSend} />
      <SideQuestionForm session={session} bridge={props.bridge} />
    </div>
  );
}

/**
 * 指示の入力欄（Issue #2137の4）。送信中は二重に送らせず、失敗の理由は入力を残したまま出す。
 * Ctrl+Enter（macOSはCmd+Enter）でも送る。
 */
function Composer(props: { onSend: (text: string) => Promise<string | undefined> }): JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = (): void => {
    if (sending || text.trim() === '') {
      return;
    }
    setSending(true);
    setError(undefined);
    void props.onSend(text).then((failure) => {
      setSending(false);
      if (failure === undefined) {
        setText('');
      } else {
        setError(failure);
      }
    });
  };
  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>指示を送る</h3>
      <textarea
        class="text-input composer-input"
        rows={3}
        aria-label="会話へ送る指示"
        placeholder="会話へ送る指示（Ctrl+Enterで送信）"
        value={text}
        disabled={sending}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="actions">
        <button type="submit" class="btn primary" disabled={sending || text.trim() === ''}>
          {sending ? '送信中…' : '送信'}
        </button>
      </div>
      {error === undefined ? null : (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </form>
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

  useEffect(() => {
    void bridge.launchOptions().then((result) => {
      if (!result.ok) {
        setRepos({ status: 'error', error: result.error ?? '候補を取り寄せられませんでした' });
        return;
      }
      const list = result.repos ?? [];
      setRepos({ status: 'ok', value: list });
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
    void bridge.launch({ cwd: chosen.path, provider, prompt, worktree }).then((result) => {
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
            onClick={() => setProvider('codex')}
          >
            Codex
          </button>
          <button
            type="button"
            aria-pressed={provider === 'claude'}
            disabled={busy}
            onClick={() => setProvider('claude')}
          >
            Claude
          </button>
        </div>
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
        <p class="notice">modelは各CLIの既定で起動します（会話のタブで変えられます）。</p>
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
        <table>
          <tbody>
            {KEY_HELP.map(([key, label]) => (
              <tr key={key}>
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
