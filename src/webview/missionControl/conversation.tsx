import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { keyLabelFor } from './keys';
import type { McTurn } from './protocol';
import {
  findTurnMatches,
  groupMatchesByTurn,
  hasOlderTurns,
  segmentField,
  stepMatch,
  type IndexedMatch,
  type TurnLog,
} from './turnLog';

/**
 * 詳細ペインの会話（Issue #2157）。
 *
 * 会話の先頭まで遡れる（上端までスクロールすると古いやり取りを読み足す）。会話内を検索し、
 * 一致へキーで移る。ツール呼び出しとdiffは折りたたんで出し、キーでまとめて開閉する。
 */

export type TurnLogState =
  { status: 'loading' } | { status: 'ok'; value: TurnLog } | { status: 'error'; error: string };

/** 全体のキー（`keys.ts`）から呼ぶ操作。詳細に会話が出ている間だけ埋まる。 */
export interface ConversationKeys {
  search(): void;
  step(delta: 1 | -1): void;
  toggleFolds(): void;
  loadOlder(): void;
}

export interface ConversationKeysRef {
  current: ConversationKeys | null;
}

/** 上端からこの距離（px）まで来たら古いやり取りを読み足す。 */
const LOAD_OLDER_THRESHOLD_PX = 40;
/** 下端からこの距離（px）以内なら、新しいやり取りが届いたときに下端へ付いていく。 */
const STICK_BOTTOM_PX = 24;

const ROLE_LABELS: Readonly<Record<McTurn['role'], string>> = {
  user: 'あなた',
  agent: 'エージェント',
  tool: 'ツール',
  diff: '変更',
};

function isFoldable(turn: McTurn): boolean {
  return turn.role === 'tool' || turn.role === 'diff';
}

function Highlighted(props: {
  text: string;
  matches: readonly IndexedMatch[] | undefined;
  field: 'title' | 'text';
  current: number | undefined;
}): JSX.Element {
  if (props.matches === undefined) {
    return <>{props.text}</>;
  }
  return (
    <>
      {segmentField(props.text, props.matches, props.field).map((segment, i) =>
        segment.match === undefined ? (
          segment.text
        ) : (
          <mark
            key={String(i)}
            class={segment.match === props.current ? 'turn-match current' : 'turn-match'}
            data-match={String(segment.match)}
          >
            {segment.text}
          </mark>
        ),
      )}
    </>
  );
}

