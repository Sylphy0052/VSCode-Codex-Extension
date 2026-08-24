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
  /*
   * 応答中かどうかを画面の外周で示す（issue #701）。ログ本文を読んでいる最中でも
   * 視界の端で状態が分かるようにするため、bodyの内側に固定位置の枠を1本重ねる。
   * position: fixed の擬似要素にすることで、既存のflexレイアウトの高さ計算に
   * 影響を与えず、pointer-events: none で下の要素の操作も妨げない。
   */
  body::after {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    /* #logより前面に出れば足りる。浮き出すメニュー類（z-index: 10）には譲る */
    z-index: 1;
    border: 2px solid var(--vscode-charts-blue);
  }
  /* 応答中は赤。busyクラスの付け外しは chatScript.ts の apply() が行う */
  body.busy::after { border-color: var(--vscode-charts-red); }
  #logWrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #log { flex: 1; overflow-y: auto; padding: 12px 16px; }
  #scrollToBottom {
    position: absolute;
    right: 20px;
    bottom: 12px;
    z-index: 10;
    width: 30px;
    height: 30px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 1px solid var(--vscode-widget-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }
  #scrollToBottom:hover { background: var(--vscode-button-secondaryHoverBackground); }
  /*
   * 発言の種別ごとに余白を変えて、ターンの切れ目を余白の広さでも示す（issue #712）。
   * 自分の発言の手前を広く空け、同じターンの中に連なる思考・ツール出力は詰める。
   * #log は通常のブロック整形なので、隣り合う項目の上下marginは相殺され広いほうが残る。
   */
  .item { margin-bottom: 12px; }
  .item.user { margin-top: 22px; }
  .item.reasoning, .item.tool { margin-bottom: 6px; }
  /* 会話の先頭が不自然に落ちないよう、最初の項目だけは上を空けない */
  #log > .item:first-child { margin-top: 0; }
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
  /*
   * エージェントの応答にも縁取りを付ける（issue #712）。ここに何も無いと、応答が長い
   * ときにターンの切れ目が本文の途切れ方でしか分からない。自分の発言（textLink色の線と
   * 背景）より弱い線にして、どちらが自分の発言かは引き続き見分けられるようにする。
   * 応答中は下の .item.running が progressBar 色でこの線を上書きする（詳細度で勝つ）。
   */
  .agent .body {
    padding-left: 10px;
    border-left: 2px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .reasoning .body-content { color: var(--vscode-descriptionForeground); font-style: italic; }
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
  .item.running .body,
  .item.running .body-fold {
    border-left: 2px solid var(--vscode-progressBar-background);
  }
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
  /* .approvalはAskUserQuestion（issue #685）の選択UIがここを使う */
  .prompt .field, .approval .field { margin-bottom: 10px; }
  .prompt .field-label, .approval .field-label {
    margin-bottom: 2px;
    font-weight: 600;
    font-size: 0.9em;
  }
  .prompt .field-desc, .approval .field-desc {
    margin-bottom: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    white-space: pre-wrap;
  }
  .prompt .option, .approval .option {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }
  .prompt input[type='text'], .prompt input[type='password'], .prompt input[type='number'],
  .approval input[type='text'] {
    padding: 3px 6px;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  .prompt .other, .approval .other { flex: 1; }
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
  /*
   * 下部を3段に固定する（issue #234）。1段目（#composerInputRow）は入力欄と送信/中断、
   * 2段目（#composerIconRow）はアイコン列、3段目は#settings（モデル・Effort等の
   * ドロップダウン群）。#composerをflex-direction: columnにして段を縦に積み、折り返しは
   * 各行の中だけで起こす。こうすることで幅が狭くなっても、アイコンが1段目へ回り込んだり
   * 入力欄が潰れたりしない。
   */
  #composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  #composerInputRow {
    display: flex;
    gap: 8px;
  }
  #composerIconRow {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  /*
   * 送信以外のボタンはアイコンのみ（issue #226）。ラベルを消していても折り返すと
   * 縦に潰れて読みにくいため、ボタン自体はnowrap・縮小なしのままにする。
   */
  #composer button {
    white-space: nowrap;
    flex-shrink: 0;
  }
  #composer button:not(#send) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 6px;
  }
  #composer button:not(#send) svg { display: block; }
  /*
   * アイコン列の「…」メニュー（issue #296）。位置の基準にするため入れ物
   * （#composerOverflow）だけ相対配置にし、メニュー本体（#composerOverflowMenu）は
   * トグルボタンの右下に絶対配置で開く。#commandsと同じ浮き出し方（枠線・影・z-index）
   * に揃える。
   */
  #composerOverflow { position: relative; display: inline-flex; }
  #composerOverflowMenu {
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    min-width: 180px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    background-color: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    z-index: 10;
  }
  /*
   * メニュー項目はアイコンのみだった元のボタンにラベル文字列を添えて出す
   * （renderComposerButtonのmenu variant）。「tooltipを読むまで区別できない」という
   * 課題の発端を畳んだ先で繰り返さないため、ここだけは左寄せ・横幅いっぱいにする
   * （#composer button:not(#send)の中央寄せ・詰め padding を上書き。同じ詳細度なので
   * 後発のこの規則が勝つ）。
   */
  #composerOverflowMenu button:not(#send) {
    justify-content: flex-start;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
  }
  .composerOverflowLabel { white-space: nowrap; }
  #composerInputRow textarea {
    /* ボタン列に押し潰されても入力欄だと分かる最小幅を確保する */
    min-width: 160px;
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
  /* 行頭の !/# で何が起きるかを送信前に見せる（issue #5/#6、Claude Code画面のみ） */
  #inputModeHint {
    margin: 0 16px 4px;
    color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
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
  /* 追加クレジットの要求ボタン（issue #204）。フッターの文言に混ぜて出すため小さく揃える */
  #status button {
    padding: 1px 8px;
    font-size: 1em;
    vertical-align: baseline;
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
   * TODO一覧と同じ並びに置く。既定は折りたたみ（issue #678）。#settingsBoxと同じ
   * details/summaryパターンで、閉じていても件数だけは分かるようにする。
   */
  #backgroundTerminals {
    margin: 0 16px 8px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
    font-size: 0.9em;
  }
  #backgroundTerminals > summary {
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #backgroundTerminals > summary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  #backgroundTerminals > summary .label { font-weight: 600; }
  #backgroundTerminalsSummary { margin-left: 8px; }
  #backgroundTerminals ul { margin: 4px 0 0; padding: 0; list-style: none; }
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
  .body, .body-content { user-select: text; cursor: text; }
  /*
   * 設定は既定で折りたたむ（issue #266）。開いたままだとドロップダウン群と但し書きで
   * 下部が6行前後を占め、会話の見える量を削ってしまう。閉じているときは現在値の
   * 1行サマリだけを見せ、何で動いているかは分かるようにする。
   */
  #settingsBox {
    padding: 0 16px 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #settingsBox > summary {
    cursor: pointer;
    /* display:flexにすると開閉の三角が消えるため、既定のlist-itemのままにする */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #settingsBox > summary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  #settingsBox > summary .label { font-weight: 600; }
  #settingsSummary { margin-left: 8px; }
  #settings {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 8px 0 2px;
  }
  #settings label {
    display: flex;
    align-items: center;
    gap: 4px;
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
  /* 「承認の詳細」。承認は3段階のセレクタを主にし、生の値はここへ畳む。行を折り返して
     全幅に置き、開いたときの中身は他の設定と同じ横並びにする */
  #approvalDetails { flex-basis: 100%; }
  #approvalDetails > summary {
    cursor: pointer;
    white-space: nowrap;
  }
  #approvalDetails > summary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  #approvalDetails .detailBody {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 6px 0 2px;
  }
  /* 変更がいつから効くかの但し書き。行を折り返して全幅に置く */
  #settings .note {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.95em;
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    cursor: pointer;
    user-select: none;
  }
  .diff[open] > summary {
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .diff-label { overflow-wrap: anywhere; }
  /* 差分の見出し行の操作ボタン（issue #291）。コードブロックのmd-code-actionsと揃える */
  .diff-actions { display: flex; flex-shrink: 0; gap: 4px; flex-wrap: wrap; }
  .diff-actions button { padding: 1px 8px; font-size: 0.85em; }
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

  /* ツール出力系（コマンド実行・思考・MCP呼び出し等）の既定折りたたみ（issue #679）。
     diffと同じ体裁に揃える */
  .body-fold {
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
  }
  .body-fold > summary {
    padding: 4px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    cursor: pointer;
    user-select: none;
  }
  .body-fold[open] > summary {
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .body-content {
    max-height: 420px;
    margin: 0;
    padding: 6px 8px;
    overflow: auto;
    background-color: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /*
   * 応答本文のMarkdown描画（issue #290）。'.body' 直下だけに効かせる（'.tool .body'
   * などコマンド出力・思考は従来どおり生テキストのままのため、ここには来ない）。
   */
  .body > *:first-child { margin-top: 0; }
  .body > *:last-child { margin-bottom: 0; }
  .body p { margin: 0 0 8px; }
  .body h1, .body h2, .body h3, .body h4, .body h5, .body h6 {
    margin: 10px 0 6px;
    line-height: 1.3;
    font-weight: 600;
  }
  .body h1 { font-size: 1.3em; }
  .body h2 { font-size: 1.2em; }
  .body h3 { font-size: 1.1em; }
  .body h4, .body h5, .body h6 { font-size: 1em; }
  .body ul, .body ol { margin: 4px 0 8px; padding-left: 1.4em; }
  .body ul ul, .body ul ol, .body ol ul, .body ol ol { margin: 2px 0; }
  .body li { margin: 2px 0; }
  .body strong { font-weight: 600; }
  .body em { font-style: italic; }
  .body s { color: var(--vscode-descriptionForeground); }
  .body a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .body a:hover { text-decoration: underline; }
  .body hr {
    margin: 10px 0;
    border: none;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  /* タスクリスト（issue #332）。チェックボックスは表示専用（クリック不可）で操作は伴わない */
  .md-task-item { list-style: none; margin-left: -1.4em; }
  .md-task-item input[type="checkbox"] { margin-right: 4px; vertical-align: middle; }
  .body blockquote.md-quote {
    margin: 6px 0 10px;
    padding: 2px 10px;
    border-left: 3px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    color: var(--vscode-descriptionForeground);
  }
  /* 表（issue #332）。列が多いと画面幅を超えるため、ラップ要素だけを横スクロールさせる */
  .md-table-wrap { margin: 6px 0 10px; overflow-x: auto; }
  .md-table { border-collapse: collapse; width: max-content; min-width: 100%; }
  .md-table th, .md-table td {
    padding: 4px 10px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    text-align: left;
  }
  .md-table th { background-color: var(--vscode-editorWidget-background); font-weight: 600; }
  .md-table .md-align-left { text-align: left; }
  .md-table .md-align-center { text-align: center; }
  .md-table .md-align-right { text-align: right; }
  /* インラインコード。コードブロック内（.md-code pre code）は下で上書きする */
  .body code {
    padding: 1px 4px;
    border-radius: 3px;
    background-color: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  .md-code {
    margin: 6px 0;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    overflow: hidden;
  }
  .md-code-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    background-color: var(--vscode-editorWidget-background);
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }
  .md-code-lang { font-family: var(--vscode-editor-font-family); }
  .md-code-actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .md-code-actions button { padding: 1px 8px; font-size: 0.85em; }
  .md-code pre {
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    line-height: 1.45;
  }
  .md-code pre code {
    padding: 0;
    background-color: transparent;
    font-family: inherit;
    font-size: inherit;
  }
`;
}
