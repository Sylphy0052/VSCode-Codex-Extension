import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { filterPalette, type McPaletteEntry } from './keys';

export type { McPaletteEntry } from './keys';

export function CommandPalette(props: {
  entries: readonly McPaletteEntry[];
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterPalette(props.entries, query), [props.entries, query]);
  const current = Math.min(index, Math.max(shown.length - 1, 0));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    document
      .querySelector(`[data-palette-index="${String(current)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const run = (entry: McPaletteEntry | undefined): void => {
    if (entry === undefined) {
      return;
    }
    props.onClose();
    // パレットが閉じてから実行する（フォーカスを移す操作がパレットの入力欄に負けないように）
    setTimeout(entry.run, 0);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) {
      return;
    }
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
    if (down || up) {
      e.preventDefault();
      if (shown.length > 0) {
        setIndex((current + (down ? 1 : shown.length - 1)) % shown.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[current]);
    }
  };

  return (
    <div
      class="help"
      role="dialog"
      aria-label="コマンドパレット"
      data-no-akey
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div class="help-box palette-box">
        <input
          ref={inputRef}
          class="text-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="mc-palette-list"
          aria-activedescendant={shown.length > 0 ? `mc-palette-${String(current)}` : undefined}
          placeholder="操作の名前で絞り込む（↑ / ↓で選び、Enterで実行、Escで閉じる）"
          value={query}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul class="palette-list" id="mc-palette-list" role="listbox">
          {shown.length === 0 ? <li class="empty">当てはまる操作はありません。</li> : null}
          {shown.map((entry, i) => (
            <li
              key={entry.id}
              id={`mc-palette-${String(i)}`}
              data-palette-index={String(i)}
              role="option"
              aria-selected={i === current}
              class={i === current ? 'palette-item selected' : 'palette-item'}
              onClick={() => run(entry)}
            >
              <span>{entry.label}</span>
              {entry.keyLabel === undefined ? null : <kbd>{entry.keyLabel}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
