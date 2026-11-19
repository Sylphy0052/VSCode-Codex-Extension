import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Bridge } from './bridge';
import type { McSession, McTurn } from './protocol';
import { TURN_PAGE_SIZE } from './turnLog';

/**
 * 選んだセッションへの名前変更・クリア・巻き戻しのダイアログ（Issue #2160）。
 *
 * 受け取る側のウィンドウはダイアログを出さないので、確認はここで済ませてから送る。
 */
export type McSessionOpDialog = 'rename' | 'clear' | 'rewind';

/** 拡張ホストの`MAX_SESSION_NAME_CHARS`（`sessionHub.ts`）に合わせる。 */
const MAX_NAME_CHARS = 200;
/** 巻き戻しの一覧で、発言を1行に縮めるときの長さ。 */
const TURN_PREVIEW_CHARS = 120;

export function SessionOpDialog(props: {
  bridge: Bridge;
  session: McSession;
  op: McSessionOpDialog;
  onClose: () => void;
  onDone: (message: string) => void;
}): JSX.Element {
  if (props.op === 'rename') {
    return <RenameDialog {...props} />;
  }
  if (props.op === 'clear') {
    return <ClearDialog {...props} />;
  }
  return <RewindDialog {...props} />;
}

interface OpProps {
  bridge: Bridge;
  session: McSession;
  onClose: () => void;
  onDone: (message: string) => void;
}

