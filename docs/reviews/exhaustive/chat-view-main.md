# Codexチャット管理本体・画面生成と破壊的操作のテスト

対象:src/view/chatView.ts、test/unit/chatView.test.ts、test/unit/chatViewDestructiveOps.test.ts。全文の関数・分岐とテストの準備・操作・期待値・後片付けを確認した。テスト未実行。

## 起動・設定・寿命

手動/タスク/既存履歴/シリアライズ復元/引継ぎ/副質問の各入口、設定の優先順位、開始待ち登録、thread/start/resume/forkの成功失敗、モデル保存、タブ生成と再表示、TaskSessionの各callback、破棄hookを確認した。タスク設定は追加root・network・bypass等を制限し、MCP/skill無効化を別々に重ねる。開始成功後のdisposed再検査、履歴復元のcwd、分岐時のモデル継承は既存F03の対象。副質問も遅いfork後の寿命を再確認しない。手動引継ぎは保存先を最大10回待つが、元セッションのモデル設定を明示継承しない。

**EX-MCP-01(P1):MCP無効化の一覧取得失敗で、利用者設定のMCPを残して起動する。** chatView.ts:654のdisableMcpServers経路は694のconfig/read失敗を受けても停止せず、buildDisabledMcpServersOverlay(undefined)をthread/startへ渡す。これは組み込みcodex_appsだけを無効化する。overlayは設定全体の置換ではないため、利用者設定のMCPが存在する場合には無効化されない。成功応答でも設定の形が読めない場合は同じ結果になる。読取り専用の相談相手で外部操作ツールが残り得る。実際の外部操作は未確認。取得不能時の中止または全MCP停止を保証する経路が必要。

**EX-MCP-02(P2):起動済みMCPの通知を取り逃がし、利用不能と判定する。** checkMcpStartupStatusはopenTaskSessionの解決後にlistenerを登録する。thread/start後からモデル設定の保存・呼出し側の確認開始までに届いたready/failed通知を保持する状態が無い。readyがこの区間に届くと、以後の更新が無い限り8秒後にfalseになる。通知の早着、二重確認、破棄中の待機終了を試験する必要がある。

## 状態更新と操作

onSessionChangeの完了sequence、queue/loopの順序、通知、listener、使用量上限のtimer設定・取消・再試行、手動send/interrupt/compact/recap、画像の取出しと失敗時復帰、疑似コマンド、承認/入力要求、queue編集、loop開始/停止、設定の永続化と全panel更新、コマンド候補、ゴール下書き、セカンドオピニオンの各振分けを確認した。voidの非同期呼出しは外側try/catchで回収できない。timer発火時のbusy等で再予約せず終わる経路がある。設定toggleは要求値を当該panelへ返すため、workspace側設定の上書きや他panelとの不一致に注意が要る。handoffToNewSessionはメッセージを送ったentryでなくmanagerのactiveを使う。

送信側のprompt変換はsendFromLoopのtryより前。sendOnceはエラーを表示して吸収する。TaskSession.sendの呼出し側は成功失敗を戻り値から判定できない。副質問・相談の保存・承認後送信は親破棄とawaitの間を併せて確認した。既存F05/F08/F10/F11/F13/F21/F22と精査済み相談機構の指摘を参照する。

postStateの50ms間引き、初回/差分と送信済み件数、webview ready時の再送、通知のthread識別・起動中への配布・file journal、承認interceptorと既定処理を確認した。postMessage受理前に差分基準を進める。未知threadの承認fallbackと遅いinterceptorはF10-01/10。MCP listenerは走査中に自身を配列から除去するため、同時確認が複数あると後続listenerを飛ばし得る。

## 編集再送・復元・分岐

対象turnの特定、先頭発言と途中の分岐、確認取消、復元計画の作成/再検査/適用、dirty document検査、送信直前hook、復元中のguard、失敗時の表示、clearのtask拒否/実行中確認を確認した。復元のidle判定はこのCodex managerのpanel集合が対象で、Claude同時編集はこの地点では観測しない。途中分岐はlastTurnIdを指定してforkし、成功後はcwd未指定でopenThreadする。実際に利用者が見たエラーのログは無く、原因の確定には至らない。F03-01〜09とF09の既存指摘を参照する。

## 画面生成テスト

chatView.test.tsはボタンラベル/title、送信欄3段の配置、detailsの初期開閉、条件付き設定・Claude要素、send/stop、密度、各ボタンの表/overflow配置、secondOpinionの個数、toggleの状態、loop上限/ゴール欄、menuのrole/aria、送信キー案内、panel option、会話移動ボタンを確認する。省略/true/false、空配列/特定ID/全指定などの入力を併読した。

生成HTMLの文字列検査であり、DOM操作やクリック、Tab/矢印/Escape、CSSによる実際の可視性は検証しない。isInOverflowMenuはmenu開始より後かだけを見て閉じ位置を見ない。row抽出は正規表現で入れ子を完全に扱わない。「16個すべて」の入力は後から追加された全ボタン集合を検査していない。これらの見出しを実際の操作保証と解釈しない。

## 破壊的操作テスト

確認文字列の一致/取消、不一致、復元の追加/更新/削除と10件表示上限、差分の適用前検査、確認待ち中の内容変更、外側パス/未対応move/欠落項目、diff editorとファイル位置、画像allowlist、添付形式/件数、ファイル候補を確認する。fake filesystemは内容中心、仮想documentは固定行数、外部コマンドは呼出し記録であり、実VSCode・symlinkの差替え・改行の保存は通らない。

「実ファイルパスで呼ぶ」はvscode.diffというコマンド名だけを検査し、引数のURIと左右の内容を検査しない。「itemId/diffIndex不正」は欠落item中心。画像の許可外入力は送信が無いことだけでread自体の不実行は保証しない。候補のcwdはfakeScanが引数を観測しない。showTextDocumentの上書きを復元しないテストもある。既存F09の回帰を防ぐには、パス/内容/保存bytesと副作用なしを独立に観測する必要がある。
