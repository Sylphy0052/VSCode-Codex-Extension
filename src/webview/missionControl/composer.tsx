import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import {
  applyCompletion,
  completionTokenAt,
  filterCommands,
  mentionOf,
  stepIndex,
  type McCompletionToken,
} from './composerLogic';
import type { McAttachment, McQueuedMessage, McSession, McSlashCommand } from './protocol';

/**
 * 指示欄（Composer。Issue #2137の4・#2158）。
 *
 * - 画像は貼り付け（Ctrl+V）とファイル選択で添える。画像以外のファイルは`@パス`として本文へ入れる
 * - `@`でファイル、行頭の`/`でスラッシュコマンドの候補を出し、↑ / ↓・Enter / Tab・Escで選ぶ
 * - 送信キュー（応答中に送って待たせている指示）を開き、↑ / ↓で選んでDeleteで取り消す
 */

/** 全体のキー（`Shift+A`・`Shift+Q`・パレット）から指示欄を動かす口。 */
export interface ComposerKeys {
  attach: () => void;
  toggleQueue: () => void;
  /** 指示欄へ移り、`@`か`/`を入れて候補を出す。 */
  complete: (trigger: '@' | '/') => void;
}

export interface ComposerKeysRef {
  current: ComposerKeys | null;
}

/** ファイル候補を取り寄せるまで待つ時間。打つたびに取り寄せない。 */
const FILE_QUERY_DEBOUNCE_MS = 150;
/** 送信キューを開いている間に読み直す間隔。 */
const QUEUE_POLL_MS = 2_000;

interface Completion {
  token: McCompletionToken;
  items: Array<{ value: string; description: string }>;
  index: number;
}

