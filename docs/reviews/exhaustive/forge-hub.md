# ForgeHubの保存・会話・操作画面

対象:`src/forge/hub.ts`、`src/forge/orchestrator.ts`、`src/view/forgeHubView.ts`、`test/unit/forgeHub.test.ts`、`test/unit/forgeOrchestrator.test.ts`。全文と埋め込みHTML・JavaScriptを精査した。テスト未実行。

## 新規指摘

### EX-FORGE-01・P1:カードへの対応を別リポジトリへ送る

`forgeHubView.ts:493`は全作業カードを表示し、`:180`の「対応する」はカードのcwdより現在のsnapshot.cwdを優先する。`buildWorkActionPrompt`はIssue/PR番号だけで、元のリポジトリやworktreeを渡さない。同じVSCodeワークスペースでAの作業を記録後、Bを指定してHubを開くと、AのカードからBの同番号へ対応を依頼する。単一リポジトリでも実装継続を隔離worktreeではなくHubを開いたcwdへ送る。カードの作業場所・providerを使い、リポジトリの識別を保持する必要がある。実際の外部操作は未検証。

さらに`hub.ts:146`のカードキーはbranchだけ、計画キーはIssue番号だけである。異なるリポジトリの同じbranch名は上書きされ、同番号の計画状態も混ざる。画面の未着手判定も番号だけである。

### EX-FORGE-02・P2:起動失敗・破棄中に相談セッションの所有状態が崩れる

`orchestrator.ts:125`は旧セッションをdisposeしてもcurrentを消さず、新規openTaskSessionを待つ。新規起動が失敗した後に旧provider/cwdへ送ると、`:123`が破棄済みセッションを再利用する。起動待ち中のdisposeも待機を無効化しないため、完了後`:144`でcurrentを復活させる。work開始にも同じ破棄待ちの問題がある。既存F37-03の同時起動とは別の終了・失敗分岐として記録する。

## 関数・分岐

サービスの依存ポート・保存型、Issue本文の固定順、保存値の読込み、origin判定・手動選択・前提確認、必須本文・label等の変換、Issue一覧・計画コメント、worktree作成・着手記録、会話状態・次操作、PR発見・作成・CI・レビュー・PR状態・返信・解決・完了・永続化を確認した。リモート取得後は現在のカードとPR番号を再確認し、削除済みカードの復活と古い番号の応答を防ぐ。mergedはcleanupを維持する。CI未設定はciPendingへ進む。CIメッセージは成功時に消すが、PR状態側の任意項目はundefined時に以前の値が残る。保存値の配列自体やplannedのnullは未検証で、壊れた保存値ではコンストラクターが例外になる。

PR作成はdirty検査、push、origin/HEAD、作成の順。既定branch解決失敗はmainへ戻す。リモート更新はカードごとに直列で、一つの依存Promiseがrejectすると残りの取得も中断する。削除したカードへのサービス呼出しは操作によりgoneとerrorを使い分ける。

相談の開始・再利用・作業会話・通知購読・表示・承認・中断・破棄・状態投影を確認した。本文は空白を除き末尾30件。作業セッションはdisposeまで保持する。初回並行起動、旧セッションの通知、手動hostを更新と一覧で失う問題はF37-01/03を参照。

画面はshow/close、30秒更新、受信値の型判定、確認ダイアログ前後、全サービス呼出し、相関ID、エラー変換、スナップショット、HTML生成、カードの各列・操作・承認・会話送信・結果復帰を確認した。showやrefreshのawait後に画面世代の確認がなく、閉じる・別cwdで開き直す間の旧応答を捨てない。受信例外の結果型マップは全操作を含まず、会話送信の失敗では消した入力を復元しない。Issue作成・計画反映は確認後に可変snapshotを再使用する。専用UIに到達しない受信処理はF37-02/F38-01。

埋め込み描画ではtext('div','step')がclassではなく本文stepを作る。CI列はurgentと排他でなく、レビュー未解決を持つCIカードは二重表示し得る。ボタンの処理中状態は相関IDで解除するが、画面の作り直しをまたぐID再利用は考慮しない。DOMは本文にtextContentを使う一方、PRリンクはURLをそのままhrefへ設定する。

## テスト内容と不足

orchestratorの3テストは相談再利用、作業role/cwd、本文・承認投影を確認する。FakeHostが毎回同じTaskSessionを返すため、テスト名の「独立した作業会話」は独立した実体を確認していない。disposeも実装しない。並行open、起動reject、破棄中open、provider変更、旧通知の抑止が不足する。

hubは本文全体、GitHub前提、GitLabの作成CLI、着手記録、CI失敗→実行中→成功、mergedと3種CI、手動CI、merged後のopen、CI待機中cleanup、未マージ拒否、二重完了、CI待機中会話状態、旧保存値の正規化を確認する。CI待機中の割込みはフェイクでawait地点を作り、カードの消滅と会話属性保持を検証する。Mementoのupdateは空実装であり、実保存の再読込みは保証しない。複数リポジトリ、破損保存、CLI失敗・例外、PR差替え中の全取得、一覧・計画・返信・解決の主要分岐は不足する。画面の導線・受信処理の追加テストは他ファイルにあり、そちらで別途精査する。
