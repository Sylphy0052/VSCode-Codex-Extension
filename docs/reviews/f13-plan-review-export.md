# F13レビュー:計画・レビュー・圧縮・要約・書き出し

レビュー日:2026-09-09。対象commit:`efd5cd67eb6a9b0a957538c9b5f981e2969875b6`。静的レビュー。指摘3件（P1が1件、P2が2件）は未修正・実行による再現未確認。

[台帳](../feature-inventory.md#f13)

## 確認範囲

| 項目   | 確認内容と境界                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13.01 | Codexは次ターンをreadOnly/neverにし、baseline不明ならPlan modeへ入れない。Claudeはset_permission_modeで切り替える。Codexの復帰設定にF13-01                                                      |
| F13.02 | 未コミット差分・baseBranch・commit・custom、空入力、inline/detached、取消とエラー時のbusy復帰を確認。対象選択ダイアログ中の競合にF13-03                                                         |
| F13.03 | Codexのthread/compact/start、通常ターンによるrecap、Claudeの/compact・/recap・/autocompactを確認。空会話のCodex recapは通知だけ。圧縮失敗にF13-02                                               |
| F13.04 | 要約指示は有効時の手動送信に付加。空本文・空指示・無効時は付加せず、擬似コマンドを先に振り分ける。生成内容の遵守はモデル依存                                                                    |
| F13.05 | コピー・保存・エディタ表示、空会話、500万文字の末尾保持、思考・差分・画像パスの出力を確認。画像データ自体は埋め込まない。引き継ぎは履歴パスを新会話へ送り、資料の固定スナップショットは作らない |
| F13.06 | Claudeは取得済みのFast mode状態と異なる場合に/fastを送る。値は応答前に更新するため、失敗時の実CLI値との再照合は未検証                                                                           |

## 指摘

### F13-01[P1]:Plan mode解除直後に現在の承認設定を開始時の値で上書きする

条件は、開始時の承認方針と現在の明示設定が異なる会話で、Plan modeを使ってから解除すること。[send](../../src/appserver/chatSession.ts#L325)が現在のapprovalModeをparamsへ入れた後、[turnPolicyFor](../../src/appserver/planMode.ts#L99)のbaseline復帰値を[再代入](../../src/appserver/chatSession.ts#L354)する。開始時がnever、現在がuntrustedなら、解除後の最初の送信でneverを送れる。

修正では現在の明示設定を復帰用baselineより優先する。sandboxとapprovalを個別に合成し、設定が空の項目だけをbaselineへ戻す。[既存テスト](../../test/unit/planMode.test.ts#L210)は開始時の値への復帰を扱うが、現在の承認設定との衝突は扱っていない。never→untrustedと逆方向の両方で送信パラメータを確認する必要がある。

### F13-02[P2]:Codexの圧縮要求が失敗してもbusyが残る

[compact](../../src/appserver/chatSession.ts#L482)はbusy=trueにしてからRPCを待ち、reject時の復帰を持たない。上限・非対応・接続エラーなどで要求が拒否され、完了通知も来なければ実行中表示が残る。[呼出元](../../src/view/chatView.ts#L1258)のエラー表示も状態を戻さない。通常送信の[F05-01](f05-input-send-queue-interrupt.md)と同系統だが、修正対象は圧縮経路にもある。

修正では圧縮開始前の状態と対象ターンを保持し、要求が拒否された場合だけ復帰する。後から始まったターンを巻き戻さない。RPCのrejectと、その間に別の状態更新が来る場合を確認する。

### F13-03[P2]:レビュー対象の選択中に変わった会話状態を再確認しない

[runReview](../../src/view/chatView.ts#L2097)は複数のQuickPick/InputBoxを待った後、disposed・busyを再確認せずreview/startを呼ぶ。選択中に会話を閉じた場合も開始要求を送れ、別のターンが始まった場合は競合する。inlineの失敗処理は[無条件にbusy=false](../../src/appserver/chatSession.ts#L550)へ戻すため、既存のターンが実行中でも待機表示になりうる。

修正ではダイアログ後の生存・ターン状態を再検査し、レビュー開始操作の所有する状態だけを戻す。選択中のタブ破棄、通常送信、重複レビュー開始とRPC拒否を確認する。detachedの失敗が親のbusyを変更しない点は現実装でも分離されている。

## 検証の限界

planMode・reviewTarget・transcriptMarkdown・handoff・turnSummary・autocompactText、両セッションと画面ハンドラーを読んだ。既存テストではPlan mode復帰、レビュー応答不正、recapの送信形、Markdownの画像表現と上限処理を確認した。テスト・型チェック・lint、実CLI・実VSCode、実際の権限変更・保存は実行していない。コードコメント内の過去の実測を今回の実測として扱わない。