/** 貼り付けられた画像をデータURLにする。 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('読み込めませんでした'));
    };
    reader.readAsDataURL(file);
  });
}

export function Composer(props: {
  session: McSession;
  bridge: Bridge;
  keysRef: ComposerKeysRef;
  onSend: (text: string, attachments: readonly McAttachment[]) => Promise<string | undefined>;
  onToast: (message: string) => void;
}): JSX.Element {
  const { session, bridge } = props;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<McAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [completion, setCompletion] = useState<Completion | undefined>(undefined);
  const [queue, setQueue] = useState<McQueuedMessage[] | undefined>(undefined);
  const [queueError, setQueueError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queueRef = useRef<HTMLUListElement>(null);
  const pendingCaret = useRef<number | undefined>(undefined);
  /** スラッシュコマンドの一覧。会話ごとに1回だけ取り寄せる。 */
  const commands = useRef<McSlashCommand[] | undefined>(undefined);
  /** 古い候補の応答で新しい候補を上書きしないための番号。 */
  const querySeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Escで閉じた語。同じ語の中で打ち続ける間は出し直さない。 */
  const dismissed = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (debounce.current !== undefined) {
        clearTimeout(debounce.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (pendingCaret.current !== undefined && inputRef.current !== null) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = undefined;
    }
  });

  const showCommands = (token: McCompletionToken, seq: number): void => {
    const list = commands.current;
    if (list === undefined) {
      void bridge.request(session, { action: 'commandCandidates' }).then((result) => {
        if (!result.ok) {
          setError(result.error ?? 'スラッシュコマンドの候補を取り寄せられませんでした');
          return;
        }
        commands.current = result.commands ?? [];
        if (seq === querySeq.current) {
          showCommands(token, seq);
        }
      });
      return;
    }
    const items = filterCommands(list, token.query).map((c) => ({
      value: c.name,
      description: [c.argumentHint, c.description].filter((v) => v !== '').join(' '),
    }));
    setCompletion(items.length === 0 ? undefined : { token, items, index: 0 });
  };

  const showFiles = (token: McCompletionToken, seq: number): void => {
    if (debounce.current !== undefined) {
      clearTimeout(debounce.current);
    }
    debounce.current = setTimeout(() => {
      void bridge
        .request(session, { action: 'fileCandidates', query: token.query })
        .then((result) => {
          if (seq !== querySeq.current) {
            return;
          }
          if (!result.ok) {
            setError(result.error ?? 'ファイルの候補を取り寄せられませんでした');
            setCompletion(undefined);
            return;
          }
          const items = (result.files ?? []).map((f) => ({ value: f, description: '' }));
          setCompletion(items.length === 0 ? undefined : { token, items, index: 0 });
        });
    }, FILE_QUERY_DEBOUNCE_MS);
  };

  /** 本文とカーソルの位置から、候補を出すか閉じるかを決める。 */
  const updateCompletion = (value: string, caret: number): void => {
    querySeq.current += 1;
    const seq = querySeq.current;
    const token = completionTokenAt(value, caret);
    if (token === undefined || dismissed.current === token.start) {
      if (token === undefined) {
        dismissed.current = undefined;
      }
      setCompletion(undefined);
      return;
    }
    dismissed.current = undefined;
    if (token.kind === 'command') {
      showCommands(token, seq);
    } else {
      showFiles(token, seq);
    }
  };

  const accept = (current: Completion): void => {
    const item = current.items[current.index];
    if (item === undefined) {
      return;
    }
    const next = applyCompletion(text, current.token, item.value);
    querySeq.current += 1;
    setText(next.text);
    setCompletion(undefined);
    pendingCaret.current = next.caret;
  };

  const insertAtCaret = (insert: string, openCompletion: boolean): void => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    // `@`は前に空白が要る（語の途中の`@`では候補を出さない）
    const lead = insert.startsWith('@') && before !== '' && !/\s$/u.test(before) ? ' ' : '';
    const next = `${before}${lead}${insert}${text.slice(caret)}`;
    const nextCaret = caret + lead.length + insert.length;
    setText(next);
    pendingCaret.current = nextCaret;
    input?.focus();
    if (openCompletion) {
      updateCompletion(next, nextCaret);
    }
  };

  const attach = (): void => {
    void bridge.pickAttachments(session.cwdFull).then((result) => {
      if (!result.ok) {
        setError(result.error ?? '添付を選べませんでした');
        return;
      }
      const images = result.attachments ?? [];
      if (images.length > 0) {
        setAttachments((list) => [...list, ...images]);
      }
      const paths = result.paths ?? [];
      if (paths.length > 0) {
        insertAtCaret(`${paths.map(mentionOf).join(' ')} `, false);
      }
      setError(result.message);
      inputRef.current?.focus();
    });
  };

  const loadQueue = (): void => {
    void bridge.request(session, { action: 'queuedMessages' }).then((result) => {
      if (!result.ok) {
        setQueueError(result.error ?? '送信キューを読めませんでした');
        return;
      }
      setQueueError(undefined);
      // 読み直しで、フォーカス中の項目が送られて消えると、フォーカスがbodyへ落ちてキーが効かなくなる
      const hadFocus = queueRef.current?.contains(document.activeElement) === true;
      setQueue((open) => (open === undefined ? undefined : (result.queued ?? [])));
      if (hadFocus) {
        setTimeout(() => {
          const list = queueRef.current;
          if (list !== null && !list.contains(document.activeElement)) {
            (list.querySelector<HTMLElement>('button') ?? list).focus();
          }
        }, 0);
      }
    });
  };

  const toggleQueue = (): void => {
    if (queue !== undefined) {
      setQueue(undefined);
      return;
    }
    setQueue([]);
    loadQueue();
    // 開いたら一覧へ移る（↑ / ↓・Deleteをすぐ使えるように）
    setTimeout(() => {
      (queueRef.current?.querySelector<HTMLElement>('button') ?? queueRef.current)?.focus();
    }, 0);
  };

  const queueOpen = queue !== undefined;
  useEffect(() => {
    if (!queueOpen) {
      return undefined;
    }
    const timer = setInterval(loadQueue, QUEUE_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [queueOpen]);

  const cancelQueued = (index: number, item: McQueuedMessage): void => {
    void bridge
      .request(session, { action: 'cancelQueued', index, queuedId: item.id })
      .then((result) => {
        props.onToast(
          result.ok ? '送信キューから取り消しました' : (result.error ?? '取り消せませんでした'),
        );
        loadQueue();
      });
  };

  props.keysRef.current = {
    attach,
    toggleQueue,
    complete: (trigger) => {
      if (trigger === '/' && text !== '') {
        // スラッシュコマンドは行頭でしか効かない。書きかけの本文の前へ足さない
        inputRef.current?.focus();
        setError('スラッシュコマンドは指示欄が空のときだけ使えます');
        return;
      }
      insertAtCaret(trigger, true);
    },
  };
  const ownKeys = useRef(props.keysRef.current);
  ownKeys.current = props.keysRef.current;
  useEffect(
    () => () => {
      if (props.keysRef.current === ownKeys.current) {
        props.keysRef.current = null;
      }
    },
    [],
  );

  const submit = (): void => {
    if (sending || (text.trim() === '' && attachments.length === 0)) {
      return;
    }
    setSending(true);
    setError(undefined);
    setCompletion(undefined);
    // 送った下書きへの候補の取り寄せが保留なら止める（送信後の空の指示欄に古い候補を出さない）
    querySeq.current += 1;
    if (debounce.current !== undefined) {
      clearTimeout(debounce.current);
      debounce.current = undefined;
    }
    void props.onSend(text, attachments).then((failure) => {
      setSending(false);
      if (failure === undefined) {
        setText('');
        setAttachments([]);
        if (queue !== undefined) {
          loadQueue();
        }
      } else {
        setError(failure);
      }
    });
  };

  const onPaste = (e: ClipboardEvent): void => {
    const items = [...(e.clipboardData?.items ?? [])];
    // 文字も載っている貼り付け（ブラウザからのコピーなど）は文字として通す
    if (items.some((item) => item.kind === 'string' && item.type === 'text/plain')) {
      return;
    }
    const files = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) {
      return;
    }
    e.preventDefault();
    void Promise.all(
      files.map(async (file, i) => ({
        name: file.name !== '' ? file.name : `貼り付け${String(attachments.length + i + 1)}.png`,
        dataUrl: await readAsDataUrl(file),
      })),
    ).then(
      (added) => {
        setAttachments((list) => [...list, ...added.filter((a) => a.dataUrl.startsWith('data:'))]);
      },
      (err: unknown) => {
        setError(`画像を読み込めませんでした: ${String(err)}`);
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) {
      return;
    }
    if (completion !== undefined) {
      const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
      const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
      if (down || up) {
        e.preventDefault();
        setCompletion({
          ...completion,
          index: stepIndex(completion.index, completion.items.length, down ? 1 : -1),
        });
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        accept(completion);
        return;
      }
      if (e.key === 'Escape') {
        // 全体のEsc（入力欄から出る）より先に、候補だけ閉じる
        e.preventDefault();
        dismissed.current = completion.token.start;
        setCompletion(undefined);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  const onQueueKeyDown = (e: KeyboardEvent): void => {
    if (queue === undefined || queue.length === 0) {
      return;
    }
    const buttons = [...(queueRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = buttons.findIndex((b) => b === document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const down = e.key === 'ArrowDown';
      // 一覧の外（コンテナ）から入るときは、↓で先頭、↑で末尾へ入る
      const next =
        at < 0 ? (down ? 0 : buttons.length - 1) : stepIndex(at, buttons.length, down ? 1 : -1);
      buttons[next]?.focus();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && at >= 0) {
      e.preventDefault();
      const item = queue[at];
      if (item !== undefined) {
        cancelQueued(at, item);
      }
    }
  };

  const listId = `composer-candidates-${session.key}`;
  const active = completion?.items[completion.index];
  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>指示を送る</h3>
      <div class="composer-field">
        <textarea
          ref={inputRef}
          class="text-input composer-input"
          rows={3}
          aria-label="会話へ送る指示"
          placeholder="会話へ送る指示（Ctrl+Enterで送信、@でファイル、行頭の/でコマンド、Ctrl+Vで画像）"
          value={text}
          disabled={sending}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={
            completion === undefined ? undefined : `${listId}-${String(completion.index)}`
          }
          onInput={(e) => {
            const value = e.currentTarget.value;
            setText(value);
            updateCompletion(value, e.currentTarget.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              updateCompletion(e.currentTarget.value, e.currentTarget.selectionStart);
            }
          }}
          onClick={(e) => updateCompletion(e.currentTarget.value, e.currentTarget.selectionStart)}
          onPaste={onPaste}
          onBlur={() => setCompletion(undefined)}
        />
        {completion === undefined ? null : (
          <ul
            id={listId}
            class="composer-candidates"
            role="listbox"
            aria-label={
              completion.token.kind === 'file' ? 'ファイルの候補' : 'スラッシュコマンドの候補'
            }
          >
            {completion.items.map((item, i) => (
              <li
                key={item.value}
                id={`${listId}-${String(i)}`}
                role="option"
                aria-selected={item === active}
                class={item === active ? 'composer-candidate selected' : 'composer-candidate'}
                // クリックで入力欄のフォーカスを外さない（onBlurで候補が閉じる前に選ぶ）
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept({ ...completion, index: i });
                }}
              >
                <span>
                  {completion.token.kind === 'command' ? '/' : '@'}
                  {item.value}
                </span>
                {item.description === '' ? null : <span class="desc">{item.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {attachments.length === 0 ? null : (
        <div class="composer-attachments" aria-label="添付する画像">
          {attachments.map((a, i) => (
            <span key={`${String(i)}-${a.name}`} class="composer-attachment">
              <img src={a.dataUrl} alt="" />
              {a.name}
              <button
                type="button"
                class="btn"
                disabled={sending}
                aria-label={`${a.name}を外す`}
                onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}
              >
                外す
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="actions">
        <button
          type="submit"
          class="btn primary"
          disabled={sending || (text.trim() === '' && attachments.length === 0)}
        >
          {sending
            ? '送信中…'
            : attachments.length > 0
              ? `送信（画像${String(attachments.length)}枚）`
              : '送信'}
        </button>
        <button type="button" class="btn" disabled={sending} onClick={attach}>
          添付…
        </button>
        <button type="button" class="btn" aria-pressed={queueOpen} onClick={toggleQueue}>
          送信キュー
        </button>
      </div>
      {error === undefined ? null : (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {queue === undefined ? null : (
        <div>
          <h3>送信キュー</h3>
          {queueError === undefined ? null : (
            <p class="error" role="alert">
              {queueError}
            </p>
          )}
          {queue.length === 0 ? (
            <p class="notice">送信キューは空です（応答中に送った指示がここに並びます）</p>
          ) : null}
          <ul
            ref={queueRef}
            class="composer-queue"
            aria-label="送信キュー（Deleteで取り消す）"
            tabIndex={-1}
            onKeyDown={onQueueKeyDown}
          >
            {queue.map((item, i) => (
              // 位置を含めない（先頭が送られて繰り上がっても同じ項目のDOMを残し、フォーカスを保つ）
              <li key={item.id === '' ? `#${String(i)}` : item.id}>
                <button
                  type="button"
                  class="choice"
                  title="押すかDeleteで取り消す"
                  onClick={() => cancelQueued(i, item)}
                >
                  <span>{String(i + 1)}.</span>
                  <span>
                    {item.text}
                    {item.truncated ? '…' : ''}
                    {item.attachments > 0 ? `（画像${String(item.attachments)}枚）` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
