import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import { ProviderIcon } from './icons';
import type { McWorkCalendar } from './protocol';
import {
  WEEKDAY_LABELS,
  calendarDayKey,
  calendarDayMap,
  calendarSessionHeading,
  formatCalendarSession,
  formatCellLabel,
  formatCellSummary,
  formatDaySkills,
  formatDaySummary,
  monthGrid,
  shiftDay,
  shiftMonth,
  todayDate,
  workLevel,
  type CalendarDate,
} from './workCalendarLogic';
import { formatWorkUnitConsumption, workUnitHeading } from './workUnitsLogic';

type CalendarState =
  | { status: 'loading' }
  | { status: 'ok'; calendar: McWorkCalendar }
  | { status: 'error'; error: string };

/**
 * 作業履歴カレンダー（Mission Control 段階23。Issue #2179）。月表示のマスに日ごとのセッション数と
 * 費用を出し、選んだ日のセッション数・作業単位・skill・使用量と、その日の全セッション（閉じた
 * ものを含む）を下に出す。
 *
 * キー: ← / →（h / l）で前後の日、↑ / ↓（k / j）で前後の週、[ / ]で前後の月、tで今日、
 * n / pでその日のセッションを選び、Enterで開く。Escは`App`のキー処理が受け持つ。
 */
