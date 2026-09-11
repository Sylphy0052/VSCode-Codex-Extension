# 機能別レビュー台帳

調査日:2026-09-08。対象:`main`の`efd5cd67eb6a9b0a957538c9b5f981e2969875b6`（作業用worktree作成時点）。

公開導線、Webviewの操作ハンドラー、プロバイダ実装、状態・保存処理、既存テストを機能別に対応付けた。機能の存在とレビュー範囲を整理した静的調査であり、一覧の作成だけでは個別機能の品質判定や動作保証にならない。チェック済み項目の確認範囲・指摘・未検証事項は、各機能のレビュー結果を参照する。

レビュー進捗:2026-09-09時点でF01〜F40の全40機能・176項目の静的レビューを完了した。[全体結果と優先度](reviews/summary.md)を参照する。チェック済みは指摘解消・実行検証の成功を意味しない。

## 対象と網羅性

40のレビュー単位、176のチェック項目に整理した。共通と明記した機能もプロバイダ別の制約をレビュー観点に記載している。

- 製品機能に加え、CLI接続、状態同期、永続化、権限、作業記録、開発・配布基盤を含む。
- [全件対応表](feature-inventory-index.md)に全`src/`ファイル、manifestの全公開コマンド・設定、入力欄ボタン、ワークフローMCPツールを列挙した。
- `dist/`・`out/`・`node_modules/`・VSIX・評価結果・個人の作業ディレクトリは機能の一次根拠から除外した。ロードマップの未実装案を実装済み機能に数えない。
- テスト名は参照先。テスト・型チェック・lint・実VSCode・実CLI・外部サービスの操作は今回実行していない。完了範囲は台帳の機能別確認項目であり、全関数・全分岐・全テスト内容を網羅した保証ではない。

## 進め方

1. F番号から機能を選び、実装と関連テストを読む。共通機能はCodexとClaude Codeの両経路を見る。
2. 正常系、失敗・取消・中断、データ保持、他機能との競合を確認する。検証を実行した場合は対象と結果を記録する。
3. 指摘に`F番号-連番`を付け、重要度、再現条件、根拠の`file:line`、影響、必要な修正を記録する。
4. 確認を終えた小項目だけチェックし、参照commit・結果・未確認事項を追記する。

推奨順はF01〜F17の基本操作、F18〜F24の会話支援、F25〜F38の自動実行・Forge連携、F39〜F40の記録・開発基盤。特定機能から始める場合も、承認はF10/F30、ファイル操作はF09/F29、外部操作はF33/F37/F38を参照する。

## レビュー単位一覧

