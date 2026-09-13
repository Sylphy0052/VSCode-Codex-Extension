# 実行中の通信・受け渡し・表示スナップショット

対象:`src/orchestrator/runnerMessaging.ts`、`src/orchestrator/teamHandoff.ts`、`src/orchestrator/runnerSnapshot.ts`、`test/unit/teamHandoff.test.ts`、`test/unit/runnerTeamHandoff.test.ts`。全文の関数・分岐・期待値を精査した。テスト未実行。

## 通信

一覧は定義順で、状態なしはpending、実体なしの要約は空にする。受付後の返信待ちはrunningの送信元だけをwaitingReplyへ変え、実際のloopをpauseする。宛先がオーケストレーターなら質問/連絡で本文を分けてプッシュし、その宛先の配送キューを消費する。タスク宛ならwaitingReplyだけをrunningへ戻す。状態変更時にnotify/persistする。

オーケストレーター不在では通知が失われる挙動がコメントにも明記されている。キューの全消費は単一件の確認ではなく、当該宛先の配送可能メッセージ全体を取り出す。待ちぼうけ判定は承認待ちを除いたactive集合と未配送件数、開始時刻とtimeoutの2経路。二重に対象へ入っても、解放時にwaitingReplyを再確認するため二重resumeはしない。タイムアウト設定0などの意味はmessaging側の関数で別途精査する。

可視性確認のrejectは通信不可の警告に変える。応答待ち中にrunが終了しても、runsに残れば警告を追加する。closeは先に参照を外し、同期throw・非同期rejectを処理し、finallyでtimerを必ず解除する。pause/resumeやlistenerのthrowはこの層では受けず、persistのPromiseも待たない。runner本体のテストにある待機・通知・終了との接続は別記録で扱う。

## 受け渡し

runId、taskId、slugの字種・長さ・空値を検証し、~区切りで名前の一意性を守る。parseは拡張子、区切り位置、左右の検証を通し、旧命名を一覧から外す。writeはUTF-8の256KiB上限、祖先リンク、一覧件数100、mkdir、writeの順。上書きは件数上限を適用しない。件数検査の並行競合は既存F32-01。read/list/remove/removeRunも識別子とリンクを検証する。削除対象なしは成功、書込み・削除のfalseは理由付き失敗になる。

ガードと各I/Oは別awaitであり、その間のリンク差替えは防がない。read側には本文サイズ制限がなく、外部から置いた大きなファイルも読み込む。listは名前だけを解析し、実ファイルかディレクトリかを調べない。FSポートのthrowは識別子解析のcatchでは捕まえない。これらは実FSの安全性・障害時契約の不足として残す。

テストは名前生成・衝突防止・解析の全主分岐、書込み読取り一覧削除、別タスクの内容保持、旧名除外、欠落、サイズ上限±境界、100件上限・上書き、各操作のリンク拒否、mkdir/write/remove/removeRunのfalseを確認する。部分書込みの後で失敗するフェイクではないため、「失敗したファイルは残らない」というテストは実I/Oの原子性を保証しない。多バイト上限、並行書込み、ガード後差替え、読取り/listの障害、run別の削除非干渉は不足する。

runnerTeamHandoffはモジュールFSを差し替え、task開始をrejectさせたfailed終了で、runの削除パス・回数、falseの警告、リンク時の削除未呼出し、reject時の警告と結果保持を確認する。success/cancel/disposeを通るテストではない。100回のマイクロタスクflushへ依存し、実体の削除を確認しない。runnerを各テスト末尾でdisposeせず、未使用メソッドは空実装のため、会話・timerの後片付けまで保証しない。

## スナップショット

getSnapshotのrun欠落、storeを1回だけ読む経路、task展開、qualityの復旧→検証失敗→レビュー→ready優先順、live優先のPR・最終マージ、ask_userのlive/保存済み/なし、オーケストレーター有無を確認した。タスクの状態・作業契約・検証・会話・承認・競合解決・PRを投影する。検証結果はliveTaskだけを参照するため、復元後はpendingへ戻り得る。保存・復元との整合は当該モジュールの精査で追う。

allowと定義上の権限越境は毎回導出する。実効権限の越境は参照上流の実体がある場合だけ判定し、同じtask/messageの警告を抑止する。復元後に上流実体がなければ実効値の比較を省く。maxReachedとstalled/escalated/advised/conflicted/timedOutはfailedの場合だけ警告し、会話の有無で継続案内を分ける。返す配列・オブジェクトの一部は元の参照であり、型上のreadonlyは外部からの実行時変更を防ぐものではない。専用テストファイルはなく、runner本体のテスト内容は別途精査する。
