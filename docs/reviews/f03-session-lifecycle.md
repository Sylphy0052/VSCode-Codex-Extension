# F03レビュー:会話の開始・再開・命名・タブ復元

レビュー日:2026-09-08。対象commit:`efd5cd67eb6a9b0a957538c9b5f981e2969875b6`。

静的レビューで6件の指摘を記録した。P1が3件、P2が3件。すべて未修正・実行による再現未確認。P1は優先修正、P2は通常の修正対象を表す。コードの制御フローから判定し、実機での発生頻度は評価していない。

2026-09-09追記:[途中分岐の追加調査](f03-fork-error-investigation.md)でP2を3件追加した。F03全体では9件。利用者が報告したエラーとの一致は未確認。

[機能別レビュー台帳へ戻る](../feature-inventory.md#f03)。修正時は各指摘の確認条件を受入基準へ引き継ぐ。

## レビュー範囲

| 小項目 | 確認内容                                                                                | 結果                                         |
| ------ | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| F03.01 | 公開コマンドからの新規開始・履歴再開・直前の会話の選択、開始待ち、失敗時の後処理        | 静的レビュー済み。F03-04/F03-05を参照        |
| F03.02 | 同じIDのタブ再利用、通常タブとタスク管理下タブの寿命、クリア確認、両CLIの名前変更と保存 | 静的レビュー済み。F03-03/F03-04/F03-05を参照 |
| F03.03 | Webviewの保存状態、serializer、遅延再開、cwd、セッション別モデル設定の読込・保存        | 静的レビュー済み。F03-02/F03-05/F03-06を参照 |
| F03.04 | 履歴メニューからの全体分岐、チャットの途中分岐、設定継承、Claudeの逐次巻戻しと途中失敗  | 静的レビュー済み。F03-01/F03-02を参照        |
| F03.05 | rolloutの読込、会話単位への変換、分岐点の選択、単発app-serverから新規タブへの接続       | 静的レビュー済み。F03-06を参照               |

CodeGraphのMCP検索を使い、関連する開始・再開・復元処理を探索した。返却範囲に含まれなかった基底クラス、イベント配線、分岐処理、既存テストは直接読んだ。`.worktree/`が索引対象外のため、同一commitでソース差分のないmainを検索した。検索結果は動作検証として扱っていない。

## 指摘一覧

| ID     | 重要度 | 問題                                                   | 主な箇所                                      |
| ------ | ------ | ------------------------------------------------------ | --------------------------------------------- |
| F03-01 | P1     | Codexの全体分岐が元の会話をそのまま再開する            | extension.ts:2840                             |
| F03-02 | P1     | Codexの復元・分岐で元のcwdを保持しない                 | chatView.ts:758、chatView.ts:2086             |
| F03-03 | P1     | Codexの会話クリアが進行中のターンを中断しない          | chatView.ts:2223、chatSession.ts:791          |
| F03-04 | P2     | 開始待ちに閉じたCodexタブを応答後に再登録する          | chatView.ts:567                               |
| F03-05 | P2     | 履歴読込中に閉じたClaudeタブのプロセスを後から起動する | claudeChatView.ts:808、claudeChatView.ts:1285 |
| F03-06 | P2     | 会話閲覧画面からの分岐でモデル設定を継承しない         | extension.ts:2809、chatView.ts:438            |

### F03-01[P1]:Codexの全体分岐が元の会話をそのまま再開する

**条件:**Codexの履歴で「セッション全体を分岐」に相当する`codex.forkSession`を実行する。

[コマンド登録](../../src/extension.ts#L1059)から呼ぶ`forkSession()`のCodex分岐は、[extension.ts:2840](../../src/extension.ts#L2840)で元の`session.id`を`chat.openThread()`へ渡す。新しいIDを作る要求はない。[openThread:710](../../src/view/chatView.ts#L710)は同じIDのタブがあれば表示し直し、なければそのIDで`thread/resume`を送る。

したがって、利用者が分岐先と思って送った指示も元の会話に追加される。未オープンならタイトルに`(fork)`を付けて開くため、表示と送信先も一致しない。チャットの途中分岐は[thread/fork](../../src/view/chatView.ts#L2078)を使っており、この問題は履歴メニューの全体分岐経路にある。

**修正方針:**Codexの全体分岐でも新しいスレッドを作り、返されたIDのタブを開く。元のタブの再表示を分岐成功として扱わない。モデル設定・cwdの継承も途中分岐と共通化する。

**修正後の確認条件:**元のタブが開いている場合と閉じている場合の両方で、公開コマンドを実行する。元と異なるIDが作られ、以後の送信が新IDだけに向かうこと、分岐失敗時は元の会話を分岐先として開かないことを確認する。

### F03-02[P1]:Codexの復元・分岐で元のcwdを保持しない

**条件:**ワークスペース直下とは異なるサブディレクトリ、別ルート、別worktreeの会話を開いてウィンドウを再読込する。または、その会話のチャットから途中分岐し、分岐先をクリアする。

Webviewが保持する会話識別情報は[threadId](../../src/view/chatScript.ts#L2177)で、復元側の[restorePanel:758](../../src/view/chatView.ts#L758)は元のcwdを解決せず`currentWorkspaceFolder()`をエントリへ設定する。利用者が復元を明示すると、[chatView.ts:1170](../../src/view/chatView.ts#L1170)から[ChatSession.resume:196](../../src/appserver/chatSession.ts#L196)を通じ、そのフォルダを`thread/resume`のcwdとして明示する。

例えば元が`/repo/.worktree/task`でウィンドウが`/repo`なら、復元要求には`/repo`が入る。元のcwdとは異なる値を明示しており、元の作業場所を前提とした次の操作が別の場所へ向くおそれがある。拡張側の活動記録やクリア時のcwdもこの値になる。

途中分岐にも保持漏れがある。[forkFrom:2086](../../src/view/chatView.ts#L2086)は`openThread()`へcwdを渡さず、再開応答からエントリのcwdを補う処理もない。この場合、CLIの再開先が誤るとは断定できないが、[clearActive:2224](../../src/view/chatView.ts#L2224)はundefinedを`openNew()`へ渡し、現在のワークスペースへ戻って新規会話を開始する。

**修正方針:**復元時は履歴などから元のcwdを解決し、途中分岐では親のcwdを引き継ぐ。復元要求のcwdと拡張側のエントリを一致させる。元のcwdが不明な場合の扱いは、無関係なフォルダを黙って指定することと区別する。

**修正後の確認条件:**サブディレクトリ、複数ルートの2番目、別worktreeの会話を復元し、明示再開の要求と活動記録のcwdを照合する。途中分岐後のクリアでも元のcwdを維持することを確認する。元ディレクトリが消えた場合の案内と再試行も確認する。

### F03-03[P1]:Codexの会話クリアが進行中のターンを中断しない

**条件:**Codexが応答中に会話クリアを実行し、「進行中のターンは中断されます」という確認で「クリアする」を選ぶ。

[clearActive:2200](../../src/view/chatView.ts#L2200)は確認後に`teardown()`を呼び、新規会話を開く。[teardown:488](../../src/view/chatManagerBase.ts#L488)はループの停止と`session.dispose()`を行うが、[ChatSession.dispose:791](../../src/appserver/chatSession.ts#L791)は保留中の承認・レビュー状態を片付けるだけで、進行中ターンへ中断要求を送らない。[LoopController.stop:632](../../src/loop/loopController.ts#L632)も通常ターンを中断する処理ではない。

Codexの接続は複数会話で共有され、通常のタブ破棄では接続自体も終了しない。既に進行中で、新たな承認待ちにならないターンは、画面から消えた後も続行できる。新規会話と並行して旧会話の処理・費用が進む可能性があり、確認文言と一致しない。通常のタブを閉じる経路も同じ後処理を通る。

**修正方針:**クリアでは対象ターンへの中断要求を行い、その結果を扱ってから画面を破棄する。中断失敗を成功として表示しない。他の会話を止めないよう共有接続の終了では解決しない。

**修正後の確認条件:**進行中のthreadId・turnIdを持つ状態でクリアを確定し、対象への`turn/interrupt`が送られることを確認する。中断失敗、確認キャンセル、ターン開始応答待ち、別会話が同時実行中の場合も確認する。中断後のCLI配下の子プロセス回収は別の確認範囲であり、要求送信だけで完全停止を保証しない。

### F03-04[P2]:開始待ちに閉じたCodexタブを応答後に再登録する

**条件:**新規Codexタブで`thread/start`の応答を待っている間にタブを閉じ、その後に開始成功の応答が届く。

[openNew:565](../../src/view/chatView.ts#L565)はエントリを開始待ちへ登録する。閉じると[teardown](../../src/view/chatManagerBase.ts#L488)が`disposed`を立て、[onTeardown](../../src/view/chatView.ts#L971)が開始待ちからも取り除く。しかし[openNew:567](../../src/view/chatView.ts#L567)はawait後に破棄状態を確認せず、返されたIDで同じエントリを`panels`へ登録する。

後で履歴からそのIDを開くと、既存エントリが見つかるため新規作成を省く。一方、[showPanel:263](../../src/view/chatManagerBase.ts#L263)は破棄済みなら何もしない。ウィンドウを再読込するなどして管理表を作り直すまで、対象の会話を開けない条件がある。

既存の[タブを閉じるテスト](../../test/unit/chatViewManager.test.ts#L549)は開始成功後に閉じている。[開始失敗のテスト](../../test/unit/chatViewSessionStartFailure.test.ts)も、この「閉じた後に成功」の順序を扱っていない。

**修正方針:**開始応答を受けた後、エントリがまだ有効か確認してから管理表へ移す。破棄済みなら再登録せず、開始成功を利用する後続処理にも渡さない。

**修正後の確認条件:**開始応答を保留してタブを閉じ、その後に成功応答を返す。管理表・開始待ちに破棄済みエントリが残らず、同じIDを履歴から開き直せることを確認する。失敗応答と複数同時開始でも、他のタブの登録を壊さないことを確認する。

### F03-05[P2]:履歴読込中に閉じたClaudeタブのプロセスを後から起動する

**条件:**Claudeの既存会話を開くか復元し、transcriptの読込中に表示されたタブを閉じる。読込が終わる前に閉じられる、大きな履歴や遅いファイルシステムで起きうる順序。

[openThread:805](../../src/view/claudeChatView.ts#L805)はタブを作って管理表へ登録し、その後にtranscriptを待つ。[restorePanel:1283](../../src/view/claudeChatView.ts#L1283)も同じ順序。閉じるとエントリは破棄されるが、[読込後のstart](../../src/view/claudeChatView.ts#L809)と[復元側のstart](../../src/view/claudeChatView.ts#L1286)には破棄状態の確認がない。

[ClaudeStreamSession.start:263](../../src/claude/streamSession.ts#L263)自身もdispose済みであることを保持せず、呼ばれればspawnする。このため、タブと管理表から外れたエントリにプロセスが残る。状態通知はマネージャの`entry.disposed`判定で捨てられ、その後のマネージャ破棄も管理表にないエントリを回収できない。

**修正方針:**履歴読込後にエントリの有効性を確認し、閉じられた場合は起動しない。開始前の非同期処理と破棄を、同じエントリの寿命として管理する。

**修正後の確認条件:**transcript読込を保留し、タブを閉じてから読込を完了させる。通常再開とserializer復元の両方で、start・spawnが呼ばれないことを確認する。続けて同じ会話を開き直した場合は、新しいエントリだけが起動することを確認する。

### F03-06[P2]:会話閲覧画面からの分岐でモデル設定を継承しない

**条件:**元のCodex会話に、現在の全体設定と異なるmodel・effortを保存している。会話閲覧画面の「ここから分岐」で新しい会話を開き、次の指示を送る。

[閲覧画面からのforkFromTurn](../../src/extension.ts#L2788)は単発app-serverで新しいIDを作り、[extension.ts:2809](../../src/extension.ts#L2809)でそのIDを`openThread()`へ渡す。親のセッション別設定を新IDへ保存する処理はない。[initialModelSettings:438](../../src/view/chatView.ts#L438)は新IDに保存値がなければ全体設定へ退避し、再開応答からmodel・effortをエントリへ取り込む処理もない。

全体設定が空でなければ、次の[turn/start](../../src/appserver/chatSession.ts#L320)へそのmodel・effortを明示するため、親の設定から変わる。同じ「途中分岐」でも、チャット内の[forkFrom:2085](../../src/view/chatView.ts#L2085)は親の設定を新IDへ保存しており、入口によって継承結果が異なる。

**修正方針:**分岐元のセッション別設定を新IDへ引き継いでから開く。全体設定しかない場合の扱いもチャット内分岐と揃える。

**修正後の確認条件:**親と全体設定に異なるmodel・effortを用意し、チャット内分岐と会話閲覧画面からの分岐を比較する。分岐先の表示、次の送信、タブ再開後の保存値が親の設定を維持し、親側の設定を変更しないことを確認する。

## 確認した既存の保護と参照テスト

以下はコードと既存テストの記述を確認したもの。今回テストが成功したという意味ではない。

- 両CLIの新規会話はcwdがなければ案内して終了する。通常の履歴再開は渡されたcwdを使い、同じIDの既存タブを再表示する:[chatViewManager.test.ts](../../test/unit/chatViewManager.test.ts)、[claudeChatViewManager.test.ts](../../test/unit/claudeChatViewManager.test.ts)。直前の会話は[resumeLast](../../src/extension.ts#L3063)が現在の履歴表示範囲の先頭を選ぶ。取得候補の取りこぼしはF02-02の関連範囲。
- Codexの開始失敗は開始待ちとタブを片付け、通常開始では通知、タスク開始では呼出元への例外伝播を行う:[chatViewSessionStartFailure.test.ts](../../test/unit/chatViewSessionStartFailure.test.ts)。開始待ちを複数件保持する単体処理は[pendingStarts.test.ts](../../test/unit/pendingStarts.test.ts)を参照。通知・承認の配送全体の保証とは区別する。
- 復元対象のIDが欠ける・型が違う場合の除外、同じIDの復元除外、タスク管理下の会話を汎用serializerから除外する経路を確認した:[panelState.test.ts](../../test/unit/panelState.test.ts)、両マネージャの既存テスト。Codexは復元直後に本文を取得せず、明示再開まで送信を抑止する。Claudeはtranscriptを読み、resumeプロセスを起動する。
- 改名は空白入力・キャンセルを除外する。Codexは`thread/name/set`成功後に表示名を更新し、Claudeはローカル名を保存してから表示へ反映する。Claudeの公開改名コマンドは完了後に履歴ツリーも更新する:[claudeSessionNames.test.ts](../../test/unit/claudeSessionNames.test.ts)、[extension.ts:1038](../../src/extension.ts#L1038)。
- model・effortはproviderとIDの組で保存し、同じIDへの保存は呼出順に直列化する。読込では型を確認し、保存途中も最新のメモリ上の値を返す:[sessionModelSettings.test.ts](../../test/unit/sessionModelSettings.test.ts)。セッション内の設定変更UI自体はF04で扱う。
- Codexの途中分岐は直前のターンを`lastTurnId`として渡す。会話閲覧画面も同じ向きで、最初の指示には分岐ボタンを出さない:[chatScript.ts:1281](../../src/view/chatScript.ts#L1281)、[conversationView.ts:110](../../src/view/conversationView.ts#L110)。[chatCodexThreadFlow.test.ts:150](../../test/integration/chatCodexThreadFlow.test.ts#L150)は接続を模擬して途中分岐を確認する記述で、全体分岐コマンドや実CLIの結果を保証するものではない。
- Claudeの途中分岐はfork済みプロセスだけへ巻戻しを許可し、新しい発言から順に処理する。0件成功で失敗した場合は新しいタブを閉じ、部分成功後の失敗は不整合を表示してタブを残す:[claudeForkFromTurn.test.ts](../../test/unit/claudeForkFromTurn.test.ts)、[claudeStreamSessionForkFromTurn.test.ts](../../test/unit/claudeStreamSessionForkFromTurn.test.ts)、[claudeChatViewManager.test.ts](../../test/unit/claudeChatViewManager.test.ts)。
- 会話閲覧画面は欠損ファイル・読込失敗・分岐候補0件を案内し、会話本文をHTMLへ埋める際にエスケープする。rolloutの壊れた行は読み飛ばす:[conversationView.ts](../../src/view/conversationView.ts)、[conversation.test.ts](../../test/unit/conversation.test.ts)。

## 関連指摘と残る範囲

F01のホーム設定・接続初期化・プロセス管理の指摘と、F02の履歴収集の指摘は、F03の開始・再開にも影響する。同じ原因は重複計上していない。今回のF03-04/F03-05は、開始や読込の待機中に利用者がタブを閉じるという別の経路を扱う。

Claudeの全体・途中分岐は、拡張側が分岐先IDを追跡せず、復元と作業記録の対象外である旨を会話に表示する既存実装。これを今回の新規指摘には数えていない。ID通知を用いた追跡の可否や、fork・逐次巻戻しの実CLIでの互換性は今回検証していない。

今回の変更は結果文書と台帳の進捗記録。実装・テストコードは変更していない。テスト・型チェック・lint、実VSCode・実CLI・Remote環境での検証は未実施。実行検証の追加・実行は明示依頼時のみという個人規約に従った。チェック済みは上表の静的レビュー完了を示し、全イベント順序の検証や指摘解消を意味しない。

開始時の設定確認の入口は読んだが、権限・承認の妥当性はF10、プリセットと設定変更はF04、編集再送とファイルの巻戻しはF09、引き継ぎ・作業記録は対応する後続機能へ残す。次は[F04:モデル・設定パネル・プリセット](../feature-inventory.md#f04)。
