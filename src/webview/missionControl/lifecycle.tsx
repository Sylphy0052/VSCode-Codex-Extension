/**
 * Mission Control段階5（Issue #2149）の画面部品。セッションの閉じる・archive・delete、
 * 開始ダイアログの起動オプション、履歴の検索と再開。
 */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import { ProviderIcon } from './icons';
import {
  EMPTY_HISTORY_FILTER,
  filterHistory,
  historyRepos,
  LIFECYCLE_LABELS,
  type McHistoryFilter,
} from './logic';
import type {
  McHistoryItem,
  McLaunchChoices,
  McLaunchSettings,
  McLifecycleOp,
  McProvider,
} from './protocol';

const PROVIDER_LABELS: Record<McProvider, string> = { codex: 'Codex', claude: 'Claude' };

/** Claude Codeにはarchiveの仕組みが無いので、閉じる操作だけに対応する。 */
export function supportsArchive(provider: McProvider): boolean {
  return provider === 'codex';
}

/**
 * providerを変えたときなどに、候補に無くなった値を外す。プリセットはproviderが違えば外す。
 */
export function normalizeLaunchSettings(
  provider: McProvider,
  settings: McLaunchSettings,
  choices: McLaunchChoices | undefined,
): McLaunchSettings {
  if (choices === undefined) {
    return settings;
  }
  const list = choices.providers[provider];
  const preset = choices.presets.find((p) => p.name === settings.preset && p.provider === provider);
  const model = list.models.find((m) => m.slug === settings.model);
  const efforts = model === undefined ? list.efforts : model.efforts;
  return {
    preset: preset?.name,
    model: model?.slug,
    effort:
      settings.effort !== undefined && efforts.includes(settings.effort)
        ? settings.effort
        : undefined,
    approval: list.approvals.some((a) => a.value === settings.approval)
      ? settings.approval
      : undefined,
  };
}

/** 開始ダイアログのmodel・effort・承認方針・プリセットの選択欄。 */
export function LaunchSettingsFields(props: {
  choices: McLaunchChoices | undefined;
  provider: McProvider;
  value: McLaunchSettings;
  disabled: boolean;
  onChange: (next: McLaunchSettings) => void;
  /** プリセットを選んだら、そのproviderへ切り替える。 */
  onProvider: (provider: McProvider) => void;
}): JSX.Element | null {
  const { choices, provider, value } = props;
  if (choices === undefined) {
    return null;
  }
  const list = choices.providers[provider];
  const preset = choices.presets.find((p) => p.name === value.preset);
  const model = list.models.find((m) => m.slug === value.model);
  const efforts = model === undefined ? list.efforts : model.efforts;
  // 「既定」が何になるかを見せる。プリセットを選んでいればその値、無ければ拡張機能の設定
  const base = {
    model: preset?.model || list.current.model,
    effort: preset?.effort || list.current.effort,
    approval: preset?.approval || list.current.approval,
  };
  const baseLabel = preset === undefined ? '設定のまま' : 'プリセットのまま';
  const approvalLabel = (v: string): string =>
    list.approvals.find((a) => a.value === v)?.label ?? v;
  const set = (patch: McLaunchSettings): void => props.onChange({ ...value, ...patch });

  return (
    <div class="launch-grid">
      <label>
        プリセット
        <select
          class="text-input"
          aria-label="プリセット"
          value={value.preset ?? ''}
          disabled={props.disabled}
          onChange={(e) => {
            const name = e.currentTarget.value;
            const next = choices.presets.find((p) => p.name === name);
            if (next !== undefined && next.provider !== provider) {
              props.onProvider(next.provider);
            }
            set({ preset: next?.name });
          }}
        >
          <option value="">使わない</option>
          {choices.presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}（{PROVIDER_LABELS[p.provider]}）
            </option>
          ))}
        </select>
      </label>
      <label>
        model
        <select
          class="text-input"
          aria-label="model"
          value={value.model ?? ''}
          disabled={props.disabled}
          onChange={(e) => {
            const slug = e.currentTarget.value;
            const next = list.models.find((m) => m.slug === slug);
            const nextEfforts = next === undefined ? list.efforts : next.efforts;
            set({
              model: next?.slug,
              effort:
                value.effort !== undefined && nextEfforts.includes(value.effort)
                  ? value.effort
                  : undefined,
            });
          }}
        >
          <option value="">
            {baseLabel}
            {base.model === '' ? '' : `（${base.model}）`}
          </option>
          {list.models.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        effort
        <select
          class="text-input"
          aria-label="effort"
          value={value.effort ?? ''}
          disabled={props.disabled || efforts.length === 0}
          onChange={(e) => set({ effort: e.currentTarget.value || undefined })}
        >
          <option value="">
            {baseLabel}
            {base.effort === '' ? '' : `（${base.effort}）`}
          </option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
      <label>
        承認方針
        <select
          class="text-input"
          aria-label="承認方針"
          value={value.approval ?? ''}
          disabled={props.disabled}
          onChange={(e) => set({ approval: e.currentTarget.value || undefined })}
        >
          <option value="">
            {baseLabel}
            {base.approval === '' ? '' : `（${approvalLabel(base.approval)}）`}
          </option>
          {list.approvals.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** 複数選択（`x`）したセッションへまとめて行う操作の帯。 */
export function MarkBar(props: {
  count: number;
  onOp: (op: McLifecycleOp) => void;
  onClear: () => void;
}): JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <div class="mark-bar" role="group" aria-label="選択したセッションの操作">
      <span>{String(props.count)}件を選択中</span>
      <button
        type="button"
        class="btn"
        onClick={() => props.onOp('close')}
        title="閉じる（c）"
        data-key-label="c"
      >
        閉じる
      </button>
      <button
        type="button"
        class="btn"
        onClick={() => props.onOp('archive')}
        title="archive（e）"
        data-key-label="e"
      >
        archive
      </button>
      <button
        type="button"
        class="btn"
        onClick={() => props.onOp('delete')}
        title="削除（Shift+D）"
        data-key-label="Shift+D"
      >
        削除
      </button>
      <button
        type="button"
        class="btn"
        onClick={props.onClear}
        title="選択を外す（Esc）"
        data-key-label="Esc"
      >
        選択を外す
      </button>
    </div>
  );
}

