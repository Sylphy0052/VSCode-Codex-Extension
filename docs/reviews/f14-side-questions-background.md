# F14レビュー:脇道の質問・バックグラウンド作業

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f14)の4項目を静的レビューした。指摘2件、いずれもP2。

## 確認範囲

| 項目   | 確認内容                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F14.01 | Codexはephemeral forkを別タブへ読み込み、Claudeは本流の注記へ結果表示。Claudeの履歴は20件まで                                             |
| F14.02 | Codexの本流と分岐の状態は独立。Claudeは要求ID別に応答を解決し、プロセス終了時に未完了要求を解放                                           |
| F14.03 | Codexは実行中commandExecutionを一覧化するが停止不可。Claudeは通知で一覧を置換し、確認後にtaskIdを指定して停止。プロセス終了時は一覧を消す |
| F14.04 | subAgentActivityとcollabAgentToolCallを描画用状態へ変換。対象threadId、状態、指示、モデルを表示し、未知の状態名は原文で残す               |

## 指摘

### F14-01[P2]:失敗扱いの脇道応答が次回の質問履歴に入る

[終了表示](../../src/claude/sideQuestion.ts)はsynthetic=trueを失敗として扱う。一方、[履歴追加](../../src/view/claudeChatView.ts#L1189)はokとresponseの存在だけを判定する。封筒が成功でも内容が合成エラーなら、そのエラーを有効な過去回答として次の/btwへ渡す。

履歴へ追加する成功条件を表示側と共通化する。synthetic=trueの応答後に再質問し、履歴に残らないことを確認する必要がある。既存claudeSideQuestionテストは表示上の失敗判定を扱うが、この画面側の追加条件は別経路。

### F14-02[P2]:応答のない脇道質問を終了させる期限がない

[askSideQuestion](../../src/claude/streamSession.ts#L910)は待機MapへPromiseを登録する。[claim](../../src/claude/streamSession.ts#L387)にもタイマーはなく、本流のinterruptでもこの待機を解決しない。子プロセスが生きたまま応答を返さなければ、質問の実行中表示と待機要素が残る。

要求単位のtimeoutまたは取消を設け、遅れて来た応答で終了済みの質問を上書きしないようにする。プロセス終了による解放は既にあるため、生存したまま応答がないケースを確認する。

## 検証の限界

sideQuestion、両画面の開始処理、streamSessionの要求管理、chatStateの一覧・サブエージェント変換を読んだ。既存テストのfork分離、synthetic失敗表示、終了時の一覧消去も確認した。テスト・実CLI・実VSCodeは実行していない。