| ID          | レビュー単位                          | 小項目数 |
| ----------- | ------------------------------------- | -------- |
| [F01](#f01) | 起動・CLI探索・プロセス管理           | 6        |
| [F02](#f02) | 履歴の収集・検索・整理                | 5        |
| [F03](#f03) | 会話の開始・再開・命名・タブ復元      | 5        |
| [F04](#f04) | モデル・設定パネル・プリセット        | 5        |
| [F05](#f05) | 入力・送信・キュー・中断              | 5        |
| [F06](#f06) | 添付・画像・ファイル参照              | 4        |
| [F07](#f07) | スラッシュコマンド・特殊入力          | 5        |
| [F08](#f08) | チャット描画・操作性・状態同期        | 5        |
| [F09](#f09) | 差分表示・編集再送・ファイル復元      | 4        |
| [F10](#f10) | ツール承認・質問への回答              | 5        |
| [F11](#f11) | 使用量・費用・制限からの自動再開      | 4        |
| [F12](#f12) | 通知・会話の実行状態                  | 3        |
| [F13](#f13) | 計画・レビュー・圧縮・要約・書き出し  | 6        |
| [F14](#f14) | 脇道の質問・バックグラウンド作業      | 4        |
| [F15](#f15) | アカウント・ログイン状態              | 3        |
| [F16](#f16) | MCP・hooksの管理                      | 3        |
| [F17](#f17) | skills・plugins・apps・設定インポート | 4        |
| [F18](#f18) | 反復ループ・完了/停滞判定             | 5        |
| [F19](#f19) | ゴール下書き・ゴール駆動ループ        | 4        |
| [F20](#f20) | ループAdvisor・補助CLIの制限          | 4        |
| [F21](#f21) | セカンドオピニオンの資料準備          | 5        |
| [F22](#f22) | セカンドオピニオンの実行・継続相談    | 5        |
| [F23](#f23) | 進捗画面                              | 4        |
| [F24](#f24) | セッションカンバン                    | 3        |
| [F25](#f25) | ワークフロー定義・テンプレート        | 4        |
| [F26](#f26) | ゴールからのワークフロー生成          | 3        |
| [F27](#f27) | ロードマップ生成・変換・次フェーズ    | 5        |
| [F28](#f28) | タスク実行・スケジューリング          | 4        |
| [F29](#f29) | worktree隔離・ローカル統合・片付け    | 4        |
| [F30](#f30) | ワークフロー承認・人への確認          | 4        |
| [F31](#f31) | オーケストレーター・タスク間通信      | 5        |
| [F32](#f32) | チームモード・役割・受け渡しファイル  | 4        |
| [F33](#f33) | ワークフローのGitHub/GitLab連携       | 5        |
| [F34](#f34) | プログラムによる複数run統括           | 4        |
| [F35](#f35) | ワークフロー保存・中断後の復元        | 4        |
| [F36](#f36) | ワークフロー画面・メニュー            | 5        |
| [F37](#f37) | Forge HubのIssue起点の開発            | 5        |
| [F38](#f38) | Forge HubのPR・CI・レビュー・完了記録 | 5        |
| [F39](#f39) | 作業記録・診断ログ                    | 5        |
| [F40](#f40) | 開発・配布・評価基盤                  | 4        |

<a id="f01"></a>

## F01:起動・CLI探索・プロセス管理

- [x] F01.01:拡張の起動・終了とビュー・コマンド登録。
- [x] F01.02:Codex/Claudeの実行ファイル・ホーム・cwd解決。
- [x] F01.03:CLI未導入の案内と重複通知抑制。
- [x] F01.04:子プロセスの起動・中断・終了と標準入出力。
- [x] F01.05:Codexのapp-server/JSON-RPCの初期化・要求/応答・通知・接続断処理。
- [x] F01.06:Claudeのstream-json/control protocolの初期化・イベント変換・要求/応答。

レビュー結果:[2026-09-08の静的レビュー](reviews/f01-startup-cli-process.md)。対象commitは本台帳と同じ。P1が1件、P2が5件で、すべて未修正。テスト・実機検証は未実施。

主な実装:[src/appserver/connection.ts](../src/appserver/connection.ts)、[src/codex/appServerClient.ts](../src/codex/appServerClient.ts)、[src/codex/jsonRpc.ts](../src/codex/jsonRpc.ts)、[src/claude/streamSession.ts](../src/claude/streamSession.ts)、[src/extension.ts](../src/extension.ts)、[src/provider/registry.ts](../src/provider/registry.ts)、[src/provider/executableResolution.ts](../src/provider/executableResolution.ts)、[src/codex/cliLocator.ts](../src/codex/cliLocator.ts)、[src/claude/cliLocator.ts](../src/claude/cliLocator.ts)、[src/process/childProcess.ts](../src/process/childProcess.ts)、[src/process/commandRunner.ts](../src/process/commandRunner.ts)、[src/process/stdinSafety.ts](../src/process/stdinSafety.ts)。

既存テスト:[connection](../test/unit/connection.test.ts)、[jsonRpc](../test/unit/jsonRpc.test.ts)、[claudeControl](../test/unit/claudeControl.test.ts)、[executableResolution](../test/unit/executableResolution.test.ts)、[childProcess](../test/unit/childProcess.test.ts)、[stdinSafety](../test/unit/stdinSafety.test.ts)、[providerRegistry](../test/unit/providerRegistry.test.ts)。

レビュー観点:片方だけ導入した環境、起動失敗、古いプロセスのイベント、dispose後の処理。

<a id="f02"></a>

## F02:履歴の収集・検索・整理

- [x] F02.01:両CLIの履歴収集・索引・メタデータキャッシュ・変更監視。
- [x] F02.02:全ワークスペース/現在のワークスペースの範囲切り替えと件数制限。
- [x] F02.03:検索・グループ化・ピン留め。
- [x] F02.04:Codexのアーカイブ・解除・削除。
- [x] F02.05:起動時の不要キャッシュ整理。

レビュー結果:[F02レビュー](reviews/f02-history-search-organization.md)。4件の指摘は未修正・実行による再現未確認。

主な実装:[src/view/sessionTreeProvider.ts](../src/view/sessionTreeProvider.ts)、[src/session/sessionStore.ts](../src/session/sessionStore.ts)、[src/session/sessionWatcher.ts](../src/session/sessionWatcher.ts)、[src/claude/sessionStore.ts](../src/claude/sessionStore.ts)、[src/claude/transcriptWatcher.ts](../src/claude/transcriptWatcher.ts)、[src/codex/sessionIndex.ts](../src/codex/sessionIndex.ts)、[src/claude/sessionIndex.ts](../src/claude/sessionIndex.ts)、[src/session/sessionActions.ts](../src/session/sessionActions.ts)、[src/util/sessionFilter.ts](../src/util/sessionFilter.ts)、[src/util/sessionGrouping.ts](../src/util/sessionGrouping.ts)、[src/util/pinnedSessions.ts](../src/util/pinnedSessions.ts)。

既存テスト:[sessionStore](../test/unit/sessionStore.test.ts)、[claudeSessionStore](../test/unit/claudeSessionStore.test.ts)、[sessionTreeProvider](../test/unit/sessionTreeProvider.test.ts)、[sessionFilter](../test/unit/sessionFilter.test.ts)、[sessionGrouping](../test/unit/sessionGrouping.test.ts)、[sessionActions](../test/unit/sessionActions.test.ts)、[sessionIndex](../test/unit/sessionIndex.test.ts)。

レビュー観点:更新中・欠損・破損履歴、複数ルート、表示範囲と実ファイル操作の一致。archive/deleteはCodexのみ。

<a id="f03"></a>

## F03:会話の開始・再開・命名・タブ復元

- [x] F03.01:新規会話・履歴からの再開・直前の会話を再開。
- [x] F03.02:同一会話のタブ再利用・会話クリア・セッション名変更。
- [x] F03.03:パネル復元とセッション別モデル設定の継承。
- [x] F03.04:セッション全体・途中ターンからの分岐。
- [x] F03.05:Codexの会話閲覧画面からの分岐。

レビュー結果:[F03レビュー](reviews/f03-session-lifecycle.md)の6件に、[分岐エラーの追加調査](reviews/f03-fork-error-investigation.md)で3件を追加した。合計9件は未修正・実行による再現未確認。利用者が報告したエラーの原因は未確定。

主な実装:[src/view/chatView.ts](../src/view/chatView.ts)、[src/view/claudeChatView.ts](../src/view/claudeChatView.ts)、[src/view/chatManagerBase.ts](../src/view/chatManagerBase.ts)、[src/view/panelState.ts](../src/view/panelState.ts)、[src/view/pendingStarts.ts](../src/view/pendingStarts.ts)、[src/view/conversationView.ts](../src/view/conversationView.ts)、[src/claude/sessionNames.ts](../src/claude/sessionNames.ts)、[src/sessionModelSettings.ts](../src/sessionModelSettings.ts)。

既存テスト:[chatViewManager](../test/unit/chatViewManager.test.ts)、[claudeChatViewManager](../test/unit/claudeChatViewManager.test.ts)、[panelState](../test/unit/panelState.test.ts)、[pendingStarts](../test/unit/pendingStarts.test.ts)、[claudeSessionNames](../test/unit/claudeSessionNames.test.ts)、[sessionModelSettings](../test/unit/sessionModelSettings.test.ts)。

レビュー観点:ID確定前、開始失敗、cwd不明、リロード後の復元範囲。Codexの改名はapp-server、Claudeはローカル保存。編集再送はF09。

<a id="f04"></a>

## F04:モデル・設定パネル・プリセット

- [x] F04.01:設定パネルからの新規会話・セクション開閉・遅延取得・再取得。
- [x] F04.02:モデル・推論深度・Codexプロファイル・Claudeエージェント選択。
- [x] F04.03:モデル候補の定期更新・同時取得の集約・失敗時の既存候補保持。
- [x] F04.04:会話中の設定変更とセッション別保存。
- [x] F04.05:プリセットによるcwd・モデル・推論深度・承認設定の適用。

レビュー結果:[F04レビュー](reviews/f04-model-settings-presets.md)。4件の指摘は未修正・実行による再現未確認。初期指示はプリセットの実装にないため台帳の記載を訂正した。

主な実装:[src/config.ts](../src/config.ts)、[src/sessionPresets.ts](../src/sessionPresets.ts)、[src/sessionModelSettings.ts](../src/sessionModelSettings.ts)、[src/view/settingsProvider.ts](../src/view/settingsProvider.ts)、[src/view/controlPanelView.ts](../src/view/controlPanelView.ts)、[src/codex/modelCatalog.ts](../src/codex/modelCatalog.ts)、[src/claude/modelProbe.ts](../src/claude/modelProbe.ts)、[src/claude/agentProbe.ts](../src/claude/agentProbe.ts)。

既存テスト:[config](../test/unit/config.test.ts)、[sessionPresets](../test/unit/sessionPresets.test.ts)、[modelCatalog](../test/unit/modelCatalog.test.ts)、[claudeModelProbe](../test/unit/claudeModelProbe.test.ts)、[controlPanelView](../test/unit/controlPanelView.test.ts)、[settingsProviderSections](../test/unit/settingsProviderSections.test.ts)。

レビュー観点:machine/resource等のスコープ、反映時点、未知候補、上書き順。承認の実行経路はF10。

<a id="f05"></a>

## F05:入力・送信・キュー・中断

- [x] F05.01:通常送信と応答中の送信予約。
- [x] F05.02:予約の個別取消・即時送信・先頭1件の即時送信・入力欄へ戻す操作。
- [x] F05.03:応答中断と接続喪失・終了後の状態処理。
- [x] F05.04:Enter/Ctrl+Enter・IME変換・候補確定時の入力処理。
- [x] F05.05:エディタ選択範囲を会話の入力欄へ送る。

レビュー結果:[F05レビュー](reviews/f05-input-send-queue-interrupt.md)。7件の指摘は未修正・実行による再現未確認。「一括送信」は実装に合わせて「先頭1件の即時送信」へ訂正した。分岐エラーは既存の候補を補強したが、利用者の事象との一致は未確定。

主な実装:[src/appserver/chatSession.ts](../src/appserver/chatSession.ts)、[src/claude/streamSession.ts](../src/claude/streamSession.ts)、[src/view/chatScript.ts](../src/view/chatScript.ts)、[src/view/sendKey.ts](../src/view/sendKey.ts)、[src/util/editorSelection.ts](../src/util/editorSelection.ts)、[src/view/activePanelSequence.ts](../src/view/activePanelSequence.ts)。

既存テスト:[chatQueue](../test/unit/chatQueue.test.ts)、[chatSessionSendOrQueue](../test/unit/chatSessionSendOrQueue.test.ts)、[chatSessionInterrupt](../test/unit/chatSessionInterrupt.test.ts)、[sendKey](../test/unit/sendKey.test.ts)、[editorSelection](../test/unit/editorSelection.test.ts)。

レビュー観点:重複送信、キュー順、添付との組合せ、中断と完了の競合、送信先タブ。

<a id="f06"></a>

## F06:添付・画像・ファイル参照

- [x] F06.01:画像ファイルの選択・貼り付け・ドラッグ投入・添付解除。
- [x] F06.02:画像参照の解決と応答画像の表示。
- [x] F06.03:@によるファイル候補取得・絞り込み・相対パスの挿入。
- [x] F06.04:参照ファイルやURLを開く操作。

レビュー結果:[F06レビュー](reviews/f06-attachments-images-file-references.md)。7件の指摘は未修正・実行による再現未確認。添付対象は画像のみで、@は本文展開ではなく相対パスの挿入だったため記載を訂正した。

主な実装:[src/provider/attachments.ts](../src/provider/attachments.ts)、[src/provider/imageRefs.ts](../src/provider/imageRefs.ts)、[src/provider/fileMentions.ts](../src/provider/fileMentions.ts)、[src/view/chatShared.ts](../src/view/chatShared.ts)、[src/view/chatScript.ts](../src/view/chatScript.ts)。

既存テスト:[attachments](../test/unit/attachments.test.ts)、[chatImages](../test/unit/chatImages.test.ts)、[imageReply](../test/unit/imageReply.test.ts)、[fileMentions](../test/unit/fileMentions.test.ts)、[chatFileLinks](../test/unit/chatFileLinks.test.ts)。

レビュー観点:サイズ・形式、存在しないファイル、パスの基準、外部URLとローカルパスの識別。

<a id="f07"></a>

## F07:スラッシュコマンド・特殊入力

- [x] F07.01:CLI・skills・ローカルファイルのコマンド候補と引数ヒント。
- [x] F07.02:Codexの擬似/compact・/init・/btwとClaudeの擬似/btw。
- [x] F07.03:カスタムコマンドの候補挿入・CLIへの本文送信。
- [x] F07.04:Claudeの!によるターミナル入力。
- [x] F07.05:Claudeの#によるメモリ追記と複数ルートの追記先選択。

レビュー結果:[F07レビュー](reviews/f07-slash-commands-special-input.md)。8件の指摘は未修正・実行による再現未確認。カスタムプロンプトの本文展開は拡張機能内にはなく、CLIへ文字列を送る実装だったため記載を訂正した。

主な実装:[src/provider/commandCatalog.ts](../src/provider/commandCatalog.ts)、[src/provider/slashCommands.ts](../src/provider/slashCommands.ts)、[src/provider/pseudoCommands.ts](../src/provider/pseudoCommands.ts)、[src/provider/inputModes.ts](../src/provider/inputModes.ts)、[src/codex/skillsList.ts](../src/codex/skillsList.ts)、[src/claude/skillsList.ts](../src/claude/skillsList.ts)。

既存テスト:[commandCatalog](../test/unit/commandCatalog.test.ts)、[slashCommands](../test/unit/slashCommands.test.ts)、[pseudoCommands](../test/unit/pseudoCommands.test.ts)、[inputModes](../test/unit/inputModes.test.ts)、[argumentHint](../test/unit/argumentHint.test.ts)。

レビュー観点:組込と擬似コマンドの優先順位、複数行の通常文章、既存AGENTS.md・CLAUDE.mdの扱い。/btw本体はF14。

<a id="f08"></a>

## F08:チャット描画・操作性・状態同期

- [x] F08.01:応答・推論・コマンド・ツール・編集・計画・エラーのストリーミング表示。
- [x] F08.02:Markdown・構文強調・コードコピー・エディタ挿入・新規ファイルで開く操作。
- [x] F08.03:表示密度・テーマ・スクロール・折り畳み・動きを減らす設定への対応。
- [x] F08.04:入力欄ボタンの表示順と「…」メニュー。
- [x] F08.05:全量/差分の状態同期と欠落時の再取得。

レビュー結果:[F08レビュー](reviews/f08-chat-rendering-state-sync.md)。7件の指摘は未修正・実行による再現未確認。途中分岐エラーの原因を確定する新たな証拠は得ていない。

主な実装:[src/view/chatScript.ts](../src/view/chatScript.ts)、[src/view/chatShared.ts](../src/view/chatShared.ts)、[src/view/markdown.ts](../src/view/markdown.ts)、[src/view/highlight.ts](../src/view/highlight.ts)、[src/view/chatStyles.ts](../src/view/chatStyles.ts)、[src/view/density.ts](../src/view/density.ts)、[src/view/reducedMotion.ts](../src/view/reducedMotion.ts)、[src/view/composerButtons.ts](../src/view/composerButtons.ts)、[src/view/stateDelta.ts](../src/view/stateDelta.ts)、[src/view/chatCsp.ts](../src/view/chatCsp.ts)、[src/appserver/chatState.ts](../src/appserver/chatState.ts)。

既存テスト:[markdown](../test/unit/markdown.test.ts)、[highlight](../test/unit/highlight.test.ts)、[webviewScript](../test/unit/webviewScript.test.ts)、[webviewStyles](../test/unit/webviewStyles.test.ts)、[stateDelta](../test/unit/stateDelta.test.ts)、[composerButtons](../test/unit/composerButtons.test.ts)、[chatCsp](../test/unit/chatCsp.test.ts)。

レビュー観点:長い会話のDOM更新、状態との一致、HTML/URL・CSP、入力とスクロール位置の保持。

<a id="f09"></a>

## F09:差分表示・編集再送・ファイル復元

- [x] F09.01:変更ファイルを開く・VSCodeの差分エディタを開く・差分を戻す。
- [x] F09.02:送信済み指示を書き直し、新しい分岐先へ再送。
- [x] F09.03:Codexの編集再送時に直接編集したファイルを明示選択で復元。
- [x] F09.04:Claudeのファイル巻き戻しと会話の分岐・巻き戻し。

レビュー結果:[F09レビュー](reviews/f09-diff-edit-resend-file-restore.md)。7件（P1が3件、P2が4件）の指摘は未修正・実行による再現未確認。途中分岐の既存指摘が編集再送にも及ぶことを記録したが、ユーザー報告の原因は未確定。

主な実装:[src/view/chatView.ts](../src/view/chatView.ts)、[src/view/claudeChatView.ts](../src/view/claudeChatView.ts)、[src/view/chatShared.ts](../src/view/chatShared.ts)、[src/util/diffRestore.ts](../src/util/diffRestore.ts)、[src/util/diffWorkspacePath.ts](../src/util/diffWorkspacePath.ts)、[src/appserver/fileRewind.ts](../src/appserver/fileRewind.ts)、[src/claude/forkFromTurn.ts](../src/claude/forkFromTurn.ts)。

既存テスト:[diffRestore](../test/unit/diffRestore.test.ts)、[diffWorkspacePath](../test/unit/diffWorkspacePath.test.ts)、[fileRewind](../test/unit/fileRewind.test.ts)、[claudeForkFromTurn](../test/unit/claudeForkFromTurn.test.ts)、[chatViewDestructiveOps](../test/unit/chatViewDestructiveOps.test.ts)。

レビュー観点:元会話の保持、先頭発言、他タブ・実行中・外部編集との競合、部分失敗、symlink、追加・削除・移動。Codexのコマンド実行による変更は復元対象外。

<a id="f10"></a>

## F10:ツール承認・質問への回答

- [x] F10.01:全確認/Auto/全承認とカスタム設定の対応。
- [x] F10.02:コマンド・編集・権限要求の承認/拒否と承認先の選択。
- [x] F10.03:Codexの自動承認レビュー状況の表示。
- [x] F10.04:Codexのツール/MCPからの問い合わせへの回答。
- [x] F10.05:ClaudeのAskUserQuestionへの選択・自由入力回答。

レビュー結果:[F10レビュー](reviews/f10-tool-approvals-user-questions.md)。10件（P1が2件、P2が8件）の指摘は未修正・実行による再現未確認。承認の誤配送と、全確認へ変更してもbypassが残る経路を含む。

主な実装:[src/appserver/approvals.ts](../src/appserver/approvals.ts)、[src/appserver/autoApprovalReview.ts](../src/appserver/autoApprovalReview.ts)、[src/appserver/prompts.ts](../src/appserver/prompts.ts)、[src/provider/approvalLevel.ts](../src/provider/approvalLevel.ts)、[src/codex/sandboxPolicy.ts](../src/codex/sandboxPolicy.ts)、[src/claude/control.ts](../src/claude/control.ts)、[src/claude/askUserQuestion.ts](../src/claude/askUserQuestion.ts)、[src/view/chatManagerBase.ts](../src/view/chatManagerBase.ts)。

既存テスト:[approvals](../test/unit/approvals.test.ts)、[autoApprovalReview](../test/unit/autoApprovalReview.test.ts)、[prompts](../test/unit/prompts.test.ts)、[approvalLevel](../test/unit/approvalLevel.test.ts)、[sandboxPolicy](../test/unit/sandboxPolicy.test.ts)、[askUserQuestion](../test/unit/askUserQuestion.test.ts)、[claudeStreamSessionApproval](../test/unit/claudeStreamSessionApproval.test.ts)。

レビュー観点:要求ID、期限・切断・中断後の応答、危険設定の確認、二重適用、未対応要求。

<a id="f11"></a>

## F11:使用量・費用・制限からの自動再開

- [x] F11.01:使用量・リセット時刻・ステータスバーのゲージ。
- [x] F11.02:セッション累計トークンとClaudeの費用・credits情報。
- [x] F11.03:使用量上限に達した会話の待機と自動続行。
- [x] F11.04:自動再開の切り替えと手動中断・承認待ち・タブ終了時の扱い。

レビュー結果:[F11レビュー](reviews/f11-usage-cost-limit-auto-resume.md)。8件（P1が2件、P2が6件）の指摘は未修正・実行による再現未確認。Codexの失敗結果の取りこぼしと、手動中断後に再開予約が復活する経路を含む。

主な実装:[src/view/usageStatusBar.ts](../src/view/usageStatusBar.ts)、[src/session/usageReader.ts](../src/session/usageReader.ts)、[src/codex/usage.ts](../src/codex/usage.ts)、[src/claude/usageProbe.ts](../src/claude/usageProbe.ts)、[src/claude/usageText.ts](../src/claude/usageText.ts)、[src/claude/costText.ts](../src/claude/costText.ts)、[src/view/chatView.ts](../src/view/chatView.ts)、[src/view/claudeChatView.ts](../src/view/claudeChatView.ts)。

既存テスト:[usage](../test/unit/usage.test.ts)、[usageReader](../test/unit/usageReader.test.ts)、[usageStatusBar](../test/unit/usageStatusBar.test.ts)、[claudeUsageText](../test/unit/claudeUsageText.test.ts)、[claudeCostText](../test/unit/claudeCostText.test.ts)、[rateLimitsRead](../test/unit/rateLimitsRead.test.ts)。

レビュー観点:値の出所、未取得とゼロ、複数モデル、時刻不明、リセット後も上限の場合、再試行の重複。

<a id="f12"></a>

## F12:通知・会話の実行状態

- [x] F12.01:承認待ちの通知と該当会話への移動。
- [x] F12.02:応答完了通知の設定。
- [x] F12.03:履歴の実行中・承認待ち・待機状態の装飾。

レビュー結果:[F12レビュー](reviews/f12-notifications-session-activity.md)。4件（すべてP2）の指摘は未修正・実行による再現未確認。Codexの質問待ちの見落とし、履歴の更新漏れ、タブの状態マーク欠落を含む。

主な実装:[src/view/approvalPending.ts](../src/view/approvalPending.ts)、[src/view/approvalStatusBar.ts](../src/view/approvalStatusBar.ts)、[src/view/sessionActivity.ts](../src/view/sessionActivity.ts)、[src/view/sessionDecorations.ts](../src/view/sessionDecorations.ts)、[src/view/chatManagerBase.ts](../src/view/chatManagerBase.ts)。

既存テスト:[approvalPending](../test/unit/approvalPending.test.ts)、[approvalStatusBar](../test/unit/approvalStatusBar.test.ts)、[sessionActivity](../test/unit/sessionActivity.test.ts)、[sessionDecorations](../test/unit/sessionDecorations.test.ts)。

レビュー観点:複数タブ、フォーカス中の通知、承認解除直後、状態更新とタブ破棄の競合。

<a id="f13"></a>

## F13:計画・レビュー・圧縮・要約・書き出し

- [x] F13.01:Plan mode切り替えと計画からの続行。
- [x] F13.02:コードレビューの起動とCodexの対象選択。
- [x] F13.03:会話の圧縮・要約とClaudeの自動圧縮ウィンドウ。
- [x] F13.04:応答末尾へ指示・成果・次の行動を示す設定。
- [x] F13.05:会話のMarkdown書き出しと新セッションへの引き継ぎ。
- [x] F13.06:ClaudeのFast mode切り替え（対応時）。

レビュー結果:[静的レビュー](reviews/f13-plan-review-export.md)。実装修正・実機検証は未実施。

主な実装:[src/appserver/planMode.ts](../src/appserver/planMode.ts)、[src/codex/reviewTarget.ts](../src/codex/reviewTarget.ts)、[src/appserver/transcriptMarkdown.ts](../src/appserver/transcriptMarkdown.ts)、[src/view/handoff.ts](../src/view/handoff.ts)、[src/view/turnSummary.ts](../src/view/turnSummary.ts)、[src/claude/autocompactText.ts](../src/claude/autocompactText.ts)、[src/appserver/chatSession.ts](../src/appserver/chatSession.ts)、[src/claude/streamSession.ts](../src/claude/streamSession.ts)。

既存テスト:[planMode](../test/unit/planMode.test.ts)、[reviewTarget](../test/unit/reviewTarget.test.ts)、[chatReview](../test/unit/chatReview.test.ts)、[transcriptMarkdown](../test/unit/transcriptMarkdown.test.ts)、[chatSessionRecap](../test/unit/chatSessionRecap.test.ts)、[claudeStreamSessionRecap](../test/unit/claudeStreamSessionRecap.test.ts)、[turnSummary](../test/unit/turnSummary.test.ts)、[claudeAutocompactText](../test/unit/claudeAutocompactText.test.ts)。

レビュー観点:通常ターンとの競合、設定の戻し忘れ、書き出す画像・ツール履歴の範囲、引き継ぎに残る情報。

<a id="f14"></a>

## F14:脇道の質問・バックグラウンド作業

- [x] F14.01:/btwで独立した質問を送り、Codexは別タブ、Claudeは本流へ結果表示。
- [x] F14.02:本流の中断と脇道質問のライフサイクル。
- [x] F14.03:バックグラウンドターミナル/タスク一覧とClaudeの停止操作。
- [x] F14.04:Codexのサブエージェント状態の会話内表示。

レビュー結果:[静的レビュー](reviews/f14-side-questions-background.md)。実装修正・実機検証は未実施。

主な実装:[src/codex/sideQuestion.ts](../src/codex/sideQuestion.ts)、[src/claude/sideQuestion.ts](../src/claude/sideQuestion.ts)、[src/claude/streamSession.ts](../src/claude/streamSession.ts)、[src/appserver/chatState.ts](../src/appserver/chatState.ts)。

既存テスト:[sideQuestion](../test/unit/sideQuestion.test.ts)、[claudeSideQuestion](../test/unit/claudeSideQuestion.test.ts)、[chatSideQuestion](../test/unit/chatSideQuestion.test.ts)、[claudeStreamSessionBackgroundTasks](../test/unit/claudeStreamSessionBackgroundTasks.test.ts)。

レビュー観点:本流への混入、使い捨てセッションの後始末、停止対象の同定。Codexの一覧とClaudeの停止を同一機能と扱わない。

<a id="f15"></a>

## F15:アカウント・ログイン状態

- [x] F15.01:アカウント・認証状態の取得と表示。
- [x] F15.02:CodexのAPIキーloginとlogout。
- [x] F15.03:Claudeのlogoutとターミナルでのlogin案内。

レビュー結果:[静的レビュー](reviews/f15-account-auth.md)。実装修正・実機検証は未実施。

主な実装:[src/provider/account.ts](../src/provider/account.ts)、[src/codex/accountStatus.ts](../src/codex/accountStatus.ts)、[src/codex/accountActions.ts](../src/codex/accountActions.ts)、[src/claude/authProbe.ts](../src/claude/authProbe.ts)、[src/claude/authActions.ts](../src/claude/authActions.ts)、[src/view/settingsProvider.ts](../src/view/settingsProvider.ts)、[src/view/controlPanelView.ts](../src/view/controlPanelView.ts)。

既存テスト:[codexAccountStatus](../test/unit/codexAccountStatus.test.ts)、[codexAccountActions](../test/unit/codexAccountActions.test.ts)、[claudeAuthStatus](../test/unit/claudeAuthStatus.test.ts)、[claudeAuthActions](../test/unit/claudeAuthActions.test.ts)。

レビュー観点:認証失敗、CLI未導入、操作後の更新、秘密情報の保持・ログ出力。

<a id="f16"></a>

## F16:MCP・hooksの管理

- [x] F16.01:MCPサーバーの一覧・状態・提供ツール・認証案内。
- [x] F16.02:対応するサーバーの有効/無効切り替え。
- [x] F16.03:hooksの一覧・状態・警告とCodexの信頼操作。

レビュー結果:[静的レビュー](reviews/f16-mcp-hooks.md)。実装修正・実機検証は未実施。

主な実装:[src/provider/mcpServers.ts](../src/provider/mcpServers.ts)、[src/provider/hooks.ts](../src/provider/hooks.ts)、[src/codex/mcpStatus.ts](../src/codex/mcpStatus.ts)、[src/codex/mcpDisable.ts](../src/codex/mcpDisable.ts)、[src/codex/hooksStatus.ts](../src/codex/hooksStatus.ts)、[src/claude/mcpProbe.ts](../src/claude/mcpProbe.ts)、[src/claude/hooksProbe.ts](../src/claude/hooksProbe.ts)、[src/claude/hooksSettings.ts](../src/claude/hooksSettings.ts)、[src/view/settingsProvider.ts](../src/view/settingsProvider.ts)。

既存テスト:[mcpServers](../test/unit/mcpServers.test.ts)、[mcpDisable](../test/unit/mcpDisable.test.ts)、[codexMcpStatus](../test/unit/codexMcpStatus.test.ts)、[codexHooksStatus](../test/unit/codexHooksStatus.test.ts)、[hooksProvider](../test/unit/hooksProvider.test.ts)、[claudeHooksSettings](../test/unit/claudeHooksSettings.test.ts)。

レビュー観点:CLIの能力による出し分け、設定変更先、再取得失敗、既存設定の保持。

<a id="f17"></a>

## F17:skills・plugins・apps・設定インポート

- [x] F17.01:skills一覧・Codexの有効/無効切り替えとClaudeの再読み込み。
- [x] F17.02:plugins一覧と対応する有効化・無効化・導入・削除。
- [x] F17.03:Codexのapps一覧閲覧。
- [x] F17.04:Claude Code由来設定のCodexへの検出・選択・インポート。

レビュー結果:[静的レビュー](reviews/f17-skills-plugins-apps-import.md)。実装修正・実機検証は未実施。

主な実装:[src/provider/skills.ts](../src/provider/skills.ts)、[src/provider/plugins.ts](../src/provider/plugins.ts)、[src/provider/import.ts](../src/provider/import.ts)、[src/codex/skillsStatus.ts](../src/codex/skillsStatus.ts)、[src/codex/skillDisable.ts](../src/codex/skillDisable.ts)、[src/codex/pluginsStatus.ts](../src/codex/pluginsStatus.ts)、[src/codex/appsStatus.ts](../src/codex/appsStatus.ts)、[src/codex/importStatus.ts](../src/codex/importStatus.ts)、[src/claude/skillsProbe.ts](../src/claude/skillsProbe.ts)、[src/claude/pluginsActions.ts](../src/claude/pluginsActions.ts)、[src/view/settingsProvider.ts](../src/view/settingsProvider.ts)。

既存テスト:[skillsProvider](../test/unit/skillsProvider.test.ts)、[pluginsProvider](../test/unit/pluginsProvider.test.ts)、[importProvider](../test/unit/importProvider.test.ts)、[codexSkillsStatus](../test/unit/codexSkillsStatus.test.ts)、[codexPluginsStatus](../test/unit/codexPluginsStatus.test.ts)、[codexAppsStatus](../test/unit/codexAppsStatus.test.ts)、[codexImportStatus](../test/unit/codexImportStatus.test.ts)、[claudePluginsActions](../test/unit/claudePluginsActions.test.ts)、[settingsProviderReloadClaudeSkills](../test/unit/settingsProviderReloadClaudeSkills.test.ts)。

レビュー観点:プロバイダ別の操作可否、導入スコープ、破損設定、処理中の再操作、既存ファイルの保持。

<a id="f18"></a>

## F18:反復ループ・完了/停滞判定

- [x] F18.01:回数・時間・完了条件による反復送信。
- [x] F18.02:開始・停止・一時停止・再開と状態表示。
- [x] F18.03:現在のターンに限定した完了・撤退合図の判定。
- [x] F18.04:同一応答の停滞検出と上限・失敗・ユーザー操作による停止。
- [x] F18.05:検証・方針変更を促す初回/継続ターンの指示付与。

レビュー結果:[静的レビュー](reviews/f18-loop-control.md)。実装修正・実機検証は未実施。

主な実装:[src/loop/loopController.ts](../src/loop/loopController.ts)、[src/loop/loopEngineering.ts](../src/loop/loopEngineering.ts)、[src/loop/stallDetector.ts](../src/loop/stallDetector.ts)、[src/loop/turnFocus.ts](../src/loop/turnFocus.ts)、[src/view/chatView.ts](../src/view/chatView.ts)、[src/view/claudeChatView.ts](../src/view/claudeChatView.ts)。

既存テスト:[loopController](../test/unit/loopController.test.ts)、[loopEngineering](../test/unit/loopEngineering.test.ts)、[stallDetector](../test/unit/stallDetector.test.ts)、[turnFocus](../test/unit/turnFocus.test.ts)。

レビュー観点:busy解除とターン確定の違い、過去の合図、キュー・承認・使用量制限・Advisorとの競合。

<a id="f19"></a>

## F19:ゴール下書き・ゴール駆動ループ

- [x] F19.01:一文からゴール・判定条件の下書き生成。
- [x] F19.02:下書きの確認・編集と準備役のprovider/model設定。
- [x] F19.03:コマンド結果・直近応答の根拠収集と評価役への提示。
- [x] F19.04:達成・未達・判定不能に応じた継続と停止。

レビュー結果:[静的レビュー](reviews/f19-goal-draft-evaluation.md)。実装修正・実機検証は未実施。

主な実装:[src/loop/goalDraft.ts](../src/loop/goalDraft.ts)、[src/loop/goalDraftProcess.ts](../src/loop/goalDraftProcess.ts)、[src/loop/goalLoop.ts](../src/loop/goalLoop.ts)、[src/loop/goalPrompt.ts](../src/loop/goalPrompt.ts)、[src/loop/goalEvaluatorProcess.ts](../src/loop/goalEvaluatorProcess.ts)、[src/view/goalDraftFactory.ts](../src/view/goalDraftFactory.ts)、[src/view/goalEvaluatorFactory.ts](../src/view/goalEvaluatorFactory.ts)。

既存テスト:[goalDraft](../test/unit/goalDraft.test.ts)、[goalDraftReply](../test/unit/goalDraftReply.test.ts)、[goalDraftWebview](../test/unit/goalDraftWebview.test.ts)、[goalLoop](../test/unit/goalLoop.test.ts)、[goalPrompt](../test/unit/goalPrompt.test.ts)、[goalEvaluatorProcess](../test/unit/goalEvaluatorProcess.test.ts)。

レビュー観点:下書き中のユーザー編集、根拠範囲、判定不能の連続、補助CLI失敗・timeout。

<a id="f20"></a>

## F20:ループAdvisor・補助CLIの制限

- [x] F20.01:指定ターン間隔でAdvisorがレビュー。
- [x] F20.02:助言を次の作業指示へ反映し会話にも表示。
- [x] F20.03:失敗と判断の食い違いの区別・連続失敗時の扱い。
- [x] F20.04:補助CLIの権限・入出力・時間制限・終了処理。

レビュー結果:[静的レビュー](reviews/f20-advisor-headless.md)。実装修正・実機検証は未実施。

主な実装:[src/loop/loopAdvisor.ts](../src/loop/loopAdvisor.ts)、[src/loop/loopAdvisorProcess.ts](../src/loop/loopAdvisorProcess.ts)、[src/loop/advisorPrompt.ts](../src/loop/advisorPrompt.ts)、[src/loop/headlessCli.ts](../src/loop/headlessCli.ts)、[src/view/loopAdvisorFactory.ts](../src/view/loopAdvisorFactory.ts)。

既存テスト:[loopAdvisor](../test/unit/loopAdvisor.test.ts)、[loopAdvisorDisplay](../test/unit/loopAdvisorDisplay.test.ts)、[headlessCli](../test/unit/headlessCli.test.ts)。

レビュー観点:作業役/評価役/Advisorの判断の優先順位、skills等の露出、親停止後の処理。AdvisorはCodex/Claudeを選択できる。

<a id="f21"></a>

## F21:セカンドオピニオンの資料準備

- [x] F21.01:差分・追加資料・未追跡ファイルの収集。
- [x] F21.02:変更後ツリーとレビュー用bundle作成。
- [x] F21.03:資料の容量配分と秘密情報マスクの適用範囲。
- [x] F21.04:独立した要約セッションからの会話要約。
- [x] F21.05:資料・要約用履歴・古いbundleの後始末。

レビュー結果:[静的レビュー](reviews/f21-second-opinion-material.md)。実装修正・実機検証は未実施。

主な実装:[src/secondOpinion/snapshot.ts](../src/secondOpinion/snapshot.ts)、[src/secondOpinion/reviewBundle.ts](../src/secondOpinion/reviewBundle.ts)、[src/secondOpinion/afterTree.ts](../src/secondOpinion/afterTree.ts)、[src/secondOpinion/untracked.ts](../src/secondOpinion/untracked.ts)、[src/secondOpinion/diffBudget.ts](../src/secondOpinion/diffBudget.ts)、[src/secondOpinion/redact.ts](../src/secondOpinion/redact.ts)、[src/secondOpinion/summary.ts](../src/secondOpinion/summary.ts)、[src/secondOpinion/summaryRollout.ts](../src/secondOpinion/summaryRollout.ts)、[src/view/secondOpinionCommand.ts](../src/view/secondOpinionCommand.ts)。

既存テスト:[secondOpinionReviewBundle](../test/unit/secondOpinionReviewBundle.test.ts)、[secondOpinionAfterTree](../test/unit/secondOpinionAfterTree.test.ts)、[secondOpinionUntracked](../test/unit/secondOpinionUntracked.test.ts)、[secondOpinionDiffBudget](../test/unit/secondOpinionDiffBudget.test.ts)、[redact](../test/unit/redact.test.ts)、[secondOpinionSummary](../test/unit/secondOpinionSummary.test.ts)、[summaryRollout](../test/unit/summaryRollout.test.ts)。

レビュー観点:資料採取中の親の変更、取得時点、欠落、マスク範囲、失敗時の通知。

<a id="f22"></a>

## F22:セカンドオピニオンの実行・継続相談

- [x] F22.01:候補・推論深度・依頼文を選び独立セッション起動。
- [x] F22.02:headless/表示タブ・親の実行終了待ち・取消・timeout・部分結果。
- [x] F22.03:結果を親会話へ表示し設定に応じて自動送信。
- [x] F22.04:継続相談・資料更新・指示案の作成/編集/承認/親への送信。
- [x] F22.05:相談終了・アイドル期限・親終了時の後始末。

レビュー結果:[静的レビュー](reviews/f22-second-opinion-consultation.md)。実装修正・実機検証は未実施。

主な実装:[src/secondOpinion/run.ts](../src/secondOpinion/run.ts)、[src/secondOpinion/advisorSession.ts](../src/secondOpinion/advisorSession.ts)、[src/secondOpinion/candidates.ts](../src/secondOpinion/candidates.ts)、[src/secondOpinion/display.ts](../src/secondOpinion/display.ts)、[src/secondOpinion/handoff.ts](../src/secondOpinion/handoff.ts)、[src/secondOpinion/wait.ts](../src/secondOpinion/wait.ts)、[src/view/secondOpinionCommand.ts](../src/view/secondOpinionCommand.ts)、[src/view/secondOpinionParent.ts](../src/view/secondOpinionParent.ts)。

既存テスト:[secondOpinion](../test/unit/secondOpinion.test.ts)、[secondOpinionContinue](../test/unit/secondOpinionContinue.test.ts)、[secondOpinionQueue](../test/unit/secondOpinionQueue.test.ts)、[secondOpinionTimeout](../test/unit/secondOpinionTimeout.test.ts)、[secondOpinionAutoSend](../test/unit/secondOpinionAutoSend.test.ts)、[secondOpinionHandoff](../test/unit/secondOpinionHandoff.test.ts)、[secondOpinionAdvisorSession](../test/unit/secondOpinionAdvisorSession.test.ts)。

レビュー観点:相談先はCodex固定。二重起動、資料revisionと承認、自動送信と手動承認の経路差、取消後の遅延結果。

<a id="f23"></a>

## F23:進捗画面

- [x] F23.01:会話単位の進捗タブ。
- [x] F23.02:ターン別の指示・応答抜粋・編集ファイル・編集回数・コマンド・TODO変化。
- [x] F23.03:累計ターン数・変更ファイル・実行数・TODO達成状況。
- [x] F23.04:非表示中の更新保留と再表示時の同期・差分送信・全量再取得。

レビュー結果:[静的レビュー](reviews/f23-progress-view.md)。実装修正・実機検証は未実施。

主な実装:[src/view/progressModel.ts](../src/view/progressModel.ts)、[src/view/progressView.ts](../src/view/progressView.ts)、[src/view/progressDelta.ts](../src/view/progressDelta.ts)、[src/view/progressScript.ts](../src/view/progressScript.ts)、[src/view/progressStyles.ts](../src/view/progressStyles.ts)。

既存テスト:[progressModel](../test/unit/progressModel.test.ts)、[progressDelta](../test/unit/progressDelta.test.ts)、[progressStyles](../test/unit/progressStyles.test.ts)。

レビュー観点:長い履歴、繰り返し編集、削除TODO、改名、元会話終了後。TODOはClaude由来。

<a id="f24"></a>

## F24:セッションカンバン

- [x] F24.01:現在のワークスペース内の管理中会話をカード化。
- [x] F24.02:承認待ち・実行中・待機の3列分類。
- [x] F24.03:カードから会話を開き状態変化を反映。

レビュー結果:[静的レビュー](reviews/f24-session-kanban.md)。実装修正・実機検証は未実施。

主な実装:[src/view/sessionKanbanModel.ts](../src/view/sessionKanbanModel.ts)、[src/view/sessionKanbanView.ts](../src/view/sessionKanbanView.ts)、[src/view/sessionActivity.ts](../src/view/sessionActivity.ts)。

既存テスト:[sessionKanbanModel](../test/unit/sessionKanbanModel.test.ts)、[sessionKanbanView](../test/unit/sessionKanbanView.test.ts)。

レビュー観点:履歴全件との対象差、cwd不明・複数ルート・worktree配下、タイトル順、消えた会話。

<a id="f25"></a>

## F25:ワークフロー定義・テンプレート

- [x] F25.01:YAML読込・検証とdefaults/タスク設定の合成。
- [x] F25.02:依存・並列数・隔離・cleanup・役割・反復条件の定義。
- [x] F25.03:他タスクの結果を参照するテンプレート展開。
- [x] F25.04:定義の評価用データとの対応。

レビュー結果:[静的レビュー](reviews/f25-workflow-definition.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/workflow.ts](../src/orchestrator/workflow.ts)、[src/orchestrator/taskConfig.ts](../src/orchestrator/taskConfig.ts)、[src/orchestrator/workflowEvaluation.ts](../src/orchestrator/workflowEvaluation.ts)。

既存テスト:[workflow](../test/unit/workflow.test.ts)、[taskConfig](../test/unit/taskConfig.test.ts)、[workflowWiring](../test/unit/workflowWiring.test.ts)。

レビュー観点:循環依存、未知キー・不正ID、型変換、上限、外部テキストの挿入、権限の強弱。

<a id="f26"></a>

## F26:ゴールからのワークフロー生成

- [x] F26.01:ワークスペース情報とゴールから計画を生成。
- [x] F26.02:計画レビュー・修正と検証結果を利用した再生成。
- [x] F26.03:生成ファイル名の決定・重複回避・保存・実行導線。

レビュー結果:[静的レビュー](reviews/f26-workflow-generation.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/planner.ts](../src/orchestrator/planner.ts)、[src/extension.ts](../src/extension.ts)。

既存テスト:[planner](../test/unit/planner.test.ts)、[workflowMenu](../test/unit/workflowMenu.test.ts)。

レビュー観点:不正応答、レビュー判定、修正回数、出力先、途中取消。生成操作はYAML保存とView表示までで、実行は別操作。

<a id="f27"></a>

## F27:ロードマップ生成・変換・次フェーズ

- [x] F27.01:Issue一覧等からロードマップMarkdown生成。
- [x] F27.02:既存Markdownのロードマップ変換。
- [x] F27.03:フェーズ・Issue・依存の解析・検証。
- [x] F27.04:Issue作成・参照補正と依存を除外した理由の記録。
- [x] F27.05:次フェーズ選択・ワークフロー化・フェーズ分割。

レビュー結果:[静的レビュー](reviews/f27-roadmap.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/roadmap.ts](../src/orchestrator/roadmap.ts)、[src/extension.ts](../src/extension.ts)。

既存テスト:[roadmap](../test/unit/roadmap.test.ts)、[extension.roadmapLogging](../test/unit/extension.roadmapLogging.test.ts)。

レビュー観点:既存/新規Issue、完了済み依存、空フェーズ、出力先、部分失敗。

<a id="f28"></a>

## F28:タスク実行・スケジューリング

- [x] F28.01:依存を満たしたタスクの並列起動と結果取得。
- [x] F28.02:送信・反復・中断・停止・継続・再試行。
- [x] F28.03:完了・失敗・停滞・待機・スキップと依存先への伝播。
- [x] F28.04:要約とオーケストレーターへの報告。

レビュー結果:[静的レビュー](reviews/f28-task-runner.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/runner.ts](../src/orchestrator/runner.ts)、[src/orchestrator/scheduler.ts](../src/orchestrator/scheduler.ts)、[src/orchestrator/runState.ts](../src/orchestrator/runState.ts)、[src/orchestrator/taskSession.ts](../src/orchestrator/taskSession.ts)、[src/orchestrator/taskSummary.ts](../src/orchestrator/taskSummary.ts)、[src/orchestrator/serialQueue.ts](../src/orchestrator/serialQueue.ts)。

既存テスト:[runner](../test/unit/runner.test.ts)、[scheduler](../test/unit/scheduler.test.ts)、[runState](../test/unit/runState.test.ts)、[taskSummary](../test/unit/taskSummary.test.ts)、[serialQueue](../test/unit/serialQueue.test.ts)、[runnerDispose](../test/unit/runnerDispose.test.ts)。

レビュー観点:実行枠解放、非同期完了順、再試行前状態、停止中イベント、複数runの分離。

<a id="f29"></a>

## F29:worktree隔離・ローカル統合・片付け

- [x] F29.01:タスク/統合用worktreeとブランチ作成。
- [x] F29.02:worktree/worktree-strict/sharedと非git環境の疑似worktree。
- [x] F29.03:タスク変更のコミット・統合ブランチへのマージ・競合再試行。
- [x] F29.04:cleanup方針による撤去と統合側の後片付け。

レビュー結果:[静的レビュー](reviews/f29-worktree-integration.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/worktree.ts](../src/orchestrator/worktree.ts)、[src/orchestrator/pseudoWorktree.ts](../src/orchestrator/pseudoWorktree.ts)、[src/orchestrator/integration.ts](../src/orchestrator/integration.ts)、[src/orchestrator/runnerWorkingDirectory.ts](../src/orchestrator/runnerWorkingDirectory.ts)、[src/orchestrator/runnerMerge.ts](../src/orchestrator/runnerMerge.ts)、[src/orchestrator/fsGuards.ts](../src/orchestrator/fsGuards.ts)。

既存テスト:[worktree](../test/unit/worktree.test.ts)、[pseudoWorktree](../test/unit/pseudoWorktree.test.ts)、[integration](../test/unit/integration.test.ts)、[fsGuards](../test/unit/fsGuards.test.ts)。

レビュー観点:既存作業、同時作成、symlink・パストラバーサル、疑似worktree除外・サイズ、未コミット変更と失敗時の残し方。

<a id="f30"></a>

## F30:ワークフロー承認・人への確認

- [x] F30.01:タスク承認設定と拡張設定の合成・上限制限。
- [x] F30.02:承認待ち収集・判定・期限切れ。
- [x] F30.03:人への問い合わせ・回答・回数制限。
- [x] F30.04:最終マージの判断待ち・承認・保留。

レビュー結果:[静的レビュー](reviews/f30-workflow-approval.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/approvalMapping.ts](../src/orchestrator/approvalMapping.ts)、[src/orchestrator/escalation.ts](../src/orchestrator/escalation.ts)、[src/orchestrator/runnerApproval.ts](../src/orchestrator/runnerApproval.ts)、[src/orchestrator/taskConfig.ts](../src/orchestrator/taskConfig.ts)、[src/util/safetyClamp.ts](../src/util/safetyClamp.ts)。

既存テスト:[approvalMapping](../test/unit/approvalMapping.test.ts)、[escalation](../test/unit/escalation.test.ts)、[runnerTaskApproval](../test/unit/runnerTaskApproval.test.ts)、[safetyClamp](../test/unit/safetyClamp.test.ts)。

レビュー観点:設定を緩める経路、権限と通常設定の区別、期限後回答、再開時の再承認。

<a id="f31"></a>

## F31:オーケストレーター・タスク間通信

- [x] F31.01:タスク一覧・メッセージ送受信・オーケストレーターへの質問。
- [x] F31.02:未配信キュー・返答待ち・timeout・全員待機検出。
- [x] F31.03:状態取得・停止/再試行/続行・プロンプト/設定/依存更新・タスク追加/削除。
- [x] F31.04:ask_userと最終マージ判断の制御ツール。
- [x] F31.05:HTTPのMCP接続と接続元ごとの操作制限。

レビュー結果:[静的レビュー](reviews/f31-orchestrator-messaging.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/messaging.ts](../src/orchestrator/messaging.ts)、[src/orchestrator/orchestratorSession.ts](../src/orchestrator/orchestratorSession.ts)、[src/orchestrator/runnerMessaging.ts](../src/orchestrator/runnerMessaging.ts)、[src/orchestrator/runnerOrchestrator.ts](../src/orchestrator/runnerOrchestrator.ts)、[src/orchestrator/untrustedText.ts](../src/orchestrator/untrustedText.ts)。

既存テスト:[messaging](../test/unit/messaging.test.ts)、[orchestratorSession](../test/unit/orchestratorSession.test.ts)、[untrustedText](../test/unit/untrustedText.test.ts)。

レビュー観点:接続元・操作権限、他run混入、配送順、重複応答、外部テキスト。タスクからの送信先はオーケストレーター固定で、タスク同士の直接送信は不可。ツール全名称は別紙。

<a id="f32"></a>

## F32:チームモード・役割・受け渡しファイル

- [x] F32.01:ゴールから役割付きワークフロー生成。
- [x] F32.02:orchestrator/manager/em/architect/designer/implementer/reviewer/tester/writer/researcherの既定モデル・effort。
- [x] F32.03:受け渡しファイルの作成・読込・一覧・削除。
- [x] F32.04:依存先への引き継ぎ情報提示。

レビュー結果:[静的レビュー](reviews/f32-team-handoff.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/rolePresets.ts](../src/orchestrator/rolePresets.ts)、[src/orchestrator/teamHandoff.ts](../src/orchestrator/teamHandoff.ts)、[src/orchestrator/nodeHandoffFileSystem.ts](../src/orchestrator/nodeHandoffFileSystem.ts)、[src/orchestrator/runner.ts](../src/orchestrator/runner.ts)、[src/orchestrator/planner.ts](../src/orchestrator/planner.ts)、[src/extension.ts](../src/extension.ts)。

既存テスト:[rolePresets](../test/unit/rolePresets.test.ts)、[teamHandoff](../test/unit/teamHandoff.test.ts)、[runnerTeamHandoff](../test/unit/runnerTeamHandoff.test.ts)、[nodeHandoffFileSystem](../test/unit/nodeHandoffFileSystem.test.ts)。

レビュー観点:チーム開始コマンドはYAML生成までで実行は別操作。役割と明示指定の優先順位、所有者/run分離、ファイル名・容量・件数、通常メッセージとの違い。

<a id="f33"></a>

## F33:ワークフローのGitHub/GitLab連携

- [x] F33.01:originからホスト判定とgh/glab・認証・前提条件確認。
- [x] F33.02:タスクIssue・push・タスク/統合PR・MR・Draft/ready。
- [x] F33.03:別セッションでのタスクPRレビューとリモートレビューコメントの定期取得。
- [x] F33.04:CI完了待ちとbase更新・再試行。
- [x] F33.05:finalMerge方針に従う統合PR・MRマージ。

レビュー結果:[静的レビュー](reviews/f33-workflow-forge.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/forge.ts](../src/orchestrator/forge.ts)、[src/orchestrator/runnerMerge.ts](../src/orchestrator/runnerMerge.ts)、[src/orchestrator/runnerReviewComments.ts](../src/orchestrator/runnerReviewComments.ts)。

既存テスト:[forge](../test/unit/forge.test.ts)、[runner](../test/unit/runner.test.ts)。

レビュー観点:リモート操作順、CLI失敗、PR番号/ブランチの対応、CIなし・失敗・期限切れ、レビュー結果がマージを止めるかの区別。

<a id="f34"></a>

## F34:プログラムによる複数run統括

- [x] F34.01:複数ワークフローと依存をYAMLで束ねる。
- [x] F34.02:依存のないrunの並列実行と後続への失敗伝播。
- [x] F34.03:全体停止・保存・復元。
- [x] F34.04:失敗時の制御ツールによるrun追加/削除/再試行/依存更新。

レビュー結果:[静的レビュー](reviews/f34-program-runner.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/program.ts](../src/orchestrator/program.ts)、[src/orchestrator/programRunner.ts](../src/orchestrator/programRunner.ts)、[src/orchestrator/programScheduler.ts](../src/orchestrator/programScheduler.ts)、[src/orchestrator/programState.ts](../src/orchestrator/programState.ts)、[src/orchestrator/programStore.ts](../src/orchestrator/programStore.ts)。

既存テスト:[program](../test/unit/program.test.ts)、[programRunner](../test/unit/programRunner.test.ts)、[programScheduler](../test/unit/programScheduler.test.ts)、[programState](../test/unit/programState.test.ts)、[programStore](../test/unit/programStore.test.ts)。

レビュー観点:タスク並列数との二段階制限、循環・未存在定義、手動停止、変更した定義の永続化。

<a id="f35"></a>

## F35:ワークフロー保存・中断後の復元

- [x] F35.01:実行状態の保存と定義・成果・メッセージの復元範囲。
- [x] F35.02:リロード等で中断した実行の検出。
- [x] F35.03:設定・停止理由・承認条件に応じた自動再開。
- [x] F35.04:再開回数上限と手動再試行への引き渡し。

レビュー結果:[静的レビュー](reviews/f35-run-restore.md)。実装修正・実機検証は未実施。

主な実装:[src/orchestrator/runStore.ts](../src/orchestrator/runStore.ts)、[src/orchestrator/runnerRestore.ts](../src/orchestrator/runnerRestore.ts)、[src/orchestrator/runnerSnapshot.ts](../src/orchestrator/runnerSnapshot.ts)、[src/orchestrator/programStore.ts](../src/orchestrator/programStore.ts)。

既存テスト:[runStore](../test/unit/runStore.test.ts)、[runner](../test/unit/runner.test.ts)、[programStore](../test/unit/programStore.test.ts)。

レビュー観点:途中書込、破損・旧形式、残存worktree/セッション、二重再開、明示停止の尊重。

<a id="f36"></a>

## F36:ワークフロー画面・メニュー

- [x] F36.01:履歴・プログラム・タスクカード・依存グラフ表示。
- [x] F36.02:実行切り替えと定義/会話/PRを開く操作。
- [x] F36.03:全体停止・タスク中断/停止/再試行/継続/マージ再試行。
- [x] F36.04:承認回答・オーケストレーター会話・最終マージ判断。
- [x] F36.05:worktree撤去と統合cleanup操作。

レビュー結果:[静的レビュー](reviews/f36-workflow-view.md)。実装修正・実機検証は未実施。

主な実装:[src/view/workflowView.ts](../src/view/workflowView.ts)、[src/view/workflowScript.ts](../src/view/workflowScript.ts)、[src/view/workflowStyles.ts](../src/view/workflowStyles.ts)、[src/view/workflowGraph.ts](../src/view/workflowGraph.ts)、[src/view/workflowMenu.ts](../src/view/workflowMenu.ts)。

既存テスト:[workflowViewGraph](../test/unit/workflowViewGraph.test.ts)、[workflowViewPrograms](../test/unit/workflowViewPrograms.test.ts)、[workflowGraph](../test/unit/workflowGraph.test.ts)、[workflowMenu](../test/unit/workflowMenu.test.ts)。

レビュー観点:幅変化、状態と有効ボタンの一致、古いrunへの操作、画面再接続、重要な警告の表示。

<a id="f37"></a>

## F37:Forge HubのIssue起点の開発

- [x] F37.01:GitHub/GitLab接続診断とホスト選択。
- [x] F37.02:概要・実装計画・確認点を含むIssue作成。
- [x] F37.03:Issue一覧・計画コメント投稿・計画済み追跡。
- [x] F37.04:Issue用worktreeと担当会話の開始。
- [x] F37.05:Hubのオーケストレーターへの相談・中断・承認と担当会話を開く操作。

レビュー結果:[静的レビュー](reviews/f37-forge-hub-issues.md)。実装修正・実機検証は未実施。

主な実装:[src/forge/hub.ts](../src/forge/hub.ts)、[src/forge/orchestrator.ts](../src/forge/orchestrator.ts)、[src/view/forgeHubView.ts](../src/view/forgeHubView.ts)。

既存テスト:[forgeHub](../test/unit/forgeHub.test.ts)、[forgeOrchestrator](../test/unit/forgeOrchestrator.test.ts)。

レビュー観点:Issue/cwd/provider対応、重複着手、起票と着手の部分失敗、計画済み状態の保存。

<a id="f38"></a>

## F38:Forge HubのPR・CI・レビュー・完了記録

- [x] F38.01:開発カード保存と担当会話の状態反映。
- [x] F38.02:Draft PR・MR作成とCI/レビュー/PR状態再取得。
- [x] F38.03:レビューthreadへの返信・解決。
- [x] F38.04:状態に応じた次の操作案内と作業会話への依頼。
- [x] F38.05:マージ済みカードのcleanup完了確認と追跡解除。

レビュー結果:[静的レビュー](reviews/f38-forge-hub-review.md)。実装修正・実機検証は未実施。

主な実装:[src/forge/hub.ts](../src/forge/hub.ts)、[src/view/forgeHubView.ts](../src/view/forgeHubView.ts)、[src/forge/orchestrator.ts](../src/forge/orchestrator.ts)。

既存テスト:[forgeHub](../test/unit/forgeHub.test.ts)、[forgeOrchestrator](../test/unit/forgeOrchestrator.test.ts)。

レビュー観点:リモート更新競合、PR差替え、消したカードの復活、merged状態保持。完了記録ボタン自体はIssue closeやbranch/worktree削除を実行しない。

<a id="f39"></a>

## F39:作業記録・診断ログ

- [x] F39.01:発言・ターン成果の日別バッファ追記。
- [x] F39.02:要約・編集ファイル・時刻・cwd・セッションIDの記録。
- [x] F39.03:出力先の設定/環境変数/既定値による解決。
- [x] F39.04:拡張の出力ログとエラーからログへの案内。
- [x] F39.05:Claudeのdebugコマンド・ログ閲覧。

レビュー結果:[静的レビュー](reviews/f39-activity-logs.md)。実装修正・実機検証は未実施。

主な実装:[src/activity/activityLogger.ts](../src/activity/activityLogger.ts)、[src/activity/record.ts](../src/activity/record.ts)、[src/activity/nodeAppender.ts](../src/activity/nodeAppender.ts)、[src/log.ts](../src/log.ts)、[src/orchestrator/sanitize.ts](../src/orchestrator/sanitize.ts)、[src/view/claudeChatView.ts](../src/view/claudeChatView.ts)。

既存テスト:[activityLogger](../test/unit/activityLogger.test.ts)、[activityRecord](../test/unit/activityRecord.test.ts)、[log](../test/unit/log.test.ts)、[sanitize](../test/unit/sanitize.test.ts)、[claudeStreamSessionDebug](../test/unit/claudeStreamSessionDebug.test.ts)。

レビュー観点:記録対象外セッション、空応答、書込失敗、機密情報、日付境界。manifestの頻度説明との差は末尾に記録。

<a id="f40"></a>

## F40:開発・配布・評価基盤

- [x] F40.01:拡張ビルド・VSIX作成・配布対象ファイル。
- [x] F40.02:単体・VSCode統合・外部CLIの検証導線と隔離fixture。
- [x] F40.03:CI・静的検査・手動テスト手順。
- [x] F40.04:進捗ベンチマークとセカンドオピニオン評価の抽出・採点・集計。

レビュー結果:[静的レビュー](reviews/f40-build-evaluation.md)。実装修正・実機検証は未実施。

主な実装:[package.json](../package.json)、[scripts/check.sh](../scripts/check.sh)、[scripts/run-external-cli-tests.mjs](../scripts/run-external-cli-tests.mjs)、[.github/workflows/ci.yml](../.github/workflows/ci.yml)、[vitest.config.ts](../vitest.config.ts)、[.vscode-test.mjs](../.vscode-test.mjs)、[docs/integration-testing.md](../docs/integration-testing.md)、[docs/second-opinion-eval.md](../docs/second-opinion-eval.md)。

既存テスト:[integrationFixtureGuards](../test/unit/integrationFixtureGuards.test.ts)、[integrationFixturesRoot](../test/unit/integrationFixturesRoot.test.ts)、[eslintConfig](../test/unit/eslintConfig.test.ts)。

レビュー観点:製品機能との分離、実環境依存、fixture隔離、生成物・秘密情報の配布混入。今回は実行しない。

## 記述差・対応範囲として残す点

| 対象                              | 静的調査で確認した差・制約                                                                                                                                                                   | レビュー先      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Codexの巻き戻し                   | READMEの対応表は未対応としているが、`ChatViewManager.editAndResend`と`FileRewindJournal`には編集再送時のファイル復元がある。直接編集とコマンド実行による変更の範囲を分けて説明を再確認する。 | F09             |
| 日報バッファの頻度                | `package.json`の`agent.activityLog.enabled`説明は「セッションごとに1行」だが、`ActivityLogger.record`の呼出経路は発言・成果ごとの追記を扱う。頻度と記録内容の説明を合わせる必要がある。      | F39             |
| Claudeのセッション全体fork        | `ClaudeChatViewManager.openFork`は、新しいIDを追跡できないためタブ復元と作業記録の対象外になる旨を会話へ表示する。通常の再開や途中分岐と一括して保証しない。                                 | F03/F39         |
| Claudeの途中分岐の宣言            | `ClaudeProvider.capabilities.forkFromTurn`はfalseだが、チャットには`forkFromTurn`と`rewindConversationToTurn`の経路がある。能力フラグだけで画面の対応可否を判定しない。                      | F03             |
| Forge Hubのcleanup完了            | `completeCleanup`はマージ済みカードを追跡から外す処理。Issue close・branch/worktree削除はこのボタン自体では行わない。                                                                        | F38             |
| セカンドオピニオンとループAdvisor | 前者の相談先はCodex固定。後者はCodex/Claudeを選べる。相談結果の自動送信と、指示案を承認して送る経路も分けて確認する。                                                                        | F20/F22         |
| 各管理画面の対象                  | 進捗は会話内の経過、カンバンは管理中会話、ワークフローはrun/task、Forge HubはIssue起点の開発カードを扱う。各画面の母集団は異なる。                                                           | F23/F24/F36/F37 |

これらはコード不具合を断定した一覧ではない。レビュー時に仕様・表示・実装の整合性を確認するための記録。

## レビュー結果の記録欄

| 対象ID   | 参照commit                               | 結果・指摘へのリンク                               | 実行した確認                                        | 未確認・制約                                                                                   |
| -------- | ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F01〜F40 | efd5cd67eb6a9b0a957538c9b5f981e2969875b6 | [全体結果](reviews/summary.md)、各節のレビュー結果 | 176項目の静的レビュー、資料の対応・リンク・差分確認 | 指摘は未修正。テスト・型チェック・lint・実機検証は未実施。途中分岐の実際のエラー原因は未確定。 |
