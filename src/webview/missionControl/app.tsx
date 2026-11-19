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
import { KindIcon, ProviderIcon } from './icons';
import {
  ACTIVITY_LABELS,
  EMPTY_FILTER,
  filterPending,
  filterSessions,
  formatElapsed,
  groupSessionsByRepo,
  KEY_HELP,
  mapKey,
  moveSelection,
  needsApprovalDetail,
  PENDING_KIND_LABELS,
  type McFilter,
  type McProviderFilter,
} from './logic';
import type {
  McApprovalDetail,
  McControlAction,
  McPendingItem,
  McRepo,
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
  const lastIndex = useRef(0);

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
  const rowIds = useMemo(
    () => [...pending.map(pendingRowId), ...groups.flatMap((g) => g.sessions.map(sessionRowId))],
    [pending, groups],
  );

  // 選択中の行が消えた（回答済み・絞り込み）ら、同じ位置の行へ移す。未選択なら先頭を選ぶ
  useEffect(() => {
    if (snapshot === undefined) {
      return;
    }
    const index = selected === undefined ? -1 : rowIds.indexOf(selected);
    if (index >= 0) {
      lastIndex.current = index;
      return;
    }
    const next = rowIds[Math.min(lastIndex.current, rowIds.length - 1)];
    if (next !== selected) {
      setSelected(next);
    }
  }, [snapshot, rowIds, selected]);

  const selectedPending = pending.find((item) => pendingRowId(item) === selected);
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

  // キーボード操作（Issue #2136の5）。最新の状態をrefで読む
  const latest = useRef({ rowIds, selected, helpOpen });
  latest.current = { rowIds, selected, helpOpen };
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
          formKeys.current?.reply();
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
          <button type="button" class="btn" onClick={() => setHelpOpen(true)} title="キー操作">
            ?
          </button>
        </div>
        <section class="section" aria-label="Inbox">
          <h2 class="pane-title">Inbox（{String(pending.length)}）</h2>
          {pending.length === 0 ? (
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
        </section>
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
            session={selectedSession}
            now={now}
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
        ) : (
          <p class="empty">項目を選ぶと詳細が出ます（j / kで移動）。</p>
        )}
      </div>
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
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

function SessionRow(props: {
  session: McSession;
  now: number;
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
        <span class={`pill ${session.activity}`}>{ACTIVITY_LABELS[session.activity]}</span>{' '}
        {formatElapsed(props.now - session.activitySince)}
      </span>
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
  now: number;
  pending: readonly McPendingItem[];
  turns: Loadable<McTurn[]> | undefined;
  onSelectPending: (item: McPendingItem) => void;
  onReloadTurns: () => void;
  onSessionAction: (session: McSession, action: McControlAction, done: string) => void;
}): JSX.Element {
  const { session } = props;
  return (
    <div class="detail">
      <h2>
        <ProviderIcon provider={session.provider} /> {session.title}
      </h2>
      <p class="notice" title={session.cwdFull}>
        <span class={`pill ${session.activity}`}>{ACTIVITY_LABELS[session.activity]}</span>{' '}
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
      <Turns turns={props.turns} onReload={props.onReloadTurns} />
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
