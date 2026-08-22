# レビュー指摘と機能追加の統合ロードマップ

2026-08-22の全体レビューで挙がった26件の指摘と、同日のワークフロー確認で立てた8件の機能追加を
1本にまとめ、互いに干渉しない7つのワークフローへ再編したもの。

## きっかけ

この日、独立した2つのセッションが別々の成果を出した。

- **全体レビュー**: 50k LOC / 162ファイルを7領域で並列監査し、26件の指摘を
  [.agents/workflows/](../../.agents/workflows/) の3本のYAML（core / ui / final）へ計画としてまとめた
- **ワークフロー確認**: 拡張のワークフロー機能とチャット画面の不足を洗い出し、
  [workflow-autonomy.md](workflow-autonomy.md)（W1〜W5、epic [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341)）と
  [chat-conversation-parity.md](chat-conversation-parity.md)（X1〜X3、epic [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340)）を書いた

両者は同じファイルへ集中する。`runner.ts` は11項目が、`claudeChatView.ts` は7項目が触る。
別々に進めると統合ブランチでのマージ衝突が後段へ集中するため、34項目を統合して分割し直した。
あわせて、後述の運用規約から導かれる項目をW6として1件追加した（計35項目）。

## docs/roadmap/ の4本の関係

- [ux-improvements.md](ux-improvements.md) — R1〜R11。**全項目完了済み**（epic #297 もクローズ）。
  記録として残してある
- [workflow-autonomy.md](workflow-autonomy.md) — W1〜W12。本ロードマップの WF-E が担当する
- [chat-conversation-parity.md](chat-conversation-parity.md) — X1〜X3。WF-F が担当する
- 本ドキュメント — 上の8項目と全体レビューの26指摘を統合した、7ワークフローの分割と運用規約

## 方針

1. **ワークフロー同士がファイルを共有しない。** 分割の第一基準は担当領域の意味ではなく、
   触るファイルの集合が交差しないことに置く。交差するものは同じワークフローが持つか、
   波を分けて前後関係にする
2. **拡張のワークフロー機能は今回の実装には使わない。** 直す対象が runner の停止・dispose・
   worktree撤去・ループ制御そのものであり、走行中に自分の足元を掘ると原因の切り分けが
   できなくなる。機能としての検証（ドッグフーディング）は全実装の完了後に、安定した版で別途行う
3. **人が見るのは main へのマージだけにする。** タスク単位のPRはレビューを通したうえで
   統合ブランチへ自動でマージし、統合ブランチから main へのPRで人が判断する

## 分割の原則

全35項目について、触るファイルの集合から連結成分を求めた。結果、次の2つが大きなハブになる。

- `runner.ts` / `runnerOrchestrator.ts` / `runState.ts` を中心とするオーケストレーター実行系
- `claudeChatView.ts` / `chatView.ts` / `streamSession.ts` / `chatScript.ts` を中心とするチャットUI系

この2つは互いに交差しない。ハブを共有する項目は分割できないため、ハブ単位でワークフローを立て、
ハブに属さない項目（CI・ドキュメント・生成系）を独立させた。

`extension.ts` は T03（`context.subscriptions` への登録）と T19（`activate()` での `pruneCache` 呼出）が
触るため、この2件は同じワークフロー（WF-A）が持つ。

## ワークフローと波

波の内側は互いにファイルが交差しないため並列に進められる。波をまたぐ依存は一方向になる。

### 第1波 土台の修正（並列4）

- **WF-A オーケストレーター実行系**（11項目）
  - T02 `waitingReply` のタスクがターン失敗時に確定せず並列枠を占有する
  - T03 `WorkflowRunner.dispose()` がどこからも呼ばれない
  - T04 再試行時のworktree撤去が誤ったディレクトリを対象にする
  - T07 疑似worktreeの統合・反映で未ハンドルrejectが起き `merging` のまま枠を占有する
  - T08 「全体の停止」が衝突解決セッションを止めない／永続化の時点ずれ
  - T09 PR/MR操作の2件の不具合
  - T13 リロード復元後に統合成果がワークスペースへ届かない
  - T14 タスク間メッセージングの4件の不具合
  - T19 セッション一覧まわりの性能とキャッシュの3件
  - T20 オーケストレーターの警告が無制限に増える
  - T21 統合worktreeの排他制御の調査と修正
  - 依存: T08←T07 / T19←T03 / T21←T04, T13
  - ファイル: `src/orchestrator/runner*.ts`, `loopController.ts`, `runState.ts`, `forge.ts`,
    `integration.ts`, `pseudoWorktree.ts`, `messaging.ts`, `scheduler.ts`, `src/extension.ts`,
    `src/session/*`, `src/claude/sessionStore.ts`, `src/util/paths.ts`, `src/codex/cliLocator.ts`

- **WF-B 生成・安全系**（4項目）
  - T10 外部由来テキストの整形を1モジュールへ集約し、全プロンプト経路をそこへ通す
  - T15 ワークフロー生成（planner）の3件の不具合
  - T16 ロードマップMarkdownのパースを堅くする
  - T27 `slugifyGoal` の前処理にあるReDoSで長いゴール文がUIスレッドを止める（着手後に見つけて足した項目）
  - 依存: T15←T10 / T16←T10, T15 / T27←T15
  - ファイル: `src/orchestrator/workflow.ts`, `roadmap.ts`, `planner.ts`

