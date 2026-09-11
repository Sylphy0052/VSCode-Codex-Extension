# セカンドオピニオンの画面導線と追加テストの精査

src/view/secondOpinionCommand.ts全1,284行と、test/unit/secondOpinionAutoSend.test.ts、secondOpinionContinue.test.ts、secondOpinionQueue.test.ts、secondOpinionSpeed.test.ts、secondOpinionTimeout.test.tsを全文で確認した。テストは実行していない。

| 対象               | 確認内容と不足                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依頼の選択         | 候補1件の省略、候補取消、effort既定先頭・1件省略・今回だけの上書き、資料3種、依頼の空白拒否、cwd未設定、取得失敗を確認。選択UI中はregistryを取得せず、取得後にbeginで重複を止める。会話の扱いの説明と実装の不一致はEX-SECONDOPINION-01。                                                                                                                                                                                                                         |
| 開始・結果・所有権 | registry取得直後のtry、bundle失敗表示、after-tree失敗から差分/baseへ退避、親idle待機、要約失敗の継続/取消の終了、短い会話の直接添付、単発の部分/取消/失敗表示、autoSend、Advisorへの移譲、親破棄時dispose、finallyのregistry→bundle→表示解除を確認。F21-01・02、F22-01を参照。noteなどは非throw契約だが、保持session受領後に契約違反のthrowがあると移譲前にsessionを閉じるfinallyはない。                                                                        |
| 継続・更新・下書き | storeなし、registry重複、入力取消、下書き破棄、成功/取消/失敗とfinally、固定baseからの再採取、update通知、JSON parse、draft/material世代付与を確認。画面からupdateとaskは同じregistryを取得するので、Advisor内部のupdatingガード不足はこの経路では排他される。未追跡を新revisionへ渡さない問題はF22-02。部分応答の取消はAdvisorでokへ変換されるため、継続画面ではcompletedと打切り注記になる。下書き再生成は開始時に旧draftを無効化せず、失敗時も旧draftが残る。 |
| 承認・送信         | 文書の全文表示、編集・空白拒否、非modal確認、古い材料の警告、draft世代照合、出所前置き、sent/queued、失敗時revertApproval、終了処理を確認。承認はregistryを取得しない。送信待機後の対象取り違えはEX-ADVISOR-01。編集後の文字数に再上限はない。                                                                                                                                                                                                                   |
| autoSendテスト     | 既定有効、無効時表示のみ、部分の前置き、通常、失敗、空、送信失敗後の表示維持を確認。取消部分の入力がなくF22-01を検出しない。全文送信のassertはcontains中心で、完全一致・順序・重複を確認しない。                                                                                                                                                                                                                                                                 |
| continueテスト     | 相談先への1送信、表示id維持、registry解除、取消、storeなし、重複、終了、JSON成否、相談後の旧draft破棄、承認有無、送信失敗後再承認、編集反映、空文、旧世代拒否を確認。FakePortの送信なしassertはEX-TEST-09。seedAdvisorはonClosedによるstore.removeを結線せず、本番のclose後削除とは異なる。旧draftのテストはdialogを保留して再生成するのではなく、生成し終えてから古いdraftを渡す。                                                                              |
| queueテスト        | busy/queued/idle、実際の待機表示まで条件待ち、重複通知で1回だけ開始、取消後のidle、購読解除、2件目拒否を確認。FakePortはlistener配列のコピーを走査する。全件資料なし・空会話なので、Git採取中の書換え・要約との待合せは確認しない。否定assert前の10ms待機は実時間依存。                                                                                                                                                                                          |
| speedテスト        | effortの実セッション入力、取消、省略、短文は直接記録・長文は2session、MCP無効を確認。4,000文字の境界は未確認。本文へ記録そのものが入ることはassertするが、選択UIの説明との一致はassertしない。                                                                                                                                                                                                                                                                   |
| timeoutテスト      | 5msの実timer、部分保持なし/最後のagentMessage/出力なし、interruptとdispose、停止未保証文言、結果union、部分本文のinfoログ非混入、表示、manifestの15分既定一致を確認。プロセスを残さないというtest名に対し実体はFakeSessionの呼出回数で、相手の終了を確認しない。部分なしの一部テストは例外型を確認せずpartialText未定義のみを見る。                                                                                                                              |

## EX-SECONDOPINION-01[P2]:会話原文を渡さないと説明した後に短い会話を渡す

secondOpinionCommand.ts:242付近の資料選択と:439付近の依頼入力は、要約有効時に「この会話そのものは渡らず」「背景要約だけ」と説明する。しかし:330付近のbuildConversationSummaryは4,000文字未満ならconversationTranscriptをそのまま本体へ渡す。secondOpinionSpeed.test.tsもこの直接添付を期待している。

利用者が外部相談先へ渡す情報を判断する時点の説明が、実際に渡る内容と一致しない。送信後の注記だけでなく、送信前の選択UIにも短い場合は記録を直接渡すことを示す必要がある。テスト・外部送信は未実行。

## EX-ADVISOR-01[P2]:古い指示の送信完了で置換後の相談を閉じる

approveSecondOpinionHandoffは冒頭でadvisorを保持し、:1205でsendApprovedInstructionをawaitした後、:1224付近でstore.closeFor(parentSessionId)を呼ぶ。承認送信中はregistryを占有せず、別のstartSecondOpinionが新Advisorをstoreへ登録できる。古い送信が遅れて完了すると、その時点でstoreに入っている新AdvisorをinstructionSentとして閉じる。

Codex側の送信口はchatView.ts:1705で非同期sendOrQueueをawaitするため、待機区間がある。close対象を承認したinstanceへ固定する必要がある。既存テストの送信は即時成功か即時失敗だけで、送信保留中のstore置換を扱わない。実際のCLI待機による再現は未実施。

## EX-TEST-09[P2]:メインAIへの未送信を変化しないcounterで判定する

secondOpinionContinue.test.tsのFakePort.sentToMainは0で初期化されるだけで、どのmethodも更新しない。実際のsendApprovedInstructionはsent配列へ追記する。相談・下書きのテストでsentToMain===0を確認しても、誤って送信口を呼ぶ回帰を検出できない。sent配列の空、または送信口のspyを確認する必要がある。実装に未承認送信を追加した事実はなく、テストの検出力の指摘である。

## 制約

画面本体の残り、Webviewの押下可否、実CLIの停止・送信・競合は別の精査対象。今回のファイル確認を実行テストや分岐カバレッジとして扱わない。
