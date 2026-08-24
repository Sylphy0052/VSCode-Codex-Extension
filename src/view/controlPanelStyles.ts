import { reducedMotionStyles } from './reducedMotion';

/**
 * 設定パネルのスタイル。
 *
 * チャット画面と同じく、`hidden` がdisplay指定に負けないよう打ち消し規則を持つ。
 */
export function controlPanelStyles(): string {
  return `
  /* hidden属性を常に効かせる（display指定に負けないように） */
  [hidden] { display: none !important; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 8px 12px 12px;
  }
  .row { margin-bottom: 12px; }
  label, .fieldLabel {
    display: block;
    margin-bottom: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  /*
   * 承認レベルの選択肢（issue #744）。<select> は開くまで他の選択肢が見えないため、
   * 3段階を常に並べて出す。
   *
   * 縦積みにしているのは、表示名が横並びに収まらないため（着手時の実測: 「全確認」3文字 /
   * 「Auto（承認をエージェントに任せる）」18文字 / 「全承認」3文字）。サイドバーの幅では
   * いちばん長いものが必ず折り返す。
   *
   * 選択中は枠の色・背景・ネイティブのラジオの点の3つで示す。:has が効かない環境でも
   * ラジオの点は残るので、選択が完全に見えなくなることはない。
   */
  .levelGroup { display: flex; flex-direction: column; gap: 4px; }
  .levelOption {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-bottom: 0;
    padding: 5px 8px;
    color: var(--vscode-foreground);
    font-size: 1em;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
    cursor: pointer;
  }
  .levelOption:hover { background-color: var(--vscode-list-hoverBackground); }
  .levelOption:focus-within {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .levelOption input { margin: 3px 0 0; }
  .levelOption-text { display: flex; flex-direction: column; }
  .levelOption-label { font-weight: 600; }
  .levelOption-desc, .levelOption-effective {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  /* 選択中。文字色は変えず背景だけを薄く敷く（説明文の色をそのまま読めるようにする） */
  .levelOption:has(input:checked) {
    border-color: var(--vscode-focusBorder);
    background-color: color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent);
  }
  /* 全承認（確認を一切しない）。選ぶ前から注意色で縁取り、選ぶと更に濃くする */
  .levelOption-unsafe { border-color: var(--vscode-charts-yellow); }
  .levelOption-unsafe:has(input:checked) {
    border-color: var(--vscode-errorForeground);
    background-color: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
  }
  select {
    width: 100%;
    padding: 3px 4px;
    color: var(--vscode-dropdown-foreground);
    background-color: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .hint {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    min-height: 1em;
  }
  .usage {
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .usage-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4px;
  }
  .usage-head .percent { font-weight: 600; font-size: 1.15em; }
  /*
   * 使用量の内訳（リセットまでの時間・プラン・取得時刻）。以前は .hint（0.85em の
   * descriptionForeground）で出していたが、割合の次に読む値なので1段上げる（issue #742）。
   * min-height は中身が空のときにレイアウトが動かないようにするため（.hint と同じ理由）。
   */
  .usage-meta {
    margin-top: 4px;
    min-height: 1em;
    font-size: 0.95em;
    color: var(--vscode-foreground);
  }
  /*
   * バーの太さはワークフロー画面（workflowStyles.ts の #progressBar）と揃えて 8px（issue #742）。
   * トラックは opacity を掛けるのではなく color-mix で薄い色を作る。opacity は子要素にも
   * 掛かるため .fill { opacity: 1 } で打ち消す必要があり、ハイコントラストテーマでは
   * トラックが背景と同化していた。
   * contrastBorder はハイコントラストテーマでのみ定義される。outline なので通常のテーマでは
   * transparent に落ちて何も描かれず、レイアウトにも影響しない。
   */
  .bar {
    height: 8px;
    border-radius: 4px;
    background-color: color-mix(
      in srgb,
      var(--vscode-progressBar-background, var(--vscode-editorWidget-border)) 30%,
      transparent
    );
    outline: 1px solid var(--vscode-contrastBorder, transparent);
    outline-offset: -1px;
  }
  .bar .fill {
    height: 100%;
    border-radius: 4px;
    background-color: var(--vscode-charts-blue);
    transition: width 0.2s ease;
  }
  .bar .fill.warning { background-color: var(--vscode-charts-yellow); }
  .bar .fill.critical { background-color: var(--vscode-charts-red); }
  button {
    width: 100%;
    padding: 5px 8px;
    margin-top: 2px;
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
  }
  button:hover { background-color: var(--vscode-button-hoverBackground); }
  button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  /* 折りたたまれたセクションの中にしか出ていない異常のまとめ（issue #741）。
     書式はワークフロー画面の #banner（workflowStyles.ts）へ揃える（#757 で共通化する対象）。
     押せる要素なので button だが、ボタンの既定の見た目（幅・背景）は打ち消す */
  #alertBanner {
    display: block;
    width: 100%;
    margin: 0 0 8px;
    padding: 6px 10px;
    border-radius: 3px;
    border: 1px solid;
    background-color: transparent;
    font-size: 0.9em;
    text-align: left;
    cursor: pointer;
  }
  #alertBanner.error {
    border-color: var(--vscode-errorForeground);
    color: var(--vscode-errorForeground);
    background-color: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
  }
  #alertBanner.warning {
    border-color: var(--vscode-charts-yellow);
    color: var(--vscode-charts-yellow);
    background-color: color-mix(in srgb, var(--vscode-charts-yellow) 12%, transparent);
  }
  /* 押せることが分かるよう、hoverでだけ濃くする（色そのものは変えない） */
  #alertBanner.error:hover {
    background-color: color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent);
  }
  #alertBanner.warning:hover {
    background-color: color-mix(in srgb, var(--vscode-charts-yellow) 20%, transparent);
  }
  /* セクション見出しの集計（issue #740）。異常の強調は先頭の帯（issue #741）が担うので、
     ここでは色を付けず件数だけを出す */
  .sectionCount {
    margin-left: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    font-weight: normal;
  }
  .tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  /*
   * どちらのプロバイダを編集しているかを取り違えると、設定が反対側のCLIに入る（issue #743）。
   * 太さの差だけではサイドバーの小さい字で判別しにくいので、選択中には背景と2pxの下線を付ける。
   *
   * 非選択を opacity で薄くすると、フォーカスリング（button:focus の outline）まで薄くなる。
   * 文字色を descriptionForeground へ落とす形にして、リングの濃さは保つ。
   *
   * 下線は非選択側も 2px の transparent にしてある。選択時に太さが変わると、選択の切り替えで
   * タブの高さが1pxずつ動く。
   */
  .tabs button {
    width: auto;
    flex: 1;
    margin-top: 0;
    padding: 4px 8px;
    color: var(--vscode-descriptionForeground);
    background-color: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
  }
  /* 選択中を除くのは、hover の背景が選択中の背景を打ち消して選択が見えなくなるため
     （同じ詳細度で後に来た規則が勝つ） */
  .tabs button:not([aria-selected='true']):hover {
    background-color: var(--vscode-toolbar-hoverBackground, transparent);
  }
  .tabs button[aria-selected='true'] {
    font-weight: 600;
    color: var(--vscode-foreground);
    background-color: var(--vscode-tab-activeBackground, var(--vscode-editorWidget-background));
    border-bottom-color: var(--vscode-focusBorder);
  }
  .note {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    line-height: 1.5;
  }
  .section {
    margin: 16px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .section summary.sectionTitle {
    margin: 0 0 8px;
    padding-top: 0;
    border-top: none;
    cursor: pointer;
    /* 三角マーカーはブラウザ標準のものをそのまま使う（design.md §16.8の見た目変更範囲外） */
  }
  .section summary.sectionTitle:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  /*
   * セクション見出しのアイコン（issue #739）。中身はインラインSVG（controlPanelIcons.ts）。
   *
   * summary の display は変えていない。display を flex や block にすると折りたたみの
   * 三角マーカー（::marker）が消えるため、インラインのspanで包んで縦位置だけを揃える。
   * inline-flex は SVG のベースライン下がりを打ち消すためで、vertical-align で
   * 文字の中心に寄せる。
   *
   * 色は指定しない。SVG側が currentColor を使っているので、見出しの文字色にそのまま従う。
   */
  .sectionIcon {
    display: inline-flex;
    vertical-align: -2px;
    margin-right: 5px;
  }
  .section .sectionBody { padding-top: 2px; }
  /* 承認の下位項目（承認の詳細）。アカウント等の大セクションと同じ重さに見えないよう、
     区切り線を引かず余白も詰める */
  .subsection {
    margin: 4px 0 0;
    padding-top: 0;
    border-top: none;
  }
  .subsection summary.sectionTitle { margin: 0 0 4px; }
  .sectionLoading {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .mcpList { display: flex; flex-direction: column; gap: 6px; }
  .mcpEmpty, .mcpError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .mcpError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  /*
   * 一覧の項目（カード）にマウスを乗せたときの反応（issue #746）。
   *
   * 枠だけだとどこまでが1件なのか追いにくい。VS Codeの一覧と同じ
   * --vscode-list-hoverBackground を使い、拡張機能の外の一覧と挙動を揃える。
   *
   * カード内のボタン（.hookTrustButton / .pluginItem-actions button / .importRunButton）は
   * --vscode-button-background の不透明な背景を持つので、カードの背景が変わっても
   * ボタンの読みやすさには影響しない。
   *
   * 枠の指定自体は各カードの規則に重複したまま残してある。まとめるのは共通トークンを
   * 入れるissue #757 の担当（先に片方だけ動かすと、あとで突き合わせる相手が消える）。
   */
  .mcpServer:hover,
  .hookItem:hover,
  .skillItem:hover,
  .pluginItem:hover,
  .appItem:hover,
  .importItem:hover,
  .importHistoryItem:hover {
    background-color: var(--vscode-list-hoverBackground);
  }
  .mcpServer {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
  }
  .mcpServer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mcpServer-name { font-weight: 600; }
  .mcpServer-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .mcpBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .mcpBadge-connected {
    color: var(--vscode-charts-green);
    border: 1px solid var(--vscode-charts-green);
  }
  .mcpBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .mcpBadge-unavailable {
    color: var(--vscode-charts-red);
    border: 1px solid var(--vscode-charts-red);
  }
  .hooksList { display: flex; flex-direction: column; gap: 6px; }
  .hooksEmpty, .hooksError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .hooksError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .hooksWarning {
    color: var(--vscode-charts-yellow, var(--vscode-descriptionForeground));
    font-size: 0.85em;
  }
  .hookItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
  }
  .hookItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .hookItem-name { font-weight: 600; }
  .hookItem-command {
    margin: 4px 0 0;
    padding: 4px 6px;
    white-space: pre-wrap;
    word-break: break-all;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    background-color: var(--vscode-textCodeBlock-background, transparent);
    border-radius: 2px;
  }
  .hookItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    word-break: break-all;
  }
  .hookTrustButton {
    width: auto;
    margin-top: 6px;
    padding: 3px 10px;
  }
  .hookBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .hookBadge-trusted {
    color: var(--vscode-charts-green);
    border: 1px solid var(--vscode-charts-green);
  }
  .hookBadge-untrusted, .hookBadge-modified {
    color: var(--vscode-charts-red);
    border: 1px solid var(--vscode-charts-red);
  }
  .hookBadge-managed, .hookBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .skillsList { display: flex; flex-direction: column; gap: 6px; }
  .skillsEmpty, .skillsError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .skillsError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .skillsWarning {
    color: var(--vscode-charts-yellow, var(--vscode-descriptionForeground));
    font-size: 0.85em;
  }
  .skillItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
  }
  .skillItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .skillItem-name { font-weight: 600; }
  .skillItem-desc {
    margin-top: 4px;
    color: var(--vscode-foreground);
    font-size: 0.85em;
    line-height: 1.4;
  }
  .skillItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    word-break: break-all;
  }
  .skillBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .skillBadge-user {
    color: var(--vscode-charts-blue);
    border: 1px solid var(--vscode-charts-blue);
  }
  .skillBadge-project {
    color: var(--vscode-charts-orange, var(--vscode-charts-yellow));
    border: 1px solid var(--vscode-charts-orange, var(--vscode-charts-yellow));
  }
  .skillBadge-plugin {
    color: var(--vscode-charts-purple, var(--vscode-charts-blue));
    border: 1px solid var(--vscode-charts-purple, var(--vscode-charts-blue));
  }
  .skillBadge-system, .skillBadge-admin, .skillBadge-unknown, .skillBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .accountBox { display: flex; flex-direction: column; gap: 6px; }
  .accountStatus {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .accountMeta {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .accountActions .note { border-top: none; padding-top: 0; margin-top: 6px; }
  .pluginsList, .appsList { display: flex; flex-direction: column; gap: 6px; }
  .pluginsEmpty, .pluginsError, .appsEmpty, .appsError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .pluginsError, .appsError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .pluginsWarning {
    color: var(--vscode-charts-yellow, var(--vscode-descriptionForeground));
    font-size: 0.85em;
  }
  .pluginItem, .appItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
  }
  .pluginItem-head, .appItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pluginItem-name, .appItem-name { font-weight: 600; }
  .pluginItem-desc, .appItem-desc {
    margin-top: 4px;
    color: var(--vscode-foreground);
    font-size: 0.85em;
    line-height: 1.4;
  }
  .pluginItem-meta, .appItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    word-break: break-all;
  }
  .pluginBadge, .appBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .pluginBadge-enabled, .appBadge-enabled {
    color: var(--vscode-charts-green);
    border: 1px solid var(--vscode-charts-green);
  }
  .pluginBadge-disabled, .appBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .pluginItem-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .pluginItem-actions button, .pluginInstallButton {
    width: auto;
    padding: 3px 10px;
  }
  .sectionSubTitle {
    margin: 12px 0 6px;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
  }
  .importList, .importHistoryList { display: flex; flex-direction: column; gap: 6px; }
  .importEmpty, .importError, .importHistoryEmpty {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .importError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .importItem, .importHistoryItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
  }
  .importItem-head, .importHistoryItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .importItem-name { font-weight: 600; }
  .importItem-desc {
    margin-top: 4px;
    color: var(--vscode-foreground);
    font-size: 0.85em;
    line-height: 1.4;
    word-break: break-all;
  }
  .importItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    word-break: break-all;
  }
  .importBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .importBadge-home {
    color: var(--vscode-charts-blue);
    border: 1px solid var(--vscode-charts-blue);
  }
  .importBadge-project {
    color: var(--vscode-charts-orange, var(--vscode-charts-yellow));
    border: 1px solid var(--vscode-charts-orange, var(--vscode-charts-yellow));
  }
  /*
   * バッジを色以外でも見分けられるようにする（issue #759）。
   * ワークフロー画面が既に採っている方針（workflowStyles.ts 冒頭・design.md §16.8の
   * 「色だけに頼らない」）を設定パネルへも広げる。
   *
   * 各バッジには既に状態名の文字が載っている（「接続済み」「未信頼」「無効」など）ので、
   * ここで足すのは2つ目の手掛かりにあたる。
   *
   * - 状態（良好・危険・無効）は先頭の記号で分ける
   * - 出どころ（user / project / plugin、home / project）は枠線の線種で分ける。
   *   出どころは状態ではないので記号を割り当てず、ワークフロー画面のノードが
   *   stroke-dasharray で種別を分けているのと同じ手を使う
   *
   * 記号は全角1文字ぶんの幅しか増やさない。バッジは white-space: nowrap なので、
   * 折り返しは起きない。
   *
   * 出どころの規則は各バッジの border 一括指定より後に置くこと。詳細度が同じなので、
   * 前に置くと border: 1px solid に上書きされて線種が消える。
   */
  .mcpBadge-connected::before,
  .hookBadge-trusted::before,
  .pluginBadge-enabled::before,
  .appBadge-enabled::before {
    content: '●';
  }
  .mcpBadge-unavailable::before,
  .hookBadge-untrusted::before,
  .hookBadge-modified::before {
    content: '▲';
  }
  .mcpBadge-disabled::before,
  .hookBadge-managed::before,
  .hookBadge-disabled::before,
  .skillBadge-disabled::before,
  .skillBadge-system::before,
  .skillBadge-admin::before,
  .skillBadge-unknown::before,
  .pluginBadge-disabled::before,
  .appBadge-disabled::before {
    content: '○';
  }
  .mcpBadge::before,
  .hookBadge::before,
  .skillBadge::before,
  .pluginBadge::before,
  .appBadge::before {
    margin-right: 3px;
    font-size: 0.9em;
  }
  /* 出どころの線種。project は clone しただけで効く経路なので、実線から外して目立たせる。
     user / home の実線は border 一括指定の既定と同じ値だが、割り当てを明示するために書く
     （書かないと「線種を割り当て忘れた」のか「実線を選んだ」のかが読めない） */
  .skillBadge-user, .importBadge-home { border-style: solid; }
  .skillBadge-project, .importBadge-project { border-style: dashed; }
  .skillBadge-plugin { border-style: dotted; }
  .importRunButton {
    width: auto;
    margin-top: 4px;
    padding: 5px 10px;
  }
  .importHistoryItem-time { font-weight: 600; }
  .importHistoryItem-provider {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }
  .importHistoryItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .importHistoryItem-failure {
    margin-top: 2px;
    color: var(--vscode-errorForeground, var(--vscode-charts-red));
    font-size: 0.8em;
    word-break: break-all;
  }
${reducedMotionStyles()}
`;
}