- **WF-C チャットUIの土台**（9項目）
  - T05 app-server接続の初期化失敗・接続断で待機中のPromiseが解放されない
  - T06 Claude CLIの異常終了で応答待ちのPromiseが解放されず永久ハングする
  - T11 Claude側の `postState` に間引きが無い
  - T12 未使用の `AgentProvider.buildLaunch` 経路の整理
  - T17 ストリーム受信とプロセス終了の頑健性
  - T18 View層の軽微な2件（`controlPanelView` の参照クリア・CSPの集約）
  - T22 `chatView.ts` の破壊的操作系へのテスト追加（実装は変更しない）
  - T23 `chatView.ts` からプロバイダ非依存の共有ユーティリティを抽出
  - T24 `ChatViewManager` と `ClaudeChatViewManager` の重複を基底クラスへ抽出
  - 依存: T17←T05, T06 / T23←T11, T22 / T24←T23
  - ファイル: `src/appserver/*`, `src/claude/*`, `src/codex/*`, `src/provider/types.ts`,
    `src/util/ndjson.ts`, `src/view/chat*.ts`, `src/view/controlPanelView.ts`, `src/view/conversationView.ts`

- **WF-D リポジトリ基盤**（2項目）
  - T01 GitHub ActionsのCIワークフローを新規追加する（lint / typecheck / test）
  - T25 リポジトリ衛生の課題を調査し、対処方針を文書化する
  - 依存: なし
  - ファイル: `.github/workflows/ci.yml`, `docs/`

### 第2波 機能の追加（並列2）

