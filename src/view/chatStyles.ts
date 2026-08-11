/**
 * チャット画面のスタイル。
 *
 * テンプレートリテラルの中身なので型検査もlintも効かない。`hidden` を付けたのに
 * display指定に負けて出しっぱなしになる事故が続いたため、`webviewStyles.test.ts`
 * で打ち消し規則の有無と構文を確かめている。
 */
export function chatStyles(): string {
  return `
  html, body { height: 100%; margin: 0; }
  /*
   * hidden属性を常に効かせる。display指定のある要素は hidden より詳細度が高く、
   * 隠したつもりの領域が出しっぱなしになる事故が続いたため、ここで一律に打ち消す。
   */
  [hidden] { display: none !important; }
  body {
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  #log { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .item { margin-bottom: 12px; }
  .item .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 8px 10px;
    border-radius: 4px;
  }
  .user .body {
    background-color: var(--vscode-textBlockQuote-background);
    border-left: 2px solid var(--vscode-textLink-foreground);
  }
  .agent .body { padding-left: 0; }
  .tool .body {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    background-color: var(--vscode-textCodeBlock-background);
    max-height: 240px;
    overflow: auto;
  }
  .reasoning .body { color: var(--vscode-descriptionForeground); font-style: italic; }
  /* 会話に出す画像。既定はサムネイル、クリックで原寸まで広げる */
  .images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .image img {
    max-height: 160px;
    max-width: 100%;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border);
    cursor: zoom-in;
  }
  .image.zoom img { max-height: none; cursor: zoom-out; }
  .image-note {
    padding: 6px 8px;
    border-radius: 4px;
    background-color: var(--vscode-textCodeBlock-background);
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  /* 実行中のコマンド。完了したものと見分けが付くようにする */
  .item.running .body { border-left: 2px solid var(--vscode-progressBar-background); }
  .item.running .head { color: var(--vscode-foreground); }
  .approval {
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    border-radius: 4px;
    background-color: var(--vscode-inputValidation-warningBackground, transparent);
  }
  .approval h3 { margin: 0 0 6px; font-size: 1em; }
  /* ユーザーへの問い合わせ。承認カードと同じ場所・同じ系統の見た目にする */
  .prompt {
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
  }
  .prompt h3 { margin: 0 0 6px; font-size: 1em; }
  .prompt .source {
    margin: 0 0 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .prompt .message { margin: 0 0 8px; white-space: pre-wrap; }
  .prompt .note { margin: 0 0 8px; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .prompt-url {
    margin: 0 0 8px;
    padding: 6px 8px;
    overflow-x: auto;
    background-color: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
  }
  .prompt .field { margin-bottom: 10px; }
  .prompt .field-label { margin-bottom: 2px; font-weight: 600; font-size: 0.9em; }
  .prompt .field-desc {
    margin-bottom: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    white-space: pre-wrap;
  }
  .prompt .option { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
  .prompt input[type='text'], .prompt input[type='password'], .prompt input[type='number'] {
    padding: 3px 6px;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  .prompt .other { flex: 1; }
  .approval pre {
    margin: 0 0 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    padding: 4px 10px;
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
  }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background-color: var(--vscode-button-secondaryBackground);
  }
  /* 押しっぱなしのトグル。入っているかどうかが一目で分かるようにする */
  button.toggled {
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border-color: var(--vscode-focusBorder);
    font-weight: 600;
  }
  button:hover { background-color: var(--vscode-button-hoverBackground); }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  /* 送信前の添付画像。入力欄のすぐ上に並べ、送る前に取り消せるようにする */
  #attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 16px 0;
  }
  .attachment {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
    font-size: 0.85em;
  }
  .attachment img {
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: 2px;
  }
  .attachment .name {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
  }
  #composer {
    position: relative;
    display: flex;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  textarea {
    flex: 1;
    min-height: 54px;
    max-height: 200px;
    resize: vertical;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #approvals { padding: 0 16px; }
  #commands {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 100%;
    max-height: 240px;
    overflow-y: auto;
    margin-bottom: 4px;
    padding: 4px 0;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    background-color: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    z-index: 10;
  }
  #commands .row {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 3px 10px;
    cursor: pointer;
  }
  #commands .row.active {
    background-color: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-list-activeSelectionForeground);
  }
  #commands .name { font-weight: 600; white-space: nowrap; }
  #commands .desc {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  #commands .row.active .desc { color: inherit; }
  /* 引数の書き方。名前と別の色で添える（issue #9） */
  #commands .hint {
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  #commands .row.active .hint { color: inherit; }
  /* 候補を確定した後も書き方が見えるよう、入力欄の上に残す */
  #argumentHint {
    margin: 0 16px 4px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  #queue {
    margin: 0 16px 8px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
    font-size: 0.9em;
  }
  #queue .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    color: var(--vscode-descriptionForeground);
  }
  #queue ol { margin: 0; padding-left: 1.4em; }
  #queue li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 2px 0;
  }
  #queue li span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #status { padding: 0 16px 6px; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  /* コンテキストの残りが少ないとき。見落とすと突然の圧縮に驚かされる */
  #status .warn {
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-editorWarning-foreground));
    font-weight: 600;
  }
  /*
   * TODO一覧（Claude CodeのTodoWrite）。入力欄の上、ループ・コンテキスト表示と同じ並びに置く。
   * 会話には積まず、ここだけが書き変わる。
   */
  #todos {
    margin: 0 16px 8px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
    font-size: 0.9em;
  }
  #todos .head { color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  #todos ul { margin: 0; padding: 0; list-style: none; }
  #todos li { display: flex; align-items: baseline; gap: 6px; margin: 2px 0; }
  #todos li .mark {
    flex: none;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
  }
  /* 完了は取り消し線、進行中は太字にして一覧の中でも状態が見分けられるようにする */
  #todos li.completed { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  #todos li.in_progress { font-weight: 600; }
  /*
   * バックグラウンドで実行中のプロセス一覧（issue #33、design.md 14.23、Codexの/ps相当）。
   * TODO一覧と同じ並びに置く。
   */
  #backgroundTerminals {
    margin: 0 16px 8px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
    font-size: 0.9em;
  }
  #backgroundTerminals .head { color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  #backgroundTerminals ul { margin: 0; padding: 0; list-style: none; }
  #backgroundTerminals li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 2px 0;
  }
  #backgroundTerminals li .command {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  #backgroundTerminals li .note {
    flex: none;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .item .head .actions { display: flex; gap: 6px; flex: none; }
  .item .head .actions button { padding: 1px 8px; font-size: 0.85em; }
  /* 本文は選択してコピーできるようにする */
  .body { user-select: text; cursor: text; }
  #settings {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 0 16px 12px;
  }
  #settings label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #settings select {
    padding: 2px 4px;
    color: var(--vscode-dropdown-foreground);
    background-color: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  #settings select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  /* 変更がいつから効くかの但し書き。行を折り返して全幅に置く */
  #settings .note {
    flex-basis: 100%;
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }
  #loop {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  #loop label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #loop textarea { flex: none; min-height: 40px; }
  #loop input {
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  #loop input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #loop .line { display: flex; gap: 12px; align-items: flex-end; }
  #loop .line label.grow { flex: 1; }
  #loop .line input[type='number'] { width: 72px; }
  #loopBar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .diffs { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .diff {
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
  }
  .diff > summary {
    padding: 4px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    cursor: pointer;
    user-select: none;
  }
  .diff[open] > summary {
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .diff-body {
    /* 長い差分でも会話全体が伸びきらないようにする */
    max-height: 420px;
    margin: 0;
    padding: 6px 8px;
    overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    line-height: 1.45;
    white-space: pre;
  }
  .diff-body span { display: block; }
  .diff-add {
    background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(80, 200, 120, 0.16));
    color: var(--vscode-gitDecoration-addedResourceForeground, inherit);
  }
  .diff-del {
    background-color: var(--vscode-diffEditor-removedTextBackground, rgba(220, 90, 90, 0.16));
    color: var(--vscode-gitDecoration-deletedResourceForeground, inherit);
  }
  .diff-hunk { color: var(--vscode-descriptionForeground); }
  /* Web検索結果（issue #18）。URLは全部見せる。クリックで外部ブラウザへ */
  .search-results { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .search-result {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 6px 8px;
    color: inherit;
    background-color: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
    text-align: left;
  }
  .search-result:hover { background-color: var(--vscode-list-hoverBackground); }
  .search-result-title { color: var(--vscode-textLink-foreground); }
  .search-result-url {
    overflow-wrap: anywhere;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .search-results-fold > summary {
    padding: 4px 0;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    cursor: pointer;
    user-select: none;
  }
  .search-results-fold[open] > summary { margin-bottom: 4px; }
  .search-results-fold .search-result { margin-bottom: 4px; }
`;
}
