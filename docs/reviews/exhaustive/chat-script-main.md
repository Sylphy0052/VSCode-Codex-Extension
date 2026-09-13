# チャット画面スクリプト全体の精査

対象は`src/view/chatScript.ts`全3617行。外側の引数と既定値だけでなく、返すテンプレート内の全関数・イベント・分岐を読んだ。補間されるMarkdown、highlight、sendKey、deltaは各記録と接続して確認。テスト内容は[Webviewスクリプト試験](webview-script-tests.md)、[ゴール下書き試験](session-tree-manager-base.md)、[チャットHTML試験](chat-view-main.md)に記録済み。今回も実行なし。

## 確認範囲

初期state/設定の保持、項目生成・再利用・削除、種別/状態ラベルと色、コピー成功/失敗、分岐/巻戻し/編集再送/相談操作、折畳み・Markdown・表・引用・入れ子リスト・コード操作、画像キャッシュ/要求/失敗、検索結果の折畳み、差分パスと操作を確認した。リンクはホストへ渡し、表示本文はDOMのtextContent/createTextNodeを使う。agentLabel等の直接補間は呼出元の固定値が前提。

承認とAskUserQuestionの再利用、質問の選択/自由入力/拒否、通常promptの再描画、設定select/default/一覧外/effort/plan/fast、TODO/背景タスク/queue、スクロール、会話移動、遅延復元、添付の選択/貼付/D&D、上限/コスト/トークン、ループ開始/停止/ゴール下書きの採番と編集保護を追った。スラッシュ/@補完、送信、入力履歴、全ボタン、overflowの位置/フォーカス、Escape/IME/Shift+Tab、messageごとの更新、full再要求も読んだ。

## EX-CHATUI-01[P2]:メニューを閉じるEscapeが応答も中断する

`chatScript.ts:3294`付近のoverflowと3460行付近の補完メニューはEscapeをpreventDefaultして閉じるが、伝播を止めない。documentのEscapeリスナーはdefaultPreventedを確認せず、stopが表示中ならinterruptを送る。応答中にメニューだけを閉じた操作で本流の応答を中断する。編集欄とqueue取出しはstopPropagationしており、この2経路だけ条件が異なる。現在の文字列試験はメニュー位置や操作断片を確認するが、入れ子イベントの伝播と送信回数を検査しない。

## 既存指摘とテスト不足

F03-07/08/09の途中分岐IDと失敗後disabled固定、F05の送信直後クリア・queue位置指定・取出し後の入力上書き・補完のIME割込、F08のノード順序とMarkdown更新時の選択破棄・disabled項目へのフォーカス、F09-06の編集再送失敗時の下書き喪失、F10のprompt全再生成・radio名衝突・required未検査を本文でも確認した。EX-MARKDOWN-01のchecked持越しはcreateListのcheckbox表示へ接続する。

画像の読取失敗後はimageAskedが残り再要求しない。workspaceRoots変更だけではdiffKeyが同じなら操作ボタンを作り直さない。AskUserQuestionの同一質問文はanswersのキーが重なり、複数問の回答が最後の値になる。ゴール下書きの入力写しはcontinuePrompt/上限を含まず、通常state更新のapplyLoopは下書き中の開始disabledを上書きする。これらの境界、FileReader失敗、リサイズ/折畳み後の会話移動位置、実ブラウザのIME・フォーカス・イベント伝播は現行の断片検査だけでは保証されない。画像/各操作の実機試験も未実行。