- **WF-E ワークフローの自律性と安全な統制**（12項目、詳細は [workflow-autonomy.md](workflow-autonomy.md)）
  - W1 mainへの最終マージをオーケストレーターが判断する（[#335](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/335)）
  - W2 タスクのループ・停滞を検知して止める（[#336](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/336)）
  - W3 生成したワークフローの分解が妥当かをレビューする段を足す（[#337](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/337)）
  - W4 オーケストレーターがタスクを追加・削除・依存変更できるようにする（[#338](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/338)）
  - W5 PR/MRのレビュー結果を取り込んでタスクへ反映する（[#339](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/339)）
  - W6 タスクごとにIssueを起票し、PRのレビューを経てマージする（後述。Issueは未起票）
  - W7 タスクからオーケストレーターへ判断を仰ぐ経路を作る（Issueは未起票）
  - W8 オーケストレーターからユーザーへ確認する経路を作る（Issueは未起票）
  - W9 タスク間の直接メッセージングを廃し、オーケストレーターの中継にする（Issueは未起票）
  - W10 中断からの自動再開（Issueは未起票）
  - W11 CIの完了待ちとブランチ保護への対応（Issueは未起票）
  - W12 runをまたぐ統括（Issueは未起票）
  - 依存: W2←W1 / W7←W9 / W8←W7 / W4←W2, W8 / W5←W4 / W6←W1 / W11←W1 /
    W12←W1, W7, W8, W9, W10
  - **W6〜W12 は2026-08-22に追加した**（Issue #497）。同日、この拡張のワークフロー機能を使わずに
    人手で7ワークフローを回した実運用から出た要求による。あわせてW1・W4の方針を
    「人の承認を必須にする」から「オーケストレーターが判断し、人への確認は最低限」へ転換した
  - 前提: WF-AとWF-Bの完了（`runner.ts` / `forge.ts` / `planner.ts` / `roadmap.ts` を共有する）。
    両者とも完了済み（2026-08-22、WF-A: PR #447 / WF-B: PR #429）
  - 事実: WF-A2（[#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)）も
    `runner.ts`（例: #374 `WorkflowRunner.dispose()`）を触るため、WF-Eとファイルの集合が交差する。
    ワークフロー同士がファイルを共有しないという本ロードマップの並列規則に照らして判断すること
  - **決定: WF-EはWF-A2（#466）の完了を待つ**（2026-08-22）。上の交差があるため、
    並列規則に照らして順序を付けた。第2波はWF-Fのみ先に着手する
  - **申し送り**（2026-08-22、WF-B の担当から。着手時の起動プロンプトへ含めること）
    - **W6 が通すべき集約点の実体**。W6 は外部由来テキストの整形をT10の集約点へ通す前提であり、
      新規に整形処理を書き起こすと集約が崩れる。モジュールは
      [untrustedText.ts](../../src/orchestrator/untrustedText.ts)、仕様は
      [design.md](../design.md) §16.24。公開関数は
      `formatUntrusted(text, options)`（`options` は `{ id, field, maxLength, preserveNewlines?, nonce? }`。
      nonce は省略時に `randomUUID()`。**1回の展開で複数フィールドを囲む場合は呼び出し側が
      同じ nonce を明示的に渡す**）、`sanitizeInlineText(text, maxLength)`（一覧の要素向け）、
      `truncateByCodePoint(...)`（サロゲートペアを割らない切り詰め）
    - **使い分けは2系統ある。** プロンプトへ渡す経路は `formatUntrusted`、ログへ出す経路は
      `sanitizeForLog`（Trojan Source / bidi制御文字対策）。取り違えないこと
    - **`runner.ts` にロードマップ警告のログ出力6行がある。** WF-A のファイルだが、T16 の警告を
      人へ見せる出口として必要だったため**ユーザーの承認を得た例外**として残してある（Issue #408）。
      不審に見えても消さないこと。行番号は main が進んで当てにならないので識別子で探す

- **WF-F チャット画面の会話操作と表示**（3項目、詳細は [chat-conversation-parity.md](chat-conversation-parity.md)）
  - X1 応答のMarkdown描画へ表・引用・ネストしたリストを足す（[#332](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/332)）
  - X2 Claude Codeでも会話の途中のターンから分岐できるようにする（[#333](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/333)）
  - X3 Claude Codeでも脇道の質問を使えるようにする（[#334](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/334)）
  - 依存: X1 → X2 → X3（逐次。3項目とも `chatScript.ts` かcontrol protocol層を触る）
  - 前提: WF-Cの完了（`chatScript.ts` / `claudeChatView.ts` / `streamSession.ts` を共有する）。
    完了済み（2026-08-22、PR #431）
  - **完了**（2026-08-22、PR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510)）。
    着手時の想定と違った点が4つあり、いずれも実測して [design.md](../design.md) §14.61 / §14.62 へ残した
    - `rewind_conversation` は1回では戻れない。対象ターンとそれ以降のユーザー発言を新しい順に逐次送る（N往復）
    - `rewind_conversation` は失敗時も封筒が `subtype:"success"` で返る。本体の `rewound:false` でしか失敗が分からない
    - `side_question` も同型で、`synthetic:true` が失敗を意味する。`response` はCLI生成の英語プレースホルダで
      モデルの回答ではない。**当初の `response.ok` 判定はエラーを正常な回答として画面に出していた**
    - 脇道の質問は本流の会話の文脈を暗黙に共有する。また拡張のtranscriptエクスポートには `/btw` が残るため、
      「痕跡が残らない」は不正確。design.md §14.62 / README.md / docs/slash-commands.md の3か所へ明記した
    - `--fork-session` でないセッションへ `rewind_conversation` を送るとユーザーのtranscriptが壊れるため、
      最下層（`streamSession.ts`）に `isForkSession` ガードを入れている

### 第3波 仕上げ

- **WF-G 横断の仕上げ**（12項目）
  - T26 eslintへ型情報を要するルールを導入し、未処理Promiseを機械的に検出できるようにする
  - [#491](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/491)
    終了したrunを `retry_task` で再開してもオーケストレーターの制御ツールが復活しない
  - [#502](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/502)
    dispose()後に宙に浮いたstartTaskの継続がCLIセッションを起動しうる。
    **未検証の指摘であり、まず再現を確認し、成立しなければ根拠を記録してクローズする。**
    `pump()` が `void this.startTask(...)` を await せずに呼び、`startTask` は複数の `await` 点を
    経て `prepareTaskLaunch` に到達する。`WorkflowRunner.dispose()` は同期関数のため、
    その間に dispose が走ると、既に dispose 済みの状態でCLIセッションが起動しうる
  - [#485](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/485)
    疑似worktree反映: renameの必須化と一時ファイルの掃除
  - [#490](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/490)
    worktree撤去の試行回数に上限が無い（git側・疑似worktree側の両方）
  - [#524](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/524)
    警告ポップアップの「詳しくはログ」に出力チャネルを開く導線が無い
  - [#527](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/527)
    複数の親からブロックされた後続が、停止解除後に自動復帰しない
  - [#533](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/533)
    セッションのタブ名の組み立てがユニットテストで検証されていない
  - [#541](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/541)
    統合テスト C-42 が並列負荷下で間欠タイムアウトし、統合テスト全緑がEvidenceにならない。
    **再現は1回のみで成立未確認。着手する場合は修正から入らず再現条件の特定から始め、
    再現しなければ直さずに報告して閉じてよい。** 対象は1テストではなく
    `test/integration/helpers/waitFor.ts` を使う統合テスト全体の待ち方であり、
    C-42 に個別タイムアウトを与える対処は次に別のテストで同じことを起こす。
    Issue #522（PR #523で解消）と同じクラスで、**そこで実際に起きた害は
    「テストが落ちること」ではなく「実装者が失敗を無視する習慣をつけたこと」だった**
  - [#551](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/551)
    prettierの設定とコードが乖離している（121ファイル非準拠、lintが見ていない）。
    **T26と同じlint基盤の作業のため同じ回で扱う。** 一括 `prettier --write .` は開いているPRが
    無いときにしかできない（121ファイルへ同時に手を入れるため進行中のPRが全て衝突する）
  - [#562](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/562)
    権限昇格の検出（`messagingPermissionEscalation`）がW9以降 恒常的に不発火である。
    **まず「復活させる」か「削除する」かを決める作業であり、復活を既定として着手しないこと。**
    W9でメッセージングをオーケストレーター中継型にした結果 `from` が常に `-orchestrator-` になり、
    `checkMessagingPermissionEscalation` は全反復で `continue` して警告を出さない。
    型検査もlintもテストも通るため機械的には検出できず、**関数名と実装だけを読むと
    動いている防御に見える**。復活させる場合の設計の本体は由来の追跡情報を足すことではなく、
    **オーケストレーターが本文を書き換えられる以上、由来と本文の一致をどう保証するか**である
  - 全体レビュー（第1波・第2波の全変更を横断でレビューする）
  - 依存: 第1波・第2波の全完了
  - ファイル: `src` 全域（型情報ルールの導入は全ファイルへ波及する）
  - **申し送り**（2026-08-22、WF-A2 の担当から）
    - **#491 をここへ送った理由**: オーケストレーターのMCP URLはCLIプロセスの起動時に固定される
      （Codexは `thread/start` の `config.mcp_servers.<name>`、Claude Codeは `--mcp-config`）。
      サーバを立て直しても既存プロセスは古いURLを掴んだままなので、Issue #475 の案A
      （hubを捨てず再利用する）では救えない。救うにはオーケストレーターセッションの再起動か
      URLを差し替え可能にする設計変更が要り、WF-A2 の追いIssueの範囲を超える。あわせて
      #401 の方向(b)が制御ツールの可視性そのものにガードを足すため、**その着地を見てからでないと
      正しい形が決まらない**
    - **`chatScript.ts`（2333行）はテンプレートリテラルのため型検査もlintも効かない。**
      WF-G は型情報を要するeslintルールを入れる回なので、この負債も同じ回で扱うのが筋
      （型検査が効かないファイルが残っていると、型情報ルールの効果がそこだけ穴になる）。
      **この申し送りの出所は WF-F の担当**（X1〜X3 の着手前に自分の担当範囲として検分した結果）。
      `renderShell` の `chatShared.ts` への分離は WF-C が行った別件で、そちらは完了済み。
      残っているのはこの負債だけ。
      解消に要ると見積もられているのは、webview JS の実ファイル化とビルド導入（esbuild等）・
      CSP / nonce の見直し・エスケープ規約の全面的な書き換えの3点。
      **WF-F が検分したうえで「X1〜X3 では分離しない」と判断している**（X1〜X3 が触るのは
      `renderMarkdownInto` 付近と分岐・脇道質問のハンドラのみで局所的な一方、大規模移設は
      CI落ちと回帰の両リスクが高く、カバレッジ下限の余裕も小さいため）
    - **`chatScript.ts` のコメントにバッククォートを書かない。** テンプレートリテラルが切れて
      `tsc` が壊れる
  - **WF-A2から統合PR前に線引きした5件を送る**（2026-08-22、WF-A2 の担当から）
    - WF-A2の成果を統合ブランチへ置き去りにするのが最悪の結果であり、それに比べれば
      残件がWF-Gへ送られるのは小さい問題だと判断した。線引きの基準は、実害のある欠陥
      （データが届かない・runが終わらない）と誤った記録を残すもの（無効なテスト）は必ず入れる。
      テストの不足そのもの・可視化や導線・回避手段のある振る舞いの後退は送る、というもの
    - [#485](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/485)
      疑似worktree反映: renameの必須化と一時ファイルの掃除。`rename` を提供しないポート向けの
      後方互換経路（一時ファイルを使わない直接コピー）は、書き込み先の名前が `relPath` から
      予測可能なままのため、境界外の既存ファイルを上書きし、ロールバックがそれを削除しうる
      （任意ファイル破壊）性質を残している。
      **送る理由**: 本番で実際に使われるポート（`nodePseudoWorktreeFileSystem`）は `rename` を
      持つためこの経路には落ちない。残存リスクとして [design.md](../design.md) §16.20 に
      **正直に記述済み**であり、「守られている」という誤った記録にはなっていない
    - [#490](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/490)
      worktree撤去の試行回数に上限が無い（git側・疑似worktree側の両方）。
      `retryCount + manualRetryCount` に上限が無く、撤去時の処理コスト（`realpath` +
      ブロッキングI/O）が線形に増加する。
      **送る理由**: 実害は処理コストのみ。データ消失も境界越えも無い（各撤去は個別に境界
      チェックを通る）。PR #477 / #483 / #488 の監査で3回lowとして挙がり、いずれも
      「既存のパターン」として据え置かれてきた。**git側と疑似worktree側の両方をまとめて
      直す必要がある**（片方だけだと対称性が崩れる）
    - [#524](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/524)
      警告ポップアップの「詳しくはログ」に出力チャネルを開く導線が無い。
      **送る理由**: 可視化・導線の改善であり、振る舞いの欠陥ではない。
      `（詳しくはログ）` という文言は既存の6箇所で同じ形で使われており、**この1箇所だけ
      直すと不揃いになる。** 6箇所まとめて扱うべきで、それはWF-A2の追いIssueの範囲を超える
    - [#527](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/527)
      複数の親からブロックされた後続が、停止解除後に自動復帰しない。PR #517（Issue #432）の
      副作用。`markMergeSucceeded` の復帰対象フィルタが `s.failure?.kind === 'mergeBlocked'` を
      要求するが、停止中に `runHalted` へ書き換わったタスクは以降このフィルタに掛からない。
      **送る理由**: 詰みではない（当該タスク自身へ `retryTask` を呼べば救える）。修正前の
      全体挙動は「停止が解除されれば自動復帰するが、解除されなければ回収できない `pending` が
      生まれる」というより悪いもので、PR #517はそれを解いた。**この後退を直すには、停止中の
      `failure.kind` の扱いを設計から見直す必要がある**ため、局所修正では戻せない
    - [#533](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/533)
      セッションのタブ名の組み立てがユニットテストで検証されていない。`chatView.ts` /
      `claudeChatView.ts` のパネルタイトル組み立てを直接検証するテストが無い。PR #532の
      可視化効果（タブ名にtaskIdを含める）はユニットテストのレベルでは未検証。
      **送る理由**: テストが**無い**のであって、あるのに何も検証していない（誤った記録が
      残る）わけではない。既存の `role === 'orchestrator'` 分岐にも同じ欠落があり、PR #532が
      持ち込んだものではない。直すにはタイトル組み立てを純粋関数として切り出す必要があり、
      3分岐まとめて扱うのが筋
    - **WF-A2が統合PRへ必ず含める分**（送る5件と対比するため記録する）
      - #528 / #529 / #530 無効なテストの修正、#531 テストの書き方の規約
      - Issue #413のPR5（承認待ちのアイドルタイムアウト）
      - #514 `stop_task` が衝突解決セッションへ届かず、届いていないのに成功を返す
      - #511 疑似worktree: baselineが更新されないため、再開後の2周目の統合内容が
        ワークスペースへ届かない。**#511を送らずに入れる理由**: runは成功して終わるのに
        成果物がワークスペースへ届かないため、実質的に「誤った記録」と同じ性質を持つ
  - **`chatScript.ts` の実ファイル化に着手する前に読むこと**（2026-08-22、WF-F の担当から。
    X1〜X3 で `renderMarkdownInto` 付近と Claude Code の control protocol 層を実際に触った結果）
    - **分割の本丸はビルド手順とCSPであって、行数ではない。** `chatScript.ts` は
      テンプレートリテラル1本で webview 用のJSを組み立てている。実ファイル化には
      (a) webview用JSを別ファイルへ出す、(b) それをバンドルするビルド手順を足す、
      (c) CSP / nonce の与え方を作り直す、(d) 現在テンプレート補間で行っている値の埋め込み規約を
      全面的に書き直す、が要る。**行数を機械的に割るだけでは終わらない**
    - **`${` とバッククォートの禁止は、移行が完了するまで残る。** 実ファイル化するとこの制約は
      消えるが、**移行の途中で消えたと勘違いすると壊れる。**完全に外へ出し切るまでは効き続ける
    - **型検査とlintが届いた瞬間に、既存の違反がまとめて表面化する。** いまこのファイルは
      `tsc` も `eslint` も効いていない。実ファイル化すると初めて届くため、既存のバグや規約違反が
      一度に出る可能性がある。**「移動するだけ」の想定で見積もると規模が膨らむ。**
      分割PRの見積もりへその修正分を織り込んでおく
    - **【分割PRのレビュー観点】Markdown描画のDOM構築が最も壊れやすい。** X1 で `createTable` /
      `createQuote` / `createList` を足した。`createList` は深さのスタックでネストを組み立てる、
      このファイルで数少ない状態を持つ箇所。またこのファイルは**エージェントの出力を信用しない
      描画**（HTML文字列を組み立てず `createElement` + `createTextNode` / `textContent` のみ、
      リンクの `href` は `'#'` 固定で実遷移は `postMessage`）を守っている。
      **移送の過程でこの規約が崩れると、そのまま XSS 経路になる。**分割PRのレビューでは
      この規約が維持されているかを独立した観点として確認すること
    - **TS実装と webview 実装の二重管理があり、パリティテストは片方へ寄せるまで消さない。**
      [markdown.ts](../../src/view/markdown.ts) の `parseMarkdown` と、webview へ埋め込む
      `MARKDOWN_PARSE_SOURCE`（JSのソース文字列）が同じトークン列を返すことをテストで固定している。
      実ファイル化はこの二重管理を解消できる好機だが、**統合の際にパリティテストを消すと、
      TS側だけ直して webview 側が置き去りになる事故が検出できなくなる**
    - **`INLINE_RE` はキャプチャグループの位置に依存している。** X1 で `~~([^~]+)~~` を足したとき、
      それ以降のグループ番号が全部ずれた。正規表現へ何かを足すときは、**番号で分岐している箇所を
      全部見ること**

## W6 タスクごとにIssueを起票し、PRのレビューを経てマージする

- 依存: W1
- Issue: 未起票（着手時に起票する）
- 現状: **タスクごとのPR作成は既に実装されている。** `agent.workflows.pullRequest` の既定が
  `per-task` で（[config.ts](../../src/config.ts) の `normalizePullRequestLayerConfig`）、
  [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) が `shouldCreateTaskPullRequest` を見て
  [forge.ts](../../src/orchestrator/forge.ts) の `runTaskPullRequestFlow` を回す。その段取りは
  「タスクブランチをpush → 統合ブランチをpush → PRを作る → ローカルでマージして統合ブランチをpush →
  PRをready化」である。PR作成時の宛先ブランチも引数（`baseBranch`）で受け取っている。
  無いのは次の2つだけ。
  - **タスクごとのIssue起票**（`gh issue create` を呼ぶ経路が `src` 配下に無い）
  - **PRのレビューを経てからマージする段**（PRは記録として残すだけで、マージはローカルで行うため、
    PR上のレビューを待つ余地が無い）
- 変更: 上の2点だけを足す。既にある `per-task` のフローを作り直さない。
  - (a) タスクの開始時にIssueを起票し、PR本文から参照する。Issue本文はタスクの `prompt` と `done`
    から組み立て、外部由来テキストはT10で集約するサニタイズを通す
  - (b) PRを作ったあと、ローカルマージの前にレビューを1段挟む。レビューの実施主体
    （別セッションを立てるのか、forgeのレビュー機能を使うのか）は実装時に決めて design.md へ残す
  - どちらも設定で切り替えられるようにし、既定をどちらにするかは実装時に決めて design.md へ残す
- 受入基準: タスクの開始でIssueが起票されPR本文から参照される／PRがレビューを経てからマージされる／
  Issueを起票できない環境（CLIや認証が無い）では警告を出して従来どおり進み、runは止まらない／
  設定で従来の挙動へ戻せる／`per-task` 以外（`none` / `integration`）を選んだときの挙動が変わらない
- 影響: [forge.ts](../../src/orchestrator/forge.ts) /
  [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) / [runner.ts](../../src/orchestrator/runner.ts) /
  [config.ts](../../src/config.ts) / [workflowView.ts](../../src/view/workflowView.ts)

## 運用規約

全ワークフローで同じ手順を踏む。

1. ワークフローの開始時に **epic Issueを1件起票** し、統合ブランチ `wf/<wf-id>/integration` を作る
   （例: `wf/wf-a/integration`）。epic Issueにはタスクをチェックリストで並べる
2. タスクごとに **Issueを1件起票** し、worktreeでブランチを切る。ブランチ名は
   `<type>/<Issue番号>/<slug>`
3. 実装 → **統合ブランチを宛先とするPR** を作る → レビュー → 指摘対応 → マージ、を1タスクずつ繰り返す。
   **人の承認は挟まない**
4. すべてのタスクが終わったら、ワークフローの最後に **全体レビュー** を1段置く。
   統合ブランチに入った全変更を横断で見る
5. ワークフローの終了時に **統合ブランチから main へPR** を出す。mainへのマージは人が判断する
6. **ブランチは必ずworktreeで作る**。作業ツリーを直接切り替えない

補足。

- レビューはsubagent（`code-reviewer` / `security-auditor`）で行い、指摘は潰してからマージする。
  潰せないものはPR本文へ残す
- タスクの詳細な指示（根拠・行番号・変更内容・受入基準・自己レビュー手順）は
  [.agents/workflows/](../../.agents/workflows/) の該当タスクをそのまま使う。
  YAMLのファイル分け（core / ui / final）は本ドキュメントの分割で置き換わっており、
  参照するのは各タスクの `prompt` と `done` だけとする
- YAMLの `prompt` には「検証済み」「未検証」が明記してある。**未検証のタスクは、修正の前に
  再現条件の確認から始める**。確認の結果として指摘が成立しなかった場合は、直さずにその旨を報告する
- ロジック層（`vscode` を import しない層）へ寄せられる部分はユニットテストを付ける
- 実VSCodeでしか確かめられない受入基準は [docs/manual-test.md](../manual-test.md) へ追記する
- 権限や信頼境界に触れる変更は、[design.md](../design.md) §16.16（設定の信頼境界）の方針から
  外れないことを確かめてから入れる
- **横断レビューの結果は epic Issue と、統合ブランチから main へ出すPRの本文へ残す。docs配下に
  別の文書は作らない。** WF-A（epic #352 / PR #447）・WF-B（PR #429）・WF-C（PR #431）はいずれも
  この形で残しており、docs配下にレビュー記録の文書は存在しない。
  [.agents/workflows/](../../.agents/workflows/)（`review-fixes-core.yaml` の `Z01_core_review`、
  `review-fixes-ui.yaml` の `Z02_ui_review`）の `done` にある「docs配下の文書に残る」という記述は、
  この運用に置き換わっている。YAML自体は第1波の全タスクが終わった時点で歴史的な資料であり、
  文言は直さない
- **変更した振る舞いについて書かれた既存の文が近くにないかを、実装後に必ず確認する。**
  コードの変更が、同じファイルの既存の説明文を黙って偽にする事故が WF-A で5回起きた。
  JSDocが「〜という経路は現状無い」と書いている直下で、そのコミットがまさにその経路を
  実装している（PR #537）。`docs/design.md` の見出しが Issue #528〜#531 を扱うと書きながら、
  本文が #528 に触れていない（PR #535）。JSDocが「この状況は起こりえない」と断言したものが、
  実際には起きていた（PR #536 → Issue #539 / PR #540）。**差分だけを見ているレビューでは
  見つからない**性質のもので、差分の外を見る理由が要る。
  **キーワードのgrepでは足りない。** WF-E の W1（Issue #335 / PR #549）で、担当は
  `grep -rn "pr-only"` で洗って §16.18 の一節を正しく直したが、`pr-only` という文字列を
  含まない記述が4件漏れた（「run終了時にMCPサーバごと閉じる」§16.23、「`auto` にされては
  いけない」§16.16、「全11項目」という件数、「最終マージ（`finalMerge: auto`）の直前に」
  §16.18）。**変更した振る舞いを言い換えている文・件数・一覧表は、キーワードで引っかからない。**
  grepに加えて、変更した機能を説明している design.md の節を目で読む。一覧表と件数を持つ節
  （§16.16 の設定一覧、§16.23 の制御ツール一覧）は変更のたびに開く
- **同じクラスの穴が兄弟にもないかを探してから直す。** 片方だけ塞ぐPRが繰り返し出た。
  PR #536 は `mergeApprovalTimeoutSec` に上限を入れる修正だったが、同じ形の `replyTimeoutSec`
  にも同じ穴があった（両方直した）。Issue #541 の C-42 も、1テストに個別タイムアウトを与える
  対処は次に別のテストで同じことを起こす。**規律を文章で残すときは「どの起点か」まで特定して
  書く**: Issue #526 では「ルート起点で検査する」とだけ書いたため `.agents/worktrees` 起点が
  正解として扱われ、同じ循環が1段上で再発した（正しくは `workspaceRoot` 起点）
- **テストが本当に何かを検証しているかの確認は [design.md](../design.md) §16.25 に従う**
  （一般則と確認項目8件）。ここには内容を持たない（二重管理を避ける）
- **Issueを起票したら、同じ操作の中で行き先の一覧へ足す。** 「送り先を決めた」ことと
  「送り先の一覧に載せた」ことは別である。**一覧を更新した後に新しく起票したものは、
  一覧へ戻る動線が無い。** 2026-08-22〜23 に2件起きた（Issue #502 はWF-Gへ送ったつもりで
  この文書に無く、Issue #541 は `#534` でWF-Gの棚を更新した後に起票されたため載っていなかった）。
  epic Issue のクローズコメントに残件を並べるのは**棚ではない**。次の担当が読むのは棚のほうである
- **恒久的に残したい文書を書く前に `git check-ignore -v <path>` で確認する。** このリポジトリは
  `.gitignore` が `.claude/` をまるごと無視している。同一マシン上の別セッションからは読めるため、
  **書いた側が「残した」と錯覚しやすい**。WF-A の申し送りが実際にこの形で `.claude/handoff/`
  へ書かれ、リポジトリに入っていなかった
- **型のユニオンを複数のPRが同時に広げているときは、衝突解決の後に全ての枝が実在することを
  grepで確認する。** 衝突解決で片方の枝が落ちても、その枝を使う側も一緒に消えるため
  `tsc --noEmit` も lint もテストも緑のまま通る。**型で守られていない**のはこの一点である
- **「テスト全pass」の報告には、何を実行しての全passかを書かせる。** `npm test` は vitest の
  ユニットのみで、統合テストを含まない。WF-E の W11（Issue #560）で、担当が「全pass」と
  報告した状態で統合テストが2件落ちていた（78 passing / 2 failing、ベースは
  80 passing / 0 failing）。**担当は嘘をついておらず、報告の意味が実行したコマンドによって
  変わる。** 統合テストに触れる変更では
  `XDG_RUNTIME_DIR=/run/user/$(id -u) npm run test:integration:xvfb` まで回させる
- **沈黙が意味を持つ画面では、沈黙の意味が変わったことを画面側に伝える。** WF-E の W9 で
  `checkMessagingPermissionEscalation` が構造上不発火になった（中継化で `from` が常に
  `-orchestrator-` になり `live.def.tasks` に無いため、毎回 `continue` する）。
  design.md へ書いてもワークフローViewを見る人には届かず、**「警告が出ていない」を
  「権限差が無かった」と読む**。死んだ防御には、関数のJSDocとテストの両方に
  「不発火が意図的であること」と再実装のIssue番号を書き、[manual-test.md](../manual-test.md)
  にも「出ないのが現在の仕様」と書く（実機確認する人はコードを読まない）。
  現物は Issue [#562](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/562)
- **統合テストは `XDG_RUNTIME_DIR` の実在が要る。** 未設定だと mocha の出力が一切ないまま止まる。
  `XDG_RUNTIME_DIR=/run/user/$(id -u) npm run test:integration:xvfb` の形で回す
- **エディタが出す診断は、撤去した worktree を指す古いバッファのことがある。** 実体が無いのに
  「モジュールが見つからない」「implicit any」といった診断がファイル全体へ大量に出る。
  worktree を撤去した直後に起きやすい。**診断を信じて直しにかからず、まず実際に作業している
  worktree で `npx tsc --noEmit` を回して確認する。**WF-F では作業中に何度も発生し、
  そのたびに実測ではエラー0件だった

### 担当セッションの動き方

各ワークフローの担当は、自分で手を動かさず**オーケストレーターとして振る舞う**。

- 調査・実装・レビューは担当自身が行わず、そのつど**新しいセッションを作って任せる**。
  担当がするのは、ユーザーおよび作ったセッションとのやりとり、指示の分解、結果の検証、統合、最終判断
- **並列にできる作業は複数のセッションを同時に作ってよい。** ただし同じファイルを書くセッションは
  同時に走らせない（本ロードマップがワークフロー同士に課している制約を、ワークフローの内側でも守る）
- **作ったセッションはユーザーと直接やりとりしない。** ユーザーとのやりとりは必ず担当を経由する
  （ユーザー ←→ 担当（オーケストレーター）←→ セッション）。作ったセッションが判断に迷ったときは
  担当へ返し、担当が必要と判断したときだけユーザーへ確認する
- **指示で順序や範囲が変わったら、その指示で解消されなかった残りを明示する。** 指示に従うと、
  従った側は「解決した」という形の報告を返しやすく、**指示を出した側は自分の指示の穴を知る
  機会を失う**。WF-E 第1波で、担当は並列3→2の指示を受けた時点で `workflowView.ts` の交差が
  残ることを認識していながら報告に書かなかった（自己申告）。指示を出した側（オーケストレーター）
  も同じ穴を踏んでおり、`runner.ts` の交差だけを見て W9 を外し、W1×W3 の `workflowView.ts` を
  見落としていた
- **ロードマップの「影響」欄に書かれたファイル一覧を、並列の交差判断に使わない。** 実際に触る
  ファイルは着手して初めて決まる。WF-E の W3（Issue #337 / PR #548）は影響欄に
  `workflowView.ts` と書かれていたが1行も触らず（既存の `previewDefinition` へ流したため）、
  真の交差は `runner.ts` と `extension.ts` だった。交差は着手後の実測
  （`gh pr view <PR> --json files`）で判断する
- **タスクは追加・修正・削除してよい。** 着手して初めて分かることは多い。指摘が成立しなかった、
  分割し直したほうがよい、前提が変わった、といった場合は担当の判断で直す。
  ただし**方針が変わる場合はユーザーへ確認する**。方針が変わるとは、担当領域をまたぐ、
  設計の前提を変える、受入基準を下げる、他のワークフローへ影響する、といった場合を指す。
  変更した内容とその理由は epic Issue へ記録する

## 番号の割り当て

epic Issueは各ワークフローの開始時に起票し、採番できた時点でこの表へ追記する。

**`docs/design.md` の節番号と `docs/manual-test.md` のケース記号は、末尾への追記のみとする。**
既存の番号を動かさない（挿入・繰り上げ・体系の付け替えをしない）。動かす必要が出た場合は、
実行前に全体オーケストレーターを通す。子Issueの本文や他ワークフローのIssueが同じ番号を
参照しているため、**動かした本人には見えないところに影響が出る**。
Issue
[#487](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/487)
で §16.24 が先に使われていたため W1 以降を1つずつ繰り下げた結果、子Issue 5件（#335〜#339）の本文が
すべて腐った。しかも**ずれた先が隣の項目の有効な割り当てと一致する**という壊れ方で、
そのまま着手すると別項目の節へ書けてしまう状態だった。
なお、レビューや監査の指摘から起票されたIssueが持つ節番号は、起票時点で実在するものを
指しているため腐りにくい。ただし安全なのは起票時点までで、その後に割り当てが動けば同じように腐る。

| ワークフロー | 波 | 項目数 | epic Issue | 統合ブランチ | 状態 |
| --- | --- | --- | --- | --- | --- |
| WF-A オーケストレーター実行系 | 1 | 11 | [#352](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/352) | `wf/wf-a/integration` | 完了（PR [#447](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/447)、mainへマージ済み。統合ブランチは削除済み）。後続はWF-A2行（次行）を参照 |
| WF-A2 オーケストレーター実行系の追いIssue | 1 | 16 | [#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466) | `wf/wf-a2/integration` | 完了（PR [#542](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/542)、mainへマージ済み。統合ブランチは削除済み）。必須7件（[#528](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/528)・[#529](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/529)・[#530](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/530)・[#531](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/531)・[#413](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/413)・[#514](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/514)・[#511](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/511)）を解消し、残件はWF-Gへ送った（下の「WF-G 横断の仕上げ」を参照） |
| WF-B 生成・安全系 | 1 | 4 | [#350](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/350) | `wf/wf-b/integration` | 完了（PR [#429](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/429)、mainへマージ済み。統合ブランチは削除済み） |
| WF-C チャットUIの土台 | 1 | 9 | [#351](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/351) | `wf/wf-c/integration` | 完了（PR [#431](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/431)、mainへマージ済み。統合ブランチは削除済み） |
| WF-D リポジトリ基盤 | 1 | 2 | [#353](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/353) | `wf/wf-d/integration` | 完了（PR [#394](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/394)、mainへマージ済み。統合ブランチは削除済み） |
| WF-E ワークフローの自律性 | 2 | 12 | [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341) | `wf/wf-e/integration` | **進行中**。第1波（W1 [#335](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/335) / W3 [#337](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/337) / W9 [#547](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/547) / W11 [#556](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/556)）が統合ブランチへ着地済み（2026-08-23）。次は第2波（W2 [#336](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/336) / W7 未起票）。**節番号は着手のたびに、[workflow-autonomy.md](workflow-autonomy.md) の「着手前に必ず実測する」に従って実測すること**（割り当ては Issue [#543](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/543) で §16.26〜§16.37 へ移動済み）。追いIssue [#562](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/562) を WF-G へ送った |
| WF-F チャットの会話操作と表示 | 2 | 3 | [#340](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/340) | `wf/wf-f/integration` | 完了（PR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510)、mainへマージ済み。統合ブランチは削除済み） |
| WF-G 横断の仕上げ | 3 | 12 | 未採番 | `wf/wf-g/integration` | 第2波の完了待ち |

W1〜W5とX1〜X3のIssue番号・ブランチ名・design.mdの節・manual-test.mdの番号は、
[workflow-autonomy.md](workflow-autonomy.md) と [chat-conversation-parity.md](chat-conversation-parity.md) で
既に割り当ててある。担当はそこに書かれた番号だけを使う。

## 着手前の整理（完了済みの記録）

第1波を始める前に済ませた項目。**すべて完了しており、これから対応するものは無い。**

- **このロードマップを含むPR [#342](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/342) の
  マージは済んでいる**（2026-08-22）。取りこぼした差分も PR
  [#345](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/345) で回収済み
- **`feat/332/markdown-table-quote-nested-list` の未コミット変更の引き継ぎは完了した**（2026-08-22）。
  worktree `.claude/worktrees/agent-afc5d95d062c971b9` に残っていた `src/view/markdown.ts` の
  271行分の変更を、X1の担当が検分したうえでコミットし `wf/wf-f/integration` へ rebase した
  （`markdown.ts` は `cac40c73` 以降 main で変更されていなかったためコンフリクトなし）
- **不要なブランチの整理は済んでいる**（2026-08-22）。`feat/unified-approval-levels`（PR #343 で
  マージ済み）、`worktree-agent-a5ff0a7b5eea5cdfd`、`feat/335/final-merge-confirm`（いずれも独自の
  コミットが無い空ブランチ）と、リモートの `feat/327/workflow-branch-naming-conventions`
  （PR #330 でマージ済み）を削除した。W1のブランチは着手時に現在のmainから切り直す

### YAMLの行番号は古い

[.agents/workflows/](../../.agents/workflows/) の各タスクが根拠として挙げている行番号は、
全体レビューを実施した時点のmain（`cac40c73`）のものである。その後 PR
[#343](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/343)（承認方法をCodexとClaude Codeで
共通の3段階に揃える）がマージされ、次が変わっている。

- 変更: `src/view/chatScript.ts` / `chatView.ts` / `claudeChatView.ts` / `controlPanelView.ts` /
  `controlPanelScript.ts` / `chatStyles.ts` / `controlPanelStyles.ts` / `settingsProvider.ts`
- 削除: `src/provider/approvalCycle.ts`（かわりに `src/provider/approvalLevel.ts` が新設された）

**ずれているのはWF-Cの範囲だけで、`src/orchestrator/` 配下は変わっていない。**
WF-A / WF-B の根拠行はそのまま使える。WF-Cの根拠行を実測した結果は次のとおりで、
対象のコード自体はいずれも残っている。

| 根拠 | YAMLの記載 | 現在のmain |
| --- | --- | --- |
| `claudeChatView.ts` の `postState` | 355 | 360 |
| `chatView.ts` の `STATE_POST_INTERVAL_MS` | 144 | 151 |
| `chatView.ts` の `postState` | 2012 | 2028 |
| `controlPanelView.ts` の `this.view = view` | 100 | 108 |
| `conversationView.ts` のCSP組み立て | 145 | 157 |
| `chatCsp.ts` の `chatCsp()` | 11 | 11（ずれなし） |

行番号ではなくシンボル名と説明文で該当箇所を特定すること。また PR #343 は承認まわりで
`chatView.ts` と `claudeChatView.ts` に手を入れているため、T23 / T24 の抽出設計はその結果を
読んでから決める。承認まわりの変更で既に解消している指摘があれば、直さずにその旨を報告する。

**この節はWF-C着手前の申し送りだったが、WF-Cは完了した**（2026-08-22、PR #431でmainへマージ済み）。
その後さらにWF-A（PR #447）とWF-B（PR #429）もmainへマージされており、
`.agents/workflows/` の行番号は当時（`cac40c73`時点）のまま一切更新されていないため、
上表の「現在のmain」列との差分に加えて、WF-A / WF-B / WF-Cそれぞれの変更分だけ
さらにずれが積み重なっている。WF-E / WF-Fの担当は、YAMLの行番号をそのまま信じず、
シンボル名と説明文で現物を確認してから着手すること。

## 進め方

- 第1波の4ワークフローは同時に始めてよい。互いにファイルを共有しない
- 第2波は第1波の全完了を待つ。**第1波は4本とも完了済み**（2026-08-22、WF-A: PR #447 / WF-B: PR #429 /
  WF-C: PR #431 / WF-D: PR #394、いずれもmainへマージ済み）。WF-Aの後続として、実装過程とその後の
  横断レビューで分離した追いIssue epic [#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)
  （16件、統合ブランチ `wf/wf-a2/integration`）は **PR [#542](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/542) で完了した**（2026-08-22）。
  第2波は **WF-Fのみ先に着手する**という決定（2026-08-22）のもとで進み、
  **WF-FはPR [#510](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/510) で完了した**（2026-08-22）。
  WF-E は WF-A2 と `runner.ts` / `forge.ts` を共有しファイルの集合が交差するため後回しにしていたが、
  **WF-A2 の完了で交差が解け、2026-08-23 に着手した**（統合ブランチ `wf/wf-e/integration`）。
  WF-EとWF-Fは互いに交差しないので先にWF-Fだけを流した。**第2波で残るのはWF-Eのみ**
- 第3波は第2波の完了後。型情報ルールの導入は全ファイルへ波及するため最後に置く
- 各ワークフローの完了時に、READMEの該当箇所（機能の節・設定・既知の制約）を同じPRで更新する
- 全実装の完了後、拡張のワークフロー機能そのものでこの運用を回せるか（ドッグフーディング）を
  安定した版で確かめる。W6の受入確認をここで兼ねる
