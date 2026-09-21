# 機能調査の全件対応表

[機能別レビュー台帳](feature-inventory.md)の補助索引。対象commitと調査範囲は台帳に記載。F番号はレビューの入口であり、ファイル全体をレビュー済みと示すものではない。共通ファイルは複数機能から参照する。

静的抽出した母集団は`src/`の242ファイル、公開コマンド45件、設定84件。全件をF番号へ割り当てた。

[全機能の静的レビュー結果](reviews/summary.md)に完了範囲・指摘件数・優先対応をまとめた。

## 公開コマンド

出典:[package.json](../package.json)の`contributes.commands`。登録先は[src/extension.ts](../src/extension.ts)。パレット非表示のコマンドも含む。

| コマンドID                       | 表示名                                      | レビュー先                      |
| -------------------------------- | ------------------------------------------- | ------------------------------- |
| `codex.openSession`              | セッションを開く                            | [F03](feature-inventory.md#f03) |
| `codex.resumeSession`            | セッションを再開…                           | [F03](feature-inventory.md#f03) |
| `codex.resumeLast`               | 直前のセッションを再開                      | [F03](feature-inventory.md#f03) |
| `codex.refreshSessions`          | 更新                                        | [F02](feature-inventory.md#f02) |
| `codex.showAllSessions`          | 全ワークスペースを表示                      | [F02](feature-inventory.md#f02) |
| `codex.showWorkspaceSessions`    | このワークスペースのみ表示                  | [F02](feature-inventory.md#f02) |
| `codex.filterSessions`           | 履歴を絞り込む…                             | [F02](feature-inventory.md#f02) |
| `codex.clearSessionFilter`       | 絞り込みを解除                              | [F02](feature-inventory.md#f02) |
| `codex.pinSession`               | ピン留めする                                | [F02](feature-inventory.md#f02) |
| `codex.unpinSession`             | ピン留めを外す                              | [F02](feature-inventory.md#f02) |
| `codex.newChat`                  | 新しい会話（Codex）                         | [F03](feature-inventory.md#f03) |
| `agent.openProgress`             | 進捗を表示                                  | [F23](feature-inventory.md#f23) |
| `codex.handoffToNewSession`      | 新セッションへ引き継ぐ（Codex）             | [F13](feature-inventory.md#f13) |
| `agent.openPresetChat`           | プリセットから新しい会話を開く…             | [F04](feature-inventory.md#f04) |
| `codex.clearChat`                | 会話をクリアして新しく始める（Codex）       | [F03](feature-inventory.md#f03) |
| `claude.clearChat`               | 会話をクリアして新しく始める（Claude Code） | [F03](feature-inventory.md#f03) |
| `codex.renameChat`               | セッション名を変更                          | [F03](feature-inventory.md#f03) |
| `codex.openChat`                 | チャット画面で開く（Codex）                 | [F03](feature-inventory.md#f03) |
| `codex.openConversation`         | 会話を開いて分岐する                        | [F03](feature-inventory.md#f03) |
| `codex.forkSession`              | このセッションをforkする                    | [F03](feature-inventory.md#f03) |
| `codex.archiveSession`           | アーカイブする                              | [F02](feature-inventory.md#f02) |
| `codex.unarchiveSession`         | アーカイブを解除する                        | [F02](feature-inventory.md#f02) |
| `codex.deleteSession`            | 削除する                                    | [F02](feature-inventory.md#f02) |
| `codex.showUsage`                | 使用量を表示                                | [F11](feature-inventory.md#f11) |
| `codex.showApprovalPending`      | 承認待ちの会話を開く                        | [F12](feature-inventory.md#f12) |
| `codex.showLog`                  | ログを表示                                  | [F39](feature-inventory.md#f39) |
| `claude.newChat`                 | 新しい会話（Claude Code）                   | [F03](feature-inventory.md#f03) |
| `claude.handoffToNewSession`     | 新セッションへ引き継ぐ（Claude Code）       | [F13](feature-inventory.md#f13) |
| `claude.openChat`                | チャット画面で開く（Claude Code）           | [F03](feature-inventory.md#f03) |
| `claude.forkSession`             | このセッションをforkする（Claude Code）     | [F03](feature-inventory.md#f03) |
| `claude.reloadSkills`            | skillsを読み直す（Claude Code）             | [F17](feature-inventory.md#f17) |
| `claude.renameChat`              | セッション名を変更（Claude Code）           | [F03](feature-inventory.md#f03) |
| `agent.workflows.menu`           | ワークフロー…                               | [F36](feature-inventory.md#f36) |
| `agent.sessionKanban`            | セッションカンバンを開く                    | [F24](feature-inventory.md#f24) |
| `agent.forgeHub`                 | Forge Hubを開く                             | [F37](feature-inventory.md#f37) |
| `agent.workflows.run`            | ワークフローを実行…                         | [F28](feature-inventory.md#f28) |
| `agent.workflows.runProgram`     | プログラムを実行…                           | [F34](feature-inventory.md#f34) |
| `agent.workflows.stop`           | ワークフローを停止…                         | [F28](feature-inventory.md#f28) |
| `agent.workflows.stopProgram`    | プログラムを停止…                           | [F34](feature-inventory.md#f34) |
| `agent.workflows.roadmap`        | ロードマップを生成…                         | [F27](feature-inventory.md#f27) |
| `agent.workflows.convertRoadmap` | ファイルからロードマップを作成…             | [F27](feature-inventory.md#f27) |
| `agent.workflows.view`           | ワークフローViewを開く                      | [F36](feature-inventory.md#f36) |
| `agent.workflows.plan`           | ゴール文からワークフローを生成…             | [F26](feature-inventory.md#f26) |
| `agent.workflows.team`           | チームモードでワークフローを生成…           | [F32](feature-inventory.md#f32) |
| `agent.sendSelectionToChat`      | Agentへ送る                                 | [F05](feature-inventory.md#f05) |

## ビュー・キーバインド

| 入口                                              | 内容                                 | レビュー先                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex.controlPanel`                              | Activity Barの設定Webview            | [F04](feature-inventory.md#f04)、[F15](feature-inventory.md#f15)、[F16](feature-inventory.md#f16)、[F17](feature-inventory.md#f17)                                  |
| `codex.sessions`                                  | Activity Barの履歴TreeView           | [F02](feature-inventory.md#f02)、[F12](feature-inventory.md#f12)                                                                                                    |
| `codex.chat` / `claude.chat`                      | 会話タブ。serializerで復元           | [F03](feature-inventory.md#f03)、[F08](feature-inventory.md#f08)                                                                                                    |
| 会話閲覧・進捗・カンバン・ワークフロー・Forge Hub | コマンドや会話のボタンから開く別画面 | [F03](feature-inventory.md#f03)、[F23](feature-inventory.md#f23)、[F24](feature-inventory.md#f24)、[F36](feature-inventory.md#f36)、[F37](feature-inventory.md#f37) |

| キー       | macOS     | コマンド               | 有効条件                        |
| ---------- | --------- | ---------------------- | ------------------------------- |
| `ctrl+k x` | `cmd+k x` | `codex.newChat`        | `!terminalFocus && !inputFocus` |
| `ctrl+k l` | `cmd+k l` | `claude.newChat`       | `!terminalFocus && !inputFocus` |
| `ctrl+k b` | `cmd+k b` | `codex.resumeLast`     | `!terminalFocus && !inputFocus` |
| `ctrl+k a` | `cmd+k a` | `agent.workflows.view` | `!terminalFocus && !inputFocus` |

## 設定の全キー

出典:[package.json](../package.json)の`contributes.configuration.properties`。値の検証・合成は[src/config.ts](../src/config.ts)と各機能の実装を参照。長い指示文と構造化既定値は省略表示し、原文への参照を残す。スコープ未指定はmanifest上の省略として記載する。

| 設定キー                                         | 既定値                                                                                                           | scope                 | レビュー先                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------- |
| `codex.executablePath`                           | `"codex"`                                                                                                        | `machine`             | [F01](feature-inventory.md#f01) |
| `codex.codexHome`                                | `""`                                                                                                             | `machine`             | [F01](feature-inventory.md#f01) |
| `codex.additionalArgs`                           | `[]`                                                                                                             | `machine`             | [F01](feature-inventory.md#f01) |
| `codex.sandbox`                                  | `""`                                                                                                             | `machine`             | [F10](feature-inventory.md#f10) |
| `codex.sandboxWritableRoots`                     | `[]`                                                                                                             | `machine`             | [F10](feature-inventory.md#f10) |
| `codex.sandboxNetworkAccess`                     | `false`                                                                                                          | `machine`             | [F10](feature-inventory.md#f10) |
| `codex.approvalMode`                             | `""`                                                                                                             | `machine`             | [F10](feature-inventory.md#f10) |
| `codex.approvalsReviewer`                        | `""`                                                                                                             | `machine`             | [F10](feature-inventory.md#f10) |
| `codex.bypassApprovalsAndSandbox`                | `false`                                                                                                          | `machine`             | [F10](feature-inventory.md#f10) |
| `codex.model`                                    | `""`                                                                                                             | `machine-overridable` | [F04](feature-inventory.md#f04) |
| `codex.reasoningEffort`                          | `""`                                                                                                             | `machine-overridable` | [F04](feature-inventory.md#f04) |
| `codex.profile`                                  | `""`                                                                                                             | `machine-overridable` | [F04](feature-inventory.md#f04) |
| `codex.usage.statusBarGauge`                     | `true`                                                                                                           | `window`              | [F11](feature-inventory.md#f11) |
| `codex.history.scope`                            | `"workspace"`                                                                                                    | `window`              | [F02](feature-inventory.md#f02) |
| `codex.history.maxEntries`                       | `200`                                                                                                            | `window`              | [F02](feature-inventory.md#f02) |
| `codex.history.groupBy`                          | `"date"`                                                                                                         | `window`              | [F02](feature-inventory.md#f02) |
| `agent.activityLog.enabled`                      | `true`                                                                                                           | `window`              | [F39](feature-inventory.md#f39) |
| `agent.activityLog.dir`                          | `""`                                                                                                             | `machine`             | [F39](feature-inventory.md#f39) |
| `agent.chat.renderMarkdown`                      | `true`                                                                                                           | `window`              | [F08](feature-inventory.md#f08) |
| `agent.chat.density`                             | `"comfortable"`                                                                                                  | `window`              | [F08](feature-inventory.md#f08) |
| `agent.chat.sendOn`                              | `"ctrlEnter"`                                                                                                    | `window`              | [F05](feature-inventory.md#f05) |
| `agent.chat.composerButtons`                     | `["attach","loopToggle","compact","recap","planToggle","handoffToNewSession","secondOpinion"]`                   | `window`              | [F08](feature-inventory.md#f08) |
| `agent.chat.limitAutoResume.enabled`             | `true`                                                                                                           | `window`              | [F11](feature-inventory.md#f11) |
| `agent.secondOpinion.candidates`                 | `[{"name":"Sol (high)","model":"gpt-5.6-sol","effort":"high"}]`                                                  | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.summary`                    | `{"enabled":true,"model":"gpt-5.6-luna","effort":"low"}`                                                         | `window`              | [F21](feature-inventory.md#f21) |
| `agent.secondOpinion.headless`                   | `true`                                                                                                           | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.timeoutMs`                  | `900000`                                                                                                         | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.template`                   | `"この変更をレビューしてください。特に設計上の欠陥、見落とし、より単純な代替案を挙げてください。"`               | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.autoSend`                   | `true`                                                                                                           | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.afterTree`                  | `true`                                                                                                           | `window`              | [F21](feature-inventory.md#f21) |
| `agent.secondOpinion.diffIndex.enabled`          | `true`                                                                                                           | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.diffIndex.inlineMaxTokens`  | `8000`                                                                                                           | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.diffIndex.hunkMaxTokens`    | `20000`                                                                                                          | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.advisor.enabled`            | `true`                                                                                                           | `window`              | [F22](feature-inventory.md#f22) |
| `agent.secondOpinion.advisor.idleTimeoutMs`      | `1800000`                                                                                                        | `window`              | [F22](feature-inventory.md#f22) |
| `agent.chat.turnSummary.enabled`                 | `false`                                                                                                          | `window`              | [F13](feature-inventory.md#f13) |
| `agent.chat.turnSummary.instruction`             | `"最後に次の3点を必ず示すこと。1) 今回受け取った指示、2) この会話で実施した内容の要約、3) 次の推奨アクション。"` | `window`              | [F13](feature-inventory.md#f13) |
| `agent.chat.loopEngineering.enabled`             | `false`                                                                                                          | `window`              | [F18](feature-inventory.md#f18) |
| `agent.chat.loopEngineering.initialInstruction`  | `構造化値/長文（package.json参照）`                                                                              | `window`              | [F18](feature-inventory.md#f18) |
| `agent.chat.loopEngineering.continueInstruction` | `構造化値/長文（package.json参照）`                                                                              | `window`              | [F18](feature-inventory.md#f18) |
| `agent.chat.goalEvaluator.provider`              | `"inherit"`                                                                                                      | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.goalEvaluator.model`                 | `"auto"`                                                                                                         | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.goalEvaluator.timeoutSeconds`        | `120`                                                                                                            | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.goalEvaluator.maxIndeterminate`      | `3`                                                                                                              | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.loop.autoGoal.enabled`               | `true`                                                                                                           | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.loop.autoGoal.confirm`               | `true`                                                                                                           | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.loop.autoGoal.provider`              | `"inherit"`                                                                                                      | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.loop.autoGoal.model`                 | `"auto"`                                                                                                         | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.loop.autoGoal.timeoutSeconds`        | `120`                                                                                                            | `window`              | [F19](feature-inventory.md#f19) |
| `agent.chat.loopAdvisor.enabled`                 | `false`                                                                                                          | `window`              | [F20](feature-inventory.md#f20) |
| `agent.chat.loopAdvisor.provider`                | `"codex"`                                                                                                        | `window`              | [F20](feature-inventory.md#f20) |
| `agent.chat.loopAdvisor.model`                   | `"auto"`                                                                                                         | `window`              | [F20](feature-inventory.md#f20) |
| `agent.chat.loopAdvisor.timeoutSeconds`          | `120`                                                                                                            | `window`              | [F20](feature-inventory.md#f20) |
| `agent.chat.loopAdvisor.everyNTurns`             | `1`                                                                                                              | `window`              | [F20](feature-inventory.md#f20) |
| `agent.notifications.approvalPending`            | `true`                                                                                                           | `window`              | [F12](feature-inventory.md#f12) |
| `agent.notifications.turnComplete`               | `false`                                                                                                          | `window`              | [F12](feature-inventory.md#f12) |
| `agent.sessionPresets`                           | `[]`                                                                                                             | `resource`            | [F04](feature-inventory.md#f04) |
| `agent.workflows.dir`                            | `".agents/workflows"`                                                                                            | `resource`            | [F25](feature-inventory.md#f25) |
| `agent.workflows.allowAutoApprove`               | `false`                                                                                                          | `machine`             | [F30](feature-inventory.md#f30) |
| `agent.workflows.allowClaudeBypassPermissions`   | `false`                                                                                                          | `machine`             | [F30](feature-inventory.md#f30) |
| `agent.workflows.replyTimeoutSec`                | `300`                                                                                                            | `machine-overridable` | [F31](feature-inventory.md#f31) |
| `agent.workflows.mergeApprovalTimeoutSec`        | `3600`                                                                                                           | `machine-overridable` | [F30](feature-inventory.md#f30) |
| `agent.workflows.taskApprovalTimeoutSec`         | `3600`                                                                                                           | `machine-overridable` | [F30](feature-inventory.md#f30) |
| `agent.workflows.finalMergeDecisionTimeoutSec`   | `900`                                                                                                            | `machine-overridable` | [F30](feature-inventory.md#f30) |
| `agent.workflows.ciWaitTimeoutSec`               | `1800`                                                                                                           | `machine-overridable` | [F33](feature-inventory.md#f33) |
| `agent.workflows.ciUpdateBranchMaxRetries`       | `2`                                                                                                              | `machine-overridable` | [F33](feature-inventory.md#f33) |
| `agent.workflows.reviewCommentPollIntervalSec`   | `600`                                                                                                            | `machine-overridable` | [F33](feature-inventory.md#f33) |
| `agent.workflows.roadmapDir`                     | `"docs/roadmap"`                                                                                                 | `machine-overridable` | [F27](feature-inventory.md#f27) |
| `agent.workflows.pseudoWorktreeExclude`          | `["node_modules",".venv","dist","out"]`                                                                          | `machine-overridable` | [F29](feature-inventory.md#f29) |
| `agent.workflows.forge`                          | `"auto"`                                                                                                         | `machine`             | [F33](feature-inventory.md#f33) |
| `agent.workflows.pullRequest`                    | `"per-task"`                                                                                                     | `machine-overridable` | [F33](feature-inventory.md#f33) |
| `agent.workflows.finalMerge`                     | `"orchestrator"`                                                                                                 | `machine`             | [F33](feature-inventory.md#f33) |
| `agent.workflows.branchNaming`                   | `"wf"`                                                                                                           | `machine-overridable` | [F29](feature-inventory.md#f29) |
| `agent.workflows.draftPullRequest`               | `false`                                                                                                          | `machine-overridable` | [F33](feature-inventory.md#f33) |
| `agent.workflows.createTaskIssue`                | `false`                                                                                                          | `machine-overridable` | [F33](feature-inventory.md#f33) |
| `agent.workflows.reviewTaskPullRequest`          | `false`                                                                                                          | `machine-overridable` | [F33](feature-inventory.md#f33) |
| `agent.workflows.stallRepeatCount`               | `4`                                                                                                              | `machine-overridable` | [F28](feature-inventory.md#f28) |
| `agent.workflows.maxAskUserPerRun`               | `3`                                                                                                              | `machine-overridable` | [F30](feature-inventory.md#f30) |
| `agent.workflows.autoResume`                     | `true`                                                                                                           | `machine-overridable` | [F35](feature-inventory.md#f35) |
| `agent.workflows.maxAutoResumeAttempts`          | `3`                                                                                                              | `machine-overridable` | [F35](feature-inventory.md#f35) |
| `claude.executablePath`                          | `"claude"`                                                                                                       | `machine`             | [F01](feature-inventory.md#f01) |
| `claude.configDir`                               | `""`                                                                                                             | `machine`             | [F01](feature-inventory.md#f01) |
| `claude.additionalArgs`                          | `[]`                                                                                                             | `machine`             | [F01](feature-inventory.md#f01) |
| `claude.permissionMode`                          | `""`                                                                                                             | `machine`             | [F10](feature-inventory.md#f10) |
| `claude.model`                                   | `"opus"`                                                                                                         | `machine-overridable` | [F04](feature-inventory.md#f04) |
| `claude.effort`                                  | `"medium"`                                                                                                       | `machine-overridable` | [F04](feature-inventory.md#f04) |
| `claude.agent`                                   | `""`                                                                                                             | `machine-overridable` | [F04](feature-inventory.md#f04) |

## 入力欄ボタンと特殊入力

出典:[composerButtons.ts](../src/view/composerButtons.ts)、[pseudoCommands.ts](../src/provider/pseudoCommands.ts)、[inputModes.ts](../src/provider/inputModes.ts)。ボタンIDの存在と表示可否は別で、プロバイダ・CLI能力・実行状態により表示が変わる。

| ボタンID              | レビュー先                      |
| --------------------- | ------------------------------- |
| `attach`              | [F06](feature-inventory.md#f06) |
| `loopToggle`          | [F18](feature-inventory.md#f18) |
| `compact`             | [F13](feature-inventory.md#f13) |
| `claudeImport`        | [F17](feature-inventory.md#f17) |
| `recap`               | [F13](feature-inventory.md#f13) |
| `planToggle`          | [F13](feature-inventory.md#f13) |
| `fastToggle`          | [F13](feature-inventory.md#f13) |
| `review`              | [F13](feature-inventory.md#f13) |
| `exportTranscript`    | [F13](feature-inventory.md#f13) |
| `workflowMenu`        | [F36](feature-inventory.md#f36) |
| `teamWorkflow`        | [F32](feature-inventory.md#f32) |
| `workflowView`        | [F36](feature-inventory.md#f36) |
| `sessionKanban`       | [F24](feature-inventory.md#f24) |
| `forgeHub`            | [F37](feature-inventory.md#f37) |
| `openProgress`        | [F23](feature-inventory.md#f23) |
| `handoffToNewSession` | [F13](feature-inventory.md#f13) |
| `secondOpinion`       | [F22](feature-inventory.md#f22) |

| 入力                | 対象・処理                                                    | レビュー先                                                       |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/compact`、`/init` | Codexの擬似コマンド。圧縮/AGENTS.md生成指示                   | [F07](feature-inventory.md#f07)、[F13](feature-inventory.md#f13) |
| `/btw`              | 両プロバイダの独立した脇道質問                                | [F07](feature-inventory.md#f07)、[F14](feature-inventory.md#f14) |
| `/...`              | Codexのskills/プロンプト、ClaudeのCLI由来候補・フォールバック | [F07](feature-inventory.md#f07)、[F17](feature-inventory.md#f17) |
| `@...`              | ファイル候補・参照                                            | [F06](feature-inventory.md#f06)                                  |
| `!`、`#`            | Claudeの単一行入力。ターミナル/メモリ追記                     | [F07](feature-inventory.md#f07)                                  |

## ワークフローMCPツール

出典:[messaging.ts](../src/orchestrator/messaging.ts)。宣言されたツールを抽出した。実際に呼べる範囲は接続元がタスク/オーケストレーターか、program配下か、実行状態等で異なる。`send_message`のタスク側の宛先はオーケストレーター固定。

| ツール名                   | 宣言                                   | レビュー先                      |
| -------------------------- | -------------------------------------- | ------------------------------- |
| `list_tasks`               | `LIST_TASKS_TOOL`                      | [F31](feature-inventory.md#f31) |
| `send_message`             | `SEND_MESSAGE_TOOL`                    | [F31](feature-inventory.md#f31) |
| `ask_orchestrator`         | `ASK_ORCHESTRATOR_TOOL`                | [F31](feature-inventory.md#f31) |
| `get_run_status`           | `GET_RUN_STATUS_TOOL`                  | [F31](feature-inventory.md#f31) |
| `stop_task`                | `STOP_TASK_TOOL`                       | [F31](feature-inventory.md#f31) |
| `retry_task`               | `RETRY_TASK_TOOL`                      | [F31](feature-inventory.md#f31) |
| `continue_task`            | `CONTINUE_TASK_TOOL`                   | [F31](feature-inventory.md#f31) |
| `decide_approval`          | `DECIDE_APPROVAL_TOOL`                 | [F30](feature-inventory.md#f30) |
| `update_task_prompt`       | `UPDATE_TASK_PROMPT_TOOL`              | [F31](feature-inventory.md#f31) |
| `update_task`              | `UPDATE_TASK_TOOL`                     | [F31](feature-inventory.md#f31) |
| `ask_user`                 | `ASK_USER_TOOL`                        | [F30](feature-inventory.md#f30) |
| `decide_final_merge`       | `DECIDE_FINAL_MERGE_TOOL`              | [F30](feature-inventory.md#f30) |
| `add_task`                 | `ADD_TASK_TOOL`                        | [F31](feature-inventory.md#f31) |
| `remove_task`              | `REMOVE_TASK_TOOL`                     | [F31](feature-inventory.md#f31) |
| `update_task_dependencies` | `UPDATE_TASK_DEPENDENCIES_TOOL`        | [F31](feature-inventory.md#f31) |
| `get_program_status`       | `GET_PROGRAM_STATUS_TOOL`              | [F34](feature-inventory.md#f34) |
| `add_run`                  | `ADD_PROGRAM_RUN_TOOL`                 | [F34](feature-inventory.md#f34) |
| `remove_run`               | `REMOVE_PROGRAM_RUN_TOOL`              | [F34](feature-inventory.md#f34) |
| `retry_run`                | `RETRY_PROGRAM_RUN_TOOL`               | [F34](feature-inventory.md#f34) |
| `update_run_dependencies`  | `UPDATE_PROGRAM_RUN_DEPENDENCIES_TOOL` | [F34](feature-inventory.md#f34) |
| `write_handoff`            | `WRITE_HANDOFF_TOOL`                   | [F32](feature-inventory.md#f32) |
| `read_handoff`             | `READ_HANDOFF_TOOL`                    | [F32](feature-inventory.md#f32) |
| `list_handoffs`            | `LIST_HANDOFFS_TOOL`                   | [F32](feature-inventory.md#f32) |
| `delete_handoff`           | `DELETE_HANDOFF_TOOL`                  | [F32](feature-inventory.md#f32) |

## 全ソースファイル

`src/`配下を全列挙し、主なレビュー先を割り当てた。型・共通ヘルパーは利用機能のレビュー時にも確認する。F番号の主な実装リンクにない補助ファイルもここに含む。

| ファイル                                                                                    | レビュー先                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/activity/activityLogger.ts](../src/activity/activityLogger.ts)                         | [F39](feature-inventory.md#f39)                                                                                                                                     |
| [src/activity/nodeAppender.ts](../src/activity/nodeAppender.ts)                             | [F39](feature-inventory.md#f39)                                                                                                                                     |
| [src/activity/record.ts](../src/activity/record.ts)                                         | [F39](feature-inventory.md#f39)                                                                                                                                     |
| [src/appserver/approvals.ts](../src/appserver/approvals.ts)                                 | [F10](feature-inventory.md#f10)                                                                                                                                     |
| [src/appserver/autoApprovalReview.ts](../src/appserver/autoApprovalReview.ts)               | [F10](feature-inventory.md#f10)                                                                                                                                     |
| [src/appserver/chatSession.ts](../src/appserver/chatSession.ts)                             | [F05](feature-inventory.md#f05)、[F13](feature-inventory.md#f13)                                                                                                    |
| [src/appserver/chatState.ts](../src/appserver/chatState.ts)                                 | [F08](feature-inventory.md#f08)、[F14](feature-inventory.md#f14)                                                                                                    |
| [src/appserver/connection.ts](../src/appserver/connection.ts)                               | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/appserver/fileRewind.ts](../src/appserver/fileRewind.ts)                               | [F09](feature-inventory.md#f09)                                                                                                                                     |
| [src/appserver/planMode.ts](../src/appserver/planMode.ts)                                   | [F13](feature-inventory.md#f13)                                                                                                                                     |
| [src/appserver/prompts.ts](../src/appserver/prompts.ts)                                     | [F10](feature-inventory.md#f10)                                                                                                                                     |
| [src/appserver/transcriptMarkdown.ts](../src/appserver/transcriptMarkdown.ts)               | [F13](feature-inventory.md#f13)                                                                                                                                     |
| [src/claude/agentProbe.ts](../src/claude/agentProbe.ts)                                     | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/claude/argvBuilder.ts](../src/claude/argvBuilder.ts)                                   | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/claude/askUserQuestion.ts](../src/claude/askUserQuestion.ts)                           | [F10](feature-inventory.md#f10)                                                                                                                                     |
| [src/claude/authActions.ts](../src/claude/authActions.ts)                                   | [F15](feature-inventory.md#f15)                                                                                                                                     |
| [src/claude/authProbe.ts](../src/claude/authProbe.ts)                                       | [F15](feature-inventory.md#f15)                                                                                                                                     |
| [src/claude/authStatus.ts](../src/claude/authStatus.ts)                                     | [F15](feature-inventory.md#f15)                                                                                                                                     |
| [src/claude/autocompactText.ts](../src/claude/autocompactText.ts)                           | [F13](feature-inventory.md#f13)                                                                                                                                     |
| [src/claude/cliLocator.ts](../src/claude/cliLocator.ts)                                     | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/claude/control.ts](../src/claude/control.ts)                                           | [F10](feature-inventory.md#f10)                                                                                                                                     |
| [src/claude/costText.ts](../src/claude/costText.ts)                                         | [F11](feature-inventory.md#f11)                                                                                                                                     |
| [src/claude/forkFromTurn.ts](../src/claude/forkFromTurn.ts)                                 | [F09](feature-inventory.md#f09)                                                                                                                                     |
| [src/claude/hooksProbe.ts](../src/claude/hooksProbe.ts)                                     | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/claude/hooksSettings.ts](../src/claude/hooksSettings.ts)                               | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/claude/mcpProbe.ts](../src/claude/mcpProbe.ts)                                         | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/claude/modelProbe.ts](../src/claude/modelProbe.ts)                                     | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/claude/pluginsActions.ts](../src/claude/pluginsActions.ts)                             | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/claude/pluginsList.ts](../src/claude/pluginsList.ts)                                   | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/claude/pluginsProbe.ts](../src/claude/pluginsProbe.ts)                                 | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/claude/provider.ts](../src/claude/provider.ts)                                         | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/claude/sessionIndex.ts](../src/claude/sessionIndex.ts)                                 | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/claude/sessionNames.ts](../src/claude/sessionNames.ts)                                 | [F03](feature-inventory.md#f03)                                                                                                                                     |
| [src/claude/sessionStore.ts](../src/claude/sessionStore.ts)                                 | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/claude/settingsJson.ts](../src/claude/settingsJson.ts)                                 | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/claude/sideQuestion.ts](../src/claude/sideQuestion.ts)                                 | [F14](feature-inventory.md#f14)                                                                                                                                     |
| [src/claude/skillsList.ts](../src/claude/skillsList.ts)                                     | [F07](feature-inventory.md#f07)                                                                                                                                     |
| [src/claude/skillsProbe.ts](../src/claude/skillsProbe.ts)                                   | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/claude/streamJson.ts](../src/claude/streamJson.ts)                                     | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/claude/streamSession.ts](../src/claude/streamSession.ts)                               | [F01](feature-inventory.md#f01)、[F05](feature-inventory.md#f05)、[F13](feature-inventory.md#f13)、[F14](feature-inventory.md#f14)                                  |
| [src/claude/transcript.ts](../src/claude/transcript.ts)                                     | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/claude/transcriptWatcher.ts](../src/claude/transcriptWatcher.ts)                       | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/claude/types.ts](../src/claude/types.ts)                                               | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/claude/usageProbe.ts](../src/claude/usageProbe.ts)                                     | [F11](feature-inventory.md#f11)                                                                                                                                     |
| [src/claude/usageText.ts](../src/claude/usageText.ts)                                       | [F11](feature-inventory.md#f11)                                                                                                                                     |
| [src/codex/accountActions.ts](../src/codex/accountActions.ts)                               | [F15](feature-inventory.md#f15)                                                                                                                                     |
| [src/codex/accountStatus.ts](../src/codex/accountStatus.ts)                                 | [F15](feature-inventory.md#f15)                                                                                                                                     |
| [src/codex/appServerClient.ts](../src/codex/appServerClient.ts)                             | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/codex/appsStatus.ts](../src/codex/appsStatus.ts)                                       | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/codex/argvBuilder.ts](../src/codex/argvBuilder.ts)                                     | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/codex/cliLocator.ts](../src/codex/cliLocator.ts)                                       | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/codex/configToml.ts](../src/codex/configToml.ts)                                       | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/codex/conversation.ts](../src/codex/conversation.ts)                                   | [F03](feature-inventory.md#f03)                                                                                                                                     |
| [src/codex/hooksStatus.ts](../src/codex/hooksStatus.ts)                                     | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/codex/importStatus.ts](../src/codex/importStatus.ts)                                   | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/codex/jsonRpc.ts](../src/codex/jsonRpc.ts)                                             | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/codex/mcpDisable.ts](../src/codex/mcpDisable.ts)                                       | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/codex/mcpStatus.ts](../src/codex/mcpStatus.ts)                                         | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/codex/modelCatalog.ts](../src/codex/modelCatalog.ts)                                   | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/codex/pluginsStatus.ts](../src/codex/pluginsStatus.ts)                                 | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/codex/provider.ts](../src/codex/provider.ts)                                           | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/codex/reviewTarget.ts](../src/codex/reviewTarget.ts)                                   | [F13](feature-inventory.md#f13)                                                                                                                                     |
| [src/codex/sandboxPolicy.ts](../src/codex/sandboxPolicy.ts)                                 | [F10](feature-inventory.md#f10)                                                                                                                                     |
| [src/codex/sessionIndex.ts](../src/codex/sessionIndex.ts)                                   | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/codex/sessionMeta.ts](../src/codex/sessionMeta.ts)                                     | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/codex/sideQuestion.ts](../src/codex/sideQuestion.ts)                                   | [F14](feature-inventory.md#f14)                                                                                                                                     |
| [src/codex/skillDisable.ts](../src/codex/skillDisable.ts)                                   | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/codex/skillsList.ts](../src/codex/skillsList.ts)                                       | [F07](feature-inventory.md#f07)                                                                                                                                     |
| [src/codex/skillsStatus.ts](../src/codex/skillsStatus.ts)                                   | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/codex/threadList.ts](../src/codex/threadList.ts)                                       | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/codex/types.ts](../src/codex/types.ts)                                                 | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/codex/usage.ts](../src/codex/usage.ts)                                                 | [F11](feature-inventory.md#f11)                                                                                                                                     |
| [src/config.ts](../src/config.ts)                                                           | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/extension.ts](../src/extension.ts)                                                     | [F01](feature-inventory.md#f01)、[F26](feature-inventory.md#f26)、[F27](feature-inventory.md#f27)、[F32](feature-inventory.md#f32)                                  |
| [src/forge/hub.ts](../src/forge/hub.ts)                                                     | [F37](feature-inventory.md#f37)、[F38](feature-inventory.md#f38)                                                                                                    |
| [src/forge/orchestrator.ts](../src/forge/orchestrator.ts)                                   | [F37](feature-inventory.md#f37)、[F38](feature-inventory.md#f38)                                                                                                    |
| [src/log.ts](../src/log.ts)                                                                 | [F39](feature-inventory.md#f39)                                                                                                                                     |
| [src/loop/advisorPrompt.ts](../src/loop/advisorPrompt.ts)                                   | [F20](feature-inventory.md#f20)                                                                                                                                     |
| [src/loop/goalDraft.ts](../src/loop/goalDraft.ts)                                           | [F19](feature-inventory.md#f19)                                                                                                                                     |
| [src/loop/goalDraftProcess.ts](../src/loop/goalDraftProcess.ts)                             | [F19](feature-inventory.md#f19)                                                                                                                                     |
| [src/loop/goalEvaluatorProcess.ts](../src/loop/goalEvaluatorProcess.ts)                     | [F19](feature-inventory.md#f19)                                                                                                                                     |
| [src/loop/goalLoop.ts](../src/loop/goalLoop.ts)                                             | [F19](feature-inventory.md#f19)                                                                                                                                     |
| [src/loop/goalPrompt.ts](../src/loop/goalPrompt.ts)                                         | [F19](feature-inventory.md#f19)                                                                                                                                     |
| [src/loop/headlessCli.ts](../src/loop/headlessCli.ts)                                       | [F20](feature-inventory.md#f20)                                                                                                                                     |
| [src/loop/loopAdvisor.ts](../src/loop/loopAdvisor.ts)                                       | [F20](feature-inventory.md#f20)                                                                                                                                     |
| [src/loop/loopAdvisorProcess.ts](../src/loop/loopAdvisorProcess.ts)                         | [F20](feature-inventory.md#f20)                                                                                                                                     |
| [src/loop/loopController.ts](../src/loop/loopController.ts)                                 | [F18](feature-inventory.md#f18)                                                                                                                                     |
| [src/loop/loopEngineering.ts](../src/loop/loopEngineering.ts)                               | [F18](feature-inventory.md#f18)                                                                                                                                     |
| [src/loop/stallDetector.ts](../src/loop/stallDetector.ts)                                   | [F18](feature-inventory.md#f18)                                                                                                                                     |
| [src/loop/turnFocus.ts](../src/loop/turnFocus.ts)                                           | [F18](feature-inventory.md#f18)                                                                                                                                     |
| [src/orchestrator/approvalMapping.ts](../src/orchestrator/approvalMapping.ts)               | [F30](feature-inventory.md#f30)                                                                                                                                     |
| [src/orchestrator/escalation.ts](../src/orchestrator/escalation.ts)                         | [F30](feature-inventory.md#f30)                                                                                                                                     |
| [src/orchestrator/forge.ts](../src/orchestrator/forge.ts)                                   | [F33](feature-inventory.md#f33)                                                                                                                                     |
| [src/orchestrator/fsGuards.ts](../src/orchestrator/fsGuards.ts)                             | [F29](feature-inventory.md#f29)                                                                                                                                     |
| [src/orchestrator/integration.ts](../src/orchestrator/integration.ts)                       | [F29](feature-inventory.md#f29)                                                                                                                                     |
| [src/orchestrator/messaging.ts](../src/orchestrator/messaging.ts)                           | [F31](feature-inventory.md#f31)                                                                                                                                     |
| [src/orchestrator/nodeHandoffFileSystem.ts](../src/orchestrator/nodeHandoffFileSystem.ts)   | [F32](feature-inventory.md#f32)                                                                                                                                     |
| [src/orchestrator/orchestratorSession.ts](../src/orchestrator/orchestratorSession.ts)       | [F31](feature-inventory.md#f31)                                                                                                                                     |
| [src/orchestrator/planner.ts](../src/orchestrator/planner.ts)                               | [F26](feature-inventory.md#f26)、[F32](feature-inventory.md#f32)                                                                                                    |
| [src/orchestrator/program.ts](../src/orchestrator/program.ts)                               | [F34](feature-inventory.md#f34)                                                                                                                                     |
| [src/orchestrator/programRunner.ts](../src/orchestrator/programRunner.ts)                   | [F34](feature-inventory.md#f34)                                                                                                                                     |
| [src/orchestrator/programScheduler.ts](../src/orchestrator/programScheduler.ts)             | [F34](feature-inventory.md#f34)                                                                                                                                     |
| [src/orchestrator/programState.ts](../src/orchestrator/programState.ts)                     | [F34](feature-inventory.md#f34)                                                                                                                                     |
| [src/orchestrator/programStore.ts](../src/orchestrator/programStore.ts)                     | [F34](feature-inventory.md#f34)、[F35](feature-inventory.md#f35)                                                                                                    |
| [src/orchestrator/pseudoWorktree.ts](../src/orchestrator/pseudoWorktree.ts)                 | [F29](feature-inventory.md#f29)                                                                                                                                     |
| [src/orchestrator/roadmap.ts](../src/orchestrator/roadmap.ts)                               | [F27](feature-inventory.md#f27)                                                                                                                                     |
| [src/orchestrator/rolePresets.ts](../src/orchestrator/rolePresets.ts)                       | [F32](feature-inventory.md#f32)                                                                                                                                     |
| [src/orchestrator/runState.ts](../src/orchestrator/runState.ts)                             | [F28](feature-inventory.md#f28)                                                                                                                                     |
| [src/orchestrator/runStore.ts](../src/orchestrator/runStore.ts)                             | [F35](feature-inventory.md#f35)                                                                                                                                     |
| [src/orchestrator/runner.ts](../src/orchestrator/runner.ts)                                 | [F28](feature-inventory.md#f28)、[F32](feature-inventory.md#f32)                                                                                                    |
| [src/orchestrator/runnerApproval.ts](../src/orchestrator/runnerApproval.ts)                 | [F30](feature-inventory.md#f30)                                                                                                                                     |
| [src/orchestrator/runnerInternals.ts](../src/orchestrator/runnerInternals.ts)               | [F28](feature-inventory.md#f28)                                                                                                                                     |
| [src/orchestrator/runnerMerge.ts](../src/orchestrator/runnerMerge.ts)                       | [F29](feature-inventory.md#f29)、[F33](feature-inventory.md#f33)                                                                                                    |
| [src/orchestrator/runnerMessaging.ts](../src/orchestrator/runnerMessaging.ts)               | [F31](feature-inventory.md#f31)                                                                                                                                     |
| [src/orchestrator/runnerOrchestrator.ts](../src/orchestrator/runnerOrchestrator.ts)         | [F31](feature-inventory.md#f31)                                                                                                                                     |
| [src/orchestrator/runnerRestore.ts](../src/orchestrator/runnerRestore.ts)                   | [F35](feature-inventory.md#f35)                                                                                                                                     |
| [src/orchestrator/runnerReviewComments.ts](../src/orchestrator/runnerReviewComments.ts)     | [F33](feature-inventory.md#f33)                                                                                                                                     |
| [src/orchestrator/runnerSnapshot.ts](../src/orchestrator/runnerSnapshot.ts)                 | [F35](feature-inventory.md#f35)                                                                                                                                     |
| [src/orchestrator/runnerWorkingDirectory.ts](../src/orchestrator/runnerWorkingDirectory.ts) | [F29](feature-inventory.md#f29)                                                                                                                                     |
| [src/orchestrator/sanitize.ts](../src/orchestrator/sanitize.ts)                             | [F39](feature-inventory.md#f39)                                                                                                                                     |
| [src/orchestrator/scheduler.ts](../src/orchestrator/scheduler.ts)                           | [F28](feature-inventory.md#f28)                                                                                                                                     |
| [src/orchestrator/serialQueue.ts](../src/orchestrator/serialQueue.ts)                       | [F28](feature-inventory.md#f28)                                                                                                                                     |
| [src/orchestrator/taskConfig.ts](../src/orchestrator/taskConfig.ts)                         | [F25](feature-inventory.md#f25)、[F30](feature-inventory.md#f30)                                                                                                    |
| [src/orchestrator/taskSession.ts](../src/orchestrator/taskSession.ts)                       | [F28](feature-inventory.md#f28)                                                                                                                                     |
| [src/orchestrator/taskSummary.ts](../src/orchestrator/taskSummary.ts)                       | [F28](feature-inventory.md#f28)                                                                                                                                     |
| [src/orchestrator/teamHandoff.ts](../src/orchestrator/teamHandoff.ts)                       | [F32](feature-inventory.md#f32)                                                                                                                                     |
| [src/orchestrator/untrustedText.ts](../src/orchestrator/untrustedText.ts)                   | [F31](feature-inventory.md#f31)                                                                                                                                     |
| [src/orchestrator/workflow.ts](../src/orchestrator/workflow.ts)                             | [F25](feature-inventory.md#f25)                                                                                                                                     |
| [src/orchestrator/workflowEvaluation.ts](../src/orchestrator/workflowEvaluation.ts)         | [F25](feature-inventory.md#f25)                                                                                                                                     |
| [src/orchestrator/worktree.ts](../src/orchestrator/worktree.ts)                             | [F29](feature-inventory.md#f29)                                                                                                                                     |
| [src/process/childProcess.ts](../src/process/childProcess.ts)                               | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/process/commandRunner.ts](../src/process/commandRunner.ts)                             | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/process/stdinSafety.ts](../src/process/stdinSafety.ts)                                 | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/provider/account.ts](../src/provider/account.ts)                                       | [F15](feature-inventory.md#f15)                                                                                                                                     |
| [src/provider/approvalLevel.ts](../src/provider/approvalLevel.ts)                           | [F10](feature-inventory.md#f10)                                                                                                                                     |
| [src/provider/attachments.ts](../src/provider/attachments.ts)                               | [F06](feature-inventory.md#f06)                                                                                                                                     |
| [src/provider/commandCatalog.ts](../src/provider/commandCatalog.ts)                         | [F07](feature-inventory.md#f07)                                                                                                                                     |
| [src/provider/executableResolution.ts](../src/provider/executableResolution.ts)             | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/provider/fileMentions.ts](../src/provider/fileMentions.ts)                             | [F06](feature-inventory.md#f06)                                                                                                                                     |
| [src/provider/hooks.ts](../src/provider/hooks.ts)                                           | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/provider/id.ts](../src/provider/id.ts)                                                 | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/provider/imageRefs.ts](../src/provider/imageRefs.ts)                                   | [F06](feature-inventory.md#f06)                                                                                                                                     |
| [src/provider/import.ts](../src/provider/import.ts)                                         | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/provider/inputModes.ts](../src/provider/inputModes.ts)                                 | [F07](feature-inventory.md#f07)                                                                                                                                     |
| [src/provider/mcpServers.ts](../src/provider/mcpServers.ts)                                 | [F16](feature-inventory.md#f16)                                                                                                                                     |
| [src/provider/plugins.ts](../src/provider/plugins.ts)                                       | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/provider/pseudoCommands.ts](../src/provider/pseudoCommands.ts)                         | [F07](feature-inventory.md#f07)                                                                                                                                     |
| [src/provider/registry.ts](../src/provider/registry.ts)                                     | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/provider/skills.ts](../src/provider/skills.ts)                                         | [F17](feature-inventory.md#f17)                                                                                                                                     |
| [src/provider/slashCommands.ts](../src/provider/slashCommands.ts)                           | [F07](feature-inventory.md#f07)                                                                                                                                     |
| [src/provider/types.ts](../src/provider/types.ts)                                           | [F01](feature-inventory.md#f01)                                                                                                                                     |
| [src/secondOpinion/advisorSession.ts](../src/secondOpinion/advisorSession.ts)               | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/secondOpinion/afterTree.ts](../src/secondOpinion/afterTree.ts)                         | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/candidates.ts](../src/secondOpinion/candidates.ts)                       | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/secondOpinion/diffBudget.ts](../src/secondOpinion/diffBudget.ts)                       | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/display.ts](../src/secondOpinion/display.ts)                             | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/secondOpinion/handoff.ts](../src/secondOpinion/handoff.ts)                             | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/secondOpinion/prompt.ts](../src/secondOpinion/prompt.ts)                               | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/secondOpinion/redact.ts](../src/secondOpinion/redact.ts)                               | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/reviewBundle.ts](../src/secondOpinion/reviewBundle.ts)                   | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/run.ts](../src/secondOpinion/run.ts)                                     | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/secondOpinion/snapshot.ts](../src/secondOpinion/snapshot.ts)                           | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/summary.ts](../src/secondOpinion/summary.ts)                             | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/summaryRollout.ts](../src/secondOpinion/summaryRollout.ts)               | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/untracked.ts](../src/secondOpinion/untracked.ts)                         | [F21](feature-inventory.md#f21)                                                                                                                                     |
| [src/secondOpinion/wait.ts](../src/secondOpinion/wait.ts)                                   | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/session/nodeFileScan.ts](../src/session/nodeFileScan.ts)                               | [F06](feature-inventory.md#f06)                                                                                                                                     |
| [src/session/nodeFileSystem.ts](../src/session/nodeFileSystem.ts)                           | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/session/ports.ts](../src/session/ports.ts)                                             | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/session/pruneOnStartup.ts](../src/session/pruneOnStartup.ts)                           | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/session/sessionActions.ts](../src/session/sessionActions.ts)                           | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/session/sessionStore.ts](../src/session/sessionStore.ts)                               | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/session/sessionWatcher.ts](../src/session/sessionWatcher.ts)                           | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/session/usageReader.ts](../src/session/usageReader.ts)                                 | [F11](feature-inventory.md#f11)                                                                                                                                     |
| [src/sessionModelSettings.ts](../src/sessionModelSettings.ts)                               | [F03](feature-inventory.md#f03)、[F04](feature-inventory.md#f04)                                                                                                    |
| [src/sessionPresets.ts](../src/sessionPresets.ts)                                           | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/util/concurrency.ts](../src/util/concurrency.ts)                                       | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/util/dateBucket.ts](../src/util/dateBucket.ts)                                         | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/util/diffRestore.ts](../src/util/diffRestore.ts)                                       | [F09](feature-inventory.md#f09)                                                                                                                                     |
| [src/util/diffWorkspacePath.ts](../src/util/diffWorkspacePath.ts)                           | [F09](feature-inventory.md#f09)                                                                                                                                     |
| [src/util/editorSelection.ts](../src/util/editorSelection.ts)                               | [F05](feature-inventory.md#f05)                                                                                                                                     |
| [src/util/memento.ts](../src/util/memento.ts)                                               | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/util/ndjson.ts](../src/util/ndjson.ts)                                                 | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/util/paths.ts](../src/util/paths.ts)                                                   | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/util/pinnedSessions.ts](../src/util/pinnedSessions.ts)                                 | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/util/safetyClamp.ts](../src/util/safetyClamp.ts)                                       | [F30](feature-inventory.md#f30)                                                                                                                                     |
| [src/util/sessionFilter.ts](../src/util/sessionFilter.ts)                                   | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/util/sessionGrouping.ts](../src/util/sessionGrouping.ts)                               | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/view/activePanelSequence.ts](../src/view/activePanelSequence.ts)                       | [F05](feature-inventory.md#f05)                                                                                                                                     |
| [src/view/approvalPending.ts](../src/view/approvalPending.ts)                               | [F12](feature-inventory.md#f12)                                                                                                                                     |
| [src/view/approvalStatusBar.ts](../src/view/approvalStatusBar.ts)                           | [F12](feature-inventory.md#f12)                                                                                                                                     |
| [src/view/chatCsp.ts](../src/view/chatCsp.ts)                                               | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/chatManagerBase.ts](../src/view/chatManagerBase.ts)                               | [F03](feature-inventory.md#f03)、[F10](feature-inventory.md#f10)、[F12](feature-inventory.md#f12)                                                                   |
| [src/view/chatScript.ts](../src/view/chatScript.ts)                                         | [F05](feature-inventory.md#f05)、[F06](feature-inventory.md#f06)、[F08](feature-inventory.md#f08)                                                                   |
| [src/view/chatShared.ts](../src/view/chatShared.ts)                                         | [F06](feature-inventory.md#f06)、[F08](feature-inventory.md#f08)、[F09](feature-inventory.md#f09)                                                                   |
| [src/view/chatStyles.ts](../src/view/chatStyles.ts)                                         | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/chatView.ts](../src/view/chatView.ts)                                             | [F03](feature-inventory.md#f03)、[F09](feature-inventory.md#f09)、[F11](feature-inventory.md#f11)、[F18](feature-inventory.md#f18)                                  |
| [src/view/claudeChatView.ts](../src/view/claudeChatView.ts)                                 | [F03](feature-inventory.md#f03)、[F09](feature-inventory.md#f09)、[F11](feature-inventory.md#f11)、[F18](feature-inventory.md#f18)、[F39](feature-inventory.md#f39) |
| [src/view/composerButtons.ts](../src/view/composerButtons.ts)                               | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/controlPanelAlerts.ts](../src/view/controlPanelAlerts.ts)                         | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/view/controlPanelIcons.ts](../src/view/controlPanelIcons.ts)                           | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/view/controlPanelScript.ts](../src/view/controlPanelScript.ts)                         | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/view/controlPanelStyles.ts](../src/view/controlPanelStyles.ts)                         | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/view/controlPanelSummaries.ts](../src/view/controlPanelSummaries.ts)                   | [F04](feature-inventory.md#f04)                                                                                                                                     |
| [src/view/controlPanelView.ts](../src/view/controlPanelView.ts)                             | [F04](feature-inventory.md#f04)、[F15](feature-inventory.md#f15)                                                                                                    |
| [src/view/conversationView.ts](../src/view/conversationView.ts)                             | [F03](feature-inventory.md#f03)                                                                                                                                     |
| [src/view/density.ts](../src/view/density.ts)                                               | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/forgeHubView.ts](../src/view/forgeHubView.ts)                                     | [F37](feature-inventory.md#f37)、[F38](feature-inventory.md#f38)                                                                                                    |
| [src/view/goalDraftFactory.ts](../src/view/goalDraftFactory.ts)                             | [F19](feature-inventory.md#f19)                                                                                                                                     |
| [src/view/goalEvaluatorFactory.ts](../src/view/goalEvaluatorFactory.ts)                     | [F19](feature-inventory.md#f19)                                                                                                                                     |
| [src/view/handoff.ts](../src/view/handoff.ts)                                               | [F13](feature-inventory.md#f13)                                                                                                                                     |
| [src/view/highlight.ts](../src/view/highlight.ts)                                           | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/loopAdvisorFactory.ts](../src/view/loopAdvisorFactory.ts)                         | [F20](feature-inventory.md#f20)                                                                                                                                     |
| [src/view/markdown.ts](../src/view/markdown.ts)                                             | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/panelState.ts](../src/view/panelState.ts)                                         | [F03](feature-inventory.md#f03)                                                                                                                                     |
| [src/view/pendingStarts.ts](../src/view/pendingStarts.ts)                                   | [F03](feature-inventory.md#f03)                                                                                                                                     |
| [src/view/progressDelta.ts](../src/view/progressDelta.ts)                                   | [F23](feature-inventory.md#f23)                                                                                                                                     |
| [src/view/progressModel.ts](../src/view/progressModel.ts)                                   | [F23](feature-inventory.md#f23)                                                                                                                                     |
| [src/view/progressScript.ts](../src/view/progressScript.ts)                                 | [F23](feature-inventory.md#f23)                                                                                                                                     |
| [src/view/progressStyles.ts](../src/view/progressStyles.ts)                                 | [F23](feature-inventory.md#f23)                                                                                                                                     |
| [src/view/progressView.ts](../src/view/progressView.ts)                                     | [F23](feature-inventory.md#f23)                                                                                                                                     |
| [src/view/reducedMotion.ts](../src/view/reducedMotion.ts)                                   | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/relativeTime.ts](../src/view/relativeTime.ts)                                     | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/view/secondOpinionCommand.ts](../src/view/secondOpinionCommand.ts)                     | [F21](feature-inventory.md#f21)、[F22](feature-inventory.md#f22)                                                                                                    |
| [src/view/secondOpinionParent.ts](../src/view/secondOpinionParent.ts)                       | [F22](feature-inventory.md#f22)                                                                                                                                     |
| [src/view/sendKey.ts](../src/view/sendKey.ts)                                               | [F05](feature-inventory.md#f05)                                                                                                                                     |
| [src/view/sessionActivity.ts](../src/view/sessionActivity.ts)                               | [F12](feature-inventory.md#f12)、[F24](feature-inventory.md#f24)                                                                                                    |
| [src/view/sessionDecorations.ts](../src/view/sessionDecorations.ts)                         | [F12](feature-inventory.md#f12)                                                                                                                                     |
| [src/view/sessionKanbanModel.ts](../src/view/sessionKanbanModel.ts)                         | [F24](feature-inventory.md#f24)                                                                                                                                     |
| [src/view/sessionKanbanView.ts](../src/view/sessionKanbanView.ts)                           | [F24](feature-inventory.md#f24)                                                                                                                                     |
| [src/view/sessionTitle.ts](../src/view/sessionTitle.ts)                                     | [F03](feature-inventory.md#f03)                                                                                                                                     |
| [src/view/sessionTreeProvider.ts](../src/view/sessionTreeProvider.ts)                       | [F02](feature-inventory.md#f02)                                                                                                                                     |
| [src/view/settingsProvider.ts](../src/view/settingsProvider.ts)                             | [F04](feature-inventory.md#f04)、[F15](feature-inventory.md#f15)、[F16](feature-inventory.md#f16)、[F17](feature-inventory.md#f17)                                  |
| [src/view/sharedStyles.ts](../src/view/sharedStyles.ts)                                     | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/stateDelta.ts](../src/view/stateDelta.ts)                                         | [F08](feature-inventory.md#f08)                                                                                                                                     |
| [src/view/turnSummary.ts](../src/view/turnSummary.ts)                                       | [F13](feature-inventory.md#f13)                                                                                                                                     |
| [src/view/usageStatusBar.ts](../src/view/usageStatusBar.ts)                                 | [F11](feature-inventory.md#f11)                                                                                                                                     |
| [src/view/workflowGraph.ts](../src/view/workflowGraph.ts)                                   | [F36](feature-inventory.md#f36)                                                                                                                                     |
| [src/view/workflowMenu.ts](../src/view/workflowMenu.ts)                                     | [F36](feature-inventory.md#f36)                                                                                                                                     |
| [src/view/workflowScript.ts](../src/view/workflowScript.ts)                                 | [F36](feature-inventory.md#f36)                                                                                                                                     |
| [src/view/workflowStyles.ts](../src/view/workflowStyles.ts)                                 | [F36](feature-inventory.md#f36)                                                                                                                                     |
| [src/view/workflowView.ts](../src/view/workflowView.ts)                                     | [F36](feature-inventory.md#f36)                                                                                                                                     |

## 統合・外部CLI・手動確認の参照先

以下は後続レビューで使う参照先。存在の確認のみで、今回の実行結果ではない。

| 対象                | 参照先                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動・設定・履歴    | [extension](../test/integration/extension.test.ts)、[configuration](../test/integration/configuration.test.ts)、[sessionHistory](../test/integration/sessionHistory.test.ts)                                                                                   |
| Codex会話           | [chatCodexThreadFlow](../test/integration/chatCodexThreadFlow.test.ts)、[chatCodexApprovals](../test/integration/chatCodexApprovals.test.ts)                                                                                                                   |
| Claude会話          | [chatClaudeHandshake](../test/integration/chatClaudeHandshake.test.ts)、[chatClaudeSettings](../test/integration/chatClaudeSettings.test.ts)、[chatClaudeThreadFlow](../test/integration/chatClaudeThreadFlow.test.ts)                                         |
| ワークフロー        | [workflow](../test/integration/workflow.test.ts)、[workflowMessaging](../test/integration/workflowMessaging.test.ts)、[workflowMerge](../test/integration/workflowMerge.test.ts)、[workflowPseudoWorktree](../test/integration/workflowPseudoWorktree.test.ts) |
| Forge・ロードマップ | [workflowForgeOrder](../test/integration/workflowForgeOrder.test.ts)、[workflowForgePrerequisites](../test/integration/workflowForgePrerequisites.test.ts)、[workflowRoadmap](../test/integration/workflowRoadmap.test.ts)                                     |
| 実CLIの境界         | [threadStart.test.mjs](../test/external-cli/threadStart.test.mjs)、[実行スクリプト](../scripts/run-external-cli-tests.mjs)                                                                                                                                     |
| 性能・評価          | [進捗ベンチマーク](../test/bench/progressBench.ts)、[セカンドオピニオン評価](../docs/second-opinion-eval.md)、[評価用コード](../test/bench/secondOpinionEval/)                                                                                                 |
| 手動確認と既存仕様  | [手動テスト計画](manual-test-plan.md)、[手動テスト](manual-test.md)、[設計](design.md)、[統合テスト手順](integration-testing.md)                                                                                                                               |

## 更新時の照合方法

機能追加時は台帳に小項目を追加し、以下の母集団との差を確認する。コマンド登録だけでなくWebview内の送信・承認・復元等のハンドラーも対象にする。

```sh
rg --files src
rg -n "registerCommand|registerWebviewPanelSerializer" src/extension.ts
rg -n "type ===|message.type ===" src/view
rg -n "export const .*_TOOL" src/orchestrator/messaging.ts
```

`package.json`では`contributes.commands`・`configuration.properties`・`views`・`menus`・`keybindings`を照合する。追加したソースが対応表に載り、参照先F番号の小項目で役割を説明できることを確認する。
