# 途中からの分岐の精査

全文精査済み:`src/claude/forkFromTurn.ts`、`test/unit/claudeForkFromTurn.test.ts`、`test/unit/claudeStreamSessionForkFromTurn.test.ts`。加えてstreamSession.tsの826〜864行、claudeChatView.tsの890〜1029行、control.tsの巻戻し要求・結果を追跡した。大きい呼出元ファイルは一部の読取だけで精査済みにしていない。

## 関数と分岐

| 対象                        | 確認結果                                                                                               | 不足・注意点                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `buildRewindSequence`       | indexOfで対象を探し、無ければ空。対象以降をコピーしてreverseするため元配列は変えない                   | 途中・末尾・先頭・欠損・空配列の5入力を試験。重複UUIDは最初の一致を使うが未検査                                                 |
| `forkFromTurn`              | 空sequenceでは送信なし。各await後にrewoundを検査し、falseで打切り。成功件数を保持。最後のprefillを返す | 送信順、同時実行なし、prefill、途中失敗、最初の失敗、error欠損、対象欠損を試験                                                  |
| 送信callbackの例外          | sendRewindがrejectすると結果objectではなくrejectを伝播し、succeededCountを返せない                     | 純粋層の試験にはreject・同期throwなし。実接続側のwrite異常・解放処理は別ファイルの精査対象                                      |
| `describeForkFromTurnError` | undefined→汎用、app→そのまま、cli→既知表/汎用                                                          | 7既知値、app2値、未知CLI、undefined、同じ入力の一致を試験。下記の期待値不足あり                                                 |
| StreamSessionのfork guard   | resume/newは拒否。forkでもprocなしは拒否。要求にはinterrupt_if_running=true                            | resume/new/通常forkを試験。procなしの入口は直接試験せず、途中のproc解放を試験                                                   |
| StreamSessionの逐次応答     | request_idごとの応答で次の送信へ進む。封筒successだけで成功にしない                                    | 要求生成、最初の応答後に2件目、最初の失敗、2件完了、payload上の失敗、待機解放を確認                                             |
| Viewの結果処理              | 0件成功で失敗なら新tabを閉じる。途中成功で失敗なら警告を残す。成功なら再送かprefill                    | StreamSession試験はViewを経由しない。View試験は[Codex側](chat-view-manager-tests.md)と[Claude側](claude-view-main.md)で精査済み |

エラー辞書は通常objectであり、`constructor`や`toString`など継承propertyの名前をCLIエラーとして受けると汎用文字列へ退避しない。未知文字列を網羅的に拒否する契約としては穴がある。既存fixtureにも該当値がない。報告された実エラーと一致する証拠はない。

## テスト本体の精査

`claudeForkFromTurn.test.ts`のsuccess/failure helper、送信履歴・inFlight・prefillの各callback、各describe/it/eachを確認した。「ok:trueだけの封筒」という試験は実際には`rewound:false`の正規化済み結果を手作りし、封筒parserを通さない。封筒判定は`claudeControl.test.ts`で別に確認する必要があり、今回併読した。

`claudeStreamSessionForkFromTurn.test.ts`のstartSessionはspawnとイベント登録をfakeへ置換する。fork/resume/newの引数分岐、stdin配列、JSON抽出のmap/filter/map、応答行の生成を読んだ。handshake要求を除外してrewind要求だけを数えるため、CLIのinitialize完了を確認する試験ではない。2件の試験はvoidで始めた巻戻しを未完了のまま終え、全試験でsession.disposeを呼ばない。実際のプロセスは起動しないが、待機解放・後片付けの保証は得られない。

### テスト不足:既知エラーがすべて汎用文言でも通る

[claudeForkFromTurn.test.ts](../../../test/unit/claudeForkFromTurn.test.ts#L170)の既知エラー7値への期待値は「元の英語と違う」「空でない」「英字だけでない」。常に同じ汎用日本語を返しても満たす。後続の安定性試験も同じ入力同士の比較で、対応表の区別を検査しない。各入力の期待文言または区別すべき案内内容を比較すれば、既知エラーの案内消失を検知できる。現在の実装に対応表がないという指摘ではない。

## 報告されたエラーとの関係

原因は引き続き未確定。静的に確認できたCodexの進行中ターン指定、再開時のturnId欠落、失敗後のボタン復帰不足は[既存の追加調査](../f03-fork-error-investigation.md)を継続する。Claudeのfake応答試験は、実CLIが新しい分岐へ読み込むUUID列と画面側のUUID列の一致を証明しない。実会話への送信・分岐・巻戻しは実行していない。
