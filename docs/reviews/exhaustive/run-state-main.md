# タスク状態遷移とテスト

対象:src/orchestrator/runState.ts全1,211行、test/unit/runState.test.ts全1,316行。関数本体・型契約・各分岐と全テストの準備、操作、期待値を静的精査した。テスト未実行。

## 新規指摘

EX-RUNSTATE-01/P2:複数親の片方だけ再マージすると実行中のまま残る。runState.ts:738–745は停止中でなければmergeBlockedの後続を無条件にpendingへ戻す。A・Bがblocked、CがAとBに依存する状態でAだけ再マージ成功すると、Cはpending、Bはblockedになる。scheduler.ts:70の依存判定でCを開始できず、同:110のpending優先判定で実行結果はrunningのまま。Bの手動解決は可能だが、それまで終了通知や終了時の後始末が進まない。残存するblocked親を確認し、その親によるskippedを保持する必要がある。複数親のテストは両親の解決後だけschedulerまで確認しており、片親だけ成功した時点の終了判定を検査していない。

## 関数・分岐

- 状態一覧、活性状態と未確定状態、失敗理由、初期値、追加・削除、Mapの複製、依存先索引と再帰探索を確認。追加の重複IDや削除可否は呼出側の契約。初期値オブジェクトは共有され、readonlyは実行時の凍結ではない。
- 失敗遷移、依存失敗の連鎖、複数原因IDの追記、独立pendingのrunHalted化、既存skipped理由の保持を確認。activeやdoneの後続は巻き戻さない。
- ループ終了理由の全分岐を確認。manual/interruptedは対象IDの存在確認より先に全体停止する。doneはmergingへ進み、上限・停滞・単体停止等は確定失敗、loopFailedだけ自動再試行予算を使う。pendingも未確定に含まれ、古いfailed通知の重複防止は呼出側の責任。
- 承認拒否・期限切れはwaitingApprovalのみ。running、承認待ち、返信待ちの移行ガード、送信回数・セッション情報の更新、撤去試行数のNaN・無限大・小数の丸めを確認。
- mergingから成功・blocked・失敗、blockedから再マージする全出口を確認。停止中の成功はmergeBlockedWhileHaltedを残す。blockedは全体停止理由にならず、再マージ自体もhaltedByUserを解除しない。
- retryTaskとcontinueTaskは依存完了を要求し、人の明示操作で停止を解除する。retryは試行名を更新し、continueは同じ試行・送信通算数を保持する。別タスクがfailedなら全体停止は残るが、後続をpendingへ戻す挙動は既存テストで明示されている。
- applyAutoResumeはreloadInterrupted以外の失敗、allow確認が必要な失敗、対象なしを分ける。再開では自動retry予算を消費せずmanualRetryCountを増やし、送信数を0にする。runHalted由来のskippedも戻す。haltedByUserの適格性と保存タスク定義の整合性は呼出側が担う。

## テスト内容と不足

- 全テストのチェーン・合流・独立枝、失敗理由、回数、対象外状態、同一参照の返却、停止解除、再マージ、再開を確認。Issue #432-1は独立failedが残るときの終了結果、#527は両親を解決した後の実際の起動候補も確認する。
- 人による衝突解決停止では全体停止→blockedの順序と逆順を比較し、skipped理由が変わることを固定する。ただしこの純粋関数テストはgit操作が無いこと自体を検証しない。
- 一部の準備は依存未完了のタスクを直接runningへ移す。reducerの単体試験としては成立するが、実際の起動順を保証しない。
- 対象外状態を列挙するテスト名でも全状態を操作していない例がある。retryTaskの「done/running/pending」はpendingを呼ばず、markRunningの対象外IDも実際に呼んでいない。applyAutoResumeの「dependencyFailed／mergeBlocked」はdependencyFailedだけを投入する。
- recordSubmissionCountは通常値中心。古い通知の再送、retry後pendingでのfailed重複、完了済みセッションからのmanual、再試行時のメタデータ全項目、他親blockedが残る場合の終了結果は不足する。continueTaskは再開可能な全失敗理由を個別には検査していない。
