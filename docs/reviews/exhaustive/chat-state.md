# 会話状態と通知の精査

chatState.tsの1,841行、chatState.test.tsの1,661行を全文精査した。キューのテストは[会話セッション](chat-session.md)、画像・Plan・復元の追加テストは対応記録も参照する。テスト未実行。

| 関数群                  | 分岐とテストの内容・不足                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 型・初期値・出力        | 全interface、共有空配列、initialChatState、str/strOrUndefined/numberOf/rec、imageGenerationText、capOutput/DuringAppend、lastNonEmptyAgentMessageText、currentTurnIndex、buildContextUsageを確認。出力の末尾保持、soft上限超過と以後の印、使用量の負/NaN/上限不明/上限超過を期待値で確認する。閾値ちょうど、UTF-16の途中切断、Infinity窓、共有配列の外部変更は不足。初期Claude値の1項目を見ただけのテストは、全通知後も常に同値という保証ではない。                                                       |
| normalizeItemと読取り   | readStringArray、readContentText、describeCollabAgentToolCallを含み、user/agent/plan/reasoning/command/file/MCP/Web/review/subagent/collab/image/未知の全caseを確認。status優先、exitCode、空文字、任意属性の型不正、配列要素の除外を読む。テストは通常本文、差分・移動、reasoningの4組合せ、Webの欠損・スキーム拒否、collabの既知/未知/省略を確認。空ID、継承プロパティ名の辞書検索、collabの不正要素・一部の既知ラベル、非有限exitCodeは不足。辞書のconstructor等は未知値fallbackを通らず継承値を返す。 |
| 差分・検索・計画        | normalizeDiffBodyのhunk有無とadd/delete/他、readFileDiffsの非配列/空diff/空path/移動、describeFileChangesのpath→file、isOpenableSearchUrl、readWebSearchResults、describePlanを確認。hunk判定は行頭@@だけなので、通常ファイル本文に同じ行がある場合も差分扱い。空ファイルは表示diffから除くがreadRewindChangesには残す。検索URLはスキーム接頭辞のみ検査し、URL構文全体は検査しない。                                                                                                                      |
| 集約・派生              | summarizeTurn、uniqueOrdered、deriveReviewing、deriveCodexBackgroundTerminalsを確認。テストはturn一致/不明、複数応答とpath重複、review入退場、inProgressのみ・中断印除外を検査。カンマ入りpath、空白を含むpathの保存、終了後の再派生は不足。                                                                                                                                                                                                                                                              |
| upsertとdelta           | upsertItemの新規/既存、空本文・reasoningFull・diff・turnIdの引継ぎ、中断印保持条件、appendDelta/ReasoningDeltaの項目未作成・既存・target分岐を確認。テストはdelta先行、空completedでも本文/思考保持、turnId保持、上限切詰めを検査。diffだけ引き継いでもdetailは空に戻りうる。画像・検索結果など他属性は同じ空値保持をしない。kindの異なる同ID、短い最終出力、summary区切り連続は不足。                                                                                                                    |
| applyEvent:ターン       | started、completed、failed、name、statusの全caseを確認。失敗statusの見落としは既存F11-01。テストはbusy/ID/成果/seqの正常推移、idle先行、未知通知同一参照、元状態保持を検査する。completed/failedへ主に空paramsを渡し、通知turn.id・status・errorを検査しない。重複・旧turn・中断後の成果保持もない。                                                                                                                                                                                                      |
| applyEvent:項目・使用量 | item3通知の共通経路、agent/command/reasoning deltaの空ガード、summaryPartAdded、rateLimitsの型fallback、tokenUsageのlast必須・window・total保持、planの空/同ID更新、patchUpdatedの対象不在/空差分を確認。テストのpatchUpdated不在は無視を期待し、順序逆転からの回復は期待しない。rateLimitsの非有限値、totalだけ届く更新・負値累計、旧itemのturnIdによる現turn上書きは不足。                                                                                                                              |
| applyEvent:承認等       | autoReviewの開始/完了/不正reviewId、guardianWarningの空/非空、resolvedの型/不在/削除、hookのblocked/他とevent/source fallback、defaultを確認。テストは主経路と重複item抑止を検査。prompt解決の欠落はF10-08。hookのテストコメントと実装コメントのCLI観測には差があり、今回の実測とは扱わない。                                                                                                                                                                                                             |
| キュー・通知・承認操作  | routeSend、enqueue、takeQueued/At、restoreQueued、popLastQueued、removeQueued、clearQueue、appendNotice/SideQuestion/SecondOpinion、interruptedCommandsNoticeId/interruptFailedNoticeId、isRunningCommand、keepsInterruptedMark、markInterruptedCommands、add/removeApproval/Prompt、readRewindChangesを確認。正常キューは別テストで確認。中断印は状態内の全実行中commandへ付き、引数turnIdは注記IDだけに使用。appendSideQuestion等の更新も空本文なら旧本文を残す共通upsertの影響を受ける。               |

## EX-STATE-01[P2]:完了通知の重複・旧ターンを区別しない

[chatState.ts:1282](../../../src/appserver/chatState.ts#L1282)とfailed分岐は通知のターンを読まず、毎回seqを増やして現在turnIdを消す。同じ完了を2回適用すると成果が空へ上書きされ、2回目も完了として扱われる。旧ターンの完了が新ターン開始後に届いた場合も、新ターンを終了させる。[chatView.ts:993](../../../src/view/chatView.ts#L993)はseq変化ごとに予約送信・成果記録・完了通知を行うため、状態内だけの誤差ではない。

契約は同じターンにつき1回の確定。ターンIDと確定済み状態を保持して照合する必要がある。既存テストは異なる2ターンで増えることだけを確認する。実CLIが同じ終局通知を再送するか、該当順序を発生させるかは未確認。

## EX-STATE-02[P2]:完了時に消した実行中一覧が次の項目で復活する

[chatState.ts:1290](../../../src/appserver/chatState.ts#L1290)は取り逃したcommand完了への対処として一覧を空にするが、items内のinProgressは残す。次のuser/agent等のitem通知で[全itemsから再派生](../../../src/appserver/chatState.ts#L1348)し、前ターンのcommandが再び一覧に載る。現実装が対処対象としているitem/completed欠落の条件で、終了処理の効果が持続しない。

終了したターンを派生対象から除くか、コマンドの状態を未確認の終了として保持する必要がある。既存テストはturn/completed直後の空一覧だけを検査し、次ターンのitemまで進めない。

## EX-STATE-03[P2]:カンマを含むファイル名が成果記録で分割される

[summarizeTurn](../../../src/appserver/chatState.ts#L1075)は表示用detailを`, `でsplitしtrimする。1ファイル`/w/a, b.txt`の変更が`/w/a`と`b.txt`の2件になる。先頭/末尾空白も失う。表示用文字列を逆解析せず、正規化時点でパス配列を保持して集約する必要がある。既存テストのpathは区切りを含まない。

## EX-STATE-04[P2]:中断応答が先に返るとターン成果が空になる

[interrupt](../../../src/appserver/chatSession.ts#L605)は成功時にturnIdを消し、完了seqは後続completedへ委ねる。そのcompletedは通知のturn.idを使わずstate.turnIdでsummarizeTurnするため、ID不明として本文・編集ファイルを空にする。中断前に応答や編集があっても成果記録へ渡らない。completedが先に来る順序ではこの欠落条件に入らない。

中断先のIDと完了集約用のIDを区別するか、終局通知のIDで集約する必要がある。中断テストは後続completedのseqだけを確認し、成果の値を検査しない。実機未確認。