function RenameDialog(props: OpProps): JSX.Element {
  const { bridge, session } = props;
  const [name, setName] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = name.trim();
  const invalid = trimmed === '' || trimmed.length > MAX_NAME_CHARS;
  const submit = (e: Event): void => {
    e.preventDefault();
    if (invalid || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    void bridge.request(session, { action: 'rename', name: trimmed }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '名前を変えられませんでした');
        return;
      }
      props.onDone(`名前を「${trimmed}」にしました`);
    });
  };

  return (
    <div class="help" role="dialog" aria-label="名前の変更">
      <form class="help-box" onSubmit={submit}>
        <h2>名前の変更</h2>
        <input
          ref={inputRef}
          class="text-input"
          type="text"
          aria-label="新しい名前"
          maxLength={MAX_NAME_CHARS}
          value={name}
          onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
        />
        {error === undefined ? null : (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button type="submit" class="btn primary" disabled={busy || invalid}>
            {busy ? '変更しています…' : '変更（Enter）'}
          </button>
          <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </form>
    </div>
  );
}

function ClearDialog(props: OpProps): JSX.Element {
  const { bridge, session } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // 誤ってEnterで消さないように、取りやめのボタンへ先にフォーカスを置く
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const clear = (): void => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    void bridge.request(session, { action: 'clear' }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? 'クリアできませんでした');
        return;
      }
      props.onDone(`「${session.title}」をクリアしました`);
    });
  };

  return (
    <div class="help" role="dialog" aria-label="会話のクリア">
      <div class="help-box">
        <h2>会話のクリア</h2>
        <p>
          「{session.title}
          」の会話を閉じ、同じタブで新しい会話を始めます。元の会話は履歴に残ります。
        </p>
        {error === undefined ? null : (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button type="button" class="btn primary" data-submit disabled={busy} onClick={clear}>
            {busy ? 'クリアしています…' : 'クリアする（Ctrl+Enter）'}
          </button>
          <button ref={cancelRef} type="button" class="btn" disabled={busy} onClick={props.onClose}>
            取りやめる（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}

type RewindStep =
  | { step: 'loading' }
  | { step: 'error'; error: string }
  | { step: 'pick'; turns: McTurn[] }
  | { step: 'confirm'; turns: McTurn[]; turn: McTurn; files: string[] };

/** 巻き戻しの起点にできる発言（固定のidがある人の発言）を、新しい順に並べる。 */
export function rewindCandidates(turns: readonly McTurn[]): McTurn[] {
  return turns.filter((t) => t.role === 'user' && t.id !== undefined && t.id !== '').reverse();
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > TURN_PREVIEW_CHARS ? `${line.slice(0, TURN_PREVIEW_CHARS)}…` : line;
}

function RewindDialog(props: OpProps): JSX.Element {
  const { bridge, session } = props;
  const [state, setState] = useState<RewindStep>({ step: 'loading' });
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);

  // `session`は開いた時点の値を親が固定して渡す（snapshotの更新ごとに取り寄せ直さないように）
  useEffect(() => {
    void bridge
      .request(session, { action: 'recentTurns', limit: TURN_PAGE_SIZE })
      .then((result) => {
        if (!result.ok) {
          setState({ step: 'error', error: result.error ?? '会話を取り寄せられませんでした' });
          return;
        }
        setState({ step: 'pick', turns: rewindCandidates(result.turns ?? []) });
      });
  }, [bridge, session]);

  useEffect(() => {
    if (state.step === 'pick') {
      listRef.current?.focus();
      listRef.current
        ?.querySelector(`[data-rewind="${String(cursor)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
    // 確認の段では「選び直す」にフォーカスを置く。Ctrl+Enterはダイアログの`data-submit`に届き、
    // 確かめたときのEnterを押し続けても巻き戻さない
    if (state.step === 'confirm') {
      backRef.current?.focus();
    }
  }, [state.step, cursor]);

  const turns = state.step === 'pick' || state.step === 'confirm' ? state.turns : [];
  const index = Math.min(cursor, Math.max(turns.length - 1, 0));

  const preview = (turn: McTurn | undefined): void => {
    if (turn?.id === undefined || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    void bridge.request(session, { action: 'rewindPreview', messageId: turn.id }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '巻き戻しで戻るファイルを確かめられませんでした');
        return;
      }
      setState({ step: 'confirm', turns, turn, files: result.rewindFiles ?? [] });
    });
  };
  const rewind = (turn: McTurn): void => {
    if (turn.id === undefined || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    void bridge.request(session, { action: 'rewind', messageId: turn.id }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? '巻き戻せませんでした');
        return;
      }
      props.onDone(`「${oneLine(turn.text)}」の時点まで巻き戻しました`);
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (state.step !== 'pick' || e.target instanceof HTMLButtonElement) {
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => {
        const last = Math.max(turns.length - 1, 0);
        const current = Math.min(c, last);
        return e.key === 'ArrowDown' ? Math.min(current + 1, last) : Math.max(current - 1, 0);
      });
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      preview(turns[index]);
    }
  };

  return (
    <div class="help" role="dialog" aria-label="巻き戻し" onKeyDown={onKeyDown}>
      <div class="help-box history-box">
        <h2>巻き戻し</h2>
        {state.step === 'loading' ? <p class="notice">会話を取り寄せ中…</p> : null}
        {state.step === 'error' ? <p class="error">{state.error}</p> : null}
        {state.step === 'pick' ? (
          <>
            <p class="notice">
              戻す先の発言を↑ /
              ↓で選び、Enterで確かめます。選んだ発言の直前の状態へ、会話とファイルを戻します（直近
              {String(TURN_PAGE_SIZE)}件のやり取りから選べます）。
            </p>
            {turns.length === 0 ? (
              <p class="empty">巻き戻しの起点にできる発言がありません。</p>
            ) : (
              <div
                class="history-list"
                ref={listRef}
                tabIndex={0}
                role="listbox"
                aria-label="戻す先の発言"
              >
                {turns.map((turn, i) => (
                  <div
                    key={turn.id}
                    data-rewind={String(i)}
                    class={i === index ? 'row selected' : 'row'}
                    role="option"
                    aria-selected={i === index}
                    onClick={() => setCursor(i)}
                    onDblClick={() => preview(turn)}
                  >
                    <span class="row-title">{oneLine(turn.text)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
        {state.step === 'confirm' ? (
          <>
            <p>「{oneLine(state.turn.text)}」の直前まで巻き戻します。</p>
            {state.files.length === 0 ? (
              <p class="notice">戻るファイルはありません（会話だけを戻します）。</p>
            ) : (
              <>
                <p class="notice">次のファイルが元に戻ります。</p>
                <ul class="rewind-files">
                  {state.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : null}
        {error === undefined ? null : (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          {state.step === 'confirm' ? (
            <>
              <button
                type="button"
                class="btn primary"
                data-submit
                disabled={busy}
                onClick={() => rewind(state.turn)}
              >
                {busy ? '巻き戻しています…' : '巻き戻す（Ctrl+Enter）'}
              </button>
              <button
                ref={backRef}
                type="button"
                class="btn"
                disabled={busy}
                onClick={() => setState({ step: 'pick', turns })}
              >
                選び直す
              </button>
            </>
          ) : (
            <button
              type="button"
              class="btn primary"
              disabled={busy || state.step !== 'pick' || turns[index] === undefined}
              onClick={() => preview(turns[index])}
            >
              {busy ? '確かめています…' : '確かめる（Enter）'}
            </button>
          )}
          <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
            閉じる（Esc）
          </button>
        </div>
      </div>
    </div>
  );
}
