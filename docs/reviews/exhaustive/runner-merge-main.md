# マージ実行と衝突解決の寿命

対象:src/orchestrator/runnerMerge.ts全1,436行。全関数・コールバック・分岐を静的精査した。関連するrunner.test.tsの全体精査は別途。テスト未実行。

## 確認した経路

- Forge無効時のローカル統合と、有効時のtask push、integration push、PR作成、任意レビュー、merge/push、任意ready化を確認。作成失敗時の続行、URLなし、番号抽出失敗、レビューの例外・指摘、警告保存を追跡した。既存F33-01のready化問題はforge本体との契約に残る。
- レビュー用git diffが非0なら空文字でレビューを続ける。レビュー自体の失敗と区別されず、差分取得失敗を拒否条件にしない。レビューセッションの追加調査に依存するため、空差分の指摘0を差分検査成功と扱えない。
- startMergeはrunなし、integrationなし、未コミット回収失敗、想定外例外を分ける。例外を失敗状態へ変換するが、persistはvoid呼出し。回収await後の破棄・停止は占有取得後の判定へ委ねる。
- 占有取得前後のhaltedByUser比較、対象がmerging以外、失効占有、破棄、通常続行を確認。解放はfinally、衝突時はhandoverへ移す。停止前からhaltedだった再マージは許可する。待機中に停止→解除された履歴までは保持しない。
- 成功はdone・必要な撤去、busyはblockedと警告、failureはfailed、conflictは専用セッションへ進む。リロード直後でLiveTaskが無いと新しいPR情報は保持されない。
- 承認待ちタイマーの取消・張替え・同じ開始時刻の照合・タイムアウト・unrefを確認。状態更新はentryを新規構築して停止フラグをfalseへ戻すため、停止完了通知までの間に別状態通知が来る場合の扱いはhostの通知順に依存する。
- 衝突解決の設定ゲート、既存マージタスク収集、host起動失敗、占有引継ぎ、openより前の購読、open中の同期終了、runLoop失敗、abandonedによるdispose再入抑止を確認。host.openTaskSessionのawait中に破棄された場合の再確認は無い。後続runnerの寿命検査と併せて扱う。
- 完了処理は破棄中を除外し、entry削除、タイマー取消、dispose失敗のログ、単体停止・承認期限、全体停止、doneのgit確認、その他のabortを分ける。全体停止では依存skippedの理由を保つため全体停止→blockedの順序を守る。終了イベントの同一セッション重複をこの関数自身では識別しない。
- 再マージはlive/persistedのcwd・branchを選び、blockedのみ受け付け、finishedを解除して通知する。撤去はusedWorktree・cleanup・最終状態を確認し、retry名でキューへ渡す。removeのreject用catchは無く、resolve型の実装契約に依存する。

## 既存精査との関連

[EX-INTEGRATION-01](integration-main.md)の到達経路を確認した。runnerMerge.ts:1308のdone判定は未解決パスとMERGE_HEADの消失だけに依存し、対象タスクの変更が実際に取り込まれた証明が無いままdone・後続起動・撤去へ進み得る。新しい重複IDは付けない。

テスト側では差分取得失敗、host起動待ち中の破棄、停止フラグ設定後かつ終了前の状態通知、同一終了通知の重複、abort後のdoneを重点照合する。
