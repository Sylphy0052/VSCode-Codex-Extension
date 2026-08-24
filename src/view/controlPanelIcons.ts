/**
 * 設定パネルのセクション見出しに出すアイコン（issue #739）。
 *
 * 折りたたみの見出しが8個以上、同じ見た目の文字だけで縦に並んでいるため、目的の項目を
 * 探すのに毎回すべて読むことになっていた。形で見分けられるようにする。
 *
 * codiconのwebfontは使わない。webviewのCSPは `default-src 'none'` で `font-src` を
 * 開けておらず（`chatCsp.ts`）、未指定のdirectiveは `default-src` に落ちて塞がれるため、
 * フォント読み込みには新しい許可とアセット同梱が要る。外部CDNも使えない。インライン
 * `<svg>` はCSPが制御する「読み込み」に当たらずそのまま描画できるため、これで代える
 * （`chatShared.ts` の `COMPOSER_ICONS` と同じ判断・同じ書式）。
 *
 * `currentColor` を使い、見出しの文字色にそのまま追従させる。ライト／ダーク／
 * ハイコントラストのどれでも、見出しの文字が読める色ならアイコンも読める。
 *
 * `aria-hidden="true"` を付けているのは、見出しの文字が同じ情報を持っているため。
 * 読み上げでアイコン名が重ねて読まれても情報は増えない。
 */
export const SECTION_ICONS = {
  /** 承認の詳細。盾にチェック */
  approval:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8 3 3.6v4.1c0 3 2.1 5.2 5 6.5 2.9-1.3 5-3.5 5-6.5V3.6z"/><path d="M5.9 7.8 7.4 9.3l2.9-3"/></svg>',
  /** アカウント。人 */
  account:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5.2" r="2.6"/><path d="M2.8 13.5a5.2 5.2 0 0 1 10.4 0"/></svg>',
  /** MCPサーバー。積み重ねた筐体 */
  mcp: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><rect x="2.5" y="9" width="11" height="4.5" rx="1"/><circle cx="5" cy="4.75" r="0.7" fill="currentColor" stroke="none"/><circle cx="5" cy="11.25" r="0.7" fill="currentColor" stroke="none"/></svg>',
  /** hooks。稲妻（何かが起きた瞬間に走るもの） */
  hooks:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M9 1.5 4 8.5h3.2L7 14.5l5-7H8.8z" fill="currentColor"/></svg>',
  /** skills。開いた本 */
  skills:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4.2C6.9 3.2 5.4 2.7 3 2.7v9c2.4 0 3.9.5 5 1.5 1.1-1 2.6-1.5 5-1.5v-9c-2.4 0-3.9.5-5 1.5z"/><path d="M8 4.2v9"/></svg>',
  /** plugins。差し込むプラグ */
  plugins:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3"/><path d="M4 5h8v2.5a4 4 0 0 1-8 0z"/><path d="M8 11.5V14"/></svg>',
  /** apps。四角の格子 */
  apps: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
  /** 他エージェントからの設定インポート。受け皿へ落とす下向き矢印 */
  import:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v7M5 6.3l3 2.7 3-2.7"/><path d="M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/></svg>',
} as const satisfies Record<string, string>;

export type SectionIconName = keyof typeof SECTION_ICONS;

/**
 * 見出しの先頭に置くアイコンを組み立てる。
 *
 * `<summary>` の `display` は変えない（変えると折りたたみの三角マーカーが消える）。
 * インラインのspanで包み、`controlPanelStyles.ts` の `.sectionIcon` で縦位置を揃える。
 */
export function sectionIcon(name: SectionIconName): string {
  return `<span class="sectionIcon">${SECTION_ICONS[name]}</span>`;
}

/**
 * 一覧が空・取得に失敗したときに出すアイコンの `<path>`（issue #745）。
 *
 * 見出しのアイコン（`SECTION_ICONS`）と違い、こちらはwebview側のスクリプトが実行時に
 * 組み立てる。`controlPanelScript.ts` はDOM APIだけでDOMを組む方針（`innerHTML` 系を
 * 使わない）なので、SVGの文字列ではなく `<path>` の `d` だけを渡し、あちらで
 * `createElementNS` を使って組む（`workflowGraph.ts` と同じ作り）。
 *
 * 読み込み中には形を割り当てない。止まった絵ではなく動く帯で示す方が「まだ終わっていない」
 * ことが伝わるため（`controlPanelStyles.ts` の `.stateBar`）。
 */
export const STATE_ICON_PATHS = {
  /** 0件。空の受け皿 */
  empty: [
    'M2.5 9.5 4.3 3.2h7.4l1.8 6.3v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
    'M2.5 9.5h3l1 2h3l1-2h3',
  ],
  /** 取得に失敗。感嘆符付きの三角 */
  error: ['M8 2.2 14.3 13.2H1.7z', 'M8 6.4v3.1', 'M8 11.4v0.01'],
} as const satisfies Record<string, readonly string[]>;

export type StateIconName = keyof typeof STATE_ICON_PATHS;