export function WorkCalendarDialog(props: { bridge: Bridge; onClose: () => void }): JSX.Element {
  const { bridge } = props;
  const [selected, setSelected] = useState<CalendarDate>(() => todayDate());
  const [state, setState] = useState<CalendarState>({ status: 'loading' });
  const [cursor, setCursor] = useState(0);
  const [openError, setOpenError] = useState<string | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { year, month } = selected;

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void bridge.workCalendar(year, month).then((result) => {
      if (!alive) return;
      setState(
        result.ok && result.calendar !== undefined
          ? { status: 'ok', calendar: result.calendar }
          : { status: 'error', error: result.error ?? '作業履歴を読めませんでした' },
      );
    });
    return () => {
      alive = false;
    };
  }, [bridge, year, month]);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const calendar = state.status === 'ok' ? state.calendar : undefined;
  const dayMap = useMemo(() => calendarDayMap(calendar), [calendar]);
  const maxSessions = useMemo(
    () => Math.max(0, ...(calendar?.days ?? []).map((d) => d.sessionCount)),
    [calendar],
  );
  const weeks = useMemo(() => monthGrid(year, month), [year, month]);
  const today = calendarDayKey(todayDate());
  const day = dayMap.get(calendarDayKey(selected));
  const sessions = day?.sessions ?? [];
  const index = Math.min(cursor, Math.max(sessions.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-calendar-session="${String(index)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const select = (next: CalendarDate): void => {
    setSelected(next);
    setCursor(0);
    setOpenError(undefined);
  };

  const openSession = (i: number): void => {
    const session = sessions[i];
    if (session === undefined) return;
    setOpenError(undefined);
    const open = async (): Promise<void> => {
      // 開く操作はホストが直前に渡した履歴の一覧と突き合わせるので、先に一覧を取り寄せる
      // （履歴のダイアログで別の一覧に替わっていることもあるので、毎回取り寄せる）
      const listed = await bridge.history();
      if (!listed.ok) {
        setOpenError(listed.error ?? '履歴を読めませんでした');
        return;
      }
      const result = await bridge.historyOpen(session.provider, session.threadId);
      if (result.ok) {
        props.onClose();
      } else {
        // 履歴の一覧（件数の上限あり）に無い古いセッションは開けない
        setOpenError(result.error ?? 'セッションを開けませんでした');
      }
    };
    void open();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
      return;
    }
    const plain = !e.shiftKey;
    const last = Math.max(sessions.length - 1, 0);
    let handled = true;
    if (e.key === 'ArrowLeft' || (e.key === 'h' && plain)) {
      select(shiftDay(selected, -1));
    } else if (e.key === 'ArrowRight' || (e.key === 'l' && plain)) {
      select(shiftDay(selected, 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && plain)) {
      select(shiftDay(selected, -7));
    } else if (e.key === 'ArrowDown' || (e.key === 'j' && plain)) {
      select(shiftDay(selected, 7));
    } else if (e.key === '[') {
      select(shiftMonth(selected, -1));
    } else if (e.key === ']') {
      select(shiftMonth(selected, 1));
    } else if (e.key === 't' && plain) {
      select(todayDate());
    } else if (e.key === 'n' && plain) {
      setCursor((c) => Math.min(Math.min(c, last) + 1, last));
    } else if (e.key === 'p' && plain) {
      setCursor((c) => Math.max(Math.min(c, last) - 1, 0));
    } else if (e.key === 'Enter' && e.target === boxRef.current) {
      openSession(index);
    } else {
      handled = false;
    }
    if (handled) e.preventDefault();
  };

  return (
    <div
      class="help"
      role="dialog"
      aria-label="作業履歴カレンダー"
      data-reserved-keys="hjkltnp"
      onKeyDown={onKeyDown}
    >
      <div class="help-box history-box calendar-box" ref={boxRef} tabIndex={-1}>
        <h2>
          作業履歴カレンダー {String(year)}年{String(month)}月
        </h2>
        <p class="notice">
          ← / →（h / l）で日、↑ / ↓（k / j）で週、[ / ]で月、tで今日。n / pでセッションを選び、
          Enterで開く。
        </p>
        {state.status === 'loading' ? <p class="notice">作業履歴を読み込み中…</p> : null}
        {state.status === 'error' ? <p class="error">{state.error}</p> : null}
        <table class="calendar" role="grid" aria-label={`${String(year)}年${String(month)}月`}>
          <thead>
            <tr>
              {WEEKDAY_LABELS.map((w) => (
                <th key={w} scope="col">
                  {w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi}>
                {week.map((d, di) => {
                  if (d === undefined) return <td key={di} class="calendar-cell outside" />;
                  const date = { year, month, day: d };
                  const key = calendarDayKey(date);
                  const info = dayMap.get(key);
                  const classes = [
                    'calendar-cell',
                    `level-${String(workLevel(info, maxSessions))}`,
                    d === selected.day ? 'selected' : '',
                    key === today ? 'today' : '',
                  ]
                    .filter((c) => c !== '')
                    .join(' ');
                  return (
                    <td
                      key={di}
                      class={classes}
                      role="gridcell"
                      aria-selected={d === selected.day}
                      title={formatCellLabel(date, info)}
                      onClick={() => select(date)}
                    >
                      <span class="calendar-date">{String(d)}</span>
                      <span class="calendar-summary">{formatCellSummary(info)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <h3>
          {String(month)}月{String(selected.day)}日
        </h3>
        {day === undefined ? (
          <p class="empty">{state.status === 'ok' ? 'この日の作業履歴はありません。' : ''}</p>
        ) : (
          <>
            <p class="notice">{formatDaySummary(day)}</p>
            <p class="notice">skill: {formatDaySkills(day)}</p>
            {day.units.length > 0 ? (
              <ul class="calendar-units" aria-label="この日の作業単位">
                {day.units.map((unit) => (
                  <li key={unit.key}>
                    {workUnitHeading(unit)} — {formatWorkUnitConsumption(unit)}
                  </li>
                ))}
              </ul>
            ) : null}
            {openError !== undefined ? <p class="error">{openError}</p> : null}
            <div class="history-list" ref={listRef} role="listbox" aria-label="この日のセッション">
              {sessions.map((session, i) => (
                <div
                  key={`${session.provider}:${session.threadId}`}
                  data-calendar-session={String(i)}
                  class={i === index ? 'row selected' : 'row'}
                  role="option"
                  aria-selected={i === index}
                  onClick={() => setCursor(i)}
                  onDblClick={() => openSession(i)}
                >
                  <ProviderIcon provider={session.provider} />
                  <span class="row-title">{calendarSessionHeading(session)}</span>
                  <span class="row-meta">{session.ended ? '閉じた' : ''}</span>
                  <span class="row-sub" title={session.branch}>
                    {formatCalendarSession(session)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        <div class="actions">
          <button type="button" class="btn" onClick={() => select(shiftMonth(selected, -1))}>
            前の月（[）
          </button>
          <button type="button" class="btn" onClick={() => select(shiftMonth(selected, 1))}>
            次の月（]）
          </button>
          <button
            type="button"
            class="btn"
            disabled={sessions.length === 0}
            onClick={() => openSession(index)}
          >
            セッションを開く（Enter）
          </button>
          <button type="button" class="btn" onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}
