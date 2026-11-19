import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Bridge } from './bridge';
import {
  activeSavedFilter,
  formatCapturedAt,
  formatCostTotal,
  formatUsageSummary,
  formatUsageWindow,
  isUsageLimited,
  oneLine,
  totalCost,
} from './globalLogic';
import { keyLabelFor } from './keys';
import type { McFilter } from './logic';
import type {
  McBooleanPrefKey,
  McPrefs,
  McSavedFilter,
  McSession,
  McUsage,
  McUsageSource,
} from './protocol';

/**
 * ヘッダの費用・利用枠と、MCの設定・絞り込みの保存のダイアログ（Issue #2162）。
 */

/** 拡張ホストの`MAX_FILTER_NAME_CHARS`（`missionControlPrefs.ts`）に合わせる。 */
const MAX_FILTER_NAME_CHARS = 40;
/** 停滞の閾値の範囲（`package.json`の`agent.missionControl.stallMinutes`）。 */
const STALL_MIN = 1;
const STALL_MAX = 1440;

const PROVIDER_USAGE: ReadonlyArray<readonly ['codex' | 'claude', string]> = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
];

export function McHeader(props: {
  sessions: readonly McSession[];
  usage: McUsage | undefined;
  now: number;
  savedFilters: readonly McSavedFilter[];
  filter: McFilter;
  onUsage: () => void;
  onPrefs: () => void;
  onSaveFilter: () => void;
}): JSX.Element {
  const cost = formatCostTotal(totalCost(props.sessions));
  const active = activeSavedFilter(props.savedFilters, props.filter);
  return (
    <header class="mc-header" aria-label="費用と利用枠">
      <button
        type="button"
        class="mc-header-usage"
        onClick={props.onUsage}
        title={`費用と利用枠の詳細（${keyLabelFor('usage') ?? ''}）`}
        data-key-label={keyLabelFor('usage')}
      >
        <span class="mc-header-item" data-usage="cost">
          <span class="notice">費用</span> {cost}
        </span>
        {PROVIDER_USAGE.map(([provider, label]) => {
          const source = props.usage?.[provider];
          return (
            <span
              key={provider}
              class={isUsageLimited(source) ? 'mc-header-item limited' : 'mc-header-item'}
              data-usage={provider}
            >
              <span class="notice">{label}</span> {formatUsageSummary(source, props.now)}
            </span>
          );
        })}
      </button>
      <span class="mc-header-filter" data-saved-filter={active === undefined ? '' : 'active'}>
        <span class="notice">絞り込み</span>{' '}
        {active === undefined
          ? props.savedFilters.length === 0
            ? '保存なし'
            : `保存${String(props.savedFilters.length)}件（${keyLabelFor('savedFilter') ?? ']'}で切替）`
          : oneLine(active.name, MAX_FILTER_NAME_CHARS)}
      </span>
      <button
        type="button"
        class="btn"
        onClick={props.onSaveFilter}
        title={`今の絞り込みを保存（${keyLabelFor('saveFilter') ?? ''}）`}
        data-key-label={keyLabelFor('saveFilter')}
      >
        絞り込みを保存
      </button>
      <button
        type="button"
        class="btn"
        onClick={props.onPrefs}
        title={`Mission Controlの設定（${keyLabelFor('prefs') ?? ''}）`}
        data-key-label={keyLabelFor('prefs')}
      >
        設定
      </button>
    </header>
  );
}