/** セッションの詳細に出す閉じる・archive・削除のボタン。 */
export function LifecycleButtons(props: {
  provider: McProvider;
  marked: boolean;
  onOp: (op: McLifecycleOp) => void;
  onToggleMark: () => void;
}): JSX.Element {
  const archivable = supportsArchive(props.provider);
  const reason = archivable ? undefined : 'Claude Codeのセッションはarchive・削除できません';
  return (
    <div class="actions">
      <button
        type="button"
        class="btn"
        onClick={props.onToggleMark}
        title="複数選択（x）"
        data-key-label="x"
      >
        {props.marked ? '選択を外す' : '選択に加える'}
      </button>
      <button
        type="button"
        class="btn"
        onClick={() => props.onOp('close')}
        title="閉じる（c）"
        data-key-label="c"
      >
        {LIFECYCLE_LABELS.close}
      </button>
      <button
        type="button"
        class="btn"
        disabled={!archivable}
        onClick={() => props.onOp('archive')}
        title={reason ?? 'archive（e）。履歴から開き直せます'}
        data-key-label="e"
      >
        {LIFECYCLE_LABELS.archive}
      </button>
      <button
        type="button"
        class="btn"
        disabled={!archivable}
        onClick={() => props.onOp('delete')}
        title={reason ?? '削除（Shift+D）。元に戻せません'}
        data-key-label="Shift+D"
      >
        {LIFECYCLE_LABELS.delete}
      </button>
    </div>
  );
}

/** 一度に描く履歴の上限。多いときは絞り込んでもらう。 */
const HISTORY_SHOWN_MAX = 200;

type HistoryState =
  | { status: 'loading' }
  | { status: 'ok'; items: McHistoryItem[] }
  | { status: 'error'; error: string };

function formatDate(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString('ja-JP') : '日時不明';
}

/**
 * 履歴（archive済みを含む）の検索と再開（Issue #2149の3）。↑ / ↓で選び、Enterで開き直す。
 * Escは`App`のキー処理が受け持つ。
 */