export function Conversation(props: {
  log: TurnLogState | undefined;
  keysRef: ConversationKeysRef;
  onReload: () => void;
  onLoadOlder: () => void;
  onLoadAll: () => void;
}): JSX.Element {
  const { log } = props;
  const value = log?.status === 'ok' ? log.value : undefined;
  const turns = value?.turns ?? [];
  const base = value?.start ?? 0;
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState<number | undefined>(undefined);
  const [openAll, setOpenAll] = useState(false);
  // 1件ずつ開閉を反転させた位置（会話全体での位置。読み足しで添字がずれても保つ）
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(new Set());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const lastHeight = useRef(0);
  const lastStart = useRef<number | undefined>(undefined);

  const matches = useMemo(() => findTurnMatches(turns, query), [turns, query]);
  const byTurn = useMemo(() => groupMatchesByTurn(matches), [matches]);
  const currentMatch = current === undefined ? undefined : matches[current];
  const older = value !== undefined && hasOlderTurns(value);
  const olderLoading = value?.olderLoading === true;

  // 検索するときは会話の先頭まで読み込む（読み込んだ範囲だけを探すと見落とす）。取り寄せに
  // 失敗した後は自動では取り直さない（失敗のたびに取り直し続けない）
  const olderFailed = value?.olderError !== undefined;
  useEffect(() => {
    if (query.trim() !== '' && older && !olderLoading && !olderFailed) {
      props.onLoadAll();
    }
  }, [query, older, olderLoading]);
  // 検索語が変わったら最初の一致へ戻す。一致が減ったら範囲へ収める
  useEffect(() => {
    setCurrent(matches.length === 0 ? undefined : 0);
  }, [query]);
  useEffect(() => {
    if (current !== undefined && current >= matches.length) {
      setCurrent(matches.length === 0 ? undefined : matches.length - 1);
    } else if (current === undefined && matches.length > 0 && query.trim() !== '') {
      setCurrent(0);
    }
  }, [matches.length]);
  // 今の一致を見える位置へ出す。検索語が変わると、選択位置（0件目）と一致したやり取りが同じでも
  // 一致の文字位置は変わるので、検索語でも出し直す
  useEffect(() => {
    if (current === undefined) {
      return;
    }
    logRef.current
      ?.querySelector<HTMLElement>(`[data-match="${current}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [current, currentMatch?.turn, query]);

  // 古いやり取りを先頭へ足したときは見ていた位置を保ち、下端にいたなら新しいやり取りへ付いていく
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el === null) {
      return;
    }
    if (
      lastStart.current !== undefined &&
      value?.start !== undefined &&
      value.start < lastStart.current
    ) {
      el.scrollTop += el.scrollHeight - lastHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    lastHeight.current = el.scrollHeight;
    lastStart.current = value?.start;
  });

  const onScroll = (): void => {
    const el = logRef.current;
    if (el === null) {
      return;
    }
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX;
    if (el.scrollTop <= LOAD_OLDER_THRESHOLD_PX && older && !olderLoading) {
      props.onLoadOlder();
    }
  };

  const step = (delta: 1 | -1): void => {
    setCurrent((at) => stepMatch(at, matches.length, delta));
  };
  const keys: ConversationKeys = {
    search: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    step,
    toggleFolds: () => {
      setOpenAll((on) => !on);
      setFlipped(new Set());
    },
    loadOlder: () => {
      if (older && !olderLoading) {
        props.onLoadOlder();
      }
    },
  };
  props.keysRef.current = keys;
  const ownKeys = useRef(keys);
  ownKeys.current = keys;
  useEffect(
    () => () => {
      // 宛先が替わって作り直したときは、新しい方が先に描画して埋めている。それを消さない
      if (props.keysRef.current === ownKeys.current) {
        props.keysRef.current = null;
      }
    },
    [],
  );

  const toggleOne = (position: number): void => {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(position)) {
        next.delete(position);
      } else {
        next.add(position);
      }
      return next;
    });
  };

  const searchKey = keyLabelFor('turnSearch');
  const stepKeys = [keyLabelFor('turnMatch'), keyLabelFor('turnMatchPrev')]
    .filter((k) => k !== undefined)
    .join(' / ');
  const foldKey = keyLabelFor('turnFolds');
  const olderKey = keyLabelFor('turnOlder');

  return (
    <div class="conversation">
      <h3>
        会話{value?.total !== undefined ? `（${value.total}件）` : ''}{' '}
        <button type="button" class="btn" onClick={props.onReload}>
          再読込
        </button>
      </h3>
      <div class="turn-search" data-no-akey>
        <input
          ref={searchRef}
          type="search"
          class="turn-search-input"
          placeholder={`会話内を検索${searchKey === undefined ? '' : `（${searchKey}）`}`}
          aria-label="会話内を検索"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            // 入力欄の中ではEnter / Shift+Enterで一致を移る（全体のキーは文字入力に譲っている）
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span class="turn-search-count notice" aria-live="polite">
          {query.trim() === ''
            ? `${stepKeys}で一致を移動・${foldKey ?? ''}でツール / diffを開閉`
            : olderLoading
              ? '先頭まで読み込み中…'
              : matches.length === 0
                ? '一致なし'
                : `${current === undefined ? 0 : current + 1} / ${matches.length}件`}
        </span>
      </div>
      {log === undefined || log.status === 'loading' ? (
        <p class="notice">取り寄せ中…</p>
      ) : log.status === 'error' ? (
        <p class="error">{log.error}</p>
      ) : turns.length === 0 ? (
        <p class="notice">やり取りはまだありません。</p>
      ) : (
        <div class="turn-log" ref={logRef} onScroll={onScroll} data-no-akey>
          {older ? (
            <p class="notice turn-older">
              {olderLoading ? (
                '古いやり取りを読み込み中…'
              ) : (
                <button type="button" class="btn" onClick={props.onLoadOlder}>
                  古いやり取りを読む（あと{log.value.start}件
                  {olderKey === undefined ? '' : `・${olderKey}`}）
                </button>
              )}
            </p>
          ) : log.value.start === 0 ? (
            <p class="notice turn-older">会話の先頭</p>
          ) : null}
          {log.value.olderError !== undefined ? <p class="error">{log.value.olderError}</p> : null}
          {turns.map((turn, index) => {
            const position = base + index;
            const turnMatches = byTurn.get(index);
            const role = ROLE_LABELS[turn.role];
            if (!isFoldable(turn)) {
              return (
                <div key={String(position)} class={`turn ${turn.role}`}>
                  <p class="turn-role">{role}</p>
                  <p class="turn-text">
                    <Highlighted
                      text={turn.text}
                      matches={turnMatches}
                      field="text"
                      current={current}
                    />
                    {turn.truncated ? '…（続きはチャットタブで）' : ''}
                  </p>
                </div>
              );
            }
            // 今の一致がある項目は、閉じていても開いて見せる
            const open =
              openAll !== flipped.has(position) ||
              (currentMatch !== undefined && currentMatch.turn === index);
            return (
              <div key={String(position)} class={`turn ${turn.role}`}>
                <button
                  type="button"
                  class="turn-fold"
                  aria-expanded={open}
                  onClick={() => toggleOne(position)}
                >
                  <span class="turn-fold-mark" aria-hidden="true">
                    {open ? '▾' : '▸'}
                  </span>
                  <span class="turn-role">{role}</span>{' '}
                  <span class="turn-title">
                    <Highlighted
                      text={turn.title ?? ''}
                      matches={turnMatches}
                      field="title"
                      current={current}
                    />
                  </span>
                </button>
                {open ? (
                  <pre class="turn-output">
                    {turn.text === '' ? (
                      <span class="notice">（出力なし）</span>
                    ) : (
                      <Highlighted
                        text={turn.text}
                        matches={turnMatches}
                        field="text"
                        current={current}
                      />
                    )}
                    {turn.truncated ? '\n…（続きはチャットタブで）' : ''}
                  </pre>
                ) : turnMatches?.some((m) => m.match.field === 'text') === true ? (
                  <span class="notice turn-hidden-match">（本文に一致あり）</span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
