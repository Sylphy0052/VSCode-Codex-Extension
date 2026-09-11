# タスク設定・起動判定・保存・境界処理の精査

対象本文を末尾まで読んだ。テストはfixture、操作、期待値、条件付き早期終了、後片付けを確認した。実行はしていない。runner本体・巨大な関連テストの完了を意味しない。

## 関数・分岐とテスト内容

| 対象                                                    | 確認内容と不足                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| taskConfig.ts、taskConfig.test.ts                       | Provider別の承認クランプ、Codexだけのsandbox、autoApproveの上限、Claudeのbypass許可とacceptEditsへの退避、警告連結、model/effortの省略値。テストは安全側・危険側の指定、未指定、空の基準値、bypass許可ありなしを比較する。未知値、複数警告の同時生成、model/effort未指定時の空文字は直接確認しない。                                                                                                                                                                                   |
| taskSession.ts、runnerInternals.ts                      | 承認結果のauto/ask、セッション開始・送信・変換・停止・再開・dispose、通知コールバック、MCP設定の優先順位、ホスト依存の型契約を確認。readonlyはMapの内容まで固定しない。型宣言から実装の寿命や例外処理は保証しない。                                                                                                                                                                                                                                                                    |
| runnerApproval.ts                                       | 既存タイマー解除、承認待ち開始時だけの設定、既定3600秒、unref、run/task消失・開始時刻不一致・状態変更時の無操作、timeout印を付けてstopLoopへ渡す経路を確認。runner.ts:4510では新たな承認待ち開始時に時刻を設定するため、同じ待機を定期的に延長するという指摘にはしない。本体連携と関連runnerテストは[runner-test-main.md](runner-test-main.md)と[承認・寿命試験](runner-lifecycle-tests-vscode-mock.md)で精査済み。                                                                    |
| runnerReviewComments.ts                                 | 本文のコードポイント上限、空投稿者の代替、取得失敗のwarn、取得後のrun再確認、既読IDのSet、イベント・警告・保存、正の有限間隔だけの起動、即時取得、停止の冪等性。投稿者や接頭辞は本文上限に含まれない。並行poll、停止後の遅延応答、イベント受付失敗はrunnerとの連携精査を残す。                                                                                                                                                                                                         |
| scheduler.ts、scheduler.test.ts                         | 停止判定、active四状態と除外集合、定義順の枠割当、doneだけの依存充足、終了優先順を確認。テストは菱形DAG、枠1/2/3、承認・返信・マージ待ち、失敗伝播、独立枝、手動停止後再試行、retry上限、blocked/failedの優先、除外しても後続を解禁しない条件を確認する。終了テストのpending/running/waitingApprovalという名前はpendingだけを直接入力する。空run、定義と状態の欠落は直接確認しない。                                                                                                   |
| programScheduler.ts、programScheduler.test.ts           | running枠、pending選択、done依存、停止フラグ、failed/skipped伝播の不動点、全件終端判定。テストは前段完了、並列上限、独立枝継続、失敗/skipped依存、全体停止、連鎖と直近失敗理由、無変更の参照同一性を確認する。連鎖fixtureは定義順なので、逆順DAGで複数周が必要な分岐は直接確認しない。空定義・状態欠落も未確認。                                                                                                                                                                       |
| programState.ts、programState.test.ts                   | 初期化、開始・終了、不存在ID、再読込のrunning→failed、live状態の再適用、skipのpending限定、全体停止の冪等性。テストは失敗3種の丸め、runId保持、pending温存、停止フラグ保持を確認する。再適用の終端側は引数runIdではなく既存runIdを使う契約で、呼出側は同じrunを渡す必要がある。開始・終了は状態遷移前提を自ら検証しない。危険キーはprogram定義検証に依存する。                                                                                                                         |
| programStore.ts、programStore.test.ts                   | list/find、新規追加・既存更新、開始時刻順10件への切詰め、直列キュー、再読込の変更時だけ保存、clearAll。テストは同じMementoを使う再構築、10更新、12件の保持上限、running/done混在、全消去を確認する。JSON往復はしない。保存拒否後の継続、updater例外、無変更時の書込回数は直接確認しない。並行更新の検出不足は下記。                                                                                                                                                                    |
| rolePresets.ts、rolePresets.test.ts                     | 10役割、型ガード、役割→重さ→Provider別model/effort、表示名、明示escalationを確認。全役割と両Providerを走査し、役割群ごとのtierと代表model、既定でescalationにしないことを期待する。ラベルは非空だけで日本語や正確な対応までは確認しない。モデルの実在・利用資格は静的テーブルから保証しない。                                                                                                                                                                                          |
| fsGuards.ts、fsGuards.test.ts                           | UUID大小文字、runId優先エラー、taskId50/51文字境界、assertのthrow、祖先の浅い順のリンク検出・早期returnを確認。root自体は調べず、root外への相対パスは拒否せず..を除くため、この関数単体は包含検証にならない。呼出側の検証・作成後再確認が必要。末端リンクのテストは空Setを渡すためリンクあり分岐を確認していない。                                                                                                                                                                     |
| nodeHandoffFileSystem.ts、nodeHandoffFileSystem.test.ts | 各fs操作の成功・catch時false/undefined/空配列、消去時force、再帰mkdir/rmを確認。実FSテストは専用mkdtemp、作成読書一覧消去、上書き、未存在、親が通常ファイル、リンク、書込権限を扱う。リンク作成失敗は理由を問わずreturnして成功扱い。権限テストはrootでreturnするがWindowsのchmod差は扱わない。削除失敗、読込権限失敗、lstat権限失敗は未確認。実行していない。                                                                                                                         |
| untrustedText.ts、untrustedText.test.ts                 | 空本文、乱数nonce、任意notice、改行保持の選択、制御文字除去、コードポイント切詰め、5連以上の罫線置換、inline整形を確認。テストは固定/ランダムnonce、空、改行・タブ、双方向制御、上限前後、偽閉じ区切り、囲いなしを確認する。復帰保持という名前に反して入力に復帰はない。コードポイント関数のサロゲート、負数・非有限上限、任意noticeはこのテストで確認しない。ラベル/nonce/noticeは呼出側が信頼できる値を渡す前提。                                                                    |
| orchestratorSession.ts、orchestratorSession.test.ts     | 専用接続ID、最初のProviderと空定義の既定値、権限クランプ、イベントの角括弧・制御文字処理、新しい通知から予算内に選択、人の発話全量保持、ヘッダー超過時の再帰を確認。テストはProvider/権限、通知だけ/発話だけ/混在、偽タグ、30件の超過、発話60000文字、定数500を確認する。ヘッダーだけで超える境界、通知数制限の実際の配線、全イベント脱落時の説明、再帰時の省略件数は確認しない。Claude側のsandboxはtaskConfigで空になるため、コメントの「読み取り専用」をOSの強制制限とは解釈しない。 |

