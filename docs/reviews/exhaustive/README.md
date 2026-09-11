# 全関数・全分岐・全テストの精査

静的精査完了。対象555/555ファイル、残0件。前回の[機能別レビュー](../summary.md)の40機能・176項目とは別に、全対象の本文を読み、関数本体、各分岐と非同期境界、テストの準備・操作・期待値・後片付けを確認した。機械抽出だけで精査済みとはしていない。

基準コミットは`efd5cd67eb6a9b0a957538c9b5f981e2969875b6`。対象は追跡中のコード547ファイル・190,336行。実装、テスト補助、JavaScript/TypeScriptの設定、シェルを含む。加えて手動テスト文書・入力fixture8ファイルを確認した。対象は基準コミットの追跡コードとこれら8件であり、生成物・依存パッケージや後から追加されたコードは含めない。状態は[ファイル台帳](files.md)、根拠は各精査記録、構文単位は[extract.mjs](extract.mjs)で抽出する。出力の`inventory.json`は約15MBの中間生成物なので追跡せず、`node docs/reviews/exhaustive/extract.mjs`で再生成する（スクリプトが同じディレクトリへ書き出す。所要約8秒）。抽出対象はその時点のHEADなので、基準コミットの内容を再現するときは先に基準コミットをcheckoutする。[progress.mjs](progress.mjs)による台帳生成も再生成後に実行する。

## 精査単位

- 関数:名前付き関数、無名関数、コールバック、メソッド、コンストラクター、アクセサー。型宣言も契約として読む。
- 分岐:if/else、三項演算、switchの各case/defaultと不一致、ループの開始・反復・終了、短絡評価、optional chaining、引数既定値、try/catch/finally。早期return、throw、await前後の状態、非同期の競合も本文で確認する。
- テスト:各テスト本体、パラメーター化の入力、ヘルパー、モック、fixture、期待値、待機、後片付け、skip条件。実装の挙動とテストの名前だけを照合して済ませない。
- Webview:TypeScript外の埋め込みJavaScriptも対象。抽出した17候補は補間を`0`へ置換した構文参照であり、生成後の挙動を保証しない。元のテンプレート・挿入先を併読する。

構文上の関数は14,921個。テスト定義候補6,251件、assertion候補21,099件は呼出式の数で、実行テスト数ではない。describe、expectの内外の呼出し、eachの工場呼出しなどを重複して含む。埋め込みJavaScriptは別集計とする。これらをカバレッジ率として使わない。

## 完了条件と制約

全555ファイルに本文の精査記録を付け、ファイルのSHA-256と根拠への参照を照合した。[追加指摘一覧](findings.md)は94件（P1:23件、P2:69件、P3:2件）。既存116指摘は重複計上せず参照する。新規不具合、テスト不足、契約上の注意点を各記録で区別した。精査完了は修正完了を意味せず、指摘は未修正。

静的精査では、全入力の組合せ、外部CLIの実挙動、実行時の分岐網羅率を証明できない。今回テスト・lint・型チェック・実機検証は実行していない。途中分岐の実際のエラー原因も未確定のまま扱う。

最終照合では555件のハッシュと67件の根拠文書、reviews配下のローカルリンク2,038件を確認し、不一致・欠落は0件だった。製品コードとテスト本体に変更はない。成果物は`docs/feature-inventory`ブランチの`.worktree/docs-feature-inventory`に保存し、commit・pushは行っていない。

## 精査記録

- [実行管理本体](runner-main.md)
- [実行管理本体の全テスト内容](runner-test-main.md)

- [拡張の起動と全コマンド配線](extension-main.md)

- [Claudeチャット画面本体とテスト](claude-view-main.md)

- [チャット画面の全埋込みスクリプト](chat-script-main.md)

- [Forge本体・CLI・CI・レビュー操作](forge-main.md)

- [活動ログ](activity.md)
- [並列処理・直列キュー・Provider境界](core.md)
- [表示用の純粋関数](presentation.md)
- [途中からの分岐](fork.md)
- [Claude制御プロトコル](claude-control.md)
- [セッション操作・キャッシュ掃除](session-operations.md)

