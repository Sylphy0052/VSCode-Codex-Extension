import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import type { McWorkUnit, McWorkUnitSort } from './protocol';
import {
  WORK_UNIT_PERIODS,
  WORK_UNIT_SORTS,
  formatWorkUnitConsumption,
  formatWorkUnitPeriod,
  nextWorkUnitPeriod,
  nextWorkUnitSort,
  sortWorkUnits,
  workUnitHeading,
  workUnitPeriodLabel,
  workUnitSortLabel,
} from './workUnitsLogic';

type WorkUnitsState =
  | { status: 'loading' }
  | { status: 'ok'; units: McWorkUnit[] }
  | { status: 'error'; error: string };

/**
 * 作業単位（Issue番号ごと・handoffの連鎖ごと）の使用量の一覧（Issue #2177）。
 * `s`で並べ替えの基準、`p`で集計の期間を切り替え、↑ / ↓（j / k）で移動する。Escは`App`の
 * キー処理が受け持つ。
 */
export function WorkUnitsDialog(props: { bridge: Bridge; onClose: () => void }): JSX.Element {
  const { bridge } = props;
  const [days, setDays] = useState(WORK_UNIT_PERIODS[0] ?? 30);
  const [sort, setSort] = useState<McWorkUnitSort>(WORK_UNIT_SORTS[0]?.[0] ?? 'cost');
  const [state, setState] = useState<WorkUnitsState>({ status: 'loading' });
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void bridge.workUnits(days).then((result) => {
      if (!alive) return;
      setState(
        result.ok
          ? { status: 'ok', units: result.workUnits ?? [] }
          : { status: 'error', error: result.error ?? '作業単位を集計できませんでした' },
      );
    });
    return () => {
      alive = false;
    };
  }, [bridge, days]);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const units = useMemo(
    () => (state.status === 'ok' ? sortWorkUnits(state.units, sort) : []),
    [state, sort],
  );
  const index = Math.min(cursor, Math.max(units.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-work-unit="${String(index)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const changeSort = (): void => {
    setSort((s) => nextWorkUnitSort(s));
    setCursor(0);
  };
  const changePeriod = (): void => {
    setDays((d) => nextWorkUnitPeriod(d));
    setCursor(0);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
      return;
    }
    const last = Math.max(units.length - 1, 0);
    if (e.key === 'ArrowDown' || (e.key === 'j' && !e.shiftKey)) {
      e.preventDefault();
      setCursor((c) => Math.min(Math.min(c, last) + 1, last));
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && !e.shiftKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(Math.min(c, last) - 1, 0));
    } else if (e.key === 's' && !e.shiftKey) {
      e.preventDefault();
      changeSort();
    } else if (e.key === 'p' && !e.shiftKey) {
      e.preventDefault();
      changePeriod();
    }
  };

  return (
    <div
      class="help"
      role="dialog"
      aria-label="作業単位ごとの使用量"
      data-reserved-keys="jksp"
      onKeyDown={onKeyDown}
    >
      <div class="help-box history-box" ref={boxRef} tabIndex={-1}>
        <h2>作業単位ごとの使用量（Issue番号・handoffの連鎖）</h2>
        <p class="notice">
          並べ替え: {workUnitSortLabel(sort)}の多い順 ・ 期間: {workUnitPeriodLabel(days)}
          。利用枠の消費は、計測の間にターンを終えたセッションへ割り当てた概算です。
        </p>
        {state.status === 'loading' ? <p class="notice">作業履歴を集計中…</p> : null}
        {state.status === 'error' ? <p class="error">{state.error}</p> : null}
        {state.status === 'ok' && units.length === 0 ? (
          <p class="empty">この期間の作業履歴はありません。</p>
        ) : null}
        <div class="history-list" ref={listRef} role="listbox" aria-label="作業単位の一覧">
          {units.map((unit, i) => (
            <div
              key={unit.key}
              data-work-unit={String(i)}
              class={i === index ? 'row selected' : 'row'}
              role="option"
              aria-selected={i === index}
              onClick={() => setCursor(i)}
            >
              <span class="row-title">{workUnitHeading(unit)}</span>
              <span class="row-meta">
                {String(unit.sessionCount)}セッション · {formatWorkUnitPeriod(unit)}
              </span>
              <span class="row-sub" title={unit.branch}>
                {formatWorkUnitConsumption(unit)}
              </span>
            </div>
          ))}
        </div>
        <div class="actions">
          <button type="button" class="btn" onClick={changeSort}>
            並べ替えを変える（s）
          </button>
          <button type="button" class="btn" onClick={changePeriod}>
            期間を変える（p）
          </button>
          <button type="button" class="btn" onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}
