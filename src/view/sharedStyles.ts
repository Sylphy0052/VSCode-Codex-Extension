/**
 * 4画面（チャット・設定パネル・進捗・ワークフローView）で共通のスタイル（issue #757）。
 *
 * 各画面のスタイル関数（`chatStyles` / `controlPanelStyles` / `progressStyles` /
 * `workflowStyles`）が、返す文字列の先頭にこれを連結する。画面ごとに別々の値を書いた結果、
 * 同じ意味の要素が画面ごとに違う見た目になっていた（角丸2/3/4/6/8/10px、進捗バーの高さ
 * 8/8/10px など）ため、寸法と枠線をカスタムプロパティ1箇所へ集約する。
 *
 * **色そのものはここで決めない。** 決めるのは寸法と、テーマ変数の束ね方だけ。色は各画面が
 * これまでどおり `var(--vscode-*)` を直接使う。ここで独自の色を持つと、テーマの追随が
 * この1ファイルの更新漏れで止まる。
 *
 * `[hidden]` の打ち消しもここへ置く。4画面すべてが同じ規則を別々に書いており、画面を
 * 足したときに書き忘れる形になっていた（`webviewStyles.test.ts` が全画面で有無を見張る）。
 */
export function sharedStyles(): string {
  return `
  /*
   * hidden属性を常に効かせる。display指定のある要素はhiddenより詳細度が高く、
   * 隠したつもりの領域が出しっぱなしになる事故が続いたため、一律に打ち消す。
   */
  [hidden] { display: none !important; }
  :root {
    /* 角丸。ボタン・入力欄が sm、カード・箱・バナーが md、会話の発言が lg、
       バッジ（丸い枠つきラベル）が pill */
    --agent-radius-sm: 2px;
    --agent-radius-md: 4px;
    --agent-radius-lg: 6px;
    --agent-radius-pill: 10px;

    /* 進捗バー。高さと角丸は対で使う（角丸は高さの半分） */
    --agent-bar-height: 8px;
    --agent-bar-radius: 4px;
    /*
     * バーの下地。opacity を箱へ掛けると中身の塗りまで薄くなる（子で opacity: 1 へ
     * 戻せない）ため、透過は color-mix で色そのものに掛ける。
     */
    --agent-bar-track: color-mix(
      in srgb,
      var(--vscode-progressBar-background, var(--vscode-editorWidget-border)) 30%,
      transparent
    );

    /*
     * 枠線の色（issue 758）。--vscode-widget-border は全テーマが定義しているわけでは
     * なく、transparent へ落とすと幅だけ残って区切りが消える。実在する変数を後段に置く。
     */
    --agent-border: var(--vscode-widget-border, var(--vscode-editorWidget-border));

    /* バッジ（丸い枠つきラベル）の内側の余白と文字の大きさ */
    --agent-badge-padding: 1px 6px;
    --agent-badge-font-size: 0.8em;
  }
`;
}