- [Provider補助](provider-helpers.md)
- [プロセス補助](process.md)
- [テスト基盤](test-infrastructure.md)

- [統合試験fixtureと補助](integration-fixtures.md)
- [純粋関数・表示状態の追加](pure-helpers.md)
- [MCP・skill補助](mcp-skills.md)
- [一覧・認証・CLI問い合わせ](catalogs.md)
- [設定importの変換](import.md)
- [セッション保存・読込み・会話変換](history.md)
- [実行ファイル・home・通知](locators.md)
- [入力候補・添付画像](input-helpers.md)
- [承認設定・通信・問い合わせ](approval-transport.md)
- [Codex単発要求・モデル・使用量・計画設定](codex-requests.md)
- [Codex会話セッション](chat-session.md)
- [会話状態と通知](chat-state.md)
- [会話書き出しとファイル復元](transcript-rewind.md)
- [表示差分・一覧・パス補助](view-helpers.md)
- [Claude応答ストリーム・会話制御](claude-stream.md)

- [タスク設定・起動判定・保存・境界処理](orchestrator-helpers.md)

- [ゴール・証拠・補助AI](loop-helpers.md)

- [ループ制御本体](loop-controller.md)

- [セカンドオピニオンの材料・起動・要約](second-opinion-core.md)

- [レビュー材料の実体化と相談継続](second-opinion-lifecycle.md)

- [セカンドオピニオンの画面導線と追加テスト](second-opinion-command.md)

- [ワークフロー承認・保存・program定義](orchestrator-approval-store.md)

- [表示集計・進捗・カンバン・導線テスト](panel-progress.md)

- [評価ベンチの実行・採点・案件抽出](evaluation-bench.md)

- [差分復元・本文整形・プリセット・設定取得](formatting-settings.md)

- [設定の読取りと正規化](configuration.md)

- [統合テストの本体・フェイク・期待値](integration-tests.md)

- [ForgeHubの保存・会話・操作画面](forge-hub.md)

- [実行中の通信・受け渡し・表示スナップショット](runner-messaging-handoff-snapshot.md)

- [ログ文字列の無害化](log-sanitization.md)

- [実行の復元と作業場所・疑似統合](runner-restore-working-directory.md)

- [program実行本体とテスト](program-runner.md)

`extract.mjs`は追跡コードを読み、構文位置とSHA-256を保存する補助スクリプト。`progress.mjs`は手で根拠を付けた`reviewed.json`から台帳を生成する。どちらもテスト実行や精査済みの自動判定は行わない。

- [ワークフロー表示・集計・配線](workflow-view-graph.md)

- [セッションツリー・管理基底・起動失敗/ゴール下書き試験](session-tree-manager-base.md)

- [Codexチャット管理本体・画面生成と破壊的操作のテスト](chat-view-main.md)

- [チャット共有処理・スタイルと検査内容](chat-shared-styles.md)

- [設定パネル本体・画面スクリプト・ホスト試験](control-panel-main.md)

- [Codexチャット管理のテスト内容](chat-view-manager-tests.md)

- [実行管理の寿命・承認試験とVSCodeモック](runner-lifecycle-tests-vscode-mock.md)

- [タスクworktreeの作成・撤去とテスト](worktree-main.md)

- [ローカル統合・占有・完了判定とテスト](integration-main.md)

- [タスク状態遷移とテスト](run-state-main.md)
- [マージ実行と衝突解決の寿命](runner-merge-main.md)

- [Webviewスクリプトのテスト内容](webview-script-tests.md)
- [オーケストレーターの制御・質問・通知](runner-orchestrator-main.md)

- [ワークフロー定義・検証・展開と全テスト](workflow-main.md)

- [疑似worktree・全テストの精査](pseudo-worktree-main.md)

- [手動試験計画・評価手順・fixture](manual-evaluation-protocol.md)

- [計画生成・単発ターン・レビューと全テスト](planner-main.md)

- [タスク通信・HTTP・全テスト](messaging-main.md)

- [ロードマップ本体・全テスト](roadmap-main.md)

- [手動テストの全操作・期待値](manual-test-main.md)