export function HistoryDialog(props: {
  bridge: Bridge;
  onClose: () => void;
  onOpened: (message: string) => void;
}): JSX.Element {
  const { bridge } = props;
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [filter, setFilter] = useState<McHistoryFilter>(EMPTY_HISTORY_FILTER);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const queryRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void bridge.history().then((result) => {
      setState(
        result.ok
          ? { status: 'ok', items: result.history ?? [] }
          : { status: 'error', error: result.error ?? '履歴を取り寄せられませんでした' },
      );
    });
    queryRef.current?.focus();
  }, [bridge]);

  const items = state.status === 'ok' ? state.items : [];
  const repos = useMemo(() => historyRepos(items), [items]);
  const matched = useMemo(() => filterHistory(items, filter), [items, filter]);
  const shown = matched.slice(0, HISTORY_SHOWN_MAX);
  const index = Math.min(cursor, Math.max(shown.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-history="${String(index)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const update = (patch: Partial<McHistoryFilter>): void => {
    setFilter((prev) => ({ ...prev, ...patch }));
    setCursor(0);
  };
  const open = (item: McHistoryItem | undefined): void => {
    if (item === undefined || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    void bridge.historyOpen(item.provider, item.threadId).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '開けませんでした');
        return;
      }
      props.onOpened(`「${item.title}」を開きました`);
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    // 日付欄・選択欄の矢印は値を変える標準の操作に任せる
    const ownsArrows =
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLInputElement && target.type === 'date');
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !ownsArrows) {
      e.preventDefault();
      setCursor((c) => {
        const current = Math.min(c, Math.max(shown.length - 1, 0));
        return e.key === 'ArrowDown'
          ? Math.min(current + 1, Math.max(shown.length - 1, 0))
          : Math.max(current - 1, 0);
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
      open(shown[index]);
    }
  };

  return (
    <div class="help" role="dialog" aria-label="履歴" onKeyDown={onKeyDown}>
      <div class="help-box history-box">
        <h2>履歴（archive済みを含む）</h2>
        <div class="history-filter">
          <input
            ref={queryRef}
            class="text-input"
            type="search"
            placeholder="タイトル・repo名で検索"
            aria-label="タイトル・repo名で検索"
            value={filter.query}
            onInput={(e) => update({ query: e.currentTarget.value })}
          />
          <select
            class="text-input"
            aria-label="repoで絞る"
            value={filter.repoKey}
            onChange={(e) => update({ repoKey: e.currentTarget.value })}
          >
            <option value="">すべてのrepo</option>
            {repos.map((repo) => (
              <option key={repo.key} value={repo.key}>
                {repo.label}
              </option>
            ))}
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
        {state.status === 'loading' ? <p class="notice">履歴を取り寄せ中…</p> : null}
        {state.status === 'error' ? <p class="error">{state.error}</p> : null}
        {state.status === 'ok' && matched.length === 0 ? (
          <p class="empty">一致する履歴はありません。</p>
        ) : null}
        <div class="history-list" ref={listRef} role="listbox" aria-label="履歴の一覧">
          {shown.map((item, i) => (
            <div
              key={`${item.provider}:${item.threadId}`}
              data-history={String(i)}
              class={i === index ? 'row selected' : 'row'}
              role="option"
              aria-selected={i === index}
              onClick={() => setCursor(i)}
              onDblClick={() => open(item)}
            >
              <ProviderIcon provider={item.provider} />
              <span class="row-title">{item.title}</span>
              <span class="row-meta">{formatDate(item.updatedAt)}</span>
              <span class="row-sub" title={item.cwdFull}>
                {item.repoLabel}
                {item.archived ? ' · archive済み' : ''}
              </span>
            </div>
          ))}
        </div>
        {matched.length > shown.length ? (
          <p class="notice">
            ほか{String(matched.length - shown.length)}件あります。絞り込んでください。
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
            disabled={busy || shown[index] === undefined}
            onClick={() => open(shown[index])}
          >
            {busy ? '開いています…' : '再開（Enter）'}
          </button>
          <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}