## 新規指摘

### EX-TEST-07[P2]:並行更新テストが更新消失を検出できない

`test/unit/programStore.test.ts:87`の10更新は、それぞれ固定のattempt文字列で同じ欄を上書きする。最終期待値も`startsWith('attempt-') === true`だけなので、9更新が消失しても通る。fakeMemento.updateはawait前に即座に値を変更するため、保存待ちの競合も再現しない。実装にはSerialQueueがあり、実際の更新消失を確認したという指摘ではない。遅延する保存と累積カウンター等を用い、全更新が保持されることを確認する必要がある。

### EX-TEXT-01[P3]:inline切詰めでサロゲートペアを分断する

`src/orchestrator/untrustedText.ts:166`はUTF-16のsliceを使う。上限直前の補助平面文字を半分だけ残し、Issueタイトルやファイル名のプロンプト表記が壊れる。同じファイルのtruncateByCodePointはこの分断を避けるが、inline側では使わない。テストはASCII/BMPだけ。補助平面文字が切詰め境界に来る入力が不足する。

## 制約

上記は対象補助ファイルの静的精査。既存F30/F31/F33/F34指摘の解消を意味しない。実CLI、OS権限、保存遅延、runnerの全経路は別途確認が必要。実装修正・テスト追加・テスト実行はしていない。

## workflowEvaluation.tsの追加精査

全80行の率計算、0件、丸め、evidence/verify/outcome/outputsの有無、acceptanceなし、過剰分割、before/afterと差分を確認した。src/testを検索した範囲で実際の呼出元と直接テストはない。

EX-WORKFLOW-01[P3]:34行の`task.outcome?.trim() !== ''`はoutcome未指定でも真になる。そのためacceptanceとoutputsだけがあるタスクも、成果説明があるタスクとしてacceptanceCoveragePercentへ加算する。未指定と空文字の扱いが逆転しており、品質指標を過大評価する。非空文字列を明示的に要求する必要がある。未使用の補助関数内の不具合で、稼働中の画面・実行への影響は確認していない。テストは追加・実行していない。
