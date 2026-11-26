/**
 * Mission Control段階22（Issue #2178）: handoff台帳。handoff本文を日付・セッション・契機で絞り、
 * 本文の部分一致で探す。本文の読み込みと照合は拡張ホストが行い、ここは条件と結果だけを扱う。
 * ↑ / ↓で選び、Enterで本文をエディタで開く。Escは`App`のキー処理が受け持つ。
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import { ProviderIcon } from './icons';
import { EMPTY_LEDGER_FILTER, toHandoffQuery, type McLedgerFilter } from './ledgerLogic';
import type { McHandoffItem, McHandoffListing } from './protocol';

/** 入力が止まってから問い合わせるまでの時間。本文の照合はファイルを読むので打鍵ごとには送らない。 */
const LEDGER_DEBOUNCE_MS = 300;

type LedgerState =
  | { status: 'loading' }
  | { status: 'ok'; listing: McHandoffListing }
  | { status: 'error'; error: string };

function formatDate(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString('ja-JP') : '日時不明';
}

const TRIGGER_LABELS: Record<McHandoffItem['trigger'], string> = {
  manual: '手動',
  auto: '自動',
  unknown: '契機不明',
};

export function HandoffLedgerDialog(props: {
  bridge: Bridge;
  /** 開いたときのセッションの絞り込み（履歴から「handoffを見る」で来たとき）。 */
  initialSession?: string | undefined;
  onClose: () => void;
  /** 選んだhandoffのセッションを履歴で探す。 */
  onShowSession: (sessionId: string) => void;
}): JSX.Element {
  const { bridge } = props;
  const [filter, setFilter] = useState<McLedgerFilter>({
    ...EMPTY_LEDGER_FILTER,
    session: props.initialSession ?? '',
  });
  const [state, setState] = useState<LedgerState>({ status: 'loading' });
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const queryRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    queryRef.current?.focus();
  }, []);

  useEffect(() => {
    requestId.current += 1;
    const id = requestId.current;
    setState((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }));
    const timer = setTimeout(() => {
      void bridge.handoffLedger(toHandoffQuery(filter)).then((result) => {
        // 入力が進んだ後に届いた古い応答は捨てる
        if (id !== requestId.current) {
          return;
        }
        setState(
          result.ok && result.handoffs !== undefined
            ? { status: 'ok', listing: result.handoffs }
            : { status: 'error', error: result.error ?? 'handoff台帳を取り寄せられませんでした' },
        );
      });
    }, LEDGER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [bridge, filter]);

  const items = state.status === 'ok' ? state.listing.items : [];
  const index = Math.min(cursor, Math.max(items.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-ledger="${String(index)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const update = (patch: Partial<McLedgerFilter>): void => {
    setFilter((prev) => ({ ...prev, ...patch }));
    setCursor(0);
  };
  const open = (item: McHandoffItem | undefined): void => {
    if (item === undefined || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    void bridge.handoffOpen(item.name).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '開けませんでした');
      }
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    const ownsArrows =
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLInputElement && target.type === 'date');
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !ownsArrows) {
      e.preventDefault();
      setCursor((c) => {
        const last = Math.max(items.length - 1, 0);
        const current = Math.min(c, last);
        return e.key === 'ArrowDown' ? Math.min(current + 1, last) : Math.max(current - 1, 0);
      });
      return;
    }
    if (
      e.key === 'Enter' &&
      !e.isComposing &&
      !(target instanceof HTMLButtonElement) &&
      !(target instanceof HTMLSelectElement)
    ) {
      e.preventDefault();
      open(items[index]);
    }
  };

  const selected = items[index];
  const listing = state.status === 'ok' ? state.listing : undefined;
  return (
    <div class="help" role="dialog" aria-label="handoff台帳" onKeyDown={onKeyDown}>
      <div class="help-box history-box">
        <h2>handoff台帳</h2>
        <div class="ledger-filter">
          <input
            ref={queryRef}
            class="text-input"
            type="search"
            placeholder="本文の部分一致で検索"
            aria-label="本文の部分一致で検索"
            value={filter.query}
            onInput={(e) => update({ query: e.currentTarget.value })}
          />
          <input
            class="text-input"
            type="search"
            placeholder="セッションID・作業ディレクトリ"
            aria-label="セッションID・作業ディレクトリで絞る"
            value={filter.session}
            onInput={(e) => update({ session: e.currentTarget.value })}
          />
          <select
            class="text-input"
            aria-label="契機で絞る"
            value={filter.trigger}
            onChange={(e) =>
              update({ trigger: e.currentTarget.value as McLedgerFilter['trigger'] })
            }
          >
            <option value="all">すべての契機</option>
            <option value="manual">手動</option>
            <option value="auto">自動</option>
          </select>
          <input
            class="text-input"
            type="date"
            aria-label="この日から"
            value={filter.from}
            onInput={(e) => update({ from: e.currentTarget.value })}
          />
          <input
            class="text-input"
            type="date"
            aria-label="この日まで"
            value={filter.to}
            onInput={(e) => update({ to: e.currentTarget.value })}
          />
        </div>
        {state.status === 'loading' ? <p class="notice">handoffを読み込み中…</p> : null}
        {state.status === 'error' ? <p class="error">{state.error}</p> : null}
        {listing !== undefined && listing.items.length === 0 ? (
          <p class="empty">一致するhandoffはありません。</p>
        ) : null}
        <div class="history-list" ref={listRef} role="listbox" aria-label="handoffの一覧">
          {items.map((item, i) => (
            <div
              key={item.name}
              data-ledger={String(i)}
              class={i === index ? 'row selected' : 'row'}
              role="option"
              aria-selected={i === index}
              onClick={() => setCursor(i)}
              onDblClick={() => open(item)}
            >
              {item.provider === undefined ? <span /> : <ProviderIcon provider={item.provider} />}
              <span class="row-title">{item.request === '' ? item.sessionId : item.request}</span>
              <span class="row-meta">{formatDate(item.createdAt)}</span>
              <span class="row-sub" title={item.cwdFull}>
                {TRIGGER_LABELS[item.trigger]}
                {item.triggerLabel === '' ? '' : `（${item.triggerLabel}）`} · {item.repoLabel}
                {item.branch === '' ? '' : ` · ${item.branch}`} · {item.sessionId}
              </span>
              {item.snippet === undefined ? null : (
                <span class="row-sub prompt">{item.snippet}</span>
              )}
            </div>
          ))}
        </div>
        {listing !== undefined ? (
          <p class="notice">
            {filter.query.trim() === ''
              ? `${String(listing.total)}件中${String(listing.items.length)}件を表示`
              : `条件に合う${String(listing.total)}件のうち、本文が一致した${String(listing.items.length)}件`}
            {listing.truncated ? '（上限で打ち切り。絞り込んでください）' : ''}
          </p>
        ) : null}
        {error === undefined ? null : (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button
            type="button"
            class="btn primary"
            disabled={busy || selected === undefined}
            onClick={() => open(selected)}
          >
            本文を開く
          </button>
          <button
            type="button"
            class="btn"
            disabled={selected === undefined}
            onClick={() => {
              if (selected !== undefined) {
                props.onShowSession(selected.sessionId);
              }
            }}
          >
            履歴でセッションを探す
          </button>
          <button type="button" class="btn" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