export function UsageDialog(props: {
  sessions: readonly McSession[];
  usage: McUsage | undefined;
  now: number;
  onClose: () => void;
}): JSX.Element {
  const total = totalCost(props.sessions);
  return (
    <div class="help" role="dialog" aria-label="費用と利用枠">
      <div class="help-box">
        <h2>費用と利用枠</h2>
        <h3>費用（開いているセッションの合計）</h3>
        <p data-usage-detail="cost">{formatCostTotal(total)}</p>
        <p class="notice">
          費用はClaude
          Codeのセッションだけ、トークン数はCodexのセッションだけが持ちます。閉じたセッションの分は含みません。
        </p>
        {PROVIDER_USAGE.map(([provider, label]) => (
          <UsageSourceDetail
            key={provider}
            label={label}
            source={props.usage?.[provider]}
            now={props.now}
          />
        ))}
        <p class="notice">
          利用枠はステータスバーと同じ値です。Claude
          Codeはチャット画面を開いている間に届いた値だけを出します。
        </p>
        <div class="actions">
          <button type="button" class="btn" onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}

function UsageSourceDetail(props: {
  label: string;
  source: McUsageSource | undefined;
  now: number;
}): JSX.Element {
  const { source } = props;
  const captured = formatCapturedAt(source, props.now);
  return (
    <section data-usage-detail={props.label}>
      <h3>
        {props.label}の利用枠
        {captured === '' ? null : <span class="notice">（{captured}）</span>}
      </h3>
      {source === undefined || source.windows.length === 0 ? (
        <p class="notice">取得できない（まだ値が届いていません）</p>
      ) : (
        <ul>
          {source.windows.map((w, i) => (
            <li key={String(i)} class={w.limited ? 'limited' : undefined}>
              {formatUsageWindow(w, props.now)}
            </li>
          ))}
        </ul>
      )}
      {source?.plan === undefined ? null : (
        <p class="notice">プラン: {oneLine(source.plan, MAX_FILTER_NAME_CHARS)}</p>
      )}
    </section>
  );
}

const BOOLEAN_PREF_ROWS: ReadonlyArray<readonly [McBooleanPrefKey, string]> = [
  ['notifications.approvalPending', '承認待ち・質問で止まったら通知する'],
  ['notifications.turnComplete', 'ターンが終わったら通知する'],
  ['notifications.sound.enabled', '通知音を鳴らす'],
  ['notifications.sound.turnComplete', '音: ターンが終わったとき'],
  ['notifications.sound.approvalPending', '音: 承認待ち・質問で止まったとき'],
  ['notifications.sound.handoff', '音: 自動引き継ぎの確認が出たとき'],
  ['notifications.sound.onlyWhenHidden', '音: タブが見えているときは鳴らさない'],
];

export function PrefsDialog(props: {
  bridge: Bridge;
  prefs: McPrefs | undefined;
  onClose: () => void;
  onDone: (message: string) => void;
}): JSX.Element {
  const { bridge, prefs } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [stall, setStall] = useState(
    prefs === undefined ? '' : String(prefs['missionControl.stallMinutes']),
  );
  const firstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  if (prefs === undefined) {
    return (
      <div class="help" role="dialog" aria-label="Mission Controlの設定">
        <div class="help-box">
          <h2>Mission Controlの設定</h2>
          <p class="notice">この版の拡張機能からは設定を読めません。</p>
          <div class="actions">
            <button type="button" class="btn" onClick={props.onClose}>
              閉じる（Esc）
            </button>
          </div>
        </div>
      </div>
    );
  }

  const send = (key: Parameters<Bridge['setPref']>[0], value: boolean | number): void => {
    setBusy(true);
    setError(undefined);
    void bridge.setPref(key, value).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '設定を変えられませんでした');
        return;
      }
      props.onDone('設定を変えました');
    });
  };

  const stallValue = Number(stall);
  const stallValid =
    stall.trim() !== '' &&
    Number.isInteger(stallValue) &&
    stallValue >= STALL_MIN &&
    stallValue <= STALL_MAX;
  const submitStall = (e: Event): void => {
    e.preventDefault();
    if (!stallValid || busy || stallValue === prefs['missionControl.stallMinutes']) {
      return;
    }
    send('missionControl.stallMinutes', stallValue);
  };

  return (
    <div class="help" role="dialog" aria-label="Mission Controlの設定">
      <form class="help-box" onSubmit={submitStall}>
        <h2>Mission Controlの設定</h2>
        <label class="check">
          停滞とみなす分数（{String(STALL_MIN)}〜{String(STALL_MAX)}）
          <input
            ref={firstRef}
            class="text-input"
            type="number"
            min={STALL_MIN}
            max={STALL_MAX}
            step={1}
            aria-label="停滞とみなす分数"
            value={stall}
            disabled={busy}
            onInput={(e) => setStall((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div class="actions">
          <button
            type="submit"
            class="btn primary"
            disabled={busy || !stallValid || stallValue === prefs['missionControl.stallMinutes']}
          >
            分数を変える（Enter）
          </button>
        </div>
        <h3>通知</h3>
        {BOOLEAN_PREF_ROWS.map(([key, label]) => (
          <label key={key} class="check" data-pref={key}>
            <input
              type="checkbox"
              checked={prefs[key]}
              disabled={busy}
              onChange={(e) => send(key, (e.currentTarget as HTMLInputElement).checked)}
            />
            {label}
          </label>
        ))}
        <p class="notice">
          チェックを変えるとすぐに設定へ書きます（ユーザー設定。ワークスペースに値があればそちら）。音のファイルと再生コマンドは設定エディタで変えてください。
        </p>
        {error === undefined ? null : (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </form>
    </div>
  );
}

export function SaveFilterDialog(props: {
  bridge: Bridge;
  filter: McFilter;
  savedFilters: readonly McSavedFilter[];
  toSpec: (filter: McFilter) => Parameters<Bridge['saveFilter']>[1];
  onClose: () => void;
  onDone: (message: string) => void;
}): JSX.Element {
  const { bridge } = props;
  const current = activeSavedFilter(props.savedFilters, props.filter);
  const [name, setName] = useState(current?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const normalized = oneLine(name, MAX_FILTER_NAME_CHARS * 2);
  const invalid = normalized === '' || [...normalized].length > MAX_FILTER_NAME_CHARS;
  const overwrite = props.savedFilters.some((f) => f.name === normalized);
  const submit = (e: Event): void => {
    e.preventDefault();
    if (invalid || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    void bridge.saveFilter(normalized, props.toSpec(props.filter)).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '絞り込みを保存できませんでした');
        return;
      }
      props.onDone(`絞り込み「${normalized}」を保存しました`);
    });
  };

  return (
    <div class="help" role="dialog" aria-label="絞り込みの保存">
      <form class="help-box" onSubmit={submit}>
        <h2>今の絞り込みに名前を付けて保存</h2>
        <input
          ref={inputRef}
          class="text-input"
          type="text"
          aria-label="絞り込みの名前"
          maxLength={MAX_FILTER_NAME_CHARS}
          value={name}
          onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
        />
        <p class="notice">
          {overwrite ? '同じ名前の絞り込みを上書きします。' : ''}
          保存した絞り込みは ] / [ で切り替えます。
        </p>
        {error === undefined ? null : (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button type="submit" class="btn primary" disabled={busy || invalid}>
            {busy ? '保存しています…' : '保存（Enter）'}
          </button>
          <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </form>
    </div>
  );
}
