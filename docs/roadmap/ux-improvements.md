# 利用者目線のUX改善

利用者としてこの拡張機能を使ったときに引っかかる点を洗い出し、11項目へ整理したロードマップ。
出典は2026-08-16のレビュー（機能の不足ではなく、既にある機能へ届かない・気づけないことが中心）。
進捗の追跡は epic Issue [#297](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/297) に集める。

> **このロードマップは R1〜R11 すべて完了済み。** epic Issue #297 もクローズしてある。
> 以降は着手時の記録として残してあるだけで、新しく着手する項目は無い。
> 現在動いているロードマップは [review-and-feature-consolidation.md](review-and-feature-consolidation.md) を見ること。

方針は次の3つ。

1. **裏で走らせたタスクの状態が分かること**を最優先にする。複数タブ並列が前提の拡張でありながら、
   完了も承認待ちも利用者に届いていない
2. **VSCodeの中にいる利点**（エディタ・差分ビューア・検索・キーバインド）を会話へ繋ぐ
3. **既定の挙動は変えない。** 送信キーやボタン配置は設定で選べるようにし、既定は現状のまま置く

各項目の `依存` はロードマップのパーサ（[roadmap.ts](../../src/orchestrator/roadmap.ts)）が読む形式に合わせてある。
この形式のまま `Agent: ゴール文からワークフローを生成…` の「ロードマップから生成」でYAML化できる。

## フェーズ1 即効（低コスト・体感差大）

- [x] R1 応答の完了と承認待ちを利用者へ届ける
  - 依存: なし
  - Issue: #286
  - 現状: 背面タブでターンが終わっても承認カードが出ても、通知もタブ名の変化もない。履歴ツリーのアイコンは
    「開いているか」だけを見る（[sessionTreeProvider.ts:100](../../src/view/sessionTreeProvider.ts#L100)）
  - 変更: (a) タブ名の先頭へ状態の印を付ける（実行中・承認待ち）、(b) 履歴ツリーのアイコンとdescriptionへ同じ状態を出す、
    (c) 承認待ちになったタブが非表示のときだけ通知を出し、「開く」で当該タブをreveal する
  - 受入基準: 背面タブで承認要求が出た直後に通知が1回出る／同じ要求で通知が重複しない／
    タブを表に出している間は通知を出さない／設定で全ての通知を止められる
  - 追加設定: `agent.notifications.approvalPending`（既定 `true`）、`agent.notifications.turnComplete`（既定 `false`）
  - 影響: [chatView.ts](../../src/view/chatView.ts) / [claudeChatView.ts](../../src/view/claudeChatView.ts) /
    [sessionTreeProvider.ts](../../src/view/sessionTreeProvider.ts) / [extension.ts](../../src/extension.ts)

- [x] R2 チャット画面でCtrl+Fを効かせる
  - 依存: なし
  - Issue: #287
  - 現状: `enableFindWidget` を渡していないため検索できない
    （[chatView.ts:895](../../src/view/chatView.ts#L895) / [claudeChatView.ts:688](../../src/view/claudeChatView.ts#L688) /
    [workflowView.ts:107](../../src/view/workflowView.ts#L107)）
  - 変更: 3つのWebviewPanelの生成オプションへ `enableFindWidget: true` を足す
  - 受入基準: チャットタブでCtrl+Fを押すと検索窓が出て、折り畳んでいない範囲の本文を検索できる
  - 備考: 折り畳んだ部分は検索対象にならない。この制約はREADMEの既知の制約へ1行足す

- [x] R3 送信キーを選べるようにする
  - 依存: なし
  - Issue: #288
  - 現状: Ctrl+Enter固定（[chatScript.ts:1786](../../src/view/chatScript.ts#L1786)）。Enterは改行のまま
  - 変更: 設定 `agent.chat.sendOn` を足す。`ctrlEnter`（既定、現状維持）と `enter`（Enterで送信、Shift+Enterで改行）
  - 受入基準: `enter` にするとEnterで送信されShift+Enterで改行が入る／
    候補メニュー（`/` `@`）を開いている間はEnterが候補の確定として優先される／既定値では現状と同じ挙動
  - 影響: [chatScript.ts](../../src/view/chatScript.ts) / [chatView.ts](../../src/view/chatView.ts) / package.json

- [x] R4 主要コマンドへ既定のキーバインドを割り当てる
  - 依存: なし
  - Issue: #289
  - 現状: `contributes.keybindings` が無く、全ての操作がコマンドパレットかクリック経由
  - 変更: 新しい会話（Codex / Claude Code）・直前のセッションを再開・ワークフローViewを開く へ既定を割り当てる。
    VSCode既定および主要拡張との衝突を調べたうえで、和音（`Ctrl+K` 始まり等）を軸に決める
  - 受入基準: 既定のキーバインドがVSCodeの既定と衝突しない／`when` 句で不要な場面には出さない／
    README の使い方の表へ載せる

## フェーズ2 会話を読めるようにする

- [x] R5 応答をMarkdownとして描画し、コードブロックを扱えるようにする
  - 依存: なし
  - Issue: #290
  - 現状: `textContent` と `white-space: pre-wrap` だけで、見出しも箇条書きも記号のまま
    （[chatScript.ts:266](../../src/view/chatScript.ts#L266) / [chatStyles.ts:35](../../src/view/chatStyles.ts#L35)）。
    コピーは項目の全文コピーのみ（[chatScript.ts:150](../../src/view/chatScript.ts#L150)）
  - 変更: (a) 見出し・箇条書き・強調・インラインコード・コードブロック・リンクを描画する、
    (b) コードブロックごとに「コピー」「エディタへ挿入」「新規ファイルで開く」を付ける、
    (c) 設定 `agent.chat.renderMarkdown`（既定 `true`）で生テキストへ戻せるようにする
  - 受入基準: 描画はWebview内で行い外部ライブラリを増やさない／エージェントの出力をHTMLとして評価しない
    （生成したDOMへテキストノードとして入れる。CSPは現状のまま）／
    リンクのクリックは既存の `openUrl` 経路を通し、外部ブラウザで開く／
    ストリーミング中の部分的なMarkdownでも描画が壊れない
  - 影響: [chatScript.ts](../../src/view/chatScript.ts) / [chatStyles.ts](../../src/view/chatStyles.ts) /
    [chatCsp.ts](../../src/view/chatCsp.ts)

- [x] R6 会話の差分からファイルとdiffを開けるようにする
  - 依存: なし
  - Issue: #291
  - 現状: パスを `<summary>` のテキストとして出すだけでクリックできない
    （[chatScript.ts:401-423](../../src/view/chatScript.ts#L401-L423)）
  - 変更: 差分の見出し行へ操作を足す。「エディタで開く」（該当行へ移動）、「差分を開く」（VSCodeのdiffエディタ）、
    「この変更を戻す」（確認ダイアログののち元へ戻す）
  - 受入基準: パスはワークスペース内へ解決できたときだけ操作を出す（外へ出るパスは操作を出さない）／
    「この変更を戻す」は実行前にモーダルで確認する／ファイルが既に消えている・変わっている場合は理由を出して何もしない
  - 影響: [chatScript.ts](../../src/view/chatScript.ts) / [chatView.ts](../../src/view/chatView.ts) /
    [claudeChatView.ts](../../src/view/claudeChatView.ts)

## フェーズ3 導線を増やす

- [x] R7 エディタの選択範囲をそのまま送れるようにする
  - 依存: なし
  - Issue: #292
  - 現状: `contributes.menus` に `editor/context` が無く、`@` によるファイル指定しか経路がない。
    「この関数だけ見せる」に行番号の手打ちが要る
  - 変更: エディタの右クリックへ「Agentへ送る」を足し、`パス:開始行-終了行` と選択本文を、
    アクティブなチャットタブの入力欄へ挿入する（送信はしない。人が指示を書き足してから送る）
  - 受入基準: チャットタブが1枚も無いときは新しい会話を開いてから挿入する／複数開いているときは直近にアクティブだったタブを使う／
    選択が空のときはメニュー自体を出さない（`editorHasSelection`）
  - 影響: package.json / [extension.ts](../../src/extension.ts) / [chatView.ts](../../src/view/chatView.ts)

- [x] R8 履歴を探せるようにする
  - 依存: なし
  - Issue: #293
  - 現状: 最大200件がフラットな1リストで並ぶだけ（[sessionTreeProvider.ts:47-61](../../src/view/sessionTreeProvider.ts#L47-L61)）。
    検索・グループ・ピン留めのいずれも無い。全ワークスペース表示にすると実質使えない
  - 変更: (a) 日付でグループ化する（今日・昨日・今週・それ以前。全ワークスペース表示では作業ディレクトリ別を選べる）、
    (b) タイトルバーへ絞り込みを足す（入力した語をセッション名と作業ディレクトリに対して照合する）、
    (c) ピン留め（`globalState` に保持し、先頭のグループへ出す）
  - 受入基準: グループ化してもツリー要素の `id` が一意のままで、右クリックのコマンドへ `SessionSummary` が渡る（issue #236の再発防止）／
    絞り込みは表示だけを変え、履歴の読み込み件数（`codex.history.maxEntries`）を変えない
  - 追加設定: `codex.history.groupBy`（`date` / `folder` / `none`、既定 `date`）
  - 影響: [sessionTreeProvider.ts](../../src/view/sessionTreeProvider.ts) / [extension.ts](../../src/extension.ts) / package.json

- [x] R9 Codexのセッション単位の使用量を画面へ出す
  - 依存: なし
  - Issue: #294
  - 現状: 金額はCodexに経路が無い（既知の制約）が、トークン数も会話中には出ていない。
    ステータスバーはレート制限の割合のみ（[usageStatusBar.ts](../../src/view/usageStatusBar.ts)）
  - 変更: Claude Code側のコスト表示と同じ場所（ステータス行）へ、Codexはセッション累計のトークン数を出す
  - 受入基準: 値が取れない間は枠ごと出さない（取れていないのか0なのかを混同させない）／
    金額を出さない理由を1行の補足として添える
  - 影響: [chatScript.ts](../../src/view/chatScript.ts) / [chatState.ts](../../src/appserver/chatState.ts) /
    [usage.ts](../../src/codex/usage.ts)

## フェーズ4 使い込んだときの摩擦を取る

- [x] R10 セッションのプリセットを保存して起動できるようにする
  - 依存: R4
  - Issue: #295
  - 現状: 新しい会話のたびにモデル・承認・サンドボックス・作業ディレクトリを組み直す。
    さらにマルチルートでは先頭フォルダ固定で作業ディレクトリを選べない（[config.ts:235](../../src/config.ts#L235)）
  - 変更: (a) 名前付きプリセット（provider・model・effort・承認・サンドボックス・作業ディレクトリ）を設定へ持つ、
    (b) プリセットを選んで新しい会話を開くコマンドを足す、
    (c) マルチルートのときは作業ディレクトリをQuickPickで選べるようにする
  - 受入基準: プリセットは拡張機能の設定より権限を緩める方向へは効かない（ワークフローYAMLと同じクランプの考え方を踏襲する）／
    プリセットが空のときはコマンドを出さない／作業ディレクトリの選択はワークスペースフォルダの中に限る
  - 追加設定: `agent.sessionPresets`（配列）
  - 影響: package.json / [extension.ts](../../src/extension.ts) / [config.ts](../../src/config.ts) /
    [controlPanelView.ts](../../src/view/controlPanelView.ts)

- [x] R11 入力欄のアイコン列を整理する
  - 依存: R5, R6, R10
  - Issue: #296
  - 現状: ラベルの無いアイコンが10個並ぶ（[chatView.ts:2062-2071](../../src/view/chatView.ts#L2062-L2071)）。
    使用頻度が大きく違う操作が同列に置かれ、tooltipを読むまで区別が付かない
  - 変更: よく使う4つを残し、残りを `...` のメニューへ畳む。表に出す並びは設定で変えられるようにする
  - 受入基準: 既存の全ての操作へ2手以内で到達できる／`...` の中身もキーボードで辿れる／
    条件付きで隠れるボタン（インポート・要約・高速・レビュー）が、畳んだあとも同じ条件で出入りする
  - 追加設定: `agent.chat.composerButtons`（配列。既定は現状の並びの先頭4つ）
  - 影響: [chatView.ts](../../src/view/chatView.ts) / [chatScript.ts](../../src/view/chatScript.ts) /
    [chatStyles.ts](../../src/view/chatStyles.ts)

## 進め方

- 1項目1 Issue・1ブランチ・1 PRとする。フェーズ内の項目は依存が無いので並行して進められる
- ロジック層（`vscode` を import しない層）へ寄せられる部分はユニットテストを付ける。
  Webviewの描画はスクリプト・スタイルを分離したまま構文と `hidden` の打ち消しをテストする（CONTRIBUTING.mdの方針を踏襲）
- 実VSCodeでしか確かめられない受入基準は [docs/manual-test.md](../manual-test.md) へ追記する
- 各項目の完了時にREADMEの使い方・設定・既知の制約を同じPRで更新する

## 番号の割り当て（実績）

着手前に設計書の節番号と手動テストのケース番号を割り当てていたが、並列で進めた結果、
実際に採番された番号は当初の割り当てとずれた。下表は**実際に使われた番号**である
（`docs/design.md` と `docs/manual-test.md` の見出しで確認した値）。

| 項目 | Issue | design.md | manual-test.md |
| --- | --- | --- | --- |
| R1 | #286 | §14.55 | U-15 |
| R2 | #287 | §14.48 | U-04 |
| R3 | #288 | §14.49 | U-05, U-06 |
| R4 | #289 | §14.50 | U-07 |
| R5 | #290 | §14.51 | U-08〜U-10 |
| R6 | #291 | §14.52 | U-11〜U-13（後日 #310 で U-24 を追加） |
| R7 | #292 | §14.57 | U-19 |
| R8 | #293 | §14.54 | U-16〜U-18 |
| R9 | #294 | §14.53 | U-14 |
| R10 | #295 | §14.56 | U-20〜U-22 |
| R11 | #296 | §14.58 | U-23 |

U-01〜U-03 は当初 R1 へ割り当てていたが、実際には使われていない（欠番）。
