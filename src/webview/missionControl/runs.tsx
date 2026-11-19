import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import type {
  McIssueListing,
  McProvider,
  McRun,
  McRunOp,
  McRunsSnapshot,
  McRunState,
} from './protocol';

/** 表示順。 */
const STATE_ORDER: Array<[McRunState, string]> = [
  ['running', '実行中'],
  ['waiting', '待機'],
  ['suspended', '中断'],
  ['finished', '完了'],
];

/** 一覧の並び（state別にグループ。j / kの移動順と描画順を揃える）。 */
export function orderRuns(runs: readonly McRun[]): McRun[] {
  return STATE_ORDER.flatMap(([state]) => runs.filter((r) => r.state === state));
}

export function RunsPane(props: {
  runs: McRunsSnapshot | undefined;
  selectedRun: string | undefined;
  onSelect: (runId: string) => void;
  onOp: (op: McRunOp) => void;
  onParallel: (delta: 1 | -1) => void;
  onStart: () => void;
  onIssues: () => void;
  tabButtons: JSX.Element;
}): JSX.Element {
  const { runs, selectedRun } = props;
  if (runs === undefined) {
    return (
      <div class="pane runs-pane" style={{ gridColumn: '2 / 4' }}>
        <p class="empty">オーケストレータモードは使えません。</p>
      </div>
    );
  }
  const run = runs.runs.find((r) => r.runId === selectedRun);
  const halted = run?.halted === true;
  const disabled = run === undefined;
  return (
    <div class="pane runs-pane" style={{ gridColumn: '2 / 4' }}>
      <div class="toolbar">
        {props.tabButtons}
        <button type="button" class="btn primary" onClick={props.onStart} title="新しいrun（n）">
          ＋ 新しいrun
        </button>
        <button
          type="button"
          class="btn"
          onClick={props.onIssues}
          title="roadmap・Issueから起動（i）"
        >
          roadmap / Issueから起動
        </button>
      </div>
      <section class="section" aria-label="run一覧">
        {runs.runs.length === 0 ? <p class="empty">runはありません。</p> : null}
        {STATE_ORDER.map(([state, label]) => {
          const group = runs.runs.filter((r) => r.state === state);
          if (group.length === 0) {
            return null;
          }
          return (
            <div key={state}>
              <h3 class="group-title">
                {label}
                <span class="count">{String(group.length)}</span>
              </h3>
              {group.map((r) => (
                <div
                  key={r.runId}
                  data-row={`run:${r.runId}`}
                  class={r.runId === selectedRun ? 'row run-row selected' : 'row run-row'}
                  onClick={() => props.onSelect(r.runId)}
                >
                  <span />
                  <span class="row-title">
                    {r.label}
                    <span class="pill" style={{ marginLeft: '6px' }}>
                      {r.status}
                    </span>
                  </span>
                  <span class="row-meta">
                    {r.engine} / 並列{String(r.activeSessions)}/{String(r.maxParallel)} /{' '}
                    {String(r.taskDone)}/{String(r.taskTotal)}
                  </span>
                  <span class="row-sub">
                    {r.repoLabel} · {r.assessment}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </section>
      <section class="detail" aria-label="runの詳細">
        {run === undefined ? (
          <p class="empty">runを選ぶと詳細が出ます（j / kで移動）。</p>
        ) : (
          <>
            <h2>{run.label}</h2>
            <p class="notice">
              {run.repoLabel} · {run.status} · {run.assessment} · {run.engine} · 並列上限{' '}
              {String(run.maxParallel)}（実行中{String(run.activeSessions)}）· 完了{' '}
              {String(run.taskDone)}/{String(run.taskTotal)}
            </p>
            <div class="actions">
              <button
                type="button"
                class="btn"
                disabled={disabled}
                onClick={() => props.onOp('switch')}
                title="切替（o / Enter）"
              >
                切替
              </button>
              <button
                type="button"
                class="btn"
                disabled={disabled}
                onClick={() => props.onOp(halted ? 'unpause' : 'pause')}
                title="一時停止 / 解除（p）"
              >
                {halted ? '一時停止を解く' : '一時停止'}
              </button>
              <button
                type="button"
                class="btn"
                disabled={disabled}
                onClick={() => props.onOp('suspend')}
                title="中断（z）"
              >
                中断
              </button>
              <button
                type="button"
                class="btn"
                disabled={disabled}
                onClick={() => props.onOp('resume')}
                title="再開（u）"
              >
                再開
              </button>
              <button
                type="button"
                class="btn"
                disabled={disabled}
                onClick={() => props.onOp('finish')}
                title="終える（Shift+F）"
              >
                終える
              </button>
              <button
                type="button"
                class="btn"
                disabled={disabled || run.maxParallel <= 1}
                onClick={() => props.onParallel(-1)}
                title="並列上限を下げる（-）"
              >
                並列 −
              </button>
              <button
                type="button"
                class="btn"
                disabled={disabled || run.maxParallel >= runs.maxParallelLimit}
                onClick={() => props.onParallel(1)}
                title="並列上限を上げる（+）"
              >
                並列 ＋
              </button>
            </div>
            <h3>タスク（{String(run.tasks.length)}）</h3>
            {run.tasks.length === 0 ? <p class="empty">タスクはありません。</p> : null}
            {run.tasks.map((t) => (
              <div key={t.taskId} class={t.done ? 'run-task done' : 'run-task'}>
                <span class="row-title">
                  {t.taskId} {t.title}
                </span>
                <span class="row-meta">
                  <span class="pill">{t.stage}</span>
                  {t.badges.map((b) => (
                    <span key={b} class={t.warn ? 'pill error' : 'pill'}>
                      {b}
                    </span>
                  ))}
                  {t.issueNumber !== undefined ? ` #${String(t.issueNumber)}` : ''}
                  {t.pullRequestNumber !== undefined ? ` PR#${String(t.pullRequestNumber)}` : ''}
                </span>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

const ISSUES_MAX = 20;

type CursorEntry =
  | { kind: 'roadmap'; number: number; title: string; checked?: boolean; head: boolean }
  | { kind: 'issue'; number: number; title: string; roadmap: boolean };

function entriesOf(listing: McIssueListing): CursorEntry[] {
  const out: CursorEntry[] = [];
  for (const r of listing.roadmaps) {
    out.push({ kind: 'roadmap', number: r.number, title: r.title, head: true });
    for (const c of r.children) {
      out.push({
        kind: 'roadmap',
        number: c.number,
        title: c.title,
        checked: c.checked,
        head: false,
      });
    }
  }
  for (const i of listing.issues) {
    out.push({ kind: 'issue', number: i.number, title: i.title, roadmap: i.roadmap });
  }
  return out;
}

export function IssueStartDialog(props: {
  bridge: Bridge;
  folders: McRunsSnapshot['folders'];
  onClose: () => void;
  onDone: (message: string) => void;
}): JSX.Element {
  const { bridge, folders } = props;
  const [folderIndex, setFolderIndex] = useState(0);
  const [engine, setEngine] = useState<McProvider>('codex');
  const [listing, setListing] = useState<McIssueListing | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const folder = folders[folderIndex]?.path;

  useEffect(() => {
    boxRef.current?.focus();
  }, []);
  useEffect(() => {
    if (folder === undefined) {
      return;
    }
    let live = true;
    setListing(undefined);
    setLoadError(undefined);
    setCursor(0);
    setPicked(new Set());
    void bridge.issueList(folder).then((result) => {
      if (!live) {
        return;
      }
      if (result.ok && result.issues !== undefined) {
        setListing(result.issues);
      } else {
        setLoadError(result.error ?? '一覧を取り寄せられませんでした');
      }
    });
    return () => {
      live = false;
    };
  }, [bridge, folder]);

  const entries = listing === undefined ? [] : entriesOf(listing);
  const index = Math.min(cursor, Math.max(entries.length - 1, 0));
  useEffect(() => {
    boxRef.current
      ?.querySelector(`[data-entry="${String(index)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const keyOf = (e: CursorEntry): string => `${e.kind}:${String(e.number)}`;
  const isRoadmap = (e: CursorEntry): boolean =>
    (e.kind === 'roadmap' && e.head) || (e.kind === 'issue' && e.roadmap);

  const start = (): void => {
    if (busy || folder === undefined) {
      return;
    }
    const chosen = entries.filter((e) => picked.has(keyOf(e)));
    const targets =
      chosen.length > 0 ? chosen : entries[index] === undefined ? [] : [entries[index]];
    if (targets.length === 0) {
      setMessage('Issueを選んでください');
      return;
    }
    // roadmapは1本ずつ起動し、それ以外のIssueはまとめて1本の自由指示のrunへ渡す（拡張ホストが行う）
    const roadmapNumbers = [...new Set(targets.filter(isRoadmap).map((e) => e.number))];
    const issueNumbers = [
      ...new Set(targets.filter((e) => !isRoadmap(e)).map((e) => e.number)),
    ].filter((n) => !roadmapNumbers.includes(n));
    if (roadmapNumbers.length + issueNumbers.length > ISSUES_MAX) {
      setMessage(`選べるのは${String(ISSUES_MAX)}件までです`);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    void bridge
      .issueStart({
        folder,
        engine,
        roadmapIssueNumbers: roadmapNumbers,
        issueNumbers,
      })
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          setMessage(result.error ?? '起動できませんでした');
          return;
        }
        props.onDone(result.message ?? '起動しました');
      });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    const last = Math.max(entries.length - 1, 0);
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
        return;
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        setCursor(Math.min(index + 1, last));
        return;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        setCursor(Math.max(index - 1, 0));
        return;
      case 'x':
      case ' ': {
        e.preventDefault();
        const entry = entries[index];
        if (entry === undefined) {
          return;
        }
        const key = keyOf(entry);
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
          return next;
        });
        return;
      }
      case 'Enter':
        e.preventDefault();
        start();
        return;
      case 'f':
        e.preventDefault();
        if (folders.length > 1) {
          setFolderIndex((i) => (i + 1) % folders.length);
        }
        return;
      case 'g':
        e.preventDefault();
        setEngine((c) => (c === 'codex' ? 'claude' : 'codex'));
        return;
      default:
    }
  };

  return (
    <div class="help" role="dialog" aria-label="roadmap・Issueから起動">
      <div class="help-box history-box issue-box" ref={boxRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2>roadmap・Issueから起動</h2>
        <p class="notice">
          フォルダ: {folders[folderIndex]?.label ?? '（なし）'}（f） / CLI: {engine}（g） / j k 移動
          / x Space 選択 / Enter 起動 / Esc 閉じる
        </p>
        {folder === undefined ? <p class="error">開いているフォルダがありません。</p> : null}
        {listing === undefined && loadError === undefined && folder !== undefined ? (
          <p class="notice">取り寄せ中…</p>
        ) : null}
        {loadError !== undefined ? <p class="error">{loadError}</p> : null}
        {message !== undefined ? <p class="error">{message}</p> : null}
        <div class="history-list" role="listbox" aria-label="roadmapとIssue">
          {entries.map((entry, i) => (
            <div
              key={`${keyOf(entry)}:${String(i)}`}
              data-entry={String(i)}
              class={[
                i === index ? 'row selected' : 'row',
                picked.has(keyOf(entry)) ? 'marked' : '',
                entry.kind === 'roadmap' && entry.checked === true ? 'sent' : '',
              ]
                .filter((c) => c !== '')
                .join(' ')}
              role="option"
              aria-selected={i === index}
              onClick={() => setCursor(i)}
            >
              <span class="mark">{picked.has(keyOf(entry)) ? '✓' : ''}</span>
              <span class="row-title">
                #{String(entry.number)} {entry.title}
              </span>
              <span class="row-meta">
                {entry.kind === 'roadmap'
                  ? entry.head
                    ? 'roadmap'
                    : entry.checked === true
                      ? '済'
                      : '着手順'
                  : entry.roadmap
                    ? 'roadmap'
                    : 'Issue'}
              </span>
            </div>
          ))}
        </div>
        <div class="actions">
          <button type="button" class="btn primary" disabled={busy} onClick={start}>
            起動（Enter）
          </button>
          <button type="button" class="btn" onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}
